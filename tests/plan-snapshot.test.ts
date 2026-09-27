import { describe, expect, it } from "vitest";
import { parsePlanToolCall } from "../src/runtime/plan-snapshot.js";

describe("parsePlanToolCall", () => {
  it("parses direct update_plan calls", () => {
    expect(parsePlanToolCall("update_plan", JSON.stringify({ plan: [
      { step: "Inspect state", status: "completed" },
      { step: "Run tests", status: "in_progress" }
    ] }))).toEqual([
      { key: "plan:0", label: "Inspect state", state: "done" },
      { key: "plan:1", label: "Run tests", state: "active" }
    ]);
  });

  it("parses exec-wrapped tools.update_plan calls with quoted or bare keys", () => {
    const input = `const r = await tools.update_plan({plan:[{step:"One",status:"pending"},{"step":"Two","status":"completed"}]});`;
    expect(parsePlanToolCall("exec", input)).toEqual([
      { key: "plan:0", label: "One", state: "pending" },
      { key: "plan:1", label: "Two", state: "done" }
    ]);
  });

  it("rejects malformed, truncated, oversized, and empty plans", () => {
    expect(parsePlanToolCall("update_plan", "{")) .toBeNull();
    expect(parsePlanToolCall("update_plan", JSON.stringify({ plan: [{ step: "  ", status: "pending" }] }))).toBeNull();
    expect(parsePlanToolCall("update_plan", JSON.stringify({ plan: Array.from({ length: 101 }, () => ({ step: "x", status: "pending" })) }))).toBeNull();
    expect(parsePlanToolCall("exec", "tools.update_plan({plan:[")).toBeNull();
  });
});
