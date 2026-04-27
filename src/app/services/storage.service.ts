import { Injectable } from '@angular/core';

// ─── Data types ──────────────────────────────────────────

export interface StoredList {
  id: string;
  title: string;
  lastModifiedAt: string;
  content: any[];
  isBacklog: boolean;
}

export interface StoredSection {
  id: string;
  title: string;
  position: number;
  metadataLastModifiedAt: string;
  deleted?: boolean;
  isNew?: boolean;
  lists: StoredList[];
}

export interface Partition {
  sections: StoredSection[];
}

// ─── Defaults ────────────────────────────────────────────

function generateId(): string {
  return crypto.randomUUID();
}

function createDefaultPartition(): Partition {
  const mainListId = generateId();
  const backlogListId = generateId();
  const sectionId = generateId();
  const now = new Date().toISOString();

  return {
    sections: [
      {
        id: sectionId,
        title: 'My Tasks',
        position: 0,
        metadataLastModifiedAt: now,
        lists: [
          { id: mainListId, title: '', lastModifiedAt: now, content: [], isBacklog: false },
          { id: backlogListId, title: 'Later', lastModifiedAt: now, content: [], isBacklog: true },
        ],
      },
    ],
  };
}

// ─── Service ─────────────────────────────────────────────

const LS_PREFIX = 'splendide_v2_';

@Injectable({ providedIn: 'root' })
export class StorageService {
  private activeKey = this.buildKey();

  private buildKey(userId?: string): string {
    return userId ? `${LS_PREFIX}${userId}` : `${LS_PREFIX}anonymous`;
  }

  /** Switch the active partition. */
  setActivePartition(userId?: string): void {
    this.activeKey = this.buildKey(userId);
  }

  isPartitionEmpty(userId?: string): boolean {
    const key = this.buildKey(userId);
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return true;
      const partition = JSON.parse(raw) as Partition;
      return partition.sections.filter(s => !s.deleted).length === 0;
    } catch {
      return true;
    }
  }

  getActiveUserId(): string | undefined {
    const suffix = this.activeKey.slice(LS_PREFIX.length);
    return suffix === 'anonymous' ? undefined : suffix;
  }

  // ─── Read / Write ──────────────────────────────────────

  load(): Partition {
    try {
      const raw = localStorage.getItem(this.activeKey);
      if (raw) return JSON.parse(raw) as Partition;
    } catch { /* corrupted */ }
    // Return default for anonymous, empty for user partitions
    if (!this.getActiveUserId()) {
      const def = createDefaultPartition();
      this.save(def);
      return def;
    }
    return { sections: [] };
  }

  save(partition: Partition): void {
    try {
      localStorage.setItem(this.activeKey, JSON.stringify(partition));
    } catch { /* quota exceeded */ }
  }

  // ─── Section helpers ───────────────────────────────────

  loadSections(): StoredSection[] {
    return this.load().sections.filter(s => !s.deleted).sort((a, b) => a.position - b.position);
  }

  /** Load all sections including deleted ones (for sync payload). */
  loadAllSectionsForSync(): StoredSection[] {
    return this.load().sections;
  }

  saveSections(sections: StoredSection[]): void {
    this.save({ sections });
  }

  getSection(sectionId: string): StoredSection | undefined {
    return this.load().sections.find(s => s.id === sectionId);
  }

  upsertSection(section: StoredSection): void {
    const p = this.load();
    const idx = p.sections.findIndex(s => s.id === section.id);
    if (idx >= 0) {
      // Preserve existing lists
      p.sections[idx] = { ...section, lists: p.sections[idx].lists };
    } else {
      p.sections.push(section);
    }
    this.save(p);
  }

  removeSection(sectionId: string): void {
    const p = this.load();
    const sec = p.sections.find(s => s.id === sectionId);
    if (sec) {
      sec.deleted = true;
      sec.metadataLastModifiedAt = new Date().toISOString();
      delete sec.isNew;
    }
    this.save(p);
  }

  /** Apply synced sections from backend — overwrite metadata but preserve lists for existing sections */
  applySyncedSections(synced: StoredSection[]): void {
    const p = this.load();
    const existingMap = new Map(p.sections.map(s => [s.id, s]));

    const result: StoredSection[] = synced.map(s => {
      const existing = existingMap.get(s.id);
      return {
        ...s,
        lists: existing?.lists ?? s.lists ?? [],
      };
    });

    this.save({ sections: result });
  }

  // ─── List helpers ──────────────────────────────────────

  getListsForSection(sectionId: string): StoredList[] {
    return this.getSection(sectionId)?.lists ?? [];
  }

  upsertList(sectionId: string, list: StoredList): void {
    const p = this.load();
    const sec = p.sections.find(s => s.id === sectionId);
    if (!sec) return;
    const idx = sec.lists.findIndex(l => l.id === list.id);
    if (idx >= 0) {
      sec.lists[idx] = list;
    } else {
      sec.lists.push(list);
    }
    this.save(p);
  }

  setListsForSection(sectionId: string, lists: StoredList[]): void {
    const p = this.load();
    const sec = p.sections.find(s => s.id === sectionId);
    if (!sec) return;
    sec.lists = lists;
    this.save(p);
  }

  // ─── Partition copy ────────────────────────────────────

  /** Copy anonymous partition to user partition when the user partition has no data yet. */
  copyAnonymousToUser(userId: string): void {
    const anonKey = this.buildKey();
    const userKey = this.buildKey(userId);
    try {
      const raw = localStorage.getItem(anonKey);
      if (raw) {
        const source = JSON.parse(raw) as Partition;
        const partition: Partition = {
          sections: source.sections
            .filter(s => !s.deleted)
            .map(s => ({
              ...s,
              deleted: undefined,
              isNew: true,
              lists: s.lists.map(l => ({ ...l })),
            })),
        };
        for (const sec of partition.sections) {
          delete sec.deleted;
        }
        localStorage.setItem(userKey, JSON.stringify(partition));
      }
    } catch { /* ignore */ }
  }

  /** Copy user partition to anonymous (on unsubscribe). */
  copyUserToAnonymous(userId: string): void {
    const userKey = this.buildKey(userId);
    const anonKey = this.buildKey();
    try {
      const raw = localStorage.getItem(userKey);
      if (raw) {
        const partition: Partition = JSON.parse(raw);
        // Strip sync flags
        for (const sec of partition.sections) {
          delete sec.deleted;
          delete sec.isNew;
        }
        // Remove deleted sections
        partition.sections = partition.sections.filter(s => !s.deleted);
        localStorage.setItem(anonKey, JSON.stringify(partition));
      }
    } catch { /* ignore */ }
  }
}
