import { createHash } from "node:crypto";

const ANSI = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export function cleanTerminalOutput(output: string): string {
  return output
    .replace(ANSI, "")
    .replace(/^[\s\S]*?›\s*/m, "")
    .replace(/(?:^|\n)[•◌⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏].*$/gm, "")
    .trim();
}

export function stripTerminalControl(output: string): string { return output.replace(ANSI, "").replace(/\r/g, ""); }

export function outputFingerprint(output: string): string {
  return createHash("sha256").update(output).digest("hex");
}

export function extractNewOutput(before: string, after: string): string {
  if (!before || !after.startsWith(before)) return after;
  return after.slice(before.length).trimStart();
}
