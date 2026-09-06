export const MAX_CARD_SERIALIZED_LENGTH = 12_000;

export function appendWithinCardLimit(elements: readonly object[], additions: readonly object[], reserve = 800, limit = MAX_CARD_SERIALIZED_LENGTH): boolean {
  return JSON.stringify([...elements, ...additions]).length + reserve <= limit;
}
