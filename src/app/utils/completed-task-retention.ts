export const SINGLE_LIST_COMPLETED_RETENTION = 20;

export function completedItemsBeyondRetention<T>(
  items: readonly T[],
  compareNewestFirst: (left: T, right: T) => number,
  retention = SINGLE_LIST_COMPLETED_RETENTION,
): T[] {
  if (items.length <= retention) return [];
  return [...items].sort(compareNewestFirst).slice(retention);
}
