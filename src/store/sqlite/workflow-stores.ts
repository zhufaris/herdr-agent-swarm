import type { CommandIntentStore } from "../../domain/ports/swarm-command.js";
import type { DeliveryRecoveryStore } from "../../domain/ports/workflow.js";
import type { SessionOperationStore } from "../../domain/ports/workflow.js";
import type { Binding } from "../../domain/types.js";
import type { SessionOperation } from "../../domain/types.js";
import type { SqliteCommandIntentStore } from "./command-intent-store.js";
import type { SqliteSessionOperationStore } from "./session-operation-store.js";

export class SqliteCommandIntentStoreAdapter implements CommandIntentStore, Pick<DeliveryRecoveryStore, "audit" | "getBinding"> {
  constructor(
    private readonly store: SqliteCommandIntentStore,
    private readonly dependencies: {
      audit: DeliveryRecoveryStore["audit"];
      getBinding: DeliveryRecoveryStore["getBinding"];
    }
  ) {}

  acceptCommandIntent: CommandIntentStore["acceptCommandIntent"] = (input) => this.store.accept(input);
  getCommandIntent: CommandIntentStore["getCommandIntent"] = (id) => this.store.get(id);
  claimNextCommandIntent: CommandIntentStore["claimNextCommandIntent"] = (laneKey) => this.store.claimNext(laneKey);
  finishCommandIntent: CommandIntentStore["finishCommandIntent"] = (id, state, outcome) => this.store.finish(id, state, outcome);
  listRecoverableCommandIntents: CommandIntentStore["listRecoverableCommandIntents"] = () => this.store.listRecoverable();
  recoverExecutingCommandIntents: CommandIntentStore["recoverExecutingCommandIntents"] = (recoveredAt) => this.store.recoverExecuting(recoveredAt);
  audit: DeliveryRecoveryStore["audit"] = (input) => this.dependencies.audit(input);
  getBinding: DeliveryRecoveryStore["getBinding"] = (id) => this.dependencies.getBinding(id);
}

export class SqliteSessionOperationStoreAdapter implements SessionOperationStore {
  constructor(
    private readonly store: SqliteSessionOperationStore,
    private readonly getBindingById: (id: string) => Binding | null
  ) {}

  acceptSessionOperation: SessionOperationStore["acceptSessionOperation"] = (input) => this.store.accept(input);
  claimNextSessionOperation: SessionOperationStore["claimNextSessionOperation"] = (bindingId) => this.store.claimNext(bindingId);
  finishSessionOperation: SessionOperationStore["finishSessionOperation"] = (id, state, detail) => this.store.finish(id, state, detail);
  getSessionOperation(id: string): SessionOperation | null { return this.store.get(id); }
  getBinding: SessionOperationStore["getBinding"] = (id) => this.getBindingById(id);
  listRecoverableSessionOperations: SessionOperationStore["listRecoverableSessionOperations"] = () => this.store.listRecoverable();
}
