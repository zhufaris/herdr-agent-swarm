import { describe, expect, it } from "vitest";
import { renderShortcutPanelCard } from "../src/cards/shortcut-panel-card.js";
import { cardKitToGatewayView } from "../src/gateways/feishu/cardkit-view.js";

describe("shortcut panel card", () => {
  it("contains only bounded navigation and existing workflow entry actions", () => {
    const serialized = JSON.stringify(renderShortcutPanelCard());
    expect(serialized).toContain("shortcut_panes");
    expect(serialized).toContain("shortcut_sessions");
    expect(serialized).toContain("shortcut_new_primary");
    expect(serialized).toContain("shortcut_model");
    expect(serialized).toContain("shortcut_help");
    expect(serialized).not.toMatch(/shortcut_(?:stop|reset|replace|archive|replay)/);
    expect(serialized).not.toContain('"tag":"action"');
    expect(cardKitToGatewayView(renderShortcutPanelCard())).toMatchObject({ schemaVersion: 1, nodes: expect.arrayContaining([expect.objectContaining({ kind: "columns" })]) });
  });
});
