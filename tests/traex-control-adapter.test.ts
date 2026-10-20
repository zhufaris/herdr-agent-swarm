import { describe, expect, it, vi } from "vitest";
import { TraexControlAdapter } from "../src/adapters/traex-control-adapter.js";
import { listTraexModelsFromCli } from "../src/runtime/traex-model-protocol.js";

const session = { source: "herdr:traex", agent: "traex", kind: "id" as const, value: "01a03eb1-c193-7531-83c0-e6c6f70143d4" };
describe("TraexControlAdapter", () => {
  it("lists models through the public TraeX CLI", async () => {
    const run = vi.fn(async () => ({
      stdout: JSON.stringify([{ name: "GPT-5.4", config_name: "gpt-5-4", provider: "trae" }]),
      stderr: ""
    }));
    const adapter = control({ run });

    await expect(adapter.listModels(session)).resolves.toEqual([{ id: "gpt-5-4", name: "GPT-5.4", displayName: "GPT-5.4" }]);
    expect(run).toHaveBeenCalledWith("traex", ["models", "--json"], 1_000);
  });

  it("uses only the public TraeX CLI model catalog", async () => {
    const run = vi.fn(async () => ({
      stdout: JSON.stringify([
        { name: "GPT-5.4", config_name: "gpt-5-4", provider: "trae" },
        { name: "Seed-2.1-Pro-0915", provider: "trae" }
      ]),
      stderr: ""
    }));
    const adapter = control({ run });

    await expect(adapter.listModels(session)).resolves.toEqual([
      { id: "gpt-5-4", name: "GPT-5.4", displayName: "GPT-5.4" },
      { id: "Seed-2.1-Pro-0915", name: "Seed-2.1-Pro-0915", displayName: "Seed-2.1-Pro-0915" }
    ]);
    expect(run).toHaveBeenCalledWith("traex", ["models", "--json"], 1_000);
  });

  it.each(["herdr:codex", "herdr-traex-shim"])("rejects legacy TraeX source %s", async (source) => {
    const run = vi.fn(async () => ({ stdout: "[]", stderr: "" }));
    const adapter = control({ run });
    await expect(adapter.listModels({ ...session, source })).rejects.toThrow("Session does not support TraeX control");
    expect(run).not.toHaveBeenCalled();
  });
});

function control(runner = { run: vi.fn(async () => ({ stdout: "[]", stderr: "" })) }) {
  return new TraexControlAdapter(1_000, runner, "traex", listTraexModelsFromCli);
}
