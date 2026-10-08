import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { openExternalUrl } from '../../utils/external-link';
import { environment } from '../../../environments/environment';
import { MobileNotificationsService } from '../../services/mobile-notifications.service';
import { MobilePurchasesService } from '../../services/mobile-purchases.service';
import { DeadlineNotificationsService } from '../../services/deadline-notifications.service';

@Component({
  selector: 'app-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink],
  template: `
    <div class="settings-page">
      <div class="settings-card">

        <a class="auth-back" routerLink="/" aria-label="back to home">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
          </svg>
        </a>

        <p class="auth-logo">splendide.</p>
        <h1 class="auth-title">settings</h1>

        <section class="settings-section" aria-labelledby="device-notifications-title">
          <div class="notification-row">
            <div class="settings-section-header">
              <h3 id="device-notifications-title" class="settings-section-title">notifications on this device</h3>
              @if (!isMobile) {
                <p id="device-notifications-description" class="settings-section-desc" aria-live="polite">
                  {{ deviceNotificationDescription() }}
                </p>
              }
            </div>
            <label class="settings-switch">
              <input
                type="checkbox"
                [checked]="deadlineNotifications.deviceNotificationsEnabled()"
                [disabled]="deviceNotificationLoading()"
                (change)="setDeviceNotifications($any($event.target).checked)"
                aria-label="notifications on this device"
                [attr.aria-describedby]="isMobile ? null : 'device-notifications-description'"
              />
              <span class="settings-switch-track" aria-hidden="true"><span></span></span>
            </label>
          </div>
          @if (deviceNotificationError()) {
            <p class="settings-error" role="alert">{{ deviceNotificationError() }}</p>
          }
          @if (!auth.isLoggedIn() && !isMobile) {
            <p class="settings-section-note">stored on this device; no account required</p>
          }
        </section>

        <!-- ── Go Premium ───────────────────────────────── -->
        @if (auth.user()?.premiumOverride !== null && auth.user()?.premiumOverride !== undefined) {
          <p class="settings-section-desc">premium access is managed by an administrator. existing subscriptions are unchanged.</p>
        }
        @if (auth.isLoggedIn() && !auth.isPremium() && auth.user()?.premiumOverride !== false) {
          <section class="settings-section">
            <div class="settings-section-header">
              <h3 class="settings-section-title">More room for larger work sessions</h3>
            </div>
            <button class="settings-btn settings-btn--accent" (click)="goPremium()">
              Upgrade to premium ✦
            </button>
          </section>
        }

        @if (!isMobile) {
          <section class="settings-section desktop-shortcuts" aria-labelledby="keyboard-shortcuts-title">
            <div class="settings-section-header">
              <h3 id="keyboard-shortcuts-title" class="settings-section-title">keyboard shortcuts</h3>
              <p class="settings-section-desc">move quickly without leaving the keyboard</p>
            </div>
            <dl class="shortcut-list">
              <div class="shortcut-row">
                <dt><kbd>↑</kbd><kbd>↓</kbd></dt>
                <dd>move through pages and tasks</dd>
              </div>
              <div class="shortcut-row">
                <dt><kbd>←</kbd><kbd>→</kbd></dt>
                <dd>switch pages</dd>
              </div>
              <div class="shortcut-row">
                <dt><kbd>Enter</kbd></dt>
                <dd>open or save</dd>
              </div>
              <div class="shortcut-row">
                <dt><kbd>Tab</kbd></dt>
                <dd>add a subtask while writing a task</dd>
              </div>
              <div class="shortcut-row">
                <dt><kbd>Delete</kbd></dt>
                <dd>remove the focused task or page</dd>
              </div>
              <div class="shortcut-row">
                <dt><kbd>Esc</kbd></dt>
                <dd>cancel editing or close dialogs</dd>
              </div>
            </dl>
          </section>
        }

        @if (auth.isLoggedIn() && isMobile) {
          <section class="settings-section">
            <div class="notification-row">
              <div class="settings-section-header">
                <h3 class="settings-section-title">shared-page activity</h3>
                <p class="settings-section-desc">an account setting for alerts when someone adds an item</p>
              </div>
              <label class="settings-switch">
                <input
                  type="checkbox"
                  [checked]="auth.user()?.sharedNotificationsEnabled === true"
                  [disabled]="notificationLoading()"
                  (change)="setSharedNotifications($any($event.target).checked)"
                  aria-label="shared page notifications"
                />
                <span class="settings-switch-track" aria-hidden="true"><span></span></span>
              </label>
            </div>
            @if (notificationError()) {
              <p class="settings-error" role="alert">{{ notificationError() }}</p>
            }
          </section>
        }

        <!-- ── Change Password ──────────────────────────── -->
        @if (auth.user()?.hasPassword) {
          <section class="settings-section">
            <div class="settings-section-header">
              <h3 class="settings-section-title">Change password</h3>
            </div>

            @if (pwSuccess()) {
              <p class="settings-success">password changed successfully</p>
            } @else {
              <form [formGroup]="pwForm" (ngSubmit)="submitChangePassword()" class="settings-form">
                @if (pwError()) {
                  <p class="settings-error" role="alert">{{ pwError() }}</p>
                }
                <label class="auth-label" for="currentPassword">current password</label>
                <div class="auth-password-field">
                  <input
                    id="currentPassword"
                    class="auth-input"
                    [type]="currentPasswordVisible() ? 'text' : 'password'"
                    formControlName="currentPassword"
                    autocomplete="current-password"
                  />
                  <button
                    class="auth-password-toggle"
                    type="button"
                    [attr.aria-label]="currentPasswordVisible() ? 'hide password' : 'show password'"
                    (click)="currentPasswordVisible.update(visible => !visible)"
                  >
                    @if (currentPasswordVisible()) {
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M2 2l20 20" />
                        <path d="M10.6 10.6a2 2 0 0 0 2.8 2.8" />
                        <path d="M9.9 5.1A10.6 10.6 0 0 1 12 5c5 0 9 4.5 10 7a13.1 13.1 0 0 1-2.2 3.3" />
                        <path d="M6.6 6.6A13.3 13.3 0 0 0 2 12c1 2.5 5 7 10 7 1.6 0 3.1-.4 4.4-1" />
                      </svg>
                    } @else {
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    }
                  </button>
                </div>
                <label class="auth-label" for="newPassword">new password</label>
                <div class="auth-password-field">
                  <input
                    id="newPassword"
                    class="auth-input"
                    [class.auth-input--error]="pwForm.controls.newPassword.invalid && pwForm.controls.newPassword.touched"
                    [type]="newPasswordVisible() ? 'text' : 'password'"
                    formControlName="newPassword"
                    autocomplete="new-password"
                  />
                  <button
                    class="auth-password-toggle"
                    type="button"
                    [attr.aria-label]="newPasswordVisible() ? 'hide password' : 'show password'"
                    (click)="newPasswordVisible.update(visible => !visible)"
                  >
                    @if (newPasswordVisible()) {
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M2 2l20 20" />
                        <path d="M10.6 10.6a2 2 0 0 0 2.8 2.8" />
                        <path d="M9.9 5.1A10.6 10.6 0 0 1 12 5c5 0 9 4.5 10 7a13.1 13.1 0 0 1-2.2 3.3" />
                        <path d="M6.6 6.6A13.3 13.3 0 0 0 2 12c1 2.5 5 7 10 7 1.6 0 3.1-.4 4.4-1" />
                      </svg>
                    } @else {
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    }
                  </button>
                </div>
                @if (pwForm.controls.newPassword.touched && pwForm.controls.newPassword.errors?.['minlength']) {
                  <p class="settings-field-error" role="alert">password must be at least 8 characters</p>
                }
                <label class="auth-label" for="confirmNewPassword">confirm new password</label>
                <div class="auth-password-field">
                  <input
                    id="confirmNewPassword"
                    class="auth-input"
                    [class.auth-input--error]="pwForm.controls.confirmNewPassword.touched && passwordsMismatch()"
                    [type]="confirmNewPasswordVisible() ? 'text' : 'password'"
                    formControlName="confirmNewPassword"
                    autocomplete="new-password"
                  />
                  <button
                    class="auth-password-toggle"
                    type="button"
                    [attr.aria-label]="confirmNewPasswordVisible() ? 'hide password' : 'show password'"
                    (click)="confirmNewPasswordVisible.update(visible => !visible)"
                  >
                    @if (confirmNewPasswordVisible()) {
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M2 2l20 20" />
                        <path d="M10.6 10.6a2 2 0 0 0 2.8 2.8" />
                        <path d="M9.9 5.1A10.6 10.6 0 0 1 12 5c5 0 9 4.5 10 7a13.1 13.1 0 0 1-2.2 3.3" />
                        <path d="M6.6 6.6A13.3 13.3 0 0 0 2 12c1 2.5 5 7 10 7 1.6 0 3.1-.4 4.4-1" />
                      </svg>
                    } @else {
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    }
                  </button>
                </div>
                @if (pwForm.controls.confirmNewPassword.touched && passwordsMismatch()) {
                  <p class="settings-field-error" role="alert">new passwords do not match</p>
                }
                <button class="settings-btn settings-btn--primary" type="submit" [disabled]="pwLoading()">
                  {{ pwLoading() ? 'saving' : 'Save password' }}
                </button>
              </form>
            }
          </section>
        }

        <!-- ── Delete Account ───────────────────────────── -->
        @if (auth.isLoggedIn()) {
          <section class="settings-section settings-section--danger">
          <div class="settings-section-header">
            <h3 class="settings-section-title settings-section-title--danger">Delete account</h3>
            <p class="settings-section-desc">
              @if (hasCancelableSubscription()) {
                Cancel active subscriptions before deleting your account
              } @else {
                Permanently delete your account and all data. This cannot be undone
              }
            </p>
          </div>

          @if (hasCancelableSubscription()) {
            @if (auth.user()?.hasMobileSubscription) {
              <button class="settings-btn settings-btn--primary" [disabled]="subscriptionLoading()" (click)="manageSubscription('mobile')">
                {{ subscriptionLoading() ? 'Opening' : 'Manage App Store subscription' }}
              </button>
            }
            @if (auth.user()?.hasStripeSubscription) {
              <button class="settings-btn settings-btn--primary" [disabled]="subscriptionLoading()" (click)="manageSubscription('stripe')">
                {{ subscriptionLoading() ? 'Opening' : 'Manage web subscription' }}
              </button>
            }
            @if (deleteError()) {
              <p class="settings-error" role="alert">{{ deleteError() }}</p>
            }
          } @else if (!confirmDelete()) {
            <button class="settings-btn settings-btn--danger-outline" (click)="confirmDelete.set(true)">
              Delete my account
            </button>
          } @else {
            <p class="settings-confirm-text">type <strong>delete</strong> to confirm account deletion</p>
            <input
              class="settings-delete-input"
              type="text"
              placeholder="delete"
              autocomplete="off"
              [value]="deleteConfirmText()"
              (input)="deleteConfirmText.set($any($event.target).value)"
            />
            <div class="settings-confirm-actions">
              <button class="settings-btn settings-btn--ghost" (click)="confirmDelete.set(false); deleteConfirmText.set('')">cancel</button>
              <button class="settings-btn settings-btn--danger" [disabled]="deleteLoading() || deleteConfirmText() !== 'delete'" (click)="deleteAccount()">
                {{ deleteLoading() ? 'deleting' : 'yes, delete everything' }}
              </button>
            </div>
            @if (deleteError()) {
              <p class="settings-error" role="alert">{{ deleteError() }}</p>
            }
          }
          </section>
        }

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
      gap: 12px;
    }

    .notification-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
    }

    .settings-switch {
      position: relative;
      display: inline-flex;
      min-height: 44px;
      flex: 0 0 auto;
      align-items: center;
      cursor: pointer;
    }
    .settings-switch input { position: absolute; opacity: 0; pointer-events: none; }
    .settings-switch-track {
      display: block;
      box-sizing: border-box;
      width: 46px;
      height: 28px;
      padding: 2px;
      border: 1px solid var(--accent);
      border-radius: 999px;
      background: transparent;
      transition: background .18s ease, border-color .18s ease;
    }
    .settings-switch-track span {
      display: block;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      background: var(--accent);
      box-shadow: 0 1px 3px rgba(0, 0, 0, .22);
      transition: transform .2s cubic-bezier(.2, .8, .2, 1), background .18s ease;
    }
    .settings-switch input:checked + .settings-switch-track {
      border-color: var(--accent);
      background: var(--accent);
    }
    .settings-switch input:checked + .settings-switch-track span {
      transform: translateX(18px);
      background: var(--card, #fff);
    }
    .settings-switch input:focus-visible + .settings-switch-track { outline: 2px solid var(--text); outline-offset: 3px; }
    .settings-switch input:disabled + .settings-switch-track { opacity: .55; }

    .settings-section-title {
      font-size: 1rem;
      font-weight: 600;
      color: var(--text);
      margin: 0 0 10px 0;

      &--danger {
        color: #e53e3e;
      }
    }

    .settings-section-desc {
      font-size: 0.85rem;
      color: var(--text-secondary);
      margin: 0;
    }

    .settings-section-note {
      margin: 0;
      color: var(--text-muted);
      font-size: 0.76rem;
    }

    .shortcut-list {
      display: grid;
      gap: 10px;
      margin: 0;
    }

    .shortcut-row {
      display: grid;
      grid-template-columns: 94px 1fr;
      align-items: center;
      gap: 12px;
    }

    .shortcut-row dt,
    .shortcut-row dd {
      margin: 0;
    }

    .shortcut-row dt {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .shortcut-row dd {
      color: var(--text-muted);
      font-size: 0.82rem;
    }

    .shortcut-row kbd {
      min-width: 24px;
      padding: 3px 6px;
      border: 1px solid var(--border);
      border-radius: 5px;
      background: var(--card);
      color: var(--text-secondary);
      box-shadow: inset 0 -1px 0 var(--border);
      font-family: inherit;
      font-size: 0.72rem;
      font-weight: 500;
      line-height: 1.2;
      text-align: center;
    }

    .settings-account-prompt {
      align-items: flex-start;
    }

    .settings-link {
      min-height: 40px;
      padding: 10px 0;
      color: var(--text);
      font-size: 0.85rem;
      font-weight: 600;
      text-underline-offset: 3px;
    }

    .settings-link:focus-visible {
      border-radius: 4px;
      outline: 2px solid var(--text);
      outline-offset: 3px;
    }

    @media (max-width: 768px) {
      .desktop-shortcuts {
        display: none;
      }
    }

    @media (hover: none) and (pointer: coarse) {
      .desktop-shortcuts {
        display: none;
      }
    }

    .settings-form {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .settings-btn {
      align-self: flex-start;
      min-height: 38px;
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

    .settings-delete-input {
      padding: 8px 12px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--bg);
      color: var(--text);
      font-size: 0.875rem;
      font-family: inherit;
      width: 100%;
      max-width: 220px;
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
  protected readonly deadlineNotifications = inject(DeadlineNotificationsService);
  private readonly router = inject(Router);
  private readonly fb = inject(FormBuilder);
  private readonly notifications = inject(MobileNotificationsService);
  private readonly mobilePurchases = inject(MobilePurchasesService);
  protected readonly isMobile = environment.isMobile || (
    typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches
  );
  protected readonly notificationLoading = signal(false);
  protected readonly notificationError = signal('');
  protected readonly deviceNotificationLoading = signal(false);
  protected readonly deviceNotificationError = signal('');
  protected readonly deviceNotificationDescription = computed(() => {
    if (!this.deadlineNotifications.deviceNotificationsEnabled()) {
      return 'task reminders and supported activity alerts are off';
    }

    switch (this.deadlineNotifications.permissionState()) {
      case 'granted':
        if (this.deadlineNotifications.registrationState() === 'retrying') {
          return 'permission granted; delivery setup will retry when online';
        }
        return this.auth.isLoggedIn()
          ? 'ready for task reminders and supported activity alerts'
          : 'ready for task reminders on this device';
      case 'denied':
        return 'enabled here, but blocked in your device or browser settings';
      case 'unsupported':
        return 'enabled here, but unavailable on this device or browser';
      case 'prompt':
        return 'permission is waiting for your confirmation';
    }
  });

  protected async setDeviceNotifications(enabled: boolean): Promise<void> {
    this.deviceNotificationLoading.set(true);
    this.deviceNotificationError.set('');
    try {
      await this.deadlineNotifications.setDeviceNotificationsEnabled(enabled);
    } catch (error: unknown) {
      this.deviceNotificationError.set(
        error instanceof Error ? error.message : 'notification settings could not be updated',
      );
    } finally {
      this.deviceNotificationLoading.set(false);
    }
  }

  protected async setSharedNotifications(enabled: boolean): Promise<void> {
    this.notificationLoading.set(true);
    this.notificationError.set('');
    try {
      await this.notifications.setEnabled(enabled);
    } catch (error: any) {
      this.notificationError.set(error?.message ?? 'notification settings could not be updated');
    } finally {
      this.notificationLoading.set(false);
    }
  }

  // ── Change password ──────────────────────────────────────
  protected readonly pwForm = this.fb.group({
    currentPassword: ['', Validators.required],
    newPassword: ['', [Validators.required, Validators.minLength(8)]],
    confirmNewPassword: ['', Validators.required],
  });
  protected readonly pwLoading = signal(false);
  protected readonly pwError = signal('');
  protected readonly pwSuccess = signal(false);
  protected readonly currentPasswordVisible = signal(false);
  protected readonly newPasswordVisible = signal(false);
  protected readonly confirmNewPasswordVisible = signal(false);

  protected async submitChangePassword(): Promise<void> {
    if (this.pwForm.invalid) {
      this.pwForm.markAllAsTouched();
      return;
    }
    if (this.passwordsMismatch()) {
      this.pwForm.controls.confirmNewPassword.markAsTouched();
      this.pwError.set('new passwords do not match');
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
      this.pwError.set(e?.error?.error ?? 'failed to change password');
    } finally {
      this.pwLoading.set(false);
    }
  }

  protected passwordsMismatch(): boolean {
    const { newPassword, confirmNewPassword } = this.pwForm.getRawValue();
    return Boolean(confirmNewPassword) && newPassword !== confirmNewPassword;
  }

  // ── Go Premium ───────────────────────────────────────────
  protected async goPremium(): Promise<void> {
    this.router.navigate(['/payment']);
  }

  // ── Delete account ───────────────────────────────────────
  protected readonly confirmDelete = signal(false);
  protected readonly deleteConfirmText = signal('');
  protected readonly deleteLoading = signal(false);
  protected readonly deleteError = signal('');
  protected readonly subscriptionLoading = signal(false);

  protected hasCancelableSubscription(): boolean {
    const user = this.auth.user();
    return Boolean(user?.hasMobileSubscription || user?.hasStripeSubscription);
  }

  protected async manageSubscription(source: 'mobile' | 'stripe'): Promise<void> {
    this.subscriptionLoading.set(true);
    this.deleteError.set('');
    try {
      if (source === 'mobile') {
        await this.mobilePurchases.openManagement();
        this.subscriptionLoading.set(false);
        return;
      }
      const url = await this.auth.manageSubscription();
      const openedExternally = await openExternalUrl(url);
      if (openedExternally) {
        this.subscriptionLoading.set(false);
      }
    } catch (e: any) {
      this.deleteError.set(e?.error?.error ?? 'could not open subscription management');
      this.subscriptionLoading.set(false);
    }
  }

  protected async deleteAccount(): Promise<void> {
    if (this.hasCancelableSubscription()) {
      this.deleteError.set('cancel your active subscription before deleting your account');
      return;
    }
    this.deleteLoading.set(true);
    this.deleteError.set('');
    try {
      await this.auth.deleteAccount();
    } catch (e: any) {
      this.deleteError.set(e?.error?.error ?? 'failed to delete account');
      this.deleteLoading.set(false);
    }
  }
}
