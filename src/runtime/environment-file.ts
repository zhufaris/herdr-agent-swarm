import { readFileSync } from "node:fs";

const assignment = /^([A-Z_][A-Z0-9_]*)=(.*)$/;

export function readEnvironmentFile(path: string, base: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...base };
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const [index, source] of lines.entries()) {
    const line = source.trim();
    if (!line || line.startsWith("#")) continue;
    const match = assignment.exec(line);
    if (!match) throw new Error(`Invalid environment assignment at ${path}:${index + 1}`);
    const [, key, rawValue] = match;
    environment[key!] = parseValue(rawValue!, path, index + 1);
  }
  return environment;
}

export function serializeEnvironmentValue(value: string): string {
  return JSON.stringify(value);
}

export function serializeEnvironmentFile(environment: Record<string, string>, order: readonly string[]): string {
  const known = order.filter((key) => environment[key] !== undefined);
  const knownSet = new Set(known);
  const remaining = Object.keys(environment).filter((key) => !knownSet.has(key)).sort();
  return [...known, ...remaining].map((key) => `${key}=${serializeEnvironmentValue(environment[key]!)}`).join("\n") + "\n";
}

function parseValue(rawValue: string, path: string, line: number): string {
  const value = rawValue.trim();
  if (!value.startsWith('\"')) {
    if (/\s/.test(value)) throw new Error(`Unquoted whitespace at ${path}:${line}`);
    return value;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "string") throw new Error("not a string");
    return parsed;
  } catch {
    throw new Error(`Invalid quoted value at ${path}:${line}`);
  }
}
