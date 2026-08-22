import { describe, expect, it } from "vitest";
import { deriveTopicTitle, parseCommand, splitMessage } from "../src/domain/commands.js";

describe("commands", () => {
  it("parses supported commands", () => {
    expect(parseCommand("/herdr new fix build")).toEqual({ kind: "new", title: "fix build" });
    expect(parseCommand("/herdr new")).toEqual({ kind: "new", title: null });
    expect(parseCommand("/herdr projects")).toEqual({ kind: "projects" });
    expect(parseCommand("/herdr spaces")).toEqual({ kind: "spaces" });
    expect(parseCommand("/herdr spaces extra")).toEqual({ kind: "help" });
    expect(parseCommand("/herdr rename better title")).toEqual({ kind: "rename", title: "better title" });
    expect(parseCommand("/herdr status")).toEqual({ kind: "status" });
    expect(parseCommand("/herdr attach datasage_semantic_knowledge w5:p3G")).toEqual({ kind: "attach", spaceName: "datasage_semantic_knowledge", paneId: "w5:p3G" });
    expect(parseCommand("/herdr attach datasage_semantic_knowledge")).toEqual({ kind: "help" });
    expect(parseCommand("/herdr attach datasage_semantic_knowledge w5:p3G extra")).toEqual({ kind: "help" });
    expect(parseCommand("/herdr reattach w1:p9")).toEqual({ kind: "reattach", paneId: "w1:p9" });
    expect(parseCommand("/herdr replace")).toEqual({ kind: "replace" });
    expect(parseCommand("/herdr resume")).toEqual({ kind: "resume" });
    expect(parseCommand("hello")).toBeNull();
  });

  it("derives bounded titles and splits at line boundaries", () => {
    expect(deriveTopicTitle(`${"a".repeat(100)}\nbody`)).toHaveLength(80);
    expect(splitMessage("12345\n67890", 7)).toEqual(["12345", "67890"]);
  });
});
