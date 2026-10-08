import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';

export interface AdminUser {
  id: string;
  name: string | null;
  email: string;
  accountType: 'user' | 'admin';
  createdAt: string;
  lastSeenAt: string | null;
  isPremium: boolean;
  premiumOverride: boolean | null;
  profileRevision: number;
  stripePremium: boolean;
  mobilePremium: boolean;
  vipPremium: boolean;
}

export interface AdminUserPage {
  users: AdminUser[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AdminUserUpdate {
  profileRevision: number;
  name: string | null;
  email: string;
  premiumOverride: boolean | null;
}

@Injectable({ providedIn: 'root' })
export class AdminService {
  private readonly http = inject(HttpClient);
  private readonly url = `${environment.apiUrl}/admin/users`;

  list(q: string, page: number): Promise<AdminUserPage> {
    return firstValueFrom(
      this.http.get<AdminUserPage>(this.url, { params: { q, page, pageSize: 50 } }),
    );
  }

  update(
    id: string,
    changes: AdminUserUpdate,
  ): Promise<{ user: AdminUser; sessionRevoked: boolean }> {
    return firstValueFrom(
      this.http.patch<{ user: AdminUser; sessionRevoked: boolean }>(
        `${this.url}/${encodeURIComponent(id)}`,
        changes,
      ),
    );
  }
}
