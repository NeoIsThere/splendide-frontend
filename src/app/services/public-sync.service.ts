import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';
import {
  ItemsSyncResponse,
  OrderSyncResponse,
  StorageService,
  StoredItem,
  StoredList,
  StoredSection,
} from './storage.service';

@Injectable({ providedIn: 'root' })
export class PublicSyncService {
  private readonly http = inject(HttpClient);
  private readonly storage = inject(StorageService);
  private readonly apiUrl = environment.apiUrl;
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

  async createPublicPage(): Promise<StoredSection> {
    const section = await firstValueFrom(
      this.http.post<StoredSection>(`${this.apiUrl}/public-pages`, {}),
    );
    this.storage.setActivePublicPartition(section.id);
    return this.applyPublicSection(section);
  }

  async loadPublicPage(publicId: string): Promise<StoredSection> {
    this.storage.setActivePublicPartition(publicId);
    const section = await firstValueFrom(
      this.http.get<StoredSection>(`${this.apiUrl}/public-pages/${publicId}`),
    );
    return this.applyPublicSection(section);
  }

  async syncPublicLists(publicId: string): Promise<StoredList[]> {
    const generation = this.nextGeneration(this.listsSyncGeneration, publicId);
    const payload = this.storage.getListsForSection(publicId).map(list => ({
      id: list.id,
      title: list.title,
      isBacklog: list.isBacklog,
      metadataLastModifiedAt: list.metadataLastModifiedAt,
      serverRevision: list.serverRevision,
      ...(list.dirty ? { dirty: true } : {}),
    }));

    const synced = await firstValueFrom(
      this.http.post<StoredList[]>(`${this.apiUrl}/public-pages/${publicId}/sync`, payload),
    );

    if (generation === this.listsSyncGeneration.get(publicId)) {
      this.storage.setListsForSection(publicId, synced);
    }
    return this.storage.getListsForSection(publicId);
  }

  async syncPublicListItems(publicId: string, listId: string): Promise<StoredItem[]> {
    const key = `${publicId}:${listId}`;
    const generation = this.nextGeneration(this.itemsSyncGeneration, key);
    const revision = this.storage.getItemsRevision(publicId, listId);
    const items = this.storage.getItemsForList(publicId, listId)
      .filter(item => !(item.created && item.deleted))
      .map(item => ({
        id: item.id,
        content: this.taskContentForSync(item),
        lastModifiedAt: item.lastModifiedAt,
        serverRevision: item.serverRevision,
        ...(item.deleted ? { deleted: true } : {}),
        ...(this.shouldSyncAsCreated(item) ? { created: true } : {}),
        ...(item.dirty ? { dirty: true } : {}),
      }));
    const order = this.storage.getListOrderSync(publicId, listId);
    const payload = {
      items,
      ...(order ? { order } : {}),
    };

    const synced = await firstValueFrom(
      this.http.post<ItemsSyncResponse>(`${this.apiUrl}/public-pages/${publicId}/lists/${listId}/sync`, payload),
    );

    if (generation === this.itemsSyncGeneration.get(key)) {
      this.storage.applySyncedItems(publicId, listId, synced, revision);
    }
    return this.storage.getItemsForList(publicId, listId);
  }

  async reorderPublicItems(publicId: string, listId: string, items: { id: string; position: number }[]): Promise<OrderSyncResponse> {
    return firstValueFrom(
      this.http.patch<OrderSyncResponse>(`${this.apiUrl}/public-pages/${publicId}/lists/${listId}/reorder`, {
        baseOrderRevision: this.storage.getListBaseOrderRevision(publicId, listId),
        items,
      }),
    );
  }

  private applyPublicSection(section: StoredSection): StoredSection {
    this.storage.save({
      syncGeneration: 0,
      sectionOrderRevision: 0,
      sectionBaseOrderRevision: 0,
      sections: [{
        ...section,
        position: 0,
        title: section.title || 'public',
      }],
    });
    return this.storage.loadSections()[0] ?? section;
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

  private shouldSyncAsCreated(item: StoredItem): boolean {
    return !item.deleted && (item.created === true || (item.serverRevision === 0 && item.dirty === true));
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }
}
