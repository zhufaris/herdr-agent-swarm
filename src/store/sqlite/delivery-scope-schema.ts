function parentFenceColumns(includeParentPane: boolean): string[] {
  return ["delivery_parent_id", "delivery_parent_generation", "delivery_parent_session_generation",
    ...(includeParentPane ? ["delivery_parent_pane_id"] : [])];
}

export function validDeliveryScopeSql(row: string, includeParentPane: boolean): string {
  const parentEmpty = parentFenceColumns(includeParentPane).map((column) => `${row}.${column} IS NULL`).join(" AND ");
  const fenceEmpty = ["delivery_owner_kind", "delivery_owner_id", "delivery_owner_generation", "delivery_owner_session_generation", ...parentFenceColumns(includeParentPane)]
    .map((column) => `${row}.${column} IS NULL`).join(" AND ");
  const scopeEmpty = ["scope_key", "scope_workspace_id", "scope_pane_id"]
    .map((column) => `${row}.${column} IS NULL`).join(" AND ");
  const primaryFence = `${row}.delivery_owner_kind='primary' AND length(${row}.delivery_owner_id)>0
    AND ${row}.delivery_owner_generation>=1 AND ${row}.delivery_owner_session_generation>=1 AND ${parentEmpty}`;
  const workerFence = `${row}.delivery_owner_kind='worker' AND length(${row}.delivery_owner_id)>0
    AND ${row}.delivery_owner_generation>=1 AND ${row}.delivery_owner_session_generation>=1
    AND length(${row}.delivery_parent_id)>0 AND ${row}.delivery_parent_generation>=1 AND ${row}.delivery_parent_session_generation>=1
    ${includeParentPane ? `AND length(${row}.delivery_parent_pane_id)>0` : ""}`;
  const variants = [
    `${row}.scope_kind IS NULL AND ${scopeEmpty} AND ${fenceEmpty} AND ${row}.scheduler_owner = 'legacy'`,
    `${row}.scope_kind = 'global' AND ${row}.scope_key = json_array('global') AND ${row}.scope_workspace_id IS NULL AND ${row}.scope_pane_id IS NULL AND ${fenceEmpty}`,
    `${row}.scope_kind = 'pane'
      AND length(${row}.scope_key) > 0 AND length(${row}.scope_workspace_id) > 0 AND length(${row}.scope_pane_id) > 0
      AND ${row}.scope_key = json_array('pane', ${row}.scope_workspace_id, ${row}.scope_pane_id)
      AND ((${primaryFence}) OR (${workerFence}))`
  ];
  return variants.map((variant) => `COALESCE((${variant}), 0)`).join(" OR ");
}

export function validContractedDeliveryScopeSql(row: string, includeParentPane: boolean): string {
  const parentEmpty = parentFenceColumns(includeParentPane).map((column) => `${row}.${column} IS NULL`).join(" AND ");
  const fenceEmpty = ["delivery_owner_kind", "delivery_owner_id", "delivery_owner_generation", "delivery_owner_session_generation", ...parentFenceColumns(includeParentPane)]
    .map((column) => `${row}.${column} IS NULL`).join(" AND ");
  const primaryFence = `${row}.delivery_owner_kind='primary' AND length(${row}.delivery_owner_id)>0
    AND ${row}.delivery_owner_generation>=1 AND ${row}.delivery_owner_session_generation>=1 AND ${parentEmpty}`;
  const workerFence = `${row}.delivery_owner_kind='worker' AND length(${row}.delivery_owner_id)>0
    AND ${row}.delivery_owner_generation>=1 AND ${row}.delivery_owner_session_generation>=1
    AND length(${row}.delivery_parent_id)>0 AND ${row}.delivery_parent_generation>=1 AND ${row}.delivery_parent_session_generation>=1
    ${includeParentPane ? `AND length(${row}.delivery_parent_pane_id)>0` : ""}`;
  return [
    `${row}.scope_kind='global' AND ${row}.scope_key=json_array('global')
      AND ${row}.scope_workspace_id IS NULL AND ${row}.scope_pane_id IS NULL AND ${fenceEmpty}`,
    `${row}.scope_kind='pane' AND length(${row}.scope_key)>0
      AND length(${row}.scope_workspace_id)>0 AND length(${row}.scope_pane_id)>0
      AND ${row}.scope_key=json_array('pane',${row}.scope_workspace_id,${row}.scope_pane_id)
      AND ((${primaryFence}) OR (${workerFence}))`
  ].map((variant) => `COALESCE((${variant}),0)`).join(" OR ");
}

export function contractedDeliveryScopeTriggersSql(includeParentPane: boolean): string {
  const parentPaneColumn = includeParentPane ? ",delivery_parent_pane_id" : "";
  return `
    CREATE TRIGGER IF NOT EXISTS outbound_replies_valid_delivery_scope_insert
    BEFORE INSERT ON outbound_replies WHEN NOT (${validContractedDeliveryScopeSql("NEW", includeParentPane)})
    BEGIN SELECT RAISE(ABORT, 'invalid_delivery_scope'); END;
    CREATE TRIGGER IF NOT EXISTS outbound_replies_valid_delivery_scope_update
    BEFORE UPDATE OF scope_kind,scope_key,scope_workspace_id,scope_pane_id,
      delivery_owner_kind,delivery_owner_id,delivery_owner_generation,delivery_owner_session_generation,
      delivery_parent_id,delivery_parent_generation,delivery_parent_session_generation${parentPaneColumn} ON outbound_replies
    WHEN NOT (${validContractedDeliveryScopeSql("NEW", includeParentPane)})
    BEGIN SELECT RAISE(ABORT, 'invalid_delivery_scope'); END;
  `;
}
