#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

export function resolveStatusEndpoint(environment = process.env) {
  if (environment.BRIDGE_STATUS_URL) return environment.BRIDGE_STATUS_URL;
  const configDirectory = environment.SWARM_CONFIG_DIR
    ?? join(environment.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "herdr-agent-swarm");
  const environmentFile = join(configDirectory, ".env");
  const configured = existsSync(environmentFile) ? parseEnv(readFileSync(environmentFile, "utf8")) : {};
  const configuredHost = configured.BRIDGE_HTTP_HOST ?? "127.0.0.1";
  const host = configuredHost === "0.0.0.0" || configuredHost === "::" ? "127.0.0.1" : configuredHost;
  const port = configured.BRIDGE_HTTP_PORT ?? "8787";
  const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${urlHost}:${port}/status`;
}

export async function main() {
const endpoint = resolveStatusEndpoint();
const marker = `herdr-smoke-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 120_000);
const intervalMs = 2_000;

console.log(`Smoke marker: ${marker}`);
console.log("请由真实飞书用户在已配置群中依次执行：");
console.log("1. /swarm spaces — 确认 Space 使用名称显示；已绑定 Pane 可打开话题。");
console.log("2. 如有可安全认领的未绑定 TraeX Pane，点击「认领」；否则明确跳过。");
console.log("3. /swarm sessions — 确认当前群会话可见，其他群信息不可见。");
console.log("4. /swarm failures — 仅在有可丢弃测试 dead letter 时验证重试/忽略；不得重试 prompt。");
console.log(`5. 在群中发送 "${marker}" 作为人工验收标记（不要让本脚本代发）。`);
console.log(`未来 ${Math.round(timeoutMs / 1000)} 秒将只轮询 ${endpoint}。Ctrl-C 可提前结束。`);

const startedAt = Date.now();
let lastSignature = "";
let failures = 0;
while (Date.now() - startedAt < timeoutMs) {
  try {
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(1_500) });
    const body = await response.json();
    const snapshot = {
      observedAt: new Date().toISOString(), httpStatus: response.status, status: body.status,
      leaseHeld: body.lease?.held, pendingOutbox: body.operational?.pendingOutbox, deadLetters: body.operational?.deadLetters,
      orphaned: body.operational?.attachment?.orphaned, cache: body.workspaceCache
    };
    const signature = JSON.stringify(snapshot);
    if (signature !== lastSignature) console.log(signature);
    lastSignature = signature;
  } catch (error) {
    failures += 1;
    console.error(JSON.stringify({ observedAt: new Date().toISOString(), status: "unreachable", error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) }));
  }
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
}
console.log(JSON.stringify({ marker, observationSeconds: Math.round((Date.now() - startedAt) / 1000), statusPollFailures: failures, manualConfirmationRequired: true }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
