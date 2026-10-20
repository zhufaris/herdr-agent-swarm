import { describe, expect, it, vi } from "vitest";
import { listTraexModelsFromCli } from "../src/runtime/traex-model-protocol.js";

describe("TraeX model protocol", () => {
  it("parses the bounded public CLI catalog", async () => {
    const runner = { run: vi.fn(async () => ({
      stdout: JSON.stringify([
        { name: "GPT-5.5", config_name: "gpt-5-5", provider: "trae" },
        { name: "Seed-2.1-Pro-0915", provider: "trae" }
      ]),
      stderr: ""
    })) };

    await expect(listTraexModelsFromCli(runner, "traex", 1_000)).resolves.toEqual([
      { id: "gpt-5-5", name: "GPT-5.5", displayName: "GPT-5.5" },
      { id: "Seed-2.1-Pro-0915", name: "Seed-2.1-Pro-0915", displayName: "Seed-2.1-Pro-0915" }
    ]);
    expect(runner.run).toHaveBeenCalledWith("traex", ["models", "--json"], 1_000);
  });

  it.each([
    ["invalid JSON", "{"],
    ["non-list JSON", "{}"],
    ["malformed entry", "[{}]"],
    ["duplicate model", '[{"name":"GPT-5.5"},{"name":"GPT-5.5"}]']
  ])("fails closed for %s", async (_case, stdout) => {
    const runner = { run: vi.fn(async () => ({ stdout, stderr: "" })) };
    await expect(listTraexModelsFromCli(runner, "traex", 1_000)).rejects.toThrow();
  });

  it("rejects an oversized CLI response before parsing it", async () => {
    const runner = { run: vi.fn(async () => ({ stdout: " ".repeat(256 * 1024 + 1), stderr: "" })) };
    await expect(listTraexModelsFromCli(runner, "traex", 1_000)).rejects.toThrow(/byte limit/i);
  });
});
