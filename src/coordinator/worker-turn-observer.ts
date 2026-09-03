import { renderWorkerTurnCard } from "../cards/worker-turn-card.js";
import type { InstanceStore } from "../domain/ports/instance.js";
import type { TraexTranscriptObservation, TraexTranscriptReaderPort } from "../domain/ports/external.js";
import { redactSecrets } from "../runtime/redact-secrets.js";
import type { RunProgressEvent } from "../domain/run-card-view.js";

interface Options {
  store: InstanceStore;
  transcriptReader: TraexTranscriptReaderPort;
  wakeInstance(instanceId: string): void;
  wakeOutbound(): void;
}
export interface WorkerTurnWatch { stop(): Promise<void> }
const POLL_INTERVAL_MS = 250;
const FINAL_DRAIN_LIMIT = 8;

export class WorkerTurnObserver {
  private readonly headlessChunks = new Map<string, string[]>();
  constructor(private readonly options: Options) {}

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
    const delta = safeOutput(observation.answerDelta);
    const chunks = view ? null : this.headlessChunks.get(turnId) ?? [];
    if (delta && chunks) { chunks.push(delta); this.headlessChunks.set(turnId, chunks); }
    const accumulated = safeOutput(view ? (delta ? [view.answer, delta].filter(Boolean).join("\n\n") : view.answer) : chunks!.join("\n\n"));
    const occurredAt = new Date().toISOString();
    const progressEvents = observedProgress(observation, occurredAt);
    const statusTitle = observation.mainStatus?.statusTitle === undefined ? undefined : safeOutput(observation.mainStatus.statusTitle);
    if (view && lifecycle?.state === "active" && ["queued", "preparing", "dispatch-uncertain"].includes(view.phase)) {
      view = this.options.store.applyInstanceTurnProjection({ turnId, expectedGeneration: turn.instanceGeneration, ...expected, change: { type: "running", occurredAt }, render: renderWorkerTurnCard });
      if (view) this.options.wakeOutbound();
    }
    if (lifecycle?.state === "aborted") {
      const notice = lifecycle.reason === "interrupted"
        ? "TraeX turn was interrupted by a human operator"
        : `TraeX turn was aborted${lifecycle.reason ? `: ${lifecycle.reason}` : ""}`;
      const projected = view
        ? this.options.store.transitionInstanceTurnWithProjection({ turnId, expectedGeneration: turn.instanceGeneration, ...expected, state: "cancelled", error: notice, eventKind: "turn.cancelled", change: { type: "cancelled", occurredAt, notice }, render: renderWorkerTurnCard })
        : this.options.store.updateInstanceTurn({ turnId, expectedGeneration: turn.instanceGeneration, ...expected, state: "cancelled", error: notice, eventKind: "turn.cancelled" });
      this.headlessChunks.delete(turnId);
      if (projected) { this.options.wakeOutbound(); this.options.wakeInstance(turn.instanceId); }
      return;
    }
    if (lifecycle?.state === "completed") {
      const answer = safeOutput(lifecycle.finalAnswer ?? accumulated);
      const projected = view
        ? this.options.store.transitionInstanceTurnWithProjection({ turnId, expectedGeneration: turn.instanceGeneration, ...expected, state: "completed", result: answer, eventKind: "turn.completed", change: { type: "completed", occurredAt, answer }, render: renderWorkerTurnCard })
        : this.options.store.updateInstanceTurn({ turnId, expectedGeneration: turn.instanceGeneration, ...expected, state: "completed", result: answer, eventKind: "turn.completed" });
      this.headlessChunks.delete(turnId);
      if (projected) { this.options.wakeOutbound(); this.options.wakeInstance(turn.instanceId); }
      return;
    }
    if ((delta || progressEvents.length > 0 || statusTitle !== undefined) && view) {
      const projected = this.options.store.applyInstanceTurnProjection({
        turnId, expectedGeneration: turn.instanceGeneration, ...expected, change: { type: "output", occurredAt, answer: accumulated, ...(statusTitle === undefined ? {} : { statusTitle }), progressEvents }, render: renderWorkerTurnCard
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
    const opened = await this.options.transcriptReader.open(session);
    if (opened.mode !== "typed") return null;
    let stopping = false;
    let timer: NodeJS.Timeout | null = null;
    let active = Promise.resolve();
    const poll = () => {
      active = active.then(async () => {
        if (stopping) return;
        const observation = opened.cursor.readObservation ? await opened.cursor.readObservation() : { answerDelta: await opened.cursor.readDelta() };
        if (hasObservation(observation)) await this.observe(turnId, observation);
      }).catch(() => undefined);
    };
    timer = setInterval(poll, POLL_INTERVAL_MS);
    timer.unref?.();
    return {
      stop: async () => {
        stopping = true;
        if (timer) clearInterval(timer);
        timer = null;
        await active;
        for (let count = 0; count < FINAL_DRAIN_LIMIT; count += 1) {
          const observation = opened.cursor.readObservation ? await opened.cursor.readObservation() : { answerDelta: await opened.cursor.readDelta() };
          if (!hasObservation(observation)) break;
          await this.observe(turnId, observation);
          const current = this.options.store.getInstanceTurn(turnId);
          if (!current || ["completed", "failed", "cancelled"].includes(current.state)) break;
        }
      }
    };
  }

  async recover(turnId: string): Promise<void> {
    const turn = this.options.store.getInstanceTurn(turnId);
    if (!turn?.runtimeTurnId || !turn.runtimeTurnStartedAt || !this.options.transcriptReader.openAfterTurn) return;
    const instance = this.options.store.getAgentInstance(turn.instanceId);
    const session = sessionFor(instance, turn.instanceGeneration);
    if (!session) return;
    const opened = await this.options.transcriptReader.openAfterTurn(
      session,
      turn.runtimeTurnId, turn.runtimeTurnStartedAt
    );
    if (opened.mode !== "typed") return;
    for (let count = 0; count < 32; count += 1) {
      const observation = opened.cursor.readObservation
        ? await opened.cursor.readObservation()
        : { answerDelta: await opened.cursor.readDelta() };
      if (!hasObservation(observation)) break;
      await this.observe(turnId, observation);
      const current = this.options.store.getInstanceTurn(turnId);
      if (!current || ["completed", "failed", "cancelled"].includes(current.state)) break;
    }
    const current = this.options.store.getInstanceTurn(turnId);
    const view = this.options.store.loadWorkerTurnCard(turnId);
    if (current && view && !["completed", "failed", "cancelled"].includes(current.state)) {
      const occurredAt = new Date().toISOString();
      const answer = safeOutput(view.answer);
      const projected = this.options.store.transitionInstanceTurnWithProjection({
        turnId, expectedGeneration: current.instanceGeneration, expectedRuntimeTurnId: current.runtimeTurnId!, expectedRuntimeTurnStartedAt: current.runtimeTurnStartedAt!,
        state: "completed", result: answer, eventKind: "turn.completed", change: { type: "completed", occurredAt, answer }, render: renderWorkerTurnCard
      });
      if (projected) { this.options.wakeOutbound(); this.options.wakeInstance(current.instanceId); }
    }
  }
}

function safeOutput(value: string): string {
  return redactSecrets(value).slice(0, 64 * 1024);
}
function hasObservation(observation: TraexTranscriptObservation): boolean {
  return Boolean(observation.turnId || observation.freshTurnStart || observation.answerDelta || observation.toolActivities?.length || observation.mainStatus || observation.turnLifecycle);
}
function observedProgress(observation: TraexTranscriptObservation, occurredAt: string): RunProgressEvent[] {
  const tools = (observation.toolActivities ?? []).map((event) => ({ ...event, label: safeOutput(event.label), occurredAt }));
  const plans = (observation.mainStatus?.planSteps ?? []).map((step) => ({ key: `plan:${step.key}`, kind: "step" as const, label: safeOutput(step.label), state: step.state, occurredAt }));
  return [...tools, ...plans];
}
function sessionFor(instance: ReturnType<InstanceStore["getAgentInstance"]>, generation: number) {
  return instance?.runtimeRef?.nativeSessionId && instance.generation === generation && instance.agentKind === "traex"
    ? { source: "traex", agent: "traex", kind: "id" as const, value: instance.runtimeRef.nativeSessionId }
    : null;
}
