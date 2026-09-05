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
