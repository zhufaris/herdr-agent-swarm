import { describe, expect, it } from "vitest";
import { formatProjectPaneTitle } from "../src/domain/thread-title.js";

describe("project and pane thread title", () => {
  it("formats the cwd basename and pane label", () => {
    expect(formatProjectPaneTitle("/work/herdr-lark-bridge/", " card   markdown ", "wH:p8"))
      .toBe("herdr-lark-bridge / card markdown");
  });

  it("falls back safely when cwd or pane label is missing", () => {
    expect(formatProjectPaneTitle(null, null, "wH:p8")).toBe("wH:p8");
    expect(formatProjectPaneTitle("/", "pane", "wH:p8")).toBe("pane");
  });

  it("keeps both components recognizable within 80 characters", () => {
    const title = formatProjectPaneTitle(`/work/${"p".repeat(100)}`, "very long pane name", "fallback");
    const [project, pane] = title.split(" / " );
    expect(title).toHaveLength(80);
    expect(project?.endsWith("…")).toBe(true);
    expect(pane).toBe("very long pane name");
  });
});
