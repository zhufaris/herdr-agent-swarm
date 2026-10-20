export type GatewayTone = "default" | "blue" | "green" | "orange" | "red" | "purple" | "grey" | "turquoise";
export type GatewayButtonStyle = "primary" | "default" | "danger";
export interface GatewayText { text: string; }
export type GatewayViewNode =
  | { kind: "markdown"; content: string; slot?: string }
  | { kind: "mention"; userId: string; content: string }
  | { kind: "divider" }
  | { kind: "button"; label: string; style?: GatewayButtonStyle; size?: string; action: unknown; name?: string; submit?: boolean }
  | { kind: "link"; label: string; url: string; style?: GatewayButtonStyle; size?: string; pcUrl?: string; iosUrl?: string; androidUrl?: string }
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
  widthMode?: "fill";
}

/** Read-only compatibility envelope for provider-materialized payloads written before Gateway views. */
export interface LegacyGatewayView { schemaVersion: 0; format: "legacy-materialized-v1"; fallbackText: string; payload: object; }
export type GatewayRenderableView = GatewayView | LegacyGatewayView;

export function isGatewayView(value: unknown): value is GatewayView {
  if (!strictRecord(value, ["schemaVersion", "fallbackText", "heading", "nodes", "mutable", "streaming", "widthMode"])) return false;
  return value.schemaVersion === 1
    && typeof value.fallbackText === "string"
    && validHeading(value.heading)
    && Array.isArray(value.nodes) && value.nodes.every(validNode)
    && typeof value.mutable === "boolean"
    && typeof value.streaming === "boolean"
    && (value.widthMode === undefined || value.widthMode === "fill");
}
export function legacyGatewayView(payload: object, fallbackText = "Herdr update"): LegacyGatewayView {
  return { schemaVersion: 0, format: "legacy-materialized-v1", fallbackText, payload };
}

function validHeading(value: unknown): boolean {
  if (value === null) return true;
  if (!strictRecord(value, ["title", "subtitle", "tone"]) || typeof value.title !== "string") return false;
  if (value.subtitle !== undefined && typeof value.subtitle !== "string") return false;
  return value.tone === undefined || ["default", "blue", "green", "orange", "red", "purple", "grey", "turquoise"].includes(String(value.tone));
}

function validNode(value: unknown): boolean {
  if (!record(value) || typeof value.kind !== "string") return false;
  if (value.kind === "markdown") return strictRecord(value, ["kind", "content", "slot"]) && typeof value.content === "string" && optionalString(value.slot);
  if (value.kind === "mention") return strictRecord(value, ["kind", "userId", "content"])
    && typeof value.userId === "string" && value.userId.length > 0 && typeof value.content === "string";
  if (value.kind === "divider") return strictRecord(value, ["kind"]);
  if (value.kind === "button") return strictRecord(value, ["kind", "label", "style", "size", "action", "name", "submit"])
    && typeof value.label === "string" && optionalButtonStyle(value.style) && optionalString(value.size)
    && jsonValue(value.action) && optionalString(value.name) && (value.submit === undefined || typeof value.submit === "boolean");
  if (value.kind === "link") return strictRecord(value, ["kind", "label", "url", "style", "size", "pcUrl", "iosUrl", "androidUrl"])
    && typeof value.label === "string" && typeof value.url === "string" && optionalButtonStyle(value.style)
    && optionalString(value.size) && optionalString(value.pcUrl) && optionalString(value.iosUrl) && optionalString(value.androidUrl);
  if (value.kind === "columns") return strictRecord(value, ["kind", "columns", "flex", "horizontalSpacing", "verticalAlign", "background"])
    && Array.isArray(value.columns) && value.columns.every(validColumn) && (value.flex === undefined || value.flex === "none")
    && optionalString(value.horizontalSpacing) && optionalString(value.verticalAlign) && optionalString(value.background);
  if (value.kind === "panel") return strictRecord(value, ["kind", "title", "expanded", "nodes", "borderColor", "cornerRadius"])
    && typeof value.title === "string" && typeof value.expanded === "boolean" && Array.isArray(value.nodes) && value.nodes.every(validNode)
    && optionalString(value.borderColor) && optionalString(value.cornerRadius);
  if (value.kind === "form") return strictRecord(value, ["kind", "name", "nodes"])
    && typeof value.name === "string" && Array.isArray(value.nodes) && value.nodes.every(validNode);
  if (value.kind === "input") return strictRecord(value, ["kind", "name", "inputType", "placeholder", "required"])
    && typeof value.name === "string" && typeof value.inputType === "string" && typeof value.placeholder === "string" && typeof value.required === "boolean";
  if (value.kind === "select") return strictRecord(value, ["kind", "name", "placeholder", "required", "options", "initialValue", "action"])
    && typeof value.name === "string" && typeof value.placeholder === "string" && typeof value.required === "boolean"
    && Array.isArray(value.options) && value.options.every(validOption) && optionalString(value.initialValue)
    && (value.action === undefined || jsonValue(value.action));
  return false;
}

function validColumn(value: unknown): boolean {
  return strictRecord(value, ["width", "weight", "nodes"])
    && (value.width === "auto" || value.width === "weighted")
    && (value.weight === undefined || typeof value.weight === "number" && Number.isFinite(value.weight))
    && Array.isArray(value.nodes) && value.nodes.every(validNode);
}

function validOption(value: unknown): boolean {
  return strictRecord(value, ["label", "value"]) && typeof value.label === "string" && typeof value.value === "string";
}

function optionalString(value: unknown): boolean { return value === undefined || typeof value === "string"; }
function optionalButtonStyle(value: unknown): boolean { return value === undefined || value === "primary" || value === "default" || value === "danger"; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function strictRecord(value: unknown, allowed: readonly string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).every((key) => allowed.includes(key));
}
function jsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(jsonValue);
  return record(value) && Object.values(value).every(jsonValue);
}
