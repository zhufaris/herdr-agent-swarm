import type { DatabaseSync } from "node:sqlite";

const EXACT_LEASE_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;

export const SQLITE_NOW_MS = "(CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER))";

export function hasLeaseExpiryMilliseconds(database: DatabaseSync): boolean {
  return database.prepare("SELECT 1 FROM pragma_table_info('instance_lease') WHERE name='expires_at_ms'").get() !== undefined;
}

export function parseLeaseTimestampMs(value: string, field: string): number {
  const match = EXACT_LEASE_TIMESTAMP.exec(value);
  if (!match) throw new Error(`Invalid ${field}: expected an exact ISO-8601 millisecond timestamp`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = "", zone, sign, offsetHourText = "0", offsetMinuteText = "0"] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const millisecond = Number(fraction.padEnd(3, "0"));
  const offsetHour = Number(offsetHourText);
  const offsetMinute = Number(offsetMinuteText);
  const wallTime = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  const wall = new Date(wallTime);
  const validCalendar = wall.getUTCFullYear() === year && wall.getUTCMonth() === month - 1 && wall.getUTCDate() === day
    && wall.getUTCHours() === hour && wall.getUTCMinutes() === minute && wall.getUTCSeconds() === second
    && wall.getUTCMilliseconds() === millisecond && offsetHour <= 23 && offsetMinute <= 59;
  if (!validCalendar) throw new Error(`Invalid ${field}: expected an exact ISO-8601 millisecond timestamp`);
  const offsetMs = zone === "Z" ? 0 : (sign === "+" ? 1 : -1) * (offsetHour * 60 + offsetMinute) * 60_000;
  const timestamp = wallTime - offsetMs;
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || Date.parse(value) !== timestamp) {
    throw new Error(`Invalid ${field}: timestamp is outside the supported range`);
  }
  return timestamp;
}

export function leaseExpiryMs(row: { expires_at: string; expires_at_ms?: number }): number {
  const parsed = parseLeaseTimestampMs(row.expires_at, "stored expires_at");
  if (row.expires_at_ms !== undefined && row.expires_at_ms !== parsed) {
    throw new Error("Invalid stored instance lease: expires_at and expires_at_ms disagree");
  }
  return row.expires_at_ms ?? parsed;
}
