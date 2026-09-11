import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error The operational script is intentionally plain ESM.
import { resolveStatusEndpoint } from "../scripts/real-user-smoke.mjs";

describe("real-user smoke endpoint", () => {
  it("prefers an explicit status URL", () => {
    expect(resolveStatusEndpoint({ BRIDGE_STATUS_URL: "http://127.0.0.1:9999/status" })).toBe("http://127.0.0.1:9999/status");
  });

  it("loads the installed private environment host and port", () => {
    const configDirectory = mkdtempSync(join(tmpdir(), "swarm-smoke-"));
    writeFileSync(join(configDirectory, ".env"), "BRIDGE_HTTP_HOST=0.0.0.0\nBRIDGE_HTTP_PORT=8788\n");
    expect(resolveStatusEndpoint({ SWARM_CONFIG_DIR: configDirectory })).toBe("http://127.0.0.1:8788/status");
  });

  it("uses the service defaults when no private environment exists", () => {
    const configDirectory = join(tmpdir(), `missing-swarm-smoke-${Date.now()}`);
    expect(resolveStatusEndpoint({ SWARM_CONFIG_DIR: configDirectory })).toBe("http://127.0.0.1:8787/status");
  });
});
