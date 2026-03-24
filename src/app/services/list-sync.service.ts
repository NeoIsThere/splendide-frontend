import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';

export interface ListData {
  tasks: any[];
  secondaryTasks: any[];
  secondaryTitle: string;
  secondaryVisible: boolean;
}

@Injectable({ providedIn: 'root' })
export class ListSyncService {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = environment.apiUrl;
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;

  async load(): Promise<ListData | null> {
    try {
      return await firstValueFrom(this.http.get<ListData>(`${this.apiUrl}/lists`));
    } catch {
      return null;
    }
  }

  debouncedSave(data: ListData): void {
    if (this.saveTimeout) clearTimeout(this.saveTimeout);
    this.saveTimeout = setTimeout(() => this.save(data), 2000);
  }

  private async save(data: ListData): Promise<void> {
    try {
      await firstValueFrom(this.http.put(`${this.apiUrl}/lists`, data));
    } catch {
      // Silently fail — will retry on next change
    }
  }
}
