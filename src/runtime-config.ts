import { existsSync, readFileSync } from "node:fs";
import { parseDocument, visit } from "yaml";
import { z } from "zod";

const pollingSchema = z.object({
  transcriptIdentityMs: z.number().int().min(10).max(5_000).default(50),
  attachedTranscriptMs: z.number().int().min(10).max(10_000).default(250),
  workerTurnMs: z.number().int().min(10).max(10_000).default(250),
  externalTurnMs: z.number().int().min(100).max(60_000).default(2_000)
}).strict().default({});
const cacheSchema = z.object({
  herdrSnapshotTtlMs: z.number().int().min(0).max(60_000).default(2_000)
}).strict().default({});
const cardsSchema = z.object({
  updateDebounceMs: z.number().int().min(0).max(10_000).default(500),
  payloadLimitChars: z.number().int().min(1_000).max(50_000).default(12_000),
  answerStreamLimitChars: z.number().int().min(4_000).max(50_000).default(28_000),
  answerPageLimitChars: z.number().int().min(1_000).max(28_000).default(9_000)
}).strict().default({}).superRefine((cards, context) => {
  if (cards.answerPageLimitChars > cards.answerStreamLimitChars) context.addIssue({ code: z.ZodIssueCode.custom, path: ["answerPageLimitChars"], message: "must not exceed answerStreamLimitChars" });
});
const paneClosureSchema = z.object({
  confirmationTtlMs: z.number().int().min(5_000).max(600_000).default(60_000)
}).strict().default({});
const runtimeConfigSchema = z.object({
  runtime: z.object({ polling: pollingSchema, cache: cacheSchema, cards: cardsSchema, paneClosure: paneClosureSchema }).strict().default({})
}).strict().default({});

export type RuntimeTuningConfig = z.infer<typeof runtimeConfigSchema>["runtime"] & { outboxSafetyScanIntervalMs: number };
export type RuntimeYamlConfig = Omit<RuntimeTuningConfig, "outboxSafetyScanIntervalMs">;

export function defaultRuntimeTuning(): RuntimeYamlConfig { return runtimeConfigSchema.parse({}).runtime; }
export function validateRuntimeTuning(value: unknown): RuntimeYamlConfig { return runtimeConfigSchema.parse({ runtime: value }).runtime; }

export function loadRuntimeTuning(path: string): RuntimeYamlConfig {
  if (!existsSync(path)) return defaultRuntimeTuning();
  let source: string;
  try { source = readFileSync(path, "utf8"); }
  catch (error) { throw new Error(`Cannot read runtime configuration ${path}: ${errorMessage(error)}`); }
  try {
    const document = parseDocument(source, { prettyErrors: false });
    if (document.errors.length) throw document.errors[0];
    visit(document, { Alias() { throw new Error("YAML aliases are not supported"); } });
    return runtimeConfigSchema.parse(document.toJS()).runtime;
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issue = error.issues[0];
      const field = issue?.path.length ? issue.path.join(".") : "runtime";
      throw new Error(`Invalid runtime configuration ${path}: ${field}: ${issue?.message ?? "invalid value"}`);
    }
    throw new Error(`Invalid runtime configuration ${path}: ${errorMessage(error)}`);
  }
}

export function serializeRuntimeTuning(config: RuntimeYamlConfig): string {
  const q = (value: number) => String(value);
  return [
    "runtime:", "  polling:", `    transcriptIdentityMs: ${q(config.polling.transcriptIdentityMs)}`,
    `    attachedTranscriptMs: ${q(config.polling.attachedTranscriptMs)}`, `    workerTurnMs: ${q(config.polling.workerTurnMs)}`,
    `    externalTurnMs: ${q(config.polling.externalTurnMs)}`, "", "  cache:",
    `    herdrSnapshotTtlMs: ${q(config.cache.herdrSnapshotTtlMs)}`, "", "  cards:",
    `    updateDebounceMs: ${q(config.cards.updateDebounceMs)}`, `    payloadLimitChars: ${q(config.cards.payloadLimitChars)}`,
    `    answerStreamLimitChars: ${q(config.cards.answerStreamLimitChars)}`, `    answerPageLimitChars: ${q(config.cards.answerPageLimitChars)}`,
    "", "  paneClosure:", `    confirmationTtlMs: ${q(config.paneClosure.confirmationTtlMs)}`, ""
  ].join("\n");
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
