import { createHash } from "node:crypto";
import { resolve } from "node:path";

export interface PiTranscriptDescriptor { sessionId: string; sessionDir: string }

export function piSessionId(ownerId: string, generation: number): string {
  const digest = createHash("sha256").update(`herdr-agent-swarm:pi:${ownerId}:${generation}`).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export function piTranscriptDescriptor(root: string, ownerId: string, generation: number): PiTranscriptDescriptor {
  const sessionId = piSessionId(ownerId, generation);
  return { sessionId, sessionDir: resolve(root, safeSegment(ownerId), String(generation)) };
}

function safeSegment(value: string): string {
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 12);
  const prefix = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "binding";
  return `${prefix}-${digest}`;
}
