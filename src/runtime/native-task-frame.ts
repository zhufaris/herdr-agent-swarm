import type { ProgressEventState } from "../domain/run-card-view.js";

interface NativeTaskStep { key: string; label: string; state: ProgressEventState }
interface NativeTaskFrame { start: number; end: number; steps: NativeTaskStep[] }

const TASK_COUNT = /^\s*\d+\s+tasks?\s*\(.*\)\s*$/i;
const TASK_ROW = /^\s*([✔✓■◻□✕✖✘×])\s+(.+?)\s*$/;
const TASK_CONTINUATION = /^\s{2,}\S/;
const META = /\([^)]*(?:tokens?|esc to)[^)]*\)/i;
const STATES = { "✔": "done", "✓": "done", "■": "active", "◻": "pending", "□": "pending", "✕": "failed", "✖": "failed", "✘": "failed", "×": "failed" } as const;

function findNativeTaskFrameLines(lines: readonly string[]): NativeTaskFrame | null {
  for (let taskCount = lines.length - 1; taskCount >= 0; taskCount -= 1) {
    if (!TASK_COUNT.test(lines[taskCount]!)) continue;
    let start = taskCount;
    while (start > 0 && lines[start - 1]!.trim()) start -= 1;
    let hasMeta = false;
    for (let index = start; index < taskCount; index += 1) {
      if (META.test(lines[index]!)) { hasMeta = true; break; }
    }
    if (!hasMeta) continue;

    const steps: NativeTaskStep[] = [];
    let end = taskCount + 1;
    while (end < lines.length) {
      const match = lines[end]!.match(TASK_ROW);
      if (!match) break;
      const labelParts = [match[2]!.trim()];
      end += 1;
      while (end < lines.length && isTaskContinuation(lines[end]!)) {
        labelParts.push(lines[end]!.trim());
        end += 1;
      }
      const label = labelParts.join(" " ).slice(0, 240);
      if (label && steps.length < 20) {
        steps.push({ key: `native:${steps.length}:${label}`, label, state: STATES[match[1] as keyof typeof STATES] });
      }
    }
    if (steps.length) return { start, end, steps };
  }
  return null;
}

function isTaskContinuation(line: string): boolean {
  return TASK_CONTINUATION.test(line)
    && !TASK_ROW.test(line)
    && !TASK_COUNT.test(line)
    && !META.test(line)
    && !/^\s*(?:◆|✧|│|├|└|```)/.test(line);
}

export function stripNativeTaskFrame(source: string): string {
  const normalized = source.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const frame = findNativeTaskFrameLines(lines);
  if (!frame) return normalized.trim();
  return [...lines.slice(0, frame.start), ...lines.slice(frame.end)].join("\n").trim();
}
