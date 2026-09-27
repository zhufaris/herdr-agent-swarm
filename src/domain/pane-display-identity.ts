const NATIVE_PANE_TOKEN_PATTERN = /^[a-z0-9]{4}$/;

export function normalizePaneToken(value: string | null | undefined): string | null {
  const token = value?.trim().toLowerCase() ?? "";
  return NATIVE_PANE_TOKEN_PATTERN.test(token) ? token : null;
}

export function displayPaneIdentity(input: { paneToken?: string | null | undefined; paneId?: string | null | undefined }, fallback = "provisioning"): string {
  return normalizePaneToken(input.paneToken) ?? input.paneId ?? fallback;
}
