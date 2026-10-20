import type {
  CoreEventCapabilities,
  CoreEventSourceDescriptor,
  HerdrEventsPort
} from "../../domain/herdr-events.js";
import type {
  AgentTranscriptSource,
  AgentTranscriptSubmissionReceipt,
  AgentTranscriptTurnList,
  HerdrPort,
  NativePromptSubmissionReceipt
} from "../../domain/ports/external.js";
import type { AgentTranscriptDescriptor } from "../agent-transcript-reader.js";
import type { AgentTranscriptDescriptorResolver } from "../herdr-events-shadow.js";
import type { CoreEventBoundary } from "./identity.js";

export interface CoreNativeIdentity {
  agentKind: "traex" | "pi";
  sessionId: string;
}

export interface AttachedCoreEventSource {
  sourceId: string;
  sourceEpoch?: string;
  sessionId: string;
  latestCursor: string;
  recoverySources: CoreEventSourceDescriptor[];
  sessionStream: boolean;
  sessionRingV2: boolean;
}

export class HerdrEventSourceSession {
  private cachedCapabilities: Promise<CoreEventCapabilities> | undefined;
  private cachedSessionStreamSupport: Promise<boolean> | undefined;
  private cachedSessionRingSupport: Promise<boolean> | undefined;

  constructor(
    private readonly events: HerdrEventsPort,
    private readonly herdr: Pick<HerdrPort, "listAllPanes">,
    private readonly resolveTranscript: AgentTranscriptDescriptorResolver
  ) {}

  async resolveDescriptor(source: AgentTranscriptSource): Promise<AgentTranscriptDescriptor | null> {
    if (await this.supportsSessionRingV2() || await this.supportsSessionStream()) return null;
    return this.resolveTranscript(source);
  }

  async getSubmissionReceipt(source: AgentTranscriptSource, submissionId: string): Promise<AgentTranscriptSubmissionReceipt | null> {
    const identity = await this.identity(source);
    if (!identity || !(await this.capabilities()).exactTurnRecovery) return null;
    try { return await this.events.submissionReceipt(submissionId, identity); }
    catch { return null; }
  }

  async getNativeSubmissionReceipt(source: AgentTranscriptSource, submissionId: string): Promise<NativePromptSubmissionReceipt | null> {
    if (!(await this.supportsSessionRingV2()) && !(await this.supportsSessionStream())) return null;
    const identity = await this.identity(source);
    if (!identity) return null;
    try {
      const receipt = await this.events.sessionSubmissionReceipt(submissionId);
      return receipt.agentKind === identity.agentKind && receipt.sessionId === identity.sessionId ? receipt : null;
    } catch { return null; }
  }

  async listSessionTurns(source: AgentTranscriptSource, after?: string): Promise<AgentTranscriptTurnList> {
    const identity = await this.identity(source);
    if (!identity || !(await this.capabilities()).sessionTurnEnumeration) return { turns: [], complete: true };
    return this.events.listTurns(identity, after);
  }

  async identity(source: AgentTranscriptSource): Promise<CoreNativeIdentity | null> {
    if (source.agentKind !== "traex" && source.agentKind !== "pi") return null;
    if (await this.supportsSessionRingV2() || await this.supportsSessionStream()) {
      const session = source.nativeSession;
      return session?.kind === "id" && session.agent === source.agentKind
        ? { agentKind: source.agentKind, sessionId: session.value }
        : null;
    }
    const descriptor = await this.resolveTranscript(source);
    if (!descriptor) return null;
    return { agentKind: source.agentKind, sessionId: descriptor.sessionId };
  }

  capabilities(): Promise<CoreEventCapabilities> {
    if (!this.cachedCapabilities) {
      const capabilities = this.events.capabilities().catch(() => {
        if (this.cachedCapabilities === capabilities) this.cachedCapabilities = undefined;
        return { exactTurnRecovery: false, historicalTurnIndexRecovery: false, sessionTurnEnumeration: false, visibleReasoning: false, sessionEventRingV2: false };
      });
      this.cachedCapabilities = capabilities;
    }
    return this.cachedCapabilities;
  }

  supportsSessionStream(): Promise<boolean> {
    if (!this.cachedSessionStreamSupport) {
      const support = this.events.supportsSessionEventStream();
      this.cachedSessionStreamSupport = support;
      void support.catch(() => {
        if (this.cachedSessionStreamSupport === support) this.cachedSessionStreamSupport = undefined;
      });
    }
    return this.cachedSessionStreamSupport;
  }

  supportsSessionRingV2(): Promise<boolean> {
    if (!this.cachedSessionRingSupport) {
      const support = typeof this.events.supportsSessionEventRingV2 === "function"
        ? this.events.supportsSessionEventRingV2()
        : Promise.resolve(false);
      this.cachedSessionRingSupport = support;
      void support.catch(() => {
        if (this.cachedSessionRingSupport === support) this.cachedSessionRingSupport = undefined;
      });
    }
    return this.cachedSessionRingSupport;
  }

  async attach(source: AgentTranscriptSource, from: "start" | "end"): Promise<AttachedCoreEventSource> {
    if (await this.supportsSessionRingV2()) {
      if (!source.paneId) throw new Error("identity unavailable");
      const opened = await this.events.openSessionRing(source.paneId);
      const expectedSession = source.nativeSession;
      if (opened.agentKind !== source.agentKind
        || source.terminalId && opened.terminalId !== source.terminalId
        || expectedSession?.kind !== "id"
        || expectedSession.agent !== source.agentKind
        || opened.sessionId !== expectedSession.value) throw new Error("session event ring identity mismatch");
      return {
        sourceId: opened.ringId,
        sourceEpoch: opened.epoch,
        sessionId: opened.sessionId,
        latestCursor: opened.latestCursor,
        recoverySources: [{
          sourceId: opened.ringId, terminalId: opened.terminalId, agentKind: opened.agentKind,
          sessionId: opened.sessionId, state: "active", checkpointOffset: 0, latestCursor: opened.latestCursor
        }],
        sessionStream: true,
        sessionRingV2: true
      };
    }
    if (await this.supportsSessionStream()) {
      if (!source.paneId) throw new Error("identity unavailable");
      const opened = await this.events.openSession(source.paneId);
      const expectedSession = source.nativeSession;
      if (opened.agentKind !== source.agentKind
        || source.terminalId && opened.terminalId !== source.terminalId
        || expectedSession?.kind !== "id"
        || expectedSession.agent !== source.agentKind
        || opened.sessionId !== expectedSession.value) throw new Error("session stream identity mismatch");
      return {
        sourceId: opened.streamId,
        sessionId: opened.sessionId,
        latestCursor: opened.latestCursor,
        recoverySources: [{
          sourceId: opened.streamId, terminalId: opened.terminalId, agentKind: opened.agentKind,
          sessionId: opened.sessionId, state: "active", checkpointOffset: 0, latestCursor: opened.latestCursor
        }],
        sessionStream: true,
        sessionRingV2: false
      };
    }
    if (!source.paneId || !this.herdr.listAllPanes) throw new Error("identity unavailable");
    const panes = (await this.herdr.listAllPanes()).filter((pane) => pane.paneId === source.paneId);
    if (panes.length !== 1 || !panes[0]!.terminalId) throw new Error("identity unavailable");
    const descriptor = await this.resolveTranscript(source);
    if (!descriptor) throw new Error("transcript unavailable");
    const attached = await this.events.attach({
      paneId: source.paneId,
      agentKind: source.agentKind,
      sessionId: descriptor.sessionId,
      path: descriptor.path,
      from
    });
    let candidates = attached.sources;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const matches = candidates.filter((candidate) =>
        candidate.sourceId === attached.sourceId
        && candidate.terminalId === panes[0]!.terminalId
        && candidate.agentKind === source.agentKind
        && candidate.sessionId === descriptor.sessionId
      );
      const match = matches.length === 1 ? matches[0] : undefined;
      if (match?.state === "active" && match.checkpointOffset >= attached.attachOffset) {
        const historical = candidates.filter((candidate) =>
          candidate.state === "active"
          && candidate.agentKind === source.agentKind
          && candidate.sessionId === descriptor.sessionId
          && candidate.sourceId !== match.sourceId
        );
        return {
          sourceId: attached.sourceId,
          sessionId: descriptor.sessionId,
          latestCursor: match.latestCursor,
          recoverySources: [match, ...historical.reverse()],
          sessionStream: false,
          sessionRingV2: false
        };
      }
      if (attempt < 7) {
        await wait(125);
        candidates = await this.events.listSources();
      }
    }
    throw new Error("source unavailable");
  }

  locate(sourceId: string, boundary: Exclude<CoreEventBoundary, { kind: "latest" | "first" }>): Promise<{ found: boolean; afterCursor: string }> {
    const turn = boundary.kind === "at" || boundary.kind === "after"
      ? { id: boundary.turnId, startedAt: boundary.startedAt }
      : undefined;
    return this.events.locate(sourceId, boundary.kind, turn);
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
