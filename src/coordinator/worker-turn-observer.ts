import type { WorkerTurnObservationStore } from "../domain/ports/instance.js";
import type { WorkerPresentation } from "../domain/ports/presentation.js";
import type { TraexTranscriptObservation, TraexTranscriptReaderPort } from "../domain/ports/external.js";
import type { RunProgressEvent } from "../domain/run-card-view.js";
import { ExactTurnObserver, type ExactTurnCursor } from "../runtime/exact-turn-observer.js";

interface Options {
  store: WorkerTurnObservationStore;
  transcriptReader: TraexTranscriptReaderPort;
  wakeInstance(instanceId: string): void;
  wakeOutbound(): void;
  presentation: Pick<WorkerPresentation, "workerTurn" | "safeWorkerOutput">;
  pollIntervalMs?: number;
}
export interface WorkerTurnWatch { flush(): Promise<void>; stop(): Promise<void>; detach(): Promise<void> }
const FINAL_DRAIN_LIMIT = 8;
const RECOVERY_DRAIN_LIMIT = 64;

export class WorkerTurnObserver {
  private readonly headlessChunks = new Map<string, string[]>();
  private readonly exactTurns: ExactTurnObserver;
  constructor(private readonly options: Options) { this.exactTurns = new ExactTurnObserver(options.transcriptReader); }

  async observe(turnId: string, observation: TraexTranscriptObservation): Promise<void> {
    let turn = this.options.store.getInstanceTurn(turnId);
    if (!turn || ["completed", "failed", "cancelled"].includes(turn.state)) return;
    const lifecycle = observation.turnLifecycle;
    if (!turn.runtimeTurnId && observation.freshTurnStart === true && lifecycle && observation.turnId === lifecycle.turnId) {
      turn = this.options.store.claimInstanceTurnTranscript({
        turnId, expectedGeneration: turn.instanceGeneration, runtimeTurnId: lifecycle.turnId, startedAt: lifecycle.startedAt
      });
    }
    if (!turn?.runtimeTurnId || observation.turnId !== turn.runtimeTurnId) return;
    if (lifecycle && (lifecycle.turnId !== turn.runtimeTurnId || lifecycle.startedAt !== turn.runtimeTurnStartedAt)) return;
    let view = this.options.store.loadWorkerTurnCard(turnId);
    const expected = { expectedRuntimeTurnId: turn.runtimeTurnId, expectedRuntimeTurnStartedAt: turn.runtimeTurnStartedAt! };
    const delta = this.safeOutput(observation.answerDelta);
    const chunks = view ? null : this.headlessChunks.get(turnId) ?? [];
    if (delta && chunks) { chunks.push(delta); this.headlessChunks.set(turnId, chunks); }
    const accumulated = this.safeOutput(view ? (delta ? [view.answer, delta].filter(Boolean).join("\n\n") : view.answer) : chunks!.join("\n\n"));
    const occurredAt = new Date().toISOString();
    const progressEvents = observedProgress(observation, occurredAt, (value) => this.safeOutput(value));
    const statusTitle = observation.mainStatus?.statusTitle === undefined ? undefined : this.safeOutput(observation.mainStatus.statusTitle);
    if (view && lifecycle?.state === "active" && ["queued", "preparing", "dispatch-uncertain"].includes(view.phase)) {
      view = this.options.store.applyInstanceTurnProjection({ turnId, expectedGeneration: turn.instanceGeneration, ...expected, change: { type: "running", occurredAt }, render: this.options.presentation.workerTurn });
      if (view) this.options.wakeOutbound();
    }
    if (lifecycle?.state === "aborted") {
      const notice = lifecycle.reason === "interrupted"
        ? "TraeX turn was interrupted by a human operator"
        : `TraeX turn was aborted${lifecycle.reason ? `: ${lifecycle.reason}` : ""}`;
      const projected = view
        ? this.options.store.transitionInstanceTurnWithProjection({ turnId, expectedGeneration: turn.instanceGeneration, ...expected, state: "cancelled", error: notice, eventKind: "turn.cancelled", change: { type: "cancelled", occurredAt, notice }, render: this.options.presentation.workerTurn })
        : this.options.store.updateInstanceTurn({ turnId, expectedGeneration: turn.instanceGeneration, ...expected, state: "cancelled", error: notice, eventKind: "turn.cancelled" });
      this.headlessChunks.delete(turnId);
      if (projected) { this.options.wakeOutbound(); this.options.wakeInstance(turn.instanceId); }
      return;
    }
    if (lifecycle?.state === "completed") {
      const answer = this.safeOutput(lifecycle.finalAnswer ?? accumulated);
      const projected = view
        ? this.options.store.transitionInstanceTurnWithProjection({ turnId, expectedGeneration: turn.instanceGeneration, ...expected, state: "completed", result: answer, eventKind: "turn.completed", change: { type: "completed", occurredAt, answer }, render: this.options.presentation.workerTurn })
        : this.options.store.updateInstanceTurn({ turnId, expectedGeneration: turn.instanceGeneration, ...expected, state: "completed", result: answer, eventKind: "turn.completed" });
      this.headlessChunks.delete(turnId);
      if (projected) { this.options.wakeOutbound(); this.options.wakeInstance(turn.instanceId); }
      return;
    }
    if ((delta || progressEvents.length > 0 || statusTitle !== undefined) && view) {
      const projected = this.options.store.applyInstanceTurnProjection({
        turnId, expectedGeneration: turn.instanceGeneration, ...expected, change: { type: "output", occurredAt, answer: accumulated, ...(statusTitle === undefined ? {} : { statusTitle }), progressEvents }, render: this.options.presentation.workerTurn
      });
      if (projected) this.options.wakeOutbound();
    }
  }

  async watch(turnId: string): Promise<WorkerTurnWatch | null> {
    const turn = this.options.store.getInstanceTurn(turnId);
    if (!turn) return null;
    const instance = this.options.store.getAgentInstance(turn.instanceId);
    const session = sessionFor(instance, turn.instanceGeneration);
    if (!session) return null;
    const opened = await this.exactTurns.open({ session, boundary: { kind: "latest" } });
    if (opened.mode !== "typed") return null;
    let stopping = false;
    let timer: NodeJS.Timeout | null = null;
    let active = Promise.resolve();
    let resolveDetached!: () => void;
    const detached = new Promise<void>((resolve) => { resolveDetached = resolve; });
    const finish = () => {
      if (stopping) return;
      stopping = true;
      if (timer) clearInterval(timer);
      timer = null;
      resolveDetached();
    };
    const poll = () => {
      active = active.then(async () => {
        if (stopping) return;
        const result = await opened.cursor.read();
        if (result.kind === "accepted") await this.observe(turnId, result.observation);
        const current = this.options.store.getInstanceTurn(turnId);
        if (!current || ["completed", "failed", "cancelled"].includes(current.state)) finish();
      }).catch(() => undefined);
    };
    timer = setInterval(poll, this.options.pollIntervalMs ?? 250);
    timer.unref?.();
    return {
      flush: async () => {
        active = active.then(() => this.drain(turnId, opened.cursor, FINAL_DRAIN_LIMIT));
        await active;
      },
      stop: async () => {
        finish();
        await active;
        await this.drain(turnId, opened.cursor, FINAL_DRAIN_LIMIT);
      },
      detach: () => detached
    };
  }

  async recover(turnId: string): Promise<void> {
    const turn = this.options.store.getInstanceTurn(turnId);
    if (!turn?.runtimeTurnId || !turn.runtimeTurnStartedAt) return;
    const instance = this.options.store.getAgentInstance(turn.instanceId);
    const session = sessionFor(instance, turn.instanceGeneration);
    if (!session) return;
    const opened = await this.exactTurns.open({
      session,
      boundary: { kind: "at", turnId: turn.runtimeTurnId, startedAt: turn.runtimeTurnStartedAt },
      expected: { turnId: turn.runtimeTurnId, startedAt: turn.runtimeTurnStartedAt }
    });
    if (opened.mode !== "typed") return;
    await this.drain(turnId, opened.cursor, RECOVERY_DRAIN_LIMIT);
  }
  private async drain(turnId: string, cursor: ExactTurnCursor, limit: number): Promise<void> {
    await cursor.drain({ limit, onObservation: async (observation) => {
      await this.observe(turnId, observation);
      const current = this.options.store.getInstanceTurn(turnId);
      return !current || ["completed", "failed", "cancelled"].includes(current.state) ? "stop" : "continue";
    } });
  }
  private safeOutput(value: string): string { return this.options.presentation.safeWorkerOutput(value); }
}
function observedProgress(observation: TraexTranscriptObservation, occurredAt: string, safeOutput: (value: string) => string): RunProgressEvent[] {
  const tools = (observation.toolActivities ?? []).map((event) => ({ ...event, label: safeOutput(event.label), occurredAt }));
  const plans = (observation.mainStatus?.planSteps ?? []).map((step) => ({ key: `plan:${step.key}`, kind: "step" as const, label: safeOutput(step.label), state: step.state, occurredAt }));
  return [...tools, ...plans];
}
function sessionFor(instance: ReturnType<WorkerTurnObservationStore["getAgentInstance"]>, generation: number) {
  return instance?.runtimeRef?.nativeSessionId && instance.generation === generation && instance.agentKind === "traex"
    ? { source: "traex", agent: "traex", kind: "id" as const, value: instance.runtimeRef.nativeSessionId }
    : null;
}
