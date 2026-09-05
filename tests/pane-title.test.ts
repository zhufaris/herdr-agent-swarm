import { describe, expect, it } from "vitest";
import { createPrimaryPaneToken, primaryPaneToken } from "../src/domain/pane-title.js";

describe("Primary pane tokens", () => {
  it("creates exactly four lowercase base36 characters", () => {
    expect(createPrimaryPaneToken()).toMatch(/^[a-z0-9]{4}$/);
  });

  it.each([
    ["e8g2", "e8g2"],
    ["lark_ilcs", "ilcs"],
    ["LARK_ILCS", "ilcs"],
    ["lark_task-ilcs", "ilcs"],
    ["task-ilcs", "ilcs"],
    ["  lark_iLcS  ", "ilcs"]
  ])("extracts a canonical token from %s", (label, expected) => {
    expect(primaryPaneToken(label, "pane-1")).toBe(expected);
  });

  it.each([null, "", "primary-ilcs", "prefix-lark_ilcs", "lark_ilcs-extra", "abc", "abcde"])
    ("uses a deterministic pane-id fallback for noncanonical label %s", (label) => {
      const token = primaryPaneToken(label, "pane-1");
      expect(token).toMatch(/^[a-z0-9]{4}$/);
      expect(token).toBe(primaryPaneToken(label, "pane-1"));
      expect(token).toBe(primaryPaneToken(null, "pane-1"));
      expect(token).not.toBe(primaryPaneToken(null, "pane-2"));
    });

  it("derives the fallback from the full SHA-256 value in base36", () => {
    expect(primaryPaneToken(null, "pane-1")).toBe("1de2");
  });
});
