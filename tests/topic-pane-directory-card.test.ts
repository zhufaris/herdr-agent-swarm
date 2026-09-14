import { describe, expect, it } from "vitest";
import { renderTopicPaneDirectoryCard } from "../src/cards/topic-pane-directory-card.js";
import { renderPaneThreadEntryCard } from "../src/cards/run-card.js";
import { initialTopicView } from "../src/domain/topic-view.js";

describe("topic pane directory card", () => {
  it("renders each active pane with an identity-fenced send action", () => {
    const card = renderTopicPaneDirectoryCard([{
      bindingId: "binding-1", bindingGeneration: 4, paneId: "work:p1", sourceMainMessageId: "om_main",
      title: "Build * release", spaceName: "core", agentState: "working", workers: [{ workerId: "worker-1", runtimeGeneration: 4, workerSessionGeneration: 2, workerName: "reviewer", paneId: "work:p2", state: "working" }]
    }]);

    const serialized = JSON.stringify(card);
    expect(serialized).toContain("pane_primary_thread_forward");
    expect(serialized).toContain("\"bindingGeneration\":4");
    expect(serialized).toContain("\"sourceMainMessageId\":\"om_main\"");
    expect(serialized).toContain("Build \\\\* release");
    expect(serialized).toContain("转发 Primary Thread");
    expect(serialized).toContain("🧭 Swarm Panes");
    expect(serialized).toContain("🤖 **reviewer**");
    expect(serialized).toContain("work:p2");
    expect(serialized).toContain('"action":"pane_worker_thread_forward"');
    expect(serialized).toContain('"generation":4');
    expect(serialized).toContain('"parentPaneId":"work:p1"');
    expect(serialized).toContain('"sourceMainMessageId":"om_main"');
    expect(serialized).toContain("转发 Worker Thread");
    expect(serialized).not.toContain('"action":"pane_card_send"');
    expect(serialized).not.toContain('"action":"worker_thread_send"');
  });

  it("renders a passive pane entry snapshot without canonical navigation buttons", () => {
    const card = renderPaneThreadEntryCard({ ...initialTopicView("b1"), title: "Task", spaceName: "core", paneId: "w1:p1", workers: [{ instanceId: "worker", name: "reviewer", state: "idle", currentTaskTitle: null, queueCount: 0, workerMain: { aggregateKind: "worker-session", aggregateId: "worker", generation: 1, messageId: "worker-main" } }] });
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("回复此话题继续交互");
    expect(serialized).toContain("同步当前 Pane 状态");
    expect(serialized).not.toContain("主状态请以原始 Main Card 为准");
    expect(serialized).not.toContain('"tag":"button"');
    expect(serialized).not.toContain('"tag":"form"');
    expect(serialized).not.toContain("card_target_open");
  });

  it("renders an explicit empty state and bounds the directory", () => {
    expect(JSON.stringify(renderTopicPaneDirectoryCard([]))).toContain("当前群中没有可发送的 active Pane 卡片。");
    const entries = Array.from({ length: 41 }, (_, index) => ({
      bindingId: `binding-${index}`, bindingGeneration: index, paneId: `work:p${index}`, sourceMainMessageId: `om-${index}`,
      title: `Task ${index}`, spaceName: "core", agentState: "idle" as const, workers: []
    }));
    const serialized = JSON.stringify(renderTopicPaneDirectoryCard(entries));
    expect((serialized.match(/pane_primary_thread_forward/g) ?? [])).toHaveLength(40);
    expect(serialized).toContain("仅展示前 40 个 active Pane。");
  });

  it("bounds Worker panes under a Primary without losing the overflow signal", () => {
    const workers = Array.from({ length: 9 }, (_, index) => ({ workerId: `worker-${index}`, runtimeGeneration: 1, workerSessionGeneration: 1, workerName: `worker-${index}`, paneId: `work:p${index + 2}`, state: "idle" as const }));
    const serialized = JSON.stringify(renderTopicPaneDirectoryCard([{ bindingId: "binding-1", bindingGeneration: 1, paneId: "work:p1", sourceMainMessageId: "om-main", title: "Primary", spaceName: "core", agentState: "idle", workers }]));
    expect(serialized).toContain("另有 1 个 Worker Pane 未展示");
    expect(serialized).toContain("worker-7");
    expect(serialized).not.toContain("worker-8");
  });
});
