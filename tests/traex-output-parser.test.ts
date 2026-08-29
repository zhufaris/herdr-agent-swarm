import { describe, expect, it } from "vitest";
import { extractTraexTelemetry, stripTraexConsoleStatus } from "../src/runtime/traex-output-parser.js";

describe("TraeX terminal control-plane parser", () => {
  it("extracts trusted model and context telemetry", () => {
    expect(extractTraexTelemetry("GPT-5.6-Sol · Auto Mode · 31.1K tokens")).toEqual({
      model: "GPT-5.6-Sol", context: "31.1K tokens"
    });
  });

  it("extracts telemetry only from the bounded terminal tail", () => {
    const early = "GPT-5.6-Sol · Auto Mode · 1K tokens";
    const tail = ["GPT-5.6-Terra · Auto Mode · 31.1K tokens", ...Array.from({ length: 39 }, (_, index) => `tail ${index}`)].join("\n");

    expect(extractTraexTelemetry(`${early}\n${tail}`)).toEqual({
      model: "GPT-5.6-Terra", context: "31.1K tokens"
    });
  });

  it("removes orchestration status from compact card previews", () => {
    const source = ["Keep this", "5 agents running… · /ps to manage", "● Main [default] running · 20m"].join("\n");
    expect(stripTraexConsoleStatus(source)).toBe("Keep this");
  });
});
