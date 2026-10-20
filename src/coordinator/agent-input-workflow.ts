import { randomUUID } from "node:crypto";
import type { AgentInputRequest, AgentInputResult, AgentInputStore, AgentInputWorkflowPort } from "../domain/ports/agent-input.js";
import type { AgentInputCapabilityStatus } from "../runtime/agent-input-capability.js";
import type { AgentInputDrainer } from "./agent-input-drainer.js";

export interface AgentInputWorkflowOptions {
  store: Pick<AgentInputStore, "admit" | "get">;
  drainer: Pick<AgentInputDrainer, "drain">;
  capability: { snapshot(): AgentInputCapabilityStatus };
  idFactory?: () => string;
  now?: () => string;
}

export class AgentInputWorkflow implements AgentInputWorkflowPort {
  private readonly idFactory: () => string;
  private readonly now: () => string;

  constructor(private readonly options: AgentInputWorkflowOptions) {
    this.idFactory = options.idFactory ?? randomUUID;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async submit(input: AgentInputRequest): Promise<AgentInputResult> {
    const capability = this.options.capability.snapshot();
    if (!capability.ready || !capability.supported) {
      throw new Error(capability.error ?? "Herdr Core Agent Input capability is unavailable");
    }
    const submissionId = this.idFactory();
    const admission = this.options.store.admit({
      submissionId,
      ...input,
      recordedAt: this.now()
    });
    if (admission.outcome === "conflict") {
      return {
        outcome: "conflict",
        submissionId: admission.intent.submissionId,
        state: admission.intent.state
      };
    }
    const intent = await this.options.drainer.drain(admission.intent.submissionId);
    if (!intent) throw new Error("Agent Input disappeared after durable admission");
    return {
      outcome: admission.outcome,
      submissionId: intent.submissionId,
      state: intent.state
    };
  }

  async resume(submissionId: string): Promise<AgentInputResult> {
    const capability = this.options.capability.snapshot();
    if (!capability.ready || !capability.supported) {
      throw new Error(capability.error ?? "Herdr Core Agent Input capability is unavailable");
    }
    const before = this.options.store.get(submissionId);
    if (!before) throw new Error("Agent Input is unavailable");
    const intent = await this.options.drainer.drain(submissionId);
    if (!intent) throw new Error("Agent Input disappeared after durable admission");
    return { outcome: before.state === "recorded" ? "accepted" : "duplicate", submissionId: intent.submissionId, state: intent.state };
  }
}
