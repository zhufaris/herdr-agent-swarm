import type { PromptJob } from "../../domain/prompt.js";
import type { AcceptCardCommandIntentInput, AcceptCardCommandIntentResult, CommandStatusRenderer } from "../../domain/ports/swarm-command.js";
import { sessionOperationRejection } from "../../domain/session-operation-policy.js";
import type { BridgeCommand, Binding, CardInteraction, SessionOperationKind } from "../../domain/types.js";
import { mapCardInteraction, type CardInteractionRow } from "../sqlite-records.js";
import type { SqliteCommandIntentStore } from "./command-intent-store.js";
import type { SqliteContext } from "./context.js";

interface Dependencies {
  getBinding(id: string): Binding | null;
  getActiveOrdinaryPrompt(bindingId: string, expectedGeneration: number): PromptJob | null;
}

export class SqliteCardCommandAdmissionStore {
  constructor(
    private readonly context: SqliteContext,
    private readonly commands: SqliteCommandIntentStore,
    private readonly dependencies: Dependencies
  ) {}

  accept(input: AcceptCardCommandIntentInput, renderStatus?: CommandStatusRenderer): AcceptCardCommandIntentResult {
    return this.context.transaction("sqlite.card-command-admission-store.write", () => {
      const interaction = this.getInteraction(input.interactionId);
      if (!interaction) return rejected("missing");
      const { intent } = input;
      const primary = intent.context.primary;
      if (interaction.actorOpenId !== intent.context.actorOpenId) return rejected("unauthorized");
      if (interaction.state === "consumed") {
        if (interaction.resultCode !== intent.command.kind) return rejected("stale");
        const existing = this.commands.findExact(intent, "card");
        return existing ? { outcome: "duplicate", intent: existing } : rejected("stale");
      }
      if (interaction.state !== "active") return rejected(interaction.state === "expired" ? "expired" : "stale");
      if (interaction.expiresAt <= input.now) {
        this.context.database.prepare("UPDATE card_interactions SET state = 'expired' WHERE id = ? AND state = 'active'").run(interaction.id);
        return rejected("expired");
      }
      if (!primary || interaction.actionKind !== "more_actions"
        || interaction.bindingId !== primary.bindingId || interaction.bindingGeneration !== input.expectedBindingGeneration
        || primary.bindingGeneration !== input.expectedBindingGeneration || intent.laneKey !== `binding:${primary.bindingId}`
        || intent.idempotencyKey !== `interaction:${interaction.id}:${intent.command.kind}`
        || intent.context.sourceMessageId !== interaction.id) return rejected("stale");
      const binding = this.dependencies.getBinding(primary.bindingId);
      if (!binding || binding.chatId !== intent.context.chatId || !sameFrozenPrimary(binding, primary)) return rejected("stale");
      const operationKind = cardOperationKind(intent.command);
      if (!operationKind || sessionOperationRejection(binding, operationKind)) return rejected("stale");
      if (intent.command.kind === "stop") {
        const active = this.dependencies.getActiveOrdinaryPrompt(binding.id, binding.generation);
        if (!active || active.id !== primary.activePromptId) return rejected("stale");
      }
      const accepted = this.commands.accept(intent, "card", renderStatus);
      if (accepted.outcome !== "accepted") return accepted;
      const consumed = this.context.database.prepare("UPDATE card_interactions SET state = 'consumed', result_code = ?, consumed_at = ? WHERE id = ? AND state = 'active'")
        .run(intent.command.kind, input.now, interaction.id);
      if (consumed.changes !== 1) throw new Error(`Card command interaction acceptance lost ownership: ${interaction.id}`);
      return accepted;
    });
  }

  private getInteraction(id: string): CardInteraction | null {
    const row = this.context.database.prepare("SELECT * FROM card_interactions WHERE id = ?").get(id) as CardInteractionRow | undefined;
    return row ? mapCardInteraction(row) : null;
  }
}

function rejected(outcome: "missing" | "unauthorized" | "expired" | "stale"): AcceptCardCommandIntentResult {
  return { outcome, intent: null };
}

function cardOperationKind(command: BridgeCommand): SessionOperationKind | null {
  switch (command.kind) {
    case "stop": return "stop";
    case "reset": return "reset";
    case "archive": return "archive";
    case "resume": return "resume";
    case "replace": return "replace";
    case "pane_close_request": return "pane_close";
    case "rename": return "rename";
    case "reattach": return "reattach";
    default: return null;
  }
}

function sameFrozenPrimary(binding: Binding, primary: NonNullable<AcceptCardCommandIntentInput["intent"]["context"]["primary"]>): boolean {
  const nativeSession = binding.agentSessionSource && binding.agentSessionAgent && binding.agentSessionKind && binding.agentSessionValue
    ? { source: binding.agentSessionSource, agent: binding.agentSessionAgent, kind: binding.agentSessionKind, value: binding.agentSessionValue }
    : null;
  return binding.generation === primary.bindingGeneration && binding.paneId === primary.paneId
    && binding.traexSessionId === primary.terminalId && JSON.stringify(nativeSession) === JSON.stringify(primary.nativeSession);
}
