import { basename } from "node:path";

const MAX_THREAD_TITLE_LENGTH = 80;

export function formatProjectPaneTitle(cwd: string | null, paneName: string | null, paneId: string): string {
  const project = normalizeTitlePart(cwd ? basename(cwd) : "");
  const pane = normalizeTitlePart(paneName) || normalizeTitlePart(paneId) || "TraeX pane";
  if (!project) return truncateTitlePart(pane, MAX_THREAD_TITLE_LENGTH);
  const combined = `${project} / ${pane}`;
  if (combined.length <= MAX_THREAD_TITLE_LENGTH) return combined;

  const separatorLength = 3;
  const available = MAX_THREAD_TITLE_LENGTH - separatorLength;
  const projectLimit = Math.min(project.length, Math.max(Math.floor(available / 2), available - pane.length));
  const visibleProject = truncateTitlePart(project, projectLimit);
  const paneLimit = MAX_THREAD_TITLE_LENGTH - visibleProject.length - separatorLength;
  return `${visibleProject} / ${truncateTitlePart(pane, paneLimit)}`;
}

function normalizeTitlePart(value: string | null): string {
  return (value ?? "").replace(/\s+/g, " " ).trim();
}

function truncateTitlePart(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 1) return "…".slice(0, maxLength);
  return `${value.slice(0, maxLength - 1)}…`;
}
