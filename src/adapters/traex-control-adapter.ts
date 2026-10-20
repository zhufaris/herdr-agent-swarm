import type { TraexControlPort } from "../domain/ports/external.js";
import type { HerdrAgentSession } from "../domain/types.js";
import type { CommandRunner } from "../infra/command-runner.js";
import { isNativeTraexSession } from "../domain/traex-session-identity.js";
import { listTraexModelsFromCli } from "../runtime/traex-model-protocol.js";

export class TraexControlAdapter implements TraexControlPort {
  constructor(
    private readonly timeoutMs: number,
    private readonly runner: Pick<CommandRunner, "run">,
    private readonly executable: string,
    private readonly listModelsFromCli = listTraexModelsFromCli
  ) {}

  async listModels(agentSession: HerdrAgentSession) {
    this.requireNativeSession(agentSession);
    return this.listModelsFromCli(this.runner, this.executable, this.timeoutMs);
  }

  private requireNativeSession(session: HerdrAgentSession): void {
    if (!isNativeTraexSession(session)) throw new Error("Session does not support TraeX control");
  }
}
