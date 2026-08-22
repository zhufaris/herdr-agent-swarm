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
    super(`Command failed: ${executable} ${args.join(" " )}: ${message}`, { cause: options });
    this.name = "CommandError";
  }
}
