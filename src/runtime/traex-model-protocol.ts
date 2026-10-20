import type { TraexModelSummary } from "../domain/model-selection.js";
import type { CommandRunner } from "../infra/command-runner.js";

const MAX_RESPONSE_BYTES = 256 * 1024;

export async function listTraexModelsFromCli(
  runner: Pick<CommandRunner, "run">,
  executable: string,
  timeoutMs: number
): Promise<TraexModelSummary[]> {
  const { stdout } = await runner.run(executable, ["models", "--json"], timeoutMs);
  if (Buffer.byteLength(stdout) > MAX_RESPONSE_BYTES) throw new Error("TraeX model catalog exceeded the byte limit");
  let value: unknown;
  try { value = JSON.parse(stdout); }
  catch { throw new Error("TraeX model catalog returned invalid JSON"); }
  if (!Array.isArray(value) || value.length > 1_000) throw new Error("TraeX model catalog returned an invalid list");
  const names = new Set<string>();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("TraeX model catalog contained an invalid entry");
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== "string" || !record.name || record.name.length > 256) throw new Error("TraeX model catalog contained an invalid entry");
    if (names.has(record.name)) throw new Error("TraeX model catalog contained a duplicate model");
    names.add(record.name);
    const id = typeof record.config_name === "string" && record.config_name ? record.config_name : record.name;
    if (id.length > 256) throw new Error("TraeX model catalog contained an invalid entry");
    return { id, name: record.name, displayName: record.name };
  });
}
