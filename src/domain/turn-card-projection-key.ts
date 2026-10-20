export function turnCardProjectionKey(segmentId: string, pageIndex: number): string {
  if (!segmentId || !Number.isInteger(pageIndex) || pageIndex < 0) throw new Error("Invalid Turn Card projection identity");
  return `turn-card:${segmentId}:page:${pageIndex}`;
}

export function parseTurnCardProjectionKey(value: string): { segmentId: string; pageIndex: number } | null {
  const match = /^turn-card:(.+):page:(\d+)$/.exec(value);
  if (!match) return null;
  const pageIndex = Number(match[2]);
  return Number.isSafeInteger(pageIndex) && match[1] ? { segmentId: match[1], pageIndex } : null;
}

export function parseTurnCardRecoveryProjectionKey(value: string): { segmentId: string; sourcePageIndex: number; partIndex: number } | null {
  const match = /^turn-card-recovery:(.+):source:(\d+):part:(\d+):create$/.exec(value);
  if (!match) return null;
  const sourcePageIndex = Number(match[2]);
  const partIndex = Number(match[3]);
  return Number.isSafeInteger(sourcePageIndex) && Number.isSafeInteger(partIndex) && match[1]
    ? { segmentId: match[1], sourcePageIndex, partIndex }
    : null;
}

export function turnCardLateRecoveryProjectionKey(segmentId: string, recoveryId: number, partIndex: number): string {
  if (!segmentId || !Number.isSafeInteger(recoveryId) || recoveryId < 1 || !Number.isSafeInteger(partIndex) || partIndex < 0) throw new Error("Invalid late Turn Card recovery identity");
  return `turn-card-late-recovery:${segmentId}:recovery:${recoveryId}:part:${partIndex}:create`;
}

export function parseTurnCardLateRecoveryProjectionKey(value: string): { segmentId: string; recoveryId: number; partIndex: number } | null {
  const match = /^turn-card-late-recovery:(.+):recovery:(\d+):part:(\d+):create$/.exec(value);
  if (!match) return null;
  const recoveryId = Number(match[2]);
  const partIndex = Number(match[3]);
  return Number.isSafeInteger(recoveryId) && recoveryId > 0 && Number.isSafeInteger(partIndex) && match[1]
    ? { segmentId: match[1], recoveryId, partIndex }
    : null;
}
