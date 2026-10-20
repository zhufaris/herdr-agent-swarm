const NATIVE_PANE_TOKEN_PATTERN = /^[a-z0-9]{4}$/;

export function normalizePaneToken(value: string | null | undefined): string | null {
  const token = value?.trim().toLowerCase() ?? "";
  return NATIVE_PANE_TOKEN_PATTERN.test(token) ? token : null;
}

/** User-visible conversation identity. It cannot fall back to an internal Pane ID. */
export function displayPaneToken(paneToken: string | null | undefined, fallback = "—"): string {
  return normalizePaneToken(paneToken) ?? fallback;
}

export function displayPaneIdentity(input: { paneToken?: string | null | undefined; paneId?: string | null | undefined }, fallback = "provisioning"): string {
  return normalizePaneToken(input.paneToken) ?? input.paneId ?? fallback;
}

export function displayNamedPaneIdentity(input: { paneName?: string | null | undefined; paneToken?: string | null | undefined; paneId?: string | null | undefined }, fallback = "provisioning"): string {
  const name = input.paneName?.trim() || null;
  const identity = normalizePaneToken(input.paneToken) ?? input.paneId ?? null;
  if (name && identity && name !== identity) return `${name} · ${identity}`;
  return name ?? identity ?? fallback;
}
