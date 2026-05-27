import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';
import {
  StorageService,
  StoredSection,
  StoredList,
  StoredItem,
  SectionsSyncResponse,
  ItemsSyncResponse,
  OrderSyncResponse,
} from './storage.service';

@Injectable({ providedIn: 'root' })
export class SyncService {
  private readonly http = inject(HttpClient);
  private readonly storage = inject(StorageService);
  private readonly apiUrl = environment.apiUrl;
  private sectionsSyncGeneration = 0;
  private readonly listsSyncGeneration = new Map<string, number>();
  private readonly itemsSyncGeneration = new Map<string, number>();

  private nextGeneration(map: Map<string, number>, key: string): number {
    const next = (map.get(key) ?? 0) + 1;
    map.set(key, next);
    return next;
  }

  reserveListItemsSync(sectionId: string, listId: string): void {
    this.nextGeneration(this.itemsSyncGeneration, `${sectionId}:${listId}`);
  }

  async syncSections(): Promise<StoredSection[]> {
    const generation = ++this.sectionsSyncGeneration;
    const localOrderRevision = this.storage.getSectionOrderLocalRevision();
    const sections = this.storage.loadAllSectionsForSync().map(section => ({
      id: section.id,
      title: section.title,
      metadataLastModifiedAt: section.metadataLastModifiedAt,
      serverRevision: section.serverRevision,
      ...(section.deleted ? { deleted: true } : {}),
      ...(section.created ? { created: true } : {}),
      ...(section.dirty ? { dirty: true } : {}),
      ...(!section.deleted && (section.created || section.serverRevision === 0) ? {
        lists: section.lists.map(list => ({
          id: list.id,
          title: list.title,
          isBacklog: list.isBacklog,
          metadataLastModifiedAt: list.metadataLastModifiedAt,
          serverRevision: list.serverRevision,
          ...(list.dirty ? { dirty: true } : {}),
        })),
      } : {}),
    }));
    const order = this.storage.getSectionOrderSync();
    const payload = {
      sections,
      ...(order ? { order } : {}),
    };

    const synced = await firstValueFrom(
      this.http.post<SectionsSyncResponse>(`${this.apiUrl}/sections/sync`, payload),
    );

    if (
      generation === this.sectionsSyncGeneration &&
      localOrderRevision === this.storage.getSectionOrderLocalRevision()
    ) {
      const rebasedLocalSections = this.storage.applySyncedSections(synced);
      if (rebasedLocalSections) {
        return this.syncSections();
      }
    }
    return this.storage.loadSections();
  }

  async syncSectionLists(sectionId: string): Promise<StoredList[]> {
    const generation = this.nextGeneration(this.listsSyncGeneration, sectionId);
    const payload = this.storage.getListsForSection(sectionId).map(list => ({
      id: list.id,
      title: list.title,
      isBacklog: list.isBacklog,
      metadataLastModifiedAt: list.metadataLastModifiedAt,
      serverRevision: list.serverRevision,
      ...(list.dirty ? { dirty: true } : {}),
    }));

    const synced = await firstValueFrom(
      this.http.post<StoredList[]>(`${this.apiUrl}/sections/${sectionId}/sync`, payload),
    );

    if (generation === this.listsSyncGeneration.get(sectionId)) {
      this.storage.setListsForSection(sectionId, synced);
    }
    return this.storage.getListsForSection(sectionId);
  }

  async syncListItems(sectionId: string, listId: string): Promise<StoredItem[]> {
    const key = `${sectionId}:${listId}`;
    const generation = this.nextGeneration(this.itemsSyncGeneration, key);
    const revision = this.storage.getItemsRevision(sectionId, listId);
    const items = this.storage.getItemsForList(sectionId, listId)
      .filter(item => !(item.created && item.deleted))
      .map(item => {
        return {
          id: item.id,
          content: this.taskContentForSync(item),
          lastModifiedAt: item.lastModifiedAt,
          serverRevision: item.serverRevision,
          ...(item.deleted ? { deleted: true } : {}),
          ...(item.created && !item.deleted ? { created: true } : {}),
          ...(item.dirty ? { dirty: true } : {}),
        };
      });
    const order = this.storage.getListOrderSync(sectionId, listId);
    const payload = {
      items,
      ...(order ? { order } : {}),
    };

    const synced = await firstValueFrom(
      this.http.post<ItemsSyncResponse>(`${this.apiUrl}/sections/${sectionId}/lists/${listId}/sync`, payload),
    );

    if (generation === this.itemsSyncGeneration.get(key)) {
      this.storage.applySyncedItems(sectionId, listId, synced, revision);
    }
    return this.storage.getItemsForList(sectionId, listId);
  }

  private taskContentForSync(item: StoredItem): { id: string; text: string; done: boolean; doneAt?: string; subtasks: { id: string; text: string; done: boolean }[] } {
    const record = this.asRecord(item.content);
    const subtasks = Array.isArray(record['subtasks'])
      ? record['subtasks'].map(subtask => {
          const subtaskRecord = this.asRecord(subtask);
          return {
            id: String(subtaskRecord['id'] ?? crypto.randomUUID()),
            text: String(subtaskRecord['text'] ?? ''),
            done: Boolean(subtaskRecord['done']),
          };
        })
      : [];

    return {
      id: String(record['id'] ?? item.id),
      text: String(record['text'] ?? ''),
      done: Boolean(record['done']),
      ...(typeof record['doneAt'] === 'string' && record['doneAt'].length > 0 ? { doneAt: record['doneAt'] } : {}),
      subtasks,
    };
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  async reorderSections(sections: { id: string; position: number }[]): Promise<OrderSyncResponse> {
    return firstValueFrom(
      this.http.patch<OrderSyncResponse>(`${this.apiUrl}/sections/reorder`, {
        baseOrderRevision: this.storage.getSectionBaseOrderRevision(),
        items: sections,
      }),
    );
  }

  async reorderItems(sectionId: string, listId: string, items: { id: string; position: number }[]): Promise<OrderSyncResponse> {
    return firstValueFrom(
      this.http.patch<OrderSyncResponse>(`${this.apiUrl}/sections/${sectionId}/lists/${listId}/reorder`, {
        baseOrderRevision: this.storage.getListBaseOrderRevision(sectionId, listId),
        items,
      }),
    );
  }
}
