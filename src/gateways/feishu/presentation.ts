import { createCardKitApplicationPresentation } from "../../cards/cardkit-application-presentation.js";
import { cardKitPanePresentation } from "../../cards/cardkit-pane-presentation.js";
import { createCardKitPrimaryPresentation, type CardKitPresentationLimits } from "../../cards/cardkit-primary-presentation.js";
import { cardKitWorkerPresentation } from "../../cards/cardkit-worker-presentation.js";
import type { ApplicationPresentation, PanePresentation, PrimaryPresentation, WorkerPresentation } from "../../domain/ports/presentation.js";
import { cardKitToGatewayView } from "./cardkit-view.js";

export function createFeishuGatewayApplicationPresentation(limits: CardKitPresentationLimits): ApplicationPresentation {
  return wrapCardKitPresentation(createCardKitApplicationPresentation(limits));
}
export function createFeishuGatewayPrimaryPresentation(limits: CardKitPresentationLimits): PrimaryPresentation {
  return wrapCardKitPresentation(createCardKitPrimaryPresentation(limits));
}
export const feishuGatewayApplicationPresentation = createFeishuGatewayApplicationPresentation({ payloadLimitChars: 12_000, answerStreamLimitChars: 28_000 });
export const feishuGatewayPrimaryPresentation = createFeishuGatewayPrimaryPresentation({ payloadLimitChars: 12_000, answerStreamLimitChars: 28_000 });
export const feishuGatewayWorkerPresentation: WorkerPresentation = wrapCardKitPresentation(cardKitWorkerPresentation);
export const feishuGatewayPanePresentation: PanePresentation = wrapCardKitPresentation(cardKitPanePresentation);

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
  if (isCardKitCard(value)) return cardKitToGatewayView(value);
  return value;
}
function isCardKitCard(value: unknown): value is object {
  return typeof value === "object" && value !== null && (value as { schema?: unknown }).schema === "2.0";
}
