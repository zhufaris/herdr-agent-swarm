import { describe, expect, it } from "vitest";
import { renderInstanceDetailCard } from "../src/cards/instance-detail-card.js";
import { renderModelResultCard } from "../src/cards/model-card.js";
import { renderSessionCards } from "../src/cards/operations-card.js";
import { renderPaneCloseConfirmationCard } from "../src/cards/pane-close-card.js";
import { renderAttachStatusCard } from "../src/cards/run-card.js";
import { renderSpaceDirectoryCards } from "../src/cards/space-directory-card.js";
import { renderTopicPaneDirectoryCard } from "../src/cards/topic-pane-directory-card.js";
import { renderWorkerHumanReviewNotification } from "../src/cards/worker-human-review-notification.js";
import { renderWorkerMainCard } from "../src/cards/worker-main-card.js";
import { createWorkerMainView } from "../src/domain/worker-main-view.js";

const paneId = "wN:p4D";
const paneToken = "vdfn";

describe("pane token card display", () => {
  it("uses the native token across Primary, model, close, and operations cards", () => {
    const cards = [
      renderAttachStatusCard({ spaceName: "swarm", paneId, paneToken }),
      renderModelResultCard({ bindingId: "binding-1", spaceName: "swarm", paneId, paneToken, output: "ok", switched: true }),
      renderPaneCloseConfirmationCard({ spaceName: "swarm", paneId, paneToken, agentState: "idle", workerPaneCount: 0, code: "ABC123", expiresAt: "later" }),
      ...renderSessionCards([{ queueDepth: 0, binding: binding() }])
    ];

    for (const card of cards) {
      const text = JSON.stringify(card);
      expect(text).toContain(paneToken);
      expect(text).not.toContain(paneId);
    }
  });

  it("uses tokens in Worker and directory text while retaining pane ids in callback payloads", () => {
    const workerMain = createWorkerMainView({
      workerId: "worker-1", workerSessionGeneration: 1, parentBindingId: "binding-1", parentBindingGeneration: 1,
      parentPaneId: paneId, parentPaneToken: paneToken, workerName: "reviewer", ownerName: "Primary",
      runtimeGeneration: 1, runtimeState: "idle", runtimeAttached: true, desiredState: "running", parentActive: true,
      paneId: "wN:p5E", paneToken: "wk42", workspace: "/repo", branch: null, model: null, occurredAt: "now"
    });
    const mainText = JSON.stringify(renderWorkerMainCard(workerMain));
    expect(mainText).toContain("vdfn");
    expect(mainText).toContain("wk42");
    expect(mainText).not.toContain("wN:p4D");
    expect(mainText).not.toContain("wN:p5E");

    const reviewText = JSON.stringify(renderWorkerHumanReviewNotification({
      state: "waiting",
      workerId: "worker-1", workerSessionGeneration: 1, workerName: "reviewer", turnId: "turn-1", taskTitle: "review",
      primaryName: "Primary", parentPaneId: paneId, parentPaneToken: paneToken, workerPaneId: "wN:p5E", workerPaneToken: "wk42",
      notice: "local action", creatorOpenId: null, workerMainMessageId: null
    }));
    expect(reviewText).toContain("vdfn");
    expect(reviewText).toContain("wk42");
    expect(reviewText).not.toContain("wN:p4D");
    expect(reviewText).not.toContain("wN:p5E");

    const topicText = JSON.stringify(renderTopicPaneDirectoryCard([{
      bindingId: "binding-1", bindingGeneration: 1, paneId, paneToken, sourceMainMessageId: "main-1", title: "Primary", spaceName: "swarm", agentState: "idle",
      workers: [{ workerId: "worker-1", runtimeGeneration: 1, workerSessionGeneration: 1, workerName: "reviewer", paneId: "wN:p5E", paneToken: "wk42", state: "idle" }]
    }]));
    expect(topicText).toContain("Primary `vdfn`");
    expect(topicText).toContain("Pane `wk42`");
    expect(topicText).toContain('\"paneId\":\"wN:p4D\"');
    expect(topicText).toContain('\"parentPaneId\":\"wN:p4D\"');

    const spaceText = JSON.stringify(renderSpaceDirectoryCards([{
      spaceName: "swarm", workspaceId: "wN", directories: ["/repo"],
      panes: [{ paneId, paneToken, name: "Primary", agentState: "idle", foregroundExecutables: ["traex"], claimProjectId: "swarm" }]
    }]));
    expect(spaceText).toContain("`vdfn`");
    expect(spaceText).toContain('\"paneId\":\"wN:p4D\"');
  });

  it("falls back to the full pane id when no valid native token exists", () => {
    expect(JSON.stringify(renderAttachStatusCard({ spaceName: "swarm", paneId }))).toContain(paneId);
    expect(JSON.stringify(renderAttachStatusCard({ spaceName: "swarm", paneId, paneToken: "invalid" }))).toContain(paneId);
  });

  it("uses the token in instance details", () => {
    const text = JSON.stringify(renderInstanceDetailCard({
      instance: { id: "worker-1", projectId: "swarm", name: "reviewer", role: "worker", agentKind: "traex", model: null, sourcePrimaryPaneLabel: null, parent: null, workerSessionLifecycle: "active", workerSessionGeneration: 1, desiredState: "running", observedState: "idle", workspaceLeaseId: "lease-1", generation: 1, runtimeRef: { herdrWorkspaceId: "wN", paneId, paneToken, nativeSessionId: "session-1", generation: 1 }, pendingRuntimeRef: null, provisioningCheckpoint: "verified", lastError: null },
      workspace: { id: "lease-1", projectId: "swarm", instanceId: "worker-1", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "abc", state: "ready", generation: 1 },
      capabilities: { available: true, structuredEvents: true, nativeResume: true, primaryTools: true, steering: "unsupported", interrupt: "native", approvals: "terminal", modelSelection: "runtime", usageReporting: true },
      turns: [], queueDepth: 0
    }));
    expect(text).toContain("wN / vdfn");
    expect(text).not.toContain(paneId);
  });
});

function binding() {
  return {
    id: "binding-1", gatewayId: "lark", creatorOpenId: null, projectId: "swarm", workspaceId: "wN", chatId: "chat", topicId: "topic",
    rootMessageId: "root", retiredTopicId: null, retiredRootMessageId: null, replacesBindingId: null, reservedTopicId: null, reservedRootMessageId: null, resetMessageId: null,
    paneId, paneToken, traexSessionId: null, title: "Primary", agentKind: "traex" as const, state: "active" as const, statusMessageId: "main", statusCardSequence: 0,
    lastAgentState: "idle" as const, lastOutputFingerprint: null, lifecycle: "active" as const, attachment: "attached" as const, generation: 1, provisioningCheckpoint: "activated" as const,
    degradationCount: 0, hasCompletedTurn: false, lastObservedAt: null, archivedAt: null, lastActivityAt: "now", createdAt: "now", updatedAt: "now"
  };
}
