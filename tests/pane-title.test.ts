import { describe, expect, it } from "vitest";
import { canonicalPrimaryPaneToken, createPrimaryPaneToken, paneIdentityLabels, primaryGroupToken, primaryPaneToken } from "../src/domain/pane-title.js";

describe("Primary pane tokens", () => {
  it.each([
    ["managed-primary", { kind: "managed-primary" } as const, "9e2u-main"],
    ["default-primary", { kind: "default-primary" } as const, "9e2u-default-main"],
    ["worker", { kind: "worker", name: "reviewer" } as const, "9e2u-reviewer"]
  ])("derives one canonical %s identity from the owning Group Token", (_kind, role, paneLabel) => {
    expect(paneIdentityLabels("9E2U", role)).toEqual({ groupToken: "9e2u", tabLabel: "9e2u", paneLabel });
  });

  it("prefers the authoritative pane token over a legacy display label", () => {
    expect(primaryGroupToken({ paneToken: "VDFN", label: "lark_ilcs", paneId: "w1:p1" })).toBe("vdfn");
    expect(primaryGroupToken({ paneToken: null, label: "lark_ilcs", paneId: "w1:p1" })).toBe("ilcs");
    expect(primaryGroupToken({ paneToken: null, label: null, paneId: "pane-1" })).toBe("1de2");
  });

  it("rejects invalid Group Tokens and Worker names before rendering identity", () => {
    expect(() => paneIdentityLabels("bad", { kind: "managed-primary" })).toThrow(/Group Token/);
    expect(() => paneIdentityLabels("9e2u", { kind: "worker", name: "Reviewer Name" })).toThrow(/Worker name/);
  });

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
    expect(canonicalPrimaryPaneToken(label)).toBe(expected);
    expect(primaryPaneToken(label, "pane-1")).toBe(expected);
  });

  it.each([null, "", "primary-ilcs", "prefix-lark_ilcs", "lark_ilcs-extra", "abc", "abcde"])
    ("does not expose a fallback token for noncanonical label %s", (label) => {
      expect(canonicalPrimaryPaneToken(label)).toBeNull();
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
