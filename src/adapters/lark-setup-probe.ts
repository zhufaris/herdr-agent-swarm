import type { SetupCheck, SetupDraft, SetupHttpClient, SetupHttpRequest } from "../setup/setup-types.js";

const LARK_BASE_URL = "https://open.feishu.cn/open-apis";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type ProbeStage = "auth" | "chat" | "bot";

class SetupHttpResponseError extends Error {
  constructor(readonly kind: "malformed" | "oversized", message: string) {
    super(message);
    this.name = "SetupHttpResponseError";
  }
}

export class NodeSetupHttpClient implements SetupHttpClient {
  constructor(
    private readonly fetchImplementation: Fetch = globalThis.fetch,
    private readonly maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES
  ) {}

  async request(input: SetupHttpRequest): Promise<{ status: number; body: unknown }> {
    const response = await this.fetchImplementation(input.url, {
      method: input.method,
      ...(input.headers ? { headers: input.headers } : {}),
      ...(input.body === undefined ? {} : { body: input.body }),
      signal: AbortSignal.timeout(input.timeoutMs)
    });
    const text = await readBoundedResponse(response, this.maxResponseBytes);
    try {
      return { status: response.status, body: JSON.parse(text) as unknown };
    } catch {
      throw new SetupHttpResponseError("malformed", "Lark response contained malformed JSON");
    }
  }
}

export class LarkSetupProbe {
  constructor(
    private readonly http: SetupHttpClient = new NodeSetupHttpClient(),
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS
  ) {}

  async check(draft: SetupDraft): Promise<SetupCheck[]> {
    const appId = draft.environment.LARK_APP_ID;
    const appSecret = draft.environment.LARK_APP_SECRET;
    const chatId = draft.environment.LARK_CHAT_ID;
    const configuredBotOpenId = draft.environment.LARK_BOT_OPEN_ID;
    if (!appId || !appSecret) {
      return [fail("lark.auth", "Lark application credentials are missing", "Set LARK_APP_ID and LARK_APP_SECRET.")];
    }

    const auth = await this.safeRequest("auth", {
      method: "POST",
      url: `${LARK_BASE_URL}/auth/v3/tenant_access_token/internal`,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      timeoutMs: this.timeoutMs
    });
    if ("check" in auth) return [auth.check];
    const authBody = record(auth.response.body);
    const authCode = number(authBody?.code);
    if (auth.response.status === 401 || auth.response.status === 403 || (authCode !== undefined && authCode !== 0)) {
      return [fail("lark.auth", safeFailureSummary("Lark authentication failed", auth.response.status, authCode), "Verify the Lark App ID and App Secret for the installed application.")];
    }
    const authData = record(authBody?.data);
    const token = string(authData?.tenant_access_token);
    if (auth.response.status < 200 || auth.response.status >= 300 || authCode !== 0 || !token) {
      return [fail("lark.auth", "Lark authentication returned malformed data", "Verify the application credentials and retry the connectivity check.")];
    }

    const checks: SetupCheck[] = [{ id: "lark.auth", status: "pass", summary: "Lark credentials authenticated" }];
    if (!chatId) {
      checks.push(fail("lark.chat", "Target Lark chat ID is missing", "Set LARK_CHAT_ID."));
      return checks;
    }
    const authorization = { Authorization: `Bearer ${token}` };
    const chat = await this.safeRequest("chat", {
      method: "GET",
      url: `${LARK_BASE_URL}/im/v1/chats/${encodeURIComponent(chatId)}`,
      headers: authorization,
      timeoutMs: this.timeoutMs
    });
    if ("check" in chat) {
      checks.push(chat.check);
      return checks;
    }
    const chatCheck = classifyChatResponse(chat.response);
    checks.push(chatCheck);
    if (chatCheck.status !== "pass") return checks;

    if (!configuredBotOpenId) {
      checks.push(fail("lark.bot", "Configured bot open ID is missing", "Set LARK_BOT_OPEN_ID from the Lark developer console or event test data."));
      return checks;
    }
    const bot = await this.safeRequest("bot", {
      method: "GET",
      url: `${LARK_BASE_URL}/bot/v3/info`,
      headers: authorization,
      timeoutMs: this.timeoutMs
    });
    if ("check" in bot) {
      checks.push(bot.check);
      return checks;
    }
    checks.push(classifyBotResponse(bot.response, configuredBotOpenId));
    return checks;
  }

  private async safeRequest(stage: ProbeStage, request: SetupHttpRequest): Promise<
    { response: { status: number; body: unknown } } | { check: SetupCheck }
  > {
    try {
      return { response: await this.http.request(request) };
    } catch (error) {
      if (isTimeout(error)) {
        return { check: fail(`lark.${stage}`, `Lark ${stageLabel(stage)} check timed out`, "Retry the Lark connectivity check when the service is reachable.") };
      }
      if (error instanceof SetupHttpResponseError) {
        const detail = error.kind === "malformed" ? "malformed JSON" : "an oversized response";
        return { check: fail(`lark.${stage}`, `Lark ${stageLabel(stage)} returned ${detail}`, "Retry the check and inspect Lark service health if the response remains invalid.") };
      }
      return { check: fail(`lark.${stage}`, `Lark ${stageLabel(stage)} check was unavailable`, "Retry the Lark connectivity check when the service is reachable.") };
    }
  }
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new SetupHttpResponseError("oversized", `Lark response body exceeded ${maxBytes} bytes`);
      }
      text += decoder.decode(result.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function classifyChatResponse(response: { status: number; body: unknown }): SetupCheck {
  const body = record(response.body);
  const code = number(body?.code);
  if (response.status === 429 || code === 99991400) {
    return fail("lark.chat", safeFailureSummary("Lark chat lookup was rate limited", response.status, code), "Retry the Lark connectivity check after the rate limit clears.");
  }
  if (response.status === 403) {
    return fail("lark.chat", safeFailureSummary("Lark denied access to the target chat", response.status, code), "Grant the bot permission to read the target chat and add it to the group.");
  }
  if (response.status === 404) {
    return fail("lark.chat", safeFailureSummary("Target Lark chat was not found", response.status, code), "Verify LARK_CHAT_ID and ensure the bot is in the target group.");
  }
  if (response.status < 200 || response.status >= 300 || (code !== undefined && code !== 0)) {
    return fail("lark.chat", safeFailureSummary("Lark chat lookup failed", response.status, code), "Verify the chat ID, application permissions, publication, and bot membership.");
  }
  const data = record(body?.data);
  const name = string(data?.name);
  if (code !== 0 || !data || !name) {
    return fail("lark.chat", "Lark chat lookup returned malformed data", "Verify the chat ID and retry the connectivity check.");
  }
  return { id: "lark.chat", status: "pass", summary: `Target chat is readable: ${JSON.stringify(name)}` };
}

function classifyBotResponse(response: { status: number; body: unknown }, configuredOpenId: string): SetupCheck {
  const body = record(response.body);
  const code = number(body?.code);
  if (response.status === 403) {
    return warning("lark.bot", "Lark did not expose bot identity with the granted read scope", "Verify LARK_BOT_OPEN_ID in the Lark developer console or event test data.");
  }
  if (response.status === 429 || code === 99991400) {
    return fail("lark.bot", safeFailureSummary("Lark bot lookup was rate limited", response.status, code), "Retry the Lark connectivity check after the rate limit clears.");
  }
  if (response.status < 200 || response.status >= 300 || (code !== undefined && code !== 0)) {
    return fail("lark.bot", safeFailureSummary("Lark bot lookup failed", response.status, code), "Verify the application bot capability and granted permissions.");
  }
  const bot = record(body?.bot);
  const openId = string(bot?.open_id);
  if (code !== 0 || !openId) {
    return fail("lark.bot", "Lark bot lookup returned malformed data", "Verify the application bot capability and retry the connectivity check.");
  }
  if (openId !== configuredOpenId) {
    return fail("lark.bot", "Configured bot open ID does not match the authenticated application", "Replace LARK_BOT_OPEN_ID with the bot open ID shown in the Lark developer console.");
  }
  return { id: "lark.bot", status: "pass", summary: "Bot identity matches the configured open ID" };
}

function safeFailureSummary(label: string, status: number, code: number | undefined): string {
  const metadata = [`HTTP ${status}`, ...(code === undefined ? [] : [`code ${code}`])].join(", " );
  return `${label} (${metadata})`;
}

function fail(id: string, summary: string, remediation: string): SetupCheck {
  return { id, status: "fail", summary, remediation };
}

function warning(id: string, summary: string, remediation: string): SetupCheck {
  return { id, status: "warning", summary, remediation };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function stageLabel(stage: ProbeStage): string {
  if (stage === "auth") return "authentication";
  if (stage === "chat") return "chat";
  return "bot";
}
