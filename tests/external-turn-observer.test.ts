import pino from "pino";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { HerdrEventsAdapter } from "../src/adapters/herdr-events-adapter.js";
import { ExternalTurnObserver } from "../src/coordinator/external-turn-observer.js";
import { BindingPromptWorkflow } from "../src/coordinator/binding-prompt-workflow.js";
import type { AgentTranscriptObservation } from "../src/domain/ports.js";
import { createQueuedRunCard, reduceRunCard } from "../src/domain/run-card-view.js";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";
import { TestConversationViewProjector as ConversationViewProjector } from "./helpers/create-test-conversation-view-projector.js";
import { HerdrEventRouter } from "../src/runtime/herdr-event-router.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";
import { createTestPublisher } from "./helpers/create-test-outbound.js";
import { CardContextRebuilder } from "../src/events/card-context-rebuilder.js";
import { applicationPresentation, primaryPresentation } from "./helpers/presentation.js";
import type { LarkPort } from "../src/domain/ports.js";
import { initialTopicView } from "../src/domain/topic-view.js";
import { MAX_TURN_OUTPUT_CHARS, TURN_OUTPUT_TRUNCATION_MARKER } from "../src/runtime/bounded-turn-output.js";
import { createTestStoreBundle } from "./helpers/create-test-store-bundle.js";
import type { CoreEventEnvelope } from "../src/domain/core-event-inbox.js";
import { HerdrEventsReader } from "../src/runtime/herdr-events-reader.js";
import { HerdrEventCursor } from "../src/runtime/herdr-events/event-cursor.js";
import type { ProjectConfig } from "../src/domain/types.js";
import { conversationTurnProjectionId, type ConversationTurnIdentity } from "../src/domain/conversation-turn-projection.js";
import type { RunCardView } from "../src/domain/run-card-view.js";
import { coreEventResponse } from "./helpers/herdr-events.js";
import { selectCompletionChoiceTerminalAnswer } from "../src/domain/completion-choice.js";

function withHumanReviewChoice(answer: string): string {
  return `${answer}\n\n\`\`\`herdr-choice-list\n{"version":2,"intent":"human_review","question":"继续吗？","default":"yes","options":[{"id":"yes","label":"继续","message":"default"}]}\n\`\`\``;
}

type NativeTurnIdentity = {
  bindingId: string;
  bindingGeneration: number;
  paneId: string;
  nativeSessionId: string;
  turnId: string;
  startedAt: string;
};

function nativeTurnPromptId(identity: NativeTurnIdentity): string {
  const canonical = [
    `binding_id=${identity.bindingId}`,
    `binding_generation=${identity.bindingGeneration}`,
    `pane_id=${identity.paneId}`,
    `native_session_id=${identity.nativeSessionId}`,
    `turn_id=${identity.turnId}`,
    `started_at=${identity.startedAt}`
  ].join("\n");
  const digest = createHash("sha256").update(canonical).digest("hex");
  return `herdr-prompt:v1:${digest}`;
}

function stageHistoricalNativeSubmission(store: SqliteBindingStore, promptId: string, dispatchedAt: string): void {
  const staged = store.database.prepare(`
    UPDATE prompt_jobs
    SET state = 'submitted', observation_state = 'not_started', attempt_count = attempt_count + 1,
      dispatched_at = NULL, native_submission_id = NULL, updated_at = ?
    WHERE id = ? AND state = 'queued'
  `).run(dispatchedAt, promptId);
  if (Number(staged.changes) !== 1) throw new Error(`expected historical native submission ${promptId}`);
  if (!store.markPromptNativeQueued({ promptId, bindingId: "b1", submissionId: promptId, dispatchedAt })) {
    throw new Error(`expected historical native receipt ${promptId}`);
  }
  store.markPromptObservationDetached(promptId, "historical native submission awaits exact Core ownership");
}

function loadConversationSegmentView(store: SqliteBindingStore, identity: ConversationTurnIdentity): RunCardView | null {
  const row = store.database.prepare(`SELECT state_json FROM conversation_turn_projections
    WHERE agent_kind = ? AND session_id = ? AND turn_id = ? AND started_at = ?`).get(
    identity.agentKind, identity.sessionId, identity.turnId, identity.startedAt
  ) as { state_json: string | null } | undefined;
  if (row?.state_json) return JSON.parse(row.state_json) as RunCardView;
  const segment = store.database.prepare(`SELECT s.owner_id
    FROM conversation_segments s
    JOIN core_event_inbox e ON e.event_id=s.human_event_id
    WHERE s.agent_kind=? AND s.session_id=? AND e.turn_id=?`).get(
    identity.agentKind, identity.sessionId, identity.turnId
  ) as { owner_id: string } | undefined;
  if (!segment) return null;
  const rowWithId = store.database.prepare(`SELECT s.id
    FROM conversation_segments s
    JOIN core_event_inbox e ON e.event_id=s.human_event_id
    WHERE s.agent_kind=? AND s.session_id=? AND e.turn_id=?`).get(
    identity.agentKind, identity.sessionId, identity.turnId
  ) as { id: string } | undefined;
  if (!rowWithId) return null;
  const view = store.capabilityModules().conversationSegments.loadCardView(rowWithId.id);
  if (!view) return null;
  const visibleAnswers = view.timelineItems.filter((item) => item.kind === "agent_message" || item.kind === "final_answer");
  const finalAnswer = [...visibleAnswers].reverse().find((item) => item.kind === "final_answer");
  const answer = finalAnswer && "markdown" in finalAnswer
    ? selectCompletionChoiceTerminalAnswer(finalAnswer.markdown, "")
    : visibleAnswers.flatMap((item) => "markdown" in item ? [item.markdown] : []).join("\n\n");
  return { ...view, phase: view.state, answer } as unknown as RunCardView;
}

const loadConversationTurnView = loadConversationSegmentView;

function wrapCanonicalDirectReader(store: SqliteBindingStore, reader: ConstructorParameters<typeof ExternalTurnObserver>[0]["transcriptReader"]): ConstructorParameters<typeof ExternalTurnObserver>[0]["transcriptReader"] {
  const wrap = async (open: (...args: never[]) => Promise<{ mode: "typed"; cursor: { readObservation?: (...args: never[]) => Promise<AgentTranscriptObservation>; [key: string]: unknown } }>, ...args: never[]) => {
    const opened = await open(...args);
    let sequence = 0;
    const cursor = opened.cursor;
    if (!cursor) return opened;
    const readObservation = cursor.readObservation?.bind(cursor);
    if (!readObservation) return opened;
    cursor.readObservation = async (...readArgs: never[]) => {
      const observation = await readObservation(...readArgs);
      const turnId = observation.turnId ?? observation.turnLifecycle?.turnId;
      const startedAt = observation.turnLifecycle?.startedAt;
      if (turnId && startedAt && observation.requestText && !observation.requestSubmissionId && !observation.coreEventSettlement) {
        const laneId = `test-direct:${openedSessionId(args)}`;
        const sourceId = `test-source:${openedSessionId(args)}`;
        const eventId = `direct:${turnId}:human`;
        const sessionId = openedSessionId(args);
        const afterCursor = sequence === 0 ? "" : `${laneId}:${sequence}`;
        const events: CoreEventEnvelope[] = [{ schemaVersion: 1, eventId, cursor: `${laneId}:${++sequence}`, sourceId, agentKind: "traex", sessionId, turnId, occurredAt: startedAt, payload: { type: "human_message", message_id: observation.requestMessageId ?? eventId, text: observation.requestText, truncated: false } }];
        if (observation.answerDelta || observation.turnLifecycle?.finalAnswer) events.push({ schemaVersion: 1, eventId: `direct:${turnId}:message:${++sequence}`, cursor: `${laneId}:${sequence}`, sourceId, agentKind: "traex", sessionId, turnId, occurredAt: startedAt, payload: { type: "message", message_id: `direct:${turnId}:message:${sequence}`, channel: "final", text: observation.turnLifecycle?.finalAnswer ?? observation.answerDelta, truncated: false } });
        if (observation.turnLifecycle?.state === "completed") events.push({ schemaVersion: 1, eventId: `direct:${turnId}:completed`, cursor: `${laneId}:${++sequence}`, sourceId, agentKind: "traex", sessionId, turnId, occurredAt: startedAt, payload: { type: "turn_completed" } });
        if (observation.turnLifecycle?.state === "aborted") events.push({ schemaVersion: 1, eventId: `direct:${turnId}:aborted`, cursor: `${laneId}:${++sequence}`, sourceId, agentKind: "traex", sessionId, turnId, occurredAt: startedAt, payload: { type: "turn_aborted", reason: observation.turnLifecycle.reason ?? "aborted" } });
        store.capabilityModules().coreEvents.ingestBatch({ laneId, sourceId, agentKind: "traex", sessionId, afterCursor, nextCursor: events.at(-1)!.cursor, latestCursor: events.at(-1)!.cursor, events, ingestedAt: startedAt });
        return { ...observation, coreEventSettlement: { laneId, eventIds: events.map(({ eventId: settledEventId }) => settledEventId), occurredAt: startedAt, owner: { kind: "binding" as const, id: "b1" } } };
      }
      if (turnId && startedAt && !observation.requestSubmissionId && (observation.answerDelta || observation.turnLifecycle?.state === "completed" || observation.turnLifecycle?.state === "aborted")) {
        const sessionId = openedSessionId(args); const laneId = `test-direct:${sessionId}`; const sourceId = `test-source:${sessionId}`;
        const events: CoreEventEnvelope[] = [];
        if (observation.answerDelta || observation.turnLifecycle?.finalAnswer) events.push({ schemaVersion: 1, eventId: `direct:${turnId}:message:${++sequence}`, cursor: `${laneId}:${sequence}`, sourceId, agentKind: "traex", sessionId, turnId, occurredAt: startedAt, payload: { type: "message", message_id: `direct:${turnId}:message:${sequence}`, channel: "final", text: observation.turnLifecycle?.finalAnswer ?? observation.answerDelta, truncated: false } });
        if (observation.turnLifecycle?.state === "completed") events.push({ schemaVersion: 1, eventId: `direct:${turnId}:completed`, cursor: `${laneId}:${++sequence}`, sourceId, agentKind: "traex", sessionId, turnId, occurredAt: startedAt, payload: { type: "turn_completed" } });
        if (observation.turnLifecycle?.state === "aborted") events.push({ schemaVersion: 1, eventId: `direct:${turnId}:aborted`, cursor: `${laneId}:${++sequence}`, sourceId, agentKind: "traex", sessionId, turnId, occurredAt: startedAt, payload: { type: "turn_aborted", reason: observation.turnLifecycle.reason ?? "aborted" } });
        if (events.length) {
          store.capabilityModules().coreEvents.ingestBatch({ laneId, sourceId, agentKind: "traex", sessionId, afterCursor: `${laneId}:${sequence - events.length}`, nextCursor: events.at(-1)!.cursor, latestCursor: events.at(-1)!.cursor, events, ingestedAt: startedAt });
        }
        if (events.length) return { ...observation, coreEventSettlement: { laneId, eventIds: events.map(({ eventId }) => eventId), occurredAt: startedAt, owner: { kind: "binding" as const, id: "b1" } } };
      }
      return observation;
    };
    return opened;
  };
  const openedSessionId = (args: never[]) => {
    const input = args[0] as { nativeSession?: { value?: string } } | undefined;
    return input?.nativeSession?.value ?? "session-1";
  };
  return new Proxy(reader, { get(target, property) {
    const value = target[property as keyof typeof target];
    if (["open", "openActiveTurn", "openAtTurn"].includes(String(property)) && typeof value === "function") return (...args: never[]) => wrap(value.bind(target) as never, ...args);
    return value;
  }}) as ConstructorParameters<typeof ExternalTurnObserver>[0]["transcriptReader"];
}

const defaultProjects: ProjectConfig[] = [
  { id: "repo", displayName: "Repo", spaceName: "repo", description: "Repo", workspaceId: "w1", cwd: "/repo" }
];

type ExternalTurnObserverTestOptions = Omit<ConstructorParameters<typeof ExternalTurnObserver>[0], "workflow"> & {
  projects?: readonly ProjectConfig[];
  maxQueueDepth?: number;
  idFactory?: () => string;
  isBindingBusy?: (bindingId: string) => boolean;
};

function createExternalTurnObserver(options: ExternalTurnObserverTestOptions): ExternalTurnObserver {
  const {
    projects = defaultProjects,
    maxQueueDepth = 100,
    idFactory: _idFactory,
    isBindingBusy: _isBindingBusy,
    ...observerOptions
  } = options;
  const externalTurns = typeof observerOptions.store.capabilityModules === "function"
    ? observerOptions.store.capabilityModules().externalTurns
    : null;
  const workflow = new BindingPromptWorkflow({
    config: { projects, maxQueueDepth },
    store: (externalTurns ? Object.assign(Object.create(observerOptions.store), {
      loadConversationTurnProjection: externalTurns.loadConversationTurnProjection.bind(externalTurns),
      projectConversationTurn: externalTurns.projectConversationTurn.bind(externalTurns)
    }) : observerOptions.store) as never,
    lifecycleEvents: observerOptions.bus,
    outboundWork: observerOptions.outboundWork,
    scheduler: {
      subscribe: () => () => {},
      wake(event) {
        if (event.kind === "prompt-ready") observerOptions.wakePrompt(event.bindingId);
      }
    },
    presentation: observerOptions.presentation
  });
  return new ExternalTurnObserver({
    ...observerOptions,
    transcriptReader: typeof observerOptions.store.capabilityModules === "function"
      ? wrapCanonicalDirectReader(observerOptions.store, observerOptions.transcriptReader)
      : observerOptions.transcriptReader,
    workflow
  });
}

type TestStoreBundle = ReturnType<typeof createTestStoreBundle>;

function projectedHerdrMessage(input: {
  eventId: string;
  cursor: string;
  occurredAt: string;
  channel: "commentary" | "final";
  text: string;
  truncated?: boolean;
  completionChoice?: unknown;
}): CoreEventEnvelope {
  return {
    schemaVersion: 1, eventId: input.eventId, cursor: input.cursor, sourceId: "source-1",
    agentKind: "traex", sessionId: "session-1", turnId: "turn-projected", occurredAt: input.occurredAt,
    payload: {
      type: "message", message_id: `${input.eventId}-message`, channel: input.channel,
      text: input.text, truncated: input.truncated ?? false,
      ...(input.completionChoice === undefined ? {} : { completion_choice: input.completionChoice })
    }
  };
}

function prepareProjectedHerdrRepair(stores: TestStoreBundle, messageEvents: readonly CoreEventEnvelope[]) {
  stores.driver.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task", creatorOpenId: "ou_creator" });
  stores.driver.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
  const startedAt = "2026-09-30T06:00:00.000Z";
  const promptId = nativeTurnPromptId({ bindingId: "b1", bindingGeneration: 1, paneId: "w1:p1", nativeSessionId: "session-1", turnId: "turn-projected", startedAt });
  const view = createQueuedRunCard({ promptId: "external-projected", bindingId: "b1", title: "Direct", workspaceId: "w1", paneId: "w1:p1", requestText: "direct task", queuePosition: 0, occurredAt: startedAt });
  expect(stores.externalTurns.adoptExternalTurn({
    bindingId: "b1", expectedGeneration: 1, expectedPaneId: "w1:p1",
    expectedSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" },
    turnId: "turn-projected", startedAt, requestText: "direct task", externalPromptId: "external-projected",
    externalMessageId: "herdr-turn:session-1:turn-projected", externalView: view, answerCardFor: () => ({})
  }).outcome).toBe("created_external");
  stores.promptRecovery.markPromptObservationDetached(promptId, "restart");
  const terminalCursor = `c${messageEvents.length + 2}`;
  const terminal: CoreEventEnvelope = {
    schemaVersion: 1, eventId: "projected-terminal", cursor: terminalCursor, sourceId: "source-1",
    agentKind: "traex", sessionId: "session-1", turnId: "turn-projected",
    occurredAt: "2026-09-30T06:00:03.000Z", payload: { type: "turn_completed" }
  };
  const events: CoreEventEnvelope[] = [
    { schemaVersion: 1, eventId: "projected-start", cursor: "c1", sourceId: "source-1", agentKind: "traex", sessionId: "session-1", turnId: "turn-projected", occurredAt: startedAt, payload: { type: "turn_started" } },
    ...messageEvents,
    terminal
  ];
  stores.coreEvents.ingestBatch({ laneId: "lane-projected", sourceId: "source-1", agentKind: "traex", sessionId: "session-1", afterCursor: "start", nextCursor: terminalCursor, latestCursor: terminalCursor, events, ingestedAt: "2026-09-30T06:00:04.000Z" });
  stores.coreEvents.acknowledge("lane-projected", events.map(({ eventId }) => eventId), "projected", "2026-09-30T06:00:05.000Z", undefined, { kind: "binding", id: "b1" });
  return { promptId, startedAt, terminal };
}

function projectedHerdrRepairInput(prepared: { promptId: string; startedAt: string }) {
  return {
    promptId: prepared.promptId, bindingId: "b1", expectedGeneration: 1, expectedPaneId: "w1:p1",
    expectedSession: { source: "herdr:traex" as const, agent: "traex" as const, kind: "id" as const, value: "session-1" },
    turnId: "turn-projected", startedAt: prepared.startedAt, occurredAt: "2026-09-30T06:00:06.000Z"
  };
}

function projectedV3ReviewFence(question = "Recovered review?", optionId = "continue"): string {
  return `\`\`\`herdr-choice-list\n{"version":3,"choice":{"question":"${question}","defaultOption":{"id":"${optionId}","label":"Continue","submitText":"Continue"},"alternatives":[]}}\n\`\`\``;
}

function projectedV3NoneFence(): string {
  return "```herdr-choice-list\n{\"version\":3}\n```";
}

function completeOversizedV3ReviewFence(): string {
  const option = (id: string, label: string) => ({ id, label, submitText: `${id}:`.padEnd(2_000, id) });
  return `\`\`\`herdr-choice-list\n${JSON.stringify({
    version: 3,
    choice: {
      question: "Choose one oversized but otherwise valid option set?",
      defaultOption: option("a", "Option A"),
      alternatives: [option("b", "Option B"), option("c", "Option C"), option("d", "Option D")]
    }
  })}\n\`\`\``;
}

function rewritePersistedCompletionChoice(stores: TestStoreBundle, eventId: string, completionChoice: unknown): void {
  const persisted = stores.driver.database.prepare("SELECT event_json FROM core_event_inbox WHERE event_id=?").get(eventId) as { event_json: string };
  const event = JSON.parse(persisted.event_json) as { payload: Record<string, unknown> };
  event.payload.completion_choice = completionChoice;
  stores.driver.database.prepare("UPDATE core_event_inbox SET event_json=? WHERE event_id=?").run(JSON.stringify(event), eventId);
}

describe("ExternalTurnObserver", () => {
  it("binds a settled direct-Herdr segment without creating a legacy Answer projection", () => {
    const stores = createTestStoreBundle(":memory:");
    stores.driver.createPendingBinding({
      id: "b1", projectId: "repo", workspaceId: "w1", chatId: "c1", topicId: "t1",
      rootMessageId: "root", title: "Direct turn"
    });
    stores.driver.updateBinding("b1", {
      state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-placeholder"
    });
    const identity: ConversationTurnIdentity = {
      agentKind: "traex",
      sessionId: "session-placeholder",
      turnId: "turn-placeholder",
      startedAt: "2026-10-04T10:00:00.000Z"
    };
    const events: CoreEventEnvelope[] = [
      {
        schemaVersion: 1, eventId: "placeholder-start", cursor: "c1", sourceId: "source-1",
        agentKind: "traex", sessionId: identity.sessionId, turnId: identity.turnId,
        occurredAt: identity.startedAt, payload: { type: "turn_started" }
      },
      {
        schemaVersion: 1, eventId: "placeholder-human", cursor: "c2", sourceId: "source-1",
        agentKind: "traex", sessionId: identity.sessionId, turnId: identity.turnId,
        occurredAt: "2026-10-04T10:00:00.100Z",
        payload: { type: "human_message", message_id: "human-placeholder", text: "direct task", truncated: false }
      },
      {
        schemaVersion: 1, eventId: "placeholder-final", cursor: "c3", sourceId: "source-1",
        agentKind: "traex", sessionId: identity.sessionId, turnId: identity.turnId,
        occurredAt: "2026-10-04T10:00:01.000Z",
        payload: { type: "message", message_id: "final-placeholder", channel: "final", text: "done", truncated: false }
      },
      {
        schemaVersion: 1, eventId: "placeholder-completed", cursor: "c4", sourceId: "source-1",
        agentKind: "traex", sessionId: identity.sessionId, turnId: identity.turnId,
        occurredAt: "2026-10-04T10:00:01.100Z", payload: { type: "turn_completed" }
      }
    ];
    stores.coreEvents.ingestBatch({
      laneId: "lane-placeholder", sourceId: "source-1", agentKind: "traex", sessionId: identity.sessionId,
      afterCursor: "start", nextCursor: "c4", latestCursor: "c4", events,
      ingestedAt: "2026-10-04T10:00:02.000Z"
    });
    stores.coreEvents.acknowledge(
      "lane-placeholder", events.map(({ eventId }) => eventId), "projected", "2026-10-04T10:00:03.000Z",
      undefined, { kind: "binding", id: "b1" }
    );
    expect(stores.driver.database.prepare(`SELECT projection_id,binding_id,pane_id,state_json,answer_card_json
      FROM conversation_turn_projections WHERE session_id=? AND turn_id=?`).get(identity.sessionId, identity.turnId)).toBeUndefined();

    const promptId = conversationTurnProjectionId(identity);
    let view = createQueuedRunCard({
      promptId, bindingId: "b1", bindingGeneration: 1, title: "Direct task", workspaceId: "w1", spaceName: "repo",
      paneId: "w1:p1", requestText: "direct task", queuePosition: 0, occurredAt: identity.startedAt
    });
    view = reduceRunCard(view, { type: "started", occurredAt: identity.startedAt });
    view = reduceRunCard(view, {
      type: "completed", occurredAt: "2026-10-04T10:00:01.100Z", answer: "done", replaceAnswer: true
    });
    const project = () => stores.externalTurns.projectConversationTurn({
      identity, origin: "herdr", bindingId: "b1", expectedGeneration: 1, expectedPaneId: "w1:p1", view,
      settlement: {
        laneId: "lane-placeholder", eventIds: events.map(({ eventId }) => eventId),
        occurredAt: "2026-10-04T10:00:03.000Z", owner: { kind: "binding" as const, id: "b1" }
      },
      answerCardFor: (current) => ({ answer: current.answer }),
      mainCardFor: (current) => ({ phase: current.phase }),
      paneEntryCardFor: (current) => ({ phase: current.phase })
    });

    expect(project()).toMatchObject({
      outcome: "projected", outboxReserved: true,
      projection: null
    });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM conversation_turn_projections").get()).toEqual({ count: 0 });
    expect(stores.driver.database.prepare("SELECT owner_id,root_message_id,state FROM conversation_segments WHERE human_event_id='placeholder-human'").get()).toEqual({ owner_id: "b1", root_message_id: "root", state: "completed" });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM conversation_segment_pages").get()).toEqual({ count: 1 });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE projection_key LIKE 'conversation-turn:%'").get()).toEqual({ count: 0 });
    expect(project()).toMatchObject({ outcome: "projected", projection: null });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM prompt_jobs").get()).toEqual({ count: 0 });
    stores.lifecycle.close();
  });

  it("projects an unmatched direct Herdr human turn without creating a Prompt Job", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", {
      state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", lastAgentState: "working",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-direct"
    });
    const observations: AgentTranscriptObservation[] = [
      { turnId: "turn-direct", freshTurnStart: true, answerDelta: "", turnLifecycle: { turnId: "turn-direct", state: "active", startedAt: "2026-10-04T04:20:00.000Z" } },
      {
        turnId: "turn-direct", requestText: "direct task", requestMessageId: "human-direct", answerDelta: "",
        timelineDeltas: [{ kind: "human_message", id: "human:human-direct", sequence: 1, markdown: "direct task" }],
        turnLifecycle: { turnId: "turn-direct", state: "active", startedAt: "2026-10-04T04:20:00.000Z" }
      }
    ];
    const cursor = { async readDelta() { return ""; }, async readObservation() { return observations.shift() ?? { answerDelta: "" }; } };
    const observer = createExternalTurnObserver({
      store,
      transcriptReader: { open: vi.fn(async () => ({ mode: "typed" as const, cursor })) },
      bus: new BridgeEventBus(), outboundWork: { wake: vi.fn() }, logger: pino({ enabled: false }),
      presentation: primaryPresentation, wakePrompt: vi.fn()
    });

    await observer.handoff("b1");

    expect(store.database.prepare("SELECT COUNT(*) AS count FROM prompt_jobs").get()).toEqual({ count: 0 });
    expect(store.database.prepare("SELECT owner_id,root_message_id,state,request_text FROM conversation_segments WHERE session_id='session-direct'").get()).toEqual({ owner_id: "b1", root_message_id: "root", state: "working", request_text: "direct task" });
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM conversation_segment_pages").get()).toEqual({ count: 1 });
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM conversation_turn_projections").get()).toEqual({ count: 0 });
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE projection_key LIKE 'conversation-turn:%'").get()).toEqual({ count: 0 });

    await observer.stop();
    store.close();
  });

  it("replays the exact durable Core plan after a queued Prompt is adopted mid-turn", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", {
      state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", lastAgentState: "idle",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1"
    });
    const queued = createQueuedRunCard({ promptId: "queued", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1", requestText: "adopt me", queuePosition: 1, occurredAt: "2026-09-30T16:16:00.000Z" });
    store.acceptPrompt({ prompt: { id: "queued", bindingId: "b1", larkMessageId: "message-1", actorOpenId: "user", body: "adopt me" }, view: queued, rootMessageId: "root", answerCard: {} });
    expect(store.claimNextDispatchablePrompt("b1")?.prompt.id).toBe("queued");
    expect(store.markPromptNativeQueued({
      promptId: "queued",
      bindingId: "b1",
      submissionId: "queued",
      dispatchedAt: "2099-09-30T16:16:10.000Z"
    })).toBe(true);
    store.markPromptObservationDetached("queued", "native submission awaits exact Core ownership");
    store.updateBinding("b1", { lastAgentState: "working" });

    const observations: AgentTranscriptObservation[] = [
      { turnId: "turn-1", freshTurnStart: true, requestSubmissionId: "queued", answerDelta: "", turnLifecycle: { turnId: "turn-1", state: "active", startedAt: "2099-09-30T16:16:14.000Z" } },
      { turnId: "turn-1", answerDelta: "", mainStatus: { planSteps: [{ key: "plan:0", label: "Inspect durable state", state: "active" }] } },
      { turnId: "turn-1", requestSubmissionId: "queued", requestText: "adopt me", answerDelta: "" }
    ];
    const cursor = { async readDelta() { return ""; }, async readObservation() { return observations.shift() ?? { answerDelta: "" }; } };
    const coreEvents = store.capabilityModules().coreEvents;
    const startEvent: CoreEventEnvelope = {
      schemaVersion: 1, eventId: "start-before-owner", cursor: "source-1:1", sourceId: "source-1", agentKind: "traex",
      sessionId: "session-1", turnId: "turn-1", occurredAt: "2099-09-30T16:16:14.000Z", payload: { type: "turn_started" }
    };
    const planEvent: CoreEventEnvelope = {
      schemaVersion: 1, eventId: "plan-before-owner", cursor: "source-1:2", sourceId: "source-1", agentKind: "traex",
      sessionId: "session-1", turnId: "turn-1", occurredAt: "2099-09-30T16:16:20.000Z",
      payload: { type: "tool_call", call_id: "plan-1", name: "update_plan", arguments: JSON.stringify({ plan: [{ step: "Inspect durable state", status: "in_progress" }] }), truncated: false }
    };
    const goalEvent: CoreEventEnvelope = {
      schemaVersion: 1, eventId: "goal-before-owner", cursor: "source-1:3", sourceId: "source-1", agentKind: "traex",
      sessionId: "session-1", turnId: "turn-1", occurredAt: "2099-09-30T16:16:20.500Z",
      payload: { type: "goal_changed", goal_id: "goal-1", objective: "Ship safely", status: "active", source_updated_at: 1, truncated: false }
    };
    coreEvents.ingestBatch({ laneId: "lane-1", sourceId: "source-1", agentKind: "traex", sessionId: "session-1", afterCursor: "start", nextCursor: "source-1:3", latestCursor: "source-1:3", events: [startEvent, planEvent, goalEvent], ingestedAt: "2099-09-30T16:16:21.000Z" });
    store.database.prepare(`INSERT INTO conversation_turn_projections(
      agent_kind,session_id,turn_id,started_at,source_lane_id,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?)`).run(
      "traex", "session-1", "turn-1", "2099-09-30T16:16:14.000Z", "lane-1",
      "2099-09-30T16:16:21.000Z", "2099-09-30T16:16:21.000Z"
    );
    coreEvents.acknowledge("lane-1", [startEvent.eventId, planEvent.eventId, goalEvent.eventId], "projected", "2099-09-30T16:16:22.000Z", undefined, { kind: "binding", id: "b1" });
    const durableReader = new HerdrEventsReader(new HerdrEventsAdapter({ run: vi.fn(async () => { throw new Error("must not read Core during durable replay"); }) }, "herdr"), { async listAllPanes() { return []; } }, async () => null, coreEvents);
    const replayProjectedTurnState = vi.fn(durableReader.replayProjectedTurnState.bind(durableReader));
    const openCursor = vi.fn(async () => ({ mode: "typed" as const, cursor }));
    const transcriptReader = { openActiveTurn: openCursor, openAtTurn: openCursor, open: openCursor, replayProjectedTurnState };
    const bus = new BridgeEventBus();
    const published: unknown[] = [];
    bus.onBridgeEvent("capture-replayed-plan", (event) => { published.push(event); });
    const publisher = createTestPublisher(store, noOpLark(), pino({ enabled: false }));
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false }), primaryPresentation, { converge: async () => undefined }, { project: async () => undefined, converge: async () => undefined }, { cardUpdateDebounceMs: 0, mainCardUpdateDebounceMs: 0 });
    projector.start();
    const observer = createExternalTurnObserver({
      store, transcriptReader, bus, outboundWork: { wake() {} }, logger: pino({ enabled: false }), presentation: primaryPresentation,
      wakePrompt: vi.fn(), projects: [{ id: "repo", displayName: "Repo", spaceName: "repo", description: "Repo", workspaceId: "w1", cwd: "/repo" }], idFactory: () => "external"
    });

    await publisher.drain();
    await observer.handoff("b1");

    expect(store.getPrompt("queued")).toMatchObject({ state: "running", executionOrigin: "bridge", transcriptTurnId: "turn-1" });
    expect(replayProjectedTurnState).toHaveBeenCalledWith(expect.objectContaining({ bindingId: "b1" }), "turn-1", "2099-09-30T16:16:14.000Z");
    expect(published).toContainEqual(expect.objectContaining({ type: "TurnOutputObserved", payload: expect.objectContaining({ promptId: "queued" }) }));
    await vi.waitFor(() => expect(store.loadRunCard("queued")?.taskList).toEqual([
      expect.objectContaining({ key: "plan:0", label: "Inspect durable state", state: "active" })
    ]));
    await vi.waitFor(() => expect(store.loadRunCard("queued")?.currentGoal).toMatchObject({ goalId: "goal-1", objective: "Ship safely", status: "active" }));

    const projectedVersion = store.loadRunCard("queued")!.viewVersion;
    await observer.stop();
    const reopened = createExternalTurnObserver({
      store, transcriptReader, bus, outboundWork: { wake() {} }, logger: pino({ enabled: false }), presentation: primaryPresentation,
      wakePrompt: vi.fn(), projects: [{ id: "repo", displayName: "Repo", spaceName: "repo", description: "Repo", workspaceId: "w1", cwd: "/repo" }]
    });
    await reopened.observe(store.getBinding("b1")!);
    expect(store.loadRunCard("queued")?.viewVersion).toBe(projectedVersion);
    expect(published.filter((event) => (event as { type?: string }).type === "TurnCompleted" || (event as { type?: string }).type === "TurnFailed")).toEqual([]);

    await reopened.stop();
    await projector.stop();
    await publisher.stop();
    store.close();
  });

  it("recovers Human Review notifications for an already-running direct Herdr turn", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task", creatorOpenId: "operator" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", paneToken: "p001", lastAgentState: "blocked", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    const startedAt = "2026-09-30T07:00:00.000Z";
    const view = createQueuedRunCard({ promptId: "external-blocked", bindingId: "b1", title: "Direct", workspaceId: "w1", paneId: "w1:p1", requestText: "direct blocked task", queuePosition: 0, occurredAt: startedAt });
    expect(store.adoptExternalTurn({
      bindingId: "b1", expectedGeneration: 1, expectedPaneId: "w1:p1",
      expectedSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" },
      turnId: "turn-blocked", startedAt, requestText: "direct blocked task", externalPromptId: "external-blocked",
      externalMessageId: "herdr-turn:session-1:turn-blocked", externalView: view, answerCardFor: () => ({})
    }).outcome).toBe("created_external");
    const wake = vi.fn();
    const cursor = { async readDelta() { return ""; }, async readObservation() { return { answerDelta: "" }; } };
    const observer = createExternalTurnObserver({
      store, transcriptReader: { open: vi.fn(async () => ({ mode: "typed" as const, cursor })) }, bus: new BridgeEventBus(),
      outboundWork: { wake }, logger: pino({ enabled: false }), presentation: primaryPresentation, wakePrompt: vi.fn()
    });

    await observer.observe(store.getBinding("b1")!);
    const reviewCreate = store.listPendingOutboundReplies().find(({ idempotencyKey, kind }) => idempotencyKey.startsWith("human-review:primary:") && kind === "card_reply")!;
    expect(reviewCreate).toBeDefined();
    expect(store.markOutboundReplyDelivered(reviewCreate.id, "review-message", "review-card")).toBe(true);
    expect(wake).toHaveBeenCalled();

    store.updateBinding("b1", { lastAgentState: "working" });
    await observer.observe(store.getBinding("b1")!);
    expect(store.listPendingOutboundReplies()).toContainEqual(expect.objectContaining({
      kind: "card_update", rootMessageId: "review-message", idempotencyKey: expect.stringMatching(/^human-review:primary:.*:revision:2$/)
    }));
    expect(store.database.prepare("SELECT state FROM primary_human_review_episodes").all()).toEqual([{ state: "resolved" }]);

    await observer.stop();
    store.close();
  });

  it("repairs a detached Herdr Prompt from exact already-projected terminal evidence without reopening Core", async () => {
    const stores = createTestStoreBundle(":memory:");
    stores.driver.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task", creatorOpenId: "ou_creator" });
    stores.driver.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    const startedAt = "2026-09-30T06:00:00.000Z";
    const promptId = nativeTurnPromptId({ bindingId: "b1", bindingGeneration: 1, paneId: "w1:p1", nativeSessionId: "session-1", turnId: "turn-projected", startedAt });
    const view = createQueuedRunCard({ promptId: "external-projected", bindingId: "b1", title: "Direct", workspaceId: "w1", paneId: "w1:p1", requestText: "direct task", queuePosition: 0, occurredAt: startedAt });
    expect(stores.externalTurns.adoptExternalTurn({
      bindingId: "b1", expectedGeneration: 1, expectedPaneId: "w1:p1",
      expectedSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" },
      turnId: "turn-projected", startedAt, requestText: "direct task", externalPromptId: "external-projected",
      externalMessageId: "herdr-turn:session-1:turn-projected", externalView: view, answerCardFor: () => ({})
    }).outcome).toBe("created_external");
    stores.promptRecovery.markPromptObservationDetached(promptId, "restart");

    const events: CoreEventEnvelope[] = [
      { schemaVersion: 1, eventId: "projected-start", cursor: "c1", sourceId: "source-1", agentKind: "traex", sessionId: "session-1", turnId: "turn-projected", occurredAt: startedAt, payload: { type: "turn_started" } },
      { schemaVersion: 1, eventId: "projected-commentary", cursor: "c2", sourceId: "source-1", agentKind: "traex", sessionId: "session-1", turnId: "turn-projected", occurredAt: "2026-09-30T06:00:01.000Z", payload: { type: "message", message_id: "commentary-1", channel: "commentary", text: "```herdr-choice-list\n{\"version\":3,\"choice\":{\"question\":\"Continue?\",\"defaultOption\":{\"id\":\"continue\",\"label\":\"Continue\",\"submitText\":\"Continue\"},\"alternatives\":[]}}\n```", truncated: false } },
      { schemaVersion: 1, eventId: "projected-final", cursor: "c3", sourceId: "source-1", agentKind: "traex", sessionId: "session-1", turnId: "turn-projected", occurredAt: "2026-09-30T06:00:02.000Z", payload: { type: "message", message_id: "final-1", channel: "final", text: "durable final answer", truncated: false } },
      { schemaVersion: 1, eventId: "projected-terminal", cursor: "c4", sourceId: "source-1", agentKind: "traex", sessionId: "session-1", turnId: "turn-projected", occurredAt: "2026-09-30T06:00:03.000Z", payload: { type: "turn_completed" } }
    ];
    stores.coreEvents.ingestBatch({ laneId: "lane-projected", sourceId: "source-1", agentKind: "traex", sessionId: "session-1", afterCursor: "start", nextCursor: "c4", latestCursor: "c4", events, ingestedAt: "2026-09-30T06:00:04.000Z" });
    stores.coreEvents.acknowledge("lane-projected", events.map(({ eventId }) => eventId), "projected", "2026-09-30T06:00:05.000Z", undefined, { kind: "binding", id: "b1" });
    const openAtTurn = vi.fn(async () => { throw new Error("projected evidence must be repaired before Core is reopened"); });
    const bus = new BridgeEventBus();
    const terminalEvents: string[] = [];
    bus.onBridgeEvent("capture", (event) => { if (event.type === "TurnCompleted" || event.type === "TurnFailed") terminalEvents.push(event.type); });
    const wakePrompt = vi.fn();
    const outboundWake = vi.fn();
    const observer = createExternalTurnObserver({
      store: stores.externalTurns, transcriptReader: { open: openAtTurn, openAtTurn }, bus,
      outboundWork: { wake: outboundWake }, logger: pino({ enabled: false }), presentation: primaryPresentation, wakePrompt
    });

    await observer.observe(stores.externalTurns.getBinding("b1")!);

    expect(openAtTurn).not.toHaveBeenCalled();
    expect(stores.externalTurns.getPrompt(promptId)).toMatchObject({ state: "delivered", observationState: "completed" });
    expect(stores.projection.loadRunCard(promptId)).toMatchObject({ phase: "completed", answer: "durable final answer" });
    expect(JSON.stringify(stores.projection.loadRunCard(promptId))).not.toContain("herdr-choice-list");
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM completion_choice_specifications WHERE owner_kind='primary-prompt' AND owner_id=?").get(promptId)).toEqual({ count: 1 });
    expect(stores.driver.database.prepare("SELECT state FROM core_event_lane_items WHERE lane_id = 'lane-projected' ORDER BY sequence").all()).toEqual([
      { state: "projected" }, { state: "projected" }, { state: "projected" }, { state: "projected" }
    ]);
    expect(stores.coreEvents.getCheckpoint("lane-projected")).toMatchObject({ readCursor: "c4" });
    const notifications = stores.driver.listPendingOutboundReplies().filter((reply) => reply.idempotencyKey.startsWith("primary-next-input:"));
    expect(notifications).toHaveLength(0);
    expect(stores.driver.database.prepare("SELECT state FROM completion_notification_obligations WHERE owner_kind = 'primary-prompt' AND owner_id = ?").get(promptId)).toEqual({ state: "waiting_for_answer" });
    expect(outboundWake).not.toHaveBeenCalled();
    expect(terminalEvents).toEqual(["TurnCompleted"]);
    expect(wakePrompt).toHaveBeenCalledWith("b1");
    expect(stores.externalTurns.repairProjectedExternalTurn({
      promptId, bindingId: "b1", expectedGeneration: 1, expectedPaneId: "w1:p1",
      expectedSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" },
      turnId: "turn-projected", startedAt, occurredAt: "2026-09-30T06:00:06.000Z"
    })).toEqual({ outcome: "stale" });
    expect(stores.driver.database.prepare("SELECT count(*) AS count FROM audit_log WHERE action = 'turn.recovery.projected_owner'").get()).toEqual({ count: 1 });

    await observer.stop();
    stores.lifecycle.close();
  });

  it.each([
    ["later none clears review", "none"],
    ["later review replaces none", "review"]
  ] as const)("uses Herdr lane sequence when %s despite conflicting timestamps and event IDs", (_name, latestIntent) => {
    const stores = createTestStoreBundle(":memory:");
    try {
      const earlier = latestIntent === "none"
        ? projectedHerdrMessage({ eventId: "z-earlier-review", cursor: "c2", occurredAt: "2026-09-30T06:09:00.000Z", channel: "commentary", text: projectedV3ReviewFence("Earlier review?", "earlier") })
        : projectedHerdrMessage({ eventId: "z-earlier-none", cursor: "c2", occurredAt: "2026-09-30T06:09:00.000Z", channel: "commentary", text: projectedV3NoneFence() });
      const later = latestIntent === "none"
        ? projectedHerdrMessage({ eventId: "a-later-none", cursor: "c3", occurredAt: "2026-09-30T06:03:00.000Z", channel: "commentary", text: projectedV3NoneFence() })
        : projectedHerdrMessage({ eventId: "a-later-review", cursor: "c3", occurredAt: "2026-09-30T06:03:00.000Z", channel: "commentary", text: projectedV3ReviewFence("Later review?", "later") });
      const prepared = prepareProjectedHerdrRepair(stores, [
        earlier,
        later,
        projectedHerdrMessage({ eventId: "m-plain-final", cursor: "c4", occurredAt: "2026-09-30T06:02:00.000Z", channel: "final", text: "lane ordered Herdr answer" })
      ]);
      const attemptCountBefore = stores.driver.database.prepare("SELECT attempt_count FROM prompt_jobs WHERE id=?").get(prepared.promptId);

      const result = stores.externalTurns.repairProjectedExternalTurn(projectedHerdrRepairInput(prepared));

      expect(result).toMatchObject({ outcome: "repaired", terminalState: "completed", answer: "lane ordered Herdr answer" });
      if (latestIntent === "none") {
        expect(result).toMatchObject({ completionActionEligibility: { outcome: "deferred" } });
        expect(stores.driver.database.prepare("SELECT question,default_option_id FROM completion_choice_specifications WHERE owner_kind='primary-prompt' AND owner_id=?").get(prepared.promptId)).toEqual({ question: "是否继续？", default_option_id: "continue" });
      } else {
        expect(result).toMatchObject({ completionActionEligibility: { outcome: "deferred" } });
        expect(stores.driver.database.prepare("SELECT question,default_option_id FROM completion_choice_specifications WHERE owner_kind='primary-prompt' AND owner_id=?").get(prepared.promptId)).toEqual({ question: "Later review?", default_option_id: "later" });
      }
      expect(stores.driver.database.prepare("SELECT attempt_count FROM prompt_jobs WHERE id=?").get(prepared.promptId)).toEqual(attemptCountBefore);
    } finally {
      stores.lifecycle.close();
    }
  });

  it("keeps valid native final choice authoritative over Herdr textual evidence", () => {
    const stores = createTestStoreBundle(":memory:");
    try {
      const prepared = prepareProjectedHerdrRepair(stores, [
        projectedHerdrMessage({ eventId: "text-review", cursor: "c2", occurredAt: "2026-09-30T06:00:01.000Z", channel: "commentary", text: projectedV3ReviewFence("Text review?", "text") }),
        projectedHerdrMessage({
          eventId: "native-final", cursor: "c3", occurredAt: "2026-09-30T06:00:02.000Z", channel: "final", text: "native Herdr answer",
          completionChoice: { version: 2, intent: "human_review", question: "Native review?", default: "native", options: [{ id: "native", label: "Native", message: "default" }] }
        })
      ]);

      expect(stores.externalTurns.repairProjectedExternalTurn(projectedHerdrRepairInput(prepared))).toMatchObject({
        outcome: "repaired", answer: "native Herdr answer", completionActionEligibility: { outcome: "deferred" }
      });
      expect(stores.driver.database.prepare("SELECT question,default_option_id FROM completion_choice_specifications WHERE owner_kind='primary-prompt' AND owner_id=?").get(prepared.promptId)).toEqual({
        question: "Native review?", default_option_id: "native"
      });
    } finally {
      stores.lifecycle.close();
    }
  });

  it.each([
    ["null", null],
    ["text scalar", JSON.stringify({ version: 2, intent: "human_review", question: "Wrapped?", default: "wrapped", options: [{ id: "wrapped", label: "Wrapped", message: "default" }] })],
    ["number", 3],
    ["boolean", true],
    ["array", []],
    ["malformed object", { version: 2 }]
  ])("fails closed on present malformed Herdr native %s metadata without text fallback", (_label, malformedNative) => {
    const stores = createTestStoreBundle(":memory:");
    try {
      const prepared = prepareProjectedHerdrRepair(stores, [
        projectedHerdrMessage({ eventId: "fallback-review", cursor: "c2", occurredAt: "2026-09-30T06:00:01.000Z", channel: "commentary", text: projectedV3ReviewFence() }),
        projectedHerdrMessage({
          eventId: "malformed-native-final", cursor: "c3", occurredAt: "2026-09-30T06:00:02.000Z", channel: "final", text: "fail closed Herdr answer",
          completionChoice: { version: 2, intent: "human_review", question: "Temporary?", default: "temporary", options: [{ id: "temporary", label: "Temporary", message: "default" }] }
        })
      ]);
      rewritePersistedCompletionChoice(stores, "malformed-native-final", malformedNative);

      expect(stores.externalTurns.repairProjectedExternalTurn(projectedHerdrRepairInput(prepared))).toMatchObject({
        outcome: "repaired", answer: "fail closed Herdr answer",
        completionActionEligibility: { outcome: "skipped", reason: "no-review-choice" }
      });
      expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM completion_choice_specifications WHERE owner_kind='primary-prompt' AND owner_id=?").get(prepared.promptId)).toEqual({ count: 0 });
    } finally {
      stores.lifecycle.close();
    }
  });

  it("does not let v1, truncated, invalid, or oversized Herdr text create or clear a valid review", () => {
    const oversized = completeOversizedV3ReviewFence();
    expect(Buffer.byteLength(oversized, "utf8")).toBeGreaterThan(8_192);
    const excluded = [
      projectedHerdrMessage({ eventId: "v1-review", cursor: "c2", occurredAt: "2026-09-30T06:00:01.000Z", channel: "commentary", text: "```herdr-choice-list\n{\"version\":1,\"default\":\"legacy\",\"options\":[{\"id\":\"legacy\",\"label\":\"Legacy\",\"message\":\"default\"},{\"id\":\"other\",\"label\":\"Other\",\"message\":\"Other\"}]}\n```" }),
      projectedHerdrMessage({ eventId: "truncated-review", cursor: "c3", occurredAt: "2026-09-30T06:00:02.000Z", channel: "commentary", text: projectedV3ReviewFence("Truncated?", "truncated"), truncated: true }),
      projectedHerdrMessage({ eventId: "invalid-review", cursor: "c4", occurredAt: "2026-09-30T06:00:03.000Z", channel: "commentary", text: "```herdr-choice-list\n{\"version\":3,\"choice\":{}}\n```" }),
      projectedHerdrMessage({ eventId: "oversized-review", cursor: "c5", occurredAt: "2026-09-30T06:00:04.000Z", channel: "commentary", text: oversized })
    ];

    const excludedOnly = createTestStoreBundle(":memory:");
    try {
      const prepared = prepareProjectedHerdrRepair(excludedOnly, [
        ...excluded,
        projectedHerdrMessage({ eventId: "excluded-final", cursor: "c6", occurredAt: "2026-09-30T06:00:05.000Z", channel: "final", text: "excluded Herdr answer" })
      ]);
      expect(excludedOnly.externalTurns.repairProjectedExternalTurn(projectedHerdrRepairInput(prepared))).toMatchObject({ completionActionEligibility: { outcome: "skipped", reason: "no-review-choice" } });
      expect(excludedOnly.driver.database.prepare("SELECT COUNT(*) AS count FROM completion_choice_specifications WHERE owner_kind='primary-prompt' AND owner_id=?").get(prepared.promptId)).toEqual({ count: 0 });
    } finally {
      excludedOnly.lifecycle.close();
    }

    const retained = createTestStoreBundle(":memory:");
    try {
      const prepared = prepareProjectedHerdrRepair(retained, [
        projectedHerdrMessage({ eventId: "valid-review", cursor: "c2", occurredAt: "2026-09-30T06:00:00.500Z", channel: "commentary", text: projectedV3ReviewFence("Retained Herdr review?", "retained") }),
        ...excluded.map((event, index) => ({ ...event, eventId: `retained-${event.eventId}`, cursor: `c${index + 3}` })),
        projectedHerdrMessage({ eventId: "retained-final", cursor: "c7", occurredAt: "2026-09-30T06:00:05.000Z", channel: "final", text: "retained Herdr answer" })
      ]);
      expect(retained.externalTurns.repairProjectedExternalTurn(projectedHerdrRepairInput(prepared))).toMatchObject({ completionActionEligibility: { outcome: "deferred" } });
      expect(retained.driver.database.prepare("SELECT question,default_option_id FROM completion_choice_specifications WHERE owner_kind='primary-prompt' AND owner_id=?").get(prepared.promptId)).toEqual({
        question: "Retained Herdr review?", default_option_id: "retained"
      });
    } finally {
      retained.lifecycle.close();
    }
  });

  it("fails ambiguous without settling or replay when persisted legacy evidence assigns a Herdr terminal to two lanes", () => {
    const stores = createTestStoreBundle(":memory:");
    try {
      const prepared = prepareProjectedHerdrRepair(stores, [
        projectedHerdrMessage({ eventId: "plain-final", cursor: "c2", occurredAt: "2026-09-30T06:00:02.000Z", channel: "final", text: "ambiguous Herdr answer" })
      ]);
      const attemptCountBefore = stores.driver.database.prepare("SELECT attempt_count FROM prompt_jobs WHERE id=?").get(prepared.promptId);
      stores.driver.database.prepare(`INSERT INTO core_event_lane_items(
        lane_id,event_id,sequence,state,created_at,updated_at
      ) VALUES (?,?,1,'projected',?,?)`).run(
        "lane-projected-duplicate", prepared.terminal.eventId,
        "2026-09-30T06:00:05.500Z", "2026-09-30T06:00:05.600Z"
      );

      expect(stores.externalTurns.repairProjectedExternalTurn(projectedHerdrRepairInput(prepared))).toEqual({ outcome: "ambiguous" });
      expect(stores.externalTurns.getPrompt(prepared.promptId)).toMatchObject({ state: "running", observationState: "detached" });
      expect(stores.driver.database.prepare("SELECT attempt_count FROM prompt_jobs WHERE id=?").get(prepared.promptId)).toEqual(attemptCountBefore);
      expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM completion_choice_specifications WHERE owner_kind='primary-prompt' AND owner_id=?").get(prepared.promptId)).toEqual({ count: 0 });
      expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='turn.recovery.projected_owner'").get()).toEqual({ count: 0 });
    } finally {
      stores.lifecycle.close();
    }
  });

  it("opens then drains an active local turn immediately when periodic observation starts in a fresh process", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    const identity: ConversationTurnIdentity = {
      agentKind: "traex",
      sessionId: "session-1",
      turnId: "turn-startup",
      startedAt: "2026-09-28T10:29:31.096Z"
    };
    const observations: AgentTranscriptObservation[] = [
      { turnId: "turn-startup", freshTurnStart: true, requestText: "started before observer lifecycle", answerDelta: "", turnLifecycle: { turnId: "turn-startup", state: "active", startedAt: "2026-09-28T10:29:31.096Z" } },
      { turnId: "turn-startup", answerDelta: "local answer", turnLifecycle: { turnId: "turn-startup", state: "active", startedAt: "2026-09-28T10:29:31.096Z" } },
      { turnId: "turn-startup", answerDelta: "", turnLifecycle: { turnId: "turn-startup", state: "completed", startedAt: "2026-09-28T10:29:31.096Z", finalAnswer: "local answer" } },
      { answerDelta: "" }
    ];
    const cursor = { async readDelta() { return ""; }, async readObservation() { return observations.shift() ?? { answerDelta: "" }; } };
    const observer = createExternalTurnObserver({
      store, transcriptReader: { openActiveTurn: vi.fn(async () => ({ mode: "typed" as const, cursor })) }, bus: new BridgeEventBus(),
      outboundWork: { wake() {} }, logger: pino({ enabled: false }), presentation: primaryPresentation, wakePrompt: vi.fn(), idFactory: () => "external-startup"
    });

    observer.start(60_000);

    await vi.waitFor(() => expect(loadConversationTurnView(store, identity)).toMatchObject({ phase: "completed", answer: "local answer" }));
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM prompt_jobs").get()).toEqual({ count: 0 });
    expect(store.getPrompt("external-startup")).toBeNull();
    await observer.stop();
    store.close();
  });

  it("converges both Primary cards from one direct Herdr turn after a pane hint", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", paneToken: "yx0c", statusMessageId: "main-1", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    store.saveTopicView({ ...initialTopicView("b1"), title: "Task", workspaceId: "w1", spaceName: "repo", paneId: "w1:p1", phase: "ready", agentState: "idle" });
    const observations: AgentTranscriptObservation[] = [
      { turnId: "turn-1", freshTurnStart: true, requestText: "direct request", answerDelta: "direct answer", timelineDeltas: [{ kind: "agent_message", id: "message:direct-answer", sequence: 1, markdown: "direct answer" }], mainStatus: { statusTitle: "Working directly", tokenCount: 42 }, turnLifecycle: { turnId: "turn-1", state: "active", startedAt: "2026-09-12T00:00:00.000Z" } },
      { turnId: "turn-1", answerDelta: "", turnLifecycle: { turnId: "turn-1", state: "completed", startedAt: "2026-09-12T00:00:00.000Z", finalAnswer: "direct answer" } },
      { answerDelta: "" }
    ];
    const identity: ConversationTurnIdentity = {
      agentKind: "traex",
      sessionId: "session-1",
      turnId: "turn-1",
      startedAt: "2026-09-12T00:00:00.000Z"
    };
    const cursor = { async readDelta() { return ""; }, async readObservation() { return observations.shift() ?? { answerDelta: "" }; } };
    const transcriptReader = { open: vi.fn(async () => ({ mode: "typed" as const, cursor })), openActiveTurn: vi.fn(async () => ({ mode: "typed" as const, cursor })) };
    const mainUpdates: object[] = [];
    const answerUpdates: string[] = [];
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "topic", rootMessageId: "root" }; },
      async replyText() { return { messageId: "text" }; },
      async replyCard() { return { messageId: "card" }; },
      async replyStreamingCard() { return { messageId: "answer-1", cardId: "cardkit-1" }; },
      async streamCardContent(_cardId, _elementId, content) { answerUpdates.push(content); },
      async finishStreamingCard() {},
      async updateCard(messageId, card) { if (messageId === "main-1") mainUpdates.push(card); else if (messageId === "answer-1") answerUpdates.push(JSON.stringify(card)); },
      async shareThread() { return { messageId: "shared" }; }
    };
    const logger = pino({ enabled: false });
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, logger);
    const stopPublisher = publisher.start();
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, logger, primaryPresentation, undefined, undefined, { cardUpdateDebounceMs: 0, mainCardUpdateDebounceMs: 0 });
    const stopProjector = projector.start();
    const observer = createExternalTurnObserver({ store, transcriptReader, bus, outboundWork: { wake() { void publisher.requestScan(); } }, logger, presentation: primaryPresentation, isBindingBusy: () => false, wakePrompt() {}, projects: [{ id: "repo", displayName: "Repo", spaceName: "herdr-agent-swarm", description: "Repo", workspaceId: "w1", cwd: "/repo" }], idFactory: () => "external-1" });
    const binding = store.getBinding("b1")!;
    const router = new HerdrEventRouter({
      invalidateAll: vi.fn(),
      invalidateWorkspace() {}, invalidatePanes() {}, reconcileBindings: () => observer.observe(binding), reconcileInstances: async () => {},
      observePrimaryTurns: (paneIds) => paneIds ? observer.observeByPane(paneIds) : observer.scanActiveBindings(),
      observeInstanceTurns: async () => {}, retryRetiredPanes: async () => {}, logger
    });

    await router.handle({ kind: "agent-status", scope: "panes", workspaceIds: ["w1"], paneIds: ["w1:p1"] });

    expect(transcriptReader.openActiveTurn).toHaveBeenCalledOnce();
    expect(transcriptReader.open).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(loadConversationTurnView(store, identity)).toMatchObject({ phase: "completed", answer: "direct answer" }));
    await vi.waitFor(() => expect(mainUpdates.some((card) => JSON.stringify(card).includes("direct answer"))).toBe(true));
    expect(loadConversationTurnView(store, identity)).toMatchObject({ phase: "completed", answer: "direct answer", spaceName: "repo", paneToken: "yx0c" });
    expect(loadConversationTurnView(store, identity)?.timelineItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "final_answer", markdown: "direct answer" })
    ]));
    expect(store.loadTopicView("b1")).toMatchObject({ answer: "direct answer" });
    expect(store.listRunCards("b1")).toHaveLength(0);
    const deliveryCount = store.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies").get() as { count: number };
    await router.handle({ kind: "agent-status", scope: "panes", workspaceIds: ["w1"], paneIds: ["w1:p1"] });
    expect(store.listRunCards("b1")).toHaveLength(0);
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies").get()).toEqual(deliveryCount);

    await observer.stop(); await projector.stop(); stopProjector(); stopPublisher(); await publisher.stop(); store.close();
  });

  it("keeps a bounded long direct Herdr answer in its unified segment", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", statusMessageId: "main-1", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    store.saveTopicView({ ...initialTopicView("b1"), title: "Task", workspaceId: "w1", spaceName: "repo", paneId: "w1:p1", phase: "ready", agentState: "idle" });
    const answer = Array.from({ length: 1_500 }, (_, index) => `Herdr direct answer segment ${index}`).join("\n");
    const identity: ConversationTurnIdentity = {
      agentKind: "traex",
      sessionId: "session-1",
      turnId: "turn-long",
      startedAt: "2026-09-24T00:00:00.000Z"
    };
    const observations: AgentTranscriptObservation[] = [
      { turnId: "turn-long", freshTurnStart: true, requestText: "direct long request", answerDelta: answer, timelineDeltas: [{ kind: "agent_message", id: "message:long-answer", sequence: 1, markdown: answer }], turnLifecycle: { turnId: "turn-long", state: "active", startedAt: "2026-09-24T00:00:00.000Z" } },
      { turnId: "turn-long", answerDelta: "", turnLifecycle: { turnId: "turn-long", state: "completed", startedAt: "2026-09-24T00:00:00.000Z", finalAnswer: answer } },
      { answerDelta: "" }
    ];
    const cursor = { async readDelta() { return ""; }, async readObservation() { return observations.shift() ?? { answerDelta: "" }; } };
    const transcriptReader = { open: vi.fn(async () => ({ mode: "typed" as const, cursor })) };
    const createdMessages: string[] = [];
    const mainUpdates: object[] = [];
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "topic", rootMessageId: "root" }; },
      async replyText() { return { messageId: "text" }; },
      async replyCard() { return { messageId: "card" }; },
      async replyStreamingCard() {
        const page = createdMessages.length + 1;
        const messageId = `answer-${page}`;
        createdMessages.push(messageId);
        return { messageId, cardId: `cardkit-${page}` };
      },
      async streamCardContent() {},
      async finishStreamingCard() {},
      async updateCard(messageId, card) { if (messageId === "main-1") mainUpdates.push(card); },
      async shareThread() { return { messageId: "shared" }; }
    };
    const logger = pino({ enabled: false });
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, logger);
    const stopPublisher = publisher.start();
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, logger, primaryPresentation, undefined, undefined, { cardUpdateDebounceMs: 0, mainCardUpdateDebounceMs: 0 });
    const stopProjector = projector.start();
    const observer = createExternalTurnObserver({ store, transcriptReader, bus, outboundWork: { wake() { void publisher.requestScan(); } }, logger, presentation: primaryPresentation, isBindingBusy: () => false, wakePrompt() {}, idFactory: () => "external-long" });

    await observer.observe(store.getBinding("b1")!);
    await observer.observe(store.getBinding("b1")!);
    await vi.waitFor(() => expect(loadConversationTurnView(store, identity)).toMatchObject({ phase: "completed", answer }));
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM conversation_turn_projections").get()).toEqual({ count: 0 });
    expect(store.database.prepare(`SELECT COUNT(*) AS count FROM conversation_segment_pages p
      JOIN conversation_segments s ON s.id=p.segment_id WHERE s.session_id=?`).get(identity.sessionId)).toEqual({ count: 1 });
    expect(loadConversationTurnView(store, identity)!.timelineItems
      .filter((item) => "markdown" in item)
      .every((item) => item.markdown.length <= MAX_TURN_OUTPUT_CHARS)).toBe(true);
    await vi.waitFor(() => expect(mainUpdates.length).toBeGreaterThan(0));

    await observer.stop(); await projector.stop(); stopProjector(); stopPublisher(); await publisher.stop(); store.close();
  });

  it("opens only the active binding attached to a targeted Pane", async () => {
    const store = new SqliteBindingStore(":memory:");
    for (const [id, paneId] of [["b1", "w1:p1"], ["b2", "w1:p2"]]) {
      store.createPendingBinding({ id, workspaceId: "w1", chatId: "c1", topicId: `t-${id}`, rootMessageId: `root-${id}`, title: id });
      store.updateBinding(id, { state: "active", lifecycle: "active", attachment: "attached", paneId, agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: `session-${id}` });
    }
    const open = vi.fn(async () => ({ mode: "typed" as const, cursor: { async readDelta() { return ""; } } }));
    const observer = createExternalTurnObserver({ store, transcriptReader: { open }, bus: new BridgeEventBus(), outboundWork: { wake() {} }, logger: pino({ enabled: false }), presentation: primaryPresentation, isBindingBusy: () => false, wakePrompt() {} });

    await observer.observeByPane(["w1:p2"]);

    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ nativeSession: expect.objectContaining({ value: "session-b2" }) }));
    await observer.stop();
    store.close();
  });

  it("keeps a pending turn start across reads and projects a direct Herdr turn to completion", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", generation: 2, paneId: "w1:p1", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    const observations: AgentTranscriptObservation[] = [
      { turnId: "turn-1", freshTurnStart: true, answerDelta: "", turnLifecycle: { turnId: "turn-1", state: "active", startedAt: "2026-08-31T10:00:00.000Z" } },
      { turnId: "turn-1", requestText: "direct task", answerDelta: "", turnLifecycle: { turnId: "turn-1", state: "active", startedAt: "2026-08-31T10:00:00.000Z" } },
      { turnId: "turn-1", answerDelta: "answer", turnLifecycle: { turnId: "turn-1", state: "active", startedAt: "2026-08-31T10:00:00.000Z" } },
      { turnId: "turn-1", answerDelta: "", turnLifecycle: { turnId: "turn-1", state: "completed", startedAt: "2026-08-31T10:00:00.000Z", finalAnswer: withHumanReviewChoice("answer") } },
      { answerDelta: "" }
    ];
    const cursor = { async readDelta() { return ""; }, async readObservation() { return observations.shift() ?? { answerDelta: "" }; } };
    const transcriptReader = { open: vi.fn(async () => ({ mode: "typed" as const, cursor })) };
    const bus = new BridgeEventBus();
    const events: string[] = [];
    bus.onBridgeEvent("capture", (event) => { events.push(event.type); });
    const wake = vi.fn();
    const identity: ConversationTurnIdentity = {
      agentKind: "traex",
      sessionId: "session-1",
      turnId: "turn-1",
      startedAt: "2026-08-31T10:00:00.000Z"
    };
    const observer = createExternalTurnObserver({ store, transcriptReader, bus, outboundWork: { wake }, logger: pino({ enabled: false }), presentation: primaryPresentation, isBindingBusy: () => false, wakePrompt() {}, idFactory: () => "external-1" });

    await observer.observe(store.getBinding("b1")!);
    expect(loadConversationTurnView(store, identity)).toBeNull();
    await observer.observe(store.getBinding("b1")!);

    expect(loadConversationTurnView(store, identity)).toMatchObject({ phase: "completed", answer: "answer" });
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM prompt_jobs").get()).toEqual({ count: 0 });
    expect(events).toEqual([]);
    expect(wake).toHaveBeenCalled();
    store.close();
  });

  it("projects an active local turn only from exact canonical Human evidence", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    const observations: AgentTranscriptObservation[] = [
      { turnId: "turn-local", freshTurnStart: true, requestText: "Start directly in Herdr", answerDelta: "", timelineDeltas: [{ kind: "agent_message", id: "message:progress", sequence: 1, markdown: "Inspecting" }, { kind: "human_message", id: "human:follow-up", sequence: 2, markdown: "Please keep going" }], turnLifecycle: { turnId: "turn-local", state: "active", startedAt: "2026-09-28T10:00:00.000Z" } },
      { turnId: "turn-local", answerDelta: "", turnLifecycle: { turnId: "turn-local", state: "completed", startedAt: "2026-09-28T10:00:00.000Z", finalAnswer: "Done" } },
      { answerDelta: "" }
    ];
    const bus = new BridgeEventBus();
    const projected: string[] = [];
    bus.onBridgeEvent("capture", (event) => { if (event.type === "TurnOutputObserved") projected.push(JSON.stringify(event.payload)); });
    const wakePrompt = vi.fn();
    const identity: ConversationTurnIdentity = {
      agentKind: "traex",
      sessionId: "session-1",
      turnId: "turn-local",
      startedAt: "2026-09-28T10:00:00.000Z"
    };
    const observer = createExternalTurnObserver({
      store, transcriptReader: { open: async () => ({ mode: "typed" as const, cursor: { async readDelta() { return ""; }, async readObservation() { return observations.shift() ?? { answerDelta: "" }; } } }) },
      bus, outboundWork: { wake() {} }, logger: pino({ enabled: false }), presentation: primaryPresentation, isBindingBusy: () => false, wakePrompt, idFactory: () => "external-local"
    });

    await observer.handoff("b1");

    expect(loadConversationTurnView(store, identity)).toMatchObject({ phase: "completed", answer: "Done" });
    expect(loadConversationTurnView(store, identity)?.timelineItems).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "human:follow-up" })])
    );
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM prompt_jobs").get()).toEqual({ count: 0 });
    expect(projected).toHaveLength(0);
    expect(wakePrompt).not.toHaveBeenCalled();
    await observer.stop();
    store.close();
  });

  it("immediately continues after an eight-observation page while more Core work remains", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    const startedAt = "2026-10-07T00:00:00.000Z";
    const observations: AgentTranscriptObservation[] = [
      { turnId: "turn-many", freshTurnStart: true, requestText: "drain all pages", answerDelta: "", turnLifecycle: { turnId: "turn-many", state: "active", startedAt } },
      ...Array.from({ length: 8 }, (_, index) => ({ turnId: "turn-many", answerDelta: `chunk-${index + 1}` })),
      { turnId: "turn-many", answerDelta: "", turnLifecycle: { turnId: "turn-many", state: "completed" as const, startedAt, finalAnswer: "done after page two" } },
      { answerDelta: "" }
    ];
    const readObservation = vi.fn(async () => observations.shift() ?? { answerDelta: "" });
    const observer = createExternalTurnObserver({
      store,
      transcriptReader: { open: async () => ({ mode: "typed" as const, cursor: { async readDelta() { return ""; }, readObservation } }) },
      bus: new BridgeEventBus(), outboundWork: { wake() {} }, logger: pino({ enabled: false }), presentation: primaryPresentation, wakePrompt() {}
    });

    await observer.handoff("b1");

    expect(readObservation).toHaveBeenCalledTimes(11);
    expect(store.database.prepare("SELECT state FROM conversation_segments WHERE session_id='session-1'").get()).toEqual({ state: "completed" });
    await observer.stop();
    store.close();
  });

  it("projects a native queued submission into its existing Feishu Answer", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", {
      state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", lastAgentState: "idle",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1"
    });
    for (const promptId of ["p1", "p2"] as const) {
      const view = createQueuedRunCard({ promptId, bindingId: "b1", title: promptId, workspaceId: "w1", paneId: "w1:p1", requestText: promptId, queuePosition: 1, occurredAt: "2026-09-28T15:00:00.000Z" });
      store.acceptPrompt({ prompt: { id: promptId, bindingId: "b1", larkMessageId: `m-${promptId}`, actorOpenId: "u1", body: promptId }, view, rootMessageId: "root", answerCard: {} });
      stageHistoricalNativeSubmission(store, promptId, `2026-09-28T15:00:0${promptId === "p1" ? "1" : "2"}.000Z`);
    }
    const observations: AgentTranscriptObservation[] = [
      { turnId: "turn-2", freshTurnStart: true, requestText: "p2", requestSubmissionId: "p2", answerDelta: "answer", turnLifecycle: { turnId: "turn-2", state: "active", startedAt: "2026-09-28T15:00:03.000Z" } },
      { turnId: "turn-2", answerDelta: "", turnLifecycle: { turnId: "turn-2", state: "completed", startedAt: "2026-09-28T15:00:03.000Z", finalAnswer: "answer" } },
      { answerDelta: "" }
    ];
    const wakePrompt = vi.fn();
    const publisher = createTestPublisher(store, noOpLark(), pino({ enabled: false }));
    const observer = createExternalTurnObserver({
      store, transcriptReader: { open: async () => ({ mode: "typed" as const, cursor: { async readDelta() { return ""; }, async readObservation() { return observations.shift() ?? { answerDelta: "" }; } } }) },
      bus: new BridgeEventBus(), outboundWork: { wake() {} }, logger: pino({ enabled: false }), presentation: primaryPresentation, wakePrompt, idFactory: () => "external-should-not-exist"
    });

    await publisher.drain();
    await observer.handoff("b1");

    expect(store.getPrompt("p2")).toMatchObject({ state: "delivered", observationState: "completed", transcriptTurnId: "turn-2", nativeSubmissionId: "p2" });
    expect(store.loadRunCard("p2")).toMatchObject({ phase: "completed", answer: "answer" });
    expect(store.getPrompt("p1")).toMatchObject({ state: "recovering", observationState: "detached", transcriptTurnId: null, nativeSubmissionId: "p1" });
    expect(store.getPrompt("external-should-not-exist")).toBeNull();
    expect(store.listRunCards("b1")).toHaveLength(2);
    expect(wakePrompt).toHaveBeenCalledWith("b1");
    await observer.stop();
    await publisher.stop();
    store.close();
  });

  it("adopts a later exact Bridge submission after its turn start was settled by a previous cursor", async () => {
    const stores = createTestStoreBundle(":memory:");
    stores.driver.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    stores.driver.updateBinding("b1", {
      state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", lastAgentState: "idle",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1"
    });
    for (const promptId of ["stale", "exact"] as const) {
      const view = createQueuedRunCard({ promptId, bindingId: "b1", title: promptId, workspaceId: "w1", paneId: "w1:p1", requestText: promptId, queuePosition: 1, occurredAt: "2026-10-01T10:04:47.000Z" });
      stores.driver.acceptPrompt({ prompt: { id: promptId, bindingId: "b1", larkMessageId: `m-${promptId}`, actorOpenId: "u1", body: promptId }, view, rootMessageId: "root", answerCard: primaryPresentation.answerCard(view) });
      stageHistoricalNativeSubmission(stores.driver, promptId, "2026-10-01T10:04:48.000Z");
    }
    const followingView = createQueuedRunCard({ promptId: "following", bindingId: "b1", title: "following", workspaceId: "w1", paneId: "w1:p1", requestText: "following", queuePosition: 1, occurredAt: "2026-10-01T10:04:49.000Z" });
    stores.driver.acceptPrompt({ prompt: { id: "following", bindingId: "b1", larkMessageId: "m-following", actorOpenId: "u1", body: "following" }, view: followingView, rootMessageId: "root", answerCard: primaryPresentation.answerCard(followingView) });
    const answerCreate = stores.driver.listPendingOutboundReplies().find((reply) => reply.promptId === "exact" && reply.kind === "stream_card_create")!;
    stores.driver.markOutboundReplyDelivered(answerCreate.id, "answer-exact", "cardkit-exact");
    const events: CoreEventEnvelope[] = [
      { schemaVersion: 1, eventId: "split-start", cursor: "c1", sourceId: "source-1", agentKind: "traex", sessionId: "session-1", turnId: "turn-exact", occurredAt: "2026-10-01T10:04:48.568Z", payload: { type: "turn_started" } },
      { schemaVersion: 1, eventId: "split-human", cursor: "c2", sourceId: "source-1", agentKind: "traex", sessionId: "session-1", turnId: "turn-exact", occurredAt: "2026-10-01T10:04:48.700Z", payload: { type: "human_message", message_id: "human-exact", text: "exact", truncated: false, submission_id: "exact" } },
      { schemaVersion: 1, eventId: "split-final", cursor: "c3", sourceId: "source-1", agentKind: "traex", sessionId: "session-1", turnId: "turn-exact", occurredAt: "2026-10-01T10:04:56.242Z", payload: { type: "message", message_id: "final-exact", channel: "final", text: "exact final answer", truncated: false } },
      { schemaVersion: 1, eventId: "split-completed", cursor: "c4", sourceId: "source-1", agentKind: "traex", sessionId: "session-1", turnId: "turn-exact", occurredAt: "2026-10-01T10:04:56.392Z", payload: { type: "turn_completed" } }
    ];
    stores.coreEvents.ingestBatch({ laneId: "lane-split", sourceId: "source-1", agentKind: "traex", sessionId: "session-1", afterCursor: "start", nextCursor: "c4", latestCursor: "c4", events, ingestedAt: "2026-10-01T10:04:57.000Z" });
    stores.coreEvents.acknowledge("lane-split", ["split-start"], "ignored", "2026-10-01T10:04:57.100Z", undefined, { kind: "binding", id: "b1" });

    const cursor = new HerdrEventCursor(
      async () => ({ events: [], nextCursor: "c4", latestCursor: "c4", complete: true }),
      "c4",
      [],
      { store: stores.coreEvents, laneId: "lane-split", sourceId: "source-1", agentKind: "traex", sessionId: "session-1", owner: { kind: "binding", id: "b1" } },
      true
    );
    const bus = new BridgeEventBus();
    const terminalEvents: string[] = [];
    bus.onBridgeEvent("capture-split", (event) => { if (event.type === "TurnCompleted" || event.type === "TurnFailed") terminalEvents.push(event.type); });
    const finishStreamingCard = vi.fn(async () => {});
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "topic", rootMessageId: "root" }; },
      async replyText() { return { messageId: "text" }; },
      async replyCard() { return { messageId: "card" }; },
      async replyStreamingCard() { return { messageId: "answer-created", cardId: "cardkit-created" }; },
      async streamCardContent() {},
      finishStreamingCard,
      async updateCard() {},
      async shareThread() { return { messageId: "shared" }; }
    };
    const logger = pino({ enabled: false });
    const publisher = createTestPublisher(ringPublisherStore(stores), lark, logger);
    const stopPublisher = publisher.start();
    const projector = new ConversationViewProjector(bus, stores.driver, publisher, publisher, logger, primaryPresentation, undefined, undefined, { cardUpdateDebounceMs: 0, mainCardUpdateDebounceMs: 0 });
    projector.start();
    const wakePrompt = vi.fn();
    const observer = createExternalTurnObserver({
      store: stores.externalTurns,
      transcriptReader: { openActiveTurn: vi.fn(async () => ({ mode: "typed" as const, cursor })) },
      bus,
      outboundWork: { wake() { void publisher.requestScan(); } },
      logger,
      presentation: primaryPresentation,
      wakePrompt
    });

    await observer.handoff("b1");

    expect(stores.externalTurns.getPrompt("exact")).toMatchObject({
      state: "delivered", observationState: "completed", transcriptTurnId: "turn-exact",
      transcriptTurnStartedAt: "2026-10-01T10:04:48.000Z", nativeSubmissionId: "exact"
    });
    expect(stores.projection.loadRunCard("exact")).toMatchObject({ phase: "completed", answer: "exact final answer" });
    expect(stores.externalTurns.getPrompt("stale")).toMatchObject({ state: "recovering", observationState: "detached", transcriptTurnId: null });
    expect(terminalEvents).toEqual(["TurnCompleted"]);
    expect(wakePrompt).toHaveBeenCalledWith("b1");
    await vi.waitFor(() => expect(finishStreamingCard).toHaveBeenCalledTimes(1));
    expect(stores.driver.claimNextDispatchablePrompt("b1")).toBeNull();
    expect(stores.driver.getPrompt("following")).toMatchObject({ state: "queued", observationState: "not_started" });
    expect(stores.driver.database.prepare("SELECT state FROM core_event_lane_items WHERE lane_id = 'lane-split' ORDER BY sequence").all()).toEqual([
      { state: "ignored" }, { state: "projected" }, { state: "projected" }, { state: "projected" }
    ]);

    await observer.stop();
    await projector.stop();
    stopPublisher();
    await publisher.stop();
    stores.lifecycle.close();
  });

  it("keeps observing when a direct Herdr turn follows a native submission and stale identity-less submissions", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", {
      state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", lastAgentState: "idle",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1"
    });
    for (const promptId of ["first", "stale"] as const) {
      const view = createQueuedRunCard({ promptId, bindingId: "b1", title: promptId, workspaceId: "w1", paneId: "w1:p1", requestText: promptId, queuePosition: 1, occurredAt: "2026-09-28T15:00:00.000Z" });
      store.acceptPrompt({ prompt: { id: promptId, bindingId: "b1", larkMessageId: `m-${promptId}`, actorOpenId: "u1", body: promptId }, view, rootMessageId: "root", answerCard: {} });
      stageHistoricalNativeSubmission(store, promptId, `2026-09-28T15:00:0${promptId === "first" ? "1" : "2"}.000Z`);
    }
    store.markPromptObservationDetached("stale", "observer lost before exact turn identity");
    const observations: AgentTranscriptObservation[] = [
      { turnId: "turn-first", freshTurnStart: true, requestText: "first", requestSubmissionId: "first", answerDelta: "first answer", turnLifecycle: { turnId: "turn-first", state: "completed", startedAt: "2026-09-28T15:00:03.000Z", finalAnswer: "first answer" } },
      { turnId: "turn-direct", freshTurnStart: true, requestText: "direct", answerDelta: "direct answer", timelineDeltas: [{ kind: "agent_message", id: "message:direct", sequence: 1, markdown: "direct answer" }], mainStatus: { statusTitle: "Direct work" }, turnLifecycle: { turnId: "turn-direct", state: "active", startedAt: "2026-09-28T15:00:04.000Z" } },
      { turnId: "turn-direct", answerDelta: "", turnLifecycle: { turnId: "turn-direct", state: "completed", startedAt: "2026-09-28T15:00:04.000Z", finalAnswer: "direct answer" } },
      { answerDelta: "" }
    ];
    const bus = new BridgeEventBus();
    const projectedPromptIds: string[] = [];
    bus.onBridgeEvent("capture", (event) => { if (event.type === "TurnOutputObserved") projectedPromptIds.push(event.payload.promptId); });
    const directIdentity: ConversationTurnIdentity = {
      agentKind: "traex",
      sessionId: "session-1",
      turnId: "turn-direct",
      startedAt: "2026-09-28T15:00:04.000Z"
    };
    const publisher = createTestPublisher(store, noOpLark(), pino({ enabled: false }));
    const observer = createExternalTurnObserver({
      store, transcriptReader: { open: async () => ({ mode: "typed" as const, cursor: { async readDelta() { return ""; }, async readObservation() { return observations.shift() ?? { answerDelta: "" }; } } }) },
      bus, outboundWork: { wake() {} }, logger: pino({ enabled: false }), presentation: primaryPresentation, wakePrompt() {}, idFactory: () => "external-direct"
    });

    await publisher.drain();
    await observer.handoff("b1");

    expect(store.getPrompt("first")).toMatchObject({ state: "delivered", observationState: "completed", transcriptTurnId: "turn-first" });
    expect(store.getPrompt("stale")).toMatchObject({ state: "recovering", observationState: "detached", transcriptTurnId: null });
    expect(loadConversationTurnView(store, directIdentity)).toMatchObject({ phase: "completed", answer: "direct answer" });
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM prompt_jobs WHERE execution_origin = 'herdr'").get()).toEqual({ count: 0 });
    expect(projectedPromptIds).not.toContain(expect.stringContaining("conversation-turn:"));
    await observer.stop();
    await publisher.stop();
    store.close();
  });

  it("recovers a persisted external turn from a terminal transcript baseline while the binding is busy after restart", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    const startedAt = "2026-08-31T10:00:00Z";
    const canonicalStartedAt = "2026-08-31T10:00:00.159Z";
    const promptId = nativeTurnPromptId({ bindingId: "b1", bindingGeneration: 1, paneId: "w1:p1", nativeSessionId: "session-1", turnId: "turn-1", startedAt });
    const canonicalPromptId = nativeTurnPromptId({ bindingId: "b1", bindingGeneration: 1, paneId: "w1:p1", nativeSessionId: "session-1", turnId: "turn-1", startedAt: canonicalStartedAt });
    const view = createQueuedRunCard({ promptId, bindingId: "b1", title: "Direct", workspaceId: "w1", paneId: "w1:p1", requestText: "direct task", queuePosition: 0, occurredAt: startedAt });
    store.adoptExternalTurn({
      bindingId: "b1", expectedGeneration: 1, expectedPaneId: "w1:p1",
      expectedSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" },
      turnId: "turn-1", startedAt, requestText: "direct task", externalPromptId: promptId,
      externalMessageId: "herdr-turn:session-1:turn-1", externalView: view, answerCardFor: () => ({})
    });
    const completed: AgentTranscriptObservation = {
      turnId: "turn-1", answerDelta: "",
      turnLifecycle: { turnId: "turn-1", state: "completed", startedAt: canonicalStartedAt, finalAnswer: "recovered answer" }
    };
    const wakePrompt = vi.fn();
    const open = vi.fn(async () => ({ mode: "typed" as const, cursor: { async readDelta() { return ""; }, async readObservation() { return { turnId: "later-turn", answerDelta: "", turnLifecycle: { turnId: "later-turn", state: "completed" as const, startedAt, finalAnswer: "later answer" } }; } } }));
    const openAtTurn = vi.fn(async () => ({
      mode: "typed" as const,
      recoveredIdentity: { turnId: "turn-1", canonicalStartedAt },
      cursor: { async readDelta() { return ""; }, async readObservation() { return completed; } }
    }));
    const observer = createExternalTurnObserver({
      store,
      transcriptReader: { open, openAtTurn },
      bus: new BridgeEventBus(), outboundWork: { wake() {} }, logger: pino({ enabled: false }), presentation: primaryPresentation, isBindingBusy: () => true, wakePrompt
    });

    await observer.observe(store.getBinding("b1")!);
    await observer.observe(store.getBinding("b1")!);

    expect(store.getPrompt(promptId)).toBeNull();
    expect(store.getPrompt(canonicalPromptId)).toMatchObject({ id: canonicalPromptId, state: "delivered", observationState: "completed" });
    expect(store.getPrompt(canonicalPromptId)?.transcriptTurnStartedAt).toBe(canonicalStartedAt);
    expect(store.database.prepare(`SELECT count(*) AS count FROM audit_log WHERE action = 'turn.recovery.canonical_start' AND target LIKE '%prompt:${canonicalPromptId}:%'`).get()).toEqual({ count: 1 });
    expect(store.loadRunCard(canonicalPromptId)).toMatchObject({ promptId: canonicalPromptId, phase: "completed", answer: "recovered answer" });
    expect(store.loadRunCard(promptId)).toBeNull();
    expect(open).not.toHaveBeenCalled();
    expect(openAtTurn).toHaveBeenCalledWith(expect.objectContaining({ nativeSession: expect.objectContaining({ value: "session-1" }) }), "turn-1", startedAt);
    expect(wakePrompt).toHaveBeenCalledWith("b1");
    await observer.stop();
    store.close();
  });

  it("repairs the 61-event incident snapshot atomically without resubmission", async () => {
    const stores = createTestStoreBundle(":memory:");
    stores.driver.createPendingBinding({
      id: "b1", projectId: "repo", workspaceId: "w1", chatId: "c1", topicId: "t1",
      rootMessageId: "root", title: "Recovery"
    });
    stores.driver.updateBinding("b1", {
      state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", lastAgentState: "unknown",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "01a1019d-e7b6-7141-9f75-bdba80bcbd8e"
    });
    const submissionId = "f98e75a4-c9be-4e65-837a-c9b6a4c70bc5";
    const sessionId = "01a1019d-e7b6-7141-9f75-bdba80bcbd8e";
    const turnId = "01a10222-a095-7953-a82d-d74624d63023";
    const requestedStartedAt = "2026-10-03T14:19:46.000Z";
    const canonicalStartedAt = "2026-10-03T14:19:46.214Z";
    const requestedPromptId = nativeTurnPromptId({
      bindingId: "b1", bindingGeneration: 1, paneId: "w1:p1", nativeSessionId: sessionId, turnId, startedAt: requestedStartedAt
    });
    const canonicalPromptId = nativeTurnPromptId({
      bindingId: "b1", bindingGeneration: 1, paneId: "w1:p1", nativeSessionId: sessionId, turnId, startedAt: canonicalStartedAt
    });
    const queued = createQueuedRunCard({
      promptId: requestedPromptId, bindingId: "b1", title: "Recovery", workspaceId: "w1", spaceName: "repo",
      paneId: "w1:p1", requestText: "repair me", queuePosition: 0, occurredAt: requestedStartedAt
    });
    const adopted = stores.driver.adoptExternalTurn({
      bindingId: "b1", expectedGeneration: 1, expectedPaneId: "w1:p1",
      expectedSession: { source: "herdr:traex", agent: "traex", kind: "id", value: sessionId },
      turnId, startedAt: requestedStartedAt, requestText: "repair me", externalPromptId: requestedPromptId,
      externalMessageId: submissionId, externalView: queued, answerCardFor: primaryPresentation.answerCard
    });
    expect(adopted.prompt?.id).toBe(requestedPromptId);
    stores.driver.markPromptObservationDetached(requestedPromptId, "restart during projection");
    expect(stores.driver.getPrompt(requestedPromptId)).toMatchObject({ observationState: "detached" });
    stores.driver.database.prepare(`UPDATE answer_pages
      SET message_id='frozen-message',card_id='frozen-card',element_id='frozen-element',state='frozen',updated_at=?
      WHERE prompt_id=? AND page_index=0`).run(requestedStartedAt, requestedPromptId);

    const event = (eventId: string, cursor: string, payload: CoreEventEnvelope["payload"]): CoreEventEnvelope => ({
      schemaVersion: 1, eventId, cursor,
      sourceId: cursor.startsWith("live:") ? "live-source" : "snapshot-source",
      agentKind: "traex", sessionId, turnId,
      occurredAt: payload.type === "turn_started" ? canonicalStartedAt : "2026-10-03T14:20:56.000Z",
      payload
    });
    const start = event("incident-00-start", "live:1", { type: "turn_started" });
    const human = event("incident-01-human", "snapshot:2", {
      type: "human_message", message_id: "incident-human", text: "continue task", truncated: false, submission_id: submissionId
    });
    const middle = Array.from({ length: 57 }, (_, index) => event(
      `incident-${String(index + 2).padStart(2, "0")}-assistant`,
      `snapshot:${index + 3}`,
      {
        type: "message", message_id: `incident-message-${index}`, channel: "assistant",
        text: `incident progress ${index}`, truncated: false
      }
    ));
    const answer = event("incident-59-final", "snapshot:60", {
      type: "message", message_id: "incident-final", channel: "final", text: "incident recovered answer", truncated: false
    });
    const completed = event("incident-60-completed", "live:2", { type: "turn_completed" });
    const incidentEvents = [start, human, ...middle, answer, completed];
    expect(incidentEvents).toHaveLength(61);
    stores.coreEvents.ingestBatch({
      laneId: "live-repair", sourceId: "live-source", agentKind: "traex", sessionId,
      afterCursor: "start", nextCursor: "live:2", latestCursor: "live:2",
      events: [start, completed], ingestedAt: "2026-10-01T10:04:57.000Z"
    });
    stores.coreEvents.acknowledge(
      "live-repair", [start.eventId, completed.eventId], "projected", "2026-10-01T10:04:57.100Z", undefined,
      { kind: "binding", id: "b1" }
    );
    expect(stores.turnSnapshots.stageAuthoritativeTurnSnapshotPage({
      identity: { agentKind: "traex", sessionId, turnId, requestedStartedAt },
      owner: { kind: "binding", id: "b1" },
      afterCursor: "",
      batch: {
        outcome: "recovered", canonicalStartedAt, nextCursor: "snapshot:61", complete: true,
        events: incidentEvents
      },
      observedAt: "2026-10-01T10:05:00.000Z"
    })).toMatchObject({ outcome: "ready" });

    const run = vi.fn(async (_executable: string, args: readonly string[]) => {
      if (args.includes("attach")) return coreEventResponse({
        type: "agent_events_attached", source_id: "source-1", attach_offset: 10,
        sources: [{
          source_id: "source-1", terminal_id: "terminal-1", agent_kind: "traex", session_id: sessionId,
          state: "active", checkpoint_offset: 10, latest_cursor: "c9"
        }]
      });
      if (args.includes("locate")) return coreEventResponse({
        type: "agent_events_turn_cursor", source_id: "source-1", found: false, after_cursor: "c9"
      });
      if (args.includes("capabilities")) return coreEventResponse({
        type: "agent_events_capabilities", exact_turn_recovery_v1: true,
        historical_turn_index_recovery_v1: true, session_turn_enumeration_v1: true
      });
      throw new Error(`unexpected Core command: ${args.join(" ")}`);
    });
    const transcriptReader = new HerdrEventsReader(
      new HerdrEventsAdapter({ run } as never, "herdr"),
      { async listAllPanes() { return [{ paneId: "w1:p1", terminalId: "terminal-1" } as never]; } },
      async () => ({ sessionId, path: "/tmp/session.jsonl" }),
      stores.coreEvents,
      {},
      stores.turnSnapshots
    );
    const ready = await transcriptReader.openAtTurn({
      agentKind: "traex", bindingId: "b1", generation: 1, paneId: "w1:p1",
      nativeSession: { source: "herdr:traex", agent: "traex", kind: "id", value: sessionId },
      coreEventOwner: { kind: "binding", id: "b1" }
    }, turnId, requestedStartedAt);
    if (ready.mode !== "typed" || !ready.cursor.readObservation) throw new Error(`expected authoritative snapshot cursor: ${JSON.stringify(ready)}`);
    const duplicateObservation = await ready.cursor.readObservation();
    expect(duplicateObservation).toMatchObject({
      turnId,
      turnLifecycle: { turnId, state: "completed", startedAt: canonicalStartedAt },
      authoritativeSnapshot: { requestedStartedAt, canonicalStartedAt }
    });

    const wake = vi.fn();
    const wakePrompt = vi.fn();
    const observer = createExternalTurnObserver({
      store: stores.driver,
      transcriptReader,
      bus: new BridgeEventBus(),
      outboundWork: { wake },
      logger: pino({ enabled: false }),
      presentation: primaryPresentation,
      wakePrompt
    });

    await observer.handoff("b1");

    expect(stores.driver.database.prepare(`SELECT applied_projection_id,applied_view_version FROM authoritative_turn_snapshots
      WHERE agent_kind='traex' AND session_id=? AND turn_id=? AND requested_started_at=?`).get(sessionId, turnId, requestedStartedAt))
      .toEqual({ applied_projection_id: canonicalPromptId, applied_view_version: expect.any(Number) });
    expect(stores.driver.getPrompt(requestedPromptId)).toBeNull();
    expect(stores.driver.getPrompt(canonicalPromptId)).toMatchObject({
      state: "delivered", observationState: "completed", transcriptTurnId: turnId,
      transcriptTurnStartedAt: canonicalStartedAt
    });
    expect(stores.projection.loadRunCard(canonicalPromptId)).toMatchObject({
      phase: "completed", answer: "incident recovered answer"
    });
    expect(stores.driver.database.prepare(`SELECT event_id FROM conversation_turn_projection_events
      WHERE agent_kind='traex' AND session_id=? AND turn_id=? AND started_at=? ORDER BY sequence`).all(sessionId, turnId, canonicalStartedAt))
      .toEqual(incidentEvents.map(({ eventId }) => ({ event_id: eventId })));
    expect(stores.driver.database.prepare(`SELECT state,message_id,card_id FROM answer_pages
      WHERE prompt_id=? AND page_index=0`).get(canonicalPromptId))
      .toEqual({ state: "frozen", message_id: "frozen-message", card_id: "frozen-card" });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE work_class='history' AND prompt_id=?").get(canonicalPromptId))
      .toEqual({ count: 1 });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE target_role='session_status' AND binding_id='b1'").get())
      .toEqual({ count: 1 });
    expect(wake).toHaveBeenCalled();
    expect(wakePrompt).toHaveBeenCalledWith("b1");

    const repairedPrompt = stores.driver.getPrompt(canonicalPromptId)!;
    await expect(observer.observeSupersedingTurn(stores.driver.getBinding("b1")!, repairedPrompt, duplicateObservation)).resolves.toBe("completed");
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE work_class='history' AND prompt_id=?").get(canonicalPromptId))
      .toEqual({ count: 1 });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE target_role='session_status' AND binding_id='b1'").get())
      .toEqual({ count: 1 });
    expect(run.mock.calls.some(([, args]) => args.includes("recover-turn"))).toBe(false);
    expect(run.mock.calls.some(([, args]) => args.includes("prompt") || args.includes("submit"))).toBe(false);

    await observer.stop();
    stores.lifecycle.close();
  });

  it("persists recovery backoff when an exact native turn fails on the cursor's first read", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    const legacyStartedAt = "2026-09-30T04:13:43.000Z";
    const promptId = nativeTurnPromptId({ bindingId: "b1", bindingGeneration: 1, paneId: "w1:p1", nativeSessionId: "session-1", turnId: "legacy-external-turn", startedAt: legacyStartedAt });
    const view = createQueuedRunCard({ promptId, bindingId: "b1", title: "Direct", workspaceId: "w1", paneId: "w1:p1", requestText: "direct task", queuePosition: 0, occurredAt: legacyStartedAt });
    store.adoptExternalTurn({
      bindingId: "b1", expectedGeneration: 1, expectedPaneId: "w1:p1",
      expectedSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" },
      turnId: "legacy-external-turn", startedAt: legacyStartedAt, requestText: "direct task", externalPromptId: promptId,
      externalMessageId: "herdr-turn:session-1:legacy-external-turn", externalView: view, answerCardFor: () => ({})
    });
    const recoverRead = vi.fn(async () => { throw new Error("Core recover-turn failed: turn_indexing"); });
    const openAtTurn = vi.fn(async () => ({
      mode: "typed" as const,
      cursor: { async readDelta() { return ""; }, readObservation: recoverRead }
    }));
    const warn = vi.fn();
    const logger = { warn, info: vi.fn() } as never;
    const createObserver = () => createExternalTurnObserver({
      store,
      transcriptReader: { open: async () => ({ mode: "unavailable" as const, reason: "transcript_not_found" as const }), openAtTurn },
      bus: new BridgeEventBus(), outboundWork: { wake() {} }, logger, presentation: primaryPresentation, wakePrompt: vi.fn()
    });
    const observer = createObserver();

    await observer.observe(store.getBinding("b1")!);
    await observer.observe(store.getBinding("b1")!);
    await observer.observe(store.getBinding("b1")!);
    await observer.stop();

    store.database.prepare("UPDATE external_turn_recovery_attempts SET next_attempt_at = '2026-09-30T00:00:00.000Z' WHERE prompt_id = ?").run(promptId);
    const restartedObserver = createObserver();
    await restartedObserver.observe(store.getBinding("b1")!);
    await restartedObserver.observe(store.getBinding("b1")!);

    expect(openAtTurn).toHaveBeenCalledTimes(2);
    expect(recoverRead).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: "external-turn-observation-failed", attemptCount: 1, recoveryState: "transient" }), expect.any(String));
    const fence = {
      promptId, bindingId: "b1", expectedGeneration: 1, expectedPaneId: "w1:p1",
      expectedSession: { source: "herdr:traex", agent: "traex", kind: "id" as const, value: "session-1" },
      turnId: "legacy-external-turn", startedAt: legacyStartedAt
    };
    const repeated = Array.from({ length: 8 }, (_, index) => store.deferExternalTurnRecovery({
      ...fence, failureCode: "transcript_read_failed", occurredAt: new Date(Date.UTC(2026, 8, 30, 1, 0, index + 3)).toISOString()
    }));
    expect(repeated.map((result) => result?.shouldLog)).toEqual([false, false, false, false, false, false, false, true]);
    expect(store.deferExternalTurnRecovery({ ...fence, failureCode: "recovery_not_found", occurredAt: "2026-09-30T01:01:00.000Z" }))
      .toMatchObject({ attemptCount: 11, recoveryState: "not_found", shouldLog: true });
    expect(store.getPrompt(promptId)).toMatchObject({ state: "running", observationState: "attached", transcriptTurnId: "legacy-external-turn" });
    await restartedObserver.stop();
    store.close();
  });

  it("drains a newer correlated native turn while an older exact recovery is failing and backing off", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", {
      state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", lastAgentState: "idle",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1"
    });

    const newerView = createQueuedRunCard({
      promptId: "newer", bindingId: "b1", title: "Newer", workspaceId: "w1", paneId: "w1:p1",
      requestText: "newer work", queuePosition: 1, occurredAt: "2026-10-02T13:00:00.000Z"
    });
    store.acceptPrompt({
      prompt: { id: "newer", bindingId: "b1", larkMessageId: "message-newer", actorOpenId: "u1", body: "newer work" },
      view: newerView, rootMessageId: "root", answerCard: {}
    });
    expect(store.claimNextDispatchablePrompt("b1")?.prompt.id).toBe("newer");
    const dispatchedAt = "2026-10-02T13:00:01.000Z";
    expect(store.markPromptNativeQueued({ promptId: "newer", bindingId: "b1", submissionId: "newer", dispatchedAt })).toBe(true);
    expect(store.applyPromptNativeSubmissionReceipt({
      promptId: "newer", bindingId: "b1", submissionId: "newer", dispatchedAt,
      state: "accepted", notice: "Core accepted; observing without replay"
    })).toBe(true);

    const olderStartedAt = "2026-10-02T12:00:00.000Z";
    const olderPromptId = nativeTurnPromptId({
      bindingId: "b1", bindingGeneration: 1, paneId: "w1:p1", nativeSessionId: "session-1",
      turnId: "older-turn", startedAt: olderStartedAt
    });
    const olderView = createQueuedRunCard({
      promptId: olderPromptId, bindingId: "b1", title: "Older", workspaceId: "w1", paneId: "w1:p1",
      requestText: "older work", queuePosition: 0, occurredAt: olderStartedAt
    });
    expect(store.adoptExternalTurn({
      bindingId: "b1", expectedGeneration: 1, expectedPaneId: "w1:p1",
      expectedSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" },
      turnId: "older-turn", startedAt: olderStartedAt, requestText: "older work", externalPromptId: olderPromptId,
      externalMessageId: "herdr-turn:session-1:older-turn", externalView: olderView, answerCardFor: () => ({})
    })).toMatchObject({ outcome: "created_external" });

    const observations: AgentTranscriptObservation[] = [
      {
        turnId: "newer-turn", freshTurnStart: true, requestText: "newer work", requestSubmissionId: "newer", answerDelta: "new answer",
        turnLifecycle: { turnId: "newer-turn", state: "active", startedAt: "2026-10-02T13:00:02.000Z" }
      },
      {
        turnId: "newer-turn", answerDelta: "",
        turnLifecycle: { turnId: "newer-turn", state: "completed", startedAt: "2026-10-02T13:00:02.000Z", finalAnswer: "new answer" }
      },
      { answerDelta: "" }
    ];
    const recoverRead = vi.fn(async () => { throw new Error("Herdr RPC response exceeded the frame limit"); });
    const openAtTurn = vi.fn(async () => ({
      mode: "typed" as const,
      cursor: { async readDelta() { return ""; }, readObservation: recoverRead }
    }));
    const readObservation = vi.fn(async () => observations.shift() ?? { answerDelta: "" });
    const openActiveTurn = vi.fn(async () => ({
      mode: "typed" as const,
      cursor: { async readDelta() { return ""; }, readObservation }
    }));
    const publisher = createTestPublisher(store, noOpLark(), pino({ enabled: false }));
    const observer = createExternalTurnObserver({
      store, transcriptReader: { open: openActiveTurn, openActiveTurn, openAtTurn }, bus: new BridgeEventBus(),
      outboundWork: { wake() {} }, logger: pino({ enabled: false }), presentation: primaryPresentation, wakePrompt: vi.fn()
    });

    await publisher.drain();
    await observer.handoff("b1");
    await observer.handoff("b1");

    expect(openAtTurn).toHaveBeenCalledOnce();
    expect(recoverRead).toHaveBeenCalledOnce();
    expect(openActiveTurn).toHaveBeenCalledOnce();
    expect(store.getPrompt(olderPromptId)).toMatchObject({ state: "running", transcriptTurnId: "older-turn" });
    expect(store.getPrompt("newer")).toMatchObject({
      state: "delivered", observationState: "completed", nativeSubmissionId: "newer", transcriptTurnId: "newer-turn"
    });
    expect(store.loadRunCard("newer")).toMatchObject({ phase: "completed", answer: "new answer" });
    expect(store.listRunCards("b1")).toHaveLength(2);

    await observer.stop();
    await publisher.stop();
    store.close();
  });

  it("terminalizes a restarted absent historical turn after the configured not-found budget and wakes FIFO", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    store.database.prepare("UPDATE bindings SET last_agent_state = 'idle', last_observed_at = '2026-09-30T10:00:01.000Z' WHERE id = 'b1'").run();
    const startedAt = "2026-09-30T10:00:00.000Z";
    const promptId = nativeTurnPromptId({ bindingId: "b1", bindingGeneration: 1, paneId: "w1:p1", nativeSessionId: "session-1", turnId: "missing-turn", startedAt });
    const view = createQueuedRunCard({ promptId, bindingId: "b1", title: "Direct", workspaceId: "w1", paneId: "w1:p1", requestText: "direct task", queuePosition: 0, occurredAt: startedAt });
    store.adoptExternalTurn({ bindingId: "b1", expectedGeneration: 1, expectedPaneId: "w1:p1", expectedSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" }, turnId: "missing-turn", startedAt, requestText: "direct task", externalPromptId: promptId, externalMessageId: "herdr-turn:session-1:missing-turn", externalView: view, answerCardFor: () => ({}) });
    expect(store.recoverRunningPrompts()).toBe(1);
    expect(store.getPrompt(promptId)).toMatchObject({ state: "running", observationState: "detached" });
    const wakePrompt = vi.fn();
    const observer = createExternalTurnObserver({
      store,
      transcriptReader: { openAtTurn: async () => ({ mode: "unavailable" as const, reason: "recovery_not_found" as const }), open: async () => ({ mode: "unavailable" as const, reason: "transcript_not_found" as const }) },
      bus: new BridgeEventBus(), outboundWork: { wake() {} }, logger: pino({ enabled: false }), presentation: primaryPresentation, wakePrompt,
      recoveryNotFoundMaxAttempts: 3
    });

    await observer.observe(store.getBinding("b1")!);
    expect(store.getPrompt(promptId)?.state).toBe("running");
    store.database.prepare("UPDATE external_turn_recovery_attempts SET next_attempt_at = '2026-09-30T00:00:00.000Z' WHERE prompt_id = ?").run(promptId);
    await observer.observe(store.getBinding("b1")!);
    expect(store.getPrompt(promptId)?.state).toBe("running");
    store.database.prepare("UPDATE external_turn_recovery_attempts SET next_attempt_at = '2026-09-30T00:00:00.000Z' WHERE prompt_id = ?").run(promptId);
    await observer.observe(store.getBinding("b1")!);

    expect(store.getPrompt(promptId)).toMatchObject({ state: "failed", observationState: "completed", error: expect.stringContaining("outcome is unknown") });
    expect(wakePrompt).toHaveBeenCalledWith("b1");
    expect(store.database.prepare("SELECT count(*) AS count FROM external_turn_recovery_attempts WHERE prompt_id = ?").get(promptId)).toEqual({ count: 0 });
    expect(store.database.prepare(`SELECT outcome FROM audit_log WHERE action = 'turn.recovery.terminalized' AND target LIKE '%prompt:${promptId}:%'`).get()).toEqual({ outcome: "uncertain" });
    await observer.stop();
    store.close();
  });

  it("never terminalizes a blocked pane when Core cannot find the historical turn", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    store.database.prepare("UPDATE bindings SET last_agent_state = 'blocked', last_observed_at = '2026-09-30T10:00:01.000Z' WHERE id = 'b1'").run();
    const startedAt = "2026-09-30T10:00:00.000Z";
    const promptId = nativeTurnPromptId({ bindingId: "b1", bindingGeneration: 1, paneId: "w1:p1", nativeSessionId: "session-1", turnId: "missing-turn", startedAt });
    const view = createQueuedRunCard({ promptId, bindingId: "b1", title: "Direct", workspaceId: "w1", paneId: "w1:p1", requestText: "direct task", queuePosition: 0, occurredAt: startedAt });
    store.adoptExternalTurn({ bindingId: "b1", expectedGeneration: 1, expectedPaneId: "w1:p1", expectedSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" }, turnId: "missing-turn", startedAt, requestText: "direct task", externalPromptId: promptId, externalMessageId: "herdr-turn:session-1:missing-turn", externalView: view, answerCardFor: () => ({}) });
    const observer = createExternalTurnObserver({ store, transcriptReader: { openAtTurn: async () => ({ mode: "unavailable" as const, reason: "recovery_not_found" as const }), open: async () => ({ mode: "unavailable" as const, reason: "transcript_not_found" as const }) }, bus: new BridgeEventBus(), outboundWork: { wake() {} }, logger: pino({ enabled: false }), presentation: primaryPresentation, wakePrompt: vi.fn() });

    await observer.observe(store.getBinding("b1")!);
    store.database.prepare("UPDATE external_turn_recovery_attempts SET next_attempt_at = '2026-09-30T00:00:00.000Z' WHERE prompt_id = ?").run(promptId);
    store.database.prepare("UPDATE bindings SET last_observed_at = '2026-09-30T10:00:02.000Z' WHERE id = 'b1'").run();
    await observer.observe(store.getBinding("b1")!);

    expect(store.getPrompt(promptId)?.state).toBe("running");
    await observer.stop();
    store.close();
  });

  it("fails closed after repeated idle observations when an external turn has no terminal transcript event", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    store.database.prepare("UPDATE bindings SET last_agent_state = 'idle', last_observed_at = '2026-08-31T10:00:01.000Z' WHERE id = 'b1'").run();
    const startedAt = "2026-08-31T10:00:00.000Z";
    const promptId = nativeTurnPromptId({ bindingId: "b1", bindingGeneration: 1, paneId: "w1:p1", nativeSessionId: "session-1", turnId: "turn-1", startedAt });
    const view = createQueuedRunCard({ promptId, bindingId: "b1", title: "Direct", workspaceId: "w1", paneId: "w1:p1", requestText: ":q", queuePosition: 0, occurredAt: startedAt });
    store.adoptExternalTurn({
      bindingId: "b1", expectedGeneration: 1, expectedPaneId: "w1:p1",
      expectedSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" },
      turnId: "turn-1", startedAt, requestText: ":q", externalPromptId: promptId,
      externalMessageId: "herdr-turn:session-1:turn-1", externalView: view, answerCardFor: () => ({})
    });
    const events: string[] = [];
    const bus = new BridgeEventBus();
    bus.onBridgeEvent("capture", (event) => events.push(event.type));
    const wakePrompt = vi.fn();
    const observer = createExternalTurnObserver({
      store, transcriptReader: {
        open: async () => ({ mode: "typed" as const, cursor: { async readDelta() { return ""; } } }),
        openAtTurn: async () => ({ mode: "typed" as const, cursor: { async readDelta() { return ""; }, async readObservation() { return { answerDelta: "" }; } } })
      },
      bus, outboundWork: { wake() {} }, logger: pino({ enabled: false }), presentation: primaryPresentation, isBindingBusy: () => false, wakePrompt
    });

    await observer.observe(store.getBinding("b1")!);
    await observer.observe(store.getBinding("b1")!);
    expect(store.getPrompt(promptId)).toMatchObject({ state: "running", observationState: "attached" });
    await observer.observe(store.getBinding("b1")!);
    expect(store.getPrompt(promptId)).toMatchObject({ state: "running", observationState: "attached" });
    store.database.prepare("UPDATE bindings SET last_observed_at = '2026-08-31T10:00:02.000Z' WHERE id = 'b1'").run();
    await observer.observe(store.getBinding("b1")!);

    expect(store.getPrompt(promptId)).toMatchObject({ state: "failed", observationState: "completed", error: expect.stringMatching(/without a terminal transcript event/) });
    expect(store.loadRunCard(promptId)).toMatchObject({ phase: "failed", notice: expect.stringMatching(/without a terminal transcript event/) });
    expect(events).toEqual(["TurnFailed"]);
    expect(wakePrompt).toHaveBeenCalledWith("b1");
    await observer.stop();
    store.close();
  });

  it("resets missing-terminal confirmation when transcript evidence resumes", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    store.database.prepare("UPDATE bindings SET last_agent_state = 'idle', last_observed_at = '2026-08-31T10:00:01.000Z' WHERE id = 'b1'").run();
    const startedAt = "2026-08-31T10:00:00.000Z";
    const promptId = nativeTurnPromptId({ bindingId: "b1", bindingGeneration: 1, paneId: "w1:p1", nativeSessionId: "session-1", turnId: "turn-1", startedAt });
    const view = createQueuedRunCard({ promptId, bindingId: "b1", title: "Direct", workspaceId: "w1", paneId: "w1:p1", requestText: "direct", queuePosition: 0, occurredAt: startedAt });
    store.adoptExternalTurn({ bindingId: "b1", expectedGeneration: 1, expectedPaneId: "w1:p1", expectedSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" }, turnId: "turn-1", startedAt, requestText: "direct", externalPromptId: promptId, externalMessageId: "herdr-turn:session-1:turn-1", externalView: view, answerCardFor: () => ({}) });
    const observations: AgentTranscriptObservation[] = [{ answerDelta: "" }, { turnId: "turn-1", answerDelta: "late output", turnLifecycle: { turnId: "turn-1", state: "active", startedAt } }, { answerDelta: "" }];
    const observer = createExternalTurnObserver({ store, transcriptReader: { open: async () => ({ mode: "typed" as const, cursor: { async readDelta() { return ""; } } }), openAtTurn: async () => ({ mode: "typed" as const, cursor: { async readDelta() { return ""; }, async readObservation() { return observations.shift() ?? { answerDelta: "" }; } } }) }, bus: new BridgeEventBus(), outboundWork: { wake() {} }, logger: pino({ enabled: false }), presentation: primaryPresentation, isBindingBusy: () => false, wakePrompt() {} });

    await observer.observe(store.getBinding("b1")!);
    await observer.observe(store.getBinding("b1")!);
    store.database.prepare("UPDATE bindings SET last_observed_at = '2026-08-31T10:00:02.000Z' WHERE id = 'b1'").run();
    await observer.observe(store.getBinding("b1")!);
    store.database.prepare("UPDATE bindings SET last_observed_at = '2026-08-31T10:00:03.000Z' WHERE id = 'b1'").run();
    await observer.observe(store.getBinding("b1")!);

    expect(store.getPrompt(promptId)).toMatchObject({ state: "running", observationState: "attached" });
    await observer.stop();
    store.close();
  });

  it("waits for an in-flight detached-turn recovery before stopping", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    let releaseOpen!: (value: { mode: "typed"; cursor: { readDelta(): Promise<string> } }) => void;
    const openAfterTurn = vi.fn(() => new Promise<{ mode: "typed"; cursor: { readDelta(): Promise<string> } }>((resolve) => { releaseOpen = resolve; }));
    const observer = createExternalTurnObserver({
      store,
      transcriptReader: { open: async () => ({ mode: "typed" as const, cursor: { async readDelta() { return ""; } } }), openAfterTurn },
      bus: new BridgeEventBus(), outboundWork: { wake() {} }, logger: pino({ enabled: false }), presentation: primaryPresentation, isBindingBusy: () => false, wakePrompt() {}
    });
    const binding = store.getBinding("b1")!;
    const recovery = observer.recoverAfterDetachedTurn(binding, { id: "old", transcriptTurnId: "turn-1", transcriptTurnStartedAt: "2026-08-31T10:00:00.000Z" } as never);
    expect(openAfterTurn).toHaveBeenCalledOnce();

    let stopSettled = false;
    const stopping = observer.stop().then(() => { stopSettled = true; });
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(stopSettled).toBe(false);

    releaseOpen({ mode: "typed", cursor: { async readDelta() { return ""; } } });
    await Promise.all([recovery, stopping]);
    store.close();
  });

  it("absorbs a rejected in-flight detached-turn recovery during shutdown", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    let rejectOpen!: (error: Error) => void;
    const openAfterTurn = vi.fn(() => new Promise<never>((_resolve, reject) => { rejectOpen = reject; }));
    const observer = createExternalTurnObserver({
      store,
      transcriptReader: { open: async () => ({ mode: "typed" as const, cursor: { async readDelta() { return ""; } } }), openAfterTurn },
      bus: new BridgeEventBus(), outboundWork: { wake() {} }, logger: pino({ enabled: false }), presentation: primaryPresentation, isBindingBusy: () => false, wakePrompt() {}
    });
    const recovery = observer.recoverAfterDetachedTurn(store.getBinding("b1")!, { id: "old", transcriptTurnId: "turn-1", transcriptTurnStartedAt: "2026-08-31T10:00:00.000Z" } as never);
    const stopping = observer.stop();
    rejectOpen(new Error("transcript unavailable"));

    await expect(recovery).rejects.toThrow("transcript unavailable");
    await expect(stopping).resolves.toBeUndefined();
    store.close();
  });

  it("cancels a direct Turn segment when TraeX records a human interruption", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    const turnId = "turn-aborted";
    const observations: AgentTranscriptObservation[] = [
      { turnId, freshTurnStart: true, requestText: "direct task", answerDelta: "", turnLifecycle: { turnId, state: "active", startedAt: "2026-08-31T10:00:00.000Z" } },
      { turnId, answerDelta: "", turnLifecycle: { turnId, state: "aborted", startedAt: "2026-08-31T10:00:00.000Z", reason: "interrupted" } },
      { answerDelta: "" }
    ];
    const events: string[] = [];
    const bus = new BridgeEventBus();
    bus.onBridgeEvent("capture", (event) => events.push(event.type));
    const wakePrompt = vi.fn();
    const identity: ConversationTurnIdentity = {
      agentKind: "traex",
      sessionId: "session-1",
      turnId,
      startedAt: "2026-08-31T10:00:00.000Z"
    };
    const observer = createExternalTurnObserver({
      store,
      transcriptReader: { open: async () => ({ mode: "typed" as const, cursor: { async readDelta() { return ""; }, async readObservation() { return observations.shift() ?? { answerDelta: "" }; } } }) },
      bus, outboundWork: { wake() {} }, logger: pino({ enabled: false }), presentation: primaryPresentation, isBindingBusy: () => false, wakePrompt, idFactory: () => "external-aborted"
    });

    const binding = store.getBinding("b1")!;
    await observer.observe(binding);
    await observer.observe(binding);
    await observer.observe(binding);

    expect(loadConversationTurnView(store, identity)).toMatchObject({ phase: "cancelled" });
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM prompt_jobs").get()).toEqual({ count: 0 });
    expect(events).toEqual([]);
    expect(wakePrompt).not.toHaveBeenCalled();
    await observer.stop();
    store.close();
  });

  it("adopts a local turn when a stale in-memory worker remains busy after its bridge prompt settled", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    const identity: ConversationTurnIdentity = {
      agentKind: "traex",
      sessionId: "session-1",
      turnId: "local-turn",
      startedAt: "2026-09-28T10:29:31.096Z"
    };
    const observations: AgentTranscriptObservation[] = [
      { turnId: "local-turn", freshTurnStart: true, requestText: "continue locally", answerDelta: "", turnLifecycle: { turnId: "local-turn", state: "active", startedAt: "2026-09-28T10:29:31.096Z" } },
      { turnId: "local-turn", answerDelta: "", turnLifecycle: { turnId: "local-turn", state: "completed", startedAt: "2026-09-28T10:29:31.096Z", finalAnswer: "local result" } }
    ];
    const observer = createExternalTurnObserver({
      store, transcriptReader: { open: async () => ({ mode: "typed" as const, cursor: { async readDelta() { return ""; }, async readObservation() { return observations.shift() ?? { answerDelta: "" }; } } }) },
      bus: new BridgeEventBus(), outboundWork: { wake() {} }, logger: pino({ enabled: false }), presentation: primaryPresentation, wakePrompt() {}, idFactory: () => "external-local-after-bridge"
    });

    await observer.observe(store.getBinding("b1")!);
    await observer.observe(store.getBinding("b1")!);

    expect(loadConversationTurnView(store, identity)).toMatchObject({ phase: "completed", answer: "local result" });
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM prompt_jobs").get()).toEqual({ count: 0 });
    await observer.stop();
    store.close();
  });

  it("does not poll transcript data while an exact bridge-owned turn is active but permits an explicit handoff", async () => {
    const readObservation = vi.fn(async () => ({ answerDelta: "" }));
    const open = vi.fn(async () => ({ mode: "typed" as const, cursor: { readDelta: async () => "", readObservation } }));
    let active = false;
    const store = { getBinding: () => binding, getActiveExternalPrompt: () => null, getActiveBridgePrompt: () => active ? { id: "bridge" } : null } as never;
    const observer = createExternalTurnObserver({ store, transcriptReader: { open }, bus: new BridgeEventBus(), outboundWork: { wake() {} }, logger: pino({ enabled: false }), presentation: primaryPresentation, wakePrompt() {} });
    const binding = { id: "b1", generation: 1, paneId: "w1:p1", agentKind: "traex", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" } as never;
    await observer.observe(binding);
    active = true;
    await observer.observe(binding);
    expect(open).toHaveBeenCalledOnce();
    expect(readObservation).not.toHaveBeenCalled();
    await observer.handoff("b1");
    expect(readObservation).toHaveBeenCalledOnce();
  });

  it("keeps an admitted bridge Prompt owned before its native turn ID arrives", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", {
      state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", lastAgentState: "idle",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1"
    });
    const view = createQueuedRunCard({ promptId: "managed", bindingId: "b1", title: "Managed", workspaceId: "w1", paneId: "w1:p1", requestText: "managed work", queuePosition: 1, occurredAt: "2026-09-30T18:30:00.000Z" });
    store.acceptPromptWithEffects({ prompt: { id: "managed", bindingId: "b1", larkMessageId: "message-managed", actorOpenId: "u1", body: "managed work" }, view, rootMessageId: "root", answerCard: {} });
    expect(store.claimNextDispatchablePrompt("b1")).toMatchObject({ prompt: { id: "managed", nativeSubmissionId: "managed", transcriptTurnId: null } });
    const readObservation = vi.fn(async () => ({ answerDelta: "" }));
    const open = vi.fn(async () => ({ mode: "typed" as const, cursor: { readDelta: async () => "", readObservation } }));
    const observer = createExternalTurnObserver({ store, transcriptReader: { open }, bus: new BridgeEventBus(), outboundWork: { wake() {} }, logger: pino({ enabled: false }), presentation: primaryPresentation, wakePrompt() {} });

    await observer.observe(store.getBinding("b1")!);
    await observer.observe(store.getBinding("b1")!);

    expect(open).toHaveBeenCalledOnce();
    expect(readObservation).not.toHaveBeenCalled();
    expect(store.getPrompt("managed")).toMatchObject({ state: "submitted", executionOrigin: "bridge", nativeSubmissionId: "managed", transcriptTurnId: null });
    await observer.stop();
    store.close();
  });

  it("polls active bindings without requiring a Herdr runtime reconciliation", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    const observations: AgentTranscriptObservation[] = [
      { turnId: "turn-1", freshTurnStart: true, requestText: "direct task", answerDelta: "answer", turnLifecycle: { turnId: "turn-1", state: "completed", startedAt: "2026-08-31T10:00:00.000Z", finalAnswer: "answer" } },
      { answerDelta: "" }
    ];
    const cursor = { async readDelta() { return ""; }, async readObservation() { return observations.shift() ?? { answerDelta: "" }; } };
    const wakePrompt = vi.fn();
    const identity: ConversationTurnIdentity = {
      agentKind: "traex",
      sessionId: "session-1",
      turnId: "turn-1",
      startedAt: "2026-08-31T10:00:00.000Z"
    };
    const observer = createExternalTurnObserver({ store, transcriptReader: { open: async () => ({ mode: "typed" as const, cursor }) }, bus: new BridgeEventBus(), outboundWork: { wake() {} }, logger: pino({ enabled: false }), presentation: primaryPresentation, isBindingBusy: () => false, wakePrompt, idFactory: () => "external-1" });

    await observer.scanActiveBindings();
    await observer.scanActiveBindings();

    expect(loadConversationTurnView(store, identity)).toMatchObject({ phase: "completed", answer: "answer" });
    expect(wakePrompt).not.toHaveBeenCalled();
    await observer.stop();
    store.close();
  });

  it("bounds concurrent transcript observation across active bindings", async () => {
    const store = new SqliteBindingStore(":memory:");
    for (let index = 0; index < 8; index += 1) {
      const id = `b${index}`;
      store.createPendingBinding({ id, workspaceId: "w1", chatId: "c1", topicId: id, rootMessageId: `root-${id}`, title: id });
      store.updateBinding(id, { state: "active", lifecycle: "active", attachment: "attached", paneId: `w1:p${index}`, agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: `session-${index}` });
    }
    let active = 0; let peak = 0;
    const releases: Array<() => void> = [];
    const open = vi.fn(async () => {
      active += 1; peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return { mode: "typed" as const, cursor: { async readDelta() { return ""; }, async readObservation() { return { answerDelta: "" }; } } };
    });
    const observer = createExternalTurnObserver({ store, transcriptReader: { open }, bus: new BridgeEventBus(), outboundWork: { wake() {} }, logger: pino({ enabled: false }), presentation: primaryPresentation, isBindingBusy: () => false, wakePrompt() {} });

    const scan = observer.scanActiveBindings();
    await vi.waitFor(() => expect(releases).toHaveLength(4));
    expect(peak).toBe(4);
    while (releases.length > 0) { releases.shift()!(); await Promise.resolve(); }
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(8));
    while (releases.length > 0) releases.shift()!();
    await scan;
    expect(peak).toBe(4);
    await observer.stop(); store.close();
  });

  it("does not open TraeX transcripts for a non-TraeX Primary binding", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task", agentKind: "pi" });
    store.updateBinding("b1", {
      state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1",
      agentSessionSource: "herdr:pi", agentSessionAgent: "pi", agentSessionKind: "id", agentSessionValue: "pi-session-1"
    });
    const open = vi.fn(async () => ({ mode: "typed" as const, cursor: { async readDelta() { return ""; } } }));
    const observer = createExternalTurnObserver({ store, transcriptReader: { open }, bus: new BridgeEventBus(), outboundWork: { wake() {} }, logger: pino({ enabled: false }), presentation: primaryPresentation, isBindingBusy: () => false, wakePrompt() {} });

    await observer.scanActiveBindings();
    await observer.observeByPane(["w1:p1"]);

    expect(open).not.toHaveBeenCalled();
    await observer.stop();
    store.close();
  });

  it("releases cached observers for bindings that are no longer active", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    const open = vi.fn(async () => ({ mode: "typed" as const, cursor: { async readDelta() { return ""; } } }));
    const observer = createExternalTurnObserver({ store, transcriptReader: { open }, bus: new BridgeEventBus(), outboundWork: { wake() {} }, logger: pino({ enabled: false }), presentation: primaryPresentation, isBindingBusy: () => false, wakePrompt() {} });

    await observer.scanActiveBindings();
    store.updateBinding("b1", { state: "archived", lifecycle: "archived", attachment: "unattached" });
    await observer.scanActiveBindings();
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached" });
    await observer.scanActiveBindings();

    expect(open).toHaveBeenCalledTimes(2);
    await observer.stop();
    store.close();
  });

  it("bounds each canonical message and lets a trusted final answer replace fallback output", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    const startedAt = "2026-09-11T00:00:00.000Z";
    const fallbackIdentity: ConversationTurnIdentity = {
      agentKind: "traex",
      sessionId: "session-1",
      turnId: "turn-large",
      startedAt
    };
    const finalIdentity: ConversationTurnIdentity = {
      agentKind: "traex",
      sessionId: "session-1",
      turnId: "turn-final",
      startedAt: "2026-09-11T00:01:00.000Z"
    };
    const observations: AgentTranscriptObservation[] = [
      { turnId: "turn-large", freshTurnStart: true, requestText: "large", answerDelta: "x".repeat(200_000), turnLifecycle: { turnId: "turn-large", state: "active", startedAt } },
      { turnId: "turn-large", answerDelta: "y".repeat(200_000) },
      { turnId: "turn-large", answerDelta: "z".repeat(200_000) },
      { turnId: "turn-large", answerDelta: "", turnLifecycle: { turnId: "turn-large", state: "completed", startedAt } },
      { turnId: "turn-final", freshTurnStart: true, requestText: "authoritative", answerDelta: "a".repeat(40_000), turnLifecycle: { turnId: "turn-final", state: "active", startedAt: "2026-09-11T00:01:00.000Z" } },
      { turnId: "turn-final", answerDelta: "b".repeat(40_000), turnLifecycle: { turnId: "turn-final", state: "completed", startedAt: "2026-09-11T00:01:00.000Z", finalAnswer: "trusted final" } },
      { answerDelta: "" }
    ];
    let id = 0;
    const observer = createExternalTurnObserver({ store, transcriptReader: { open: async () => ({ mode: "typed" as const, cursor: { async readDelta() { return ""; }, async readObservation() { return observations.shift() ?? { answerDelta: "" }; } } }) }, bus: new BridgeEventBus(), outboundWork: { wake() {} }, logger: pino({ enabled: false }), presentation: primaryPresentation, isBindingBusy: () => false, wakePrompt() {}, idFactory: () => `external-${++id}` });

    await observer.observe(store.getBinding("b1")!);
    for (let index = 0; index < 7; index += 1) await observer.observe(store.getBinding("b1")!);

    const fallbackItems = loadConversationTurnView(store, fallbackIdentity)!.timelineItems
      .filter((item) => (item.kind === "agent_message" || item.kind === "final_answer") && "markdown" in item);
    expect(fallbackItems.length).toBeGreaterThan(0);
    expect(fallbackItems.every((item) => item.markdown.length <= MAX_TURN_OUTPUT_CHARS)).toBe(true);
    expect(fallbackItems.some((item) => item.markdown.endsWith(TURN_OUTPUT_TRUNCATION_MARKER))).toBe(true);
    expect(loadConversationTurnView(store, finalIdentity)).toMatchObject({ phase: "completed", answer: "trusted final" });
    await observer.stop(); store.close();
  });

  it("does not reproject a superseding turn after its handed-off cursor completed it", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    const existing = createQueuedRunCard({ promptId: "old", bindingId: "b1", title: "Old", workspaceId: "w1", paneId: "w1:p1", requestText: "old", queuePosition: 1, occurredAt: "2026-08-31T10:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "old", bindingId: "b1", larkMessageId: "m-old", actorOpenId: "u1", body: "old" }, view: existing, rootMessageId: "root", answerCard: {} });
    store.database.prepare("UPDATE prompt_jobs SET state='running', observation_state='detached', dispatched_at='2026-08-31T10:00:01.000Z', transcript_turn_id='old-turn', transcript_turn_started_at='2026-08-31T10:00:01.000Z' WHERE id='old'").run();
    const replay: AgentTranscriptObservation[] = [{ answerDelta: "" }];
    const bus = new BridgeEventBus(); const events: string[] = []; bus.onBridgeEvent("capture", (event) => events.push(event.type));
    const identity: ConversationTurnIdentity = {
      agentKind: "traex",
      sessionId: "session-1",
      turnId: "new-turn",
      startedAt: "2026-08-31T10:00:02.000Z"
    };
    const observer = createExternalTurnObserver({ store, transcriptReader: { open: async () => ({ mode: "typed" as const, cursor: { async readDelta() { return ""; }, async readObservation() { return replay.shift() ?? { answerDelta: "" }; } } }) }, bus, outboundWork: { wake() {} }, logger: pino({ enabled: false }), presentation: primaryPresentation, isBindingBusy: () => false, wakePrompt() {}, idFactory: () => "external" });
    const binding = store.getBinding("b1")!; const old = store.getPrompt("old")!;
    const directEvents: CoreEventEnvelope[] = [
      { schemaVersion: 1, eventId: "new-human", cursor: "new:1", sourceId: "new-source", agentKind: "traex", sessionId: "session-1", turnId: "new-turn", occurredAt: "2026-08-31T10:00:02.000Z", payload: { type: "human_message", message_id: "new-human", text: "new", truncated: false } },
      { schemaVersion: 1, eventId: "new-final", cursor: "new:2", sourceId: "new-source", agentKind: "traex", sessionId: "session-1", turnId: "new-turn", occurredAt: "2026-08-31T10:00:02.100Z", payload: { type: "message", message_id: "new-final", channel: "final", text: "answer", truncated: false } },
      { schemaVersion: 1, eventId: "new-completed", cursor: "new:3", sourceId: "new-source", agentKind: "traex", sessionId: "session-1", turnId: "new-turn", occurredAt: "2026-08-31T10:00:02.200Z", payload: { type: "turn_completed" } }
    ];
    store.capabilityModules().coreEvents.ingestBatch({ laneId: "new-lane", sourceId: "new-source", agentKind: "traex", sessionId: "session-1", afterCursor: "", nextCursor: "new:3", latestCursor: "new:3", events: directEvents, ingestedAt: "2026-08-31T10:00:02.300Z" });
    const completed = await observer.observeSupersedingTurn(binding, old, { turnId: "new-turn", freshTurnStart: true, requestText: "new", answerDelta: "answer", turnLifecycle: { turnId: "new-turn", state: "completed", startedAt: "2026-08-31T10:00:02.000Z", finalAnswer: "answer" }, coreEventSettlement: { laneId: "new-lane", eventIds: directEvents.map(({ eventId }) => eventId), occurredAt: "2026-08-31T10:00:02.300Z", owner: { kind: "binding", id: "b1" } } });
    expect(completed).toBe("completed"); const eventCount = events.length;
    expect(store.getPrompt("old")).toMatchObject({ state: "uncertain", observationState: "completed" });
    await observer.observe(binding); await observer.observe(binding);
    expect(events).toHaveLength(eventCount); expect(loadConversationTurnView(store, identity)).toMatchObject({ answer: "answer", phase: "completed" });
    await observer.stop(); store.close();
  });
});

function ringPublisherStore(stores: ReturnType<typeof createTestStoreBundle>) {
  return Object.assign(stores.driver, {
    acquireInstanceLease: stores.lease.acquireInstanceLease.bind(stores.lease),
    activateWriteFence: stores.lifecycle.activateWriteFence.bind(stores.lifecycle)
  }) as never;
}

function noOpLark(): LarkPort {
  return {
    async start() {},
    async stop() {},
    isReady: () => true,
    async createTopic() { return { topicId: "topic", rootMessageId: "root" }; },
    async replyText() { return { messageId: "text" }; },
    async replyCard() { return { messageId: "card" }; },
    async replyStreamingCard() { return { messageId: "answer", cardId: "cardkit" }; },
    async streamCardContent() {},
    async finishStreamingCard() {},
    async updateCard() {},
    async shareThread() { return { messageId: "shared" }; }
  };
}
