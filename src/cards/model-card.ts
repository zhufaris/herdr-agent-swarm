import type { ModelPreference } from "../domain/model-selection.js";
import type { TraexModelSummary } from "../runtime/traex-model-protocol.js";

export function renderModelSelectionCard(input: { bindingId: string; spaceName: string; paneId: string; models: readonly TraexModelSummary[]; preference: ModelPreference | null; notice?: string }): object {
  const preference = input.preference;
  const current = preference?.effectiveModel ?? null;
  const target = preference?.desiredModel ?? null;
  const initialOption = target && input.models.some(({ name }) => name === target) ? target : undefined;
  const status = preference?.state === "pending"
    ? `**Next turn**  ${target}\n\n将在下一条普通消息生效。`
    : preference?.state === "applying"
      ? `**Applying**  ${target}\n\n正在随已认领的普通消息应用。`
      : preference?.state === "uncertain"
        ? `**Uncertain**  ${target}\n\n请求可能已经生效，等待精确运行时证据确认；不会自动重放。`
        : "当前没有待应用的模型选择。";
  return {
    schema: "2.0", config: { update_multi: true, summary: { content: "Herdr 模型" } },
    header: { title: { tag: "plain_text", content: truncate(`TraeX · ${input.spaceName} / ${input.paneId}`, 96) }, subtitle: { tag: "plain_text", content: "HERDR MODEL" }, template: preference?.state === "uncertain" ? "orange" : preference?.state === "pending" ? "green" : "blue" },
    body: { elements: [
      { tag: "markdown", content: [`**Current**  ${current ?? "unknown"}`, status, input.notice].filter(Boolean).join("\n\n") },
      { tag: "select_static", name: "model", placeholder: { tag: "plain_text", content: "选择模型" }, ...(initialOption ? { initial_option: initialOption } : {}), options: input.models.slice(0, 100).map((model) => ({ text: { tag: "plain_text", content: truncate(model.displayName || model.name, 80) }, value: model.name })), behaviors: [{ type: "callback", value: { action: "select_model", bindingId: input.bindingId } }] }
    ] }
  };
}

export function renderModelResultCard(input: { bindingId: string; spaceName: string; paneId: string; output: string; switched: boolean }): object {
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: "Herdr 模型" } },
    header: {
      title: { tag: "plain_text", content: truncate(`TraeX · ${input.spaceName} / ${input.paneId}`, 96) },
      subtitle: { tag: "plain_text", content: "HERDR MODEL" },
      template: input.switched ? "green" : "blue"
    },
    body: { elements: [{ tag: "markdown", content: truncate(input.output.trim() || "TraeX 未返回模型信息。", 8_000) }] }
  };
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
