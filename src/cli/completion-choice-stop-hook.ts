import { callCompletionChoiceEligibilityGateway } from "../runtime/completion-choice-eligibility-gateway.js";
import { handleCompletionChoiceStop, handleCompletionChoiceUserPromptSubmit } from "../runtime/completion-choice-hook.js";

const MAX_STDIN_BYTES = 256 * 1024;

export async function runCompletionChoiceStopHook(input: string, socketPath: string, environment: NodeJS.ProcessEnv): Promise<object> {
  let parsed: unknown;
  try { parsed = JSON.parse(input); }
  catch { return {}; }
  return handleCompletionChoiceStop(parsed, environment, (request) => callCompletionChoiceEligibilityGateway(socketPath, request));
}

export async function runCompletionChoiceHook(input: string, socketPath: string, environment: NodeJS.ProcessEnv): Promise<object> {
  let parsed: unknown;
  try { parsed = JSON.parse(input); }
  catch { return {}; }
  const checkEligibility = (request: Parameters<typeof callCompletionChoiceEligibilityGateway>[1]) => callCompletionChoiceEligibilityGateway(socketPath, request);
  if (isUserPromptSubmit(parsed)) return handleCompletionChoiceUserPromptSubmit(parsed, environment, checkEligibility);
  return handleCompletionChoiceStop(parsed, environment, checkEligibility);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.length;
    if (bytes > MAX_STDIN_BYTES) throw new Error("Hook input is too large");
    chunks.push(value);
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

async function main(): Promise<void> {
  const socketIndex = process.argv.indexOf("--socket");
  const socketPath = socketIndex >= 0 ? process.argv[socketIndex + 1] : undefined;
  if (!socketPath) return;
  const response = await runCompletionChoiceHook(await readStdin(), socketPath, process.env);
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) void main().catch(() => { process.stdout.write("{}\n"); });

function isUserPromptSubmit(value: unknown): value is { hook_event_name: "UserPromptSubmit" } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (value as Record<string, unknown>).hook_event_name === "UserPromptSubmit";
}
