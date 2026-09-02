import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("README source installation guide", () => {
  it("documents one complete source install and upgrade path", async () => {
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
    expect(readme.match(/^## Install from source$/gm)).toHaveLength(1);

    const section = readme.split("## Install from source")[1]?.split(/^## /m)[0] ?? "";
    const orderedCommands = [
      "npm ci",
      "npm run build",
      "npm run swarm:setup",
      "./install.sh",
      "npm run swarm:start",
      "npm run swarm:status"
    ];
    let cursor = -1;
    for (const command of orderedCommands) {
      const next = section.indexOf(command, cursor + 1);
      expect(next, `${command} must appear in installation order`).toBeGreaterThan(cursor);
      cursor = next;
    }

    expect(section).toContain("http://127.0.0.1:8787/ready");
    expect(section).toMatch(/enables[\s\S]{0,120}does not\s+start/i);
    expect(section).toContain("npm run swarm:restart");
    expect(section).toContain("npm run swarm:restart -- --force");
    expect(section).toMatch(/detach(?:es|ed)[\s\S]{0,120}without replay/i);
  });
});
