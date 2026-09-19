import type {
  DecideNaturalLanguageCommandConfirmationResult,
  ConfirmNaturalLanguageSwarmCommandInput, ConfirmNaturalLanguageSwarmCommandResult,
  NaturalLanguageCommandConfirmation,
  StageNaturalLanguageCommandConfirmationInput,
  StageNaturalLanguageCommandConfirmationResult
} from "../natural-language-command-confirmation.js";

export interface NaturalLanguageCommandConfirmationStore {
  stageNaturalLanguageCommandConfirmation(input: StageNaturalLanguageCommandConfirmationInput): StageNaturalLanguageCommandConfirmationResult;
  getNaturalLanguageCommandConfirmation(id: string): NaturalLanguageCommandConfirmation | null;
  decideNaturalLanguageCommandConfirmation(input: { id: string; decision: "confirm" | "cancel"; actorOpenId: string; chatId: string; decidedAt: string }): DecideNaturalLanguageCommandConfirmationResult;
  confirmNaturalLanguageSwarmCommand(input: ConfirmNaturalLanguageSwarmCommandInput): ConfirmNaturalLanguageSwarmCommandResult;
}
