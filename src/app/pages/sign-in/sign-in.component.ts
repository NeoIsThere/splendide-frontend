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
        <a class="auth-back" routerLink="/" aria-label="Back to home">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
          </svg>
        </a>
        <h1 class="auth-logo">splendide.</h1>
        @if (!pendingVerification()) {
          <h2 class="auth-title">Sign in</h2>
        }

        @if (pendingVerification()) {
          <div class="auth-verify-notice" role="status">
            <p>Your email isn't verified yet. Check your inbox or request a new link.</p>
            @if (resendSuccess()) {
              <p class="auth-resend-success">A new link has been sent.</p>
            } @else {
              <button class="auth-resend-btn" [disabled]="resendLoading()" (click)="onResend()">
                {{ resendLoading() ? 'Sending…' : 'Resend verification email' }}
              </button>
            }
          </div>
        } @else {
          @if (error()) {
            <p class="auth-error" role="alert">{{ error() }}</p>
          }

          @if (googleLoading()) {
            <p class="auth-loading">Signing in…</p>
          } @else {
          <form [formGroup]="form" (ngSubmit)="onSubmit()" class="auth-form">
            <label class="auth-label" for="email">Email</label>
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
                Enter a valid email address.
              </p>
            }

            <label class="auth-label" for="password">Password</label>
            <input
              id="password"
              class="auth-input"
              type="password"
              formControlName="password"
              autocomplete="current-password"
            />

            <a class="auth-forgot" routerLink="/forgot-password">Forgot password?</a>

            <button class="auth-btn" type="submit" [disabled]="loading()">
              @if (loading()) { Signing in… } @else { Sign in }
            </button>
          </form>

          <div class="auth-divider"><span>or</span></div>

          <app-google-button (credentialResponse)="onGoogleSignIn($event)" />
          }

          <p class="auth-switch">
            Don't have an account? <a routerLink="/sign-up">Sign up</a>
          </p>
          <p class="auth-legal">
            <a routerLink="/terms">Terms</a> · <a routerLink="/privacy">Privacy</a>
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
        this.error.set(e?.error?.error ?? 'Sign in failed. Please try again.');
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
      this.error.set(e?.error?.error ?? 'Google sign in failed.');
    } finally {
      this.loading.set(false);
      this.googleLoading.set(false);
    }
  }
}

