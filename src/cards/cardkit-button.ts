export function callbackButton(content: string, value: object, type?: "primary" | "default" | "danger", extra: Record<string, unknown> = {}): object {
  return {
    tag: "button",
    text: { tag: "plain_text", content },
    ...(type ? { type } : {}),
    ...extra,
    behaviors: [{ type: "callback", value }]
  };
}

export function formSubmitButton(content: string, name: string, value: object, type?: "primary" | "default" | "danger"): object {
  return callbackButton(content, value, type, { name, action_type: "form_submit" });
}
