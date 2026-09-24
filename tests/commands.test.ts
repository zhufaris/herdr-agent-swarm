import { describe, expect, it } from "vitest";
import { deriveTopicTitle, parseCommand, parseInstanceCommand, splitMessage } from "../src/domain/commands.js";
import { SWARM_COMMAND_DEFINITIONS, SWARM_COMMAND_POLICIES, swarmCommandDefinition, swarmCommandPolicy, swarmCommandSourceDecision } from "../src/domain/swarm-command.js";

describe("commands", () => {
  it("parses supported commands", () => {
    expect(parseCommand("/swarm new fix build")).toEqual({ kind: "new", title: "fix build", agentKind: "traex" });
    expect(parseCommand("/swarm new")).toEqual({ kind: "new", title: null, agentKind: "traex" });
    expect(parseCommand("/swarm new investigate login failures --agent codex")).toEqual({ kind: "new", title: "investigate login failures", agentKind: "codex" });
    expect(parseCommand("/swarm new --agent pi")).toEqual({ kind: "new", title: null, agentKind: "pi" });
    expect(parseCommand("/swarm new --agent unknown")).toEqual({ kind: "help" });
    expect(parseCommand("/swarm new --agent")).toEqual({ kind: "help" });
    expect(parseCommand("/swarm new --agent pi --agent codex")).toEqual({ kind: "help" });
    expect(parseCommand("/swarm new title --unknown value")).toEqual({ kind: "help" });
    expect(parseCommand("/swarm new title --agent pi trailing")).toEqual({ kind: "help" });
    expect(parseCommand("/swarm reset")).toEqual({ kind: "reset", title: null });
    expect(parseCommand("/swarm reset fresh start")).toEqual({ kind: "reset", title: "fresh start" });
    expect(parseCommand("/swarm projects")).toEqual({ kind: "projects" });
    expect(parseCommand("/swarm spaces")).toEqual({ kind: "spaces" });
    expect(parseCommand("/swarm spaces extra")).toEqual({ kind: "help" });
    expect(parseCommand("/swarm panes")).toEqual({ kind: "panes" });
    expect(parseCommand("/swarm panes extra")).toEqual({ kind: "help" });
    expect(parseCommand("/swarm sessions")).toEqual({ kind: "sessions", cursor: null });
    expect(parseCommand("/swarm sessions eyJpZCI6ImIxIn0")).toEqual({ kind: "sessions", cursor: "eyJpZCI6ImIxIn0" });
    expect(parseCommand("/swarm sessions bad!cursor")).toEqual({ kind: "help" });
    expect(parseCommand("/swarm failures")).toEqual({ kind: "failures" });
    expect(parseCommand("/swarm rename better title")).toEqual({ kind: "rename", title: "better title" });
    expect(parseCommand("/swarm status")).toEqual({ kind: "status" });
    expect(parseCommand("/swarm attach datasage_semantic_knowledge w5:p3G")).toEqual({ kind: "attach", spaceName: "datasage_semantic_knowledge", paneId: "w5:p3G" });
    expect(parseCommand("/swarm attach datasage_semantic_knowledge")).toEqual({ kind: "help" });
    expect(parseCommand("/swarm attach datasage_semantic_knowledge w5:p3G extra")).toEqual({ kind: "help" });
    expect(parseCommand("/swarm reattach w1:p9")).toEqual({ kind: "reattach", paneId: "w1:p9" });
    expect(parseCommand("/swarm replace")).toEqual({ kind: "replace" });
    expect(parseCommand("/swarm resume")).toEqual({ kind: "resume" });
    expect(parseCommand("/swarm awake")).toEqual({ kind: "awake" });
    expect(parseCommand("/swarm awake extra")).toEqual({ kind: "help" });
    expect(parseCommand("/swarm skip")).toEqual({ kind: "skip" });
    expect(parseCommand("/swarm skip prompt-1")).toEqual({ kind: "help" });
    expect(parseCommand("/swarm worker create reviewer")).toEqual({ kind: "worker_create", name: "reviewer", agentKind: "traex", model: null, start: false });
    expect(parseCommand("/swarm worker create reviewer --agent codex --model \"GPT 5\" --start")).toEqual({ kind: "worker_create", name: "reviewer", agentKind: "codex", model: "GPT 5", start: true });
    expect(parseCommand("/swarm worker create reviewer --start --start")).toEqual({ kind: "help" });
    expect(parseCommand("/swarm worker create reviewer --agent unknown")).toEqual({ kind: "help" });
    expect(parseCommand("/swarm worker delete reviewer")).toEqual({ kind: "help" });
    expect(parseCommand("/swarm close")).toEqual({ kind: "pane_close_request" });
    expect(parseCommand("/swarm close confirm A7K9Q2")).toEqual({ kind: "pane_close_confirm", code: "A7K9Q2" });
    expect(parseCommand("/swarm close confirm")).toEqual({ kind: "help" });
    expect(parseCommand("/swarm pane close")).toEqual({ kind: "pane_close_request" });
    expect(parseCommand("/swarm pane close confirm A7K9Q2")).toEqual({ kind: "pane_close_confirm", code: "A7K9Q2" });
    expect(parseCommand("/swarm pane close confirm")).toEqual({ kind: "help" });
    expect(parseCommand("/swarm pane rename")).toEqual({ kind: "help" });
    expect(parseCommand("/swarm model")).toEqual({ kind: "model", name: null });
    expect(parseCommand("/swarm model GPT-5.5")).toEqual({ kind: "model", name: "GPT-5.5" });
    expect(parseCommand(" /SWARM STOP " )).toEqual({ kind: "stop" });
    expect(parseCommand("/swarm stop now")).toEqual({ kind: "help" });
    expect(parseCommand("/swarm steer inspect the failing request")).toEqual({ kind: "steer", text: "inspect the failing request" });
    expect(parseCommand("/swarm steer")).toEqual({ kind: "help" });
    expect(parseCommand("/herdr status")).toBeNull();
    expect(parseCommand("/model GPT-5.5")).toBeNull();
    expect(parseCommand("/new fresh start")).toBeNull();
    expect(parseCommand("/stop")).toBeNull();
    expect(parseCommand("/steer inspect the failing request")).toBeNull();
    expect(parseCommand("hello")).toBeNull();
  });

  it("classifies every Swarm command through one exhaustive policy catalog", () => {
    expect(Object.keys(SWARM_COMMAND_POLICIES).sort()).toEqual([
      "attach", "awake", "close", "failures", "help", "model", "new", "pane_close_confirm", "pane_close_request", "panes", "projects", "reattach", "rename", "replace", "reset", "resume", "sessions", "skip", "spaces", "status", "steer", "stop", "worker_create"
    ]);
    expect(swarmCommandPolicy({ kind: "skip" })).toEqual({ mode: "mutation", scope: "active-turn", authorization: "creator", replay: "reconcilable", handler: "prompt-recovery" });
    expect(swarmCommandPolicy({ kind: "model", name: null })).toMatchObject({ mode: "query", replay: "none" });
    expect(swarmCommandPolicy({ kind: "model", name: "GPT-5" })).toMatchObject({ mode: "mutation", replay: "non-replayable" });
  });

  it("defines operator metadata and risk for every Swarm command", () => {
    expect(Object.keys(SWARM_COMMAND_DEFINITIONS).sort()).toEqual(Object.keys(SWARM_COMMAND_POLICIES).sort());
    for (const definition of Object.values(SWARM_COMMAND_DEFINITIONS)) {
      expect(definition.syntax).toMatch(/^\/swarm/);
      expect(definition.summary.length).toBeGreaterThan(0);
      expect(definition.examples.length).toBeGreaterThan(0);
      expect(definition.examples.every((example) => example.startsWith("/swarm"))).toBe(true);
    }
    expect(swarmCommandDefinition({ kind: "stop" }).risk).toBe("destructive-mutation");
    expect(swarmCommandDefinition({ kind: "skip" }).risk).toBe("destructive-mutation");
    expect(swarmCommandDefinition({ kind: "pane_close_confirm", code: "ABC" }).risk).toBe("destructive-mutation");
    expect(swarmCommandDefinition({ kind: "reset", title: null }).risk).toBe("recoverable-mutation");
    expect(swarmCommandDefinition({ kind: "model", name: null })).toMatchObject({ mode: "query", replay: "none", risk: "read-only" });
    expect(swarmCommandDefinition({ kind: "model", name: "GPT-5" })).toMatchObject({ mode: "mutation", replay: "non-replayable", risk: "recoverable-mutation" });
  });

  it("derives source-specific command risk decisions without changing literal semantics", () => {
    expect(swarmCommandSourceDecision({ kind: "status" }, "literal")).toBe("execute-query");
    expect(swarmCommandSourceDecision({ kind: "rename", title: "next" }, "natural-language")).toBe("admit");
    expect(swarmCommandSourceDecision({ kind: "stop" }, "natural-language")).toBe("confirm");
    expect(swarmCommandSourceDecision({ kind: "stop" }, "literal")).toBe("admit");
    expect(swarmCommandSourceDecision({ kind: "stop" }, "card")).toBe("admit");
    expect(swarmCommandSourceDecision({ kind: "stop" }, "primary-tool")).toBe("unsupported");
  });

  it("derives bounded titles and splits at line boundaries", () => {
    expect(deriveTopicTitle(`${"a".repeat(100)}\nbody`)).toHaveLength(80);
    expect(splitMessage("12345\n67890", 7)).toEqual(["12345", "67890"]);
  });
});

describe("instance commands", () => {
  it("parses the compact standalone command surface", () => {
    expect(parseInstanceCommand("/projects")).toEqual({ kind: "projects" });
    expect(parseInstanceCommand("/project alpha")).toEqual({ kind: "project", projectId: "alpha" });
    expect(parseInstanceCommand("/instances")).toEqual({ kind: "instances" });
    expect(parseInstanceCommand("/instance reviewer")).toEqual({ kind: "instance", name: "reviewer" });
    expect(parseInstanceCommand("/to reviewer inspect this")).toEqual({ kind: "to", name: "reviewer", text: "inspect this" });
    expect(parseInstanceCommand("/steer reviewer focus tests")).toEqual({ kind: "steer_instance", name: "reviewer", text: "focus tests" });
    expect(parseInstanceCommand("/stop reviewer")).toEqual({ kind: "stop_instance", name: "reviewer" });
    expect(parseInstanceCommand("/interrupt reviewer")).toEqual({ kind: "stop_instance", name: "reviewer" });
  });
});
