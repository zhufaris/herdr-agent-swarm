import { randomUUID } from "node:crypto";
import type { BridgeConfig } from "../config.js";
import { createBridgeEvent } from "../domain/create-bridge-event.js";
import { nativeTurnPromptId } from "../domain/native-turn-identity.js";
import { outputFingerprint } from "../domain/output-fingerprint.js";
import { formatPromptTitle } from "../domain/prompt-title.js";
import { formatNativeInputBatch, formatNativeInputReplyContext, NATIVE_INPUT_BATCH_WINDOW_MS } from "../domain/native-input-batch.js";
import type { BindingPromptWorkflowPort, ManagedContinuationInput, ManagedPrimaryCompletionActionInput, ManagedPrimaryCompletionIgnoreInput, ManagedPromptInput, NativeInputCollectionReceipt, NativeTurnAdoptionInput, PromptAcceptanceReceipt, PromptAcceptanceStore, PromptCoreObservation, PromptCoreObservationOutput, PromptObservationReceipt } from "../domain/ports/prompt-acceptance.js";
import type { PrimaryPresentation } from "../domain/ports/presentation.js";
import type { AdoptExternalTurnInput } from "../domain/ports/workflow.js";
import { createQueuedRunCard } from "../domain/run-card-view.js";
import { reduceRunCard } from "../domain/run-card-view.js";
import { conversationTurnProjectionId, type ConversationTurnIdentity } from "../domain/conversation-turn-projection.js";
import { reduceCurrentGoal } from "../domain/current-goal.js";
import type { Binding, PromptJob } from "../domain/types.js";
import type { LifecycleEventPublisher } from "../events/bridge-event-bus.js";
import type { OutboundWorkNotifier } from "../events/outbound-work-notifier.js";
import type { PromptWorkScheduler } from "../events/prompt-work-scheduler.js";
import { createBoundedTurnOutput } from "../runtime/bounded-turn-output.js";
import { projectOwnedTranscriptOutput } from "./owned-transcript-output-projector.js";
import { ProjectCatalog } from "./project-catalog.js";
import { executePromptAcceptanceEffects } from "./prompt-acceptance-effects.js";
import type { Logger } from "pino";
import type { PrimaryCompletionResult } from "../domain/ports/prompt-run.js";
import { COMPLETION_ACTION_MESSAGES } from "../domain/completion-action-set.js";
import { selectCompletionChoiceTerminalAnswer, selectCompletionChoiceTerminalInput } from "../domain/completion-choice.js";

interface BindingPromptWorkflowStore extends PromptAcceptanceStore {
  loadConversationTurnProjection(identity: ConversationTurnIdentity): import("../domain/conversation-turn-projection.js").ConversationTurnProjection | null;
  loadRunCard(promptId: string): import("../domain/run-card-view.js").RunCardView | null;
  projectConversationTurn(input: Parameters<import("../domain/ports/workflow.js").ExternalTurnObservationStore["projectConversationTurn"]>[0]): ReturnType<import("../domain/ports/workflow.js").ExternalTurnObservationStore["projectConversationTurn"]>;
  replaceAuthoritativeTurnSnapshot(input: Parameters<import("../domain/ports/workflow.js").ExternalTurnObservationStore["replaceAuthoritativeTurnSnapshot"]>[0]): ReturnType<import("../domain/ports/workflow.js").ExternalTurnObservationStore["replaceAuthoritativeTurnSnapshot"]>;
  adoptExternalTurn(input: AdoptExternalTurnInput): import("../domain/types.js").ExternalTurnAdoption;
  getPrompt(id: string): PromptJob | null;
  claimPromptTranscriptTurn(input: { promptId: string; bindingId: string; turnId: string; startedAt: string }): import("../domain/types.js").TranscriptTurnClaimOutcome;
  listPromptTranscriptTurns?(promptId: string): Array<{ turnId: string; startedAt: string }>;
  completeTurn(input: { promptId: string; bindingId: string; answer: string; completionChoice?: import("../domain/completion-choice.js").ChoicePrompt; occurredAt: string; outputFingerprint: string; replaceAnswer?: boolean }): PrimaryCompletionResult;
  failPrompt(input: { promptId: string; error: string; occurredAt: string }): void;
  markPromptObservationDetached(id: string, notice: string): void;
  observePrimaryPromptState?(input: import("../domain/human-review.js").PrimaryPromptStateObservationInput): import("../domain/human-review.js").PrimaryPromptStateObservationResult;
}

interface Options {
  config: Pick<BridgeConfig, "projects" | "maxQueueDepth">;
  store: BindingPromptWorkflowStore;
  lifecycleEvents: LifecycleEventPublisher;
  outboundWork: OutboundWorkNotifier;
  scheduler: PromptWorkScheduler;
  logger?: Pick<Logger, "info" | "warn">;
  presentation: Pick<PrimaryPresentation, "answerCard" | "mainCard" | "paneEntryCard"> & Partial<Pick<PrimaryPresentation, "primaryHumanReviewNotification">>;
  convergeAnswer?(promptId: string): Promise<void>;
}

export class BindingPromptWorkflow implements BindingPromptWorkflowPort {
  private readonly projects: ProjectCatalog;

  constructor(private readonly options: Options) {
    this.projects = new ProjectCatalog(options.config.projects);
  }

  async acceptManagedInput(input: ManagedPromptInput): Promise<PromptAcceptanceReceipt | NativeInputCollectionReceipt | null> {
    if (input.ingressSource === "feishu" && input.larkMessageId === null) {
      throw new Error("Managed Feishu Prompt requires a Lark message ID");
    }

    const acceptedAt = new Date().toISOString();
    const eligibleNativeInput = input.ingressSource === "feishu" && (input.priority ?? "normal") === "normal";
    const acceptedSourceExists = eligibleNativeInput
      ? this.options.store.hasAcceptedPromptSource({ ingressSource: "feishu", sourceMessageKey: input.sourceMessageKey })
      : false;
    if (eligibleNativeInput && !acceptedSourceExists) await this.drainDueNativeInputBatch(input.binding.id, acceptedAt);
    const pendingCount = this.options.store.countPendingPrompts(input.binding.id);
    const nativeInputBacklog = eligibleNativeInput
      ? this.options.store.getNativeInputBacklog(input.binding.id, input.binding.generation)
      : null;
    const immediateNativeBatch = eligibleNativeInput
      && (input.binding.lastAgentState === "idle" || input.binding.lastAgentState === "done")
      && pendingCount === 0
      && nativeInputBacklog!.unbatchedInputCount === 0
      && nativeInputBacklog!.pendingBatchCount === 0;
    if (eligibleNativeInput && !immediateNativeBatch) {
      const result = this.options.store.acceptCollectingNativeInput({
        input: {
          id: randomUUID(), bindingId: input.binding.id, bindingGeneration: input.binding.generation,
          ingressSource: "feishu", sourceMessageKey: input.sourceMessageKey, larkMessageId: input.larkMessageId!,
          actorOpenId: input.actor.openId, body: input.body, rootMessageId: input.initialProjectionContext.rootMessageId,
          parentPromptId: input.parentPromptId ?? null
        },
        batchId: randomUUID(), occurredAt: acceptedAt, windowMs: NATIVE_INPUT_BATCH_WINDOW_MS,
        maxQueueDepth: this.options.config.maxQueueDepth
      });
      const backlog = this.options.store.getNativeInputBacklog(input.binding.id, input.binding.generation);
      const receipt = committedCollectionReceipt(result, result.inserted ? [
        { kind: "prompt-wake", bindingId: input.binding.id },
        { kind: "lifecycle-event", event: createBridgeEvent(input.binding.id, "NativeInputBacklogChanged", "lark", backlog) },
        ...(result.supersededPromptIds ?? []).map((promptId) => ({ kind: "answer-converge" as const, promptId }))
      ] : []);
      if (!result.inserted) return receipt;
      await executePromptAcceptanceEffects(receipt, this.options);
      this.options.store.audit({ actorOpenId: input.actor.openId, action: "prompt.input.queue", target: input.binding.id, outcome: "success" });
      return receipt;
    }
    if (immediateNativeBatch) {
      const inputId = randomUUID();
      const batchId = randomUUID();
      const combinedBody = formatNativeInputBatch([input.body]);
      const view = createQueuedRunCard({
        ...this.projects.runProjectionContextForBinding(input.binding),
        promptId: batchId,
        title: formatPromptTitle(input.body),
        requestText: combinedBody,
        replyContext: formatNativeInputReplyContext([input.body]),
        occurredAt: acceptedAt,
        conversionParentPromptId: input.parentPromptId ?? null,
        queuePosition: 1,
        currentGoal: this.options.store.getCurrentGoal(input.binding.id)
      });
      const result = this.options.store.acceptImmediateNativeInputBatch({
        input: {
          id: inputId, bindingId: input.binding.id, bindingGeneration: input.binding.generation,
          ingressSource: "feishu", sourceMessageKey: input.sourceMessageKey, larkMessageId: input.larkMessageId!,
          actorOpenId: input.actor.openId, body: input.body, rootMessageId: input.initialProjectionContext.rootMessageId,
          parentPromptId: input.parentPromptId ?? null
        },
        batchId, combinedBody, occurredAt: acceptedAt, view,
        answerCard: this.options.presentation.answerCard(view), maxQueueDepth: this.options.config.maxQueueDepth
      });
      const receipt = committedBatchReceipt(result, result.inserted ? [
        { kind: "outbound-wake" },
        { kind: "prompt-wake", bindingId: input.binding.id },
        { kind: "lifecycle-event", event: createBridgeEvent(input.binding.id, "PromptQueued", "lark", {
          promptId: result.prompt.id, queueDepth: 1, actorOpenId: input.actor.openId
        }) },
        ...(result.supersededPromptIds ?? []).map((promptId) => ({ kind: "answer-converge" as const, promptId }))
      ] : []);
      if (!result.inserted) return receipt;
      await executePromptAcceptanceEffects(receipt, this.options);
      this.options.store.audit({ actorOpenId: input.actor.openId, action: "prompt.queue", target: input.binding.id, outcome: "success" });
      return receipt;
    }
    const promptId = randomUUID();
    const view = createQueuedRunCard({
      ...this.projects.runProjectionContextForBinding(input.binding),
      promptId,
      title: formatPromptTitle(input.body),
      requestText: input.body,
      occurredAt: acceptedAt,
      conversionParentPromptId: input.parentPromptId ?? null,
      queuePosition: pendingCount + 1,
      currentGoal: this.options.store.getCurrentGoal(input.binding.id)
    });
    const receipt = this.options.store.acceptPromptWithEffects({
      prompt: {
        id: promptId,
        bindingId: input.binding.id,
        larkMessageId: input.larkMessageId,
        actorOpenId: input.actor.openId,
        body: input.body,
        parentPromptId: input.parentPromptId ?? null,
        priority: input.priority ?? "normal",
        ingressSource: input.ingressSource,
        sourceMessageKey: input.sourceMessageKey
      },
      view,
      rootMessageId: input.initialProjectionContext.rootMessageId,
      answerCard: this.options.presentation.answerCard(view),
      maxQueueDepth: this.options.config.maxQueueDepth,
      expectedBindingGeneration: input.binding.generation
    });
    if (!receipt.result.inserted) return receipt;
    await executePromptAcceptanceEffects(receipt, this.options);
    this.options.store.audit({ actorOpenId: input.actor.openId, action: "prompt.queue", target: input.binding.id, outcome: "success" });
    return receipt;
  }

  async acceptInterruptedContinuation(input: ManagedContinuationInput): Promise<PromptAcceptanceReceipt> {
    const acceptedAt = new Date().toISOString();
    const promptId = randomUUID();
    const view = createQueuedRunCard({
      ...this.projects.runProjectionContextForBinding(input.binding),
      promptId,
      title: formatPromptTitle(input.body),
      requestText: input.body,
      occurredAt: acceptedAt,
      conversionParentPromptId: input.parentPromptId,
      queuePosition: this.options.store.countPendingPrompts(input.binding.id) + 1,
      currentGoal: this.options.store.getCurrentGoal(input.binding.id)
    });
    const receipt = this.options.store.acceptInterruptedContinuation({
      interactionId: input.interactionId,
      parentPromptId: input.parentPromptId,
      sourceAnswerMessageId: input.sourceAnswerMessageId,
      expectedBindingGeneration: input.binding.generation,
      actorOpenId: input.actor.openId,
      accepted: {
        prompt: {
          id: promptId,
          bindingId: input.binding.id,
          larkMessageId: null,
          actorOpenId: input.actor.openId,
          body: input.body,
          parentPromptId: input.parentPromptId,
          ingressSource: "internal",
          sourceMessageKey: `card-continuation:v1:${input.interactionId}`
        },
        view,
        rootMessageId: input.initialProjectionContext.rootMessageId,
        answerCard: this.options.presentation.answerCard(view),
        maxQueueDepth: this.options.config.maxQueueDepth,
        expectedBindingGeneration: input.binding.generation
      }
    });
    if (!receipt.result.inserted) return receipt;
    await executePromptAcceptanceEffects(receipt, this.options);
    this.options.store.audit({ actorOpenId: input.actor.openId, action: "prompt.queue", target: input.binding.id, outcome: "success" });
    return receipt;
  }

  async acceptPrimaryCompletionAction(input: ManagedPrimaryCompletionActionInput): Promise<PromptAcceptanceReceipt> {
    if ((input.selection === undefined) === (input.optionId === undefined)) throw new Error("Exactly one completion action identity is required");
    const choice = input.optionId === undefined ? null : this.options.store.resolvePrimaryCompletionChoice({
      actionSetId: input.actionSetId,
      optionId: input.optionId,
      ownerPromptId: input.ownerPromptId,
      ownerGeneration: input.ownerGeneration,
      cardMessageId: input.cardMessageId,
      actorOpenId: input.actor.openId
    });
    const body = choice?.message ?? COMPLETION_ACTION_MESSAGES[input.selection!];
    const acceptedAt = new Date().toISOString();
    const promptId = randomUUID();
    const sourceMessageKey = input.optionId
      ? `completion-choice:v1:${input.actionSetId}:${input.optionId}`
      : `completion-action:v1:${input.actionSetId}:${input.selection}`;
    const view = createQueuedRunCard({
      ...this.projects.runProjectionContextForBinding(input.binding),
      promptId,
      title: formatPromptTitle(body),
      requestText: body,
      occurredAt: acceptedAt,
      conversionParentPromptId: input.ownerPromptId,
      queuePosition: this.options.store.countPendingPrompts(input.binding.id) + 1,
      currentGoal: this.options.store.getCurrentGoal(input.binding.id)
    });
    const receipt = this.options.store.acceptPrimaryCompletionAction({
      actionSetId: input.actionSetId,
      ...(input.optionId ? { optionId: input.optionId } : { selection: input.selection! }),
      ownerPromptId: input.ownerPromptId,
      ownerGeneration: input.ownerGeneration,
      cardMessageId: input.cardMessageId,
      actorOpenId: input.actor.openId,
      accepted: {
        prompt: {
          id: promptId,
          bindingId: input.binding.id,
          larkMessageId: null,
          actorOpenId: input.actor.openId,
          body,
          parentPromptId: input.ownerPromptId,
          ingressSource: "internal",
          sourceMessageKey
        },
        view,
        rootMessageId: input.initialProjectionContext.rootMessageId,
        answerCard: this.options.presentation.answerCard(view),
        maxQueueDepth: this.options.config.maxQueueDepth,
        expectedBindingGeneration: input.binding.generation
      }
    });
    await executePromptAcceptanceEffects(receipt, this.options);
    await this.options.convergeAnswer?.(input.ownerPromptId);
    if (receipt.result.inserted) this.options.store.audit({ actorOpenId: input.actor.openId, action: "completion-action.consume", target: input.ownerPromptId, outcome: input.optionId ?? input.selection! });
    return receipt;
  }

  async ignorePrimaryCompletionAction(input: ManagedPrimaryCompletionIgnoreInput) {
    const result = this.options.store.ignorePrimaryCompletionAction({
      actionSetId: input.actionSetId,
      ownerPromptId: input.ownerPromptId,
      ownerGeneration: input.ownerGeneration,
      cardMessageId: input.cardMessageId,
      actorOpenId: input.actor.openId
    });
    await this.options.convergeAnswer?.(result.ownerId);
    if (result.changed) this.options.store.audit({ actorOpenId: input.actor.openId, action: "completion-action.ignore", target: result.ownerId, outcome: "ignored" });
    return result;
  }

  async drainDueNativeInputBatch(bindingId: string, occurredAt = new Date().toISOString()): Promise<{ outcome: "none" | "not_due" | "formed"; nextDueAt: string | null }> {
    const result = this.options.store.formDueNativeInputBatch({
      bindingId, occurredAt, nextBatchId: randomUUID(), windowMs: NATIVE_INPUT_BATCH_WINDOW_MS,
      createProjection: ({ batchId, binding, combinedBody, replyContext, titleSource, rootMessageId, queuePosition }) => {
        const view = createQueuedRunCard({
          ...this.projects.runProjectionContextForBinding(binding),
          promptId: batchId, title: formatPromptTitle(titleSource), requestText: combinedBody, replyContext, occurredAt,
          conversionParentPromptId: null, queuePosition, currentGoal: this.options.store.getCurrentGoal(binding.id)
        });
        return { view, rootMessageId, answerCard: this.options.presentation.answerCard(view) };
      }
    });
    if (result.outcome === "none") return { outcome: "none", nextDueAt: null };
    if (result.outcome === "not_due") return { outcome: "not_due", nextDueAt: result.batch.drainDueAt };
    const receipt = committedBatchReceipt({ inserted: true, prompt: result.prompt, view: result.view }, [
      { kind: "outbound-wake" },
      { kind: "prompt-wake", bindingId },
      { kind: "lifecycle-event", event: createBridgeEvent(bindingId, "PromptQueued", "lark", {
        promptId: result.prompt.id, queueDepth: this.options.store.countPendingPrompts(bindingId), actorOpenId: result.prompt.actorOpenId
      }) },
      ...(result.supersededPromptIds ?? []).map((promptId) => ({ kind: "answer-converge" as const, promptId }))
    ]);
    await executePromptAcceptanceEffects(receipt, this.options);
    return { outcome: "formed", nextDueAt: result.nextBatch?.drainDueAt ?? null };
  }

  adoptNativeTurn(input: NativeTurnAdoptionInput) {
    const promptId = nativeTurnPromptId({
      bindingId: input.binding.id,
      bindingGeneration: input.binding.generation,
      paneId: input.binding.paneId!,
      nativeSessionId: input.session.value,
      turnId: input.turnId,
      startedAt: input.startedAt
    });
    const externalView = createQueuedRunCard({
      ...this.projects.runProjectionContextForBinding(input.binding),
      promptId,
      title: formatPromptTitle(input.requestText),
      requestText: input.requestText,
      queuePosition: 0,
      occurredAt: input.startedAt,
      currentGoal: this.options.store.getCurrentGoal(input.binding.id)
    });
    return this.options.store.adoptExternalTurn({
      bindingId: input.binding.id,
      expectedGeneration: input.binding.generation,
      expectedPaneId: input.binding.paneId!,
      expectedSession: input.session,
      turnId: input.turnId,
      startedAt: input.startedAt,
      requestText: input.requestText,
      ...(input.requestSubmissionId ? { requestSubmissionId: input.requestSubmissionId } : {}),
      ...(input.supersede ? { supersede: input.supersede } : {}),
      externalPromptId: promptId,
      externalMessageId: `herdr-turn:${input.session.value}:${input.turnId}`,
      externalView,
      answerCardFor: this.options.presentation.answerCard
    });
  }

  async applyCoreObservation(input: PromptCoreObservation): Promise<PromptObservationReceipt> {
    return input.origin === "bridge" ? this.applyBridgeObservation(input) : this.applyHerdrObservation(input);
  }

  private async applyBridgeObservation(input: Extract<PromptCoreObservation, { origin: "bridge" }>): Promise<PromptObservationReceipt> {
    const current = this.options.store.getPrompt(input.prompt.id) ?? input.prompt;
    if (!input.observation.turnId) {
      if (input.settlement) return await this.applyBridgeSettlement(input.binding, current, input.output, input.settlement);
      return { outcome: "ignored", owned: false, terminal: null, prompt: current, output: input.output };
    }
    let ownedPrompt = current;
    const lifecycle = input.observation.turnLifecycle;
    const observedStartedAt = lifecycle?.startedAt;
    const needsTurnIdentity = !current.transcriptTurnId;
    const needsAcceptedTurnStart = current.transcriptTurnId === input.observation.turnId && !current.transcriptTurnStartedAt;
    const exactSubmissionCorrelation = Boolean(
      current.nativeSubmissionId
      && current.nativeSubmissionId === current.id
      && input.observation.requestSubmissionId === current.nativeSubmissionId
    );
    const mayClaimTurn = exactSubmissionCorrelation || (
      input.observation.freshTurnStart === true
      && (current.observationState === "attached" || needsAcceptedTurnStart)
    );
    if ((needsTurnIdentity || needsAcceptedTurnStart) && lifecycle && mayClaimTurn) {
      const outcome = this.options.store.claimPromptTranscriptTurn({ promptId: current.id, bindingId: input.binding.id, turnId: lifecycle.turnId, startedAt: lifecycle.startedAt });
      if (outcome.prompt) ownedPrompt = outcome.prompt;
    }
    const ownedTurns = this.ownedTurns(ownedPrompt);
    let owned = ownedTurns.some((turn) => turn.turnId === input.observation.turnId && (!observedStartedAt || turn.startedAt === observedStartedAt));
    if (ownedPrompt.observationState === "detached") owned = owned && ownedTurns.some((turn) => turn.turnId === input.observation.turnId && turn.startedAt === observedStartedAt);
    if (!owned) return { outcome: "ignored", owned: false, terminal: null, prompt: ownedPrompt, output: input.output };

    const projection = projectOwnedTranscriptOutput({
      state: {
        emitted: input.output.emitted ?? Boolean(input.output.text),
        output: { text: input.output.text, truncated: input.output.truncated },
        ...(input.output.terminalLifecycle ? { terminalLifecycle: input.output.terminalLifecycle } : {})
      },
      observation: input.observation,
      ...(input.elapsedSeconds !== undefined ? { elapsedSeconds: input.elapsedSeconds } : {})
    });
    if (projection.observation) await this.publish(input.binding.id, "TurnOutputObserved", "herdr", { promptId: ownedPrompt.id, observation: projection.observation });
    const output = outputFromProjection(projection.state);
    const terminal = projection.state.terminalLifecycle;
    if (input.settlement) return await this.applyBridgeSettlement(input.binding, ownedPrompt, output, input.settlement);
    if (input.settleTerminal && ownedPrompt.state === "running" && terminal?.state === "completed") {
      const terminalInput = input.terminalAnswer ?? selectCompletionChoiceTerminalInput(terminal.finalAnswer, projection.state.output.text);
      const answer = selectCompletionChoiceTerminalAnswer(terminalInput, projection.state.output.text);
      this.completeTurn({
        promptId: ownedPrompt.id, bindingId: input.binding.id, answer: terminalInput,
        ...(terminal.completionChoice ? { completionChoice: terminal.completionChoice } : {}),
        outputFingerprint: outputFingerprint(answer), occurredAt: new Date().toISOString(),
        ...(input.replaceTerminalAnswer === undefined ? {} : { replaceAnswer: input.replaceTerminalAnswer })
      });
      await this.publish(input.binding.id, "TurnCompleted", "herdr", { promptId: ownedPrompt.id, answer, queueDepth: this.options.store.countPendingPrompts(input.binding.id) });
      this.options.scheduler.wake({ kind: "prompt-ready", bindingId: input.binding.id });
      return { outcome: "completed", owned: true, terminal: "completed", prompt: ownedPrompt, output };
    }
    if (input.settleTerminal && ownedPrompt.state === "running" && terminal?.state === "aborted") {
      const reason = terminal.reason === "interrupted" ? "TraeX turn was interrupted by a human operator" : `TraeX turn was aborted${terminal.reason ? `: ${terminal.reason}` : ""}`;
      this.options.store.failPrompt({ promptId: ownedPrompt.id, error: reason, occurredAt: new Date().toISOString() });
      await this.publish(input.binding.id, "TurnFailed", "herdr", { promptId: ownedPrompt.id, error: reason, queueDepth: this.options.store.countPendingPrompts(input.binding.id) });
      this.options.scheduler.wake({ kind: "prompt-ready", bindingId: input.binding.id });
      return { outcome: "completed", owned: true, terminal: "aborted", prompt: ownedPrompt, output };
    }
    return { outcome: "projected", owned: true, terminal: terminal?.state === "completed" || terminal?.state === "aborted" ? terminal.state : null, prompt: ownedPrompt, output };
  }

  private async applyBridgeSettlement(
    binding: Binding,
    prompt: PromptJob,
    output: PromptCoreObservationOutput,
    settlement: NonNullable<Extract<PromptCoreObservation, { origin: "bridge" }>["settlement"]>
  ): Promise<PromptObservationReceipt> {
    if (settlement.kind === "detached") {
      if (prompt.state === "submitted" || prompt.state === "running") this.options.store.markPromptObservationDetached(prompt.id, settlement.notice);
      return { outcome: "detached", owned: true, terminal: null, prompt, output };
    }
    if (settlement.kind === "completed") {
      if (prompt.state === "submitted" || prompt.state === "running") {
        const visibleAnswer = selectCompletionChoiceTerminalAnswer(settlement.answer, output.text);
        this.completeTurn({
          promptId: prompt.id,
          bindingId: binding.id,
          answer: settlement.answer,
          ...(settlement.completionChoice ? { completionChoice: settlement.completionChoice } : {}),
          outputFingerprint: outputFingerprint(settlement.sourceAnswer),
          occurredAt: new Date().toISOString(),
          ...(settlement.replaceAnswer === undefined ? {} : { replaceAnswer: settlement.replaceAnswer })
        });
        await this.publish(binding.id, "TurnCompleted", "herdr", { promptId: prompt.id, answer: visibleAnswer, queueDepth: this.options.store.countPendingPrompts(binding.id) });
      }
      this.options.scheduler.wake({ kind: "prompt-ready", bindingId: binding.id });
      return { outcome: "completed", owned: true, terminal: "completed", prompt, output };
    }
    if (prompt.state === "submitted" || prompt.state === "running") {
      this.options.store.failPrompt({ promptId: prompt.id, error: settlement.error, occurredAt: new Date().toISOString() });
      await this.publish(binding.id, "TurnFailed", settlement.eventOrigin ?? "herdr", { promptId: prompt.id, error: settlement.error, queueDepth: this.options.store.countPendingPrompts(binding.id) });
    }
    this.options.scheduler.wake({ kind: "prompt-ready", bindingId: binding.id });
    return { outcome: "completed", owned: true, terminal: "aborted", prompt, output };
  }

  private async applyHerdrObservation(input: Extract<PromptCoreObservation, { origin: "herdr" }>): Promise<PromptObservationReceipt> {
    const lifecycle = input.observation.turnLifecycle;
    if (input.observation.freshTurnStart && lifecycle) input.state.pendingStarts.set(lifecycle.turnId, lifecycle.startedAt);
    const turnId = input.observation.turnId ?? lifecycle?.turnId;
    if (!turnId) return { outcome: "ignored", owned: false, terminal: null, prompt: null };
    if (lifecycle && !input.supersede && !input.state.pendingStarts.has(turnId)) input.state.pendingStarts.set(turnId, lifecycle.startedAt);
    let owned = input.state.promptsByTurn.get(turnId);
    let prompt = owned ? this.options.store.getPrompt(owned.promptId) : null;
    let supersededPromptIds: string[] = [];
    let outboxReserved = false;
    const startedAt = input.state.pendingStarts.get(turnId) ?? (input.supersede ? undefined : lifecycle?.startedAt);
    const directIdentity = startedAt && (input.session.agent === "traex" || input.session.agent === "pi") ? {
      agentKind: input.session.agent,
      sessionId: input.session.value,
      turnId,
      startedAt
    } satisfies ConversationTurnIdentity : null;
    const directProjection = directIdentity ? this.options.store.loadConversationTurnProjection(directIdentity) : null;
    if (!owned && directIdentity && (directProjection || input.observation.requestText !== undefined && !input.observation.requestSubmissionId)) {
      if (input.observation.authoritativeSnapshot && directProjection) {
        return this.replaceAuthoritativeTurn(input, directIdentity, directProjection.view, null);
      }
      return await this.projectDirectHerdrTurn(input, directIdentity, directProjection?.view ?? null);
    }
    if (!owned && input.observation.requestText !== undefined) {
      if (!startedAt) return { outcome: input.observation.freshTurnStart ? "pending" : "ignored", owned: false, terminal: null, prompt: null };
      const result = this.adoptNativeTurn({
        binding: input.binding,
        session: input.session,
        turnId,
        startedAt,
        requestText: input.observation.requestText,
        ...(input.observation.requestSubmissionId ? { requestSubmissionId: input.observation.requestSubmissionId } : {}),
        ...(input.supersede ? { supersede: input.supersede } : {})
      });
      if ((result.outcome !== "adopted_queued" && result.outcome !== "created_external" && result.outcome !== "already_owned") || !result.prompt) return { outcome: "ignored", owned: false, terminal: null, prompt: null };
      if (result.outcome === "already_owned" && result.prompt.executionOrigin === "bridge") {
        input.state.pendingStarts.delete(turnId);
        return { outcome: "ignored", owned: false, terminal: null, prompt: result.prompt };
      }
      if (result.outcome === "already_owned" && result.prompt.state !== "running") {
        input.state.pendingStarts.delete(turnId);
        return { outcome: "completed", owned: true, terminal: result.prompt.state === "failed" ? "aborted" : "completed", prompt: result.prompt, output: { emitted: false, text: "", truncated: false } };
      }
      prompt = result.prompt;
      owned = { promptId: prompt.id, output: outputFromProjection({ emitted: false, output: createBoundedTurnOutput() }) };
      input.state.promptsByTurn.set(turnId, owned);
      supersededPromptIds = result.supersededPromptIds;
      outboxReserved = result.outboxReserved;
      if (outboxReserved) this.options.outboundWork.wake();
      this.observeHumanReview(input.binding, prompt);
      for (const promptId of supersededPromptIds) {
        await this.publish(input.binding.id, "TurnFailed", "herdr", { promptId, error: "A newer Herdr turn superseded this detached turn; its prior outcome remains uncertain.", queueDepth: this.options.store.countPendingPrompts(input.binding.id) });
      }
      await this.publish(input.binding.id, "TurnStarted", "herdr", { promptId: prompt.id, queueDepth: this.options.store.countPendingPrompts(input.binding.id) });
    }
    if (!owned || !prompt) return { outcome: input.observation.freshTurnStart ? "pending" : "ignored", owned: false, terminal: null, prompt: null };
    if (input.observation.authoritativeSnapshot) {
      const current = this.options.store.loadRunCard(prompt.id);
      if (!current) throw new Error(`Run card missing for authoritative snapshot: ${prompt.id}`);
      return this.replaceAuthoritativeTurn(input, {
        agentKind: input.observation.authoritativeSnapshot.agentKind,
        sessionId: input.observation.authoritativeSnapshot.sessionId,
        turnId: input.observation.authoritativeSnapshot.turnId,
        startedAt: input.observation.authoritativeSnapshot.canonicalStartedAt
      }, current, prompt);
    }

    const projection = projectOwnedTranscriptOutput({
      state: {
        emitted: owned.output.emitted ?? Boolean(owned.output.text),
        output: { text: owned.output.text, truncated: owned.output.truncated },
        ...(owned.output.terminalLifecycle ? { terminalLifecycle: owned.output.terminalLifecycle } : {})
      },
      observation: input.observation,
      ...elapsedSecondsFor(input.state.pendingStarts.get(turnId) ?? prompt.transcriptTurnStartedAt ?? lifecycle?.startedAt)
    });
    owned.output = outputFromProjection(projection.state);
    if (projection.observation) await this.publish(input.binding.id, "TurnOutputObserved", "herdr", { promptId: owned.promptId, observation: projection.observation });
    const terminal = lifecycle?.state === "completed" || lifecycle?.state === "aborted" ? lifecycle.state : null;
    if (lifecycle?.state === "completed") {
      const current = this.options.store.getPrompt(owned.promptId);
      if (current?.state === "running") {
        const answer = lifecycle.finalAnswer ?? owned.output.text;
        this.completeTurn({ promptId: owned.promptId, bindingId: input.binding.id, answer, occurredAt: new Date().toISOString(), outputFingerprint: outputFingerprint(answer), replaceAnswer: Boolean(lifecycle.finalAnswer) });
        await this.publish(input.binding.id, "TurnCompleted", "herdr", { promptId: owned.promptId, answer, queueDepth: this.options.store.countPendingPrompts(input.binding.id) });
      }
      input.state.promptsByTurn.delete(turnId);
      input.state.pendingStarts.delete(turnId);
      this.options.scheduler.wake({ kind: "prompt-ready", bindingId: input.binding.id });
      return { outcome: "completed", owned: true, terminal: "completed", prompt, output: owned.output, supersededPromptIds, outboxReserved };
    }
    if (lifecycle?.state === "aborted") {
      const current = this.options.store.getPrompt(owned.promptId);
      if (current?.state === "running") {
        const reason = lifecycle.reason === "interrupted"
          ? "TraeX turn was interrupted by a human operator"
          : `TraeX turn was aborted${lifecycle.reason ? `: ${lifecycle.reason}` : ""}`;
        this.options.store.failPrompt({ promptId: owned.promptId, error: reason, occurredAt: new Date().toISOString() });
        await this.publish(input.binding.id, "TurnFailed", "herdr", { promptId: owned.promptId, error: reason, queueDepth: this.options.store.countPendingPrompts(input.binding.id) });
      }
      input.state.promptsByTurn.delete(turnId);
      input.state.pendingStarts.delete(turnId);
      this.options.scheduler.wake({ kind: "prompt-ready", bindingId: input.binding.id });
      return { outcome: "completed", owned: true, terminal: "aborted", prompt, output: owned.output, supersededPromptIds, outboxReserved };
    }
    return { outcome: "observing", owned: true, terminal, prompt, output: owned.output, supersededPromptIds, outboxReserved };
  }

  private async projectDirectHerdrTurn(
    input: Extract<PromptCoreObservation, { origin: "herdr" }>,
    identity: ConversationTurnIdentity,
    current: import("../domain/run-card-view.js").RunCardView | null
  ): Promise<PromptObservationReceipt> {
    const occurredAt = input.observation.coreEventSettlement?.occurredAt ?? new Date().toISOString();
    let view = current ?? createQueuedRunCard({
      ...this.projects.runProjectionContextForBinding(input.binding),
      promptId: conversationTurnProjectionId(identity),
      title: formatPromptTitle(input.observation.requestText ?? "Herdr input"),
      requestText: input.observation.requestText ?? "",
      queuePosition: 0,
      occurredAt,
      currentGoal: this.options.store.getCurrentGoal(input.binding.id)
    });
    if (view.phase === "queued") view = reduceRunCard(view, { type: "started", occurredAt: identity.startedAt });
    const output = projectOwnedTranscriptOutput({
      state: { emitted: Boolean(view.answer), output: { text: view.answer, truncated: false } },
      observation: input.observation,
      ...elapsedSecondsFor(identity.startedAt)
    });
    if (output.observation) {
      const answer = output.observation.answer;
      const status = output.observation.main.status;
      view = reduceRunCard(view, {
        type: "output",
        occurredAt,
        answerSnapshot: answer.snapshot,
        ...(answer.previousSnapshot === undefined ? {} : { previousAnswerSnapshot: answer.previousSnapshot }),
        ...(answer.update === undefined ? {} : { answerUpdate: answer.update }),
        progressEvents: answer.toolActivities.map((item) => ({ ...item, occurredAt })),
        ...(status?.planSteps === undefined ? {} : { taskList: status.planSteps.map((step) => ({ ...step, occurredAt })) }),
        ...(status?.statusTitle === undefined ? {} : { taskListTitle: status.statusTitle }),
        ...(answer.timelineDeltas?.length ? { timelineDeltas: answer.timelineDeltas } : {})
      });
      let goal = view.currentGoal;
      for (const change of output.observation.goalChanges ?? []) goal = reduceCurrentGoal(goal, change);
      if (goal !== view.currentGoal) view = reduceRunCard(view, { type: "goal-snapshot", occurredAt, currentGoal: goal });
    }
    const terminal = input.observation.turnLifecycle?.state;
    if (terminal === "completed") {
      view = reduceRunCard(view, {
        type: "completed",
        occurredAt,
        answer: selectCompletionChoiceTerminalAnswer(input.observation.turnLifecycle?.finalAnswer, output.state.output.text),
        replaceAnswer: Boolean(input.observation.turnLifecycle?.finalAnswer)
      });
    } else if (terminal === "aborted") {
      const reason = input.observation.turnLifecycle?.reason === "interrupted"
        ? "TraeX turn was interrupted by a human operator"
        : `TraeX turn was aborted${input.observation.turnLifecycle?.reason ? `: ${input.observation.turnLifecycle.reason}` : ""}`;
      view = reduceRunCard(view, { type: "failed", occurredAt, notice: reason });
    }
    const result = this.options.store.projectConversationTurn({
      identity,
      origin: "herdr",
      bindingId: input.binding.id,
      expectedGeneration: input.binding.generation,
      expectedPaneId: input.binding.paneId!,
      ...(input.supersede ? { supersede: input.supersede } : {}),
      view,
      ...(input.observation.coreEventSettlement ? { settlement: input.observation.coreEventSettlement } : {}),
      answerCardFor: this.options.presentation.answerCard,
      mainCardFor: this.options.presentation.mainCard,
      paneEntryCardFor: this.options.presentation.paneEntryCard
    });
    if (result.outboxReserved) this.options.outboundWork.wake();
    for (const promptId of result.supersededPromptIds) {
      await this.publish(input.binding.id, "TurnFailed", "herdr", { promptId, error: "A newer Herdr turn superseded this detached turn; its prior outcome remains uncertain.", queueDepth: this.options.store.countPendingPrompts(input.binding.id) });
    }
    if (terminal === "completed" || terminal === "aborted") input.state.pendingStarts.delete(identity.turnId);
    const projectedOutput = outputFromProjection(output.state);
    return {
      outcome: terminal === "completed" || terminal === "aborted" ? "completed" : "projected",
      owned: false,
      terminal: terminal === "completed" || terminal === "aborted" ? terminal : null,
      prompt: null,
      output: projectedOutput,
      supersededPromptIds: result.supersededPromptIds,
      outboxReserved: result.outboxReserved
    };
  }

  private replaceAuthoritativeTurn(
    input: Extract<PromptCoreObservation, { origin: "herdr" }>,
    identity: ConversationTurnIdentity,
    current: import("../domain/run-card-view.js").RunCardView,
    prompt: PromptJob | null
  ): PromptObservationReceipt {
    const snapshot = input.observation.authoritativeSnapshot;
    if (!snapshot || snapshot.turnId !== identity.turnId || snapshot.canonicalStartedAt !== identity.startedAt) {
      throw new Error("Authoritative Turn snapshot identity mismatch");
    }
    const occurredAt = new Date().toISOString();
    let rebuilt = createQueuedRunCard({
      promptId: current.promptId,
      bindingId: current.bindingId,
      bindingGeneration: current.bindingGeneration,
      conversionParentPromptId: current.conversionParentPromptId,
      title: formatPromptTitle(input.observation.requestText ?? current.requestText),
      sessionTitle: current.sessionTitle ?? current.title,
      agentKind: current.agentKind,
      requestText: input.observation.requestText ?? current.requestText,
      replyContext: current.replyContext ?? null,
      workspaceId: current.workspaceId,
      spaceName: current.spaceName,
      paneId: current.paneId,
      paneToken: current.paneToken ?? null,
      queuePosition: 0,
      occurredAt: current.createdAt,
      currentGoal: null
    });
    rebuilt = reduceRunCard(rebuilt, { type: "started", occurredAt: identity.startedAt });
    const output = projectOwnedTranscriptOutput({
      state: { emitted: false, output: createBoundedTurnOutput() },
      observation: input.observation,
      ...elapsedSecondsFor(identity.startedAt)
    });
    if (output.observation) {
      const answer = output.observation.answer;
      const status = output.observation.main.status;
      rebuilt = reduceRunCard(rebuilt, {
        type: "output",
        occurredAt,
        answerSnapshot: answer.snapshot,
        ...(answer.previousSnapshot === undefined ? {} : { previousAnswerSnapshot: answer.previousSnapshot }),
        ...(answer.update === undefined ? {} : { answerUpdate: answer.update }),
        progressEvents: answer.toolActivities.map((item) => ({ ...item, occurredAt })),
        ...(status?.planSteps === undefined ? {} : { taskList: status.planSteps.map((step) => ({ ...step, occurredAt })) }),
        ...(status?.statusTitle === undefined ? {} : { taskListTitle: status.statusTitle }),
        ...(answer.timelineDeltas?.length ? { timelineDeltas: answer.timelineDeltas } : {})
      });
      let goal = rebuilt.currentGoal;
      for (const change of output.observation.goalChanges ?? []) goal = reduceCurrentGoal(goal, change);
      if (goal !== rebuilt.currentGoal) rebuilt = reduceRunCard(rebuilt, { type: "goal-snapshot", occurredAt, currentGoal: goal });
    }
    const terminal = input.observation.turnLifecycle?.state;
    if (terminal === "completed") {
      rebuilt = reduceRunCard(rebuilt, {
        type: "completed",
        occurredAt,
        answer: selectCompletionChoiceTerminalAnswer(input.observation.turnLifecycle?.finalAnswer, output.state.output.text),
        replaceAnswer: Boolean(input.observation.turnLifecycle?.finalAnswer)
      });
    } else if (terminal === "aborted") {
      const reason = input.observation.turnLifecycle?.reason === "interrupted"
        ? "TraeX turn was interrupted by a human operator"
        : `TraeX turn was aborted${input.observation.turnLifecycle?.reason ? `: ${input.observation.turnLifecycle.reason}` : ""}`;
      rebuilt = reduceRunCard(rebuilt, { type: "failed", occurredAt, notice: reason });
    } else throw new Error("Authoritative Turn snapshot is not terminal");
    rebuilt = {
      ...rebuilt,
      conversionParentPromptId: current.conversionParentPromptId,
      larkMessageId: current.larkMessageId,
      answerMessageId: current.answerMessageId,
      answerCardId: current.answerCardId,
      answerElementId: current.answerElementId,
      answerSequence: current.answerSequence,
      answerPageIndex: current.answerPageIndex,
      answerPageStart: current.answerPageStart,
      deliveredVersion: current.deliveredVersion,
      answerDeliveredVersion: current.answerDeliveredVersion,
      workerActivity: current.workerActivity,
      workerDependencyRevision: current.workerDependencyRevision,
      workerContextFrozenAt: current.workerContextFrozenAt,
      createdAt: current.createdAt,
      viewVersion: current.viewVersion + 1,
      updatedAt: occurredAt
    };
    const result = this.options.store.replaceAuthoritativeTurnSnapshot({
      identity: {
        agentKind: snapshot.agentKind,
        sessionId: snapshot.sessionId,
        turnId: snapshot.turnId,
        requestedStartedAt: snapshot.requestedStartedAt
      },
      bindingId: input.binding.id,
      expectedGeneration: input.binding.generation,
      expectedPaneId: input.binding.paneId!,
      projectionId: current.promptId,
      origin: "herdr",
      view: rebuilt,
      occurredAt,
      answerCardFor: this.options.presentation.answerCard,
      mainCardFor: this.options.presentation.mainCard,
      paneEntryCardFor: this.options.presentation.paneEntryCard
    });
    if (result.outcome !== "replaced" && result.outcome !== "duplicate") {
      throw new Error(`Authoritative Turn replacement ${result.outcome}`);
    }
    if (result.outboxReserved) this.options.outboundWork.wake();
    input.state.promptsByTurn.delete(identity.turnId);
    input.state.pendingStarts.delete(identity.turnId);
    this.options.scheduler.wake({ kind: "prompt-ready", bindingId: input.binding.id });
    const receipt = {
      outcome: "completed" as const,
      terminal: terminal === "aborted" ? "aborted" as const : "completed" as const,
      output: outputFromProjection(output.state),
      outboxReserved: result.outboxReserved
    };
    return prompt
      ? { ...receipt, owned: true, prompt }
      : { ...receipt, owned: false, prompt: null };
  }

  private ownedTurns(prompt: PromptJob): Array<{ turnId: string; startedAt: string }> {
    const durable = this.options.store.listPromptTranscriptTurns?.(prompt.id);
    if (durable) return durable;
    return prompt.transcriptTurnId && prompt.transcriptTurnStartedAt ? [{ turnId: prompt.transcriptTurnId, startedAt: prompt.transcriptTurnStartedAt }] : [];
  }

  private observeHumanReview(binding: Binding, prompt: PromptJob): void {
    if (!this.options.presentation.primaryHumanReviewNotification || !this.options.store.observePrimaryPromptState || !binding.paneId || binding.lastAgentState === "unknown") return;
    const observation = this.options.store.observePrimaryPromptState({
      bindingId: binding.id, promptId: prompt.id, expectedGeneration: binding.generation, expectedPaneId: binding.paneId,
      state: binding.lastAgentState, notice: binding.lastAgentState === "blocked" ? "Primary 正在等待 Herdr 中的本地审批或交互输入。" : null,
      occurredAt: new Date().toISOString(), renderHumanReviewNotification: this.options.presentation.primaryHumanReviewNotification
    });
    if (observation.notification.outcome === "reserved") this.options.outboundWork.wake();
  }

  private completeTurn(input: { promptId: string; bindingId: string; answer: string; completionChoice?: import("../domain/completion-choice.js").ChoicePrompt; occurredAt: string; outputFingerprint: string; replaceAnswer?: boolean }): Binding {
    const completed = this.options.store.completeTurn(input);
    return completed.binding;
  }

  private async publish<T extends Parameters<typeof createBridgeEvent>[1]>(bindingId: string, type: T, origin: import("../domain/types.js").EventOrigin, payload: Extract<ReturnType<typeof createBridgeEvent>, { type: T }>["payload"]): Promise<void> {
    await this.options.lifecycleEvents.publish(createBridgeEvent(bindingId, type, origin, payload));
  }
}

function committedBatchReceipt(
  result: PromptAcceptanceReceipt["result"],
  effects: readonly import("../domain/ports/prompt-acceptance.js").PromptAcceptanceEffect[]
): PromptAcceptanceReceipt {
  let consumed = false;
  return {
    result,
    commitState: "committed",
    consumeEffects: () => {
      if (consumed) return [];
      consumed = true;
      return effects;
    }
  };
}

function committedCollectionReceipt(
  result: import("../domain/native-input-batch.js").NativeInputCollectionResult,
  effects: readonly import("../domain/ports/prompt-acceptance.js").PromptAcceptanceEffect[]
): NativeInputCollectionReceipt {
  let consumed = false;
  return {
    result: { ...result, prompt: null, view: null },
    commitState: "committed",
    consumeEffects: () => {
      if (consumed) return [];
      consumed = true;
      return effects;
    }
  };
}

function outputFromProjection(state: { emitted: boolean; output: { text: string; truncated: boolean }; terminalLifecycle?: NonNullable<import("../domain/ports/external.js").AgentTranscriptObservation["turnLifecycle"]> }): PromptCoreObservationOutput {
  return {
    emitted: state.emitted,
    text: state.output.text,
    truncated: state.output.truncated,
    ...(state.terminalLifecycle ? { terminalLifecycle: state.terminalLifecycle } : {})
  };
}

function elapsedSecondsFor(startedAt: string | undefined): { elapsedSeconds: number } | {} {
  if (!startedAt) return {};
  const startedAtMs = Date.parse(startedAt);
  if (!Number.isFinite(startedAtMs)) return {};
  return { elapsedSeconds: Math.max(0, Math.floor((Date.now() - startedAtMs) / 1_000)) };
}
