import { execFile } from "node:child_process";

export interface CommandRunner {
  run(executable: string, args: string[], timeoutMs?: number, onStarted?: () => void | Promise<void>): Promise<{ stdout: string; stderr: string }>;
}

export class ExecFileCommandRunner implements CommandRunner {
  constructor(private readonly defaultTimeoutMs: number) {}

  run(executable: string, args: string[], timeoutMs = this.defaultTimeoutMs, onStarted?: () => void | Promise<void>): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let startReceipt: Promise<void> | null = null;
      const child = execFile(executable, args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, encoding: "utf8" }, (cause, stdout, stderr) => {
        if (settled) return;
        const finish = () => {
          if (settled) return;
          settled = true;
          if (!cause) { resolve({ stdout, stderr }); return; }
          const error = cause as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean };
          const detail = [error.message, error.stderr?.trim()].filter(Boolean).join(": " );
          reject(new CommandError(executable, args, detail, error.killed === true, cause));
        };
        if (startReceipt) void startReceipt.then(finish, () => undefined);
        else finish();
      });
      child.once("spawn", () => {
        startReceipt = Promise.resolve().then(() => onStarted?.());
        void startReceipt.catch((error) => {
          if (settled) return;
          settled = true;
          child.kill();
          reject(error);
        });
      });
    });
  }
}

export class CommandError extends Error {
  constructor(
    readonly executable: string,
    readonly args: string[],
    message: string,
    readonly timedOut: boolean,
    options?: unknown
  ) {
    const safeArgs = redactCommandArgs(args);
    const safeMessage = redactKnownValues(message, sensitiveCommandArgValues(args));
    super(`Command failed: ${executable} ${safeArgs.join(" " )}: ${safeMessage}`, { cause: options });
    this.name = "CommandError";
    this.args = safeArgs;
  }
}

function redactCommandArgs(args: string[]): string[] {
  const safe = [...args];
  if (safe[0] === "agent" && ["prompt", "steer"].includes(safe[1] ?? "") && safe.length > 3) safe[3] = "[REDACTED]";
  for (let index = 0; index < safe.length - 1; index += 1) {
    if (safe[index] !== "--env") continue;
    const secret = /^(SWARM_PRIMARY_CAPABILITY)=/.exec(safe[index + 1]!);
    if (secret) safe[index + 1] = `${secret[1]}=[REDACTED]`;
  }
  return safe;
}

function sensitiveCommandArgValues(args: string[]): string[] {
  const values: string[] = [];
  if (args[0] === "agent" && ["prompt", "steer"].includes(args[1] ?? "") && args.length > 3) values.push(args[3]!);
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] !== "--env") continue;
    const match = /^SWARM_PRIMARY_CAPABILITY=(.*)$/.exec(args[index + 1]!);
    if (match) values.push(args[index + 1]!, match[1]!);
  }
  return values;
}

function redactKnownValues(message: string, values: string[]): string {
  return values.filter(Boolean).reduce((safe, value) => safe.replaceAll(value, "[REDACTED]"), message);
}
