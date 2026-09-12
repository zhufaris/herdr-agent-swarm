const LIFECYCLE_MARKERS: Record<string, string> = {
  provisioning: "⏳",
  unprovisioned: "⚠️",
  starting: "⏳",
  ready: "✅",
  idle: "✅",
  queued: "⏳",
  preparing: "⏳",
  pending: "⏳",
  running: "🧠",
  working: "🧠",
  active: "🧠",
  blocked: "⚠️",
  detached: "⚠️",
  "dispatch-uncertain": "⚠️",
  degraded: "⚠️",
  orphaned: "⚠️",
  completed: "✅",
  done: "✅",
  failed: "❌",
  error: "❌",
  cancelled: "⏹️",
  stopped: "⏹️",
  draining: "📦",
  archived: "📦",
  terminated: "📦"
};

/** Presentation-only marker for lifecycle states shown in cards. */
export function lifecycleMarker(state: string): string {
  return LIFECYCLE_MARKERS[state] ?? "⚠️";
}

/** Renderer-owned section heading; canonical user and agent text stays untouched. */
export function cardSection(marker: string, label: string): string {
  return `**${marker} ${label}**`;
}

/** Compact one-line metadata. Empty values never leave visual separators. */
export function compactMetadata(parts: readonly (string | null | undefined | false)[]): string {
  return parts.filter((part): part is string => typeof part === "string" && part.length > 0).join("  ·  " );
}

/** One stable CardKit action row; callers retain ownership of action identity. */
export function actionRow(buttons: readonly object[]): object | null {
  return buttons.length === 0 ? null : { tag: "column_set", flex_mode: "none", horizontal_spacing: "8px", columns: buttons.map((button) => ({ tag: "column", width: "auto", elements: [button] })) };
}

export function recentItems<T>(items: readonly T[], limit: number): T[] {
  return items.slice(-Math.max(0, limit));
}

/** Removes every nested callback button from a presentation-only snapshot. */
export function passiveCardElements(elements: readonly object[]): object[] {
  return elements.flatMap((element) => {
    if ("tag" in element && element.tag === "button") return [];
    const copy = { ...element } as Record<string, unknown>;
    if (Array.isArray(copy.elements)) copy.elements = passiveCardElements(copy.elements.filter((item): item is object => typeof item === "object" && item !== null));
    if (Array.isArray(copy.columns)) copy.columns = copy.columns.flatMap((column) => {
      if (typeof column !== "object" || column === null) return [];
      const next = { ...column } as Record<string, unknown>;
      if (Array.isArray(next.elements)) next.elements = passiveCardElements(next.elements.filter((item): item is object => typeof item === "object" && item !== null));
      return Array.isArray(next.elements) && next.elements.length === 0 ? [] : [next];
    });
    if (Array.isArray(copy.columns) && copy.columns.length === 0) return [];
    return [copy];
  });
}
