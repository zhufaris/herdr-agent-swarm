import type { OperationsQueryStore } from "../../domain/ports/workflow.js";
import type { SqliteBindingLifecycleStore } from "./binding-store.js";
import type { SqliteProjectionStore } from "./projection-store.js";
import type { SqliteInstanceStore } from "./instance-store.js";
import type { SqliteWorkerSessionThreadStore } from "./worker-session-thread-store.js";

/** Read-only aggregate shaped for operator directory and status queries. */
export class SqliteOperationsQueryCapabilityStore implements OperationsQueryStore {
  constructor(
    private readonly bindings: SqliteBindingLifecycleStore,
    private readonly projections: SqliteProjectionStore,
    private readonly instances: SqliteInstanceStore,
    private readonly workerThreads: SqliteWorkerSessionThreadStore
  ) {}

  listBindings: OperationsQueryStore["listBindings"] = () => this.bindings.listBindings();
  listWorkerInstancesByParent: OperationsQueryStore["listWorkerInstancesByParent"] = (input) => this.instances.listWorkerInstancesByParent(input);
  getWorkspaceLease: OperationsQueryStore["getWorkspaceLease"] = (id) => this.instances.getWorkspaceLease(id);
  resolveCanonicalWorkerThreadId: OperationsQueryStore["resolveCanonicalWorkerThreadId"] = (input) => this.workerThreads.resolveCanonicalDirectoryThreadId(input);
  loadTopicView: OperationsQueryStore["loadTopicView"] = (bindingId) => this.projections.loadTopicView(bindingId);
  listFailures: OperationsQueryStore["listFailures"] = (chatId) => this.bindings.listFailures(chatId);
  listSessions: OperationsQueryStore["listSessions"] = (chatId, cursor) => this.bindings.listSessions(chatId, cursor);
}
