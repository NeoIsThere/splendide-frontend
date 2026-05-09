import { Injectable } from '@angular/core';

export interface StoredItem {
  id: string;
  content: unknown;
  position: number;
  lastModifiedAt: string;
  deleted?: boolean;
  created?: boolean;
}

export interface StoredList {
  id: string;
  title: string;
  metadataLastModifiedAt: string;
  isBacklog: boolean;
  items: StoredItem[];
}

export interface StoredSection {
  id: string;
  title: string;
  position: number;
  metadataLastModifiedAt: string;
  deleted?: boolean;
  created?: boolean;
  lists: StoredList[];
}

export interface Partition {
  sections: StoredSection[];
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeSubtasks(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];

  return value.map(subtask => {
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
      ...(value['deleted'] === true ? { deleted: true } : {}),
      ...(value['created'] === true ? { created: true } : {}),
    };
  }

  const id = isRecord(value) ? String(value['id'] ?? generateId()) : generateId();
  return {
    id,
    content: normalizeTaskContent(value, id),
    position,
    lastModifiedAt: fallbackTimestamp,
  };
}

function normalizeList(value: LegacyList, index: number, fallbackTimestamp: string): StoredList {
  const timestamp = String(value.metadataLastModifiedAt ?? value.lastModifiedAt ?? fallbackTimestamp);
  const rawItems = Array.isArray(value.items) ? value.items : (Array.isArray(value.content) ? value.content : []);

  return {
    id: String(value.id ?? generateId()),
    title: String(value.title ?? (value.isBacklog ? 'Later' : 'Now')),
    metadataLastModifiedAt: timestamp,
    isBacklog: Boolean(value.isBacklog ?? index === 1),
    items: rawItems
      .map((item, itemIndex) => normalizeItem(item, itemIndex, timestamp))
      .sort((a, b) => a.position - b.position),
  };
}

function normalizeSection(value: LegacySection, index: number, fallbackTimestamp: string): StoredSection {
  const timestamp = String(value.metadataLastModifiedAt ?? fallbackTimestamp);
  const lists = Array.isArray(value.lists) ? value.lists : [];

  return {
    id: String(value.id ?? generateId()),
    title: String(value.title ?? 'My Tasks'),
    position: Number(value.position ?? index),
    metadataLastModifiedAt: timestamp,
    ...(value.deleted === true ? { deleted: true } : {}),
    ...(value.created === true || value.isNew === true ? { created: true } : {}),
    lists: lists.map((list, listIndex) => normalizeList(list, listIndex, timestamp)),
  };
}

function normalizePartition(value: unknown): Partition {
  const timestamp = nowIso();
  if (!isRecord(value) || !Array.isArray(value['sections'])) return { sections: [] };

  return {
    sections: value['sections']
      .map((section, index) => normalizeSection(section as LegacySection, index, timestamp))
      .sort((a, b) => a.position - b.position),
  };
}

function createDefaultPartition(): Partition {
  const timestamp = nowIso();

  return {
    sections: [
      {
        id: generateId(),
        title: 'My Tasks',
        position: 0,
        metadataLastModifiedAt: timestamp,
        lists: [
          { id: generateId(), title: 'Now', metadataLastModifiedAt: timestamp, isBacklog: false, items: [] },
          { id: generateId(), title: 'Later', metadataLastModifiedAt: timestamp, isBacklog: true, items: [] },
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
    position: item.position ?? position,
    lastModifiedAt: item.lastModifiedAt,
    created: true,
  };
}

function cloneListForUser(list: StoredList): StoredList {
  return {
    id: generateId(),
    title: list.title,
    metadataLastModifiedAt: list.metadataLastModifiedAt,
    isBacklog: list.isBacklog,
    items: list.items
      .filter(item => !item.deleted)
      .map((item, index) => cloneItemForUser(item, index)),
  };
}

function cloneSectionForUser(section: StoredSection): StoredSection {
  return {
    id: generateId(),
    title: section.title,
    position: section.position,
    metadataLastModifiedAt: section.metadataLastModifiedAt,
    created: true,
    lists: section.lists.map(list => cloneListForUser(list)),
  };
}

@Injectable({ providedIn: 'root' })
export class StorageService {
  private activeKey = ANONYMOUS_KEY;
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

  setActivePartition(userId?: string): void {
    this.activeKey = this.buildKey(userId);
    if (userId) this.migrateLegacyUserPartition(userId);
  }

  isPartitionEmpty(userId?: string): boolean {
    const partition = this.readPartition(this.buildKey(userId));
    return !partition || partition.sections.filter(section => !section.deleted).length === 0;
  }

  getActiveUserId(): string | undefined {
    const suffix = this.activeKey.slice(LS_PREFIX.length);
    return suffix.startsWith('nominal_') ? suffix.slice('nominal_'.length) : undefined;
  }

  load(): Partition {
    const partition = this.readPartition(this.activeKey);
    if (partition) return partition;

    if (!this.getActiveUserId()) {
      const created = createDefaultPartition();
      this.save(created);
      return created;
    }

    return { sections: [] };
  }

  save(partition: Partition): void {
    try {
      localStorage.setItem(this.activeKey, JSON.stringify(normalizePartition(partition)));
    } catch {
      // Ignore quota errors.
    }
  }

  loadSections(): StoredSection[] {
    return this.load().sections.filter(section => !section.deleted).sort((a, b) => a.position - b.position);
  }

  loadAllSectionsForSync(): StoredSection[] {
    return this.load().sections;
  }

  saveSections(sections: StoredSection[]): void {
    this.save({ sections });
  }

  getSection(sectionId: string): StoredSection | undefined {
    return this.load().sections.find(section => section.id === sectionId);
  }

  upsertSection(section: StoredSection): void {
    const partition = this.load();
    const index = partition.sections.findIndex(existing => existing.id === section.id);
    if (index >= 0) {
      partition.sections[index] = { ...section, lists: partition.sections[index].lists };
    } else {
      partition.sections.push(section);
    }
    this.save(partition);
  }

  removeSection(sectionId: string): void {
    const partition = this.load();
    const section = partition.sections.find(existing => existing.id === sectionId);
    if (section) {
      section.deleted = true;
      section.metadataLastModifiedAt = nowIso();
    }
    this.save(partition);
  }

  applySyncedSections(synced: StoredSection[]): void {
    const partition = this.load();
    const existingMap = new Map(partition.sections.map(section => [section.id, section]));

    this.save({
      sections: synced.map(section => {
        const existing = existingMap.get(section.id);
        return {
          id: section.id,
          title: section.title,
          position: section.position,
          metadataLastModifiedAt: section.metadataLastModifiedAt,
          lists: existing?.lists ?? section.lists ?? [],
        };
      }),
    });
  }

  getListsForSection(sectionId: string): StoredList[] {
    return this.getSection(sectionId)?.lists ?? [];
  }

  upsertList(sectionId: string, list: StoredList): void {
    const partition = this.load();
    const section = partition.sections.find(existing => existing.id === sectionId);
    if (!section) return;

    const index = section.lists.findIndex(existing => existing.id === list.id);
    if (index >= 0) {
      section.lists[index] = { ...list, items: section.lists[index].items };
    } else {
      section.lists.push(list);
    }
    this.save(partition);
  }

  setListsForSection(sectionId: string, lists: StoredList[]): void {
    const partition = this.load();
    const section = partition.sections.find(existing => existing.id === sectionId);
    if (!section) return;

    const existingMap = new Map(section.lists.map(list => [list.id, list]));
    section.lists = lists.map(list => ({
      id: list.id,
      title: list.title,
      metadataLastModifiedAt: list.metadataLastModifiedAt,
      isBacklog: list.isBacklog,
      items: existingMap.get(list.id)?.items ?? list.items ?? [],
    }));
    this.save(partition);
  }

  getItemsForList(sectionId: string, listId: string): StoredItem[] {
    return this.getListsForSection(sectionId).find(list => list.id === listId)?.items ?? [];
  }

  setItemsForList(sectionId: string, listId: string, items: StoredItem[], options?: { touchRevision?: boolean }): void {
    const partition = this.load();
    const section = partition.sections.find(existing => existing.id === sectionId);
    const list = section?.lists.find(existing => existing.id === listId);
    if (!list) return;

    list.items = items.sort((a, b) => a.position - b.position);
    this.save(partition);
    if (options?.touchRevision !== false) {
      this.bumpItemsRevision(sectionId, listId);
    }
  }

  applySyncedItems(sectionId: string, listId: string, items: StoredItem[], expectedRevision?: number): boolean {
    if (expectedRevision !== undefined && this.getItemsRevision(sectionId, listId) !== expectedRevision) {
      return false;
    }

    this.setItemsForList(sectionId, listId, items.map(item => ({
      id: item.id,
      content: item.content,
      position: item.position,
      lastModifiedAt: item.lastModifiedAt,
    })), { touchRevision: false });
    return true;
  }

  applyItemPositions(sectionId: string, listId: string, positions: { id: string; position: number }[]): void {
    const positionMap = new Map(positions.map(item => [item.id, item.position]));
    const items = this.getItemsForList(sectionId, listId).map(item => ({
      ...item,
      position: positionMap.get(item.id) ?? item.position,
    }));
    this.setItemsForList(sectionId, listId, items, { touchRevision: false });
  }

  copyAnonymousToUser(userId: string): void {
    const source = this.readPartition(ANONYMOUS_KEY) ?? { sections: [] };
    const partition: Partition = {
      sections: source.sections
        .filter(section => !section.deleted)
        .map(section => cloneSectionForUser(section)),
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
