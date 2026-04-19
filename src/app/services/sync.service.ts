import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';
import { StorageService, StoredSection, StoredList } from './storage.service';

@Injectable({ providedIn: 'root' })
export class SyncService {
  private readonly http = inject(HttpClient);
  private readonly storage = inject(StorageService);
  private readonly apiUrl = environment.apiUrl;

  // ─── Section sync ──────────────────────────────────────

  async syncSections(): Promise<StoredSection[]> {
    const local = this.storage.loadAllSectionsForSync();
    const payload = local.map(s => ({
      id: s.id,
      title: s.title,
      metadataLastModifiedAt: s.metadataLastModifiedAt,
      ...(s.deleted ? { deleted: true } : {}),
      ...(s.isNew ? { isNew: true } : {}),
    }));

    const synced = await firstValueFrom(
      this.http.post<StoredSection[]>(`${this.apiUrl}/sections/sync`, payload),
    );

    this.storage.applySyncedSections(synced);
    return this.storage.loadSections();
  }

  // ─── List sync ─────────────────────────────────────────

  async syncSectionLists(sectionId: string): Promise<StoredList[]> {
    const local = this.storage.getListsForSection(sectionId);
    const payload = local.map(l => ({
      id: l.id,
      title: l.title,
      lastModifiedAt: l.lastModifiedAt,
      content: l.content,
      isBacklog: l.isBacklog,
    }));

    const synced = await firstValueFrom(
      this.http.post<StoredList[]>(`${this.apiUrl}/sections/${sectionId}/sync`, payload),
    );

    this.storage.setListsForSection(sectionId, synced);
    return synced;
  }

  // ─── Reorder ───────────────────────────────────────────

  async reorderSections(id: string, oldPosition: number, newPosition: number): Promise<{ id: string; position: number }[]> {
    return firstValueFrom(
      this.http.patch<{ id: string; position: number }[]>(`${this.apiUrl}/sections/reorder`, { id, oldPosition, newPosition }),
    );
  }


}
