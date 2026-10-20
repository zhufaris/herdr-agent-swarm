import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

const MAX_INPUT_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024;
const HELPER_TIMEOUT_MS = 4_000;

async function readInput() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_INPUT_BYTES) throw new Error("Hook input is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

async function activation(path) {
  const value = JSON.parse(await readFile(path, "utf8"));
  if (value?.schemaVersion !== 1 || value?.pluginVersion !== "1.0.0" || typeof value.helperPath !== "string" || !value.helperPath.startsWith("/") || typeof value.socketPath !== "string" || !value.socketPath.startsWith("/")) {
    throw new Error("Choice Hook activation is invalid");
  }
  return value;
}

function invoke(config, input) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [config.helperPath, "--socket", config.socketPath], {
      encoding: "buffer",
      timeout: HELPER_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      env: process.env
    }, (error, stdout) => resolve(error ? Buffer.alloc(0) : stdout));
    child.stdin?.end(input);
  });
}

try {
  const input = await readInput();
  const config = await activation(process.argv[2]);
  const output = await invoke(config, input);
  if (output.length > 0) process.stdout.write(output);
} catch {
  // Fail open: no Hook response means TraeX may stop normally.
}
