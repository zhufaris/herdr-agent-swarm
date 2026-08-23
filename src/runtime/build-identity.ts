import { readFileSync } from "node:fs";

export const BRIDGE_SERVICE_ID = "herdr-lark-bridge" as const;

export interface BuildIdentity {
  serviceId: typeof BRIDGE_SERVICE_ID;
  version: string;
  buildId: string;
  gitCommit: string | null;
}

export function loadBuildIdentity(path: string, expectedBuildId?: string): BuildIdentity {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`invalid build identity at ${path}: ${message(error)}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid build identity at ${path}: expected an object`);
  const record = value as Record<string, unknown>;
  if (record.serviceId !== BRIDGE_SERVICE_ID) throw new Error(`invalid build identity serviceId at ${path}`);
  if (typeof record.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(record.version)) throw new Error(`invalid build identity version at ${path}`);
  if (typeof record.buildId !== "string" || !/^sha256:[A-Za-z0-9._-]{6,128}$/.test(record.buildId)) throw new Error(`invalid build identity buildId at ${path}`);
  if (record.gitCommit !== null && (typeof record.gitCommit !== "string" || !/^[a-f0-9]{40}$/.test(record.gitCommit))) throw new Error(`invalid build identity gitCommit at ${path}`);
  if (expectedBuildId && record.buildId !== expectedBuildId) throw new Error(`build identity ${record.buildId} does not match expected ${expectedBuildId}`);
  return { serviceId: record.serviceId, version: record.version, buildId: record.buildId, gitCommit: record.gitCommit as string | null };
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
