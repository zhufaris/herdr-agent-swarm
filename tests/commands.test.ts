import { describe, expect, it } from "vitest";
import { deriveTopicTitle, parseCommand, parseInstanceCommand, splitMessage } from "../src/domain/commands.js";

describe("commands", () => {
  it("parses supported commands", () => {
    expect(parseCommand("/swarm new fix build")).toEqual({ kind: "new", title: "fix build" });
    expect(parseCommand("/swarm new")).toEqual({ kind: "new", title: null });
    expect(parseCommand("/swarm reset")).toEqual({ kind: "reset", title: null });
    expect(parseCommand("/swarm reset fresh start")).toEqual({ kind: "reset", title: "fresh start" });
    expect(parseCommand("/swarm projects")).toEqual({ kind: "projects" });
    expect(parseCommand("/swarm spaces")).toEqual({ kind: "spaces" });
    expect(parseCommand("/swarm spaces extra")).toEqual({ kind: "help" });
    expect(parseCommand("/swarm sessions")).toEqual({ kind: "sessions" });
    expect(parseCommand("/swarm failures")).toEqual({ kind: "failures" });
    expect(parseCommand("/swarm rename better title")).toEqual({ kind: "rename", title: "better title" });
    expect(parseCommand("/swarm status")).toEqual({ kind: "status" });
    expect(parseCommand("/swarm attach datasage_semantic_knowledge w5:p3G")).toEqual({ kind: "attach", spaceName: "datasage_semantic_knowledge", paneId: "w5:p3G" });
    expect(parseCommand("/swarm attach datasage_semantic_knowledge")).toEqual({ kind: "help" });
    expect(parseCommand("/swarm attach datasage_semantic_knowledge w5:p3G extra")).toEqual({ kind: "help" });
    expect(parseCommand("/swarm reattach w1:p9")).toEqual({ kind: "reattach", paneId: "w1:p9" });
    expect(parseCommand("/swarm replace")).toEqual({ kind: "replace" });
    expect(parseCommand("/swarm resume")).toEqual({ kind: "resume" });
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
    expect(parseInstanceCommand("/interrupt reviewer")).toEqual({ kind: "interrupt_instance", name: "reviewer" });
  });
});
