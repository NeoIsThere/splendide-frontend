export interface LegacyListMigrationSource<TItem extends { id: string }> {
  id: string;
  isBacklog?: boolean;
  sourceIndex: number;
  items: TItem[];
}

export interface PlannedLegacyItem<TItem> {
  item: TItem;
  id: string;
  position: number;
  duplicated: boolean;
}

export interface SingleListMigrationPlan<TItem> {
  canonicalListId: string;
  items: PlannedLegacyItem<TItem>[];
}

/**
 * Plans the deterministic, lossless v2 two-list to v3 one-list migration.
 * The former main list is first, followed by backlogs and then unexpected
 * extra lists. Duplicate item ids are re-keyed instead of dropping either row.
 */
export function planSingleListMigration<TItem extends { id: string }>(
  sources: LegacyListMigrationSource<TItem>[],
  sectionId: string,
  deterministicId: (seed: string) => string,
): SingleListMigrationPlan<TItem> | null {
  if (sources.length === 0) return null;

  const byId = (
    left: LegacyListMigrationSource<TItem>,
    right: LegacyListMigrationSource<TItem>,
  ) => left.id.localeCompare(right.id) || left.sourceIndex - right.sourceIndex;
  const formerMain = sources.filter(source => source.isBacklog === false).sort(byId)[0]
    ?? sources.filter(source => source.isBacklog !== true).sort(byId)[0]
    ?? [...sources].sort(byId)[0];
  const formerBacklogs = sources
    .filter(source => source !== formerMain && source.isBacklog === true)
    .sort(byId);
  const extras = sources
    .filter(source => source !== formerMain && source.isBacklog !== true)
    .sort(byId);

  const usedIds = new Set<string>();
  const items: PlannedLegacyItem<TItem>[] = [];
  for (const source of [formerMain, ...formerBacklogs, ...extras]) {
    for (const item of source.items) {
      let id = item.id;
      if (usedIds.has(id)) {
        let duplicateIndex = 1;
        do {
          id = deterministicId(`${sectionId}:${source.id}:${item.id}:${duplicateIndex}`);
          duplicateIndex += 1;
        } while (usedIds.has(id));
      }
      usedIds.add(id);
      items.push({
        item,
        id,
        position: items.length,
        duplicated: id !== item.id,
      });
    }
  }

  return { canonicalListId: formerMain.id, items };
}
