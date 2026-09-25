import { createHash } from "node:crypto";

export function managedAgentName(projectId: string | undefined, name: string): string {
  return normalizeManagedAgentName(`${projectId ?? "agent"}-${name}`);
}

export function normalizeManagedAgentName(value: string): string {
  const prefix = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z]+/, "a-");
  return prefix.slice(0, 32).replace(/[-_]$/, "") || "agent";
}

export function primaryManagedAgentName(projectId: string | null, bindingId: string, generation: number): string {
  const scope = createHash("sha256").update(`${bindingId}\0${generation}`).digest("hex").slice(0, 10);
  const readable = managedAgentName(projectId ?? undefined, "primary").slice(0, 21).replace(/[-_]$/, "");
  return `${readable}-${scope}`;
}
