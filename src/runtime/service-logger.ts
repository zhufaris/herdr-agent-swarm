import pino, { type DestinationStream, type Logger } from "pino";
import { closeSync, constants, fchmodSync, fstatSync, openSync } from "node:fs";
import { safeLogError } from "./safe-error.js";

export interface ServiceLogger { logger: Logger; close(): void }
type ReopenableDestination = DestinationStream & { file: string | null; reopen(path?: string): void; end(): void };

export function createServiceLogger(level: string, logPath = process.env.BRIDGE_LOG_PATH): ServiceLogger {
  let destination: ReopenableDestination | undefined;
  if (logPath) {
    const descriptor = openSync(logPath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.uid !== process.geteuid?.()) { closeSync(descriptor); throw new Error(`BRIDGE_LOG_PATH must be a private regular file: ${logPath}`); }
    fchmodSync(descriptor, 0o600);
    destination = pino.destination({ dest: descriptor, sync: false }) as unknown as ReopenableDestination;
    destination.file = logPath;
  }
  const logger = pino({ level, serializers: { err: safeLogError }, redact: [
    "lark.appSecret", "appSecret", "*.appSecret", "token", "*.token", "authorization", "*.authorization",
    "cookie", "*.cookie", "password", "*.password", "privateKey", "*.privateKey"
  ] }, destination);
  const reopen = () => {
    destination?.reopen();
  };
  if (destination) process.on("SIGUSR2", reopen);
  let closed = false;
  return { logger, close() { if (destination && !closed) { closed = true; process.off("SIGUSR2", reopen); destination.end(); } } };
}
