const RESERVED_XML_ENVELOPE = /^<(goal_context|scheduled-task|codex_internal_context)(?:\s+[^<>]*)?>[\s\S]*<\/\1>$/;
const HOST_CONTEXT_ENVELOPE = /^<environment_context(?:\s+[^<>]*)?>[\s\S]*<\/environment_context>$/;
const AGENTS_INSTRUCTION_ENVELOPE = /^# AGENTS\.md instructions for [^\r\n]+\r?\n\r?\n<INSTRUCTIONS>[\s\S]*<\/INSTRUCTIONS>(?:\r?\n\r?\n<environment_context>[\s\S]*<\/environment_context>)?$/;

/**
 * Recognizes complete host-reserved Human records that are present in Core
 * order but are not user-authored conversation boundaries.
 */
export function isSystemInjectedHumanEnvelope(value: string): boolean {
  const text = value.trim();
  if (!text) return false;
  return RESERVED_XML_ENVELOPE.test(text) || HOST_CONTEXT_ENVELOPE.test(text) || AGENTS_INSTRUCTION_ENVELOPE.test(text);
}
