import { describe, expect, it, vi } from "vitest";
import type { AgentInstance } from "../src/domain/agent-instance.js";
import type { CompletionChoicePaneCandidate } from "../src/domain/ports/instance.js";
import type { Binding, PromptJob } from "../src/domain/types.js";
import type { InstanceTurn } from "../src/domain/instance-turn.js";
import { CompletionChoiceEligibility, type CompletionChoiceEligibilityStore } from "../src/runtime/completion-choice-eligibility.js";

const binding = {
  id: "binding", kind: "task", projectId: "project", workspaceId: "workspace", generation: 2, paneId: "workspace:primary", agentKind: "traex", agentSessionValue: "parent-session",
  state: "active", lifecycle: "active", attachment: "attached"
} as Binding;
const prompt = {
  id: "prompt", bindingId: "binding", state: "running", observationState: "attached"
} as PromptJob;
const worker = {
  id: "worker", projectId: "project", generation: 4, role: "worker", agentKind: "traex",
  workerSessionLifecycle: "active", desiredState: "running", observedState: "working",
  runtimeRef: { herdrWorkspaceId: "workspace", paneId: "workspace:worker", nativeSessionId: "session", generation: 4 },
  parent: { bindingId: "binding", bindingGeneration: 2, paneId: "workspace:primary", nativeSessionId: "parent-session" }
} as AgentInstance;
const turn = {
  id: "turn", projectId: "project", instanceId: "worker", instanceGeneration: 4,
  state: "running", runtimeTurnId: "runtime-turn", runtimeTurnStartedAt: "2026-10-02T00:00:00.000Z"
} as InstanceTurn;

function setup(values: { binding?: Binding | null; prompt?: PromptJob | null; worker?: AgentInstance | null; turn?: InstanceTurn | null; paneKind?: string | null; paneWorkspace?: string; paneSession?: string | null; candidates?: CompletionChoicePaneCandidate[] } = {}) {
  const selectedBinding = values.binding === undefined ? binding : values.binding;
  const selectedPrompt = values.prompt === undefined ? prompt : values.prompt;
  const selectedWorker = values.worker === undefined ? worker : values.worker;
  const selectedTurn = values.turn === undefined ? turn : values.turn;
  const store: CompletionChoiceEligibilityStore = {
    findCompletionChoicePaneCandidates: vi.fn((paneId: string) => values.candidates ?? [
      ...(selectedBinding?.paneId === paneId ? [{ kind: "primary" as const, binding: selectedBinding }] : []),
      ...(selectedWorker?.runtimeRef?.paneId === paneId ? [{ kind: "worker" as const, instance: selectedWorker }] : [])
    ]),
    getBinding: vi.fn(() => selectedBinding),
    getActiveOrdinaryPrompt: vi.fn(() => selectedPrompt),
    getAgentInstance: vi.fn(() => selectedWorker),
    getActiveInstanceTurn: vi.fn(() => selectedTurn)
  };
  const panes = { inspectPane: vi.fn(async (paneId: string) => ({ paneId, workspaceId: values.paneWorkspace ?? "workspace", cwd: "/repo", label: null, agentState: "working" as const, agentKind: values.paneKind === undefined ? "traex" : values.paneKind, agentSession: values.paneSession === null ? null : { source: "herdr:traex", agent: "traex", kind: "id" as const, value: values.paneSession ?? (paneId === "workspace:worker" ? "session" : "parent-session") }, foregroundExecutables: ["traex"] })) };
  return { eligibility: new CompletionChoiceEligibility(store, panes), store, panes };
}

describe("CompletionChoiceEligibility", () => {
  it("accepts the exact active attached TraeX Primary ordinary Prompt", async () => {
    const { eligibility } = setup({ worker: null, turn: null });
    await expect(eligibility.isEligible({ paneId: "workspace:primary" })).resolves.toBe(true);
  });

  it("accepts an active attached TraeX orchestrator Primary ordinary Prompt", async () => {
    const { eligibility } = setup({ binding: { ...binding, kind: "orchestrator" }, worker: null, turn: null });
    await expect(eligibility.isEligible({ paneId: "workspace:primary" })).resolves.toBe(true);
  });

  it("accepts the exact active attached TraeX Primary Pane without a legacy PromptJob", async () => {
    const { eligibility, store } = setup({ prompt: null, worker: null, turn: null });

    await expect(eligibility.isEligible({ paneId: "workspace:primary" })).resolves.toBe(true);
    expect(store.getActiveOrdinaryPrompt).not.toHaveBeenCalled();
  });

  it("accepts the exact observed TraeX Worker Turn and active parent", async () => {
    const { eligibility } = setup({ binding: { ...binding }, prompt: null });
    await expect(eligibility.isEligible({ paneId: "workspace:worker" })).resolves.toBe(true);
  });

  it.each([
    ["ordinary pane", { paneKind: null }],
    ["non-TraeX pane", { paneKind: "codex" }],
    ["wrong workspace", { paneWorkspace: "other-workspace" }],
    ["detached Primary", { binding: { ...binding, attachment: "detached" } }],
    ["replaced Primary runtime", { binding: { ...binding, agentSessionValue: "old-session" } }],
    ["missing durable Primary session", { binding: { ...binding, agentSessionValue: null, traexSessionId: null } }]
  ])("rejects an ineligible Primary identity: %s", async (_name, values) => {
    const { eligibility } = setup({ ...values, worker: null, turn: null } as Parameters<typeof setup>[0]);
    await expect(eligibility.isEligible({ paneId: "workspace:primary" })).resolves.toBe(false);
  });

  it.each([
    ["stale generation", { worker: { ...worker, generation: 5 } }],
    ["wrong Pane", { worker: { ...worker, runtimeRef: { ...worker.runtimeRef!, paneId: "workspace:other" } } }],
    ["replaced runtime", { worker: { ...worker, runtimeRef: { ...worker.runtimeRef!, nativeSessionId: "old-session" } } }],
    ["wrong workspace", { paneWorkspace: "other-workspace" }],
    ["missing observed session", { paneSession: null }],
    ["stopped", { worker: { ...worker, desiredState: "stopped" } }],
    ["detached", { worker: { ...worker, observedState: "detached" } }],
    ["non-TraeX runtime", { worker: { ...worker, agentKind: "codex" } }],
    ["inactive turn", { turn: { ...turn, state: "dispatch-uncertain" } }],
    ["unowned transcript", { turn: { ...turn, runtimeTurnId: null } }],
    ["inactive parent", { binding: { ...binding, state: "archived" } }],
    ["parent generation mismatch", { worker: { ...worker, parent: { ...worker.parent!, bindingGeneration: 3 } } }]
  ])("rejects an ineligible Worker identity: %s", async (_name, values) => {
    const { eligibility } = setup({ ...values, prompt: null } as Parameters<typeof setup>[0]);
    await expect(eligibility.isEligible({ paneId: "workspace:worker" })).resolves.toBe(false);
  });

  it("rejects absent and ambiguous Pane owners", async () => {
    const { eligibility, store } = setup({ binding: null, prompt: null, worker: null, turn: null });
    await expect(eligibility.isEligible({ paneId: "workspace:controller" })).resolves.toBe(false);
    expect(store.getActiveOrdinaryPrompt).not.toHaveBeenCalled();
    expect(store.getActiveInstanceTurn).not.toHaveBeenCalled();

    const ambiguous = setup({ candidates: [{ kind: "primary", binding }, { kind: "primary", binding }] });
    await expect(ambiguous.eligibility.isEligible({ paneId: "workspace:primary" })).resolves.toBe(false);
  });
});
