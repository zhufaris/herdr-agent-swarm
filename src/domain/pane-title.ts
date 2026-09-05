import { createHash, randomBytes } from "node:crypto";

const PRIMARY_PANE_TOKEN_PATTERN = /^(?:lark_|lark_task-|task-)([a-z0-9]{4})$/i;

export function createPrimaryPaneToken(): string {
  return randomBytes(3).readUIntBE(0, 3).toString(36).padStart(4, "0").slice(-4);
}

export function primaryPaneToken(label: string | null | undefined, paneId: string): string {
  const match = label?.trim().match(PRIMARY_PANE_TOKEN_PATTERN);
  if (match) return match[1]!.toLowerCase();
  const digest = createHash("sha256").update(paneId, "utf8").digest("hex");
  return BigInt(`0x${digest}`).toString(36).padStart(4, "0").slice(0, 4);
}
