import { describe, expect, it } from "vitest";
import { isNativeTraexSession, sameNativeTraexSession } from "../src/domain/traex-session-identity.js";

const session = (source: string, overrides: Record<string, unknown> = {}) => ({ source, agent: "traex", kind: "id" as const, value: "session-1", ...overrides });

describe("TraeX session identity", () => {
  it("accepts only the exact native Herdr TraeX identity", () => {
    expect(isNativeTraexSession(session("herdr:traex"))).toBe(true);
    expect(sameNativeTraexSession(session("herdr:traex"), session("herdr:traex"))).toBe(true);
  });

  it.each([
    ["legacy Codex source", session("herdr:codex")],
    ["retired shim source", session("herdr-traex-shim")],
    ["agent", session("herdr:traex", { agent: "codex" })],
    ["kind", session("herdr:traex", { kind: "path" })],
    ["empty value", session("herdr:traex", { value: "" })]
  ])("rejects %s", (_field, candidate) => {
    expect(isNativeTraexSession(candidate as never)).toBe(false);
    expect(sameNativeTraexSession(candidate as never, session("herdr:traex"))).toBe(false);
  });

  it("preserves every exact tuple fence", () => {
    expect(sameNativeTraexSession(session("herdr:traex"), session("herdr:traex", { value: "session-2" }))).toBe(false);
  });
});
