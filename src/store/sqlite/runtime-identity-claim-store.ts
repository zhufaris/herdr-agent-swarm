import { createCurrentRuntimeIdentityClaim, createUnclaimedRuntimeIdentityClaim, sameNativeRuntimeIdentity, type CurrentRuntimeIdentityClaim, type RuntimeIdentityClaim, type RuntimeIdentityOwner } from "../../domain/runtime-identity-claim.js";
import type { Binding } from "../../domain/binding.js";
import type { CurrentRuntimeIdentityClaimOutcome, RuntimeIdentityTransitionFence } from "../../domain/ports/binding.js";
import type { HerdrPane, RecoverOrphanBindingProjectionInput, RuntimeIdentityReconciliationApplication, RuntimeIdentityReconciliationPolicy } from "../../domain/types.js";
import { mapRuntimeIdentityClaim, type RuntimeIdentityClaimRow } from "../sqlite-records.js";
import { SqliteSavepointOperationError, type SqliteContext } from "./context.js";
import type { SqliteBindingLifecycleStore } from "./binding-store.js";

export class SqliteRuntimeIdentityClaimStore {
  constructor(private readonly context: SqliteContext, private readonly bindings: SqliteBindingLifecycleStore) {}
  private get database() { return this.context.database; }

  loadRuntimeIdentityClaim(owner: RuntimeIdentityOwner): RuntimeIdentityClaim | null {
    const row = this.database.prepare(`SELECT * FROM runtime_identity_claims
      WHERE binding_id = ? AND binding_generation = ? AND session_epoch = ?`).get(
      owner.bindingId, owner.bindingGeneration, owner.sessionEpoch
    ) as RuntimeIdentityClaimRow | undefined;
    return row ? mapRuntimeIdentityClaim(row) : null;
  }

  claimCurrentRuntimeIdentity(input: { claim: CurrentRuntimeIdentityClaim; paneToken: string | null }): { outcome: CurrentRuntimeIdentityClaimOutcome; claim: RuntimeIdentityClaim | null } {
    const claim = createCurrentRuntimeIdentityClaim(input.claim);
    return this.context.transaction("sqlite.runtime-identity-claim.claim", () => {
      const binding = this.bindings.getBinding(claim.owner.bindingId);
      if (!binding || binding.generation !== claim.owner.bindingGeneration || binding.sessionEpoch !== claim.owner.sessionEpoch) {
        return { outcome: "stale", claim: this.loadRuntimeIdentityClaim(claim.owner) };
      }
      const existing = this.loadRuntimeIdentityClaim(claim.owner);
      if (existing?.state === "current" && sameCurrentClaim(existing, claim) && sameBindingProjection(binding, claim)) {
        return { outcome: "unchanged", claim: existing };
      }
      try {
        this.context.savepoint("sqlite.runtime-identity-claim.claim-write", () => {
          this.database.prepare(`INSERT INTO runtime_identity_claims(
            binding_id,binding_generation,session_epoch,state,native_session_source,native_session_agent,native_session_kind,native_session_value,
            attachment_state,workspace_id,pane_id,terminal_id,last_rejected_evidence_fingerprint,last_rejected_reason,created_at,updated_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(binding_id,binding_generation,session_epoch) DO UPDATE SET
            state=excluded.state,native_session_source=excluded.native_session_source,native_session_agent=excluded.native_session_agent,
            native_session_kind=excluded.native_session_kind,native_session_value=excluded.native_session_value,
            attachment_state=excluded.attachment_state,workspace_id=excluded.workspace_id,pane_id=excluded.pane_id,terminal_id=excluded.terminal_id,
            last_rejected_evidence_fingerprint=excluded.last_rejected_evidence_fingerprint,last_rejected_reason=excluded.last_rejected_reason,
            updated_at=excluded.updated_at`).run(
            claim.owner.bindingId, claim.owner.bindingGeneration, claim.owner.sessionEpoch, claim.state,
            claim.nativeIdentity.source, claim.nativeIdentity.agent, claim.nativeIdentity.kind, claim.nativeIdentity.value,
            claim.attachment.state, claim.attachment.workspaceId, claim.attachment.paneId, claim.attachment.terminalId,
            claim.lastRejectedEvidenceFingerprint, claim.lastRejectedReason, claim.createdAt, claim.updatedAt
          );
          if (!this.bindings.projectCurrentRuntimeIdentityClaim({ claim, paneToken: input.paneToken })) {
            throw new RuntimeIdentityClaimStaleError();
          }
        });
      } catch (error) {
        if (isStaleClaimError(error)) return { outcome: "stale", claim: this.loadRuntimeIdentityClaim(claim.owner) };
        if (isCurrentIdentityUniquenessError(error)) return { outcome: "conflict", claim: this.loadRuntimeIdentityClaim(claim.owner) };
        throw error;
      }
      return { outcome: "claimed", claim: this.loadRuntimeIdentityClaim(claim.owner) };
    });
  }

  applyRuntimeIdentityTransition<Result>(input: {
    expected: readonly RuntimeIdentityTransitionFence[];
    release: readonly RuntimeIdentityTransitionFence[];
    targetOwner: RuntimeIdentityOwner;
    targetBindingId: string;
    claim: "if_complete" | "defer";
  }, apply: () => Result): Result {
    return this.context.transaction("sqlite.runtime-identity-claim.transition", () => {
      try {
        return this.context.savepoint("sqlite.runtime-identity-claim.transition-write", () => {
          for (const fence of input.expected) this.assertTransitionFence(fence);
          const result = apply();
          for (const fence of input.release) this.releaseClaim(fence);
          const target = this.bindings.getBinding(input.targetBindingId);
          if (!target || !sameOwner(input.targetOwner, target)) throw new RuntimeIdentityTransitionAbort("stale");
          this.persistTransitionTarget(target, input.claim);
          return result;
        });
      } catch (error) {
        const cause = unwrapSavepointError(error);
        if (cause instanceof RuntimeIdentityTransitionAbort) throw new Error(`Runtime identity transition ${cause.outcome}`);
        if (isCurrentIdentityUniquenessError(error)) throw new Error("Runtime identity transition conflict");
        throw error;
      }
    });
  }

  reconcileRuntimeIdentity(input: { bindingId: string; expectedPaneId: string; expectedGeneration: number; expectedSessionEpoch: number; pane: HerdrPane; decide: RuntimeIdentityReconciliationPolicy; recovery?: Omit<RecoverOrphanBindingProjectionInput, "bindingId" | "expectedPaneId" | "expectedGeneration" | "pane">; recoverOrphan?: (input: Omit<RecoverOrphanBindingProjectionInput, "bindingId" | "expectedPaneId" | "expectedGeneration" | "pane">) => { binding: Binding | null; outboxReserved: boolean; outcome: string } }): RuntimeIdentityReconciliationApplication {
    return this.context.transaction("sqlite.runtime-identity-claim.reconcile", () => {
      try {
        return this.context.savepoint("sqlite.runtime-identity-claim.reconcile-write", () => {
          const binding = this.bindings.getBinding(input.bindingId);
          if (!binding || binding.paneId !== input.expectedPaneId || input.pane.paneId !== input.expectedPaneId || binding.generation !== input.expectedGeneration
            || binding.sessionEpoch !== input.expectedSessionEpoch || (binding.lifecycle !== "active" && binding.lifecycle !== "draining")) return { outcome: "stale" };
          const owner = { bindingId: binding.id, bindingGeneration: binding.generation, sessionEpoch: binding.sessionEpoch };
          const claim = this.loadRuntimeIdentityClaim(owner) ?? compatibilityClaimFor(binding);
          const decision = input.decide({ binding, claim, pane: input.pane });
          if (decision.outcome === "stale") return { outcome: "stale" };
          if (decision.outcome === "unchanged_refusal") return { outcome: "unchanged_refusal", binding, reason: decision.reason };
          if (decision.outcome === "refused") {
            if (decision.reason === "native_session_mismatch" && this.hasExactPendingOrchestratorClear(binding, claim)) {
              return { outcome: "session_rotation_pending", binding };
            }
            this.persistRefusal(claim, decision.evidenceFingerprint, decision.reason);
            return { outcome: "refused", binding, reason: decision.reason, evidenceFingerprint: decision.evidenceFingerprint };
          }
          if (decision.outcome === "observe_unclaimed") {
            const withPaneToken = this.syncPaneToken(binding, input.pane);
            const observed = this.bindings.transitionBinding(withPaneToken.id, { type: "pane_observed", runtime: input.pane.agentState });
            return { outcome: "observed", binding: observed, terminalIdentityRefreshed: false, nativeSessionAdopted: false };
          }
          if (decision.outcome === "orphan_recovery") {
            if (!input.recoverOrphan || !input.recovery) return { outcome: "stale" };
            if (input.recovery.event.bindingId !== binding.id || input.recovery.view.bindingId !== binding.id || input.recovery.view.lastEventId !== input.recovery.event.eventId) return { outcome: "stale" };
            const recovered = input.recoverOrphan(input.recovery);
            if (recovered.outcome !== "recovered" || !recovered.binding) throw new RuntimeIdentityReconciliationAbort("stale");
            const claimed = this.claimCurrentRuntimeIdentity({ claim: currentClaimFor(binding, input.pane, "attached"), paneToken: input.pane.paneToken ?? null });
            if (claimed.outcome === "conflict") throw new RuntimeIdentityReconciliationAbort("conflict");
            if (claimed.outcome === "stale" || !claimed.claim) throw new RuntimeIdentityReconciliationAbort("stale");
            return { outcome: "recovered", binding: this.syncPaneToken(this.bindings.getBinding(binding.id)!, input.pane), outboxReserved: recovered.outboxReserved, event: input.recovery.event };
          }
          const attachmentState = claim.state === "current" ? claim.attachment.state : "attached";
          const claimed = this.claimCurrentRuntimeIdentity({ claim: currentClaimFor(binding, input.pane, attachmentState), paneToken: input.pane.paneToken ?? null });
          if (claimed.outcome === "conflict") throw new RuntimeIdentityReconciliationAbort("conflict");
          if (claimed.outcome === "stale" || !claimed.claim) throw new RuntimeIdentityReconciliationAbort("stale");
          const withPaneToken = this.syncPaneToken(this.bindings.getBinding(binding.id)!, input.pane);
          const observed = this.bindings.transitionBinding(withPaneToken.id, { type: "pane_observed", runtime: input.pane.agentState });
          return { outcome: decision.outcome === "adopt" ? "adopted" : decision.outcome === "terminal_refresh" ? "terminal_refreshed" : "observed", binding: observed, terminalIdentityRefreshed: decision.outcome === "terminal_refresh", nativeSessionAdopted: decision.outcome === "adopt" };
        });
      } catch (error) {
        const cause = unwrapSavepointError(error);
        if (cause instanceof RuntimeIdentityReconciliationAbort) return { outcome: cause.outcome };
        if (isCurrentIdentityUniquenessError(error)) return { outcome: "conflict" };
        throw error;
      }
    });
  }

  private hasExactPendingOrchestratorClear(binding: Binding, claim: RuntimeIdentityClaim): boolean {
    if (binding.kind !== "orchestrator" || claim.state !== "current") return false;
    return Boolean(this.database.prepare(`SELECT 1 FROM orchestrator_clear_operations
      WHERE binding_id = ? AND binding_generation = ? AND old_session_epoch = ?
        AND expected_workspace_id = ? AND expected_pane_id = ? AND expected_terminal_id = ?
        AND expected_session_source = ? AND expected_session_agent = ? AND expected_session_kind = ? AND expected_session_value = ?
        AND state IN ('rotating','rotation-uncertain') LIMIT 1`).get(
          claim.owner.bindingId, claim.owner.bindingGeneration, claim.owner.sessionEpoch,
          claim.attachment.workspaceId, claim.attachment.paneId, claim.attachment.terminalId,
          claim.nativeIdentity.source, claim.nativeIdentity.agent, claim.nativeIdentity.kind, claim.nativeIdentity.value
        ));
  }

  private syncPaneToken(binding: Binding, pane: HerdrPane): Binding {
    return pane.paneToken && pane.paneToken !== binding.paneToken
      ? this.bindings.persistBindingPatch(binding.id, { paneToken: pane.paneToken })
      : binding;
  }

  private persistRefusal(claim: RuntimeIdentityClaim, fingerprint: string, reason: string): void {
    const timestamp = new Date().toISOString();
    const nativeIdentity = claim.nativeIdentity;
    const attachment = claim.attachment;
    this.database.prepare(`INSERT INTO runtime_identity_claims(
      binding_id,binding_generation,session_epoch,state,native_session_source,native_session_agent,native_session_kind,native_session_value,
      attachment_state,workspace_id,pane_id,terminal_id,last_rejected_evidence_fingerprint,last_rejected_reason,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(binding_id,binding_generation,session_epoch) DO UPDATE SET
      last_rejected_evidence_fingerprint=excluded.last_rejected_evidence_fingerprint,
      last_rejected_reason=excluded.last_rejected_reason,updated_at=excluded.updated_at`).run(
      claim.owner.bindingId, claim.owner.bindingGeneration, claim.owner.sessionEpoch, claim.state,
      nativeIdentity?.source ?? null, nativeIdentity?.agent ?? null, nativeIdentity?.kind ?? null, nativeIdentity?.value ?? null,
      attachment?.state ?? null, attachment?.workspaceId ?? null, attachment?.paneId ?? null, attachment?.terminalId ?? null,
      fingerprint, reason, claim.createdAt || timestamp, timestamp
    );
  }

  private assertTransitionFence(fence: RuntimeIdentityTransitionFence): void {
    const binding = this.bindings.getBinding(fence.owner.bindingId);
    if (!binding || !sameOwner(fence.owner, binding) || binding.workspaceId !== fence.workspaceId || binding.paneId !== fence.paneId
      || binding.traexSessionId !== fence.terminalId || binding.attachment !== fence.attachment
      || !sameOptionalIdentity(bindingIdentity(binding), fence.nativeIdentity)) throw new RuntimeIdentityTransitionAbort("stale");
    const claim = this.loadRuntimeIdentityClaim(fence.owner);
    if (!claim) return;
    if (claim.state === "released") throw new RuntimeIdentityTransitionAbort("stale");
    const expectedClaimAttachment = fence.attachment === "orphaned" ? "orphaned"
      : fence.attachment === "attached" || fence.attachment === "degraded" ? "attached"
      : null;
    if ((claim.state === "current" || claim.state === "conflicted")
      && (!claim.nativeIdentity || !claim.attachment || !expectedClaimAttachment || !fence.nativeIdentity || !fence.paneId || !fence.terminalId
        || !sameNativeRuntimeIdentity(claim.nativeIdentity, fence.nativeIdentity)
        || claim.attachment.workspaceId !== fence.workspaceId || claim.attachment.paneId !== fence.paneId
        || claim.attachment.terminalId !== fence.terminalId || claim.attachment.state !== expectedClaimAttachment)) throw new RuntimeIdentityTransitionAbort("stale");
  }

  private releaseClaim(fence: RuntimeIdentityTransitionFence): void {
    const existing = this.loadRuntimeIdentityClaim(fence.owner);
    const timestamp = new Date().toISOString();
    const identity = existing?.nativeIdentity ?? fence.nativeIdentity;
    const attachment = existing?.attachment ?? (fence.paneId && fence.terminalId && (fence.attachment === "attached" || fence.attachment === "orphaned")
      ? { state: fence.attachment, workspaceId: fence.workspaceId, paneId: fence.paneId, terminalId: fence.terminalId }
      : null);
    this.database.prepare(`INSERT INTO runtime_identity_claims(
      binding_id,binding_generation,session_epoch,state,native_session_source,native_session_agent,native_session_kind,native_session_value,
      attachment_state,workspace_id,pane_id,terminal_id,last_rejected_evidence_fingerprint,last_rejected_reason,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(binding_id,binding_generation,session_epoch) DO UPDATE SET state='released',updated_at=excluded.updated_at`).run(
      fence.owner.bindingId, fence.owner.bindingGeneration, fence.owner.sessionEpoch, "released",
      identity?.source ?? null, identity?.agent ?? null, identity?.kind ?? null, identity?.value ?? null,
      attachment?.state ?? null, attachment?.workspaceId ?? null, attachment?.paneId ?? null, attachment?.terminalId ?? null,
      existing?.lastRejectedEvidenceFingerprint ?? null, existing?.lastRejectedReason ?? null, existing?.createdAt ?? timestamp, timestamp
    );
  }

  private persistTransitionTarget(binding: Binding, claimMode: "if_complete" | "defer"): void {
    const owner = { bindingId: binding.id, bindingGeneration: binding.generation, sessionEpoch: binding.sessionEpoch };
    const existing = this.loadRuntimeIdentityClaim(owner);
    const identity = bindingIdentity(binding);
    const complete = Boolean(binding.paneId && binding.traexSessionId && identity && (binding.attachment === "attached" || binding.attachment === "orphaned"));
    if (claimMode === "if_complete" && complete) {
      const timestamp = new Date().toISOString();
      const claimed = this.claimCurrentRuntimeIdentity({
        claim: createCurrentRuntimeIdentityClaim({
          owner,
          nativeIdentity: identity!,
          attachment: { state: binding.attachment as "attached" | "orphaned", workspaceId: binding.workspaceId, paneId: binding.paneId!, terminalId: binding.traexSessionId! },
          lastRejectedEvidenceFingerprint: null,
          lastRejectedReason: null,
          createdAt: existing?.createdAt ?? timestamp,
          updatedAt: timestamp
        }),
        paneToken: binding.paneToken
      });
      if (claimed.outcome === "conflict") throw new RuntimeIdentityTransitionAbort("conflict");
      if (claimed.outcome === "stale") throw new RuntimeIdentityTransitionAbort("stale");
      return;
    }
    if (existing?.state === "current") throw new RuntimeIdentityTransitionAbort("stale");
    const timestamp = new Date().toISOString();
    this.database.prepare(`INSERT INTO runtime_identity_claims(
      binding_id,binding_generation,session_epoch,state,native_session_source,native_session_agent,native_session_kind,native_session_value,
      attachment_state,workspace_id,pane_id,terminal_id,last_rejected_evidence_fingerprint,last_rejected_reason,created_at,updated_at
    ) VALUES (?,?,?,'unclaimed',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,?,?)
    ON CONFLICT(binding_id,binding_generation,session_epoch) DO UPDATE SET
      state='unclaimed',native_session_source=NULL,native_session_agent=NULL,native_session_kind=NULL,native_session_value=NULL,
      attachment_state=NULL,workspace_id=NULL,pane_id=NULL,terminal_id=NULL,last_rejected_evidence_fingerprint=NULL,last_rejected_reason=NULL,updated_at=excluded.updated_at`).run(
      owner.bindingId, owner.bindingGeneration, owner.sessionEpoch, existing?.createdAt ?? timestamp, timestamp
    );
  }
}

function currentClaimFor(binding: Binding, pane: HerdrPane, attachmentState: "attached" | "orphaned"): CurrentRuntimeIdentityClaim {
  if (!pane.terminalId || !pane.agentSession) throw new Error("Runtime identity reconciliation requires complete native session evidence");
  const timestamp = new Date().toISOString();
  return createCurrentRuntimeIdentityClaim({
    owner: { bindingId: binding.id, bindingGeneration: binding.generation, sessionEpoch: binding.sessionEpoch },
    nativeIdentity: pane.agentSession,
    attachment: { state: attachmentState, workspaceId: pane.workspaceId, paneId: pane.paneId, terminalId: pane.terminalId },
    lastRejectedEvidenceFingerprint: null, lastRejectedReason: null, createdAt: timestamp, updatedAt: timestamp
  });
}

function compatibilityClaimFor(binding: Binding): RuntimeIdentityClaim {
  const timestamp = binding.updatedAt;
  const owner = { bindingId: binding.id, bindingGeneration: binding.generation, sessionEpoch: binding.sessionEpoch };
  if (!binding.agentSessionSource || !binding.agentSessionAgent || !binding.agentSessionKind || !binding.agentSessionValue || !binding.paneId || !binding.traexSessionId || (binding.attachment !== "attached" && binding.attachment !== "orphaned")) {
    return createUnclaimedRuntimeIdentityClaim({ owner, lastRejectedEvidenceFingerprint: null, lastRejectedReason: null, createdAt: timestamp, updatedAt: timestamp });
  }
  return createCurrentRuntimeIdentityClaim({
    owner,
    nativeIdentity: { source: binding.agentSessionSource, agent: binding.agentSessionAgent, kind: binding.agentSessionKind, value: binding.agentSessionValue },
    attachment: { state: binding.attachment, workspaceId: binding.workspaceId, paneId: binding.paneId, terminalId: binding.traexSessionId },
    lastRejectedEvidenceFingerprint: null, lastRejectedReason: null, createdAt: timestamp, updatedAt: timestamp
  });
}

class RuntimeIdentityClaimStaleError extends Error {}
class RuntimeIdentityReconciliationAbort extends Error {
  constructor(readonly outcome: "stale" | "conflict") { super(outcome); }
}
class RuntimeIdentityTransitionAbort extends Error {
  constructor(readonly outcome: "stale" | "conflict") { super(outcome); }
}

function sameOwner(owner: RuntimeIdentityOwner, binding: Binding): boolean {
  return owner.bindingId === binding.id && owner.bindingGeneration === binding.generation && owner.sessionEpoch === binding.sessionEpoch;
}

function bindingIdentity(binding: Binding) {
  return binding.agentSessionSource && binding.agentSessionAgent && binding.agentSessionKind && binding.agentSessionValue
    ? { source: binding.agentSessionSource, agent: binding.agentSessionAgent, kind: binding.agentSessionKind, value: binding.agentSessionValue }
    : null;
}

function sameOptionalIdentity(left: ReturnType<typeof bindingIdentity>, right: RuntimeIdentityTransitionFence["nativeIdentity"]): boolean {
  return left === null || right === null ? left === right : sameNativeRuntimeIdentity(left, right);
}

function sameCurrentClaim(left: CurrentRuntimeIdentityClaim, right: CurrentRuntimeIdentityClaim): boolean {
  return left.nativeIdentity.source === right.nativeIdentity.source
    && left.nativeIdentity.agent === right.nativeIdentity.agent
    && left.nativeIdentity.kind === right.nativeIdentity.kind
    && left.nativeIdentity.value === right.nativeIdentity.value
    && left.attachment.state === right.attachment.state
    && left.attachment.workspaceId === right.attachment.workspaceId
    && left.attachment.paneId === right.attachment.paneId
    && left.attachment.terminalId === right.attachment.terminalId
    && left.lastRejectedEvidenceFingerprint === right.lastRejectedEvidenceFingerprint
    && left.lastRejectedReason === right.lastRejectedReason;
}

function sameBindingProjection(binding: Binding, claim: CurrentRuntimeIdentityClaim): boolean {
  return binding.workspaceId === claim.attachment.workspaceId
    && binding.paneId === claim.attachment.paneId
    && binding.traexSessionId === claim.attachment.terminalId
    && binding.agentSessionSource === claim.nativeIdentity.source
    && binding.agentSessionAgent === claim.nativeIdentity.agent
    && binding.agentSessionKind === claim.nativeIdentity.kind
    && binding.agentSessionValue === claim.nativeIdentity.value
    && binding.attachment === claim.attachment.state;
}

function isStaleClaimError(error: unknown): boolean {
  return unwrapSavepointError(error) instanceof RuntimeIdentityClaimStaleError;
}

function isCurrentIdentityUniquenessError(error: unknown): boolean {
  const cause = unwrapSavepointError(error);
  return cause instanceof Error && /UNIQUE constraint failed: runtime_identity_claims\.native_session_source/i.test(cause.message);
}

function unwrapSavepointError(error: unknown): unknown {
  return error instanceof SqliteSavepointOperationError ? error.operationError : error;
}
