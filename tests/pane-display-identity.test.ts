import { describe, expect, it } from "vitest";
import { displayPaneIdentity, normalizePaneToken } from "../src/domain/pane-display-identity.js";

describe("pane display identity", () => {
  it("prefers a normalized native token", () => {
    expect(normalizePaneToken(" VDFN ")).toBe("vdfn");
    expect(displayPaneIdentity({ paneToken: "VDFN", paneId: "wN:p4D" })).toBe("vdfn");
  });

  it("falls back to the full pane id when the token is missing or invalid", () => {
    expect(displayPaneIdentity({ paneToken: null, paneId: "wN:p4D" })).toBe("wN:p4D");
    expect(displayPaneIdentity({ paneToken: "invalid", paneId: "wN:p4D" })).toBe("wN:p4D");
  });
});
