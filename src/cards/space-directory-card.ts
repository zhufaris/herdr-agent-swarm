import type { AgentState } from "../domain/types.js";

const MAX_CARD_SERIALIZED_LENGTH = 12_000;
const MAX_PANE_ROWS_PER_PAGE = 16;
const MAX_FIELD_LENGTH = 160;

export interface SpaceDirectoryPane {
  paneId: string;
  name: string;
  agentState: AgentState;
  foregroundExecutables: string[];
  bindingId?: string;
  claimProjectId?: string;
}

export interface SpaceDirectoryGroup {
  spaceName: string;
  workspaceId: string;
  directories: string[];
  panes: SpaceDirectoryPane[];
  error?: string;
  unregistered?: boolean;
}

interface SpaceSection {
  elements: object[];
  paneRows: number;
}

export function renderSpaceDirectoryCards(groups: SpaceDirectoryGroup[]): object[] {
  const sections = groups.flatMap(groupSections);
  const pages: object[][] = [];
  let page: object[] = [];
  let paneRows = 0;

  for (const section of sections) {
    const separator = page.length ? [{ tag: "hr" }] : [];
    const candidate = [...page, ...separator, ...section.elements];
    if (page.length && (paneRows + section.paneRows > MAX_PANE_ROWS_PER_PAGE || JSON.stringify(candidate).length > MAX_CARD_SERIALIZED_LENGTH)) {
      pages.push(page);
      page = [...section.elements];
      paneRows = section.paneRows;
    } else {
      page = candidate;
      paneRows += section.paneRows;
    }
  }

  if (page.length) pages.push(page);
  if (!pages.length) pages.push([{ tag: "markdown", content: "暂无已配置 Space。" }]);

  return pages.map((elements, index) => ({
    schema: "2.0",
    config: { update_multi: true, summary: { content: "Herdr Space 目录" } },
    header: {
      title: { tag: "plain_text", content: pages.length > 1 ? `Herdr Spaces · ${index + 1}/${pages.length}` : "Herdr Spaces" },
      template: groups.some((group) => group.error) ? "orange" : "blue"
    },
    body: { elements }
  }));
}

function groupSections(group: SpaceDirectoryGroup): SpaceSection[] {
  const panes = [...group.panes].sort((left, right) =>
    normalizedName(left).localeCompare(normalizedName(right)) || left.paneId.localeCompare(right.paneId)
  );
  if (group.error) return [{ elements: groupPrefix(group, [statusRow(`⚠ ${bound(group.error)}`)]), paneRows: 0 }];
  if (!panes.length) return [{ elements: groupPrefix(group, [statusRow("暂无 Pane")]), paneRows: 0 }];

  const sections: SpaceSection[] = [];
  for (let index = 0; index < panes.length; index += MAX_PANE_ROWS_PER_PAGE) {
    const chunk = panes.slice(index, index + MAX_PANE_ROWS_PER_PAGE);
    sections.push({ elements: groupPrefix(group, [tableHeader(), ...chunk.map((pane) => paneRow(group, pane))]), paneRows: chunk.length });
  }
  return sections;
}

function groupPrefix(group: SpaceDirectoryGroup, rows: object[]): object[] {
  const directories = group.directories.length
    ? group.directories.map((value) => `\`${escapeCode(bound(value))}\``).join("、")
    : "未注册";
  return [
    { tag: "markdown", content: `**${escapeMarkdown(bound(group.spaceName))}**\n目录：${directories}` },
    ...rows
  ];
}

function tableHeader(): object {
  return columnSet([
    textColumn("**Pane**", 3),
    textColumn("**状态**", 2),
    textColumn("**前台进程**", 2),
    textColumn("**话题**", 2)
  ]);
}

function paneRow(group: SpaceDirectoryGroup, pane: SpaceDirectoryPane): object {
  const executables = pane.foregroundExecutables.length
    ? pane.foregroundExecutables.map((value) => escapeMarkdown(bound(value))).join(", ")
    : "—";
  return columnSet([
    textColumn(`**${escapeMarkdown(bound(normalizedName(pane)))}**\n\`${escapeCode(shortPaneId(pane.paneId))}\``, 3),
    textColumn(escapeMarkdown(pane.agentState), 2),
    textColumn(executables, 2),
    actionColumn(group, pane)
  ]);
}

function actionColumn(group: SpaceDirectoryGroup, pane: SpaceDirectoryPane): object {
  if (pane.bindingId) return buttonColumn("打开话题", { action: "open_project_thread", bindingId: pane.bindingId });
  if (pane.claimProjectId) return buttonColumn("认领", {
    action: "claim_pane", projectId: pane.claimProjectId, workspaceId: group.workspaceId, paneId: pane.paneId
  });
  return textColumn("—", 2);
}

function statusRow(content: string): object {
  return columnSet([textColumn(escapeMarkdown(content), 1)]);
}

function columnSet(columns: object[]): object {
  return { tag: "column_set", flex_mode: "none", horizontal_spacing: "8px", vertical_align: "center", columns };
}

function textColumn(content: string, weight: number): object {
  return { tag: "column", width: "weighted", weight, elements: [{ tag: "markdown", content }] };
}

function buttonColumn(content: string, value: object): object {
  return { tag: "column", width: "weighted", weight: 2, elements: [{
    tag: "button", text: { tag: "plain_text", content }, type: "primary", size: "small", value
  }] };
}

function shortPaneId(paneId: string): string {
  const separator = paneId.indexOf(":");
  return bound(separator >= 0 ? paneId.slice(separator + 1) : paneId);
}

function normalizedName(pane: SpaceDirectoryPane): string {
  return pane.name.replace(/\s+/g, " " ).trim() || pane.paneId;
}

function bound(value: string): string { return value.length > MAX_FIELD_LENGTH ? `${value.slice(0, MAX_FIELD_LENGTH - 1)}…` : value; }
function escapeCode(value: string): string { return value.replaceAll("`", "'"); }
function escapeMarkdown(value: string): string { return value.replace(/[\\`*_{}[\]()#+.!|>-]/g, "\\$&"); }
