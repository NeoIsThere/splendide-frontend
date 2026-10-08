import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AdminService, AdminUser, AdminUserPage } from '../../services/admin.service';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-admin',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, ReactiveFormsModule, RouterLink],
  templateUrl: './admin.component.html',
  styleUrl: './admin.component.scss',
})
export class AdminComponent {
  private readonly admin = inject(AdminService);
  protected readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly search = new FormControl('', { nonNullable: true });
  protected readonly form = new FormGroup({
    name: new FormControl('', { nonNullable: true, validators: [Validators.maxLength(100)] }),
    email: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.email, Validators.maxLength(255)],
    }),
    premium: new FormControl<'billing' | 'premium' | 'free'>('billing', { nonNullable: true }),
  });
  protected readonly result = signal<AdminUserPage>({ users: [], total: 0, page: 1, pageSize: 50 });
  protected readonly selected = signal<AdminUser | null>(null);
  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly editError = signal('');
  protected readonly message = signal('');
  protected readonly pages = computed(() =>
    Math.max(1, Math.ceil(this.result().total / this.result().pageSize)),
  );
  private query = '';
  private requestId = 0;
  private editTrigger: HTMLButtonElement | null = null;

  constructor() {
    effect(() => {
      if (!this.auth.isAdmin()) {
        this.result.set({ users: [], total: 0, page: 1, pageSize: 50 });
        this.selected.set(null);
        void this.router.navigate(['/']);
      }
    });
    void this.load(1);
  }

  protected async load(page: number, search = false): Promise<void> {
    if (this.saving() || this.selected()) return;
    if (search) this.query = this.search.value.trim();
    const id = ++this.requestId;
    this.loading.set(true);
    this.error.set('');
    try {
      const result = await this.admin.list(this.query, page);
      if (id === this.requestId && !this.destroyRef.destroyed && this.auth.isAdmin())
        this.result.set(result);
    } catch (error) {
      if (id === this.requestId) {
        this.handleAuthorizationError(error);
        this.error.set(
          this.errorMessage(error, 'could not load users. check your connection and try again.'),
        );
      }
    } finally {
      if (id === this.requestId) this.loading.set(false);
    }
  }

  protected edit(user: AdminUser, trigger: HTMLButtonElement): void {
    this.editTrigger = trigger;
    this.selected.set(user);
    this.editError.set('');
    this.message.set('');
    this.form.reset({
      name: user.name ?? '',
      email: user.email,
      premium:
        user.premiumOverride === null ? 'billing' : user.premiumOverride ? 'premium' : 'free',
    });
    // Let Angular render the inline editor before moving keyboard focus into it.
    setTimeout(() => {
      if (!this.destroyRef.destroyed) document.getElementById('admin-name')?.focus();
    });
  }

  protected cancel(): void {
    this.selected.set(null);
    this.editError.set('');
    setTimeout(() => {
      if (!this.destroyRef.destroyed) this.editTrigger?.focus();
    });
  }

  protected async save(): Promise<void> {
    const current = this.selected();
    this.form.markAllAsTouched();
    if (!current || this.form.invalid || this.saving()) return;
    this.saving.set(true);
    this.editError.set('');
    const values = this.form.getRawValue();
    try {
      const result = await this.admin.update(current.id, {
        profileRevision: current.profileRevision,
        name: values.name.trim() || null,
        email: values.email.trim(),
        premiumOverride: values.premium === 'billing' ? null : values.premium === 'premium',
      });
      if (this.destroyRef.destroyed) return;
      if (result.sessionRevoked) {
        this.auth.expireSession();
        return;
      }
      this.result.update((page) => ({
        ...page,
        users: page.users.map((user) => (user.id === result.user.id ? result.user : user)),
      }));
      this.cancel();
      this.message.set('profile saved');
      if (current.id === this.auth.user()?.id) await this.auth.fetchUser();
    } catch (error) {
      this.handleAuthorizationError(error);
      this.editError.set(
        this.errorMessage(error, 'could not save. your changes are still here; please try again.'),
      );
    } finally {
      this.saving.set(false);
    }
  }

  private handleAuthorizationError(error: unknown): void {
    if (error instanceof HttpErrorResponse && (error.status === 401 || error.status === 403)) {
      this.result.set({ users: [], total: 0, page: 1, pageSize: 50 });
      this.selected.set(null);
      void this.auth.fetchUser();
      void this.router.navigate(['/']);
    }
  }

  private errorMessage(error: unknown, fallback: string): string {
    if (error instanceof HttpErrorResponse && typeof error.error?.error === 'string')
      return error.error.error;
    return fallback;
  }
}
