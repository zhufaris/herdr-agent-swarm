import { CoreSessionInvalidCursorError, CoreSessionUnrecoverableCursorError, type CoreEventBatch, type CoreRecoveryBatch, type CoreSessionEventMultiplexBatch, type CoreSessionEventMultiplexTarget, type HerdrEventsPort } from "../domain/herdr-events.js";
import type { AgentTranscriptCursorPort, AgentTranscriptObservation, AgentTranscriptOpenResult, AgentTranscriptReaderPort, AgentTranscriptSource, AgentTranscriptSubmissionReceipt, AgentTranscriptTurnList, HerdrPort } from "../domain/ports/external.js";
import type { AgentTranscriptDescriptorResolver } from "./herdr-events-shadow.js";
import type { AuthoritativeTurnSnapshotStore, CoreEventEnvelope, CoreEventInboxStore } from "../domain/core-event-inbox.js";
import { HerdrEventCursor } from "./herdr-events/event-cursor.js";
import { HerdrEventProjector, latestProjectedPlan } from "./herdr-events/event-projector.js";
import { fromCoreEventEnvelope, liveCoreEventLaneId, liveCoreSessionLaneId, recoveredCoreEventLaneId, toCoreEventEnvelope, type CoreEventBoundary } from "./herdr-events/identity.js";
import { HerdrEventSourceSession } from "./herdr-events/source-session.js";

type Boundary = CoreEventBoundary;

/** Stateful normalized projection seam for canonical SQLite ingestion. */
export class CanonicalEventProjector {
  private readonly projector = new HerdrEventProjector();
  project(envelope: CoreEventEnvelope) { return this.projector.project([fromCoreEventEnvelope(envelope)]); }
  snapshot() { return this.projector.snapshot(); }
  restore(snapshot: ReturnType<HerdrEventProjector["snapshot"]>): void { this.projector.restore(snapshot); }
}

export class HerdrEventsReader implements AgentTranscriptReaderPort {
  private readonly sourceSession: HerdrEventSourceSession;
  constructor(
    private readonly events: HerdrEventsPort,
    herdr: Pick<HerdrPort, "listAllPanes">,
    resolveTranscript: AgentTranscriptDescriptorResolver,
    private readonly coreEvents?: CoreEventInboxStore,
    private readonly projectorOptions: ConstructorParameters<typeof HerdrEventProjector>[0] = {},
    private readonly turnSnapshots?: AuthoritativeTurnSnapshotStore
  ) {
    this.sourceSession = new HerdrEventSourceSession(events, herdr, resolveTranscript);
  }

  open(source: AgentTranscriptSource) { return this.openBoundary(source, { kind: "latest" }); }
  openActiveTurn(source: AgentTranscriptSource) { return this.openBoundary(source, { kind: "active" }); }
  openFirstTurn(source: AgentTranscriptSource) { return this.openBoundary(source, { kind: "first" }); }
  openAtTurn(source: AgentTranscriptSource, turnId: string, startedAt: string) { return this.openBoundary(source, { kind: "at", turnId, startedAt }); }
  openAfterTurn(source: AgentTranscriptSource, turnId: string, startedAt: string) { return this.openBoundary(source, { kind: "after", turnId, startedAt }); }
  resolveTranscriptDescriptor(source: AgentTranscriptSource) { return this.sourceSession.resolveDescriptor(source); }

  async getSubmissionReceipt(source: AgentTranscriptSource, submissionId: string): Promise<AgentTranscriptSubmissionReceipt | null> {
    return this.sourceSession.getSubmissionReceipt(source, submissionId);
  }

  async getNativeSubmissionReceipt(source: AgentTranscriptSource, submissionId: string) {
    return this.sourceSession.getNativeSubmissionReceipt(source, submissionId);
  }

  async listSessionTurns(source: AgentTranscriptSource, after?: string): Promise<AgentTranscriptTurnList> {
    return this.sourceSession.listSessionTurns(source, after);
  }

  async ingestCurrentSession(source: AgentTranscriptSource): Promise<{ laneId: string; sourceId: string; ingestedEvents: number; caughtUp: boolean }> {
    if (!this.coreEvents) throw new Error("Core event inbox is unavailable");
    let invalidCursor: CoreSessionInvalidCursorError | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.ingestCurrentSessionAttempt(source);
      } catch (error) {
        if (!(error instanceof CoreSessionInvalidCursorError)) throw error;
        if (invalidCursor) {
          this.coreEvents.recordInvalidCursorGap({
            laneId: error.laneId,
            sourceId: error.sourceId,
            sourceEpoch: error.sourceEpoch,
            agentKind: error.agentKind,
            sessionId: error.sessionId,
            readCursor: error.readCursor,
            owner: error.owner,
            occurredAt: new Date().toISOString()
          });
          throw new CoreSessionUnrecoverableCursorError(error);
        }
        invalidCursor = error;
      }
    }
    throw new Error("Core session invalid-cursor retry exhausted");
  }

  async prepareMultiplexTarget(source: AgentTranscriptSource): Promise<CoreSessionEventMultiplexTarget> {
    if (!this.coreEvents) throw new Error("Core event inbox is unavailable");
    const attached = await this.sourceSession.attach(source, "start");
    if (!attached.sessionRingV2 || !attached.sourceEpoch) throw new Error("Core session event multiplex requires a v2 ring");
    const laneId = liveCoreSessionLaneId(source);
    const checkpoint = this.coreEvents.getCheckpoint(laneId);
    if (checkpoint && (checkpoint.sourceId !== attached.sourceId
      || checkpoint.sourceEpoch !== attached.sourceEpoch
      || checkpoint.agentKind !== attached.recoverySources[0]!.agentKind
      || checkpoint.sessionId !== attached.sessionId)) {
      throw new Error("Core event inbox identity mismatch");
    }
    return {
      ringId: attached.sourceId,
      epoch: attached.sourceEpoch,
      after: checkpoint?.readCursor ?? "start",
      limit: 128
    };
  }

  ingestMultiplexBatch(source: AgentTranscriptSource, target: CoreSessionEventMultiplexTarget, batch: CoreSessionEventMultiplexBatch): {
    laneId: string;
    sourceId: string;
    ingestedEvents: number;
    caughtUp: boolean;
    outcome: "accepted" | "stale_rebase";
    readCursor: string;
  } {
    if (!this.coreEvents) throw new Error("Core event inbox is unavailable");
    const session = source.nativeSession;
    if (session?.kind !== "id" || session.agent !== source.agentKind || (source.agentKind !== "traex" && source.agentKind !== "pi")) {
      throw new Error("Core session event multiplex identity is unavailable");
    }
    if (batch.ringId !== target.ringId || batch.epoch !== target.epoch) throw new Error("Core session event multiplex target mismatch");
    if (batch.events.some((event) => event.agentKind !== source.agentKind || event.sessionId !== session.value)) {
      throw new Error("Core session event multiplex batch identity mismatch");
    }
    const laneId = liveCoreSessionLaneId(source);
    const checkpoint = this.coreEvents.getCheckpoint(laneId);
    if (checkpoint && (checkpoint.sourceId !== target.ringId || checkpoint.sourceEpoch !== target.epoch
      || checkpoint.agentKind !== source.agentKind || checkpoint.sessionId !== session.value)) {
      throw new Error("Core event inbox identity mismatch");
    }
    const outcome = this.coreEvents.ingestBatch({
      laneId,
      sourceId: target.ringId,
      sourceEpoch: target.epoch,
      ...(source.sessionActivityContext ? { sessionActivityContext: source.sessionActivityContext } : {}),
      agentKind: source.agentKind,
      sessionId: session.value,
      afterCursor: target.after,
      nextCursor: batch.nextCursor,
      latestCursor: batch.latestCursor,
      events: batch.events.map((event) => toCoreEventEnvelope({ ...event, sourceId: target.ringId })),
      ingestedAt: new Date().toISOString()
    });
    const durable = this.coreEvents.getCheckpoint(laneId);
    if (!durable || durable.sourceId !== target.ringId || durable.sourceEpoch !== target.epoch
      || durable.agentKind !== source.agentKind || durable.sessionId !== session.value) {
      throw new Error("Core event inbox identity mismatch");
    }
    return {
      laneId,
      sourceId: target.ringId,
      ingestedEvents: outcome === "accepted" ? batch.events.length : 0,
      caughtUp: durable.readCursor === durable.latestCursor,
      outcome,
      readCursor: durable.readCursor
    };
  }

  private async ingestCurrentSessionAttempt(source: AgentTranscriptSource): Promise<{ laneId: string; sourceId: string; ingestedEvents: number; caughtUp: boolean }> {
    if (!this.coreEvents) throw new Error("Core event inbox is unavailable");
    const attached = await this.sourceSession.attach(source, "start");
    if (!attached.sessionStream) throw new Error("Core session event stream is unavailable");
    const laneId = liveCoreSessionLaneId(source, attached.sessionRingV2 ? undefined : attached.sourceId);
    let checkpoint = this.coreEvents.getCheckpoint(laneId);
    const sourceChanged = attached.sessionRingV2 && checkpoint !== null && checkpoint.sourceId !== attached.sourceId;
    if (checkpoint && ((!attached.sessionRingV2 && checkpoint.sourceId !== attached.sourceId)
      || checkpoint.agentKind !== attached.recoverySources[0]!.agentKind
      || checkpoint.sessionId !== attached.sessionId)) throw new Error("Core event inbox identity mismatch");
    let afterCursor = checkpoint?.readCursor ?? "start";
    let ingestedEvents = 0;
    let caughtUp = false;
    let staleBatchReloads = 0;
    let rebasedEpochTransition = false;
    let rebasedExpiredCursor = false;
    if (attached.sessionRingV2 && checkpoint && (sourceChanged || checkpoint.sourceEpoch !== attached.sourceEpoch)) {
      const liveRing = await this.events.openSessionRing(source.paneId!);
      if (liveRing.ringId !== attached.sourceId || liveRing.epoch !== attached.sourceEpoch
        || liveRing.agentKind !== attached.recoverySources[0]!.agentKind || liveRing.sessionId !== attached.sessionId
        || liveRing.terminalId !== attached.recoverySources[0]!.terminalId
        || source.terminalId && liveRing.terminalId !== source.terminalId) {
        throw new Error(sourceChanged
          ? "session event ring identity changed during source transition"
          : "session event ring identity changed during epoch transition");
      }
      if (sourceChanged) {
        if (!checkpoint.sourceEpoch || !attached.sourceEpoch) throw new Error("Core event source transition lost its identity fence");
        const transition = this.coreEvents.transitionSource({
          laneId,
          expectedSourceId: checkpoint.sourceId,
          expectedSourceEpoch: checkpoint.sourceEpoch,
          expectedReadCursor: checkpoint.readCursor,
          sourceId: attached.sourceId,
          sourceEpoch: attached.sourceEpoch,
          agentKind: attached.recoverySources[0]!.agentKind,
          sessionId: attached.sessionId,
          earliestCursor: liveRing.earliestCursor,
          latestCursor: liveRing.latestCursor,
          owner: source.coreEventOwner ?? { kind: "binding", id: source.bindingId },
          transitionedAt: new Date().toISOString()
        });
        if (transition !== "transitioned") throw new Error("Core event source transition lost its identity fence");
        checkpoint = this.coreEvents.getCheckpoint(laneId);
        if (!checkpoint || checkpoint.sourceId !== attached.sourceId || checkpoint.sourceEpoch !== attached.sourceEpoch || checkpoint.readCursor !== "start") {
          throw new Error("Core event source transition lost its identity fence");
        }
        afterCursor = checkpoint.readCursor;
      } else if (checkpoint.sourceEpoch && attached.sourceEpoch) {
        const rebase = this.coreEvents.rebaseEpochTransition({
          laneId,
          sourceId: attached.sourceId,
          expectedSourceEpoch: checkpoint.sourceEpoch,
          expectedReadCursor: checkpoint.readCursor,
          agentKind: attached.recoverySources[0]!.agentKind,
          sessionId: attached.sessionId,
          sourceEpoch: attached.sourceEpoch,
          earliestCursor: liveRing.earliestCursor,
          latestCursor: liveRing.latestCursor,
          owner: source.coreEventOwner ?? { kind: "binding", id: source.bindingId },
          rebasedAt: new Date().toISOString()
        });
        if (rebase !== "rebased") throw new Error("Core event epoch transition rebase lost its identity fence");
        checkpoint = this.coreEvents.getCheckpoint(laneId);
        if (!checkpoint || checkpoint.sourceEpoch !== attached.sourceEpoch || checkpoint.readCursor !== "start") {
          throw new Error("Core event epoch transition rebase lost its identity fence");
        }
        afterCursor = checkpoint.readCursor;
        rebasedEpochTransition = true;
      } else {
        throw new Error("Core event epoch transition rebase lost its identity fence");
      }
    }
    while (ingestedEvents < 512 && !caughtUp) {
      const result = attached.sessionRingV2
        ? await this.events.readSessionRing(attached.sourceId, afterCursor)
        : await this.events.readSession(attached.sourceId, afterCursor);
      if (result.outcome === "invalid_cursor") {
        throw new CoreSessionInvalidCursorError({
          laneId,
          sourceId: attached.sourceId,
          sourceEpoch: attached.sourceEpoch ?? null,
          agentKind: attached.recoverySources[0]!.agentKind,
          sessionId: attached.sessionId,
          readCursor: afterCursor,
          owner: source.coreEventOwner ?? { kind: "binding", id: source.bindingId }
        });
      }
      if (result.outcome === "cursor_expired") {
        if (!attached.sessionRingV2 || !attached.sourceEpoch || !result.resumeCursor || rebasedExpiredCursor) {
          throw new CoreSessionCursorExpiredError(result.earliestCursor, result.latestCursor, result.resumeCursor);
        }
        const expiredCursor = afterCursor;
        const observedAt = new Date().toISOString();
        const rebase = checkpoint
          ? this.coreEvents.rebaseExpiredCheckpoint({
            laneId,
            sourceId: attached.sourceId,
            sourceEpoch: attached.sourceEpoch,
            expectedSourceEpoch: checkpoint.sourceEpoch,
            agentKind: attached.recoverySources[0]!.agentKind,
            sessionId: attached.sessionId,
            expectedReadCursor: afterCursor,
            resumeCursor: result.resumeCursor,
            earliestCursor: result.earliestCursor,
            latestCursor: result.latestCursor,
            owner: source.coreEventOwner ?? { kind: "binding", id: source.bindingId },
            rebasedAt: observedAt
          })
          : this.coreEvents.bootstrapExpiredLane({
            laneId,
            sourceId: attached.sourceId,
            sourceEpoch: attached.sourceEpoch,
            agentKind: attached.recoverySources[0]!.agentKind,
            sessionId: attached.sessionId,
            resumeCursor: result.resumeCursor,
            earliestCursor: result.earliestCursor,
            latestCursor: result.latestCursor,
            owner: source.coreEventOwner ?? { kind: "binding", id: source.bindingId },
            observedAt
          });
        if (rebase !== "rebased" && rebase !== "bootstrapped" && rebase !== "stale_rebase") throw new Error("Core event checkpoint rebase lost its identity fence");
        checkpoint = this.coreEvents.getCheckpoint(laneId);
        if (!checkpoint
          || checkpoint.sourceId !== attached.sourceId
          || checkpoint.sourceEpoch !== attached.sourceEpoch
          || checkpoint.agentKind !== attached.recoverySources[0]!.agentKind
          || checkpoint.sessionId !== attached.sessionId
          || rebase === "stale_rebase" && checkpoint.readCursor === expiredCursor) {
          throw new Error("Core event checkpoint rebase lost its identity fence");
        }
        afterCursor = checkpoint.readCursor;
        rebasedExpiredCursor = true;
        continue;
      }
      const batch = result.batch;
      if (attached.sessionRingV2 && (!("epoch" in batch) || batch.epoch !== attached.sourceEpoch)) {
        if (rebasedEpochTransition) throw new Error("Core session event ring epoch changed again during ingestion");
        throw new Error("Core session event ring epoch changed");
      }
      const ingest = this.coreEvents.ingestBatch({
        laneId, sourceId: attached.sourceId, agentKind: attached.recoverySources[0]!.agentKind,
        ...(attached.sourceEpoch ? { sourceEpoch: attached.sourceEpoch } : {}),
        ...(source.sessionActivityContext ? { sessionActivityContext: source.sessionActivityContext } : {}),
        sessionId: attached.sessionId, afterCursor, nextCursor: batch.nextCursor, latestCursor: batch.latestCursor,
        events: batch.events.map((event) => toCoreEventEnvelope(
          attached.sessionRingV2 ? { ...event, sourceId: attached.sourceId } : event
        )), ingestedAt: new Date().toISOString()
      });
      if (ingest === "stale_rebase") {
        if (staleBatchReloads >= 1) throw new Error("Core event checkpoint changed repeatedly during ingestion");
        checkpoint = this.coreEvents.getCheckpoint(laneId);
        if (!checkpoint || checkpoint.sourceId !== attached.sourceId
          || checkpoint.agentKind !== attached.recoverySources[0]!.agentKind
          || checkpoint.sessionId !== attached.sessionId) throw new Error("Core event inbox identity mismatch");
        afterCursor = checkpoint.readCursor;
        staleBatchReloads += 1;
        continue;
      }
      ingestedEvents += batch.events.length;
      caughtUp = batch.nextCursor === batch.latestCursor;
      if (batch.nextCursor === afterCursor) break;
      afterCursor = batch.nextCursor;
    }
    return { laneId, sourceId: attached.sourceId, ingestedEvents, caughtUp };
  }

  async recoverCanonicalTurn(source: AgentTranscriptSource, turnId: string, startedAt: string): Promise<"recovered" | "indexing" | "not_found" | "ambiguous" | "unavailable"> {
    const session = source.nativeSession;
    if (!this.coreEvents || !this.turnSnapshots || session?.kind !== "id" || (source.agentKind !== "traex" && source.agentKind !== "pi")) return "unavailable";
    const identity = { agentKind: source.agentKind, sessionId: session.value, turnId, requestedStartedAt: startedAt };
    for (let page = 0; page < 16; page += 1) {
      let snapshot = this.turnSnapshots.loadAuthoritativeTurnSnapshot(identity);
      if (snapshot?.state === "ready" && snapshot.complete) {
        this.coreEvents.ingestCanonicalSnapshotEvidence(snapshot.events, new Date().toISOString());
        return "recovered";
      }
      if (snapshot?.state === "not_found" || snapshot?.state === "ambiguous") return snapshot.state;
      let batch: CoreRecoveryBatch;
      try {
        batch = await this.readRecovered(source.agentKind, session.value, turnId, snapshot?.canonicalStartedAt ?? startedAt, snapshot?.nextCursor ?? "");
      } catch {
        return "unavailable";
      }
      const staged = this.turnSnapshots.stageAuthoritativeTurnSnapshotPage({
        identity, owner: source.coreEventOwner ?? { kind: "binding", id: source.bindingId },
        afterCursor: snapshot?.nextCursor ?? "", batch: { ...batch, events: batch.events.map(toCoreEventEnvelope) }, observedAt: new Date().toISOString()
      });
      if (staged.state === "not_found" || staged.state === "ambiguous") return staged.state;
      if (staged.state === "indexing") return "indexing";
      snapshot = this.turnSnapshots.loadAuthoritativeTurnSnapshot(identity);
      if (snapshot?.state === "ready" && snapshot.complete) {
        this.coreEvents.ingestCanonicalSnapshotEvidence(snapshot.events, new Date().toISOString());
        return "recovered";
      }
    }
    return "indexing";
  }

  async replayProjectedTurnState(source: AgentTranscriptSource, turnId: string, startedAt: string) {
    const session = source.nativeSession;
    if (!this.coreEvents || !session || session.kind !== "id" || (source.agentKind !== "traex" && source.agentKind !== "pi")) return null;
    const events = this.coreEvents.loadProjectedTurnViewEvents({ agentKind: source.agentKind, sessionId: session.value, turnId, startedAt })
      .map(fromCoreEventEnvelope);
    const planSteps = latestProjectedPlan(events);
    const goalChanges = new HerdrEventProjector().project(events).goalChanges;
    if (!planSteps && !goalChanges?.length) return null;
    return {
      ...(planSteps ? { planSteps } : {}),
      ...(goalChanges?.length ? { goalChanges } : {})
    };
  }

  private async openBoundary(source: AgentTranscriptSource, boundary: Boundary): Promise<AgentTranscriptOpenResult> {
    try {
      const attached = await this.sourceSession.attach(source, boundary.kind === "latest" ? "end" : "start");
      if (attached.sessionStream && this.coreEvents && (boundary.kind === "latest" || boundary.kind === "active" || boundary.kind === "first")) {
        return typed(this.durableSessionCursor(source, attached.sourceId, attached.sessionId, attached.sessionRingV2));
      }
      if (boundary.kind === "latest") return typed(this.liveCursor(source, boundary, attached.sourceId, attached.sessionId, attached.latestCursor, attached.sessionStream, attached.sessionRingV2));
      if (boundary.kind === "first") return typed(this.liveCursor(source, boundary, attached.sourceId, attached.sessionId, "start", attached.sessionStream, attached.sessionRingV2));
      for (const candidate of attached.recoverySources) {
        try {
          const located = await this.sourceSession.locate(candidate.sourceId, boundary);
          if (located.found) return typed(this.liveCursor(source, boundary, candidate.sourceId, candidate.sessionId, located.afterCursor, attached.sessionStream));
        } catch { continue; }
      }
      if (boundary.kind === "at") {
        const recovered = await this.openRecoveredTurn(source, boundary.turnId, boundary.startedAt);
        if (recovered) return recovered;
      }
      return unavailable(boundary.kind === "active" ? "turn_boundary_incomplete" : "turn_boundary_not_found");
    } catch {
      if (boundary.kind === "at") {
        try {
          const recovered = await this.openRecoveredTurn(source, boundary.turnId, boundary.startedAt);
          if (recovered) return recovered;
        } catch { /* fail closed below */ }
      }
      return unavailable("transcript_validation_failed");
    }
  }

  private async openRecoveredTurn(source: AgentTranscriptSource, turnId: string, startedAt: string): Promise<AgentTranscriptOpenResult | null> {
    const identity = await this.sourceSession.identity(source);
    if (!identity) return unavailable("missing_session_identity");
    const capabilities = await this.sourceSession.capabilities();
    if (!capabilities.exactTurnRecovery || !capabilities.historicalTurnIndexRecovery) return unavailable("recovery_capability_unavailable");
    if (this.turnSnapshots) return this.stageRecoveredTurn(source, identity.agentKind, identity.sessionId, turnId, startedAt);
    // Recovery identity is the native session + turn ID. Do not include the
    // caller's potentially seconds-only started_at fence, because Core may
    // return a more precise canonical timestamp and that correction must not
    // fork the durable inbox lane on the next process start.
    const laneId = recoveredCoreEventLaneId(source, turnId, identity.agentKind, identity.sessionId);
    const checkpoint = this.coreEvents?.getCheckpoint(laneId);
    if (checkpoint && (checkpoint.agentKind !== identity.agentKind || checkpoint.sessionId !== identity.sessionId)) throw new Error("Core event inbox identity mismatch");
    let first;
    try {
      first = await this.readRecovered(identity.agentKind, identity.sessionId, turnId, startedAt, checkpoint?.readCursor ?? "");
    } catch {
      return unavailable("recovery_transient_failure");
    }
    if (first.outcome !== "recovered") return unavailable(`recovery_${first.outcome}` as "recovery_indexing" | "recovery_not_found" | "recovery_ambiguous");
    const inbox = this.coreEvents ? {
        store: this.coreEvents, laneId, agentKind: identity.agentKind, sessionId: identity.sessionId,
        owner: source.coreEventOwner ?? { kind: "binding", id: source.bindingId },
        ...(checkpoint?.sourceId ? { sourceId: checkpoint.sourceId } : {})
      } as const : undefined;
    if (inbox && first.events.length > 0) {
      const sourceId = inbox.sourceId ?? first.events[0]!.sourceId;
      inbox.store.ingestBatch({ laneId, sourceId, agentKind: identity.agentKind, sessionId: identity.sessionId,
        afterCursor: checkpoint?.readCursor ?? "", nextCursor: first.nextCursor, latestCursor: first.nextCursor,
        events: first.events.map(toCoreEventEnvelope), ingestedAt: new Date().toISOString() });
    }
    return {
      mode: "typed",
      recoveredIdentity: { turnId, canonicalStartedAt: first.canonicalStartedAt },
      cursor: new HerdrEventCursor(
        (after) => this.readRecoveredPage(identity.agentKind, identity.sessionId, turnId, first.canonicalStartedAt, after),
        first.nextCursor,
        inbox ? [] : first.events,
        inbox,
        first.complete,
        this.projectorOptions
      )
    };
  }

  private async stageRecoveredTurn(
    source: AgentTranscriptSource,
    agentKind: "traex" | "pi",
    sessionId: string,
    turnId: string,
    requestedStartedAt: string
  ): Promise<AgentTranscriptOpenResult> {
    const identity = { agentKind, sessionId, turnId, requestedStartedAt };
    const staged = this.turnSnapshots!.loadAuthoritativeTurnSnapshot(identity);
    if (staged?.state === "ambiguous") return unavailable("recovery_ambiguous");
    if (staged?.state === "not_found") return unavailable("recovery_not_found");
    if (staged?.state === "ready") return this.openReadySnapshot(staged);
    const afterCursor = staged?.nextCursor ?? "";
    let batch: CoreRecoveryBatch;
    try {
      batch = await this.readRecovered(agentKind, sessionId, turnId, staged?.canonicalStartedAt ?? requestedStartedAt, afterCursor);
    } catch {
      return unavailable("recovery_transient_failure");
    }
    const result = this.turnSnapshots!.stageAuthoritativeTurnSnapshotPage({
      identity,
      owner: source.coreEventOwner ?? { kind: "binding", id: source.bindingId },
      afterCursor,
      batch: { ...batch, events: batch.events.map(toCoreEventEnvelope) },
      observedAt: new Date().toISOString()
    });
    if (result.state === "ambiguous") return unavailable("recovery_ambiguous");
    if (result.state === "not_found") return unavailable("recovery_not_found");
    if (result.state === "ready") return this.openReadySnapshot(this.turnSnapshots!.loadAuthoritativeTurnSnapshot(identity)!);
    return unavailable("recovery_indexing");
  }

  private openReadySnapshot(snapshot: NonNullable<ReturnType<AuthoritativeTurnSnapshotStore["loadAuthoritativeTurnSnapshot"]>>): AgentTranscriptOpenResult {
    if (!snapshot.canonicalStartedAt) return unavailable("recovery_ambiguous");
    const projected = new HerdrEventProjector(this.projectorOptions).project(snapshot.events.map(fromCoreEventEnvelope));
    const observation: AgentTranscriptObservation = {
      ...projected,
      ...(projected.turnLifecycle ? {
        turnLifecycle: { ...projected.turnLifecycle, startedAt: snapshot.canonicalStartedAt }
      } : {}),
      authoritativeSnapshot: {
        ...snapshot.identity,
        canonicalStartedAt: snapshot.canonicalStartedAt
      }
    };
    return {
      mode: "typed",
      recoveredIdentity: { turnId: snapshot.identity.turnId, canonicalStartedAt: snapshot.canonicalStartedAt },
      cursor: new AuthoritativeSnapshotCursor(observation)
    };
  }

  private liveCursor(source: AgentTranscriptSource, boundary: Boundary, sourceId: string, sessionId: string, initialCursor: string, sessionStream = false, sessionRingV2 = false): HerdrEventCursor {
    const read = sessionRingV2
      ? (after: string) => this.readSessionRing(sourceId, after)
      : sessionStream ? (after: string) => this.readSession(sourceId, after) : (after: string) => this.read(sourceId, after);
    if (source.agentKind !== "traex" && source.agentKind !== "pi") return new HerdrEventCursor(read, initialCursor);
    const laneId = liveCoreEventLaneId(source, boundary, sourceId);
    const checkpoint = this.coreEvents?.getCheckpoint(laneId);
    if (checkpoint && (checkpoint.sourceId !== sourceId || checkpoint.agentKind !== source.agentKind || checkpoint.sessionId !== sessionId)) {
      throw new Error("Core event inbox identity mismatch");
    }
    return new HerdrEventCursor(
      read,
      checkpoint?.readCursor ?? initialCursor,
      [],
      this.coreEvents ? { store: this.coreEvents, laneId, sourceId, agentKind: source.agentKind, sessionId, owner: source.coreEventOwner ?? { kind: "binding", id: source.bindingId } } : undefined,
      false,
      this.projectorOptions
    );
  }

  private durableSessionCursor(source: AgentTranscriptSource, sourceId: string, sessionId: string, sessionRingV2 = false): HerdrEventCursor {
    const laneId = liveCoreSessionLaneId(source, sessionRingV2 ? undefined : sourceId);
    const checkpoint = this.coreEvents!.getCheckpoint(laneId);
    if (checkpoint && (sessionRingV2 ? checkpoint.agentKind !== source.agentKind || checkpoint.sessionId !== sessionId : checkpoint.sourceId !== sourceId || checkpoint.agentKind !== source.agentKind || checkpoint.sessionId !== sessionId)) {
      throw new Error("Core event inbox identity mismatch");
    }
    const cursor = checkpoint?.readCursor ?? "start";
    return new HerdrEventCursor(
      async (after) => ({ events: [], nextCursor: after, latestCursor: checkpoint?.latestCursor ?? after, complete: true }),
      cursor,
      [],
      { store: this.coreEvents!, laneId, sourceId, agentKind: source.agentKind as "traex" | "pi", sessionId, owner: source.coreEventOwner ?? { kind: "binding", id: source.bindingId } },
      true,
      this.projectorOptions
    );
  }

  private read(sourceId: string, after: string): Promise<CoreEventBatch> { return this.events.read(sourceId, after); }

  private async readSession(streamId: string, after: string): Promise<CoreEventBatch> {
    const result = await this.events.readSession(streamId, after);
    if (result.outcome === "invalid_cursor") throw new Error("Core session event cursor is invalid");
    if (result.outcome === "cursor_expired") throw new CoreSessionCursorExpiredError(result.earliestCursor, result.latestCursor);
    return result.batch;
  }

  private async readSessionRing(ringId: string, after: string): Promise<CoreEventBatch> {
    const result = await this.events.readSessionRing(ringId, after);
    if (result.outcome === "invalid_cursor") throw new Error("Core session event cursor is invalid");
    if (result.outcome === "cursor_expired") throw new CoreSessionCursorExpiredError(result.earliestCursor, result.latestCursor, result.resumeCursor);
    return {
      ...result.batch,
      events: result.batch.events.map((event) => ({ ...event, sourceId: ringId }))
    };
  }

  private readRecovered(agentKind: "traex" | "pi", sessionId: string, turnId: string, startedAt: string, after: string): Promise<CoreRecoveryBatch> {
    return this.events.recoverTurn({ agentKind, sessionId, turnId, startedAt, after });
  }

  private async readRecoveredPage(agentKind: "traex" | "pi", sessionId: string, turnId: string, canonicalStartedAt: string, after: string): Promise<CoreEventBatch> {
    const batch = await this.readRecovered(agentKind, sessionId, turnId, canonicalStartedAt, after);
    if (batch.outcome !== "recovered") throw new Error(`Core exact-turn recovery changed outcome to ${batch.outcome}`);
    if (batch.canonicalStartedAt !== canonicalStartedAt) throw new Error("Core exact-turn recovery changed canonical identity");
    return batch;
  }
}

class AuthoritativeSnapshotCursor implements AgentTranscriptCursorPort {
  private consumed = false;

  constructor(private readonly observation: AgentTranscriptObservation) {}

  async readDelta(): Promise<string> { return (await this.readObservation()).answerDelta; }

  async readObservation(): Promise<AgentTranscriptObservation> {
    if (this.consumed) return { answerDelta: "" };
    this.consumed = true;
    return this.observation;
  }
}

export class CoreSessionCursorExpiredError extends Error {
  constructor(readonly earliestCursor: string, readonly latestCursor: string, readonly resumeCursor?: string) {
    super("Core session event cursor expired");
    this.name = "CoreSessionCursorExpiredError";
  }
}

function typed(cursor: AgentTranscriptCursorPort): AgentTranscriptOpenResult { return { mode: "typed", cursor }; }
function unavailable(reason: Extract<AgentTranscriptOpenResult, { mode: "unavailable" }>["reason"]): AgentTranscriptOpenResult { return { mode: "unavailable", reason }; }
