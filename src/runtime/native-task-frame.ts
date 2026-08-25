import type { ProgressEventState } from "../domain/run-card-view.js";

interface NativeTaskStep { key: string; label: string; state: ProgressEventState }
interface NativeTaskFrame { start: number; end: number; steps: NativeTaskStep[] }

const TASK_COUNT = /^\s*\d+\s+tasks?\s*\(.*\)\s*$/i;
const TASK_ROW = /^\s*([✔✓■◻□✕✖✘×])\s+(.+?)\s*$/;
const META = /\([^)]*(?:tokens?|esc to)[^)]*\)/i;
const STATES = { "✔": "done", "✓": "done", "■": "active", "◻": "pending", "□": "pending", "✕": "failed", "✖": "failed", "✘": "failed", "×": "failed" } as const;

export function findNativeTaskFrame(source: string): NativeTaskFrame | null {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  for (let taskCount = lines.length - 1; taskCount >= 0; taskCount -= 1) {
    if (!TASK_COUNT.test(lines[taskCount]!)) continue;
    let start = taskCount;
    while (start > 0 && lines[start - 1]!.trim()) start -= 1;
    if (!lines.slice(start, taskCount).some((line) => META.test(line))) continue;

    const steps: NativeTaskStep[] = [];
    let end = taskCount + 1;
    while (end < lines.length) {
      const match = lines[end]!.match(TASK_ROW);
      if (!match) break;
      const label = match[2]!.trim().slice(0, 240);
      if (label && steps.length < 20) {
        steps.push({ key: `native:${steps.length}:${label}`, label, state: STATES[match[1] as keyof typeof STATES] });
      }
      end += 1;
    }
    if (steps.length) return { start, end, steps };
  }
  return null;
}

export function stripNativeTaskFrame(source: string): string {
  const normalized = source.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const frame = findNativeTaskFrame(normalized);
  if (!frame) return normalized.trim();
  return [...lines.slice(0, frame.start), ...lines.slice(frame.end)].join("\n").trim();
}
