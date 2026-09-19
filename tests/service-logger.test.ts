import { chmodSync, linkSync, mkdtempSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createServiceLogger } from "../src/runtime/service-logger.js";

describe("service logger", () => {
  it("writes structured records to a private file and reopens it on SIGUSR2", async () => {
    const root = mkdtempSync(join(tmpdir(), "service-logger-"));
    const path = join(root, "service.log");
    const rotated = `${path}.1`;
    const service = createServiceLogger("info", path);
    service.logger.info({ event: "before" }, "before");
    await new Promise((resolve) => setTimeout(resolve, 20));
    renameSync(path, rotated);
    writeFileSync(path, "", { mode: 0o600 });
    process.emit("SIGUSR2", "SIGUSR2");
    service.logger.info({ event: "after" }, "after");
    await new Promise((resolve) => setTimeout(resolve, 20));
    service.close();
    expect(readFileSync(path, "utf8")).toContain('"event":"after"');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("rejects linked log paths", () => {
    const root = mkdtempSync(join(tmpdir(), "service-logger-links-"));
    const outside = join(root, "outside");
    writeFileSync(outside, "");
    const hard = join(root, "hard"); linkSync(outside, hard);
    expect(() => createServiceLogger("info", hard)).toThrow(/private regular file/);
    const symbolic = join(root, "symbolic"); symlinkSync(outside, symbolic);
    expect(() => createServiceLogger("info", symbolic)).toThrow();
    chmodSync(outside, 0o600);
  });
});
