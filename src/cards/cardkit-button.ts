export function callbackButton(content: string, value: object, type?: "primary" | "default" | "danger", extra: Record<string, unknown> = {}): object {
  return {
    tag: "button",
    text: { tag: "plain_text", content },
    ...(type ? { type } : {}),
    ...extra,
    behaviors: [{ type: "callback", value }]
  };
}

export function linkButton(content: string, url: string, type?: "primary" | "default" | "danger", extra: Record<string, unknown> = {}): object {
  return {
    tag: "button",
    text: { tag: "plain_text", content },
    ...(type ? { type } : {}),
    ...extra,
    behaviors: [{ type: "open_url", default_url: url, pc_url: url, ios_url: url, android_url: url }]
  };
}

export function formSubmitButton(content: string, name: string, value: object, type?: "primary" | "default" | "danger"): object {
  return callbackButton(content, value, type, { name, form_action_type: "submit" });
}
