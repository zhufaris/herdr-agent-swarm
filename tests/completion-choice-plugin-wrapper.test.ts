import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const wrapper = resolve(root, "plugins/herdr-choice-list/scripts/herdr-choice-stop-hook.mjs");
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("herdr choice Hook wrapper", () => {
  it("forwards the bounded Stop block response byte-for-byte from the version-compatible release helper", async () => {
    const directory = await temporaryDirectory();
    const helperPath = join(directory, "helper.mjs");
    const activationPath = join(directory, "activation.json");
    await writeFile(helperPath, [
      "let input = '';",
      "for await (const chunk of process.stdin) input += chunk;",
      "const payload = JSON.parse(input);",
      "if (process.argv[2] !== '--socket' || process.argv[3] !== '/tmp/private.sock' || payload.last_assistant_message !== 'choice') process.exit(2);",
      "process.stdout.write(JSON.stringify({ decision: 'block', reason: 'Continue with only one compact terminal herdr-choice-list block.' }) + '\\n');"
    ].join("\n"));
    await writeFile(activationPath, JSON.stringify({ schemaVersion: 1, pluginVersion: "1.0.0", helperPath, socketPath: "/tmp/private.sock" }));

    await expect(runWrapper(activationPath, JSON.stringify({ last_assistant_message: "choice", stop_hook_active: false }))).resolves.toEqual({
      code: 0,
      stdout: "{\"decision\":\"block\",\"reason\":\"Continue with only one compact terminal herdr-choice-list block.\"}\n",
      stderr: ""
    });
  });

  it("forwards the Stop allow response and newline byte-for-byte from the version-compatible release helper", async () => {
    const directory = await temporaryDirectory();
    const helperPath = join(directory, "helper.mjs");
    const activationPath = join(directory, "activation.json");
    await writeFile(helperPath, [
      "for await (const _chunk of process.stdin) {}",
      "process.stdout.write('{}\\n');"
    ].join("\n"));
    await writeFile(activationPath, JSON.stringify({ schemaVersion: 1, pluginVersion: "1.0.0", helperPath, socketPath: "/tmp/private.sock" }));

    await expect(runWrapper(activationPath, JSON.stringify({ last_assistant_message: "done", stop_hook_active: false }))).resolves.toEqual({
      code: 0,
      stdout: "{}\n",
      stderr: ""
    });
  });

  it("forwards a Stop envelope containing an assistant message one byte over 128 KiB", async () => {
    const directory = await temporaryDirectory();
    const helperPath = join(directory, "helper.mjs");
    const activationPath = join(directory, "activation.json");
    await writeFile(helperPath, [
      "let input = '';",
      "for await (const chunk of process.stdin) input += chunk;",
      "const payload = JSON.parse(input);",
      "if (Buffer.byteLength(payload.last_assistant_message, 'utf8') !== 128 * 1024 + 1) process.exit(2);",
      "process.stdout.write(JSON.stringify({ decision: 'block', reason: 'oversized' }) + '\\n');"
    ].join("\n"));
    await writeFile(activationPath, JSON.stringify({ schemaVersion: 1, pluginVersion: "1.0.0", helperPath, socketPath: "/tmp/private.sock" }));
    const input = JSON.stringify({ last_assistant_message: "x".repeat(128 * 1024 + 1), stop_hook_active: false });

    expect(Buffer.byteLength(input, "utf8")).toBeGreaterThan(128 * 1024);
    await expect(runWrapper(activationPath, input)).resolves.toEqual({
      code: 0,
      stdout: "{\"decision\":\"block\",\"reason\":\"oversized\"}\n",
      stderr: ""
    });
  });

  it("fails open without invoking the helper above the 256 KiB wrapper cap", async () => {
    const directory = await temporaryDirectory();
    const helperPath = join(directory, "helper.mjs");
    const activationPath = join(directory, "activation.json");
    await writeFile(helperPath, "process.stdout.write('invoked\\n');");
    await writeFile(activationPath, JSON.stringify({ schemaVersion: 1, pluginVersion: "1.0.0", helperPath, socketPath: "/tmp/private.sock" }));
    const input = JSON.stringify({ last_assistant_message: "x".repeat(256 * 1024), stop_hook_active: false });

    expect(Buffer.byteLength(input, "utf8")).toBeGreaterThan(256 * 1024);
    await expect(runWrapper(activationPath, input)).resolves.toEqual({ code: 0, stdout: "", stderr: "" });
  });

  it("forwards UserPromptSubmit stdin through the same version-compatible helper", async () => {
    const directory = await temporaryDirectory();
    const helperPath = join(directory, "helper.mjs");
    const activationPath = join(directory, "activation.json");
    await writeFile(helperPath, [
      "let input = '';",
      "for await (const chunk of process.stdin) input += chunk;",
      "const payload = JSON.parse(input);",
      "if (process.argv[2] !== '--socket' || process.argv[3] !== '/tmp/private.sock' || payload.hook_event_name !== 'UserPromptSubmit') process.exit(2);",
      "process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'inline' } }) + '\\n');"
    ].join("\n"));
    await writeFile(activationPath, JSON.stringify({ schemaVersion: 1, pluginVersion: "1.0.0", helperPath, socketPath: "/tmp/private.sock" }));

    await expect(runWrapper(activationPath, JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "private" }))).resolves.toEqual({
      code: 0,
      stdout: "{\"hookSpecificOutput\":{\"hookEventName\":\"UserPromptSubmit\",\"additionalContext\":\"inline\"}}\n",
      stderr: ""
    });
  });

  it.each([
    ["missing", null],
    ["stale", { schemaVersion: 1, pluginVersion: "0.9.0", helperPath: "/tmp/helper.mjs", socketPath: "/tmp/private.sock" }],
    ["malformed", { schemaVersion: 1, pluginVersion: "1.0.0", helperPath: "relative", socketPath: "/tmp/private.sock" }]
  ])("fails open without output for %s plugin data", async (_name, activation) => {
    const directory = await temporaryDirectory();
    const activationPath = join(directory, "activation.json");
    if (activation !== null) await writeFile(activationPath, JSON.stringify(activation));
    await expect(runWrapper(activationPath, "not trusted")).resolves.toEqual({ code: 0, stdout: "", stderr: "" });
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "choice-plugin-wrapper-"));
  directories.push(directory);
  return directory;
}

function runWrapper(activationPath: string, stdin: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [wrapper, activationPath], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("close", (code) => resolveResult({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}
