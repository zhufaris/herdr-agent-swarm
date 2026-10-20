import type { OutboundCheckpointSubscriber } from "../domain/ports/outbox.js";
import type { Logger } from "pino";
import { safeLogError } from "../runtime/safe-error.js";

type AnswerCheckpoint = (promptId: string, viewVersion: number) => void;
type WorkerTurnCheckpoint = (turnId: string, viewVersion: number) => void;
type WorkerMainCheckpoint = (workerId: string, workerSessionGeneration: number, viewVersion: number) => void;
type MainCardCheckpoint = (bindingId: string, viewVersion: number) => void;
type TurnCardCheckpoint = (segmentId: string, pageIndex: number, replyId: string, messageId: string, cardId: string | null) => void;
type TurnCardRecoveryCheckpoint = (segmentId: string) => void;

/** Process-local post-ACK wake-up fanout. Durable settlement remains SQLite-authoritative. */
export class DeliveryCheckpointBus implements OutboundCheckpointSubscriber {
  private readonly answers = new Set<AnswerCheckpoint>();
  private readonly workerTurns = new Set<WorkerTurnCheckpoint>();
  private readonly workerMains = new Set<WorkerMainCheckpoint>();
  private readonly mainCards = new Set<MainCardCheckpoint>();
  private readonly turnCards = new Set<TurnCardCheckpoint>();
  private readonly turnCardRecoveries = new Set<TurnCardRecoveryCheckpoint>();

  constructor(private readonly logger?: Pick<Logger, "error">) {}

  onAnswerCheckpoint(listener: AnswerCheckpoint): () => void { return subscribe(this.answers, listener); }
  onWorkerTurnCheckpoint(listener: WorkerTurnCheckpoint): () => void { return subscribe(this.workerTurns, listener); }
  onWorkerMainCheckpoint(listener: WorkerMainCheckpoint): () => void { return subscribe(this.workerMains, listener); }
  onMainCardCheckpoint(listener: MainCardCheckpoint): () => void { return subscribe(this.mainCards, listener); }
  onTurnCardCheckpoint(listener: TurnCardCheckpoint): () => void { return subscribe(this.turnCards, listener); }
  onTurnCardRecoveryCheckpoint(listener: TurnCardRecoveryCheckpoint): () => void { return subscribe(this.turnCardRecoveries, listener); }

  publishAnswer(promptId: string, viewVersion: number): void { this.publish("answer", this.answers, (listener) => listener(promptId, viewVersion)); }
  publishWorkerTurn(turnId: string, viewVersion: number): void { this.publish("worker-turn", this.workerTurns, (listener) => listener(turnId, viewVersion)); }
  publishWorkerMain(workerId: string, generation: number, viewVersion: number): void { this.publish("worker-main", this.workerMains, (listener) => listener(workerId, generation, viewVersion)); }
  publishMainCard(bindingId: string, viewVersion: number): void { this.publish("main-card", this.mainCards, (listener) => listener(bindingId, viewVersion)); }
  publishTurnCard(segmentId: string, pageIndex: number, replyId: string, messageId: string, cardId: string | null): void { this.publish("turn-card", this.turnCards, (listener) => listener(segmentId, pageIndex, replyId, messageId, cardId)); }
  publishTurnCardRecovery(segmentId: string): void { this.publish("turn-card-recovery", this.turnCardRecoveries, (listener) => listener(segmentId)); }

  private publish<T>(name: string, listeners: ReadonlySet<T>, invoke: (listener: T) => void): void {
    for (const listener of listeners) {
      try { invoke(listener); }
      catch (error) { this.logger?.error({ event: "delivery-checkpoint-listener-failed", subscriber: name, err: safeLogError(error), outcome: "isolated" }, "post-delivery convergence hook failed; durable delivery remains authoritative"); }
    }
  }
}

function subscribe<T>(listeners: Set<T>, listener: T): () => void { listeners.add(listener); return () => listeners.delete(listener); }
