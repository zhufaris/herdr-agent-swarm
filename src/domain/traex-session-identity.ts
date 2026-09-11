import type { HerdrAgentSession } from "./types.js";

export function isNativeTraexSession(session: HerdrAgentSession | null | undefined): session is HerdrAgentSession {
  return session?.source === "herdr:traex"
    && session.agent === "traex"
    && session.kind === "id"
    && session.value.trim().length > 0;
}

export function sameNativeTraexSession(left: HerdrAgentSession, right: HerdrAgentSession): boolean {
  return isNativeTraexSession(left)
    && isNativeTraexSession(right)
    && left.source === right.source
    && left.agent === right.agent
    && left.kind === right.kind
    && left.value === right.value;
}
