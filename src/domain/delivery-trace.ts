export type DeliveryTraceStage =
  | "ingress_accepted"
  | "submission_admitted"
  | "core_projected"
  | "outbox_committed"
  | "ring_granted"
  | "gateway_acknowledged"
  | "settled";

export type DeliveryTraceOutcome = "observed" | "succeeded" | "failed" | "retry" | "stale" | "yielded";

export type DeliveryTraceCorrelation = Readonly<Partial<{
  eventId: string;
  messageId: string;
  submissionId: string;
  coreEventId: string;
  segmentId: string;
  replyId: string;
  attemptId: string;
  receiptId: string;
}>>;

export type DeliveryLatencyMetricStage =
  | "ingress_to_submission"
  | "submission_to_core"
  | "core_to_outbox"
  | "outbox_to_ring"
  | "ring_to_gateway_ack"
  | "gateway_ack_to_settlement"
  | "input_to_first_visible_ack"
  | "core_to_first_visible_ack"
  | "core_to_visible_ack"
  | "input_to_settlement";

export interface DeliveryLatencyMetric {
  stage: DeliveryLatencyMetricStage;
  outcome: Exclude<DeliveryTraceOutcome, "observed">;
  durationMs: number;
  correlation: DeliveryTraceCorrelation;
}

export interface DeliveryTraceObservation {
  stage: DeliveryTraceStage;
  outcome: DeliveryTraceOutcome;
  correlation: DeliveryTraceCorrelation;
}

export type DeliveryTraceDiagnostic = Readonly<{
  kind: "stale_attempt" | "maintenance_yield";
  correlation: DeliveryTraceCorrelation;
}>;

export interface DeliveryLatencySnapshot {
  traces: number;
  activePaths: number;
  activeBindings: number;
  completed: number;
  lastCompletedDurationMs: number | null;
  firstVisibleCompleted: number;
  lastFirstVisibleDurationMs: number | null;
  stageDurationsMs: Partial<Record<
    "ingressToSubmission" | "submissionToCore" | "coreToOutbox" | "outboxToRing" |
    "ringToGatewayAck" | "gatewayAckToSettlement",
    number
  >>;
  metrics: Partial<Record<DeliveryLatencyMetricStage, Partial<Record<Exclude<DeliveryTraceOutcome, "observed">, number>>>>;
  diagnostics: { staleAttempts: number; maintenanceYields: number; pathEvictions: number; pathRefusals: number };
}

type TraceInput = Readonly<{
  stage: DeliveryTraceStage;
  monotonicAtMs: number;
  outcome?: DeliveryTraceOutcome;
  correlation: DeliveryTraceCorrelation;
}>;

type RootTrace = {
  stages: Map<DeliveryTraceStage, number>;
  correlations: Map<DeliveryTraceStage, DeliveryTraceCorrelation>;
  paths: Set<DeliveryPath>;
  refusedKeys: Set<string>;
  firstVisibleCompleted: boolean;
  firstVisiblePath: DeliveryPath | null;
  firstVisibleMetricStages: Set<DeliveryLatencyMetricStage>;
};

type DeliveryPath = {
  root: RootTrace;
  stages: Map<DeliveryTraceStage, number>;
  correlations: Map<DeliveryTraceStage, DeliveryTraceCorrelation>;
  currentAttemptId: string | null;
  completed: boolean;
};

type FirstVisibleTombstone = { keys: Set<string> };

type Correlated = { root: RootTrace; path: DeliveryPath | null; refused?: true };
type Listener = {
  onMetric?: (metric: DeliveryLatencyMetric) => void;
  onObservation?: (observation: DeliveryTraceObservation) => void;
  onDiagnostic?: (diagnostic: DeliveryTraceDiagnostic) => void;
};

const ROOT_STAGES = new Set<DeliveryTraceStage>(["ingress_accepted", "submission_admitted", "core_projected"]);
const CORRELATION_KEYS = ["eventId", "messageId", "submissionId", "coreEventId", "segmentId", "replyId", "attemptId", "receiptId"] as const;
const PATH_CORRELATION_KEYS = new Set<(typeof CORRELATION_KEYS)[number]>(["replyId", "attemptId", "receiptId"]);
const ROOT_CORRELATION_KEYS = CORRELATION_KEYS.filter((key) => !PATH_CORRELATION_KEYS.has(key));
const DEFAULT_MAX_PATHS_PER_ROOT = 32;
const MAX_PATHS_PER_ROOT = 256;

export class DeliveryLatencyTrace {
  private readonly index = new Map<string, Correlated>();
  private readonly roots = new Set<RootTrace>();
  private readonly firstVisibleTombstones = new Set<FirstVisibleTombstone>();
  private readonly firstVisibleTombstoneIndex = new Map<string, FirstVisibleTombstone>();
  private readonly listeners = new Set<Listener>();
  private readonly metricCounts: DeliveryLatencySnapshot["metrics"] = {};
  private readonly clock: () => number;
  private readonly maxTraces: number;
  private readonly maxPathsPerRoot: number;
  private completed = 0;
  private lastCompletedDurationMs: number | null = null;
  private firstVisibleCompleted = 0;
  private lastFirstVisibleDurationMs: number | null = null;
  private lastStageDurations: DeliveryLatencySnapshot["stageDurationsMs"] = {};
  private readonly diagnostics = { staleAttempts: 0, maintenanceYields: 0, pathEvictions: 0, pathRefusals: 0 };

  constructor(options: Listener & { clock?: () => number; maxTraces?: number; maxPathsPerRoot?: number } = {}) {
    this.clock = options.clock ?? (() => performance.now());
    const requestedLimit = Math.floor(options.maxTraces ?? 2_048);
    this.maxTraces = Number.isFinite(requestedLimit) ? Math.max(1, requestedLimit) : 2_048;
    const requestedPathLimit = Math.floor(options.maxPathsPerRoot ?? DEFAULT_MAX_PATHS_PER_ROOT);
    this.maxPathsPerRoot = Number.isFinite(requestedPathLimit)
      ? Math.min(MAX_PATHS_PER_ROOT, Math.max(1, requestedPathLimit))
      : DEFAULT_MAX_PATHS_PER_ROOT;
    if (options.onMetric || options.onObservation || options.onDiagnostic) this.listeners.add(options);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  mark(input: Omit<TraceInput, "monotonicAtMs">): void {
    this.observe({ ...input, monotonicAtMs: this.clock() });
  }

  observe(input: TraceInput): void {
    if (!Number.isFinite(input.monotonicAtMs)) return;
    const correlation = sanitizeCorrelation(input.correlation);
    if (Object.keys(correlation).length === 0) return;
    const correlated = this.resolve(correlation, input.stage);
    if (!correlated) return;
    const outcome = input.outcome ?? "observed";
    const targetStages = ROOT_STAGES.has(input.stage) ? correlated.root.stages : correlated.path!.stages;
    const targetCorrelations = ROOT_STAGES.has(input.stage) ? correlated.root.correlations : correlated.path!.correlations;

    if (input.stage === "ring_granted") {
      const attemptId = correlation.attemptId ?? null;
      if (attemptId && correlated.path!.currentAttemptId !== attemptId) {
        this.retirePathBinding(correlated.path!, "attemptId");
        this.retirePathBinding(correlated.path!, "receiptId");
        correlated.path!.currentAttemptId = attemptId;
        correlated.path!.stages.delete("ring_granted");
        correlated.path!.stages.delete("gateway_acknowledged");
        correlated.path!.stages.delete("settled");
      }
    } else if ((input.stage === "gateway_acknowledged" || input.stage === "settled")
      && correlation.attemptId && correlated.path!.currentAttemptId
      && correlation.attemptId !== correlated.path!.currentAttemptId) {
      return;
    }

    if (targetStages.has(input.stage)) {
      const priorCorrelation = targetCorrelations.get(input.stage);
      const refreshedCoreProjection = input.stage === "core_projected"
        && correlation.coreEventId !== undefined
        && correlation.coreEventId !== priorCorrelation?.coreEventId;
      if (!refreshedCoreProjection) return;
      targetStages.set(input.stage, input.monotonicAtMs);
      targetCorrelations.set(input.stage, correlation);
      this.bind(correlation, correlated);
      this.emitObservation({ stage: input.stage, outcome, correlation });
      return;
    }
    targetStages.set(input.stage, input.monotonicAtMs);
    targetCorrelations.set(input.stage, correlation);
    this.bind(correlation, correlated);
    this.emitObservation({ stage: input.stage, outcome, correlation });
    if (input.stage === "gateway_acknowledged") this.recordFirstVisible(correlated.path!);
    if (input.stage === "settled" && outcome !== "retry" && outcome !== "stale" && outcome !== "yielded") {
      this.complete(correlated.path!, outcome === "succeeded" ? "succeeded" : "failed");
    }
  }

  diagnose(kind: DeliveryTraceDiagnostic["kind"], correlation: DeliveryTraceCorrelation = {}): void {
    const safe = sanitizeCorrelation(correlation);
    if (kind === "stale_attempt") this.diagnostics.staleAttempts += 1;
    else this.diagnostics.maintenanceYields += 1;
    for (const listener of this.listeners) {
      try { listener.onDiagnostic?.({ kind, correlation: safe }); } catch {}
    }
  }

  snapshot(): DeliveryLatencySnapshot {
    return {
      traces: this.roots.size,
      activePaths: [...this.roots].reduce((count, root) => count + root.paths.size, 0),
      activeBindings: this.index.size,
      completed: this.completed,
      lastCompletedDurationMs: this.lastCompletedDurationMs,
      firstVisibleCompleted: this.firstVisibleCompleted,
      lastFirstVisibleDurationMs: this.lastFirstVisibleDurationMs,
      stageDurationsMs: { ...this.lastStageDurations },
      metrics: Object.fromEntries(Object.entries(this.metricCounts).map(([stage, outcomes]) => [stage, { ...outcomes }])),
      diagnostics: { ...this.diagnostics }
    };
  }

  private resolve(correlation: DeliveryTraceCorrelation, stage: DeliveryTraceStage): Correlated | null {
    const matches = CORRELATION_KEYS.flatMap((key) => {
      const value = correlation[key];
      const found = value ? this.index.get(`${key}:${value}`) : undefined;
      return found ? [found] : [];
    });
    if (matches.some((match) => match.refused)) return null;
    const matchedRoots = [...new Set(matches.map((match) => match.root))];
    if (matchedRoots.length > 1) {
      if (matchedRoots.filter((matchedRoot) => matchedRoot.firstVisibleCompleted).length > 1) {
        this.diagnostics.pathRefusals += 1;
        this.bindMergeRefusal(matchedRoots[0]!, correlation);
        return null;
      }
      const activePaths = matchedRoots.reduce(
        (count, matchedRoot) => count + [...matchedRoot.paths].filter((path) => !path.completed).length,
        0
      );
      if (activePaths > this.maxPathsPerRoot) {
        this.diagnostics.pathRefusals += 1;
        this.bindMergeRefusal(matchedRoots[0]!, correlation);
        return null;
      }
    }
    let root = matches[0]?.root ?? this.createRoot(correlation);
    for (const match of matches) if (match.root !== root) root = this.mergeRoots(root, match.root);

    const replyMatch = correlation.replyId ? this.index.get(`replyId:${correlation.replyId}`) : undefined;
    const attemptMatch = correlation.attemptId ? this.index.get(`attemptId:${correlation.attemptId}`) : undefined;
    const receiptMatch = correlation.receiptId ? this.index.get(`receiptId:${correlation.receiptId}`) : undefined;
    let path = replyMatch?.path ?? attemptMatch?.path ?? receiptMatch?.path ?? matches.find((match) => match.path)?.path ?? null;
    if (!ROOT_STAGES.has(stage) && !path) {
      path = this.createPath(root, correlation);
      if (!path) return null;
    }
    return { root, path };
  }

  private createPath(root: RootTrace, correlation: DeliveryTraceCorrelation): DeliveryPath | null {
    if (root.paths.size >= this.maxPathsPerRoot) {
      const completed = [...root.paths].find((candidate) => candidate.completed);
      if (completed) this.evictPath(completed);
      else {
        this.diagnostics.pathRefusals += 1;
        this.bindRefusal(root, null, correlation);
        return null;
      }
    }
    const path = {
      root,
      stages: new Map<DeliveryTraceStage, number>(root.stages),
      correlations: new Map<DeliveryTraceStage, DeliveryTraceCorrelation>(root.correlations),
      currentAttemptId: null,
      completed: false
    };
    root.paths.add(path);
    return path;
  }

  private createRoot(correlation: DeliveryTraceCorrelation): RootTrace {
    const tombstone = this.findFirstVisibleTombstone(correlation);
    const root = {
      stages: new Map<DeliveryTraceStage, number>(), correlations: new Map<DeliveryTraceStage, DeliveryTraceCorrelation>(), paths: new Set<DeliveryPath>(), refusedKeys: new Set<string>(),
      firstVisibleCompleted: tombstone !== undefined, firstVisiblePath: null, firstVisibleMetricStages: new Set<DeliveryLatencyMetricStage>()
    };
    this.roots.add(root);
    while (this.roots.size > this.maxTraces) this.evict(this.roots.values().next().value as RootTrace);
    return root;
  }

  private evict(root: RootTrace): void {
    if (root.firstVisibleCompleted) this.rememberFirstVisibleRoot(root);
    this.roots.delete(root);
    for (const [key, correlated] of this.index) if (correlated.root === root) this.index.delete(key);
  }

  private mergeRoots(target: RootTrace, source: RootTrace): RootTrace {
    for (const [stage, at] of source.stages) if (!target.stages.has(stage)) target.stages.set(stage, at);
    for (const [stage, correlation] of source.correlations) if (!target.correlations.has(stage)) target.correlations.set(stage, correlation);
    for (const path of source.paths) { path.root = target; target.paths.add(path); }
    for (const key of source.refusedKeys) target.refusedKeys.add(key);
    if (source.firstVisibleCompleted) {
      target.firstVisibleCompleted = true;
      target.firstVisiblePath = source.firstVisiblePath;
      target.firstVisibleMetricStages = source.firstVisibleMetricStages;
    }
    for (const [key, correlated] of this.index) if (correlated.root === source) {
      this.index.set(key, { root: target, path: correlated.path, ...(correlated.refused ? { refused: true as const } : {}) });
    }
    this.roots.delete(source);
    while (target.paths.size > this.maxPathsPerRoot) {
      const completed = [...target.paths].find((path) => path.completed);
      if (!completed) break;
      this.evictPath(completed);
    }
    this.trimRefusals(target);
    return target;
  }

  private bindMergeRefusal(root: RootTrace, correlation: DeliveryTraceCorrelation): void {
    for (const key of CORRELATION_KEYS) {
      const value = correlation[key];
      if (!value) continue;
      const indexKey = `${key}:${value}`;
      if (!this.index.has(indexKey)) this.bindRefusalKey(root, null, indexKey);
    }
  }

  private bind(correlation: DeliveryTraceCorrelation, correlated: Correlated): void {
    for (const key of CORRELATION_KEYS) {
      const value = correlation[key];
      if (!value) continue;
      const indexKey = `${key}:${value}`;
      const path = PATH_CORRELATION_KEYS.has(key) ? correlated.path : null;
      const current = this.index.get(indexKey);
      if (current?.root === correlated.root && current.path === path && !current.refused) continue;
      for (const [priorKey, prior] of this.index) {
        if (prior.refused || prior.root !== correlated.root || prior.path !== path || !priorKey.startsWith(`${key}:`)) continue;
        this.index.delete(priorKey);
      }
      this.index.set(indexKey, { root: correlated.root, path });
    }
  }

  private retirePathBinding(path: DeliveryPath, key: "attemptId" | "receiptId"): void {
    for (const [indexKey, correlated] of this.index) {
      if (correlated.path !== path || correlated.refused || !indexKey.startsWith(`${key}:`)) continue;
      this.index.delete(indexKey);
      this.bindRefusalKey(path.root, path, indexKey);
    }
  }

  private bindRefusal(root: RootTrace, path: DeliveryPath | null, correlation: DeliveryTraceCorrelation): void {
    for (const key of CORRELATION_KEYS) {
      const value = correlation[key];
      if (value && PATH_CORRELATION_KEYS.has(key)) this.bindRefusalKey(root, path, `${key}:${value}`);
    }
  }

  private bindRefusalKey(root: RootTrace, path: DeliveryPath | null, indexKey: string): void {
    root.refusedKeys.delete(indexKey);
    root.refusedKeys.add(indexKey);
    this.index.set(indexKey, { root, path, refused: true });
    this.trimRefusals(root);
  }

  private trimRefusals(root: RootTrace): void {
    while (root.refusedKeys.size > this.maxPathsPerRoot) {
      const key = root.refusedKeys.values().next().value as string;
      root.refusedKeys.delete(key);
      if (this.index.get(key)?.refused) this.index.delete(key);
    }
  }

  private evictPath(path: DeliveryPath): void {
    path.root.paths.delete(path);
    for (const [key, correlated] of this.index) {
      if (correlated.path !== path) continue;
      this.index.delete(key);
      path.root.refusedKeys.delete(key);
    }
    this.diagnostics.pathEvictions += 1;
  }

  private complete(path: DeliveryPath, outcome: "succeeded" | "failed"): void {
    if (path.completed) return;
    path.completed = true;
    this.completed += 1;
    const stages = new Map(path.root.stages);
    for (const [stage, at] of path.stages) stages.set(stage, at);
    const correlations = new Map(path.root.correlations);
    for (const [stage, correlation] of path.correlations) correlations.set(stage, correlation);
    const pathPairs = [
      ["outbox_committed", "ring_granted", "outboxToRing", "outbox_to_ring"],
      ["ring_granted", "gateway_acknowledged", "ringToGatewayAck", "ring_to_gateway_ack"],
      ["gateway_acknowledged", "settled", "gatewayAckToSettlement", "gateway_ack_to_settlement"]
    ] as const;
    const durations: DeliveryLatencySnapshot["stageDurationsMs"] = {};
    const rootDurationPairs = [
      ["ingress_accepted", "submission_admitted", "ingressToSubmission"],
      ["submission_admitted", "core_projected", "submissionToCore"],
      ["core_projected", "outbox_committed", "coreToOutbox"]
    ] as const;
    for (const [from, to, snapshotKey] of rootDurationPairs) {
      const duration = durationBetween(stages, from, to);
      if (duration !== null) durations[snapshotKey] = duration;
    }
    const emitPairs = (pairs: typeof pathPairs) => {
      for (const [from, to, snapshotKey, metricStage] of pairs) {
        const duration = durationBetween(stages, from, to);
        if (duration === null) continue;
        durations[snapshotKey] = duration;
        this.emitMetric({ stage: metricStage, outcome, durationMs: duration, correlation: mergeCorrelations(correlations.get(from), correlations.get(to)) });
      }
    };
    emitPairs(pathPairs);
    if (path.root.firstVisiblePath === path && !path.root.firstVisibleMetricStages.has("input_to_settlement")) {
      const total = durationBetween(stages, "ingress_accepted", "settled");
      if (total !== null) {
        this.lastCompletedDurationMs = total;
        this.emitRootMetric(path.root, { stage: "input_to_settlement", outcome, durationMs: total,
          correlation: mergeCorrelations(...correlations.values()) });
      }
    }
    this.lastStageDurations = durations;
  }

  private recordFirstVisible(path: DeliveryPath): void {
    const root = path.root;
    if (root.firstVisibleCompleted) return;
    root.firstVisibleCompleted = true;
    root.firstVisiblePath = path;
    this.firstVisibleCompleted += 1;
    const stages = new Map(root.stages);
    for (const [stage, at] of path.stages) stages.set(stage, at);
    const correlations = new Map(root.correlations);
    for (const [stage, correlation] of path.correlations) correlations.set(stage, correlation);
    const rootPairs = [
      ["ingress_accepted", "submission_admitted", "ingress_to_submission"],
      ["submission_admitted", "core_projected", "submission_to_core"],
      ["core_projected", "outbox_committed", "core_to_outbox"]
    ] as const;
    for (const [from, to, stage] of rootPairs) {
      const duration = durationBetween(stages, from, to);
      if (duration !== null) this.emitRootMetric(root, { stage, outcome: "succeeded", durationMs: duration, correlation: mergeCorrelations(correlations.get(from), correlations.get(to)) });
    }
    const firstVisible = durationBetween(stages, "ingress_accepted", "gateway_acknowledged");
    if (firstVisible !== null) {
      this.lastFirstVisibleDurationMs = firstVisible;
      this.emitRootMetric(root, { stage: "input_to_first_visible_ack", outcome: "succeeded", durationMs: firstVisible, correlation: mergeCorrelations(...correlations.values()) });
    }
    const coreToFirstVisible = durationBetween(stages, "core_projected", "gateway_acknowledged");
    if (coreToFirstVisible !== null) {
      this.emitRootMetric(root, { stage: "core_to_first_visible_ack", outcome: "succeeded", durationMs: coreToFirstVisible, correlation: mergeCorrelations(...correlations.values()) });
      this.emitRootMetric(root, { stage: "core_to_visible_ack", outcome: "succeeded", durationMs: coreToFirstVisible, correlation: mergeCorrelations(...correlations.values()) });
    }
  }

  private emitRootMetric(root: RootTrace, metric: DeliveryLatencyMetric): void {
    root.firstVisibleMetricStages.add(metric.stage);
    this.emitMetric(metric);
  }

  private findFirstVisibleTombstone(correlation: DeliveryTraceCorrelation): FirstVisibleTombstone | undefined {
    return ROOT_CORRELATION_KEYS.flatMap((key) => {
      const value = correlation[key];
      const tombstone = value ? this.firstVisibleTombstoneIndex.get(`${key}:${value}`) : undefined;
      return tombstone ? [tombstone] : [];
    })[0];
  }

  private rememberFirstVisibleRoot(root: RootTrace): void {
    const keys = new Set<string>();
    for (const [stage, correlation] of root.correlations) {
      if (!ROOT_STAGES.has(stage)) continue;
      for (const key of ROOT_CORRELATION_KEYS) if (correlation[key]) keys.add(`${key}:${correlation[key]}`);
    }
    if (keys.size === 0) return;
    const tombstone = { keys };
    this.firstVisibleTombstones.add(tombstone);
    for (const key of keys) this.firstVisibleTombstoneIndex.set(key, tombstone);
    while (this.firstVisibleTombstones.size > this.maxTraces) {
      const oldest = this.firstVisibleTombstones.values().next().value as FirstVisibleTombstone;
      this.firstVisibleTombstones.delete(oldest);
      for (const key of oldest.keys) if (this.firstVisibleTombstoneIndex.get(key) === oldest) this.firstVisibleTombstoneIndex.delete(key);
    }
  }

  private emitMetric(metric: DeliveryLatencyMetric): void {
    const outcomes = this.metricCounts[metric.stage] ?? {};
    outcomes[metric.outcome] = (outcomes[metric.outcome] ?? 0) + 1;
    this.metricCounts[metric.stage] = outcomes;
    for (const listener of this.listeners) {
      try { listener.onMetric?.(metric); } catch {}
    }
  }

  private emitObservation(observation: DeliveryTraceObservation): void {
    for (const listener of this.listeners) {
      try { listener.onObservation?.(observation); } catch {}
    }
  }
}

function sanitizeCorrelation(input: DeliveryTraceCorrelation): DeliveryTraceCorrelation {
  const output: Partial<Record<(typeof CORRELATION_KEYS)[number], string>> = {};
  for (const key of CORRELATION_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0 && value.length <= 256) output[key] = value;
  }
  return output;
}

function mergeCorrelations(...values: Array<DeliveryTraceCorrelation | undefined>): DeliveryTraceCorrelation {
  const merged: DeliveryTraceCorrelation = {};
  for (const value of values) if (value) Object.assign(merged, value);
  return sanitizeCorrelation(merged);
}

function durationBetween(stages: ReadonlyMap<DeliveryTraceStage, number>, from: DeliveryTraceStage, to: DeliveryTraceStage): number | null {
  const start = stages.get(from);
  const end = stages.get(to);
  if (start === undefined || end === undefined || end < start) return null;
  return end - start;
}
