import { execFile } from "node:child_process";
import { reportTraexLifecycle } from "../runtime/report-traex-lifecycle.js";

const MAX_INPUT_BYTES = 64 * 1024;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const value = Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > MAX_INPUT_BYTES) throw new Error("TraeX lifecycle hook input exceeds 64 KiB");
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function run(executable: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => execFile(executable, args, { encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024 }, (error) => error ? reject(error) : resolve()));
}

readStdin().then((input) => reportTraexLifecycle(input, process.env, run)).catch(() => { process.exitCode = 1; });
