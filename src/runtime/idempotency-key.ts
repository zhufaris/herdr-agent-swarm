import { createHash } from "node:crypto";

export function contentIdempotencyKey(scope: string, content: unknown): string {
  const digest = createHash("sha256").update(JSON.stringify(content)).digest("hex");
  return `${scope}:${digest}`;
}
