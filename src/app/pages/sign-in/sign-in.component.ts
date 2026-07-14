import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { RouterLink, Router } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { GoogleButtonComponent } from '../../components/google-button.component';

@Component({
  selector: 'app-sign-in',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, GoogleButtonComponent],
  template: `
    <div class="auth-page">
      <div class="auth-card">
        <a class="auth-back" routerLink="/" aria-label="back to home">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
          </svg>
        </a>
        <h1 class="auth-logo">splendide.</h1>
        @if (!pendingVerification()) {
          <h2 class="auth-title">sign in</h2>
        }

        @if (pendingVerification()) {
          <div class="auth-verify-notice" role="status">
            <p>your email isn't verified yet. check your inbox or request a new link</p>
            @if (resendSuccess()) {
              <p class="auth-resend-success">a new link has been sent</p>
            } @else {
              <button class="auth-resend-btn" [disabled]="resendLoading()" (click)="onResend()">
                {{ resendLoading() ? 'sending' : 'resend verification email' }}
              </button>
            }
          </div>
        } @else {
          @if (error()) {
            <p class="auth-error" role="alert">{{ error() }}</p>
          }

          @if (googleLoading()) {
            <p class="auth-loading">signing in</p>
          } @else {
          <form [formGroup]="form" (ngSubmit)="onSubmit()" class="auth-form">
            <label class="auth-label" for="email">email</label>
            <input
              id="email"
              class="auth-input"
              [class.auth-input--error]="form.controls.email.invalid && form.controls.email.touched"
              type="email"
              formControlName="email"
              autocomplete="email"
            />
            @if (form.controls.email.touched && form.controls.email.errors) {
              <p class="auth-field-error" role="alert">
                enter a valid email address
              </p>
            }

            <label class="auth-label" for="password">password</label>
            <div class="auth-password-field">
              <input
                id="password"
                class="auth-input"
                [type]="passwordVisible() ? 'text' : 'password'"
                formControlName="password"
                autocomplete="current-password"
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

            <a class="auth-forgot" routerLink="/forgot-password">forgot password?</a>

            <button class="auth-btn" type="submit" [disabled]="loading()">
              @if (loading()) { signing in } @else { sign in }
            </button>
          </form>

          <div class="auth-divider"><span>or</span></div>

          <app-google-button
            (credentialResponse)="onGoogleSignIn($event)"
            (desktopSignIn)="onGoogleDesktopSignIn()"
            (appleSignIn)="onAppleSignIn()"
          />
          }

          <p class="auth-switch">
            don't have an account? <a routerLink="/sign-up">sign up</a>
          </p>
          <p class="auth-legal">
            <a routerLink="/terms">terms</a> / <a routerLink="/privacy">privacy</a>
          </p>
        }
      </div>
    </div>
  `,
  styles: [`
    .auth-field-error {
      font-size: 0.8rem;
      color: #e53e3e;
      margin: -6px 0 4px;
    }
    .auth-input--error {
      border-color: #e53e3e;
    }
    .auth-loading {
      text-align: center;
      color: var(--text-muted);
      margin: 24px 0;
    }
    .auth-legal {
      text-align: center;
      margin-top: 16px;
      font-size: 0.75rem;
      color: var(--text-muted);
      a {
        color: var(--text-muted);
        text-decoration: none;
        &:hover { color: var(--text); }
      }
    }
    .auth-verify-notice {
      text-align: center;
      padding: 16px 0;
      p {
        font-size: 0.9rem;
        color: var(--text);
        line-height: 1.5;
        margin: 0 0 16px;
      }
    }
    .auth-resend-btn {
      background: none;
      border: 1px solid var(--border, #e0e0e0);
      border-radius: 6px;
      padding: 8px 16px;
      margin-top: 10px;
      font-size: 0.85rem;
      cursor: pointer;
      color: var(--text);
      &:hover:not(:disabled) { background: var(--surface-hover, #f5f5f5); }
      &:disabled { opacity: 0.5; cursor: default; }
    }
    .auth-resend-success {
      font-size: 0.85rem;
      color: #2f9e44;
    }
  `],
})
export class SignInComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly fb = inject(FormBuilder);

  protected readonly error = signal('');
  protected readonly loading = signal(false);
  protected readonly googleLoading = signal(false);
  protected readonly pendingVerification = signal(false);
  protected readonly resendLoading = signal(false);
  protected readonly resendSuccess = signal(false);
  protected readonly passwordVisible = signal(false);
  private pendingEmail = '';

  protected readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required]],
  });

  protected async onSubmit(): Promise<void> {
    this.form.markAllAsTouched();
    if (this.form.invalid) return;
    this.loading.set(true);
    this.error.set('');

    try {
      const { email, password } = this.form.getRawValue();
      await this.auth.login(email, password);
      this.router.navigate(['/']);
    } catch (e: any) {
      if (e?.error?.error === 'PENDING_VERIFICATION') {
        this.pendingEmail = this.form.getRawValue().email;
        this.pendingVerification.set(true);
      } else {
        this.error.set(e?.error?.error ?? 'sign in failed. please try again');
      }
    } finally {
      this.loading.set(false);
    }
  }

  protected async onResend(): Promise<void> {
    if (!this.pendingEmail) return;
    this.resendLoading.set(true);
    try {
      await this.auth.resendVerification(this.pendingEmail);
      this.resendSuccess.set(true);
    } catch {
      this.resendSuccess.set(true);
    } finally {
      this.resendLoading.set(false);
    }
  }

  protected async onGoogleSignIn(idToken: string): Promise<void> {
    this.googleLoading.set(true);
    this.loading.set(true);
    this.error.set('');
    try {
      await this.auth.googleAuth(idToken);
      this.router.navigate(['/']);
    } catch (e: any) {
      this.error.set(e?.error?.error ?? 'google sign in failed');
    } finally {
      this.loading.set(false);
      this.googleLoading.set(false);
    }
  }

  protected async onGoogleDesktopSignIn(): Promise<void> {
    this.googleLoading.set(true);
    this.loading.set(true);
    this.error.set('');
    try {
      await this.auth.googleDesktopAuth();
      this.router.navigate(['/']);
    } catch (e: any) {
      this.error.set(e?.error?.error ?? e?.message ?? 'google sign in failed');
    } finally {
      this.loading.set(false);
      this.googleLoading.set(false);
    }
  }

  protected async onAppleSignIn(): Promise<void> {
    this.googleLoading.set(true);
    this.loading.set(true);
    this.error.set('');
    try {
      await this.auth.appleMobileAuth();
      this.router.navigate(['/']);
    } catch (error: any) {
      if (error?.code !== 'USER_CANCELLED') {
        this.error.set(error?.error?.error ?? error?.message ?? 'apple sign in failed');
      }
    } finally {
      this.loading.set(false);
      this.googleLoading.set(false);
    }
  }
}

