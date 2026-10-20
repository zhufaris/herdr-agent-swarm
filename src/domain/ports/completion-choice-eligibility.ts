export interface CompletionChoiceEligibilityRequest {
  paneId: string;
}

export interface CompletionChoiceEligibilityPort {
  isEligible(request: CompletionChoiceEligibilityRequest): boolean | Promise<boolean>;
}
