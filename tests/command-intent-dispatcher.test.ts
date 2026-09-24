import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { CommandIntentDispatcher } from "../src/coordinator/command-intent-dispatcher.js";
import type { CommandIntent } from "../src/domain/command-intent.js";

describe("CommandIntentDispatcher", () => {
  it("claims and executes accepted work from one lane in durable FIFO order", async () => {
    const context = { chatId: "chat", topicId: null, rootMessageId: "root", sourceMessageId: "message", actorOpenId: "admin", projectId: "project", workspaceId: "workspace", primary: null };
    const intents: CommandIntent[] = ["first", "second"].map((id) => ({
      id, idempotencyKey: id, laneKey: "project:project", command: { kind: "new", title: id }, context,
      replayPolicy: "safe-before-effect", state: "executing", attemptCount: 1, outcome: null,
      claimedAt: "2026-09-24T00:00:00.000Z", createdAt: "2026-09-24T00:00:00.000Z", updatedAt: "2026-09-24T00:00:00.000Z"
    }));
    const claims = [...intents];
    const order: string[] = [];
    const store = {
      claimNextCommandIntent: vi.fn(() => claims.shift() ?? null),
      finishCommandIntent: vi.fn((id: string) => { order.push(`finish:${id}`); }),
      getBinding: vi.fn(), recoverExecutingCommandIntents: vi.fn(), listRecoverableCommandIntents: vi.fn(), audit: vi.fn()
    };
    const selectProject = vi.fn(async (_message, title: string) => { order.push(`effect:${title}`); });
    const dispatcher = new CommandIntentDispatcher({
      store, logger: pino({ enabled: false }), provisioning: { selectProject },
      resolver: { resolve: vi.fn() }, primaryPrompts: { getActiveOrdinaryPrompt: vi.fn() },
      outbound: { enqueueCard: vi.fn() }, modelSelection: {}, paneControl: {}, sessionAdministration: {}, paneClosure: {}, promptRun: {}, instanceControl: {},
      wakeCardContext: vi.fn(), presentation: {}
    } as never);

    await dispatcher.drain(intents[0]!);

    expect(order).toEqual(["effect:first", "finish:first", "effect:second", "finish:second"]);
    expect(store.claimNextCommandIntent).toHaveBeenCalledTimes(3);
  });
});
