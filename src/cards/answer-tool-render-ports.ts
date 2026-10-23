import type { AnswerTimelineItem, AnswerTimelineToolCategory, AnswerTimelineToolState } from "../domain/answer-timeline.js";

export type AnswerTimelineToolItem = Extract<AnswerTimelineItem, { kind: "tool" }>;

export interface AnswerToolRenderModel {
  category: AnswerTimelineToolCategory;
  icon: string;
  label: string;
  target: string;
  semantic?: boolean;
  outcome?: "failure" | "timeout";
  summary?: string;
  state: AnswerTimelineToolState;
  context?: string;
  command?: string;
  result?: string;
  diff?: string;
  nested?: boolean;
  continuation?: boolean;
  groupChildCount?: number;
}

export interface AnswerToolRenderPort {
  readonly category: AnswerTimelineToolCategory;
  readonly icon: string;
  readonly label: string;
  project(item: AnswerTimelineToolItem): AnswerToolRenderModel | null;
}

export interface AnswerToolRenderGroup {
  summary: string;
  state: AnswerTimelineToolState;
  outcome?: "failure" | "timeout";
  members: AnswerToolRenderModel[];
}

export interface AnswerToolRenderGroupProjection {
  model: AnswerToolRenderGroup;
  childCount: number;
}

function standardPort(category: AnswerTimelineToolCategory, icon: string, label: string): AnswerToolRenderPort {
  return { category, icon, label, project: (item) => model(category, icon, label, item) };
}

export const readToolRenderPort = standardPort("read", "📖", "Read");
export const searchToolRenderPort = standardPort("search", "🔍", "Search");
export const editToolRenderPort = standardPort("edit", "✏️", "Edit");
export const commandToolRenderPort = standardPort("command", "⚙️", "Command");
export const testToolRenderPort = standardPort("test", "🧪", "Test");
export const toolToolRenderPort = standardPort("tool", "🔧", "Tool");

export const skillToolRenderPort: AnswerToolRenderPort = {
  category: "skill", icon: "🧩", label: "Skill",
  project: (item) => {
    const { command: _command, result: _result, resultPreview: _resultPreview, resultSummary: _resultSummary, ...visible } = item;
    return model("skill", "🧩", "Skill", visible);
  }
};

export const stepToolRenderPort: AnswerToolRenderPort = {
  category: "step", icon: "🛠️", label: "Step",
  project: (item) => item.label.trim().toLowerCase() === "update_plan" ? null : model("step", "🛠️", "Step", item)
};

export const ANSWER_TOOL_RENDER_PORTS: Readonly<Record<AnswerTimelineToolCategory, AnswerToolRenderPort>> = {
  read: readToolRenderPort,
  search: searchToolRenderPort,
  edit: editToolRenderPort,
  command: commandToolRenderPort,
  test: testToolRenderPort,
  skill: skillToolRenderPort,
  tool: toolToolRenderPort,
  step: stepToolRenderPort
};

export function projectAnswerToolRenderModel(item: AnswerTimelineToolItem): AnswerToolRenderModel | null {
  return ANSWER_TOOL_RENDER_PORTS[item.category].project(item);
}

export function projectAnswerToolRenderGroup(parent: AnswerTimelineToolItem, children: readonly AnswerTimelineToolItem[]): AnswerToolRenderGroup | null {
  if (children.length === 0 || children.some((child) => child.parentToolId !== parent.id)) return null;
  const members = children.map(projectAnswerToolRenderModel).filter((member): member is AnswerToolRenderModel => member !== null).map((member) => ({ ...member, nested: true }));
  if (members.length !== children.length) return null;
  const searches = members.filter((member) => member.category === "search");
  const reads = members.filter((member) => member.category === "read");
  const edits = members.filter((member) => member.category === "edit");
  const skills = members.filter((member) => member.category === "skill");
  const commands = members.filter((member) => member.category === "command" || member.category === "test");
  const state = groupState(parent, children);
  const outcome = groupOutcome(parent, children);
  let summary: string;
  if (searches.length === 0 && reads.length === members.length) {
    const readTarget = reads.length === 1 ? reads[0]!.target : `${reads.length} files`;
    summary = state === "running" ? `Reading ${readTarget}…` : state === "failed" ? `Failed to read ${readTarget}` : `Read ${readTarget}`;
  } else if (searches.length === 1 && searches.length + reads.length === members.length) {
    const readSummary = state === "succeeded"
      ? reads.length === 1 ? "read 1 file" : `read ${reads.length} files`
      : reads.length === 1 ? "reading 1 file" : `reading ${reads.length} files`;
    const searchVerb = state === "succeeded" ? "Searched for" : state === "failed" ? "Search failed for" : "Searching for";
    summary = `${searchVerb} ${searches[0]!.target}${reads.length > 0 ? `, ${readSummary}` : ""}${state === "running" ? "…" : ""}`;
  } else if (edits.length === members.length) {
    const editTarget = edits.length === 1 ? edits[0]!.target : `${edits.length} files`;
    summary = state === "running" ? `Editing ${editTarget}…` : state === "failed" ? `Failed to edit ${editTarget}` : `Edited ${editTarget}`;
  } else if (skills.length === members.length) {
    const skillTarget = skills.length === 1 ? `skill ${skills[0]!.target}` : `${skills.length} skills`;
    summary = state === "running" ? `Loading ${skillTarget}…` : state === "failed" ? `Failed to load ${skillTarget}` : `Loaded ${skillTarget}`;
  } else if (commands.length === members.length) {
    const commandTarget = commands.length === 1 ? commands[0]!.command ?? commands[0]!.target : `${commands.length} commands`;
    summary = state === "running" ? `Running ${commandTarget}…` : state === "failed" ? `Failed ${commandTarget}` : `Ran ${commandTarget}`;
  } else {
    return null;
  }
  return {
    summary,
    state,
    ...(outcome ? { outcome } : {}),
    members
  };
}

export function projectAnswerToolRenderGroupAt(items: readonly AnswerTimelineItem[], index: number): AnswerToolRenderGroupProjection | null {
  const parent = items[index];
  if (!parent || parent.kind !== "tool" || parent.parentToolId) return null;
  const children: AnswerTimelineToolItem[] = [];
  for (let childIndex = index + 1; childIndex < items.length; childIndex += 1) {
    const child = items[childIndex];
    if (child?.kind !== "tool" || child.parentToolId !== parent.id) break;
    children.push(child);
  }
  const model = projectAnswerToolRenderGroup(parent, children);
  return model ? { model, childCount: children.length } : null;
}

function model(category: AnswerTimelineToolCategory, icon: string, label: string, item: AnswerTimelineToolItem): AnswerToolRenderModel {
  const summary = standaloneSummary(category, item);
  const semantic = item.action !== undefined || item.target !== undefined || item.resultSummary !== undefined;
  const result = item.result ?? item.resultPreview ?? item.resultSummary?.text;
  return {
    category, icon, label: item.action ?? label, target: item.target ?? item.label, ...(semantic ? { semantic: true } : {}), state: item.state,
    ...(summary ? { summary } : {}),
    ...(item.context ? { context: item.context } : {}),
    ...(item.command ? { command: item.command } : {}),
    ...(result ? { result } : {}),
    ...(item.resultSummary?.outcome === "failure" || item.resultSummary?.outcome === "timeout" ? { outcome: item.resultSummary.outcome } : {}),
    ...(item.diff ? { diff: item.diff } : {}),
    ...(item.nested ? { nested: true } : {}),
    ...(item.continuation ? { continuation: true } : {}),
    ...(item.groupChildCount ? { groupChildCount: item.groupChildCount } : {})
  };
}

function standaloneSummary(category: AnswerTimelineToolCategory, item: AnswerTimelineToolItem): string | null {
  const target = category === "command" || category === "test" ? item.continuation ? item.label : item.command ?? item.label : item.label;
  let summary: string | null = null;
  if (category === "read") summary = item.state === "running" ? `Reading ${target}…` : item.state === "failed" ? `Failed to read ${target}` : `Read ${target}`;
  if (category === "search") summary = item.state === "running" ? `Searching for ${target}…` : item.state === "failed" ? `Search failed for ${target}` : `Searched for ${target}`;
  if (category === "edit") summary = item.state === "running" ? `Editing ${target}…` : item.state === "failed" ? `Failed to edit ${target}` : `Edited ${target}`;
  if (category === "command" || category === "test") summary = item.state === "running" ? `Running ${target}…` : item.state === "failed" ? `Failed ${target}` : `Ran ${target}`;
  if (category === "skill") summary = item.state === "running" ? `Loading skill ${target}…` : item.state === "failed" ? `Failed to load skill ${target}` : `Loaded skill ${target}`;
  return summary && item.nested ? `↳ ${summary}` : summary;
}

function groupState(parent: AnswerTimelineToolItem, children: readonly AnswerTimelineToolItem[]): AnswerTimelineToolState {
  const states = [parent.state, ...children.map((child) => child.state)];
  return states.includes("failed") ? "failed" : states.includes("running") ? "running" : "succeeded";
}

function groupOutcome(parent: AnswerTimelineToolItem, children: readonly AnswerTimelineToolItem[]): "failure" | "timeout" | undefined {
  const items = [parent, ...children];
  if (items.some((item) => item.resultSummary?.outcome === "timeout")) return "timeout";
  return items.some((item) => item.state === "failed" || item.resultSummary?.outcome === "failure") ? "failure" : undefined;
}
