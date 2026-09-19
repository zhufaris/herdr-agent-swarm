import { describe, expect, it } from "vitest";
import { instanceCardActionNames, parseCardActionCommand, retiredCardActionNames, sessionCardActionNames } from "../src/coordinator/card-action-command.js";

describe("card action command parsing", () => {
  it.each(instanceCardActionNames)("assigns %s only to instance interactions", (action) => {
    expect(parseCardActionCommand(validPayload(action))).toMatchObject({ kind: "instance", action });
  });

  it.each(sessionCardActionNames)("assigns %s only to session interactions", (action) => {
    expect(parseCardActionCommand(validPayload(action))).toMatchObject({ kind: "session", action });
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
    [{ action: "pane_primary_thread_forward", bindingId: "b1", bindingGeneration: "2", paneId: "pane-1", sourceMainMessageId: "om-main" }, null, { kind: "pane-directory", action: "pane_primary_thread_forward", bindingId: "b1", bindingGeneration: 2, paneId: "pane-1", sourceMainMessageId: "om-main" }],
    [{ action: "pane_worker_thread_forward", instanceId: "i1", generation: "4", workerSessionGeneration: "3", bindingId: "b1", bindingGeneration: "2", parentPaneId: "pane-1", sourceMainMessageId: "om-main" }, null, { kind: "pane-directory", action: "pane_worker_thread_forward", instanceId: "i1", generation: 4, workerSessionGeneration: 3, bindingId: "b1", bindingGeneration: 2, parentPaneId: "pane-1", sourceMainMessageId: "om-main" }],
    [{ action: "natural_language_command_confirm", confirmationId: "confirmation_1" }, null, { kind: "natural-language-confirmation", decision: "confirm", confirmationId: "confirmation_1" }],
    [{ action: "natural_language_command_cancel", confirmationId: "confirmation_1" }, null, { kind: "natural-language-confirmation", decision: "cancel", confirmationId: "confirmation_1" }],
  ] as const)("normalizes an owned action %#", (value, option, expected) => {
    expect(parseCardActionCommand(value, option)).toEqual(expected);
  });

  it("normalizes compatible decimal generation strings", () => {
    expect(parseCardActionCommand({ action: "instance_open", instanceId: "i1", generation: "2" })).toMatchObject({ kind: "instance", generation: 2 });
    expect(parseCardActionCommand({ action: "open_more_actions", bindingId: "b1", bindingGeneration: "3" })).toMatchObject({ kind: "session", bindingGeneration: 3 });
  });

  it("parses inline Primary Worker creation without client-supplied authority fields", () => {
    expect(parseCardActionCommand({ action: "primary_worker_create_submit", bindingId: "b1", bindingGeneration: "2", conversationKey: "binding:b1" })).toEqual({
      kind: "instance", action: "primary_worker_create_submit", bindingId: "b1", bindingGeneration: 2, conversationKey: "binding:b1"
    });
    expect(parseCardActionCommand({ action: "primary_worker_create_submit", bindingId: "b1", bindingGeneration: 2 })).toEqual({ kind: "unknown" });
    expect(parseCardActionCommand({ action: "worker_thread_send", instanceId: "i1", generation: 1, workerSessionGeneration: 1, bindingId: "b1", bindingGeneration: 2, conversationKey: "binding:b1", parentPaneId: "pane-1" })).toEqual({ kind: "unknown" });
  });

  it("requires coherent optional binding context", () => {
    expect(parseCardActionCommand({ action: "instance_open", instanceId: "i1", generation: 1, bindingId: "b1" })).toEqual({ kind: "unknown" });
    expect(parseCardActionCommand({ action: "instance_open", instanceId: "i1", generation: 1, bindingGeneration: 1 })).toEqual({ kind: "unknown" });
  });

  it.each([
    null, [], {}, { action: 1 }, { action: "unknown" },
    { action: "select_model", bindingId: "b1" },
    { action: "select_model", bindingId: "b1", option: "ignored" },
    { action: "open_project_thread" },
    { action: "select_project", selectionId: "s1" },
    { action: "claim_pane", projectId: "p1", workspaceId: "w1" },
    { action: "pane_primary_thread_forward", bindingId: "b1", bindingGeneration: 1, paneId: "pane-1" },
    { action: "pane_worker_thread_forward", instanceId: "i1", generation: 4, workerSessionGeneration: 3, bindingId: "b1", bindingGeneration: 2, parentPaneId: "pane-1" },
    { action: "session_archive", bindingId: "b1", bindingGeneration: 1 },
    { action: "instance_create_submit", projectId: "p1" },
    { action: "instance_open", instanceId: "i1", generation: -1 },
    { action: "worker_task_instruction_submit", turnId: "t1", instanceId: "i1", generation: 1, workerSessionGeneration: 1, sourceCardMessageId: "card", interactionId: "i1", requestedBy: "user", intent: "queue" },
    { action: "card_target_open", aggregateKind: "unknown", aggregateId: "i1", generation: 1, messageId: "card" },
    { action: "instance_open", instanceId: "i1", generation: 1, conversationKey: "x".repeat(201) },
    { action: "natural_language_command_confirm" },
  ])("maps malformed or unknown payload %# to the common fallback", (value) => {
    expect(parseCardActionCommand(value)).toEqual({ kind: "unknown" });
  });
});

function validPayload(action: typeof instanceCardActionNames[number] | typeof sessionCardActionNames[number]): Record<string, unknown> {
  const binding = { bindingId: "b1", bindingGeneration: 1 };
  if (action === "create_new_task") return { action };
  if (action === "primary_continue_form") return { action, ...binding, parentPromptId: "prompt-1", sourceAnswerMessageId: "answer-1" };
  if (action === "primary_continue_submit") return { action, ...binding, interactionId: "interaction-1", parentPromptId: "prompt-1", sourceAnswerMessageId: "answer-1", requestedBy: "user" };
  if ((sessionCardActionNames as readonly string[]).includes(action)) return { action, ...binding, ...(["open_rename", "open_reattach", "submit_rename", "submit_reattach", "session_stop", "session_model", "session_reset", "session_archive", "session_replace", "session_resume", "session_pane_close"].includes(action) ? { interactionId: "interaction-1" } : {}) };
  if (action === "card_target_open") return { action, aggregateKind: "worker-turn", aggregateId: "turn-1", generation: 1, messageId: "card-1" };
  if (action === "primary_worker_create_submit") return { action, ...binding, conversationKey: "binding:b1" };
  if (action === "instance_create_form" || action === "instance_create_submit") return { action, projectId: "p1", ...(action.endsWith("submit") ? { requestedBy: "user" } : {}) };
  if (action === "worker_thread_send") return { action, instanceId: "i1", generation: 1, workerSessionGeneration: 1 };
  if (action.startsWith("worker_new_task_")) return { action, instanceId: "i1", generation: 1, workerSessionGeneration: 1, sourceCardMessageId: "card-1", ...(action.endsWith("submit") ? { interactionId: "interaction-1", requestedBy: "user" } : {}) };
  if (action.startsWith("worker_task_")) return { action, turnId: "turn-1", instanceId: "i1", generation: 1, workerSessionGeneration: 1, sourceCardMessageId: "card-1", ...(action.endsWith("submit") ? { interactionId: "interaction-1", requestedBy: "user", intent: "steer" } : {}) };
  return { action, instanceId: "i1", generation: 1, ...(action === "instance_turn_open" ? { turnId: "turn-1" } : {}), ...(action === "instance_steer_submit" ? { requestedBy: "user" } : {}), ...(action === "instance_confirm_removal" ? { requestedBy: "user", planId: "plan-1" } : {}) };
}
