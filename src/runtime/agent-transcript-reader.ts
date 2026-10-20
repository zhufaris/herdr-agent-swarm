import type { AgentTranscriptOpenResult, AgentTranscriptReaderPort, AgentTranscriptSource } from "../domain/ports/external.js";
export interface AgentTranscriptDescriptor { sessionId: string; path: string }
export interface DescriptorAwareTranscriptReader extends AgentTranscriptReaderPort {
  resolveTranscriptDescriptor?(source: AgentTranscriptSource): Promise<AgentTranscriptDescriptor | null>;
}

export class AgentTranscriptReader implements AgentTranscriptReaderPort {
  constructor(private readonly readers: ReadonlyMap<AgentTranscriptSource["agentKind"], DescriptorAwareTranscriptReader>) {}

  open(source: AgentTranscriptSource): Promise<AgentTranscriptOpenResult> { return this.reader(source)?.open(source) ?? Promise.resolve(unavailable()); }
  openActiveTurn(source: AgentTranscriptSource): Promise<AgentTranscriptOpenResult> {
    const reader = this.reader(source);
    return reader ? reader.openActiveTurn?.(source) ?? reader.open(source) : Promise.resolve(unavailable());
  }
  openFirstTurn(source: AgentTranscriptSource): Promise<AgentTranscriptOpenResult> {
    const reader = this.reader(source);
    return reader?.openFirstTurn?.(source) ?? Promise.resolve(unavailable());
  }
  openAtTurn(source: AgentTranscriptSource, turnId: string, startedAt: string): Promise<AgentTranscriptOpenResult> {
    return this.reader(source)?.openAtTurn?.(source, turnId, startedAt) ?? Promise.resolve(unavailable());
  }
  openAfterTurn(source: AgentTranscriptSource, turnId: string, startedAt: string): Promise<AgentTranscriptOpenResult> {
    return this.reader(source)?.openAfterTurn?.(source, turnId, startedAt) ?? Promise.resolve(unavailable());
  }
  getSubmissionReceipt(source: AgentTranscriptSource, submissionId: string) {
    return this.reader(source)?.getSubmissionReceipt?.(source, submissionId) ?? Promise.resolve(null);
  }
  listSessionTurns(source: AgentTranscriptSource, after?: string) {
    return this.reader(source)?.listSessionTurns?.(source, after) ?? Promise.resolve({ turns: [], complete: true });
  }
  resolveTranscriptDescriptor(source: AgentTranscriptSource): Promise<AgentTranscriptDescriptor | null> {
    return this.reader(source)?.resolveTranscriptDescriptor?.(source) ?? Promise.resolve(null);
  }

  private reader(source: AgentTranscriptSource): DescriptorAwareTranscriptReader | undefined { return this.readers.get(source.agentKind); }
}

function unavailable(): AgentTranscriptOpenResult { return { mode: "unavailable", reason: "unsupported_session_identity" }; }
