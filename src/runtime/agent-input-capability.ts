import type { AgentInputCorePort } from "../domain/ports/agent-input.js";

export interface AgentInputCapabilityStatus {
  required: boolean;
  detected: boolean;
  supported: boolean;
  ready: boolean;
  error: string | null;
}

export class AgentInputCapabilityGate {
  private status: AgentInputCapabilityStatus;

  constructor(
    private readonly core: Pick<AgentInputCorePort, "capabilities">,
    private readonly required: boolean
  ) {
    this.status = {
      required,
      detected: false,
      supported: false,
      ready: !required,
      error: required ? "Herdr Core Agent Input capability has not been detected" : null
    };
  }

  async detect(): Promise<AgentInputCapabilityStatus> {
    try {
      const { agentInputSubmissionV3 } = await this.core.capabilities();
      this.status = {
        required: this.required,
        detected: true,
        supported: agentInputSubmissionV3 === true,
        ready: !this.required || agentInputSubmissionV3 === true,
        error: this.required && agentInputSubmissionV3 !== true
          ? "Herdr Core does not advertise agent_input_submission_v3"
          : null
      };
    } catch {
      this.status = {
        required: this.required,
        detected: false,
        supported: false,
        ready: !this.required,
        error: "Herdr Core Agent Input capability detection failed"
      };
    }
    return this.snapshot();
  }

  snapshot(): AgentInputCapabilityStatus {
    return { ...this.status };
  }
}
