export type GatewayTone = "default" | "blue" | "green" | "orange" | "red" | "purple" | "grey" | "turquoise";
export type GatewayButtonStyle = "primary" | "default" | "danger";
export interface GatewayText { text: string; }
export type GatewayViewNode =
  | { kind: "markdown"; content: string; slot?: string }
  | { kind: "divider" }
  | { kind: "button"; label: string; style?: GatewayButtonStyle; action: unknown; name?: string; submit?: boolean }
  | { kind: "columns"; columns: readonly { width: "auto" | "weighted"; weight?: number; nodes: readonly GatewayViewNode[] }[]; flex?: "none"; horizontalSpacing?: string; verticalAlign?: string; background?: string }
  | { kind: "panel"; title: string; expanded: boolean; nodes: readonly GatewayViewNode[]; borderColor?: string; cornerRadius?: string }
  | { kind: "form"; name: string; nodes: readonly GatewayViewNode[] }
  | { kind: "input"; name: string; inputType: string; placeholder: string; required: boolean }
  | { kind: "select"; name: string; placeholder: string; required: boolean; options: readonly { label: string; value: string }[]; initialValue?: string; action?: unknown };

export interface GatewayView {
  schemaVersion: 1;
  fallbackText: string;
  heading: { title: string; subtitle?: string; tone?: GatewayTone } | null;
  nodes: readonly GatewayViewNode[];
  mutable: boolean;
  streaming: boolean;
}

/** Read-only compatibility envelope for provider-materialized payloads written before Gateway views. */
export interface LegacyGatewayView { schemaVersion: 0; format: "legacy-materialized-v1"; fallbackText: string; payload: object; }
export type GatewayRenderableView = GatewayView | LegacyGatewayView;

export function isGatewayView(value: unknown): value is GatewayView {
  return typeof value === "object" && value !== null && (value as { schemaVersion?: unknown }).schemaVersion === 1 && Array.isArray((value as { nodes?: unknown }).nodes) && typeof (value as { fallbackText?: unknown }).fallbackText === "string";
}
export function legacyGatewayView(payload: object, fallbackText = "Herdr update"): LegacyGatewayView {
  return { schemaVersion: 0, format: "legacy-materialized-v1", fallbackText, payload };
}
