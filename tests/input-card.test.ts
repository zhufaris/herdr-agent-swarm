import { describe, expect, it } from "vitest";
import { renderInputCard } from "../src/cards/input-card.js";

describe("renderInputCard", () => {
  it.each([
    ["pending", "⏳ Input · Pending", "等待 Herdr 将对应 Human Message 写入 canonical JSONL。", "orange-50"],
    ["working", "✅ Input · Working", "已从 Herdr Core canonical JSONL 观察到对应 Human Message。", "blue-50"]
  ] as const)("renders the Answer-like %s state", (state, title, detail, background) => {
    const card = renderInputCard({ submissionId: "submission-1", state, ownerKind: "primary", text: "检查当前状态" }) as any;
    expect(card.header.title.content).toBe(title);
    expect(card.body.elements).toHaveLength(4);
    expect(card.body.elements[1]).toMatchObject({ tag: "column_set", background_style: background });
    expect(card.body.elements[1].columns[0].elements[0].content).toBe(detail);
    expect(card.body.elements[3].content).toContain("检查当前状态");
  });

  it("renders a bounded pending Turn Card shell with sanitized full Human text", () => {
    const text = `Please inspect token=super-secret-value and ${"x".repeat(12_000)}`;
    const card = renderInputCard({ submissionId: "submission-1", state: "pending", ownerKind: "primary", text }) as any;
    const serialized = JSON.stringify(card);
    expect(card.header.title.content).toBe("⏳ Input · Pending");
    expect(serialized).toContain("等待 Herdr");
    expect(serialized).toContain("Please inspect token");
    expect(serialized).not.toContain("token=super-secret-value");
    expect(serialized.length).toBeLessThan(12_000);
  });
});
