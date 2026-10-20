#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { DatabaseSync } from "node:sqlite";

function configuredEnvironment(environment) {
  const configDirectory = environment.SWARM_CONFIG_DIR
    ?? join(environment.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "herdr-agent-swarm");
  const environmentFile = join(configDirectory, ".env");
  return existsSync(environmentFile) ? parseEnv(readFileSync(environmentFile, "utf8")) : {};
}

export function resolveStatusEndpoint(environment = process.env) {
  if (environment.BRIDGE_STATUS_URL) return environment.BRIDGE_STATUS_URL;
  const configured = configuredEnvironment(environment);
  const configuredHost = configured.BRIDGE_HTTP_HOST ?? "127.0.0.1";
  const host = configuredHost === "0.0.0.0" || configuredHost === "::" ? "127.0.0.1" : configuredHost;
  const port = configured.BRIDGE_HTTP_PORT ?? "8787";
  const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${urlHost}:${port}/status`;
}

export function resolveDatabasePath(environment = process.env) {
  const configured = configuredEnvironment(environment);
  const explicit = environment.BRIDGE_DATABASE_PATH ?? configured.BRIDGE_DATABASE_PATH;
  if (explicit) return explicit;
  const stateDirectory = environment.SWARM_STATE_DIR ?? configured.SWARM_STATE_DIR
    ?? join(environment.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "herdr-agent-swarm");
  return join(stateDirectory, "bridge.db");
}

export function inspectDeliveryScopeEvidence(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    database.exec("PRAGMA busy_timeout=5000");
    const row = database.prepare(`WITH classified AS (
      SELECT
        CASE WHEN reply.delivery_owner_kind='primary'
          AND reply.delivery_parent_pane_id IS NULL
          AND reply.scope_key=json_array('pane',reply.scope_workspace_id,reply.scope_pane_id)
          AND primary_owner.id=reply.delivery_owner_id
          AND primary_owner.generation=reply.delivery_owner_generation
          AND primary_owner.session_epoch=reply.delivery_owner_session_generation
          AND primary_owner.workspace_id=reply.scope_workspace_id
          AND primary_owner.pane_id=reply.scope_pane_id THEN 1 ELSE 0 END AS current_primary,
        CASE WHEN reply.delivery_owner_kind='worker'
          AND reply.scope_pane_id IS NOT reply.delivery_parent_pane_id
          AND reply.scope_key=json_array('pane',reply.scope_workspace_id,reply.scope_pane_id)
          AND worker.id=reply.delivery_owner_id AND worker.generation=reply.delivery_owner_generation
          AND worker.worker_session_generation=reply.delivery_owner_session_generation
          AND worker.worker_session_lifecycle='active' AND worker.desired_state='running'
          AND worker.herdr_workspace_id=reply.scope_workspace_id AND worker.pane_id=reply.scope_pane_id
          AND worker.parent_binding_id=reply.delivery_parent_id
          AND worker.parent_binding_generation=reply.delivery_parent_generation
          AND worker.parent_pane_id=reply.delivery_parent_pane_id
          AND parent.id=reply.delivery_parent_id AND parent.generation=reply.delivery_parent_generation
          AND parent.session_epoch=reply.delivery_parent_session_generation
          AND parent.workspace_id=reply.scope_workspace_id AND parent.pane_id=reply.delivery_parent_pane_id THEN 1 ELSE 0 END AS current_worker,
        CASE WHEN reply.delivery_owner_kind='worker'
          AND reply.scope_pane_id=reply.delivery_parent_pane_id
          AND reply.scope_key=json_array('pane',reply.scope_workspace_id,reply.scope_pane_id)
          AND worker.id=reply.delivery_owner_id AND worker.generation=reply.delivery_owner_generation
          AND worker.worker_session_generation=reply.delivery_owner_session_generation
          AND worker.worker_session_lifecycle='active' AND worker.desired_state='running'
          AND worker.parent_binding_id=reply.delivery_parent_id
          AND worker.parent_binding_generation=reply.delivery_parent_generation
          AND worker.parent_pane_id=reply.delivery_parent_pane_id
          AND parent.id=reply.delivery_parent_id AND parent.generation=reply.delivery_parent_generation
          AND parent.session_epoch=reply.delivery_parent_session_generation
          AND parent.workspace_id=reply.scope_workspace_id AND parent.pane_id=reply.delivery_parent_pane_id THEN 1 ELSE 0 END AS legacy_worker
      FROM outbound_replies reply
      LEFT JOIN bindings primary_owner ON primary_owner.id=reply.delivery_owner_id
      LEFT JOIN agent_instances worker ON worker.id=reply.delivery_owner_id
      LEFT JOIN bindings parent ON parent.id=reply.delivery_parent_id
      WHERE reply.state IN ('pending','dead_letter') AND reply.scope_kind='pane'
        AND reply.delivery_owner_kind IN ('primary','worker')
    ) SELECT COUNT(*) AS checked_rows,
      SUM(current_primary) AS current_primary_rows,
      SUM(current_worker) AS current_worker_rows,
      SUM(legacy_worker) AS legacy_worker_rows,
      SUM(CASE WHEN current_primary=0 AND current_worker=0 AND legacy_worker=0 THEN 1 ELSE 0 END) AS invalid_rows
      FROM classified`).get();
    return {
      checkedRows: Number(row.checked_rows ?? 0),
      currentPrimaryRows: Number(row.current_primary_rows ?? 0),
      currentWorkerRows: Number(row.current_worker_rows ?? 0),
      legacyWorkerRows: Number(row.legacy_worker_rows ?? 0),
      invalidRows: Number(row.invalid_rows ?? 0)
    };
  } finally {
    database.close();
  }
}

export function summarizeTopologyDeliveryStatus(body) {
  return {
    topologyPending: body.operational?.paneTopology?.pending ?? null,
    topologyUncertain: body.operational?.paneTopology?.uncertain ?? null,
    primaryPaneScopes: body.operational?.deliveryRings?.primaryPaneScopes ?? null,
    workerPaneScopes: body.operational?.deliveryRings?.workerPaneScopes ?? null,
    legacyWorkerScopeDebt: body.operational?.deliveryRings?.legacyWorkerScopeDebt ?? null
  };
}

export async function main() {
const endpoint = resolveStatusEndpoint();
const databasePath = resolveDatabasePath();
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
try {
  console.log(JSON.stringify({ deliveryScopeAudit: inspectDeliveryScopeEvidence(databasePath) }));
} catch (error) {
  console.error(JSON.stringify({ deliveryScopeAudit: "unavailable", error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) }));
}

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
      orphaned: body.operational?.attachment?.orphaned, ...summarizeTopologyDeliveryStatus(body), cache: body.workspaceCache
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
