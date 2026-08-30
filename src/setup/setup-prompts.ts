import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { SetupPromptPort } from "./setup-types.js";

interface TtyInput extends Readable {
  isTTY?: boolean;
  setRawMode?(enabled: boolean): unknown;
}

interface TerminalSetupPromptOptions {
  input?: TtyInput;
  output?: Writable;
}

export class SetupCancelledError extends Error {
  constructor(message = "Setup cancelled") {
    super(message);
    this.name = "SetupCancelledError";
  }
}

export class TerminalSetupPrompts implements SetupPromptPort {
  private readonly input: TtyInput;
  private readonly output: Writable;

  constructor(options: TerminalSetupPromptOptions = {}) {
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
  }

  async text(message: string, defaultValue?: string): Promise<string> {
    const suffix = defaultValue === undefined ? "" : ` [${defaultValue}]`;
    const answer = await this.question(`${message}${suffix}: `);
    return answer || defaultValue || "";
  }

  async secret(message: string, existingValue: boolean): Promise<{ action: "retain" } | { action: "replace"; value: string }> {
    if (existingValue) {
      const action = await this.choose(`${message} (the current value is hidden)`, [
        { value: "retain", label: "Retain existing secret" },
        { value: "replace", label: "Replace secret" }
      ] as const);
      if (action === "retain") return { action };
    }
    return { action: "replace", value: await this.hiddenQuestion(`${message}: `) };
  }

  async confirm(message: string, defaultValue: boolean): Promise<boolean> {
    const hint = defaultValue ? "Y/n" : "y/N";
    for (;;) {
      const answer = (await this.question(`${message} [${hint}]: `)).trim().toLowerCase();
      if (!answer) return defaultValue;
      if (answer === "y" || answer === "yes") return true;
      if (answer === "n" || answer === "no") return false;
      this.write("Enter yes or no.");
    }
  }

  async choose<T extends string>(message: string, options: readonly { value: T; label: string }[]): Promise<T> {
    if (options.length === 0) throw new Error("A choice prompt requires at least one option");
    this.write(message);
    options.forEach((option, index) => this.write(`  ${index + 1}. ${option.label} (${option.value})`));
    for (;;) {
      const answer = (await this.question(`Choose [${options[0]!.value}]: `)).trim();
      if (!answer) return options[0]!.value;
      const numeric = Number(answer);
      if (Number.isInteger(numeric) && numeric >= 1 && numeric <= options.length) return options[numeric - 1]!.value;
      const exact = options.find((option) => option.value === answer);
      if (exact) return exact.value;
      this.write("Enter an option value or number.");
    }
  }

  write(message: string): void {
    this.output.write(`${message}\n`);
  }

  private async question(message: string): Promise<string> {
    const readline = createInterface({ input: this.input, output: this.output, terminal: Boolean(this.input.isTTY) });
    try {
      return await readline.question(message);
    } catch (error) {
      if (isCancellation(error)) throw new SetupCancelledError();
      throw error;
    } finally {
      readline.close();
    }
  }

  private hiddenQuestion(message: string): Promise<string> {
    if (!this.input.isTTY || !this.input.setRawMode) return Promise.reject(new Error("Secret input requires an interactive TTY"));
    this.output.write(message);
    return new Promise<string>((resolve, reject) => {
      let value = "";
      const finish = (error?: Error) => {
        this.input.off("data", onData);
        try { this.input.setRawMode!(false); } finally {
          this.input.pause();
          this.output.write("\n");
        }
        if (error) reject(error); else resolve(value);
      };
      const onData = (chunk: Buffer | string) => {
        for (const character of chunk.toString()) {
          if (character === "\u0003" || character === "\u001b") { finish(new SetupCancelledError()); return; }
          if (character === "\r" || character === "\n") { finish(); return; }
          if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
          else if (character >= " ") value += character;
        }
      };
      this.input.setRawMode!(true);
      this.input.resume();
      this.input.on("data", onData);
    });
  }
}

function isCancellation(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message.includes("SIGINT"));
}
