import type { Logger } from "pino";
import type { SessionOperationStore } from "../domain/ports/workflow.js";
import type { Binding, IncomingLarkMessage, SessionOperation, SessionOperationDispatcherDiagnostics } from "../domain/types.js";
import { UNSUPPORTED_RUNTIME_MODEL_MESSAGE } from "../domain/session-operation-policy.js";
import { safeLogError } from "../runtime/safe-error.js";
import type { BindingProvisioningWorkflowPort } from "./binding-provisioning-workflow.js";
import type { SessionAdministrationWorkflowPort } from "./session-administration-workflow.js";
import type { PaneControlWorkflowPort } from "./pane-control-workflow.js";
import type { PaneClosureWorkflowPort } from "./pane-closure-workflow.js";

type Store = SessionOperationStore;

interface Options {
  store: Store;
  sessionAdministration: Pick<SessionAdministrationWorkflowPort, "rename" | "archive" | "resume">;
  provisioning: Pick<BindingProvisioningWorkflowPort, "reset" | "reattach" | "replace">;
  paneControl: Pick<PaneControlWorkflowPort, "stop">;
  paneClosure: Pick<PaneClosureWorkflowPort, "requestPaneClose">;
  logger: Pick<Logger, "info" | "warn" | "error">;
}

export interface SessionOperationWorkflowPort {
  recover(): Promise<void>;
  stop(): Promise<void>;
  snapshot(): SessionOperationDispatcherDiagnostics;
}

export class SessionOperationWorkflow implements SessionOperationWorkflowPort {
  private recovery: Promise<void> | null = null;
  private state: "idle" | "running" = "idle";
  private stopping = false;
  private lastCompletedAt: string | null = null;
  private lastFailureAt: string | null = null;
  private lastFailure: string | null = null;

  constructor(private readonly options: Options) {}

  recover(): Promise<void> {
    if (this.recovery) return this.recovery;
    const recovery = this.performRecovery();
    this.recovery = recovery;
    void recovery.finally(() => { if (this.recovery === recovery) this.recovery = null; }).catch(() => {});
    return recovery;
  }

  private async performRecovery(): Promise<void> {
    this.state = "running";
    this.lastFailure = null;
    try {
      for (const operation of this.options.store.listRecoverableSessionOperations()) {
        if (operation.state !== "running") continue;
        this.options.store.finishSessionOperation(operation.id, "uncertain", "Bridge restarted after the Session operation may have reached Herdr; operation was not replayed");
        this.options.logger.warn({ event: "session-operation-recovered-uncertain", operationId: operation.id, bindingId: operation.bindingId, kind: operation.kind, outcome: "uncertain" }, "preserved interrupted Session operation without replay");
      }
      for (let operation = this.options.store.claimNextSessionOperation(); operation; operation = this.options.store.claimNextSessionOperation()) await this.execute(operation);
    } catch (error) {
      const safeError = safeLogError(error);
      this.lastFailureAt = new Date().toISOString();
      this.lastFailure = safeError.message.slice(0, 500);
      this.options.logger.error({ event: "session-operation-startup-recovery-failed", err: safeError, outcome: "blocked" }, "Legacy Session operation startup recovery failed");
      throw error;
    } finally {
      this.state = "idle";
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.recovery) await Promise.allSettled([this.recovery]);
  }

  snapshot(): SessionOperationDispatcherDiagnostics {
    return { state: this.stopping ? "stopping" : this.state, activeOperations: this.state === "running" ? 1 : 0, drainRequested: false, lastCompletedAt: this.lastCompletedAt, lastFailureAt: this.lastFailureAt, lastFailure: this.lastFailure };
  }

  private async execute(operation: SessionOperation): Promise<void> {
    try {
      const binding = this.options.store.getBinding(operation.bindingId);
      if (!binding || binding.generation !== operation.bindingGeneration || binding.paneId !== operation.expectedPaneId || binding.traexSessionId !== operation.expectedTerminalId) {
        this.options.store.finishSessionOperation(operation.id, "rejected", "Binding or pane identity changed before Session operation dispatch");
        return;
      }
      const message = syntheticMessage(operation, binding);
      let accepted: boolean;
      switch (operation.kind) {
        case "stop": accepted = await this.options.paneControl.stop(message, binding); break;
        case "model":
          this.options.store.finishSessionOperation(operation.id, "rejected", UNSUPPORTED_RUNTIME_MODEL_MESSAGE);
          this.lastCompletedAt = new Date().toISOString();
          this.options.logger.info({ event: "session-operation-completed", operationId: operation.id, bindingId: operation.bindingId, kind: operation.kind, outcome: "rejected" }, "Session operation completed");
          return;
        case "reset": accepted = await this.options.provisioning.reset(message, binding, operation.argument); break;
        case "archive": accepted = await this.options.sessionAdministration.archive(message, binding); break;
        case "rename": accepted = await this.options.sessionAdministration.rename(message, binding, operation.argument!); break;
        case "reattach": await this.options.provisioning.reattach(binding, operation.argument!, operation.actorOpenId); accepted = true; break;
        case "replace": await this.options.provisioning.replace(binding, operation.actorOpenId); accepted = true; break;
        case "resume": accepted = await this.options.sessionAdministration.resume(message, binding); break;
        case "pane_close": accepted = await this.options.paneClosure.requestPaneClose(message, binding); break;
      }
      this.options.store.finishSessionOperation(operation.id, accepted ? "succeeded" : "rejected", accepted ? null : "Session workflow rejected the operation");
      this.lastCompletedAt = new Date().toISOString();
      this.options.logger.info({ event: "session-operation-completed", operationId: operation.id, bindingId: operation.bindingId, kind: operation.kind, outcome: accepted ? "succeeded" : "rejected" }, "Session operation completed");
    } catch (error) {
      const safeError = safeLogError(error);
      this.options.store.finishSessionOperation(operation.id, "uncertain", safeError.message);
      this.lastFailureAt = new Date().toISOString();
      this.lastFailure = safeError.message.slice(0, 500);
      this.options.logger.error({ event: "session-operation-uncertain", operationId: operation.id, bindingId: operation.bindingId, kind: operation.kind, outcome: "uncertain", err: safeError }, "Session operation failed after dispatch and was not replayed");
    }
  }
}

function syntheticMessage(operation: SessionOperation, binding: Binding): IncomingLarkMessage {
  const messageId = `session-operation:${operation.id}`;
  return { eventId: messageId, messageId, parentMessageId: null, chatId: binding.chatId, topicId: binding.topicId, rootMessageId: binding.rootMessageId, actorOpenId: operation.actorOpenId, text: operation.kind, mentionsBot: true, isRootMessage: false };
}
