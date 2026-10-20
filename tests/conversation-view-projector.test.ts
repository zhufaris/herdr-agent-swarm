import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";
import { ConversationViewProjector } from "../src/events/conversation-view-projector.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";
import { initialTopicView } from "../src/domain/topic-view.js";
import { primaryPresentation } from "./helpers/presentation.js";

let store: SqliteBindingStore | undefined;
afterEach(() => { store?.close(); store = undefined; });

describe("ConversationViewProjector", () => {
  it("persists an authoritative Binding session fence without a presentation revision", async () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "binding", projectId: "project", workspaceId: "herdr", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Primary" });
    store.updateBinding("binding", {
      state: "active", lifecycle: "active", attachment: "attached", paneId: "primary:pane",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "native-1", sessionEpoch: 1
    });
    store.saveTopicView({ ...initialTopicView("binding"), title: "Primary", workspaceId: "herdr", paneId: "primary:pane", viewVersion: 7 });
    const bus = new BridgeEventBus();
    const publisher = { onAnswerCheckpoint: () => () => {}, requestScan: async () => {}, async enqueueCard() {}, async enqueueCardUpdate() {}, async enqueueRunCardUpdate() {}, async enqueueStreamCardCreate() {}, async enqueueStreamFinish() {}, async enqueueStreamContent() {} };
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false }), primaryPresentation, { converge: async () => undefined }, { project: async () => undefined, converge: async () => undefined });
    projector.start();

    await bus.publish({ eventId: "binding-current", bindingId: "binding", type: "BindingCreated", origin: "bridge", occurredAt: "2026-10-18T00:00:00.000Z", payload: { title: "Primary", workspaceId: "herdr", paneId: "primary:pane" } });

    expect(store.loadTopicView("binding")).toMatchObject({
      viewVersion: 7,
      sessionIdentity: { bindingGeneration: 1, sessionEpoch: 1, nativeSessionId: "native-1", paneId: "primary:pane", rootMessageId: "root" }
    });
    await projector.stop();
  });
});
