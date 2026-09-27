import { z } from "zod";
import type { AgentTranscriptPlanStep } from "../domain/ports/external.js";

const planArgumentsSchema = z.object({
  plan: z.array(z.object({
    step: z.string(),
    status: z.enum(["pending", "in_progress", "completed"])
  })).max(100)
}).passthrough();

export function parsePlanToolCall(name: string, argumentsJson: string): AgentTranscriptPlanStep[] | null {
  try {
    const outer = JSON.parse(argumentsJson) as unknown;
    const parsed = name === "update_plan"
      ? planArgumentsSchema.safeParse(outer)
      : isExecTool(name)
        ? parseWrappedPlan(outer)
        : null;
    if (!parsed?.success) return null;
    const states = { pending: "pending", in_progress: "active", completed: "done" } as const;
    const steps = parsed.data.plan.map((step, index) => ({
      key: `plan:${index}`,
      label: step.step.replace(/\s+/g, " ").trim().slice(0, 300),
      state: states[step.status]
    }));
    return steps.every((step) => step.label.length > 0) ? steps : null;
  } catch {
    return null;
  }
}

function isExecTool(name: string): boolean {
  return name === "exec" || name === "functions.exec" || name === "exec_command";
}

function parseWrappedPlan(value: unknown): ReturnType<typeof planArgumentsSchema.safeParse> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = (value as Record<string, unknown>).input;
  if (typeof input !== "string" || !/tools\.update_plan\s*\(/.test(input)) return null;
  const steps: Array<{ step: string; status: "pending" | "in_progress" | "completed" }> = [];
  const pattern = /"?step"?\s*:\s*("(?:\\.|[^"\\])*")\s*,\s*"?status"?\s*:\s*"(pending|in_progress|completed)"/g;
  for (const match of input.matchAll(pattern)) {
    try {
      steps.push({ step: JSON.parse(match[1]!) as string, status: match[2]! as "pending" | "in_progress" | "completed" });
    } catch {
      return null;
    }
  }
  return steps.length ? planArgumentsSchema.safeParse({ plan: steps }) : null;
}
