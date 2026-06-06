import { ChangeDetectionStrategy, Component, inject, signal, OnInit } from '@angular/core';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-reset-password',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink],
  template: `
    <div class="auth-page">
      <div class="auth-card">
        <h1 class="auth-logo">splendide.</h1>
        <h2 class="auth-title">reset password</h2>

        @if (success()) {
          <p class="auth-success" role="status">
            password has been reset successfully
          </p>
          <p class="auth-switch">
            <a routerLink="/sign-in">sign in with your new password</a>
          </p>
        } @else {
          @if (error()) {
            <p class="auth-error" role="alert">{{ error() }}</p>
          }

          <form [formGroup]="form" (ngSubmit)="onSubmit()" class="auth-form">
            <label class="auth-label" for="password">new password</label>
            <div class="auth-password-field">
              <input
                id="password"
                class="auth-input"
                [class.auth-input--error]="form.controls.password.invalid && form.controls.password.touched"
                [type]="passwordVisible() ? 'text' : 'password'"
                formControlName="password"
                autocomplete="new-password"
              />
              <button
                class="auth-password-toggle"
                type="button"
                [attr.aria-label]="passwordVisible() ? 'hide password' : 'show password'"
                (click)="passwordVisible.update(visible => !visible)"
              >
                @if (passwordVisible()) {
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
            @if (form.controls.password.touched && form.controls.password.errors?.['minlength']) {
              <p class="auth-field-error" role="alert">password must be at least 8 characters</p>
            }

            <label class="auth-label" for="confirmPassword">confirm new password</label>
            <div class="auth-password-field">
              <input
                id="confirmPassword"
                class="auth-input"
                [class.auth-input--error]="form.controls.confirmPassword.touched && passwordsMismatch()"
                [type]="confirmPasswordVisible() ? 'text' : 'password'"
                formControlName="confirmPassword"
                autocomplete="new-password"
              />
              <button
                class="auth-password-toggle"
                type="button"
                [attr.aria-label]="confirmPasswordVisible() ? 'hide password' : 'show password'"
                (click)="confirmPasswordVisible.update(visible => !visible)"
              >
                @if (confirmPasswordVisible()) {
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
            @if (form.controls.confirmPassword.touched && passwordsMismatch()) {
              <p class="auth-field-error" role="alert">new passwords do not match</p>
            }

            <button class="auth-btn" type="submit" [disabled]="loading()">
              @if (loading()) { resetting } @else { reset password }
            </button>
          </form>
        }
      </div>
    </div>
  `,
  styles: [`
    .auth-field-error {
      font-size: 0.8rem;
      color: #e53e3e;
      margin: -12px 0 0;
    }

    .auth-input--error {
      border-color: #e53e3e;
    }
  `],
})
export class ResetPasswordComponent implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly fb = inject(FormBuilder);

  protected readonly error = signal('');
  protected readonly loading = signal(false);
  protected readonly success = signal(false);
  protected readonly passwordVisible = signal(false);
  protected readonly confirmPasswordVisible = signal(false);
  private token = '';

  protected readonly form = this.fb.nonNullable.group({
    password: ['', [Validators.required, Validators.minLength(8)]],
    confirmPassword: ['', Validators.required],
  });

  ngOnInit(): void {
    this.token = this.route.snapshot.queryParamMap.get('token') ?? '';
    if (!this.token) {
      this.error.set('invalid or missing reset token');
    }
  }

  protected async onSubmit(): Promise<void> {
    this.form.markAllAsTouched();
    if (this.form.invalid || this.passwordsMismatch() || !this.token) return;
    this.loading.set(true);
    this.error.set('');

    try {
      await this.auth.resetPassword(this.token, this.form.getRawValue().password);
      this.success.set(true);
    } catch (e: any) {
      this.error.set(e?.error?.error ?? 'reset failed. the link may have expired');
    } finally {
      this.loading.set(false);
    }
  }

  protected passwordsMismatch(): boolean {
    const { password, confirmPassword } = this.form.getRawValue();
    return Boolean(confirmPassword) && password !== confirmPassword;
  }
}
