import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
// @ts-expect-error The operational script is intentionally plain ESM.
import { inspectDeliveryScopeEvidence, resolveStatusEndpoint, summarizeTopologyDeliveryStatus } from "../scripts/real-user-smoke.mjs";

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

  it("surfaces bounded topology and exact per-pane Ring class evidence", () => {
    expect(summarizeTopologyDeliveryStatus({ operational: {
      paneTopology: { pending: 2, uncertain: 1 },
      deliveryRings: { primaryPaneScopes: 1, workerPaneScopes: 3, legacyWorkerScopeDebt: 0 }
    } })).toEqual({
      topologyPending: 2, topologyUncertain: 1,
      primaryPaneScopes: 1, workerPaneScopes: 3, legacyWorkerScopeDebt: 0
    });
  });

  it("audits exact Primary, per-pane Worker, and legacy Worker scope keys without exposing identities", () => {
    const directory = mkdtempSync(join(tmpdir(), "swarm-scope-smoke-"));
    const databasePath = join(directory, "bridge.db");
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(`
        CREATE TABLE bindings(id TEXT PRIMARY KEY,generation INTEGER,session_epoch INTEGER,workspace_id TEXT,pane_id TEXT);
        CREATE TABLE agent_instances(
          id TEXT PRIMARY KEY,generation INTEGER,worker_session_generation INTEGER,worker_session_lifecycle TEXT,desired_state TEXT,
          herdr_workspace_id TEXT,pane_id TEXT,parent_binding_id TEXT,parent_binding_generation INTEGER,parent_pane_id TEXT
        );
        CREATE TABLE outbound_replies(
          id TEXT PRIMARY KEY,state TEXT,scope_kind TEXT,scope_key TEXT,scope_workspace_id TEXT,scope_pane_id TEXT,
          delivery_owner_kind TEXT,delivery_owner_id TEXT,delivery_owner_generation INTEGER,delivery_owner_session_generation INTEGER,
          delivery_parent_id TEXT,delivery_parent_generation INTEGER,delivery_parent_session_generation INTEGER,delivery_parent_pane_id TEXT
        );
        INSERT INTO bindings VALUES('primary',1,1,'workspace','primary-pane');
        INSERT INTO agent_instances VALUES('worker',2,3,'active','running','workspace','worker-pane','primary',1,'primary-pane');
        INSERT INTO outbound_replies VALUES
          ('primary-current','pending','pane',json_array('pane','workspace','primary-pane'),'workspace','primary-pane','primary','primary',1,1,NULL,NULL,NULL,NULL),
          ('worker-current','pending','pane',json_array('pane','workspace','worker-pane'),'workspace','worker-pane','worker','worker',2,3,'primary',1,1,'primary-pane'),
          ('worker-legacy','dead_letter','pane',json_array('pane','workspace','primary-pane'),'workspace','primary-pane','worker','worker',2,3,'primary',1,1,'primary-pane'),
          ('worker-invalid','pending','pane',json_array('pane','workspace','wrong-pane'),'workspace','wrong-pane','worker','worker',2,3,'primary',1,1,'primary-pane');
      `);
    } finally {
      database.close();
    }

    try {
      expect(inspectDeliveryScopeEvidence(databasePath)).toEqual({
        checkedRows: 4, currentPrimaryRows: 1, currentWorkerRows: 1, legacyWorkerRows: 1, invalidRows: 1
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
