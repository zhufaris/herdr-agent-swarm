import { createHash } from "node:crypto";
import type { TraexControlPort, TraexModelPromptDispatchOptions } from "../domain/ports/external.js";
import type { HerdrAgentSession } from "../domain/types.js";
import { canonicalTraexSession } from "../domain/traex-session-identity.js";
import { abortTraexModelPrompt, commitTraexModelPrompt, prepareTraexModelPrompt } from "../runtime/traex-model-prompt.js";
import { listTraexModels } from "../runtime/traex-model-protocol.js";
import { findTraexSessionPeer } from "../runtime/traex-session-peer.js";

export class TraexControlAdapter implements TraexControlPort {
  constructor(
    private readonly peersDir: string,
    private readonly operationDir: string,
    private readonly timeoutMs: number,
    private readonly operations = { findPeer: findTraexSessionPeer, listModels: listTraexModels, prepare: prepareTraexModelPrompt, commit: commitTraexModelPrompt, abort: abortTraexModelPrompt }
  ) {}

  async listModels(agentSession: HerdrAgentSession) {
    return this.operations.listModels(await this.peer(agentSession), { timeoutMs: this.timeoutMs });
  }

  async runModelPrompt(target: string, text: string, options: TraexModelPromptDispatchOptions, signal?: AbortSignal, onDispatched?: () => void | Promise<void>) {
    throwIfAborted(signal);
    const promptSha256 = createHash("sha256").update(text).digest("hex");
    const prepared = await this.operations.prepare({ peer: await this.peer(options.agentSession), target, model: options.modelDispatch.name, revision: options.modelDispatch.revision, promptSha256 }, { operationDir: this.operationDir, timeoutMs: this.timeoutMs });
    if (prepared.state !== "prepared") throw new Error(`Model prompt prepare returned ${prepared.state}`);
    await options.onPrepared(prepared.operationId);
    try {
      await onDispatched?.();
      throwIfAborted(signal);
      const committed = await this.operations.commit({ operationId: prepared.operationId, text, promptSha256 }, { operationDir: this.operationDir, timeoutMs: this.timeoutMs });
      if (committed.state === "rejected") await options.onPrepareAborted?.(prepared.operationId);
      if (committed.state !== "accepted" || !committed.turnId) throw new Error(committed.detail ?? `Model prompt commit returned ${committed.state}`);
      await options.onAccepted?.({ operationId: committed.operationId, turnId: committed.turnId });
      return { operationId: committed.operationId, turnId: committed.turnId };
    } catch (error) {
      const aborted = await this.operations.abort({ operationId: prepared.operationId }, { operationDir: this.operationDir, timeoutMs: this.timeoutMs }).catch(() => null);
      if (aborted?.state === "rejected") await options.onPrepareAborted?.(prepared.operationId);
      throw error;
    }
  }

  private async peer(session: HerdrAgentSession) {
    const canonical = canonicalTraexSession(session);
    if (canonical.source !== "herdr:traex" || canonical.agent !== "traex" || canonical.kind !== "id") throw new Error("Session does not support TraeX control");
    const peer = await this.operations.findPeer(this.peersDir, canonical.value);
    if (!peer) throw new Error("TraeX native session peer is unavailable");
    return peer;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Operation aborted");
}
