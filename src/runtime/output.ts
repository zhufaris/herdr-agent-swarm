import { createHash } from "node:crypto";

export function outputFingerprint(output: string): string {
  return createHash("sha256").update(output).digest("hex");
}
