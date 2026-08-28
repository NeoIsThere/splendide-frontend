import { Injectable } from '@angular/core';
import { planSingleListMigration } from '../utils/single-list-migration';

export interface StoredItem {
  id: string;
  content: unknown;
  deadlineAt?: string | null;
  deadlineTimeZone?: string | null;
  deadlineNotificationEnabled?: boolean;
  position: number;
  lastModifiedAt: string;
  serverRevision: number;
  deleted?: boolean;
  created?: boolean;
  dirty?: boolean;
}

export interface StoredList {
  id: string;
  title: string;
  metadataLastModifiedAt: string;
  serverRevision: number;
  itemsOrderRevision: number;
  itemsBaseOrderRevision: number;
  dirty?: boolean;
  itemsOrderDirty?: boolean;
  items: StoredItem[];
}

export interface StoredSection {
  id: string;
  ownerId?: string;
  title: string;
  position: number;
  metadataLastModifiedAt: string;
  serverRevision: number;
  isShared?: boolean;
  shareToken?: string;
  sharedAccess?: boolean;
  deleted?: boolean;
  created?: boolean;
  dirty?: boolean;
  lists: StoredList[];
}

export interface Partition {
  syncGeneration: number;
  sectionOrderRevision: number;
  sectionBaseOrderRevision: number;
  sectionOrderDirty?: boolean;
  cloudReplacePending?: boolean;
  sections: StoredSection[];
}

export interface OrderSyncPayload {
  baseOrderRevision: number;
  orderedIds: string[];
}

export interface SectionsSyncResponse {
  syncGeneration?: number;
  sectionOrderRevision: number;
  sections: StoredSection[];
}

export interface ItemsSyncResponse {
  syncGeneration?: number;
  itemsOrderRevision: number;
  items: StoredItem[];
}

export interface OrderSyncResponse {
  orderRevision: number;
  positions: { id: string; position: number }[];
}

type LegacySection = Partial<StoredSection> & {
  isNew?: boolean;
  lists?: LegacyList[];
};

type LegacyList = Partial<StoredList> & {
  isBacklog?: boolean;
  lastModifiedAt?: string;
  content?: unknown[];
};

export interface MovedItemOrderState {
  sectionId: string;
  listId: string;
  itemsOrderRevision: number;
  positions: { id: string; position: number }[];
}

export interface MoveItemResponse {
  item: StoredItem;
  source: MovedItemOrderState;
  target: MovedItemOrderState;
}

export interface MoveItemRollback {
  itemId: string;
  expectedItemServerRevision: number;
  sourceSectionId: string;
  sourceList: StoredList;
  sourceItemsRevision: number;
  baseSourceOrderRevision: number;
  targetSectionId: string;
  targetList: StoredList;
  targetItemsRevision: number;
  baseTargetOrderRevision: number;
}

const LS_PREFIX = 'splendide_v3_';
const LEGACY_LS_PREFIX = 'splendide_v2_';
const ANONYMOUS_KEY = `${LS_PREFIX}anonymous`;
const NEUTRAL_LIST_TITLE = 'tasks';

function generateId(): string {
  return crypto.randomUUID();
}

function nowIso(): string {
  return new Date().toISOString();
}

function revision(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function shouldAcceptRemote(
  remote: { serverRevision: number },
  local?: { serverRevision: number; dirty?: boolean },
): boolean {
  if (!local) return true;
  if (remote.serverRevision > local.serverRevision) return true;
  if (remote.serverRevision < local.serverRevision) return false;
  return local.dirty !== true;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sameContent(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function activeItemOrder(items: StoredItem[]): string[] {
  return [...items]
    .filter((item) => !item.deleted)
    .sort((left, right) => left.position - right.position)
    .map((item) => item.id);
}

function sameOrder(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function keepLocalActiveOrder(merged: StoredItem[], localItems: StoredItem[]): StoredItem[] {
  const pending = new Map(merged.map((item) => [item.id, item]));
  const ordered: StoredItem[] = [];

  for (const id of activeItemOrder(localItems)) {
    const item = pending.get(id);
    if (!item || item.deleted) continue;
    ordered.push({ ...item, position: ordered.length });
    pending.delete(id);
  }

  const remainingActive = [...pending.values()]
    .filter((item) => !item.deleted)
    .sort((left, right) => left.position - right.position);
  ordered.push(...remainingActive.map((item, index) => ({ ...item, position: ordered.length + index })));

  const deleted = [...pending.values()]
    .filter((item) => item.deleted)
    .sort((left, right) => left.position - right.position)
    .map((item, index) => ({ ...item, position: ordered.length + index }));

  return [...ordered, ...deleted];
}

function timestampMs(value: string | undefined): number {
  const parsed = value ? new Date(value).getTime() : Number.NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

function shouldRebaseLocalDirtyItem(remote: StoredItem, local: StoredItem): boolean {
  return local.dirty === true &&
    local.deleted !== true &&
    remote.deleted !== true &&
    !sameContent(remote.content, local.content) &&
    timestampMs(local.lastModifiedAt) > timestampMs(remote.lastModifiedAt);
}

function rebaseLocalDirtyItem(remote: StoredItem, local: StoredItem): StoredItem {
  return {
    id: local.id,
    content: local.content,
    position: remote.position,
    lastModifiedAt: local.lastModifiedAt,
    serverRevision: remote.serverRevision,
    dirty: true,
  };
}

function cleanSyncedItem(item: StoredItem): StoredItem {
  const deadlines = normalizeDeadlineFields(item.content, item as unknown as Record<string, unknown>);
  return {
    id: item.id,
    content: normalizeTaskContent(item.content, item.id, deadlines),
    ...deadlines,
    position: item.position,
    lastModifiedAt: item.lastModifiedAt,
    serverRevision: item.serverRevision,
    ...(item.deleted ? { deleted: true } : {}),
  };
}

function mergeSyncedItems(
  remoteItems: StoredItem[],
  localItems: StoredItem[],
  preferLocalOrder: boolean,
): { items: StoredItem[]; keptLocalOrder: boolean } {
  const shouldKeepLocalOrder = preferLocalOrder && !sameOrder(activeItemOrder(localItems), activeItemOrder(remoteItems));
  const localById = new Map(localItems.map((item) => [item.id, item]));
  const remoteIds = new Set(remoteItems.map((item) => item.id));

  let merged = remoteItems.map((item) => {
    const local = localById.get(item.id);
    if (
      local &&
      item.serverRevision === local.serverRevision &&
      item.deleted === local.deleted &&
      sameContent(item.content, local.content)
    ) {
      return cleanSyncedItem(item);
    }

    if (local && item.deleted && item.serverRevision >= local.serverRevision) {
      return cleanSyncedItem(item);
    }

    if (local && shouldRebaseLocalDirtyItem(item, local)) {
      return rebaseLocalDirtyItem(item, local);
    }

    if (local && !shouldAcceptRemote(item, local)) {
      return { ...local, position: item.position };
    }

    return cleanSyncedItem(item);
  });

  for (const item of localItems) {
    if (
      !remoteIds.has(item.id) &&
      item.dirty &&
      !item.deleted &&
      item.serverRevision === 0
    ) {
      merged.push(item);
    }
  }

  if (shouldKeepLocalOrder) {
    merged = keepLocalActiveOrder(merged, localItems);
  }

  return { items: merged, keptLocalOrder: shouldKeepLocalOrder };
}

function mergeSyncedList(
  remote: StoredList,
  existing?: StoredList,
  replaceLocal = false,
  hasAuthoritativeItems = true,
): StoredList {
  const remoteItems = (Array.isArray(remote.items) ? remote.items : [])
    .map((item, index) => normalizeItem(item, index, remote.metadataLastModifiedAt));
  if (replaceLocal || !existing) {
    return {
      id: remote.id,
      title: NEUTRAL_LIST_TITLE,
      metadataLastModifiedAt: remote.metadataLastModifiedAt,
      serverRevision: remote.serverRevision,
      itemsOrderRevision: remote.itemsOrderRevision,
      itemsBaseOrderRevision: remote.itemsOrderRevision,
      items: remoteItems.map((item) => cleanSyncedItem(item)),
    };
  }

  if (!hasAuthoritativeItems) {
    const keepLocalMetadata = !shouldAcceptRemote(remote, existing);
    return {
      id: remote.id,
      title: NEUTRAL_LIST_TITLE,
      metadataLastModifiedAt: keepLocalMetadata ? existing.metadataLastModifiedAt : remote.metadataLastModifiedAt,
      serverRevision: keepLocalMetadata ? existing.serverRevision : remote.serverRevision,
      ...(keepLocalMetadata && existing.dirty ? { dirty: true } : {}),
      itemsOrderRevision: remote.itemsOrderRevision,
      itemsBaseOrderRevision: existing.itemsOrderDirty
        ? existing.itemsBaseOrderRevision
        : remote.itemsOrderRevision,
      ...(existing.itemsOrderDirty ? { itemsOrderDirty: true } : {}),
      items: existing.items,
    };
  }

  const { items, keptLocalOrder } = mergeSyncedItems(remoteItems, existing.items, existing.itemsOrderDirty === true);
  const keepLocalMetadata = !shouldAcceptRemote(remote, existing);
  return {
    id: remote.id,
    title: NEUTRAL_LIST_TITLE,
    metadataLastModifiedAt: keepLocalMetadata ? existing.metadataLastModifiedAt : remote.metadataLastModifiedAt,
    serverRevision: keepLocalMetadata ? existing.serverRevision : remote.serverRevision,
    ...(keepLocalMetadata && existing.dirty ? { dirty: true } : {}),
    itemsOrderRevision: remote.itemsOrderRevision,
    itemsBaseOrderRevision: remote.itemsOrderRevision,
    ...(keptLocalOrder ? { itemsOrderDirty: true } : {}),
    items,
  };
}

function mergeSyncedLists(
  remoteLists: StoredList[],
  localLists: StoredList[],
  replaceLocal = false,
  sectionId = 'section',
): StoredList[] {
  const timestamp = nowIso();
  const rawRemote = remoteLists[0] as unknown;
  const hasAuthoritativeItems = isRecord(rawRemote) &&
    (Array.isArray(rawRemote['items']) || Array.isArray(rawRemote['content']));
  const remote = remoteLists.length > 0
    ? normalizeLists(remoteLists as LegacyList[], sectionId, timestamp)[0]
    : undefined;
  const existing = localLists.length > 0
    ? normalizeLists(localLists as LegacyList[], sectionId, timestamp)[0]
    : undefined;

  if (!remote) {
    return existing && !replaceLocal
      ? [existing]
      : [createEmptyList(timestamp, deterministicId(`${sectionId}:task-list`))];
  }
  return [mergeSyncedList(remote, existing, replaceLocal, hasAuthoritativeItems)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeDeadlineAt(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0) return undefined;
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return undefined;
  return Number.isNaN(Date.parse(value)) ? undefined : value;
}

function normalizeDeadlineFields(
  content: unknown,
  envelope?: Record<string, unknown>,
): Pick<StoredItem, 'deadlineAt' | 'deadlineTimeZone' | 'deadlineNotificationEnabled'> {
  const contentRecord = isRecord(content) ? content : {};
  const deadlineSource = 'deadlineAt' in contentRecord ? contentRecord : envelope;
  const timezoneSource = 'deadlineTimeZone' in contentRecord ? contentRecord : envelope;
  const notificationSource = 'deadlineNotificationEnabled' in contentRecord ? contentRecord : envelope;
  const deadlineAt = deadlineSource ? normalizeDeadlineAt(deadlineSource['deadlineAt']) : undefined;
  const hasDeadlineTimeZone = !!timezoneSource && 'deadlineTimeZone' in timezoneSource;
  const rawDeadlineTimeZone = timezoneSource?.['deadlineTimeZone'];
  const deadlineTimeZone = rawDeadlineTimeZone === null
    ? null
    : typeof rawDeadlineTimeZone === 'string' && rawDeadlineTimeZone.length > 0
      ? rawDeadlineTimeZone
      : undefined;

  return {
    ...(deadlineSource && 'deadlineAt' in deadlineSource ? { deadlineAt: deadlineAt ?? null } : {}),
    ...(hasDeadlineTimeZone ? { deadlineTimeZone: deadlineTimeZone ?? null } : {}),
    ...(notificationSource && 'deadlineNotificationEnabled' in notificationSource
      ? { deadlineNotificationEnabled: notificationSource['deadlineNotificationEnabled'] === true }
      : {}),
  };
}

function deterministicId(seed: string): string {
  const salts = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  let hex = '';
  for (const salt of salts) {
    let hash = salt;
    for (let index = 0; index < seed.length; index += 1) {
      hash ^= seed.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    hex += (hash >>> 0).toString(16).padStart(8, '0');
  }
  const versioned = `${hex.slice(0, 12)}5${hex.slice(13)}`;
  const variantNibble = ((Number.parseInt(versioned[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  const uuid = `${versioned.slice(0, 16)}${variantNibble}${versioned.slice(17)}`;
  return `${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-${uuid.slice(12, 16)}-${uuid.slice(16, 20)}-${uuid.slice(20, 32)}`;
}

function normalizeSubtasks(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];

  return value.map((subtask) => {
    if (!isRecord(subtask)) return subtask;
    return { ...subtask, id: String(subtask['id'] ?? generateId()) };
  });
}

function normalizeTaskContent(
  value: unknown,
  fallbackId: string,
  fallbackDeadlines?: Pick<StoredItem, 'deadlineAt' | 'deadlineTimeZone' | 'deadlineNotificationEnabled'>,
): unknown {
  if (!isRecord(value)) return value;

  const deadlines = normalizeDeadlineFields(value, fallbackDeadlines as Record<string, unknown> | undefined);

  return {
    ...value,
    id: fallbackId,
    subtasks: normalizeSubtasks(value['subtasks']),
    ...deadlines,
  };
}

function normalizeItem(value: unknown, position: number, fallbackTimestamp: string): StoredItem {
  if (isRecord(value) && 'content' in value) {
    const id = String(value['id'] ?? generateId());
    const deadlines = normalizeDeadlineFields(value['content'], value);
    return {
      id,
      content: normalizeTaskContent(value['content'], id, deadlines),
      ...deadlines,
      position: Number(value['position'] ?? position),
      lastModifiedAt: String(value['lastModifiedAt'] ?? fallbackTimestamp),
      serverRevision: revision(value['serverRevision']),
      ...(value['deleted'] === true ? { deleted: true } : {}),
      ...(value['created'] === true ? { created: true } : {}),
      ...(value['dirty'] === true ? { dirty: true } : {}),
    };
  }

  const id = isRecord(value) ? String(value['id'] ?? generateId()) : generateId();
  const deadlines = normalizeDeadlineFields(value, isRecord(value) ? value : undefined);
  return {
    id,
    content: normalizeTaskContent(value, id, deadlines),
    ...deadlines,
    position,
    lastModifiedAt: fallbackTimestamp,
    serverRevision: 0,
    dirty: true,
  };
}

function normalizeList(value: LegacyList, fallbackTimestamp: string): StoredList {
  const timestamp = String(
    value.metadataLastModifiedAt ?? value.lastModifiedAt ?? fallbackTimestamp,
  );
  const rawItems = Array.isArray(value.items)
    ? value.items
    : Array.isArray(value.content)
      ? value.content
      : [];

  return {
    id: String(value.id ?? generateId()),
    title: NEUTRAL_LIST_TITLE,
    metadataLastModifiedAt: timestamp,
    serverRevision: revision(value.serverRevision),
    itemsOrderRevision: revision(value.itemsOrderRevision),
    itemsBaseOrderRevision: revision(value.itemsBaseOrderRevision ?? value.itemsOrderRevision),
    ...(value.dirty === true ? { dirty: true } : {}),
    ...(value.itemsOrderDirty === true ? { itemsOrderDirty: true } : {}),
    items: rawItems
      .map((item, itemIndex) => normalizeItem(item, itemIndex, timestamp))
      .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id)),
  };
}

function createEmptyList(timestamp: string = nowIso(), id: string = generateId()): StoredList {
  return {
    id,
    title: NEUTRAL_LIST_TITLE,
    metadataLastModifiedAt: timestamp,
    serverRevision: 0,
    itemsOrderRevision: 0,
    itemsBaseOrderRevision: 0,
    dirty: true,
    items: [],
  };
}

function normalizeLists(
  values: LegacyList[],
  sectionId: string,
  fallbackTimestamp: string,
): StoredList[] {
  if (values.length === 0) {
    return [createEmptyList(fallbackTimestamp, deterministicId(`${sectionId}:task-list`))];
  }

  const entries = values.map((value, sourceIndex) => ({
    value,
    sourceIndex,
    list: normalizeList(value, fallbackTimestamp),
  }));
  const plan = planSingleListMigration(
    entries.map(entry => ({
      id: entry.list.id,
      isBacklog: entry.value.isBacklog,
      sourceIndex: entry.sourceIndex,
      items: entry.list.items,
    })),
    sectionId,
    deterministicId,
  );
  if (!plan) return [createEmptyList(fallbackTimestamp, deterministicId(`${sectionId}:task-list`))];

  const canonical = entries.find(entry => entry.list.id === plan.canonicalListId)!.list;
  const mergedItems = plan.items.map(planned => {
    const rekeyed = planned.duplicated
      ? {
          ...planned.item,
          id: planned.id,
          content: normalizeTaskContent(planned.item.content, planned.id),
          serverRevision: 0,
          created: true,
          dirty: true,
        }
      : planned.item;
    return { ...rekeyed, position: planned.position };
  });
  const mergedMultipleLists = values.length > 1;
  return [{
    ...canonical,
    title: NEUTRAL_LIST_TITLE,
    ...(mergedMultipleLists ? { dirty: true, itemsOrderDirty: true } : {}),
    itemsBaseOrderRevision: mergedMultipleLists
      ? canonical.itemsOrderRevision
      : canonical.itemsBaseOrderRevision,
    items: mergedItems,
  }];
}

function normalizeSection(
  value: LegacySection,
  index: number,
  fallbackTimestamp: string,
): StoredSection {
  const timestamp = String(value.metadataLastModifiedAt ?? fallbackTimestamp);
  const lists = Array.isArray(value.lists) ? value.lists : [];
  const id = String(value.id ?? generateId());

  return {
    id,
    ...(typeof value.ownerId === 'string' && value.ownerId.length > 0 ? { ownerId: value.ownerId } : {}),
    title: String(value.title ?? 'my tasks'),
    position: Number(value.position ?? index),
    metadataLastModifiedAt: timestamp,
    serverRevision: revision(value.serverRevision),
    ...(value.isShared === true ? { isShared: true } : {}),
    ...(typeof value.shareToken === 'string' && value.shareToken.length > 0 ? { shareToken: value.shareToken } : {}),
    ...(value.sharedAccess === true ? { sharedAccess: true } : {}),
    ...(value.deleted === true ? { deleted: true } : {}),
    ...(value.created === true || value.isNew === true ? { created: true } : {}),
    ...(value.dirty === true ? { dirty: true } : {}),
    lists: normalizeLists(lists, id, timestamp),
  };
}

function normalizePartition(value: unknown): Partition {
  const timestamp = nowIso();
  if (!isRecord(value)) {
    return { syncGeneration: 0, sectionOrderRevision: 0, sectionBaseOrderRevision: 0, sections: [] };
  }

  if (!Array.isArray(value['sections'])) {
    return { syncGeneration: 0, sectionOrderRevision: 0, sectionBaseOrderRevision: 0, sections: [] };
  }
  const sectionOrderRevision = revision(value['sectionOrderRevision']);

  return {
    syncGeneration: revision(value['syncGeneration']),
    sectionOrderRevision,
    sectionBaseOrderRevision: revision(value['sectionBaseOrderRevision'] ?? sectionOrderRevision),
    ...(value['sectionOrderDirty'] === true ? { sectionOrderDirty: true } : {}),
    ...(value['cloudReplacePending'] === true ? { cloudReplacePending: true } : {}),
    sections: value['sections']
      .map((section, index) => normalizeSection(section as LegacySection, index, timestamp))
      .sort((a, b) => a.position - b.position),
  };
}

function createDefaultPartition(): Partition {
  const timestamp = nowIso();
  const firstTaskId = generateId();
  const firstSubtaskId = generateId();
  const secondTaskId = generateId();

  return {
    syncGeneration: 0,
    sectionOrderRevision: 0,
    sectionBaseOrderRevision: 0,
    sections: [
      {
        id: generateId(),
        title: 'my list',
        position: 0,
        metadataLastModifiedAt: timestamp,
        serverRevision: 0,
        dirty: true,
        lists: [
          {
            id: generateId(),
            title: NEUTRAL_LIST_TITLE,
            metadataLastModifiedAt: timestamp,
            serverRevision: 0,
            itemsOrderRevision: 0,
            itemsBaseOrderRevision: 0,
            dirty: true,
            items: [
              {
                id: firstTaskId,
                content: {
                  id: firstTaskId,
                  text: 'my tasks...',
                  done: false,
                  subtasks: [{ id: firstSubtaskId, text: 'my subtask...', done: false }],
                },
                position: 0,
                lastModifiedAt: timestamp,
                serverRevision: 0,
                dirty: true,
              },
              {
                id: secondTaskId,
                content: { id: secondTaskId, text: 'my task...', done: false, subtasks: [] },
                position: 1,
                lastModifiedAt: timestamp,
                serverRevision: 0,
                dirty: true,
              },
            ],
          },
        ],
      },
    ],
  };
}

function cloneItemForUser(item: StoredItem, position: number): StoredItem {
  const id = generateId();
  return {
    id,
    content: normalizeTaskContent(item.content, id),
    position,
    lastModifiedAt: item.lastModifiedAt,
    serverRevision: 0,
    created: true,
    dirty: true,
  };
}

function cloneListForUser(list: StoredList): StoredList {
  return {
    id: generateId(),
    title: NEUTRAL_LIST_TITLE,
    metadataLastModifiedAt: list.metadataLastModifiedAt,
    serverRevision: 0,
    itemsOrderRevision: 0,
    itemsBaseOrderRevision: 0,
    dirty: true,
    items: list.items
      .filter((item) => !item.deleted)
      .map((item, index) => cloneItemForUser(item, index)),
  };
}

function cloneSectionForUser(section: StoredSection): StoredSection {
  if (section.sharedAccess || section.ownerId) {
    return {
      ...section,
      created: false,
      dirty: false,
      lists: section.lists.map((list) => ({
        ...list,
        dirty: false,
        items: list.items.map((item) => ({ ...item, dirty: false, created: false })),
      })),
    };
  }

  return {
    id: generateId(),
    title: section.title,
    position: section.position,
    metadataLastModifiedAt: section.metadataLastModifiedAt,
    serverRevision: 0,
    created: true,
    dirty: true,
    lists: section.lists.map((list) => cloneListForUser(list)),
  };
}

@Injectable({ providedIn: 'root' })
export class StorageService {
  private activeKey = ANONYMOUS_KEY;
  private readonly legacyPartitionFallbacks = new Map<string, Partition>();
  private sectionOrderLocalRevision = 0;
  private localMutationRevision = 0;
  private readonly itemRevisions = new Map<string, number>();

  private buildKey(userId?: string): string {
    return userId ? `${LS_PREFIX}nominal_${userId}` : ANONYMOUS_KEY;
  }

  private activeSectionPreferenceKey(): string {
    return `${this.activeKey}:active_section_id`;
  }

  private legacyPartitionKeys(userId?: string): string[] {
    if (!userId) return [`${LEGACY_LS_PREFIX}anonymous`];
    return [
      `${LEGACY_LS_PREFIX}nominal_${userId}`,
      `${LEGACY_LS_PREFIX}${userId}`,
      `${LEGACY_LS_PREFIX}premium_${userId}`,
    ];
  }

  private itemRevisionKey(sectionId: string, listId: string): string {
    return `${this.activeKey}:${sectionId}:${listId}`;
  }

  private bumpItemsRevision(sectionId: string, listId: string): void {
    const key = this.itemRevisionKey(sectionId, listId);
    this.itemRevisions.set(key, (this.itemRevisions.get(key) ?? 0) + 1);
  }

  private markLocalMutation(): void {
    this.localMutationRevision += 1;
  }

  getItemsRevision(sectionId: string, listId: string): number {
    return this.itemRevisions.get(this.itemRevisionKey(sectionId, listId)) ?? 0;
  }

  getLocalMutationRevision(): number {
    return this.localMutationRevision;
  }

  getSectionOrderLocalRevision(): number {
    return this.sectionOrderLocalRevision;
  }

  private markSectionOrderDirty(partition: Partition): void {
    if (!partition.sectionOrderDirty) {
      partition.sectionOrderDirty = true;
      partition.sectionBaseOrderRevision = partition.sectionOrderRevision;
    }
    this.sectionOrderLocalRevision += 1;
  }

  private markListOrderDirty(list: StoredList): void {
    if (list.itemsOrderDirty) return;
    list.itemsOrderDirty = true;
    list.itemsBaseOrderRevision = list.itemsOrderRevision;
  }

  setActivePartition(userId?: string): void {
    this.activeKey = this.buildKey(userId);
    this.migrateLegacyPartition(userId);
  }

  isPartitionEmpty(userId?: string): boolean {
    const fallback = this.migrateLegacyPartition(userId);
    const partition = this.readPartition(this.buildKey(userId)) ?? fallback;
    return !partition || partition.sections.filter((section) => !section.deleted).length === 0;
  }

  ensureDefaultPartition(): boolean {
    const fallback = this.migrateLegacyPartition(this.getActiveUserId());
    const partition = this.readPartition(this.activeKey) ?? fallback;
    if (partition && partition.sections.some((section) => !section.deleted)) return false;

    const created = createDefaultPartition();
    this.markLocalMutation();
    this.save(created);
    return true;
  }

  getActiveUserId(): string | undefined {
    const suffix = this.activeKey.slice(LS_PREFIX.length);
    return suffix.startsWith('nominal_') ? suffix.slice('nominal_'.length) : undefined;
  }

  getActiveSectionPreference(): string | null {
    try {
      const value = localStorage.getItem(this.activeSectionPreferenceKey());
      return value && value.length > 0 ? value : null;
    } catch {
      return null;
    }
  }

  setActiveSectionPreference(sectionId: string | null): void {
    try {
      if (sectionId && sectionId.length > 0) {
        localStorage.setItem(this.activeSectionPreferenceKey(), sectionId);
      } else {
        localStorage.removeItem(this.activeSectionPreferenceKey());
      }
    } catch {
      // Ignore storage errors.
    }
  }

  load(): Partition {
    const fallback = this.migrateLegacyPartition(this.getActiveUserId());
    const partition = this.readPartition(this.activeKey) ?? fallback;
    if (!this.getActiveUserId()) {
      if (!partition || partition.sections.filter((section) => !section.deleted).length === 0) {
        const created = createDefaultPartition();
        this.save(created);
        return created;
      }
    }

    if (partition) return partition;

    return { syncGeneration: 0, sectionOrderRevision: 0, sectionBaseOrderRevision: 0, sections: [] };
  }

  save(partition: Partition): void {
    try {
      localStorage.setItem(this.activeKey, JSON.stringify(normalizePartition(partition)));
      this.legacyPartitionFallbacks.delete(this.activeKey);
    } catch {
      // Ignore quota errors.
    }
  }

  loadSections(): StoredSection[] {
    return this.load()
      .sections.filter((section) => !section.deleted)
      .sort((a, b) => a.position - b.position);
  }

  loadAllSectionsForSync(): StoredSection[] {
    return this.load().sections;
  }

  getSyncGeneration(): number {
    return this.load().syncGeneration;
  }

  isCloudReplacePending(): boolean {
    return this.load().cloudReplacePending === true;
  }

  markCloudReplacePending(serverGeneration: number): void {
    const partition = this.load();
    if (!partition.cloudReplacePending) {
      partition.syncGeneration = Math.max(partition.syncGeneration, serverGeneration) + 1;
    }
    partition.cloudReplacePending = true;
    this.save(partition);
  }

  acceptServerSyncGeneration(syncGeneration: number): void {
    const partition = this.load();
    partition.syncGeneration = syncGeneration;
    delete partition.cloudReplacePending;
    this.save(partition);
  }

  saveSections(sections: StoredSection[], options?: { markOrderDirty?: boolean }): void {
    const partition = this.load();
    const incomingIds = new Set(sections.map((section) => section.id));
    const pendingDeleted = partition.sections.filter(
      (section) => section.deleted && !incomingIds.has(section.id),
    );
    partition.sections = [...sections, ...pendingDeleted];
    if (options?.markOrderDirty) {
      this.markSectionOrderDirty(partition);
      this.markLocalMutation();
    }
    this.save(partition);
  }

  getSection(sectionId: string): StoredSection | undefined {
    return this.load().sections.find((section) => section.id === sectionId);
  }

  ensureSectionHasTaskList(sectionId: string): boolean {
    const partition = this.load();
    const section = partition.sections.find((existing) => existing.id === sectionId && !existing.deleted);
    if (!section) return false;

    if (section.lists.length === 1) return false;
    section.lists = normalizeLists(section.lists as LegacyList[], section.id, section.metadataLastModifiedAt);
    this.markLocalMutation();
    this.save(partition);
    return true;
  }

  upsertSection(section: StoredSection): void {
    const partition = this.load();
    const index = partition.sections.findIndex((existing) => existing.id === section.id);
    if (index >= 0) {
      partition.sections[index] = { ...section, lists: partition.sections[index].lists };
    } else {
      partition.sections.push(section);
    }
    this.markLocalMutation();
    this.save(partition);
  }

  upsertSectionSnapshot(section: StoredSection): void {
    const partition = this.load();
    const index = partition.sections.findIndex((existing) => existing.id === section.id);
    if (index >= 0) {
      partition.sections[index] = {
        ...section,
        position: partition.sections[index].position,
      };
    } else {
      const nextPosition = partition.sections
        .filter((existing) => !existing.deleted)
        .reduce((max, existing) => Math.max(max, existing.position), -1) + 1;
      partition.sections.push({ ...section, position: nextPosition });
    }
    this.save(partition);
  }

  removeSection(sectionId: string): void {
    const partition = this.load();
    const section = partition.sections.find((existing) => existing.id === sectionId);
    if (section) {
      section.deleted = true;
      section.dirty = true;
      section.metadataLastModifiedAt = nowIso();
      this.markLocalMutation();
    }
    this.save(partition);
  }

  getSectionOrderSync(): OrderSyncPayload | undefined {
    const partition = this.load();
    if (!partition.sectionOrderDirty) return undefined;

    return {
      baseOrderRevision: partition.sectionBaseOrderRevision,
      orderedIds: partition.sections
        .filter((section) => !section.deleted)
        .sort((a, b) => a.position - b.position)
        .map((section) => section.id),
    };
  }

  getSectionBaseOrderRevision(): number {
    const partition = this.load();
    return partition.sectionOrderDirty
      ? partition.sectionBaseOrderRevision
      : partition.sectionOrderRevision;
  }

  applySyncedSections(response: SectionsSyncResponse, options?: { replaceLocal?: boolean }): boolean {
    const synced = response.sections;
    const partition = this.load();
    const existingMap = new Map(partition.sections.map((section) => [section.id, section]));
    let rebasedLocalSections = false;

    const remoteIds = new Set(synced.map((section) => section.id));
    const merged = synced.map((section) => {
      const existing = existingMap.get(section.id);
      if (!options?.replaceLocal && existing && !shouldAcceptRemote(section, existing)) {
        return {
          ...existing,
          position: section.position,
          lists: mergeSyncedLists(section.lists ?? existing.lists, existing.lists, false, section.id),
        };
      }

      return {
        id: section.id,
        ...(section.ownerId ? { ownerId: section.ownerId } : {}),
        title: section.title,
        position: section.position,
        metadataLastModifiedAt: section.metadataLastModifiedAt,
        serverRevision: section.serverRevision,
        ...(section.isShared ? { isShared: true } : {}),
        ...(section.shareToken ? { shareToken: section.shareToken } : {}),
        ...(section.sharedAccess ? { sharedAccess: true } : {}),
        ...(section.deleted ? { deleted: true } : {}),
        lists: section.deleted
          ? []
          : mergeSyncedLists(
              section.lists ?? (options?.replaceLocal ? [] : existing?.lists ?? []),
              existing?.lists ?? [],
              options?.replaceLocal,
              section.id,
            ),
      };
    });

    if (!options?.replaceLocal) {
      for (const section of partition.sections) {
        if (!remoteIds.has(section.id) && section.dirty && !section.deleted) {
          if (section.created || section.serverRevision === 0) {
            merged.push(section);
          } else {
            const cloned = cloneSectionForUser(section);
            cloned.position = merged.length;
            merged.push(cloned);
            rebasedLocalSections = true;
          }
        }
      }
    }

    merged.forEach((section, index) => {
      section.position = index;
    });

    const nextPartition: Partition = {
      syncGeneration: response.syncGeneration ?? partition.syncGeneration,
      sectionOrderRevision: response.sectionOrderRevision,
      sectionBaseOrderRevision: response.sectionOrderRevision,
      sections: merged,
    };
    if (rebasedLocalSections) {
      this.markSectionOrderDirty(nextPartition);
    }

    this.save(nextPartition);
    return rebasedLocalSections;
  }

  applySectionPositions(
    positions: { id: string; position: number }[],
    orderRevision: number,
  ): void {
    const positionMap = new Map(positions.map((section) => [section.id, section.position]));
    const partition = this.load();
    partition.sections = partition.sections.map((section) => ({
      ...section,
      position: positionMap.get(section.id) ?? section.position,
    }));
    partition.sectionOrderRevision = orderRevision;
    partition.sectionBaseOrderRevision = orderRevision;
    delete partition.sectionOrderDirty;
    this.save(partition);
  }

  getListsForSection(sectionId: string): StoredList[] {
    return this.getSection(sectionId)?.lists ?? [];
  }

  upsertList(sectionId: string, list: StoredList): void {
    const partition = this.load();
    const section = partition.sections.find((existing) => existing.id === sectionId);
    if (!section) return;

    const existing = section.lists[0];
    section.lists = [{
      ...list,
      title: NEUTRAL_LIST_TITLE,
      items: existing?.id === list.id ? existing.items : list.items,
    }];
    this.markLocalMutation();
    this.save(partition);
  }

  setListsForSection(sectionId: string, lists: StoredList[]): void {
    const partition = this.load();
    const section = partition.sections.find((existing) => existing.id === sectionId);
    if (!section) return;

    section.lists = mergeSyncedLists(lists, section.lists, false, sectionId);
    this.save(partition);
  }

  getItemsForList(sectionId: string, listId: string): StoredItem[] {
    return this.getListsForSection(sectionId).find((list) => list.id === listId)?.items ?? [];
  }

  getListOrderSync(sectionId: string, listId: string): OrderSyncPayload | undefined {
    const list = this.getListsForSection(sectionId).find((existing) => existing.id === listId);
    if (!list?.itemsOrderDirty) return undefined;

    return {
      baseOrderRevision: list.itemsBaseOrderRevision,
      orderedIds: list.items
        .filter((item) => !item.deleted)
        .sort((a, b) => a.position - b.position)
        .map((item) => item.id),
    };
  }

  getListBaseOrderRevision(sectionId: string, listId: string): number {
    const list = this.getListsForSection(sectionId).find((existing) => existing.id === listId);
    if (!list) return 0;
    return list.itemsOrderDirty ? list.itemsBaseOrderRevision : list.itemsOrderRevision;
  }

  setItemsForList(
    sectionId: string,
    listId: string,
    items: StoredItem[],
    options?: { touchRevision?: boolean; markOrderDirty?: boolean },
  ): void {
    const partition = this.load();
    const section = partition.sections.find((existing) => existing.id === sectionId);
    const list = section?.lists.find((existing) => existing.id === listId);
    if (!list) return;

    list.items = items.sort((a, b) => a.position - b.position);
    if (options?.markOrderDirty) {
      this.markListOrderDirty(list);
    }
    if (options?.touchRevision !== false) {
      this.markLocalMutation();
    }
    this.save(partition);
    if (options?.touchRevision !== false) {
      this.bumpItemsRevision(sectionId, listId);
    }
  }

  applySyncedItems(
    sectionId: string,
    listId: string,
    response: ItemsSyncResponse,
    expectedRevision?: number,
  ): boolean {
    if (
      expectedRevision !== undefined &&
      this.getItemsRevision(sectionId, listId) !== expectedRevision
    ) {
      return false;
    }

    const items = response.items.map((item, position) => normalizeItem(
      item,
      position,
      item.lastModifiedAt,
    ));
    const list = this.getListsForSection(sectionId).find((existing) => existing.id === listId);
    const localItems = this.getItemsForList(sectionId, listId);
    const shouldKeepLocalOrder =
      list?.itemsOrderDirty === true &&
      !sameOrder(activeItemOrder(localItems), activeItemOrder(items));
    const { items: merged } = mergeSyncedItems(items, localItems, list?.itemsOrderDirty === true);

    this.setItemsForList(sectionId, listId, merged, { touchRevision: false });
    if (shouldKeepLocalOrder) {
      this.rebaseDirtyListOrderRevision(sectionId, listId, response.itemsOrderRevision);
    } else {
      this.applyListOrderRevision(sectionId, listId, response.itemsOrderRevision);
    }
    return true;
  }

  rebaseDirtyListOrderRevision(sectionId: string, listId: string, orderRevision: number): void {
    const partition = this.load();
    const list = partition.sections
      .find((section) => section.id === sectionId)
      ?.lists.find((existing) => existing.id === listId);
    if (!list) return;

    list.itemsOrderRevision = orderRevision;
    list.itemsBaseOrderRevision = orderRevision;
    list.itemsOrderDirty = true;
    this.save(partition);
  }

  applyListOrderRevision(sectionId: string, listId: string, orderRevision: number): void {
    const partition = this.load();
    const list = partition.sections
      .find((section) => section.id === sectionId)
      ?.lists.find((existing) => existing.id === listId);
    if (!list) return;

    list.itemsOrderRevision = orderRevision;
    list.itemsBaseOrderRevision = orderRevision;
    delete list.itemsOrderDirty;
    this.save(partition);
  }

  applyItemPositions(
    sectionId: string,
    listId: string,
    positions: { id: string; position: number }[],
    orderRevision: number,
  ): void {
    const positionMap = new Map(positions.map((item) => [item.id, item.position]));
    const items = this.getItemsForList(sectionId, listId).map((item) => ({
      ...item,
      position: positionMap.get(item.id) ?? item.position,
    }));
    this.setItemsForList(sectionId, listId, items, { touchRevision: false });
    this.applyListOrderRevision(sectionId, listId, orderRevision);
  }

  optimisticallyMoveItem(
    sourceSectionId: string,
    itemId: string,
    targetSectionId: string,
    targetPosition: number,
  ): MoveItemRollback | null {
    if (sourceSectionId === targetSectionId) return null;

    const partition = this.load();
    const sourceSection = partition.sections.find(
      (section) => section.id === sourceSectionId && !section.deleted,
    );
    const targetSection = partition.sections.find(
      (section) => section.id === targetSectionId && !section.deleted,
    );
    const sourceList = sourceSection?.lists[0];
    const targetList = targetSection?.lists[0];
    if (!sourceList || !targetList) return null;

    const sourceActive = sourceList.items
      .filter((item) => !item.deleted)
      .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
    const movedItem = sourceActive.find((item) => item.id === itemId);
    if (!movedItem || targetList.items.some((item) => item.id === itemId)) return null;

    const rollbackSource = {
      ...sourceList,
      items: sourceList.items.map((item) => ({ ...item })),
    };
    const rollbackTarget = {
      ...targetList,
      items: targetList.items.map((item) => ({ ...item })),
    };
    const baseSourceOrderRevision = sourceList.itemsOrderDirty
      ? sourceList.itemsBaseOrderRevision
      : sourceList.itemsOrderRevision;
    const baseTargetOrderRevision = targetList.itemsOrderDirty
      ? targetList.itemsBaseOrderRevision
      : targetList.itemsOrderRevision;

    const nextSourceActive = sourceActive.filter((item) => item.id !== itemId);
    const targetActive = targetList.items
      .filter((item) => !item.deleted)
      .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
    const requestedPosition = Number.isFinite(targetPosition)
      ? Math.trunc(targetPosition)
      : targetActive.length;
    const insertionIndex = Math.max(0, Math.min(requestedPosition, targetActive.length));
    targetActive.splice(insertionIndex, 0, movedItem);

    const sourceDeleted = sourceList.items
      .filter((item) => item.deleted)
      .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
    const targetDeleted = targetList.items
      .filter((item) => item.deleted)
      .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
    sourceList.items = [...nextSourceActive, ...sourceDeleted]
      .map((item, position) => ({ ...item, position }));
    targetList.items = [...targetActive, ...targetDeleted]
      .map((item, position) => ({ ...item, position }));
    this.markListOrderDirty(sourceList);
    this.markListOrderDirty(targetList);
    this.markLocalMutation();
    this.save(partition);
    this.bumpItemsRevision(sourceSectionId, sourceList.id);
    this.bumpItemsRevision(targetSectionId, targetList.id);

    return {
      itemId,
      expectedItemServerRevision: movedItem.serverRevision,
      sourceSectionId,
      sourceList: rollbackSource,
      sourceItemsRevision: this.getItemsRevision(sourceSectionId, sourceList.id),
      baseSourceOrderRevision,
      targetSectionId,
      targetList: rollbackTarget,
      targetItemsRevision: this.getItemsRevision(targetSectionId, targetList.id),
      baseTargetOrderRevision,
    };
  }

  applyMovedItemResponse(response: MoveItemResponse, rollback?: MoveItemRollback): boolean {
    if (
      rollback &&
      (
        response.item.id !== rollback.itemId ||
        response.source.sectionId !== rollback.sourceSectionId ||
        response.target.sectionId !== rollback.targetSectionId ||
        this.getItemsRevision(rollback.sourceSectionId, rollback.sourceList.id) !== rollback.sourceItemsRevision ||
        this.getItemsRevision(rollback.targetSectionId, rollback.targetList.id) !== rollback.targetItemsRevision
      )
    ) {
      return false;
    }

    const partition = this.load();
    const sourceList = partition.sections
      .find((section) => section.id === response.source.sectionId && !section.deleted)
      ?.lists.find((list) => list.id === response.source.listId);
    const targetList = partition.sections
      .find((section) => section.id === response.target.sectionId && !section.deleted)
      ?.lists.find((list) => list.id === response.target.listId);
    if (!sourceList || !targetList) return false;

    sourceList.items = sourceList.items.filter((item) => item.id !== response.item.id);
    const normalizedMovedItem = cleanSyncedItem(normalizeItem(
      response.item,
      response.item.position,
      response.item.lastModifiedAt,
    ));
    targetList.items = [
      ...targetList.items.filter((item) => item.id !== response.item.id),
      normalizedMovedItem,
    ];
    this.applyAuthoritativeItemOrder(sourceList, response.source);
    this.applyAuthoritativeItemOrder(targetList, response.target);
    this.save(partition);
    this.bumpItemsRevision(response.source.sectionId, response.source.listId);
    this.bumpItemsRevision(response.target.sectionId, response.target.listId);
    return true;
  }

  rollbackMovedItem(rollback: MoveItemRollback): boolean {
    if (
      this.getItemsRevision(rollback.sourceSectionId, rollback.sourceList.id) !== rollback.sourceItemsRevision ||
      this.getItemsRevision(rollback.targetSectionId, rollback.targetList.id) !== rollback.targetItemsRevision
    ) {
      return false;
    }

    const partition = this.load();
    const sourceSection = partition.sections.find(
      (section) => section.id === rollback.sourceSectionId && !section.deleted,
    );
    const targetSection = partition.sections.find(
      (section) => section.id === rollback.targetSectionId && !section.deleted,
    );
    if (!sourceSection || !targetSection) return false;

    sourceSection.lists = [{
      ...rollback.sourceList,
      items: rollback.sourceList.items.map((item) => ({ ...item })),
    }];
    targetSection.lists = [{
      ...rollback.targetList,
      items: rollback.targetList.items.map((item) => ({ ...item })),
    }];
    this.markLocalMutation();
    this.save(partition);
    this.bumpItemsRevision(rollback.sourceSectionId, rollback.sourceList.id);
    this.bumpItemsRevision(rollback.targetSectionId, rollback.targetList.id);
    return true;
  }

  private applyAuthoritativeItemOrder(list: StoredList, state: MovedItemOrderState): void {
    const positionMap = new Map(state.positions.map((item) => [item.id, item.position]));
    const active = list.items.filter((item) => !item.deleted);
    const positioned = active
      .filter((item) => positionMap.has(item.id))
      .sort((left, right) =>
        (positionMap.get(left.id) ?? left.position) - (positionMap.get(right.id) ?? right.position) ||
        left.id.localeCompare(right.id),
      );
    const pending = active
      .filter((item) => !positionMap.has(item.id))
      .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
    const deleted = list.items
      .filter((item) => item.deleted)
      .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
    list.items = [...positioned, ...pending, ...deleted]
      .map((item, position) => ({ ...item, position }));
    list.itemsOrderRevision = state.itemsOrderRevision;
    list.itemsBaseOrderRevision = state.itemsOrderRevision;
    if (pending.length > 0) {
      list.itemsOrderDirty = true;
    } else {
      delete list.itemsOrderDirty;
    }
  }

  copyAnonymousToUser(userId: string): void {
    const fallback = this.migrateLegacyPartition();
    const source = this.readPartition(ANONYMOUS_KEY) ?? fallback ?? {
      syncGeneration: 0,
      sectionOrderRevision: 0,
      sectionBaseOrderRevision: 0,
      sections: [],
    };
    const partition: Partition = {
      syncGeneration: 0,
      sectionOrderRevision: 0,
      sectionBaseOrderRevision: 0,
      sections: source.sections
        .filter((section) => !section.deleted)
        .map((section) => cloneSectionForUser(section)),
    };

    try {
      localStorage.setItem(this.buildKey(userId), JSON.stringify(partition));
    } catch {
      // Ignore quota errors.
    }
  }

  copyUserToAnonymous(_userId: string): void {
    this.setActivePartition();
  }

  removeUserPartition(userId: string): void {
    try {
      localStorage.removeItem(this.buildKey(userId));
      localStorage.removeItem(`${this.buildKey(userId)}:active_section_id`);
      for (const key of this.legacyPartitionKeys(userId)) {
        localStorage.removeItem(key);
        localStorage.removeItem(`${key}:active_section_id`);
      }
    } catch {
      // Ignore storage errors.
    }
  }

  private readPartition(key: string): Partition | null {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      return isRecord(parsed) && Array.isArray(parsed['sections'])
        ? normalizePartition(parsed)
        : null;
    } catch {
      return null;
    }
  }

  private readPrivatePartition(key: string): Partition {
    return this.readPartition(key) ?? {
      syncGeneration: 0,
      sectionOrderRevision: 0,
      sectionBaseOrderRevision: 0,
      sections: [],
    };
  }

  private writePartition(key: string, partition: Partition): void {
    try {
      localStorage.setItem(key, JSON.stringify(normalizePartition(partition)));
      this.legacyPartitionFallbacks.delete(key);
    } catch {
      // Ignore quota errors.
    }
  }

  private migrateLegacyPartition(userId?: string): Partition | null {
    const targetKey = this.buildKey(userId);
    const existing = this.readPartition(targetKey);
    if (existing) {
      this.legacyPartitionFallbacks.delete(targetKey);
      return existing;
    }
    try {
      for (const key of this.legacyPartitionKeys(userId)) {
        const partition = this.readPartition(key);
        if (partition) {
          const serialized = JSON.stringify(partition);
          try {
            localStorage.setItem(targetKey, serialized);
          } catch {
            this.legacyPartitionFallbacks.set(targetKey, partition);
          }
          const targetPreferenceKey = `${targetKey}:active_section_id`;
          const legacyPreference = localStorage.getItem(`${key}:active_section_id`);
          if (!localStorage.getItem(targetPreferenceKey) && legacyPreference) {
            try {
              localStorage.setItem(targetPreferenceKey, legacyPreference);
            } catch {
              // The partition fallback remains usable when preference storage is full.
            }
          }
          const migrated = this.readPartition(targetKey);
          if (migrated) {
            this.legacyPartitionFallbacks.delete(targetKey);
            return migrated;
          }
          this.legacyPartitionFallbacks.set(targetKey, partition);
          return partition;
        }
      }
    } catch {
      // Use the last normalized legacy value when storage is temporarily unavailable.
    }
    return this.legacyPartitionFallbacks.get(targetKey) ?? null;
  }
}
