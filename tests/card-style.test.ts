import { describe, expect, it } from "vitest";
import { cardSection, lifecycleMarker } from "../src/cards/card-style.js";

describe("shared card style", () => {
  it.each([
    ["ready", "✅"],
    ["completed", "✅"],
    ["queued", "⏳"],
    ["pending", "⏳"],
    ["running", "🧠"],
    ["active", "🧠"],
    ["blocked", "⚠️"],
    ["dispatch-uncertain", "⚠️"],
    ["failed", "❌"],
    ["cancelled", "⏹️"],
    ["stopped", "⏹️"],
    ["archived", "📦"],
    ["terminated", "📦"]
  ])("maps %s to %s", (state, marker) => {
    expect(lifecycleMarker(state)).toBe(marker);
  });

  it("marks only renderer-owned section labels", () => {
    expect(cardSection("💬", "最新消息")).toBe("**💬 最新消息**");
  });
});
