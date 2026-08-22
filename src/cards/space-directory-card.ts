import type { AgentState } from "../domain/types.js";

const MAX_CARD_MARKDOWN_LENGTH = 12_000;
const MAX_FIELD_LENGTH = 160;

export interface SpaceDirectoryPane {
  paneId: string;
  name: string;
  agentState: AgentState;
  foregroundExecutables: string[];
}

export interface SpaceDirectoryGroup {
  spaceName: string;
  workspaceId: string;
  directories: string[];
  panes: SpaceDirectoryPane[];
  error?: string;
  unregistered?: boolean;
}

export function renderSpaceDirectoryCards(groups: SpaceDirectoryGroup[]): object[] {
  const sections = groups.flatMap(groupSections);
  const pages: string[][] = [];
  let page: string[] = [];
  let pageLength = 0;
  for (const section of sections) {
    const separator = page.length ? 2 : 0;
    if (page.length && pageLength + separator + section.length > MAX_CARD_MARKDOWN_LENGTH) {
      pages.push(page); page = []; pageLength = 0;
    }
    page.push(section);
    pageLength += (page.length > 1 ? 2 : 0) + section.length;
  }
  if (page.length) pages.push(page);
  if (!pages.length) pages.push(["暂无已配置 Space。"]);
  return pages.map((sectionsForPage, index) => ({
    schema: "2.0",
    config: { update_multi: true, summary: { content: "Herdr Space 目录" } },
    header: {
      title: { tag: "plain_text", content: pages.length > 1 ? `Herdr Spaces · ${index + 1}/${pages.length}` : "Herdr Spaces" },
      template: groups.some((group) => group.error) ? "orange" : "blue"
    },
    body: { elements: [{ tag: "markdown", content: sectionsForPage.join("\n\n") }] }
  }));
}

function groupSections(group: SpaceDirectoryGroup): string[] {
  const heading = `**${escapeMarkdown(bound(group.spaceName))}**  ·  \`${escapeCode(bound(group.workspaceId))}\``;
  const directories = group.directories.length
    ? `目录：${group.directories.map((value) => `\`${escapeCode(bound(value))}\``).join("、")}`
    : "目录：未注册";
  if (group.error) return [`${heading}\n${directories}\n⚠ ${escapeMarkdown(bound(group.error))}`];
  const panes = [...group.panes].sort((left, right) =>
    normalizedName(left).localeCompare(normalizedName(right)) || left.paneId.localeCompare(right.paneId)
  );
  if (!panes.length) return [`${heading}\n${directories}\n暂无 Pane`];

  const prefix = `${heading}\n${directories}`;
  const sections: string[] = [];
  let rows: string[] = [];
  for (const pane of panes) {
    const row = paneRow(pane);
    if (rows.length && `${prefix}\n${rows.join("\n")}\n${row}`.length > MAX_CARD_MARKDOWN_LENGTH) {
      sections.push(`${prefix}\n${rows.join("\n")}`); rows = [];
    }
    rows.push(row);
  }
  sections.push(`${prefix}\n${rows.join("\n")}`);
  return sections;
}

function paneRow(pane: SpaceDirectoryPane): string {
  const executables = pane.foregroundExecutables.length ? pane.foregroundExecutables.map((value) => escapeCode(bound(value))).join(", ") : "-";
  return `- **${escapeMarkdown(bound(normalizedName(pane)))}** · \`${escapeCode(bound(pane.paneId))}\` · ${pane.agentState} · \`${executables}\``;
}

function normalizedName(pane: SpaceDirectoryPane): string {
  return pane.name.replace(/\s+/g, " " ).trim() || pane.paneId;
}

function bound(value: string): string { return value.length > MAX_FIELD_LENGTH ? `${value.slice(0, MAX_FIELD_LENGTH - 1)}…` : value; }
function escapeCode(value: string): string { return value.replaceAll("`", "'"); }
function escapeMarkdown(value: string): string { return value.replace(/[\`*_{}[\]()#+.!|>-]/g, "\\$&"); }
