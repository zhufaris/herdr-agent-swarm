import { describe, expect, it } from "vitest";
import { acceptModelSelection, markModelEffective, markModelUncertain, resolveCatalogModel, rollbackModelBeforeDispatch } from "../src/domain/model-selection.js";
import type { ModelPreference } from "../src/domain/model-selection.js";

const applying = (): ModelPreference => ({
  bindingId: "b1", bindingGeneration: 2, desiredModel: "GPT-5.4", desiredRevision: 3,
  effectiveModel: "GPT-5.2", effectiveRevision: 2, state: "applying", dispatchPromptId: "p1", preparedOperationId: "op1", updatedAt: "before"
});

describe("runtime model selection", () => {
  it("creates and replaces only pending revisions", () => {
    expect(acceptModelSelection(null, { bindingId: "b1", bindingGeneration: 2, currentBindingGeneration: 2, model: "GPT-5.4", updatedAt: "t1" })).toMatchObject({
      outcome: "accepted", preference: { desiredRevision: 1, desiredModel: "GPT-5.4", state: "pending" }
    });
    const pending = { ...applying(), state: "pending" as const, dispatchPromptId: null, preparedOperationId: null };
    expect(acceptModelSelection(pending, { bindingId: "b1", bindingGeneration: 2, currentBindingGeneration: 2, model: "GPT-5.5", updatedAt: "t2" })).toMatchObject({
      outcome: "accepted", preference: { desiredRevision: 4, desiredModel: "GPT-5.5", state: "pending" }
    });
    expect(acceptModelSelection(applying(), { bindingId: "b1", bindingGeneration: 2, currentBindingGeneration: 2, model: "GPT-5.5", updatedAt: "t2" })).toMatchObject({ outcome: "busy" });
    expect(acceptModelSelection({ ...applying(), state: "uncertain" }, { bindingId: "b1", bindingGeneration: 2, currentBindingGeneration: 2, model: "GPT-5.5", updatedAt: "t2" })).toMatchObject({ outcome: "busy" });
    expect(acceptModelSelection(null, { bindingId: "b1", bindingGeneration: 1, currentBindingGeneration: 2, model: "GPT-5.5", updatedAt: "t2" })).toEqual({ outcome: "stale", preference: null });
  });

  it("fences effective, rollback, and uncertain transitions by exact prompt and revision", () => {
    expect(markModelEffective(applying(), { promptId: "p1", revision: 3, updatedAt: "done" })).toMatchObject({ state: "effective", effectiveModel: "GPT-5.4", effectiveRevision: 3, dispatchPromptId: null });
    expect(markModelEffective(applying(), { promptId: "other", revision: 3, updatedAt: "done" })).toBeNull();
    expect(rollbackModelBeforeDispatch(applying(), { promptId: "p1", revision: 3, updatedAt: "retry" })).toMatchObject({ state: "pending", dispatchPromptId: null, preparedOperationId: null });
    expect(markModelUncertain(applying(), { promptId: "p1", revision: 3, updatedAt: "unknown" })).toMatchObject({ state: "uncertain", dispatchPromptId: "p1" });
  });

  it("resolves one bounded visible catalog name while preserving canonical spelling", () => {
    expect(resolveCatalogModel("gpt-5.4", ["GPT-5.4", "GPT-5.5"])).toEqual({ outcome: "resolved", name: "GPT-5.4" });
    expect(resolveCatalogModel("GPT", ["GPT", "gpt"])).toEqual({ outcome: "resolved", name: "GPT" });
    expect(resolveCatalogModel("GpT", ["GPT", "gpt"])).toEqual({ outcome: "ambiguous" });
    expect(resolveCatalogModel("missing", ["GPT-5.4"])).toEqual({ outcome: "not_found" });
    for (const name of ["", " hidden", ".internal", "bad\nname", "x".repeat(129)]) expect(resolveCatalogModel(name, [name])).toEqual({ outcome: "invalid" });
  });
});
