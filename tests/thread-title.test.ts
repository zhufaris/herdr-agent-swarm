import { describe, expect, it } from "vitest";
import { formatProjectPaneTitle } from "../src/domain/thread-title.js";

describe("project and pane thread title", () => {
  it("formats the cwd basename and pane label", () => {
    expect(formatProjectPaneTitle("bridge-space", "/work/herdr-lark-bridge/", " card   markdown ", "wH:p8"))
      .toBe("bridge-space / card markdown");
  });

  it("falls back to the cwd basename and pane id", () => {
    expect(formatProjectPaneTitle(null, "/work/herdr-lark-bridge/", null, "wH:p8")).toBe("herdr-lark-bridge / wH:p8");
    expect(formatProjectPaneTitle(null, null, null, "wH:p8")).toBe("wH:p8");
    expect(formatProjectPaneTitle(null, "/", "pane", "wH:p8")).toBe("pane");
  });

  it("keeps both components recognizable within 80 characters", () => {
    const title = formatProjectPaneTitle("s".repeat(100), "/work/fallback", "very long pane name", "fallback");
    const [project, pane] = title.split(" / " );
    expect(title).toHaveLength(80);
    expect(project?.endsWith("…")).toBe(true);
    expect(pane).toBe("very long pane name");
  });
});
