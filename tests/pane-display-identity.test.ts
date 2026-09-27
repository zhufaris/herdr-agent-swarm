import { describe, expect, it } from "vitest";
import { displayNamedPaneIdentity, displayPaneIdentity, normalizePaneToken } from "../src/domain/pane-display-identity.js";

describe("pane display identity", () => {
  it("prefers a normalized native token", () => {
    expect(normalizePaneToken(" VDFN ")).toBe("vdfn");
    expect(displayPaneIdentity({ paneToken: "VDFN", paneId: "wN:p4D" })).toBe("vdfn");
  });

  it("falls back to the full pane id when the token is missing or invalid", () => {
    expect(displayPaneIdentity({ paneToken: null, paneId: "wN:p4D" })).toBe("wN:p4D");
    expect(displayPaneIdentity({ paneToken: "invalid", paneId: "wN:p4D" })).toBe("wN:p4D");
  });

  it("combines a stable pane name with the preferred runtime identity", () => {
    expect(displayNamedPaneIdentity({ paneName: " nxmz ", paneToken: "YX0C", paneId: "wN:p4E" })).toBe("nxmz · yx0c");
    expect(displayNamedPaneIdentity({ paneName: "nxmz", paneToken: null, paneId: "wN:p4E" })).toBe("nxmz · wN:p4E");
    expect(displayNamedPaneIdentity({ paneName: "yx0c", paneToken: "yx0c", paneId: "wN:p4E" })).toBe("yx0c");
    expect(displayNamedPaneIdentity({ paneName: "nxmz", paneToken: null, paneId: null })).toBe("nxmz");
    expect(displayNamedPaneIdentity({ paneName: null, paneToken: "yx0c", paneId: "wN:p4E" })).toBe("yx0c");
  });
});
