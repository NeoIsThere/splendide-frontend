import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink],
  template: `
    <div class="settings-page">
      <div class="settings-card">

        <a class="auth-back" routerLink="/" aria-label="Back to home">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
          </svg>
        </a>

        <h1 class="auth-logo">splendide.</h1>
        <h2 class="auth-title">Settings</h2>

        <!-- ── Go Premium ───────────────────────────────── -->
        @if (!auth.isPremium()) {
          <section class="settings-section">
            <div class="settings-section-header">
              <h3 class="settings-section-title">Go Premium</h3>
              <p class="settings-section-desc">Unlock unlimited sections and priority support.</p>
            </div>
            <button class="settings-btn settings-btn--accent" (click)="goPremium()">
              Upgrade to Premium
            </button>
          </section>
        }

        <!-- ── Change Password ──────────────────────────── -->
        @if (auth.user()?.hasPassword) {
          <section class="settings-section">
            <div class="settings-section-header">
              <h3 class="settings-section-title">Change Password</h3>
              <p class="settings-section-desc">Update your account password.</p>
            </div>

            @if (pwSuccess()) {
              <p class="settings-success">Password changed successfully.</p>
            } @else {
              <form [formGroup]="pwForm" (ngSubmit)="submitChangePassword()" class="settings-form">
                @if (pwError()) {
                  <p class="settings-error" role="alert">{{ pwError() }}</p>
                }
                <label class="auth-label" for="currentPassword">Current password</label>
                <input
                  id="currentPassword"
                  class="auth-input"
                  type="password"
                  formControlName="currentPassword"
                  autocomplete="current-password"
                />
                <label class="auth-label" for="newPassword">New password</label>
                <input
                  id="newPassword"
                  class="auth-input"
                  [class.auth-input--error]="pwForm.controls.newPassword.invalid && pwForm.controls.newPassword.touched"
                  type="password"
                  formControlName="newPassword"
                  autocomplete="new-password"
                />
                @if (pwForm.controls.newPassword.touched && pwForm.controls.newPassword.errors?.['minlength']) {
                  <p class="settings-field-error" role="alert">Password must be at least 8 characters.</p>
                }
                <button class="settings-btn settings-btn--primary" type="submit" [disabled]="pwLoading()">
                  {{ pwLoading() ? 'Saving…' : 'Save password' }}
                </button>
              </form>
            }
          </section>
        }

        <!-- ── Delete Account ───────────────────────────── -->
        <section class="settings-section settings-section--danger">
          <div class="settings-section-header">
            <h3 class="settings-section-title settings-section-title--danger">Delete Account</h3>
            <p class="settings-section-desc">Permanently delete your account and all data. This cannot be undone.</p>
          </div>

          @if (!confirmDelete()) {
            <button class="settings-btn settings-btn--danger-outline" (click)="confirmDelete.set(true)">
              Delete my account
            </button>
          } @else {
            <p class="settings-confirm-text">Are you sure? All your data will be permanently erased.</p>
            <div class="settings-confirm-actions">
              <button class="settings-btn settings-btn--ghost" (click)="confirmDelete.set(false)">Cancel</button>
              <button class="settings-btn settings-btn--danger" [disabled]="deleteLoading()" (click)="deleteAccount()">
                {{ deleteLoading() ? 'Deleting…' : 'Yes, delete everything' }}
              </button>
            </div>
            @if (deleteError()) {
              <p class="settings-error" role="alert">{{ deleteError() }}</p>
            }
          }
        </section>

      </div>
    </div>
  `,
  styles: [`
    .settings-page {
      display: flex;
      justify-content: center;
      padding: 48px 16px 80px;
      min-height: 100dvh;
    }

    .settings-card {
      width: 100%;
      max-width: 480px;
    }

    .settings-section {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 24px 0;
      border-top: 1px solid var(--border);

      &--danger {
        margin-top: 8px;
      }
    }

    .settings-section-header {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .settings-section-title {
      font-size: 1rem;
      font-weight: 600;
      color: var(--text);
      margin: 0;

      &--danger {
        color: #e53e3e;
      }
    }

    .settings-section-desc {
      font-size: 0.85rem;
      color: var(--text-secondary);
      margin: 0;
    }

    .settings-form {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .settings-btn {
      align-self: flex-start;
      padding: 9px 18px;
      border-radius: 8px;
      font-size: 0.875rem;
      font-family: inherit;
      font-weight: 500;
      cursor: pointer;
      border: none;
      transition: opacity 0.15s, background 0.15s;

      &:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }

      &--accent {
        background: var(--accent);
        color: var(--bg);
        &:hover:not(:disabled) { opacity: 0.85; }
      }

      &--primary {
        background: var(--text);
        color: var(--bg, #fff);
        &:hover:not(:disabled) { opacity: 0.8; }
      }

      &--danger {
        background: #e53e3e;
        color: #fff;
        &:hover:not(:disabled) { background: #c53030; }
      }

      &--danger-outline {
        background: none;
        border: 1px solid #e53e3e;
        color: #e53e3e;
        &:hover:not(:disabled) { background: #fff5f5; }
      }

      &--ghost {
        background: none;
        border: 1px solid var(--border);
        color: var(--text-secondary);
        &:hover:not(:disabled) { color: var(--text); }
      }
    }

    .settings-confirm-text {
      font-size: 0.875rem;
      color: var(--text-secondary);
      margin: 0;
    }

    .settings-confirm-actions {
      display: flex;
      gap: 10px;
    }

    .settings-error {
      font-size: 0.82rem;
      color: #e53e3e;
      margin: 0;
    }

    .settings-field-error {
      font-size: 0.8rem;
      color: #e53e3e;
      margin: -4px 0 0;
    }

    .settings-success {
      font-size: 0.875rem;
      color: #2f9e44;
      margin: 0;
    }

    .auth-input--error {
      border-color: #e53e3e;
    }
  `],
})
export class SettingsComponent {
  protected readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly fb = inject(FormBuilder);

  // ── Change password ──────────────────────────────────────
  protected readonly pwForm = this.fb.group({
    currentPassword: ['', Validators.required],
    newPassword: ['', [Validators.required, Validators.minLength(8)]],
  });
  protected readonly pwLoading = signal(false);
  protected readonly pwError = signal('');
  protected readonly pwSuccess = signal(false);

  protected async submitChangePassword(): Promise<void> {
    if (this.pwForm.invalid) {
      this.pwForm.markAllAsTouched();
      return;
    }
    this.pwLoading.set(true);
    this.pwError.set('');
    try {
      const { currentPassword, newPassword } = this.pwForm.value;
      await this.auth.changePassword(currentPassword!, newPassword!);
      this.pwSuccess.set(true);
      this.pwForm.reset();
    } catch (e: any) {
      this.pwError.set(e?.error?.error ?? 'Failed to change password.');
    } finally {
      this.pwLoading.set(false);
    }
  }

  // ── Go Premium ───────────────────────────────────────────
  protected async goPremium(): Promise<void> {
    this.router.navigate(['/payment']);
  }

  // ── Delete account ───────────────────────────────────────
  protected readonly confirmDelete = signal(false);
  protected readonly deleteLoading = signal(false);
  protected readonly deleteError = signal('');

  protected async deleteAccount(): Promise<void> {
    this.deleteLoading.set(true);
    this.deleteError.set('');
    try {
      await this.auth.deleteAccount();
    } catch (e: any) {
      this.deleteError.set(e?.error?.error ?? 'Failed to delete account.');
      this.deleteLoading.set(false);
    }
  }
}
