import { describe, expect, it } from "vitest";
import { LarkSetupProbe, NodeSetupHttpClient } from "../src/adapters/lark-setup-probe.js";
import { evaluateSetupChecks } from "../src/setup/setup-checks.js";
import type { SetupDraft, SetupHttpClient, SetupHttpRequest } from "../src/setup/setup-types.js";

const secret = "top-secret-value";
const token = "tenant-token-value";

function draft(): SetupDraft {
  return {
    environment: {
      LARK_APP_ID: "cli_app",
      LARK_APP_SECRET: secret,
      LARK_CHAT_ID: "oc_chat",
      LARK_BOT_OPEN_ID: "ou_bot"
    },
    registry: { defaultProjectId: "main", projects: [] }
  };
}

class FakeHttpClient implements SetupHttpClient {
  readonly requests: SetupHttpRequest[] = [];

  constructor(private readonly responses: Array<{ status: number; body: unknown } | Error>) {}

  async request(input: SetupHttpRequest): Promise<{ status: number; body: unknown }> {
    this.requests.push(input);
    const response = this.responses.shift();
    if (!response) throw new Error("unexpected request");
    if (response instanceof Error) throw response;
    return response;
  }
}

function successfulResponses(botOpenId = "ou_bot"): Array<{ status: number; body: unknown }> {
  return [
    { status: 200, body: { code: 0, msg: "ok", data: { tenant_access_token: token, expire: 7200 } } },
    { status: 200, body: { code: 0, msg: "ok", data: { name: "Swarm Chat", chat_mode: "topic" } } },
    { status: 200, body: { code: 0, msg: "ok", bot: { open_id: botOpenId, app_name: "Swarm Bot" } } }
  ];
}

function serialized(value: unknown): string {
  return value instanceof Error ? `${value.name}: ${value.message}` : JSON.stringify(value);
}

function expectRedacted(value: unknown): void {
  expect(serialized(value)).not.toContain(secret);
  expect(serialized(value)).not.toContain(token);
}

describe("LarkSetupProbe", () => {
  it("authenticates, reads the chat, and verifies bot identity without resource writes", async () => {
    const http = new FakeHttpClient(successfulResponses());
    const checks = await new LarkSetupProbe(http, 1234).check(draft());

    expect(checks).toEqual([
      { id: "lark.auth", status: "pass", summary: "Lark credentials authenticated" },
      { id: "lark.chat", status: "pass", summary: 'Target chat is readable: "Swarm Chat"' },
      { id: "lark.bot", status: "pass", summary: "Bot identity matches the configured open ID" }
    ]);
    expect(http.requests.map((request) => request.method)).toEqual(["POST", "GET", "GET"]);
    expect(http.requests.filter((request) => request.method !== "GET")).toHaveLength(1);
    expect(http.requests).toEqual([
      expect.objectContaining({
        method: "POST",
        url: "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
        body: JSON.stringify({ app_id: "cli_app", app_secret: secret }),
        timeoutMs: 1234
      }),
      expect.objectContaining({ method: "GET", url: "https://open.feishu.cn/open-apis/im/v1/chats/oc_chat", headers: { Authorization: `Bearer ${token}` } }),
      expect.objectContaining({ method: "GET", url: "https://open.feishu.cn/open-apis/bot/v3/info", headers: { Authorization: `Bearer ${token}` } })
    ]);
    expectRedacted(checks);
  });

  it.each([
    ["an authentication rejection", { status: 200, body: { code: 10003, msg: `bad credentials ${secret}` } }, "lark.auth", "fail"],
    ["HTTP 401", { status: 401, body: { code: 99991663, msg: secret } }, "lark.auth", "fail"]
  ] as const)("maps %s to a redacted authentication failure", async (_name, response, id, status) => {
    const checks = await new LarkSetupProbe(new FakeHttpClient([response])).check(draft());
    expect(checks).toEqual([expect.objectContaining({ id, status })]);
    expectRedacted(checks);
  });

  it.each([
    [403, { code: 99991672, msg: `forbidden ${token}` }, "fail", "Grant the bot permission to read the target chat and add it to the group."],
    [404, { code: 230001, msg: "not found" }, "fail", "Verify LARK_CHAT_ID and ensure the bot is in the target group."],
    [429, { code: 99991400, msg: "rate limited" }, "fail", "Retry the Lark connectivity check after the rate limit clears."]
  ] as const)("maps chat HTTP %i to a stable result", async (statusCode, body, status, remediation) => {
    const http = new FakeHttpClient([successfulResponses()[0]!, { status: statusCode, body }]);
    const checks = await new LarkSetupProbe(http).check(draft());
    expect(checks.at(-1)).toEqual(expect.objectContaining({ id: "lark.chat", status, remediation }));
    if (status === "fail") expect(evaluateSetupChecks(checks).canStart).toBe(false);
    expect(http.requests).toHaveLength(2);
    expectRedacted(checks);
  });

  it("maps a timeout to a startup-blocking failure without leaking the thrown message", async () => {
    const error = new DOMException(`request timed out ${secret} ${token}`, "TimeoutError");
    const checks = await new LarkSetupProbe(new FakeHttpClient([successfulResponses()[0]!, error])).check(draft());
    expect(checks.at(-1)).toEqual({
      id: "lark.chat",
      status: "fail",
      summary: "Lark chat check timed out",
      remediation: "Retry the Lark connectivity check when the service is reachable."
    });
    expect(evaluateSetupChecks(checks).canStart).toBe(false);
    expectRedacted(checks);
  });

  it("maps a generic network error to a startup-blocking failure", async () => {
    const error = new Error(`socket unavailable ${secret} ${token}`);
    const checks = await new LarkSetupProbe(new FakeHttpClient([successfulResponses()[0]!, error])).check(draft());
    expect(checks.at(-1)).toEqual({
      id: "lark.chat",
      status: "fail",
      summary: "Lark chat check was unavailable",
      remediation: "Retry the Lark connectivity check when the service is reachable."
    });
    expect(evaluateSetupChecks(checks).canStart).toBe(false);
    expectRedacted(checks);
  });

  it("maps an oversized transport response through the probe to a startup-blocking failure", async () => {
    const responses = [
      new Response(JSON.stringify(successfulResponses()[0]!.body), { status: 200 }),
      new Response(JSON.stringify({ code: 0, data: { name: "x".repeat(200) } }), { status: 200 })
    ];
    const http = new NodeSetupHttpClient(async () => responses.shift()!, 128);
    const checks = await new LarkSetupProbe(http).check(draft());
    expect(checks.at(-1)).toEqual({
      id: "lark.chat",
      status: "fail",
      summary: "Lark chat returned an oversized response",
      remediation: "Retry the check and inspect Lark service health if the response remains invalid."
    });
    expect(evaluateSetupChecks(checks).canStart).toBe(false);
    expectRedacted(checks);
  });

  it("maps malformed transport JSON through the probe to a startup-blocking failure", async () => {
    const responses = [
      new Response(JSON.stringify(successfulResponses()[0]!.body), { status: 200 }),
      new Response(`not-json ${secret} ${token}`, { status: 200 })
    ];
    const http = new NodeSetupHttpClient(async () => responses.shift()!, 1024);
    const checks = await new LarkSetupProbe(http).check(draft());
    expect(checks.at(-1)).toEqual({
      id: "lark.chat",
      status: "fail",
      summary: "Lark chat returned malformed JSON",
      remediation: "Retry the check and inspect Lark service health if the response remains invalid."
    });
    expect(evaluateSetupChecks(checks).canStart).toBe(false);
    expectRedacted(checks);
  });

  it("fails closed on malformed token and chat response data", async () => {
    const malformedAuth = await new LarkSetupProbe(new FakeHttpClient([{ status: 200, body: { code: 0, data: {} } }])).check(draft());
    expect(malformedAuth).toEqual([expect.objectContaining({ id: "lark.auth", status: "fail", summary: "Lark authentication returned malformed data" })]);

    const malformedChat = await new LarkSetupProbe(new FakeHttpClient([successfulResponses()[0]!, { status: 200, body: { code: 0, data: "wrong" } }])).check(draft());
    expect(malformedChat.at(-1)).toEqual(expect.objectContaining({ id: "lark.chat", status: "fail", summary: "Lark chat lookup returned malformed data" }));
    expectRedacted([malformedAuth, malformedChat]);
  });

  it("warns when bot identity is unavailable because the read scope is missing", async () => {
    const responses = successfulResponses().slice(0, 2);
    responses.push({ status: 403, body: { code: 99991672, msg: `scope denied ${token}` } });
    const checks = await new LarkSetupProbe(new FakeHttpClient(responses)).check(draft());
    expect(checks.at(-1)).toEqual({
      id: "lark.bot",
      status: "warning",
      summary: "Lark did not expose bot identity with the granted read scope",
      remediation: "Verify LARK_BOT_OPEN_ID in the Lark developer console or event test data."
    });
    expectRedacted(checks);
  });

  it("maps bot rate limiting to a startup-blocking failure", async () => {
    const responses = successfulResponses().slice(0, 2);
    responses.push({ status: 429, body: { code: 99991400, msg: `rate limited ${token}` } });
    const checks = await new LarkSetupProbe(new FakeHttpClient(responses)).check(draft());
    expect(checks.at(-1)).toEqual(expect.objectContaining({ id: "lark.bot", status: "fail" }));
    expect(evaluateSetupChecks(checks).canStart).toBe(false);
    expectRedacted(checks);
  });

  it("fails when the returned bot open ID differs", async () => {
    const checks = await new LarkSetupProbe(new FakeHttpClient(successfulResponses("ou_other"))).check(draft());
    expect(checks.at(-1)).toEqual({
      id: "lark.bot",
      status: "fail",
      summary: "Configured bot open ID does not match the authenticated application",
      remediation: "Replace LARK_BOT_OPEN_ID with the bot open ID shown in the Lark developer console."
    });
    expectRedacted(checks);
  });

  it("fails closed when bot data is malformed", async () => {
    const responses = successfulResponses().slice(0, 2);
    responses.push({ status: 200, body: { code: 0, bot: {} } });
    const checks = await new LarkSetupProbe(new FakeHttpClient(responses)).check(draft());
    expect(checks.at(-1)).toEqual(expect.objectContaining({ id: "lark.bot", status: "fail", summary: "Lark bot lookup returned malformed data" }));
    expectRedacted(checks);
  });
});

describe("NodeSetupHttpClient", () => {
  it("parses a bounded JSON response through the injected fetch", async () => {
    const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    const client = new NodeSetupHttpClient(async (input, init) => {
      calls.push({ input, ...(init ? { init } : {}) });
      return new Response(JSON.stringify({ code: 0 }), { status: 200 });
    }, 1024);

    await expect(client.request({ method: "GET", url: "https://example.test/read", timeoutMs: 50 })).resolves.toEqual({ status: 200, body: { code: 0 } });
    expect(calls).toHaveLength(1);
  });

  it("rejects malformed JSON and oversized response bodies without echoing content", async () => {
    const malformed = new NodeSetupHttpClient(async () => new Response(`not-json ${secret}`), 1024);
    await expect(malformed.request({ method: "GET", url: "https://example.test/read", timeoutMs: 50 })).rejects.toThrow("malformed JSON");

    const oversized = new NodeSetupHttpClient(async () => new Response("x".repeat(17)), 16);
    await expect(oversized.request({ method: "GET", url: "https://example.test/read", timeoutMs: 50 })).rejects.toThrow("response body exceeded 16 bytes");
  });
});
