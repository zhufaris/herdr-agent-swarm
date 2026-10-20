import type {
  DecideNaturalLanguageCommandConfirmationResult,
  ConfirmNaturalLanguageSwarmCommandInput, ConfirmNaturalLanguageSwarmCommandResult,
  NaturalLanguageCommandConfirmation,
  ResolvedCommandTarget,
  StageNaturalLanguageCommandConfirmationInput,
  StageNaturalLanguageCommandConfirmationResult
} from "../natural-language-command-confirmation.js";

export interface NaturalLanguageCommandConfirmationStore {
  stageNaturalLanguageCommandConfirmation(input: StageNaturalLanguageCommandConfirmationInput): StageNaturalLanguageCommandConfirmationResult;
  getNaturalLanguageCommandConfirmation(id: string): NaturalLanguageCommandConfirmation | null;
  decideNaturalLanguageCommandConfirmation(input: { id: string; decision: "cancel"; actorOpenId: string; chatId: string; decidedAt: string } | { id: string; decision: "confirm"; actorOpenId: string; chatId: string; decidedAt: string; resolvedTarget?: ResolvedCommandTarget }): DecideNaturalLanguageCommandConfirmationResult;
  confirmNaturalLanguageSwarmCommand(input: ConfirmNaturalLanguageSwarmCommandInput): ConfirmNaturalLanguageSwarmCommandResult;
}
