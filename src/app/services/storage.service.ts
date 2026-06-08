import { Injectable } from '@angular/core';

export interface StoredItem {
  id: string;
  content: unknown;
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
  isBacklog: boolean;
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
  lastModifiedAt?: string;
  content?: unknown[];
};

const LS_PREFIX = 'splendide_v2_';
const ANONYMOUS_KEY = `${LS_PREFIX}anonymous`;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeSubtasks(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];

  return value.map((subtask) => {
    if (!isRecord(subtask)) return subtask;
    return { ...subtask, id: String(subtask['id'] ?? generateId()) };
  });
}

function normalizeTaskContent(value: unknown, fallbackId: string): unknown {
  if (!isRecord(value)) return value;

  return {
    ...value,
    id: fallbackId,
    subtasks: normalizeSubtasks(value['subtasks']),
  };
}

function normalizeItem(value: unknown, position: number, fallbackTimestamp: string): StoredItem {
  if (isRecord(value) && 'content' in value) {
    const id = String(value['id'] ?? generateId());
    return {
      id,
      content: normalizeTaskContent(value['content'], id),
      position: Number(value['position'] ?? position),
      lastModifiedAt: String(value['lastModifiedAt'] ?? fallbackTimestamp),
      serverRevision: revision(value['serverRevision']),
      ...(value['deleted'] === true ? { deleted: true } : {}),
      ...(value['created'] === true ? { created: true } : {}),
      ...(value['dirty'] === true ? { dirty: true } : {}),
    };
  }

  const id = isRecord(value) ? String(value['id'] ?? generateId()) : generateId();
  return {
    id,
    content: normalizeTaskContent(value, id),
    position,
    lastModifiedAt: fallbackTimestamp,
    serverRevision: 0,
    dirty: true,
  };
}

function normalizeUniqueItems(items: StoredItem[]): StoredItem[] {
  const usedIds = new Set<string>();
  return items.map((item) => {
    if (!usedIds.has(item.id)) {
      usedIds.add(item.id);
      return item;
    }

    const id = generateId();
    usedIds.add(id);
    return {
      ...item,
      id,
      content: normalizeTaskContent(item.content, id),
      serverRevision: 0,
      created: true,
      dirty: true,
    };
  });
}

function normalizeList(value: LegacyList, index: number, fallbackTimestamp: string): StoredList {
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
    title: String(value.title ?? (value.isBacklog ? 'later' : 'now')),
    metadataLastModifiedAt: timestamp,
    serverRevision: revision(value.serverRevision),
    itemsOrderRevision: revision(value.itemsOrderRevision),
    itemsBaseOrderRevision: revision(value.itemsBaseOrderRevision ?? value.itemsOrderRevision),
    ...(value.dirty === true ? { dirty: true } : {}),
    ...(value.itemsOrderDirty === true ? { itemsOrderDirty: true } : {}),
    isBacklog: Boolean(value.isBacklog ?? index === 1),
    items: normalizeUniqueItems(rawItems.map((item, itemIndex) => normalizeItem(item, itemIndex, timestamp)))
      .sort((a, b) => a.position - b.position),
  };
}

function createEmptyList(isBacklog: boolean, timestamp: string = nowIso()): StoredList {
  return {
    id: generateId(),
    title: isBacklog ? 'later' : 'now',
    metadataLastModifiedAt: timestamp,
    serverRevision: 0,
    itemsOrderRevision: 0,
    itemsBaseOrderRevision: 0,
    dirty: true,
    isBacklog,
    items: [],
  };
}

function normalizeSection(
  value: LegacySection,
  index: number,
  fallbackTimestamp: string,
): StoredSection {
  const timestamp = String(value.metadataLastModifiedAt ?? fallbackTimestamp);
  const lists = Array.isArray(value.lists) ? value.lists : [];

  return {
    id: String(value.id ?? generateId()),
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
    lists: lists.map((list, listIndex) => normalizeList(list, listIndex, timestamp)),
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
  const mainTaskId = generateId();
  const mainSubtaskId = generateId();
  const secondaryTaskId = generateId();

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
            title: 'now',
            metadataLastModifiedAt: timestamp,
            serverRevision: 0,
            itemsOrderRevision: 0,
            itemsBaseOrderRevision: 0,
            dirty: true,
            isBacklog: false,
            items: [
              {
                id: mainTaskId,
                content: {
                  id: mainTaskId,
                  text: 'my tasks...',
                  done: false,
                  subtasks: [{ id: mainSubtaskId, text: 'my subtask...', done: false }],
                },
                position: 0,
                lastModifiedAt: timestamp,
                serverRevision: 0,
                dirty: true,
              },
            ],
          },
          {
            id: generateId(),
            title: 'later',
            metadataLastModifiedAt: timestamp,
            serverRevision: 0,
            itemsOrderRevision: 0,
            itemsBaseOrderRevision: 0,
            dirty: true,
            isBacklog: true,
            items: [
              {
                id: secondaryTaskId,
                content: { id: secondaryTaskId, text: 'my task...', done: false, subtasks: [] },
                position: 0,
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
    title: list.title,
    metadataLastModifiedAt: list.metadataLastModifiedAt,
    serverRevision: 0,
    itemsOrderRevision: 0,
    itemsBaseOrderRevision: 0,
    dirty: true,
    isBacklog: list.isBacklog,
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
  private sectionOrderLocalRevision = 0;
  private readonly itemRevisions = new Map<string, number>();

  private buildKey(userId?: string): string {
    return userId ? `${LS_PREFIX}nominal_${userId}` : ANONYMOUS_KEY;
  }

  private legacyUserKeys(userId: string): string[] {
    return [`${LS_PREFIX}${userId}`, `${LS_PREFIX}premium_${userId}`];
  }

  private itemRevisionKey(sectionId: string, listId: string): string {
    return `${this.activeKey}:${sectionId}:${listId}`;
  }

  private bumpItemsRevision(sectionId: string, listId: string): void {
    const key = this.itemRevisionKey(sectionId, listId);
    this.itemRevisions.set(key, (this.itemRevisions.get(key) ?? 0) + 1);
  }

  getItemsRevision(sectionId: string, listId: string): number {
    return this.itemRevisions.get(this.itemRevisionKey(sectionId, listId)) ?? 0;
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
    if (userId) this.migrateLegacyUserPartition(userId);
  }

  isPartitionEmpty(userId?: string): boolean {
    const partition = this.readPartition(this.buildKey(userId));
    return !partition || partition.sections.filter((section) => !section.deleted).length === 0;
  }

  ensureDefaultPartition(): boolean {
    const partition = this.readPartition(this.activeKey);
    if (partition && partition.sections.some((section) => !section.deleted)) return false;

    const created = createDefaultPartition();
    this.save(created);
    return true;
  }

  getActiveUserId(): string | undefined {
    const suffix = this.activeKey.slice(LS_PREFIX.length);
    return suffix.startsWith('nominal_') ? suffix.slice('nominal_'.length) : undefined;
  }

  load(): Partition {
    const partition = this.readPartition(this.activeKey);
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
    }
    this.save(partition);
  }

  getSection(sectionId: string): StoredSection | undefined {
    return this.load().sections.find((section) => section.id === sectionId);
  }

  ensureSectionHasDefaultLists(sectionId: string): boolean {
    const partition = this.load();
    const section = partition.sections.find((existing) => existing.id === sectionId && !existing.deleted);
    if (!section) return false;

    const hasMainList = section.lists.some((list) => !list.isBacklog);
    const hasBacklogList = section.lists.some((list) => list.isBacklog);
    if (hasMainList && hasBacklogList) return false;

    const timestamp = nowIso();
    if (!hasMainList) {
      section.lists.push(createEmptyList(false, timestamp));
    }
    if (!hasBacklogList) {
      section.lists.push(createEmptyList(true, timestamp));
    }
    section.lists.sort((left, right) => Number(left.isBacklog) - Number(right.isBacklog));
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
        return { ...existing, position: section.position };
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
        lists: section.lists ?? (options?.replaceLocal ? [] : existing?.lists ?? []),
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

    const index = section.lists.findIndex((existing) => existing.id === list.id);
    if (index >= 0) {
      section.lists[index] = { ...list, items: section.lists[index].items };
    } else {
      section.lists.push(list);
    }
    this.save(partition);
  }

  setListsForSection(sectionId: string, lists: StoredList[]): void {
    const partition = this.load();
    const section = partition.sections.find((existing) => existing.id === sectionId);
    if (!section) return;

    const existingMap = new Map(section.lists.map((list) => [list.id, list]));
    const remoteIds = new Set(lists.map((list) => list.id));
    section.lists = lists.map((list) => {
      const existing = existingMap.get(list.id);
      if (existing && !shouldAcceptRemote(list, existing)) {
        return {
          ...existing,
          itemsOrderRevision: list.itemsOrderRevision,
        };
      }

      return {
        id: list.id,
        title: list.title,
        metadataLastModifiedAt: list.metadataLastModifiedAt,
        serverRevision: list.serverRevision,
        itemsOrderRevision: list.itemsOrderRevision,
        itemsBaseOrderRevision: existing?.itemsBaseOrderRevision ?? list.itemsOrderRevision,
        ...(existing?.itemsOrderDirty ? { itemsOrderDirty: true } : {}),
        isBacklog: list.isBacklog,
        items: list.items ?? existing?.items ?? [],
      };
    });

    for (const list of existingMap.values()) {
      const remoteHasSameRole = lists.some((remote) => remote.isBacklog === list.isBacklog);
      if (!remoteIds.has(list.id) && list.dirty && !remoteHasSameRole) {
        section.lists.push(list);
      }
    }
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

    const items = response.items;
    const localItems = this.getItemsForList(sectionId, listId);
    const localById = new Map(localItems.map((item) => [item.id, item]));
    const remoteIds = new Set(items.map((item) => item.id));
    const merged = items.map((item) => {
      const local = localById.get(item.id);
      if (
        local &&
        item.serverRevision === local.serverRevision &&
        item.deleted === local.deleted &&
        sameContent(item.content, local.content)
      ) {
        return {
          id: item.id,
          content: item.content,
          position: item.position,
          lastModifiedAt: item.lastModifiedAt,
          serverRevision: item.serverRevision,
          ...(item.deleted ? { deleted: true } : {}),
        };
      }

      if (local && item.deleted && item.serverRevision >= local.serverRevision) {
        return {
          id: item.id,
          content: item.content,
          position: item.position,
          lastModifiedAt: item.lastModifiedAt,
          serverRevision: item.serverRevision,
          deleted: true,
        };
      }

      if (local && shouldRebaseLocalDirtyItem(item, local)) {
        return rebaseLocalDirtyItem(item, local);
      }

      if (local && !shouldAcceptRemote(item, local)) {
        return { ...local, position: item.position };
      }

      return {
        id: item.id,
        content: item.content,
        position: item.position,
        lastModifiedAt: item.lastModifiedAt,
        serverRevision: item.serverRevision,
        ...(item.deleted ? { deleted: true } : {}),
      };
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

    this.setItemsForList(sectionId, listId, merged, { touchRevision: false });
    this.applyListOrderRevision(sectionId, listId, response.itemsOrderRevision);
    return true;
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

  copyAnonymousToUser(userId: string): void {
    const source = this.readPartition(ANONYMOUS_KEY) ?? {
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
      for (const key of this.legacyUserKeys(userId)) {
        localStorage.removeItem(key);
      }
    } catch {
      // Ignore storage errors.
    }
  }

  private readPartition(key: string): Partition | null {
    try {
      const raw = localStorage.getItem(key);
      return raw ? normalizePartition(JSON.parse(raw)) : null;
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
    } catch {
      // Ignore quota errors.
    }
  }

  private migrateLegacyUserPartition(userId: string): void {
    try {
      if (localStorage.getItem(this.activeKey)) return;

      for (const key of this.legacyUserKeys(userId)) {
        const partition = this.readPartition(key);
        if (partition) {
          localStorage.setItem(this.activeKey, JSON.stringify(partition));
          return;
        }
      }
    } catch {
      // Ignore migration errors.
    }
  }
}
