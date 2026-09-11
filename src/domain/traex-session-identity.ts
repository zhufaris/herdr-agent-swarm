import type { HerdrAgentSession } from "./types.js";

const CANONICAL_TRAEX_SOURCE = "herdr:traex";
const TRAEX_SOURCE_ALIASES = new Set(["herdr:codex", "herdr-traex-shim", CANONICAL_TRAEX_SOURCE]);

export function canonicalTraexSession(session: HerdrAgentSession): HerdrAgentSession {
  return session.agent === "traex" && TRAEX_SOURCE_ALIASES.has(session.source)
    ? { ...session, source: CANONICAL_TRAEX_SOURCE }
    : session;
}

export function sameAgentSession(left: HerdrAgentSession, right: HerdrAgentSession): boolean {
  const canonicalLeft = canonicalTraexSession(left);
  const canonicalRight = canonicalTraexSession(right);
  return canonicalLeft.source === canonicalRight.source
    && canonicalLeft.agent === canonicalRight.agent
    && canonicalLeft.kind === canonicalRight.kind
    && canonicalLeft.value === canonicalRight.value;
}
