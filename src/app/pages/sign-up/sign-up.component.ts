import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { RouterLink, Router } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { GoogleButtonComponent } from '../../components/google-button.component';

@Component({
  selector: 'app-sign-up',
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
        @if (!verifyEmailSent()) {
          <h2 class="auth-title">Create account</h2>
        }

        @if (verifyEmailSent()) {
          <div class="auth-verify-notice" role="status">
            @if (alreadyPending()) {
              <p>Your email isn't verified yet. Check your inbox or request a new link below.</p>
            } @else {
              <p>We've sent a verification link to your email. Click it to activate your account.</p>
            }
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
            <label class="auth-label" for="name">Name (optional)</label>
            <input
              id="name"
              class="auth-input"
              type="text"
              formControlName="name"
              autocomplete="name"
            />

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
              [class.auth-input--error]="form.controls.password.invalid && form.controls.password.touched"
              type="password"
              formControlName="password"
              autocomplete="new-password"
            />
            @if (form.controls.password.touched && form.controls.password.errors) {
              <p class="auth-field-error" role="alert">
                Password must be at least 8 characters.
              </p>
            }

            <button class="auth-btn" type="submit" [disabled]="loading()">
              @if (loading()) { Creating account… } @else { Sign up }
            </button>
          </form>

          <div class="auth-divider"><span>or</span></div>

          <app-google-button (credentialResponse)="onGoogleSignUp($event)" />
          }

          <p class="auth-switch">
            Already have an account? <a routerLink="/sign-in">Sign in</a>
          </p>
          <p class="auth-legal">
            By signing up you agree to our <a routerLink="/terms">Terms</a> and <a routerLink="/privacy">Privacy Policy</a>.
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
      line-height: 1.5;
      a {
        color: var(--text-muted);
        text-decoration: underline;
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
      margin-top: 10px;
    }
  `],
})
export class SignUpComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly fb = inject(FormBuilder);

  protected readonly error = signal('');
  protected readonly loading = signal(false);
  protected readonly googleLoading = signal(false);
  protected readonly verifyEmailSent = signal(false);
  protected readonly alreadyPending = signal(false);
  protected readonly resendLoading = signal(false);
  protected readonly resendSuccess = signal(false);
  private pendingEmail = '';

  protected readonly form = this.fb.nonNullable.group({
    name: [''],
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required, Validators.minLength(8)]],
  });

  protected async onSubmit(): Promise<void> {
    this.form.markAllAsTouched();
    if (this.form.invalid) return;
    this.loading.set(true);
    this.error.set('');

    try {
      const { email, password, name } = this.form.getRawValue();
      await this.auth.register(email, password, name || undefined);
      this.pendingEmail = email;
      this.verifyEmailSent.set(true);
    } catch (e: any) {
      const code = e?.error?.error;
      if (code === 'EMAIL_TAKEN') {
        this.error.set('This email is already registered. Sign in instead.');
      } else if (code === 'PENDING_VERIFICATION') {
        this.pendingEmail = this.form.getRawValue().email;
        this.alreadyPending.set(true);
        this.verifyEmailSent.set(true);
      } else {
        this.error.set(e?.error?.error ?? 'Registration failed. Please try again.');
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
      // silent — API always returns 200
      this.resendSuccess.set(true);
    } finally {
      this.resendLoading.set(false);
    }
  }

  protected async onGoogleSignUp(idToken: string): Promise<void> {
    this.googleLoading.set(true);
    this.loading.set(true);
    this.error.set('');
    try {
      await this.auth.googleAuth(idToken);
      this.router.navigate(['/']);
    } catch (e: any) {
      this.error.set(e?.error?.error ?? 'Google sign up failed.');
    } finally {
      this.loading.set(false);
      this.googleLoading.set(false);
    }
  }
}
