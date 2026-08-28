import { describe, expect, it } from "vitest";
import { classifyAction, fingerprintAction, type ApprovalAction } from "../src/domain/approval-policy.js";

const policy = {
  workspaceRoots: ["/repo"],
  remotelyApprovableEffects: ["create-issue"]
};

describe("approval policy", () => {
  it("treats configured workspace work, local tests, and same-project worker calls as routine", () => {
    expect(classifyAction({ kind: "workspace-read", path: "/repo/src/main.ts" }, policy)).toBe("routine");
    expect(classifyAction({ kind: "workspace-write", path: "/repo/docs/note.md" }, policy)).toBe("routine");
    expect(classifyAction({ kind: "local-test", cwd: "/repo", argv: ["npm", "test"] }, policy)).toBe("routine");
    expect(classifyAction({ kind: "primary-worker-call", projectId: "p1", workerProjectId: "p1", workerInstanceId: "w1" }, policy)).toBe("routine");
  });

  it("allows only explicitly configured auditable external effects to use remote confirmation", () => {
    expect(classifyAction({ kind: "external-effect", effect: "create-issue", resource: "repo/acme#new" }, policy)).toBe("remote-confirmation");
    expect(classifyAction({ kind: "external-effect", effect: "send-email", resource: "ops@example.com" }, policy)).toBe("local-only");
  });

  it.each<ApprovalAction>([
    { kind: "git-push", remote: "origin", branch: "main" },
    { kind: "deploy", environment: "production" },
    { kind: "delete", path: "/repo/build" },
    { kind: "credential-access", resource: "LARK_APP_SECRET" },
    { kind: "permission-bypass", mechanism: "--dangerously-skip-permissions" },
    { kind: "workspace-read", path: "/etc/shadow" },
    { kind: "destructive-command", argv: ["git", "reset", "--hard"] },
    { kind: "native-approval", prompt: "Allow arbitrary shell command?" }
  ])("keeps $kind local-only", (action) => {
    expect(classifyAction(action, policy)).toBe("local-only");
  });

  it("classifies local commits as routine only inside a configured workspace", () => {
    expect(classifyAction({ kind: "git-commit", cwd: "/repo", paths: ["src/main.ts"] }, policy)).toBe("routine");
    expect(classifyAction({ kind: "git-commit", cwd: "/tmp/other", paths: ["secret"] }, policy)).toBe("local-only");
  });

  it("creates deterministic canonical fingerprints and invalidates changed actions", () => {
    const first = { kind: "external-effect" as const, effect: "create-issue", resource: "repo/acme#new", parameters: { title: "Bug", labels: ["p1", "bug"] } };
    const reordered = { parameters: { labels: ["p1", "bug"], title: "Bug" }, resource: "repo/acme#new", effect: "create-issue", kind: "external-effect" as const };
    const changed = { ...first, parameters: { ...first.parameters, title: "Different" } };

    expect(fingerprintAction(first)).toBe("sha256:5b85888d887f27a764216d308aff48094d0bbb28840588f1ab5973099cfbee55");
    expect(fingerprintAction(reordered)).toBe(fingerprintAction(first));
    expect(fingerprintAction(changed)).not.toBe(fingerprintAction(first));
  });
});
