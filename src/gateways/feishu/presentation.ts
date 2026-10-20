import { createCardKitApplicationPresentation } from "../../cards/cardkit-application-presentation.js";
import { cardKitPanePresentation } from "../../cards/cardkit-pane-presentation.js";
import { createCardKitPrimaryPresentation, type CardKitPresentationLimits } from "../../cards/cardkit-primary-presentation.js";
import { cardKitWorkerPresentation } from "../../cards/cardkit-worker-presentation.js";
import type { ApplicationPresentation, PanePresentation, PrimaryPresentation, WorkerPresentation } from "../../domain/ports/presentation.js";
import type { ProjectConfig } from "../../domain/types.js";
import { cardKitToGatewayView } from "./cardkit-view.js";
import { materializeFeishuView } from "./cardkit-view.js";
import type { GatewayRenderableView, GatewayView } from "../contract/view.js";
import { renderShortcutPanelCard } from "../../cards/shortcut-panel-card.js";
import { createTurnCardPresentationPolicy, turnCardPresentationPolicy } from "./turn-card-presentation-policy.js";

export function createFeishuGatewayApplicationPresentation(limits: CardKitPresentationLimits, projects: readonly ProjectConfig[] = [], runtimeIdentity: { branch: string | null; gitCommit: string | null } | null = null): ApplicationPresentation {
  return { ...wrapCardKitPresentation(createCardKitApplicationPresentation(limits, projects, runtimeIdentity)), turnCardSemanticPolicy: createTurnCardPresentationPolicy(runtimeIdentity) };
}
export function createFeishuGatewayPrimaryPresentation(limits: CardKitPresentationLimits): PrimaryPresentation {
  return wrapCardKitPresentation(createCardKitPrimaryPresentation(limits));
}
export const feishuGatewayApplicationPresentation = createFeishuGatewayApplicationPresentation({ payloadLimitChars: 12_000, answerStreamLimitChars: 28_000 });
export const feishuGatewayPrimaryPresentation = createFeishuGatewayPrimaryPresentation({ payloadLimitChars: 12_000, answerStreamLimitChars: 28_000 });
export const feishuGatewayWorkerPresentation: WorkerPresentation = wrapCardKitPresentation(cardKitWorkerPresentation);
export const feishuGatewayPanePresentation: PanePresentation = wrapCardKitPresentation(cardKitPanePresentation);

/** Gateway-bound materialization keeps CardKit renderer imports out of composition. */
export function renderFeishuShortcutPanelView(): object {
  return cardKitToGatewayView(renderShortcutPanelCard());
}

export function materializeFeishuPresentationView(view: GatewayRenderableView): object {
  const materialized = materializeFeishuView(view);
  if (view.schemaVersion === 1 && view.widthMode === "fill") {
    const config = (materialized as { config: Record<string, unknown> }).config;
    config.width_mode = "fill";
  }
  return materialized;
}

function wrapCardKitPresentation<T extends object>(presentation: T): T {
  return new Proxy(presentation, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => wrapResult(Reflect.apply(value, target, args));
    }
  });
}
function wrapResult(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(wrapResult);
  if (isCardKitCard(value)) return gatewayViewFromCardKit(value);
  if (isTurnCardPagePlan(value)) return { ...value, card: gatewayViewFromCardKit(value.card) };
  return value;
}
function gatewayViewFromCardKit(value: object): GatewayView {
  const view = cardKitToGatewayView(value);
  const widthMode = (value as { config?: { width_mode?: unknown } }).config?.width_mode;
  return widthMode === "fill" ? { ...view, widthMode } : view;
}
function isCardKitCard(value: unknown): value is object {
  return typeof value === "object" && value !== null && (value as { schema?: unknown }).schema === "2.0";
}
function isTurnCardPagePlan(value: unknown): value is { card: object; items: unknown; nextCursor: unknown } {
  return typeof value === "object" && value !== null
    && "card" in value && isCardKitCard((value as { card: unknown }).card)
    && "items" in value && "nextCursor" in value;
}
