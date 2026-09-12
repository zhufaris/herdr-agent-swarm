import { isGatewayView, legacyGatewayView, type GatewayRenderableView, type GatewayTone, type GatewayView, type GatewayViewNode } from "../contract/view.js";

export function cardKitToGatewayView(value: object): GatewayView {
  if (isGatewayView(value)) return value;
  const card = record(value, "CardKit card");
  const config = optionalRecord(card.config);
  const header = optionalRecord(card.header);
  const title = textContent(optionalRecord(header?.title)) ?? fallbackText(card);
  const subtitle = textContent(optionalRecord(header?.subtitle));
  const summary = textContent(optionalRecord(config?.summary));
  const body = record(card.body, "CardKit body");
  const elements = array(body.elements, "CardKit body elements");
  return {
    schemaVersion: 1, fallbackText: summary ?? title ?? (plainText(elements) || "Herdr update"),
    heading: header ? { title: title ?? "Herdr", ...(subtitle ? { subtitle } : {}), ...(tone(header.template) ? { tone: tone(header.template)! } : {}) } : null,
    nodes: elements.map(parseNode), mutable: config?.update_multi !== false, streaming: config?.streaming_mode === true
  };
}

export function legacyCardKitView(value: object): GatewayRenderableView {
  return legacyGatewayView(value, fallbackText(record(value, "legacy CardKit card")));
}

export function materializeFeishuView(view: GatewayRenderableView): object {
  if (view.schemaVersion === 0) return structuredClone(view.payload);
  const header = view.heading ? {
    title: { tag: "plain_text", content: view.heading.title },
    ...(view.heading.subtitle ? { subtitle: { tag: "plain_text", content: view.heading.subtitle } } : {}),
    ...(view.heading.tone && view.heading.tone !== "default" ? { template: view.heading.tone } : {})
  } : null;
  return {
    schema: "2.0",
    config: { update_multi: view.mutable, ...(view.streaming ? { streaming_mode: true } : {}), summary: { content: view.fallbackText } },
    ...(header ? { header } : {}),
    body: { elements: view.nodes.map(materializeNode) }
  };
}

function parseNode(value: unknown): GatewayViewNode {
  const node = record(value, "CardKit element");
  const tag = string(node.tag, "CardKit element tag");
  if (tag === "markdown") return { kind: "markdown", content: string(node.content, "markdown content"), ...(typeof node.element_id === "string" ? { slot: node.element_id } : {}) };
  if (tag === "hr") return { kind: "divider" };
  if (tag === "button") {
    const behavior = array(node.behaviors, "button behaviors").map((item) => record(item, "button behavior")).find((item) => item.type === "callback");
    if (!behavior || !("value" in behavior)) throw new Error("CardKit callback button is missing action");
    return { kind: "button", label: textContent(record(node.text, "button text")) ?? "Action", ...(buttonStyle(node.type) ? { style: buttonStyle(node.type)! } : {}), action: structuredClone(behavior.value), ...(typeof node.name === "string" ? { name: node.name } : {}), ...(node.form_action_type === "submit" ? { submit: true } : {}) };
  }
  if (tag === "column_set") return { kind: "columns", columns: array(node.columns, "columns").map((item) => { const column = record(item, "column"); return { width: column.width === "auto" ? "auto" as const : "weighted" as const, ...(typeof column.weight === "number" ? { weight: column.weight } : {}), nodes: array(column.elements, "column elements").map(parseNode) }; }), ...(node.flex_mode === "none" ? { flex: "none" as const } : {}), ...(typeof node.horizontal_spacing === "string" ? { horizontalSpacing: node.horizontal_spacing } : {}), ...(typeof node.vertical_align === "string" ? { verticalAlign: node.vertical_align } : {}), ...(typeof node.background_style === "string" ? { background: node.background_style } : {}) };
  if (tag === "collapsible_panel") { const border = optionalRecord(node.border); return { kind: "panel", title: textContent(optionalRecord(optionalRecord(node.header)?.title)) ?? "Details", expanded: node.expanded === true, nodes: array(node.elements, "panel elements").map(parseNode), ...(typeof border?.color === "string" ? { borderColor: border.color } : {}), ...(typeof border?.corner_radius === "string" ? { cornerRadius: border.corner_radius } : {}) }; }
  if (tag === "form") return { kind: "form", name: string(node.name, "form name"), nodes: array(node.elements, "form elements").map(parseNode) };
  if (tag === "input") return { kind: "input", name: string(node.name, "input name"), inputType: string(node.input_type, "input type"), placeholder: textContent(record(node.placeholder, "input placeholder")) ?? "", required: node.required === true };
  if (tag === "select_static") { const behavior = Array.isArray(node.behaviors) ? node.behaviors.map((item) => record(item, "select behavior")).find((item) => item.type === "callback") : undefined; return { kind: "select", name: string(node.name, "select name"), placeholder: textContent(record(node.placeholder, "select placeholder")) ?? "", required: node.required === true, options: array(node.options, "select options").map((item) => { const option = record(item, "select option"); return { label: textContent(record(option.text, "select option text")) ?? "", value: string(option.value, "select option value") }; }), ...(typeof node.initial_option === "string" ? { initialValue: node.initial_option } : {}), ...(behavior && "value" in behavior ? { action: structuredClone(behavior.value) } : {}) }; }
  throw new Error(`Unsupported CardKit element: ${tag}`);
}

function materializeNode(node: GatewayViewNode): object {
  if (node.kind === "markdown") return { tag: "markdown", ...(node.slot ? { element_id: node.slot } : {}), content: node.content };
  if (node.kind === "divider") return { tag: "hr" };
  if (node.kind === "button") return { tag: "button", text: { tag: "plain_text", content: node.label }, ...(node.style ? { type: node.style } : {}), ...(node.name ? { name: node.name } : {}), ...(node.submit ? { form_action_type: "submit" } : {}), behaviors: [{ type: "callback", value: structuredClone(node.action) }] };
  if (node.kind === "columns") return { tag: "column_set", ...(node.flex ? { flex_mode: node.flex } : {}), ...(node.horizontalSpacing ? { horizontal_spacing: node.horizontalSpacing } : {}), ...(node.verticalAlign ? { vertical_align: node.verticalAlign } : {}), ...(node.background ? { background_style: node.background } : {}), columns: node.columns.map((column) => ({ tag: "column", width: column.width, ...(column.weight === undefined ? {} : { weight: column.weight }), elements: column.nodes.map(materializeNode) })) };
  if (node.kind === "panel") return { tag: "collapsible_panel", expanded: node.expanded, ...(node.borderColor || node.cornerRadius ? { border: { ...(node.borderColor ? { color: node.borderColor } : {}), ...(node.cornerRadius ? { corner_radius: node.cornerRadius } : {}) } } : {}), header: { title: { tag: "plain_text", content: node.title } }, elements: node.nodes.map(materializeNode) };
  if (node.kind === "form") return { tag: "form", name: node.name, elements: node.nodes.map(materializeNode) };
  if (node.kind === "input") return { tag: "input", name: node.name, input_type: node.inputType, ...(node.required ? { required: true } : {}), placeholder: { tag: "plain_text", content: node.placeholder } };
  return { tag: "select_static", name: node.name, ...(node.required ? { required: true } : {}), placeholder: { tag: "plain_text", content: node.placeholder }, ...(node.initialValue ? { initial_option: node.initialValue } : {}), options: node.options.map((option) => ({ text: { tag: "plain_text", content: option.label }, value: option.value })), ...(node.action === undefined ? {} : { behaviors: [{ type: "callback", value: structuredClone(node.action) }] }) };
}

function fallbackText(card: Record<string, unknown>): string { const config = optionalRecord(card.config); const header = optionalRecord(card.header); return textContent(optionalRecord(config?.summary)) ?? textContent(optionalRecord(header?.title)) ?? (plainText(array(optionalRecord(card.body)?.elements ?? [], "CardKit body elements")) || "Herdr update"); }
function plainText(values: readonly unknown[]): string { return values.flatMap((value) => { const item = optionalRecord(value); if (!item) return []; if (typeof item.content === "string") return [item.content]; return [...(Array.isArray(item.elements) ? [plainText(item.elements)] : []), ...(Array.isArray(item.columns) ? item.columns.map((column) => plainText(array(optionalRecord(column)?.elements ?? [], "column elements"))) : [])]; }).filter(Boolean).join("\n").slice(0, 4_000); }
function textContent(value: Record<string, unknown> | null | undefined): string | null { return typeof value?.content === "string" ? value.content : null; }
function tone(value: unknown): GatewayTone | null { return value === "blue" || value === "green" || value === "orange" || value === "red" || value === "purple" || value === "grey" || value === "turquoise" ? value : null; }
function buttonStyle(value: unknown): "primary" | "default" | "danger" | null { return value === "primary" || value === "default" || value === "danger" ? value : null; }
function record(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`); return value as Record<string, unknown>; }
function optionalRecord(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function array(value: unknown, label: string): unknown[] { if (!Array.isArray(value)) throw new Error(`${label} must be an array`); return value; }
function string(value: unknown, label: string): string { if (typeof value !== "string") throw new Error(`${label} must be a string`); return value; }
