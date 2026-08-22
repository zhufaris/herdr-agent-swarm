import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CommandRunner {
  run(executable: string, args: string[], timeoutMs?: number): Promise<{ stdout: string; stderr: string }>;
}

export class ExecFileCommandRunner implements CommandRunner {
  constructor(private readonly defaultTimeoutMs: number) {}

  async run(executable: string, args: string[], timeoutMs = this.defaultTimeoutMs) {
    try {
      const result = await execFileAsync(executable, args, {
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        encoding: "utf8"
      });
      return { stdout: result.stdout, stderr: result.stderr };
    } catch (cause) {
      const error = cause as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean };
      const detail = [error.message, error.stderr?.trim()].filter(Boolean).join(": " );
      throw new CommandError(executable, args, detail, error.killed === true, cause);
    }
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
    const safeMessage = redactKnownValues(message, args.filter((_, index) => safeArgs[index] === "[REDACTED]"));
    super(`Command failed: ${executable} ${safeArgs.join(" " )}: ${safeMessage}`, { cause: options });
    this.name = "CommandError";
    this.args = safeArgs;
  }
}

function redactCommandArgs(args: string[]): string[] {
  const safe = [...args];
  if (safe[0] === "pane" && safe[1] === "send-text" && safe.length > 3) safe[3] = "[REDACTED]";
  return safe;
}

function redactKnownValues(message: string, values: string[]): string {
  return values.filter(Boolean).reduce((safe, value) => safe.replaceAll(value, "[REDACTED]"), message);
}
