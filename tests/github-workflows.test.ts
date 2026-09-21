import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

interface Step { uses?: string; run?: string; with?: Record<string, unknown> }
interface Workflow {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  concurrency?: { "cancel-in-progress"?: boolean };
  jobs: Record<string, { steps: Step[] }>;
}

function workflow(name: string): Workflow {
  return parse(readFileSync(resolve(`.github/workflows/${name}`), "utf8")) as Workflow;
}

function commands(value: Workflow): string {
  return Object.values(value.jobs).flatMap((job) => job.steps.map((step) => step.run ?? "")).join("\n");
}

function commandOrder(value: Workflow): string[] {
  return Object.values(value.jobs).flatMap((job) => job.steps.map((step) => step.run ?? ""));
}

function actionReferences(value: Workflow): string[] {
  return Object.values(value.jobs).flatMap((job) => job.steps.flatMap((step) => step.uses ? [step.uses] : []));
}

describe("GitHub workflows", () => {
  it("keeps CI read-only, cancellable, and complete", () => {
    const ci = workflow("ci.yml");
    expect(ci.on).toHaveProperty("pull_request");
    expect(ci.on).toMatchObject({ push: { branches: ["main"] } });
    expect(ci.permissions).toEqual({ contents: "read" });
    expect(ci.concurrency?.["cancel-in-progress"]).toBe(true);
    expect(commands(ci)).toContain("npm ci");
    expect(commands(ci)).toContain("npm test");
    expect(commands(ci)).toContain("npm run build");
    expect(commands(ci)).not.toContain("npm run typecheck");
    expect(commands(ci)).toContain("npm run public:audit");
    expect(commandOrder(ci).indexOf("npm run build")).toBeLessThan(commandOrder(ci).indexOf("npm test"));
  });

  it("publishes only tagged verified builds as GitHub assets", () => {
    const release = workflow("release.yml");
    expect(release.on).toMatchObject({ push: { tags: ["v*"] } });
    expect(release.permissions).toEqual({ contents: "write" });
    expect(release.concurrency?.["cancel-in-progress"]).toBe(false);
    expect(commands(release)).toContain("npm run release:package");
    expect(commands(release)).toContain("npm test");
    expect(commands(release)).toContain("npm run build");
    expect(commands(release)).not.toContain("npm run typecheck");
    expect(commands(release)).toContain("npm run public:audit");
    expect(commandOrder(release).indexOf("npm run build")).toBeLessThan(commandOrder(release).indexOf("npm test"));
    expect(commands(release)).toContain("sha256sum --check SHA256SUMS");
    expect(actionReferences(release).some((reference) => reference.startsWith("softprops/action-gh-release@"))).toBe(true);
  });

  it("pins every external action and disables checkout credentials", () => {
    for (const name of ["ci.yml", "release.yml"]) {
      const value = workflow(name);
      for (const reference of actionReferences(value)) expect(reference).toMatch(/^[^@]+@[a-f0-9]{40}$/);
      for (const job of Object.values(value.jobs)) {
        for (const step of job.steps.filter((candidate) => candidate.uses?.startsWith("actions/checkout@"))) {
          expect(step.with?.["persist-credentials"]).toBe(false);
        }
      }
    }
  });
});
