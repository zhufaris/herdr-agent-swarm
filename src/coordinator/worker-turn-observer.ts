import type { WorkerTurnObservationStore } from "../domain/ports/instance.js";
import type { WorkerPresentation } from "../domain/ports/presentation.js";
import type { AgentTranscriptObservation, AgentTranscriptReaderPort } from "../domain/ports/external.js";
import type { RunProgressEvent } from "../domain/run-card-view.js";
import { ExactTurnObserver, type ExactTurnCursor } from "../runtime/exact-turn-observer.js";
import { appendTurnOutput, createBoundedTurnOutput, type BoundedTurnOutput } from "../runtime/bounded-turn-output.js";
import type { WorkerTurnObservationPort, WorkerTurnWatch } from "../domain/ports/worker-turn-observation.js";
import type { Logger } from "pino";
import { selectCompletionChoiceTerminalInput } from "../domain/completion-choice.js";
import { safeLogError } from "../runtime/safe-error.js";

interface Options {
  store: WorkerTurnObservationStore;
  transcriptReader: AgentTranscriptReaderPort;
  wakeInstance(instanceId: string): void;
  wakeOutbound(): void;
  convergeWorkerTurn?(turnId: string): void;
  presentation: Pick<WorkerPresentation, "workerTurn" | "workerHumanReviewNotification" | "safeWorkerOutput">;
  logger?: Pick<Logger, "info" | "warn">;
  pollIntervalMs?: number;
}
const FINAL_DRAIN_LIMIT = 8;
const RECOVERY_DRAIN_LIMIT = 64;

export class WorkerTurnObserver implements WorkerTurnObservationPort {
  private readonly headlessOutput = new Map<string, BoundedTurnOutput>();
  private readonly exactTurns: ExactTurnObserver;
  constructor(private readonly options: Options) { this.exactTurns = new ExactTurnObserver(options.transcriptReader); }

  async observe(turnId: string, observation: AgentTranscriptObservation): Promise<void> {
    let turn = this.options.store.getInstanceTurn(turnId);
    if (!turn || ["completed", "failed", "cancelled"].includes(turn.state)) { this.headlessOutput.delete(turnId); return; }
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
    const previousOutput = view ? createBoundedTurnOutput(view.answer) : this.headlessOutput.get(turnId) ?? createBoundedTurnOutput();
    const output = appendTurnOutput(previousOutput, delta);
    if (!view && output !== previousOutput) this.headlessOutput.set(turnId, output);
    const accumulated = output.text;
    const occurredAt = new Date().toISOString();
    const progressEvents = observedProgress(observation, occurredAt, (value) => this.safeOutput(value));
    const statusTitle = observation.mainStatus?.statusTitle === undefined ? undefined : this.safeOutput(observation.mainStatus.statusTitle);
    const tokenCount = observation.mainStatus?.tokenCount;
    if (view && lifecycle?.state === "active" && ["queued", "preparing", "dispatch-uncertain"].includes(view.phase)) {
      view = this.options.store.applyInstanceTurnProjection({ turnId, expectedGeneration: turn.instanceGeneration, ...expected, change: { type: "running", occurredAt }, render: this.options.presentation.workerTurn });
      if (view) { this.options.wakeOutbound(); this.options.convergeWorkerTurn?.(turnId); }
    }
    if (lifecycle?.state === "aborted") {
      const notice = lifecycle.reason === "interrupted"
        ? "TraeX turn was interrupted by a human operator"
        : `TraeX turn was aborted${lifecycle.reason ? `: ${lifecycle.reason}` : ""}`;
      const projected = view
        ? this.options.store.transitionInstanceTurnWithProjection({ turnId, expectedGeneration: turn.instanceGeneration, ...expected, state: "cancelled", error: notice, eventKind: "turn.cancelled", change: { type: "cancelled", occurredAt, notice }, render: this.options.presentation.workerTurn, renderHumanReviewNotification: this.options.presentation.workerHumanReviewNotification })
        : this.options.store.updateInstanceTurn({ turnId, expectedGeneration: turn.instanceGeneration, ...expected, state: "cancelled", error: notice, eventKind: "turn.cancelled" });
      this.headlessOutput.delete(turnId);
      if (projected) { this.options.wakeOutbound(); this.options.convergeWorkerTurn?.(turnId); this.options.wakeInstance(turn.instanceId); }
      return;
    }
    if (lifecycle?.state === "completed") {
      const answer = selectCompletionChoiceTerminalInput(
        lifecycle.finalAnswer === undefined ? undefined : this.safeOutput(lifecycle.finalAnswer),
        accumulated
      );
      const projected = view
        ? this.options.store.transitionInstanceTurnWithProjection({ turnId, expectedGeneration: turn.instanceGeneration, ...expected, state: "completed", result: answer, eventKind: "turn.completed", change: { type: "completed", occurredAt, answer, ...(tokenCount === undefined ? {} : { tokenCount }), ...(observation.timelineDeltas?.length ? { timelineDeltas: observation.timelineDeltas } : {}) }, ...(lifecycle.completionChoice ? { completionChoice: lifecycle.completionChoice } : {}), render: this.options.presentation.workerTurn, renderHumanReviewNotification: this.options.presentation.workerHumanReviewNotification })
        : this.options.store.updateInstanceTurn({ turnId, expectedGeneration: turn.instanceGeneration, ...expected, state: "completed", result: answer, eventKind: "turn.completed" });
      this.headlessOutput.delete(turnId);
      if (projected) {
        if ("completionActionEligibility" in projected) {
          if (projected.projectionChanged || projected.notification.outcome === "reserved") { this.options.wakeOutbound(); this.options.convergeWorkerTurn?.(turnId); }
        } else {
          this.options.wakeOutbound();
          this.options.convergeWorkerTurn?.(turnId);
        }
        this.options.wakeInstance(turn.instanceId);
      }
      return;
    }
    if ((delta || observation.timelineDeltas?.length || progressEvents.length > 0 || statusTitle !== undefined || tokenCount !== undefined) && view) {
      const projected = this.options.store.applyInstanceTurnProjection({
        turnId, expectedGeneration: turn.instanceGeneration, ...expected, change: { type: "output", occurredAt, answer: accumulated, ...(statusTitle === undefined ? {} : { statusTitle }), ...(tokenCount === undefined ? {} : { tokenCount }), progressEvents, ...(observation.timelineDeltas?.length ? { timelineDeltas: observation.timelineDeltas } : {}) }, render: this.options.presentation.workerTurn
      });
      if (projected) { this.options.wakeOutbound(); this.options.convergeWorkerTurn?.(turnId); }
    }
  }

  async watch(turnId: string): Promise<WorkerTurnWatch | null> {
    const turn = this.options.store.getInstanceTurn(turnId);
    if (!turn) return null;
    const instance = this.options.store.getAgentInstance(turn.instanceId);
    const source = transcriptSourceForInstance(instance, turn.instanceGeneration, turn.id);
    if (!source) return null;
    const opened = await this.exactTurns.open({ source, boundary: { kind: "latest" } });
    if (opened.mode !== "typed") return null;
    const baseDelayMs = Math.max(1, this.options.pollIntervalMs ?? 250);
    let stopping = false;
    let timer: NodeJS.Timeout | null = null;
    let active = Promise.resolve();
    let consecutiveFailures = 0;
    let retryDelayMs = baseDelayMs;
    let resolveDetached!: () => void;
    const detached = new Promise<void>((resolve) => { resolveDetached = resolve; });
    const finish = () => {
      if (stopping) return;
      stopping = true;
      if (timer) clearTimeout(timer);
      timer = null;
      resolveDetached();
    };
    const schedule = (delayMs: number) => {
      if (stopping) return;
      timer = setTimeout(poll, delayMs);
      timer.unref?.();
    };
    const poll = () => {
      timer = null;
      active = active.then(async () => {
        if (stopping) return;
        let result;
        try {
          result = await opened.cursor.read();
        } catch (error) {
          consecutiveFailures += 1;
          const nextRetryDelayMs = Math.min(baseDelayMs * (2 ** consecutiveFailures), Math.max(5_000, baseDelayMs * 4));
          if (nextRetryDelayMs !== retryDelayMs) {
            this.options.logger?.warn({ event: "worker-turn-cursor-read-failed", turnId, consecutiveFailures, retryDelayMs: nextRetryDelayMs, err: safeLogError(error) }, "Worker exact-turn cursor read failed; retrying");
          }
          retryDelayMs = nextRetryDelayMs;
          schedule(nextRetryDelayMs);
          return;
        }
        consecutiveFailures = 0;
        retryDelayMs = baseDelayMs;
        if (result.kind === "accepted") {
          try {
            await this.observe(turnId, result.observation);
            await opened.cursor.acknowledge?.("projected");
          } catch (error) {
            await opened.cursor.acknowledge?.("quarantined", error instanceof Error ? error.message : String(error));
          }
        }
        const current = this.options.store.getInstanceTurn(turnId);
        if (!current || ["completed", "failed", "cancelled"].includes(current.state)) finish();
        else schedule(baseDelayMs);
      }).catch(() => {
        schedule(baseDelayMs);
      });
    };
    schedule(baseDelayMs);
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
    const source = transcriptSourceForInstance(instance, turn.instanceGeneration, turn.id);
    if (!source) return;
    const opened = await this.exactTurns.open({
      source,
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
function observedProgress(observation: AgentTranscriptObservation, occurredAt: string, safeOutput: (value: string) => string): RunProgressEvent[] {
  const tools = (observation.toolActivities ?? []).map((event) => ({ ...event, label: safeOutput(event.label), occurredAt }));
  const plans = (observation.mainStatus?.planSteps ?? []).map((step) => ({ key: `plan:${step.key}`, kind: "step" as const, label: safeOutput(step.label), state: step.state, occurredAt }));
  return [...tools, ...plans];
}
function transcriptSourceForInstance(instance: ReturnType<WorkerTurnObservationStore["getAgentInstance"]>, generation: number, turnId: string) {
  if (!instance || instance.generation !== generation) return null;
  const nativeSession = instance.runtimeRef?.nativeSessionId && (instance.agentKind === "traex" || instance.agentKind === "pi")
    ? { source: `herdr:${instance.agentKind}`, agent: instance.agentKind, kind: "id" as const, value: instance.runtimeRef.nativeSessionId }
    : null;
  return { agentKind: instance.agentKind, bindingId: instance.id, generation, coreEventOwner: { kind: "worker_turn" as const, id: turnId }, paneId: instance.runtimeRef?.paneId ?? null, nativeSession };
}
