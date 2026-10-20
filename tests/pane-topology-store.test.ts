import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { ReservePaneTopologyIntentInput } from "../src/domain/pane-topology-intent.js";
import { SqliteContext } from "../src/store/sqlite/context.js";
import { SqliteMigrations } from "../src/store/sqlite/migrations.js";
import { SqlitePaneTopologyStore } from "../src/store/sqlite/pane-topology-store.js";

const directories: string[] = [];
const contexts: SqliteContext[] = [];
afterEach(() => {
  for (const context of contexts.splice(0)) context.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function open(path = ":memory:"): SqlitePaneTopologyStore {
  const context = new SqliteContext(path);
  contexts.push(context);
  new SqliteMigrations(context).run();
  return new SqlitePaneTopologyStore(context);
}

const input = (patch: Partial<ReservePaneTopologyIntentInput> = {}): ReservePaneTopologyIntentInput => ({
  id: "topology-1",
  idempotencyKey: "worker:reviewer:1:primary-tab",
  owner: {
    kind: "worker", id: "worker-1", generation: 3, sessionGeneration: 4,
    parent: { id: "binding-1", generation: 7, sessionGeneration: 2, paneId: "w1:p1" }
  },
  expected: {
    workspaceId: "w1", paneId: "w1:p2", terminalId: "term-worker",
    agentSessionId: "session-worker", tabId: "w1:t2", paneLabel: "old-worker", tabLabel: "old"
  },
  desired: {
    tabId: "w1:t1", anchorPaneId: "w1:p1", paneLabel: "9e2u-reviewer", tabLabel: "9e2u"
  },
  ...patch
});

describe("Pane Topology Intent persistence", () => {
  it("converges exact reservation and fences claim, uncertainty, rearm, and receipt settlement", () => {
    const store = open();

    expect(store.reserve(input())).toMatchObject({ inserted: true, intent: { state: "pending", attemptCount: 0 } });
    expect(store.reserve(input())).toMatchObject({ inserted: false, intent: { id: "topology-1" } });
    expect(() => store.reserve(input({ desired: { ...input().desired, tabId: "w1:other" } }))).toThrow(/idempotency/i);

    const first = store.claimNext("2026-10-13T00:00:01.000Z");
    expect(first).toMatchObject({ id: "topology-1", state: "executing", attemptCount: 1 });
    expect(store.claimNext("2026-10-13T00:00:01.001Z")).toBeNull();
    expect(store.markUncertain({ id: first!.id, expectedAttemptCount: 1, detail: "transport timeout", at: "2026-10-13T00:00:02.000Z" }))
      .toMatchObject({ state: "uncertain", attemptCount: 1 });

    expect(store.rearmIfStillExpected({
      id: first!.id, expectedAttemptCount: 1,
      observed: input().expected, at: "2026-10-13T00:00:03.000Z"
    })).toMatchObject({ state: "pending", attemptCount: 1 });
    const second = store.claimNext("2026-10-13T00:00:04.000Z");
    expect(second).toMatchObject({ state: "executing", attemptCount: 2 });
    expect(store.finishSucceeded({
      id: second!.id, expectedAttemptCount: 2, at: "2026-10-13T00:00:04.500Z",
      receipt: { previousPaneId: "w1:p2", paneId: "w1:p3", tabId: "w1:wrong", workspaceId: "w1" }
    })).toBeNull();
    expect(store.finishSucceeded({
      id: second!.id, expectedAttemptCount: 2, at: "2026-10-13T00:00:05.000Z",
      receipt: { previousPaneId: "w1:p2", paneId: "w1:p3", tabId: "w1:t1", workspaceId: "w1" }
    })).toMatchObject({ state: "succeeded", resultPaneId: "w1:p3", resultTabId: "w1:t1" });
  });

  it("settles an uncertain effect from exact target observation without replaying move", () => {
    const store = open();
    store.reserve(input());
    const claim = store.claimNext("2026-10-13T00:00:01.000Z")!;
    store.markUncertain({ id: claim.id, expectedAttemptCount: 1, detail: "connection lost", at: "2026-10-13T00:00:02.000Z" });

    expect(store.finishSucceeded({
      id: claim.id, expectedAttemptCount: 1, at: "2026-10-13T00:00:03.000Z",
      receipt: { previousPaneId: "w1:p2", paneId: "w1:p3", tabId: "w1:t1", workspaceId: "w1" }
    })).toMatchObject({ state: "succeeded", attemptCount: 1, resultPaneId: "w1:p3" });
    expect(store.claimNext("2026-10-13T00:00:04.000Z")).toBeNull();
  });

  it("recovers an unresolved intent after reopening without another reservation", () => {
    const directory = mkdtempSync(join(tmpdir(), "pane-topology-"));
    directories.push(directory);
    const path = join(directory, "bridge.db");
    let store = open(path);
    store.reserve(input());
    contexts.pop()!.close();

    store = open(path);
    expect(store.listRecoverable()).toEqual([expect.objectContaining({ id: "topology-1", state: "pending" })]);
    expect(store.claimNext("2026-10-13T00:00:01.000Z")).toMatchObject({ id: "topology-1", attemptCount: 1 });
  });

  it("gives competing SQLite handles one durable effect-boundary winner", () => {
    const directory = mkdtempSync(join(tmpdir(), "pane-topology-claim-"));
    directories.push(directory);
    const path = join(directory, "bridge.db");
    const first = open(path);
    const second = open(path);
    first.reserve(input());

    const claims = [
      first.claimNext("2026-10-13T00:00:01.000Z"),
      second.claimNext("2026-10-13T00:00:01.001Z")
    ].filter((claim) => claim !== null);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ id: "topology-1", state: "executing", attemptCount: 1 });
  });
});
