import { describe, expect, it } from "vitest";
import { instanceCardActionNames, parseCardActionCommand, retiredCardActionNames, sessionCardActionNames } from "../src/coordinator/card-action-command.js";

describe("card action command parsing", () => {
  it.each(instanceCardActionNames)("assigns %s only to instance interactions", (action) => {
    expect(parseCardActionCommand({ action })).toMatchObject({ kind: "instance", value: { action } });
  });

  it.each(sessionCardActionNames)("assigns %s only to session interactions", (action) => {
    expect(parseCardActionCommand({ action })).toMatchObject({ kind: "session", value: { action } });
  });

  it.each(retiredCardActionNames)("keeps retired action %s distinct", (action) => {
    expect(parseCardActionCommand({ action })).toEqual({ kind: "retired", action });
  });

  it.each([
    [{ action: "select_model", bindingId: "b1" }, "gpt-5.4", { kind: "model", bindingId: "b1", model: "gpt-5.4" }],
    [{ action: "select_model_mode", bindingId: "b1", operationId: "op1" }, "high", { kind: "model-mode", bindingId: "b1", operationId: "op1", mode: "high" }],
    [{ action: "open_project_thread", bindingId: "b1" }, null, { kind: "open-thread", bindingId: "b1" }],
    [{ action: "retry_dead_letter", replyId: "r1" }, null, { kind: "dead-letter", decision: "retry_dead_letter", replyId: "r1" }],
    [{ action: "dismiss_dead_letter", replyId: "r1" }, null, { kind: "dead-letter", decision: "dismiss_dead_letter", replyId: "r1" }],
    [{ action: "select_project", selectionId: "s1", projectId: "p1" }, null, { kind: "project-selection", selectionId: "s1", projectId: "p1" }],
    [{ action: "claim_pane", projectId: "p1", workspaceId: "w1", paneId: "pane-1" }, null, { kind: "pane-claim", projectId: "p1", workspaceId: "w1", paneId: "pane-1" }],
  ] as const)("normalizes an owned action %#", (value, option, expected) => {
    expect(parseCardActionCommand(value, option)).toEqual(expected);
  });

  it.each([
    null, [], {}, { action: 1 }, { action: "unknown" },
    { action: "select_model", bindingId: "b1" },
    { action: "select_model", bindingId: "b1", option: "ignored" },
    { action: "open_project_thread" },
    { action: "select_project", selectionId: "s1" },
    { action: "claim_pane", projectId: "p1", workspaceId: "w1" },
  ])("maps malformed or unknown payload %# to the common fallback", (value) => {
    expect(parseCardActionCommand(value)).toEqual({ kind: "unknown" });
  });
});
