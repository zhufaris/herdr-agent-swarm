import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readEnvironmentFile, serializeEnvironmentValue } from "../src/runtime/environment-file.js";

describe("environment file", () => {
  it("reads plain and JSON-quoted systemd-compatible assignments", () => {
    const path = join(mkdtempSync(join(tmpdir(), "bridge-env-")), "bridge.env");
    writeFileSync(path, `# private config\nPLAIN=value\nSECRET=${serializeEnvironmentValue('a b\"c')}\n`);

    expect(readEnvironmentFile(path)).toMatchObject({ PLAIN: "value", SECRET: 'a b"c' });
  });

  it("rejects shell syntax and malformed quoting", () => {
    const directory = mkdtempSync(join(tmpdir(), "bridge-env-"));
    const shellPath = join(directory, "shell.env");
    const quotePath = join(directory, "quote.env");
    writeFileSync(shellPath, "export SECRET=value\n");
    writeFileSync(quotePath, 'SECRET="unterminated\n');

    expect(() => readEnvironmentFile(shellPath)).toThrow(/Invalid environment assignment/);
    expect(() => readEnvironmentFile(quotePath)).toThrow(/Invalid quoted value/);
  });
});
