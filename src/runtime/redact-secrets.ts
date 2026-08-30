const PRIVATE_KEY = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi;
const SECRET_NAME = "(?:access[_-]?token|api[_-]?key|app[_-]?secret|client[_-]?secret|private[_-]?key|token|secret|password|credential)";

export function redactSecrets(value: string): string {
  return value
    .replace(PRIVATE_KEY, "[REDACTED PRIVATE KEY]")
    .replace(new RegExp(`(["']${SECRET_NAME}["']\\s*:\\s*["'])([^"']*)(["'])`, "gi"), "$1[REDACTED]$3")
    .replace(/(authorization\s*[:=]\s*)((?:bearer|basic)\s+)?[^\r\n,;]+/gi, (_match, prefix: string, scheme?: string) => `${prefix}${scheme ?? ""}[REDACTED]`)
    .replace(/((?:x-)?api-key\s*:\s*)[^\r\n,;]+/gi, "$1[REDACTED]")
    .replace(new RegExp(`([?&]${SECRET_NAME}=)[^&#\\s]+`, "gi"), "$1[REDACTED]")
    .replace(new RegExp(`(\\b${SECRET_NAME}\\b\\s*[:=]\\s*)(?:"[^"]*"|'[^']*'|[^\\s,;&]+)`, "gi"), "$1[REDACTED]")
    .replace(/(bearer\s+)[a-z0-9._~-]+/gi, "$1[REDACTED]");
}
