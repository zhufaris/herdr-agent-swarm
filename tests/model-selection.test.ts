import { describe, expect, it } from "vitest";
import { RuntimeModelPreference, resolveCatalogModel } from "../src/domain/model-selection.js";
import type { ModelPreference } from "../src/domain/model-selection.js";

const applying = (): ModelPreference => ({
  bindingId: "b1", bindingGeneration: 2, desiredModel: "GPT-5.4", desiredRevision: 3,
  effectiveModel: "GPT-5.2", effectiveRevision: 2, state: "applying", dispatchPromptId: "p1", preparedOperationId: "op1", updatedAt: "before"
});

describe("runtime model selection", () => {
  const lifecycle = new RuntimeModelPreference();

  it("owns selection, exact dispatch evidence, and presentation snapshots behind one interface", () => {
    const selected = lifecycle.request(null, {
      bindingId: "b1", bindingGeneration: 2, currentBindingGeneration: 2,
      model: "GPT-5.4", updatedAt: "selected"
    });
    expect(selected).toMatchObject({ outcome: "accepted", preference: { state: "pending", desiredRevision: 1 } });
    if (selected.outcome !== "accepted") throw new Error("selection was not accepted");

    const claimed = lifecycle.recordEvidence(selected.preference, {
      kind: "claimed", bindingGeneration: 2, promptId: "p1", revision: 1, updatedAt: "claimed"
    });
    expect(claimed).toMatchObject({ state: "applying", dispatchPromptId: "p1", preparedOperationId: null });
    expect(lifecycle.snapshot(claimed)).toEqual({
      state: "applying", effective: null, desired: { model: "GPT-5.4", revision: 1 }, promptPinned: true
    });

    const prepared = lifecycle.recordEvidence(claimed, {
      kind: "prepared", bindingGeneration: 2, promptId: "p1", revision: 1, operationId: "op1", updatedAt: "prepared"
    });
    expect(prepared).toMatchObject({ state: "applying", preparedOperationId: "op1" });
    const effective = lifecycle.recordEvidence(prepared, {
      kind: "accepted", bindingGeneration: 2, promptId: "p1", revision: 1, operationId: "op1", turnId: "turn-1", updatedAt: "accepted"
    });
    expect(lifecycle.snapshot(effective)).toEqual({
      state: "effective", effective: { model: "GPT-5.4", revision: 1 }, desired: null, promptPinned: false
    });
  });

  it("derives rollback versus uncertain from durable dispatch evidence", () => {
    const beforePrepare = { ...applying(), preparedOperationId: null };
    expect(lifecycle.recordEvidence(beforePrepare, {
      kind: "dispatch_failed", bindingGeneration: 2, promptId: "p1", revision: 3, updatedAt: "failed"
    })).toMatchObject({ state: "pending", dispatchPromptId: null });
    expect(lifecycle.recordEvidence(applying(), {
      kind: "dispatch_failed", bindingGeneration: 2, promptId: "p1", revision: 3, updatedAt: "failed"
    })).toMatchObject({ state: "uncertain", dispatchPromptId: "p1", preparedOperationId: "op1" });
    expect(lifecycle.recordEvidence(applying(), {
      kind: "prepare_aborted", bindingGeneration: 2, promptId: "p1", revision: 3, operationId: "op1", updatedAt: "aborted"
    })).toMatchObject({ state: "pending", dispatchPromptId: null, preparedOperationId: null });
  });

  it("rejects dispatch evidence that misses any durable fence", () => {
    for (const evidence of [
      { kind: "prepared" as const, bindingGeneration: 1, promptId: "p1", revision: 3, operationId: "op1", updatedAt: "now" },
      { kind: "prepared" as const, bindingGeneration: 2, promptId: "other", revision: 3, operationId: "op1", updatedAt: "now" },
      { kind: "prepared" as const, bindingGeneration: 2, promptId: "p1", revision: 4, operationId: "op1", updatedAt: "now" }
    ]) expect(lifecycle.recordEvidence(applying(), evidence)).toBeNull();
    expect(lifecycle.recordEvidence(applying(), {
      kind: "accepted", bindingGeneration: 2, promptId: "p1", revision: 3, operationId: "other", turnId: "turn-1", updatedAt: "now"
    })).toBeNull();
  });

  it("projects absent, pending, and uncertain preferences without leaking dispatch identities", () => {
    expect(lifecycle.snapshot(null)).toEqual({ state: "none", effective: null, desired: null, promptPinned: false });
    expect(lifecycle.snapshot({ ...applying(), state: "pending", dispatchPromptId: null, preparedOperationId: null })).toEqual({
      state: "pending", effective: { model: "GPT-5.2", revision: 2 }, desired: { model: "GPT-5.4", revision: 3 }, promptPinned: false
    });
    expect(lifecycle.snapshot({ ...applying(), state: "uncertain" })).toEqual({
      state: "uncertain", effective: { model: "GPT-5.2", revision: 2 }, desired: { model: "GPT-5.4", revision: 3 }, promptPinned: true
    });
  });

  it("creates and replaces only pending revisions", () => {
    expect(lifecycle.request(null, { bindingId: "b1", bindingGeneration: 2, currentBindingGeneration: 2, model: "GPT-5.4", updatedAt: "t1" })).toMatchObject({
      outcome: "accepted", preference: { desiredRevision: 1, desiredModel: "GPT-5.4", state: "pending" }
    });
    const pending = { ...applying(), state: "pending" as const, dispatchPromptId: null, preparedOperationId: null };
    expect(lifecycle.request(pending, { bindingId: "b1", bindingGeneration: 2, currentBindingGeneration: 2, model: "GPT-5.5", updatedAt: "t2" })).toMatchObject({
      outcome: "accepted", preference: { desiredRevision: 4, desiredModel: "GPT-5.5", state: "pending" }
    });
    expect(lifecycle.request(applying(), { bindingId: "b1", bindingGeneration: 2, currentBindingGeneration: 2, model: "GPT-5.5", updatedAt: "t2" })).toMatchObject({ outcome: "busy" });
    expect(lifecycle.request({ ...applying(), state: "uncertain" }, { bindingId: "b1", bindingGeneration: 2, currentBindingGeneration: 2, model: "GPT-5.5", updatedAt: "t2" })).toMatchObject({ outcome: "busy" });
    expect(lifecycle.request(null, { bindingId: "b1", bindingGeneration: 1, currentBindingGeneration: 2, model: "GPT-5.5", updatedAt: "t2" })).toEqual({ outcome: "stale", preference: null });
  });

  it("fences effective, rollback, and uncertain evidence by exact prompt and revision", () => {
    expect(lifecycle.recordEvidence(applying(), { kind: "accepted", bindingGeneration: 2, promptId: "p1", revision: 3, operationId: "op1", turnId: "turn-1", updatedAt: "done" })).toMatchObject({ state: "effective", effectiveModel: "GPT-5.4", effectiveRevision: 3, dispatchPromptId: null });
    expect(lifecycle.recordEvidence(applying(), { kind: "accepted", bindingGeneration: 2, promptId: "other", revision: 3, operationId: "op1", turnId: "turn-1", updatedAt: "done" })).toBeNull();
    expect(lifecycle.recordEvidence(applying(), { kind: "prepare_aborted", bindingGeneration: 2, promptId: "p1", revision: 3, operationId: "op1", updatedAt: "retry" })).toMatchObject({ state: "pending", dispatchPromptId: null, preparedOperationId: null });
    expect(lifecycle.recordEvidence(applying(), { kind: "dispatch_failed", bindingGeneration: 2, promptId: "p1", revision: 3, updatedAt: "unknown" })).toMatchObject({ state: "uncertain", dispatchPromptId: "p1" });
  });

  it("resolves one bounded visible catalog name while preserving canonical spelling", () => {
    expect(resolveCatalogModel("gpt-5.4", ["GPT-5.4", "GPT-5.5"])).toEqual({ outcome: "resolved", name: "GPT-5.4" });
    expect(resolveCatalogModel("GPT", ["GPT", "gpt"])).toEqual({ outcome: "resolved", name: "GPT" });
    expect(resolveCatalogModel("GpT", ["GPT", "gpt"])).toEqual({ outcome: "ambiguous" });
    expect(resolveCatalogModel("missing", ["GPT-5.4"])).toEqual({ outcome: "not_found" });
    for (const name of ["", " hidden", ".internal", "bad\nname", "x".repeat(129)]) expect(resolveCatalogModel(name, [name])).toEqual({ outcome: "invalid" });
  });
});
