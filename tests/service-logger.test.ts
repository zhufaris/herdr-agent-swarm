import { chmodSync, linkSync, mkdtempSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import pino from "pino";
import { attachDeliveryLatencyLogging, createServiceLogger } from "../src/runtime/service-logger.js";
import { DeliveryLatencyTrace } from "../src/domain/delivery-trace.js";

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

  it("logs only bounded latency dimensions and safe correlation fields", () => {
    const records: Array<Record<string, unknown>> = [];
    const logger = pino({ level: "debug" }, { write(chunk: string) { records.push(JSON.parse(chunk) as Record<string, unknown>); } });
    const trace = new DeliveryLatencyTrace();
    const detach = attachDeliveryLatencyLogging(trace, logger);
    const canaries = [
      "CANARY_MESSAGE_TEXT", "CANARY_ANSWER_TEXT", "CANARY_TOOL_RESULT", "CANARY_CARDKIT_JSON",
      "CANARY_PRESENTATION_SNAPSHOT", "CANARY_CREDENTIAL", "CANARY_TOKEN"
    ];
    trace.observe({ stage: "ingress_accepted", monotonicAtMs: 1, correlation: { eventId: "event-safe", messageId: "message-safe" }, payload: canaries } as never);
    trace.observe({ stage: "gateway_acknowledged", monotonicAtMs: 5, correlation: { eventId: "event-safe", replyId: "reply-safe", attemptId: "attempt-safe" }, payload: canaries } as never);
    trace.observe({ stage: "settled", monotonicAtMs: 9, outcome: "succeeded", correlation: { eventId: "event-safe", replyId: "reply-safe", attemptId: "attempt-safe" }, payload: canaries } as never);
    trace.diagnose("stale_attempt", { replyId: "reply-safe", attemptId: "attempt-safe" });
    detach();

    const serialized = JSON.stringify(records);
    for (const canary of canaries) expect(serialized).not.toContain(canary);
    const metrics = records.filter(({ event }) => event === "delivery-latency-metric").map(({ metric }) => metric as Record<string, unknown>);
    expect(metrics).toContainEqual(expect.objectContaining({ stage: "input_to_settlement", outcome: "succeeded", durationMs: 8, correlation: expect.any(Object) }));
    expect(metrics.every((metric) => Object.keys(metric).sort().join(",") === "correlation,durationMs,outcome,stage")).toBe(true);
    expect(records.find(({ event }) => event === "delivery-latency-stage")).toMatchObject({
      correlation: { eventId: "event-safe", messageId: "message-safe" }
    });
    expect(records.find(({ event }) => event === "delivery-latency-diagnostic")).toMatchObject({
      level: 20, diagnostic: "stale_attempt", correlation: { replyId: "reply-safe", attemptId: "attempt-safe" }
    });
    expect(trace.snapshot().diagnostics).toMatchObject({ staleAttempts: 1, maintenanceYields: 0 });
  });

  it("keeps per-occurrence delivery diagnostics out of the info stream", () => {
    const records: Array<Record<string, unknown>> = [];
    const logger = pino({ level: "info" }, { write(chunk: string) { records.push(JSON.parse(chunk) as Record<string, unknown>); } });
    const trace = new DeliveryLatencyTrace();
    const detach = attachDeliveryLatencyLogging(trace, logger);

    trace.diagnose("maintenance_yield");
    detach();

    expect(records.some(({ event }) => event === "delivery-latency-diagnostic")).toBe(false);
    expect(trace.snapshot().diagnostics).toMatchObject({ staleAttempts: 0, maintenanceYields: 1 });
  });
});
