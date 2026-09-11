import { describe, expect, it } from "vitest";
import { canonicalTraexSession, sameAgentSession } from "../src/domain/traex-session-identity.js";

const session = (source: string, overrides: Record<string, unknown> = {}) => ({ source, agent: "traex", kind: "id" as const, value: "session-1", ...overrides });

describe("TraeX session identity", () => {
  it.each(["herdr:codex", "herdr-traex-shim", "herdr:traex"])("canonicalizes the legacy source %s", (source) => {
    expect(canonicalTraexSession(session(source))).toEqual(session("herdr:traex"));
    expect(sameAgentSession(session(source), session("herdr:traex"))).toBe(true);
  });

  it.each([
    ["agent", session("herdr:codex", { agent: "codex" })],
    ["kind", session("herdr:codex", { kind: "path" })],
    ["value", session("herdr:codex", { value: "session-2" })],
    ["source", session("other")]
  ])("does not weaken the %s fence", (_field, candidate) => {
    expect(sameAgentSession(candidate as never, session("herdr:traex"))).toBe(false);
  });

  it("does not rewrite an ordinary Codex session", () => {
    const codex = session("herdr:codex", { agent: "codex" });
    expect(canonicalTraexSession(codex as never)).toEqual(codex);
  });
});
