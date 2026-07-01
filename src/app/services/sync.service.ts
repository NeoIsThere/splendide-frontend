import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpResponse } from '@angular/common/http';
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

const SYNC_GENERATION_HEADER = 'X-Splendide-Sync-Generation';
const SYNC_MODE_HEADER = 'X-Splendide-Sync-Mode';

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

  private syncHeaders(): Record<string, string> {
    return { [SYNC_GENERATION_HEADER]: String(this.storage.getSyncGeneration()) };
  }

  private acceptSyncGenerationFromResponse(response: HttpResponse<unknown>, body: unknown = response.body): void {
    const headerValue = response.headers.get(SYNC_GENERATION_HEADER);
    const bodyValue = this.asRecord(body)['syncGeneration'];
    const parsed = Number(headerValue ?? bodyValue);
    if (Number.isInteger(parsed) && parsed >= 0) {
      this.storage.acceptServerSyncGeneration(parsed);
    }
  }

  private shouldReplaceLocalSnapshot(response: HttpResponse<unknown>): boolean {
    const mode = response.headers.get(SYNC_MODE_HEADER);
    return mode === 'server_wins' || mode === 'client_wins';
  }

  private isSectionsSnapshot(value: unknown): value is SectionsSyncResponse {
    const record = this.asRecord(value);
    return Array.isArray(record['sections']) && typeof record['sectionOrderRevision'] === 'number';
  }

  private applySnapshotIfPresent(response: HttpResponse<unknown>, requestLocalRevision?: number): boolean {
    const body = response.body;
    this.acceptSyncGenerationFromResponse(response, body);
    if (!this.isSectionsSnapshot(body)) return false;

    if (
      requestLocalRevision === undefined ||
      requestLocalRevision === this.storage.getLocalMutationRevision()
    ) {
      this.storage.applySyncedSections(body, { replaceLocal: this.shouldReplaceLocalSnapshot(response) });
    }
    return true;
  }

  private localSectionOrderResponse(): OrderSyncResponse {
    const sections = this.storage.loadSections();
    return {
      orderRevision: this.storage.getSectionBaseOrderRevision(),
      positions: sections.map(section => ({ id: section.id, position: section.position })),
    };
  }

  private localItemOrderResponse(sectionId: string, listId: string): OrderSyncResponse {
    const list = this.storage.getListsForSection(sectionId).find(existing => existing.id === listId);
    return {
      orderRevision: this.storage.getListBaseOrderRevision(sectionId, listId),
      positions: (list?.items ?? [])
        .filter(item => !item.deleted)
        .map(item => ({ id: item.id, position: item.position })),
    };
  }

  private buildCloudReplaceSections() {
    return this.storage.loadAllSectionsForSync()
      .filter(section => !section.sharedAccess)
      .filter(section => !section.deleted)
      .sort((left, right) => left.position - right.position)
      .map((section, sectionIndex) => ({
        id: section.id,
        title: section.title,
        position: sectionIndex,
        metadataLastModifiedAt: section.metadataLastModifiedAt,
        serverRevision: section.serverRevision,
        ...(section.created ? { created: true } : {}),
        ...(section.dirty ? { dirty: true } : {}),
        lists: [...section.lists]
          .sort((left, right) => Number(left.isBacklog) - Number(right.isBacklog))
          .map(list => ({
            id: list.id,
            title: list.title,
            isBacklog: list.isBacklog,
            metadataLastModifiedAt: list.metadataLastModifiedAt,
            serverRevision: list.serverRevision,
            ...(list.dirty ? { dirty: true } : {}),
            items: [...list.items]
              .filter(item => !item.deleted)
              .sort((left, right) => left.position - right.position)
              .map((item, itemIndex) => ({
                id: item.id,
                content: this.taskContentForSync(item),
                position: itemIndex,
                lastModifiedAt: item.lastModifiedAt,
                serverRevision: item.serverRevision,
                ...(this.shouldSyncAsCreated(item) ? { created: true } : {}),
                ...(item.dirty ? { dirty: true } : {}),
              })),
          })),
      }));
  }

  private shareTokenForAnonymousSection(sectionId: string): string | null {
    if (this.storage.getActiveUserId()) return null;
    const token = this.storage.getSection(sectionId)?.shareToken;
    return token && token.length > 0 ? token : null;
  }

  async loadSharedSection(shareToken: string): Promise<StoredSection> {
    const section = await firstValueFrom(
      this.http.get<StoredSection>(`${this.apiUrl}/sections/share/${encodeURIComponent(shareToken)}`),
    );
    this.storage.upsertSectionSnapshot(section);
    return this.storage.getSection(section.id) ?? section;
  }

  async enableSectionSharing(sectionId: string): Promise<StoredSection> {
    const section = await firstValueFrom(
      this.http.post<StoredSection>(`${this.apiUrl}/sections/${encodeURIComponent(sectionId)}/share`, {}),
    );
    this.storage.upsertSectionSnapshot(section);
    return this.storage.getSection(section.id) ?? section;
  }

  async disableSectionSharing(sectionId: string): Promise<StoredSection> {
    const section = await firstValueFrom(
      this.http.delete<StoredSection>(`${this.apiUrl}/sections/${encodeURIComponent(sectionId)}/share`),
    );
    this.storage.upsertSectionSnapshot(section);
    return this.storage.getSection(section.id) ?? section;
  }

  async syncSections(): Promise<StoredSection[]> {
    const generation = ++this.sectionsSyncGeneration;
    const localOrderRevision = this.storage.getSectionOrderLocalRevision();
    const localMutationRevision = this.storage.getLocalMutationRevision();
    const payload = this.storage.isCloudReplacePending()
      ? {
          replaceCloud: true as const,
          sections: this.buildCloudReplaceSections(),
        }
      : (() => {
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
          return {
            sections,
            ...(order ? { order } : {}),
          };
        })();

    const response = await firstValueFrom(
      this.http.post<SectionsSyncResponse>(
        `${this.apiUrl}/sections/sync`,
        payload,
        { observe: 'response', headers: this.syncHeaders() },
      ),
    );
    const synced = response.body;
    this.acceptSyncGenerationFromResponse(response, synced);
    if (!synced) return this.storage.loadSections();

    const replaceLocal = this.shouldReplaceLocalSnapshot(response);
    if (
      localMutationRevision === this.storage.getLocalMutationRevision() &&
      (
        replaceLocal ||
        (
          generation === this.sectionsSyncGeneration &&
          localOrderRevision === this.storage.getSectionOrderLocalRevision()
        )
      )
    ) {
      const rebasedLocalSections = this.storage.applySyncedSections(synced, {
        replaceLocal,
      });
      if (rebasedLocalSections) {
        return this.syncSections();
      }
    }
    return this.storage.loadSections();
  }

  async syncSectionLists(sectionId: string): Promise<StoredList[]> {
    const generation = this.nextGeneration(this.listsSyncGeneration, sectionId);
    const localMutationRevision = this.storage.getLocalMutationRevision();
    const payload = this.storage.getListsForSection(sectionId).map(list => ({
      id: list.id,
      title: list.title,
      isBacklog: list.isBacklog,
      metadataLastModifiedAt: list.metadataLastModifiedAt,
      serverRevision: list.serverRevision,
      ...(list.dirty ? { dirty: true } : {}),
    }));

    const shareToken = this.shareTokenForAnonymousSection(sectionId);
    const response = await firstValueFrom(
      this.http.post<StoredList[] | SectionsSyncResponse>(
        shareToken
          ? `${this.apiUrl}/sections/share/${encodeURIComponent(shareToken)}/sync`
          : `${this.apiUrl}/sections/${sectionId}/sync`,
        payload,
        shareToken
          ? { observe: 'response' }
          : { observe: 'response', headers: this.syncHeaders() },
      ),
    );
    if (this.applySnapshotIfPresent(response, localMutationRevision)) {
      return this.storage.getListsForSection(sectionId);
    }
    const synced = response.body;

    if (Array.isArray(synced) && generation === this.listsSyncGeneration.get(sectionId)) {
      this.storage.setListsForSection(sectionId, synced);
    }
    return this.storage.getListsForSection(sectionId);
  }

  async syncListItems(sectionId: string, listId: string): Promise<StoredItem[]> {
    const key = `${sectionId}:${listId}`;
    const generation = this.nextGeneration(this.itemsSyncGeneration, key);
    const revision = this.storage.getItemsRevision(sectionId, listId);
    const localMutationRevision = this.storage.getLocalMutationRevision();
    const items = this.storage.getItemsForList(sectionId, listId)
      .filter(item => !(item.created && item.deleted))
      .map(item => {
        return {
          id: item.id,
          content: this.taskContentForSync(item),
          lastModifiedAt: item.lastModifiedAt,
          serverRevision: item.serverRevision,
          ...(item.deleted ? { deleted: true } : {}),
          ...(this.shouldSyncAsCreated(item) ? { created: true } : {}),
          ...(item.dirty ? { dirty: true } : {}),
        };
      });
    const order = this.storage.getListOrderSync(sectionId, listId);
    const payload = {
      items,
      ...(order ? { order } : {}),
    };

    const shareToken = this.shareTokenForAnonymousSection(sectionId);
    const response = await firstValueFrom(
      this.http.post<ItemsSyncResponse | SectionsSyncResponse>(
        shareToken
          ? `${this.apiUrl}/sections/share/${encodeURIComponent(shareToken)}/lists/${listId}/sync`
          : `${this.apiUrl}/sections/${sectionId}/lists/${listId}/sync`,
        payload,
        shareToken
          ? { observe: 'response' }
          : { observe: 'response', headers: this.syncHeaders() },
      ),
    );
    if (this.applySnapshotIfPresent(response, localMutationRevision)) {
      return this.storage.getItemsForList(sectionId, listId);
    }
    const synced = response.body;

    if (synced && !this.isSectionsSnapshot(synced) && generation === this.itemsSyncGeneration.get(key)) {
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

  private shouldSyncAsCreated(item: StoredItem): boolean {
    return !item.deleted && (item.created === true || (item.serverRevision === 0 && item.dirty === true));
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  async reorderSections(sections: { id: string; position: number }[]): Promise<OrderSyncResponse> {
    const localMutationRevision = this.storage.getLocalMutationRevision();
    const response = await firstValueFrom(
      this.http.patch<OrderSyncResponse | SectionsSyncResponse>(
        `${this.apiUrl}/sections/reorder`,
        {
          baseOrderRevision: this.storage.getSectionBaseOrderRevision(),
          items: sections,
        },
        { observe: 'response', headers: this.syncHeaders() },
      ),
    );
    if (this.applySnapshotIfPresent(response, localMutationRevision)) return this.localSectionOrderResponse();
    this.acceptSyncGenerationFromResponse(response);
    const body = response.body;
    return body && !this.isSectionsSnapshot(body) ? body : this.localSectionOrderResponse();
  }

  async reorderItems(sectionId: string, listId: string, items: { id: string; position: number }[]): Promise<OrderSyncResponse> {
    const shareToken = this.shareTokenForAnonymousSection(sectionId);
    const localMutationRevision = this.storage.getLocalMutationRevision();
    const response = await firstValueFrom(
      this.http.patch<OrderSyncResponse | SectionsSyncResponse>(
        shareToken
          ? `${this.apiUrl}/sections/share/${encodeURIComponent(shareToken)}/lists/${listId}/reorder`
          : `${this.apiUrl}/sections/${sectionId}/lists/${listId}/reorder`,
        {
          baseOrderRevision: this.storage.getListBaseOrderRevision(sectionId, listId),
          items,
        },
        shareToken
          ? { observe: 'response' }
          : { observe: 'response', headers: this.syncHeaders() },
      ),
    );
    if (this.applySnapshotIfPresent(response, localMutationRevision)) return this.localItemOrderResponse(sectionId, listId);
    this.acceptSyncGenerationFromResponse(response);
    const body = response.body;
    return body && !this.isSectionsSnapshot(body) ? body : this.localItemOrderResponse(sectionId, listId);
  }
}
