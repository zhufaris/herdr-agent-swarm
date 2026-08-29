const MAX_INPUT_BYTES = 64 * 1024;
const PANE_ID = /^[A-Za-z0-9_-]+:p[A-Za-z0-9_-]+$/;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type LifecycleCommandRunner = (executable: string, args: string[]) => Promise<void>;

export async function reportTraexLifecycle(
  rawInput: string,
  environment: NodeJS.ProcessEnv,
  run: LifecycleCommandRunner,
  sequence: () => bigint = process.hrtime.bigint
): Promise<void> {
  if (Buffer.byteLength(rawInput) > MAX_INPUT_BYTES) throw new Error("TraeX lifecycle hook input exceeds 64 KiB");
  if (environment.HERDR_ENV !== "1") throw new Error("TraeX lifecycle hook requires Herdr");
  const paneId = environment.HERDR_PANE_ID;
  const herdr = environment.HERDR_TRAEX_REAL_HERDR;
  if (!paneId || !PANE_ID.test(paneId)) throw new Error("TraeX lifecycle hook has no valid pane identity");
  if (!herdr?.startsWith("/")) throw new Error("TraeX lifecycle hook has no absolute Herdr executable");
  const value = parseJson(rawInput);
  if (!value || typeof value !== "object") throw new Error("Invalid TraeX lifecycle hook input");
  const record = value as Record<string, unknown>;
  const event = record.hook_event_name;
  if (event === "SessionStart") {
    const sessionId = record.session_id;
    const source = record.source;
    if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) throw new Error("Invalid TraeX session identity");
    if (source !== undefined && source !== "startup" && source !== "resume") throw new Error("Unsupported TraeX session source");
    await run(herdr, ["pane", "report-agent", paneId, "--source", "herdr-traex-shim", "--agent", "codex", "--state", "idle", "--seq", sequence().toString(10), "--agent-session-id", sessionId]);
    return;
  }
  const state = event === "UserPromptSubmit" ? "working" : event === "Stop" ? "idle" : null;
  if (!state) throw new Error("Unsupported TraeX lifecycle hook event");
  await run(herdr, ["pane", "report-agent", paneId, "--source", "herdr-traex-shim", "--agent", "codex", "--state", state, "--seq", sequence().toString(10)]);
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}
