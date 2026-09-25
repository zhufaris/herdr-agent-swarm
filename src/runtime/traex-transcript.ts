import { stat } from "node:fs/promises";
import type { AgentTranscriptOpenResult, AgentTranscriptReaderPort, AgentTranscriptSource } from "../domain/ports/external.js";
import type { HerdrAgentSession } from "../domain/types.js";
import { MAX_TURN_OUTPUT_CHARS } from "./bounded-turn-output.js";
import { latestActiveTranscriptBaseline, latestTranscriptBaseline } from "./traex-transcript/baseline-reader.js";
import { findCompletedTurnBoundary, findTurnStartBoundary, MAX_RECOVERY_SCAN_BYTES } from "./traex-transcript/boundary-scanner.js";
import { DEFAULT_MAX_READ_BYTES, FileTraexTranscriptCursor } from "./traex-transcript/file-cursor.js";
import { TranscriptLocator } from "./traex-transcript/locator.js";
import type { TranscriptDiscoveryResult, TranscriptPathIndex } from "./traex-transcript/locator.js";
import { AGENT_SESSION_ID } from "./agent-transcript-codec.js";

const DEFAULT_MAX_RENDERED_DELTA_CHARS = MAX_TURN_OUTPUT_CHARS;

export type { TranscriptPathIndex } from "./traex-transcript/locator.js";
export { scanTranscriptPaths } from "./traex-transcript/locator.js";

export interface TraexTranscriptReaderOptions {
  sessionsRoot?: string;
  maxReadBytes?: number;
  maxRenderedDeltaChars?: number;
  maxDiscoveryEntries?: number;
  maxCachedPaths?: number;
  negativeCacheTtlMs?: number;
  discoveryIndexTtlMs?: number;
  now?: () => number;
  discover?: (root: string, sessionId: string, maxEntries: number) => Promise<TranscriptDiscoveryResult>;
  scan?: (root: string, maxEntries: number) => Promise<TranscriptPathIndex>;
}

export class TraexTranscriptReader implements AgentTranscriptReaderPort {
  private readonly locator: TranscriptLocator;
  private readonly maxReadBytes: number;
  private readonly maxRenderedDeltaChars: number;

  constructor(options: TraexTranscriptReaderOptions = {}) {
    this.locator = new TranscriptLocator(options);
    this.maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
    this.maxRenderedDeltaChars = options.maxRenderedDeltaChars ?? DEFAULT_MAX_RENDERED_DELTA_CHARS;
  }

  async open(source: AgentTranscriptSource | HerdrAgentSession | null | undefined): Promise<AgentTranscriptOpenResult> {
    const identity = validateSession(source);
    if (typeof identity !== "string") return identity;
    try {
      const sessionId = identity;
      const cachedPath = await this.locator.cachedPath(sessionId);
      if (cachedPath) return await this.openAtEnd(cachedPath);
      if (this.locator.isMissingCached(sessionId)) return unavailable("transcript_not_found");

      const discovery = await this.locator.discoverOnce(sessionId);
      if (discovery.paths.length > 1) return unavailable("ambiguous_transcript");
      if (discovery.exhausted) return unavailable("transcript_validation_failed");
      if (discovery.paths.length === 0) {
        this.locator.rememberMissing(sessionId);
        return unavailable("transcript_not_found");
      }
      const path = await this.locator.acceptDiscoveredPath(sessionId, discovery.paths[0]!);
      if (!path) return unavailable("transcript_validation_failed");
      return await this.openAtEnd(path);
    } catch {
      return unavailable("transcript_validation_failed");
    }
  }

  async openActiveTurn(source: AgentTranscriptSource | HerdrAgentSession | null | undefined): Promise<AgentTranscriptOpenResult> {
    const identity = validateSession(source);
    if (typeof identity !== "string") return identity;
    try {
      const path = await this.locator.resolveTranscriptPath(identity);
      if (!path) return unavailable("transcript_not_found");
      const file = await stat(path);
      const baseline = await latestActiveTranscriptBaseline(
        path, file.size, MAX_RECOVERY_SCAN_BYTES, this.maxRenderedDeltaChars,
      );
      return typed(new FileTraexTranscriptCursor(
        path, baseline.replayOffset ?? file.size, this.maxReadBytes, this.maxRenderedDeltaChars,
        baseline.tokenCount, baseline.replayOffset === null ? baseline.turnLifecycle : undefined,
      ));
    } catch {
      return unavailable("transcript_validation_failed");
    }
  }

  async openFirstTurn(source: AgentTranscriptSource | HerdrAgentSession | null | undefined): Promise<AgentTranscriptOpenResult> {
    const identity = validateSession(source);
    if (typeof identity !== "string") return identity;
    try {
      const path = await this.locator.resolveTranscriptPath(identity);
      if (!path) return unavailable("transcript_not_found");
      return typed(new FileTraexTranscriptCursor(
        path, 0, this.maxReadBytes, this.maxRenderedDeltaChars, 0, undefined,
      ));
    } catch {
      return unavailable("transcript_validation_failed");
    }
  }

  async openAfterTurn(
    source: AgentTranscriptSource | HerdrAgentSession | null | undefined,
    turnId: string,
    startedAt: string,
  ): Promise<AgentTranscriptOpenResult> {
    const identity = validateSessionAndTurn(source, turnId);
    if (typeof identity !== "string") return identity;
    try {
      const path = await this.locator.resolveTranscriptPath(identity);
      if (!path) return unavailable("transcript_not_found");
      const file = await stat(path);
      if (file.size > MAX_RECOVERY_SCAN_BYTES) return unavailable("transcript_validation_failed");
      const boundary = await findCompletedTurnBoundary(path, file.size, turnId, startedAt);
      if (boundary === "missing") return unavailable("turn_boundary_not_found");
      if (boundary === "incomplete") return unavailable("turn_boundary_incomplete");
      const baseline = await latestTranscriptBaseline(
        path, boundary, this.maxReadBytes, this.maxRenderedDeltaChars,
      );
      return typed(new FileTraexTranscriptCursor(
        path, boundary, this.maxReadBytes, this.maxRenderedDeltaChars, baseline.tokenCount, undefined,
      ));
    } catch {
      return unavailable("transcript_validation_failed");
    }
  }

  async openAtTurn(
    source: AgentTranscriptSource | HerdrAgentSession | null | undefined,
    turnId: string,
    startedAt: string,
  ): Promise<AgentTranscriptOpenResult> {
    const identity = validateSessionAndTurn(source, turnId);
    if (typeof identity !== "string") return identity;
    try {
      const path = await this.locator.resolveTranscriptPath(identity);
      if (!path) return unavailable("transcript_not_found");
      const file = await stat(path);
      const boundary = await findTurnStartBoundary(
        path, file.size, turnId, startedAt, Math.max(0, file.size - MAX_RECOVERY_SCAN_BYTES),
      );
      if (boundary === "missing") return unavailable("turn_boundary_not_found");
      const baseline = await latestTranscriptBaseline(
        path, boundary, this.maxReadBytes, this.maxRenderedDeltaChars,
      );
      return typed(new FileTraexTranscriptCursor(
        path, boundary, this.maxReadBytes, this.maxRenderedDeltaChars, baseline.tokenCount, undefined,
      ));
    } catch {
      return unavailable("transcript_validation_failed");
    }
  }

  private async openAtEnd(path: string): Promise<AgentTranscriptOpenResult> {
    const file = await stat(path);
    const baseline = await latestTranscriptBaseline(
      path, file.size, this.maxReadBytes, this.maxRenderedDeltaChars,
    );
    return typed(new FileTraexTranscriptCursor(
      path, file.size, this.maxReadBytes, this.maxRenderedDeltaChars,
      baseline.tokenCount, baseline.turnLifecycle,
    ));
  }
}

function validateSession(source: AgentTranscriptSource | HerdrAgentSession | null | undefined): string | AgentTranscriptOpenResult {
  const session = source && "nativeSession" in source ? source.nativeSession : source;
  if (!session) return unavailable("missing_session_identity");
  if (session.agent !== "traex" || session.kind !== "id" || !AGENT_SESSION_ID.test(session.value)) {
    return unavailable("unsupported_session_identity");
  }
  return session.value;
}

function validateSessionAndTurn(source: AgentTranscriptSource | HerdrAgentSession | null | undefined, turnId: string): string | AgentTranscriptOpenResult {
  const identity = validateSession(source);
  if (typeof identity !== "string") return identity;
  return AGENT_SESSION_ID.test(turnId) ? identity : unavailable("unsupported_session_identity");
}

function unavailable(reason: Extract<AgentTranscriptOpenResult, { mode: "unavailable" }>["reason"]): AgentTranscriptOpenResult {
  return { mode: "unavailable", reason };
}

function typed(cursor: FileTraexTranscriptCursor): AgentTranscriptOpenResult {
  return { mode: "typed", cursor };
}
