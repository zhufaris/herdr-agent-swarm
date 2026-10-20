import { createHash, randomBytes } from "node:crypto";

const PRIMARY_PANE_TOKEN_PATTERN = /^(?:lark_|lark_task-|task-)?([a-z0-9]{4})$/i;
const GROUP_TOKEN_PATTERN = /^[a-z0-9]{4}$/i;
const WORKER_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export type PaneIdentityRole =
  | { kind: "managed-primary" }
  | { kind: "default-primary" }
  | { kind: "worker"; name: string };

export interface PaneIdentityLabels {
  groupToken: string;
  tabLabel: string;
  paneLabel: string;
}

export function createPrimaryPaneToken(): string {
  return randomBytes(3).readUIntBE(0, 3).toString(36).padStart(4, "0").slice(-4);
}

export function canonicalPrimaryPaneToken(label: string | null | undefined): string | null {
  return label?.trim().match(PRIMARY_PANE_TOKEN_PATTERN)?.[1]?.toLowerCase() ?? null;
}

export function primaryPaneToken(label: string | null | undefined, paneId: string): string {
  const token = canonicalPrimaryPaneToken(label);
  if (token) return token;
  const digest = createHash("sha256").update(paneId, "utf8").digest("hex");
  return BigInt(`0x${digest}`).toString(36).padStart(4, "0").slice(0, 4);
}

export function primaryGroupToken(input: {
  paneToken: string | null | undefined;
  label: string | null | undefined;
  paneId: string;
}): string {
  if (input.paneToken !== null && input.paneToken !== undefined) {
    const token = normalizeGroupToken(input.paneToken);
    if (!token) throw new Error("Invalid Primary Group Token");
    return token;
  }
  return primaryPaneToken(input.label, input.paneId);
}

export function paneIdentityLabels(groupToken: string, role: PaneIdentityRole): PaneIdentityLabels {
  const normalized = normalizeGroupToken(groupToken);
  if (!normalized) throw new Error("Invalid Group Token");
  if (role.kind === "worker" && !WORKER_NAME_PATTERN.test(role.name)) throw new Error("Invalid Worker name for Pane Identity");
  const suffix = role.kind === "managed-primary" ? "main"
    : role.kind === "default-primary" ? "default-main"
      : role.name;
  return Object.freeze({ groupToken: normalized, tabLabel: normalized, paneLabel: `${normalized}-${suffix}` });
}

function normalizeGroupToken(value: string): string | null {
  const token = value.trim().toLowerCase();
  return GROUP_TOKEN_PATTERN.test(token) ? token : null;
}
