import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';
import { StorageService, StoredSection, StoredList, StoredItem } from './storage.service';

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
    const payload = this.storage.loadAllSectionsForSync().map(section => ({
      id: section.id,
      title: section.title,
      metadataLastModifiedAt: section.metadataLastModifiedAt,
      ...(section.deleted ? { deleted: true } : {}),
      ...(section.created ? { created: true } : {}),
    }));

    const synced = await firstValueFrom(
      this.http.post<StoredSection[]>(`${this.apiUrl}/sections/sync`, payload),
    );

    if (generation === this.sectionsSyncGeneration) {
      this.storage.applySyncedSections(synced);
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
    const payload = this.storage.getItemsForList(sectionId, listId).map(item => ({
      id: item.id,
      content: item.content,
      lastModifiedAt: item.lastModifiedAt,
      ...(item.deleted ? { deleted: true } : {}),
      ...(item.created ? { created: true } : {}),
    }));

    const synced = await firstValueFrom(
      this.http.post<StoredItem[]>(`${this.apiUrl}/sections/${sectionId}/lists/${listId}/sync`, payload),
    );

    if (generation === this.itemsSyncGeneration.get(key)) {
      this.storage.applySyncedItems(sectionId, listId, synced, revision);
    }
    return this.storage.getItemsForList(sectionId, listId);
  }

  async reorderSections(sections: { id: string; position: number }[]): Promise<{ id: string; position: number }[]> {
    return firstValueFrom(
      this.http.patch<{ id: string; position: number }[]>(`${this.apiUrl}/sections/reorder`, sections),
    );
  }

  async reorderItems(sectionId: string, listId: string, items: { id: string; position: number }[]): Promise<{ id: string; position: number }[]> {
    return firstValueFrom(
      this.http.patch<{ id: string; position: number }[]>(`${this.apiUrl}/sections/${sectionId}/lists/${listId}/reorder`, items),
    );
  }
}
