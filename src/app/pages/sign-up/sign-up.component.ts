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
        <h2 class="auth-title">Create account</h2>

        @if (error()) {
          <p class="auth-error" role="alert">{{ error() }}</p>
        }

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
            type="email"
            formControlName="email"
            autocomplete="email"
          />

          <label class="auth-label" for="password">Password</label>
          <input
            id="password"
            class="auth-input"
            type="password"
            formControlName="password"
            autocomplete="new-password"
          />

          <button class="auth-btn" type="submit" [disabled]="loading()">
            @if (loading()) { Creating account… } @else { Sign up }
          </button>
        </form>

        <div class="auth-divider"><span>or</span></div>

        <app-google-button (credentialResponse)="onGoogleSignUp($event)" />

        <p class="auth-switch">
          Already have an account? <a routerLink="/sign-in">Sign in</a>
        </p>
        <p class="auth-legal">
          By signing up you agree to our <a routerLink="/terms">Terms</a> and <a routerLink="/privacy">Privacy Policy</a>.
        </p>
      </div>
    </div>
  `,
  styles: [`
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
  `],
})
export class SignUpComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly fb = inject(FormBuilder);

  protected readonly error = signal('');
  protected readonly loading = signal(false);

  protected readonly form = this.fb.nonNullable.group({
    name: [''],
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required, Validators.minLength(8)]],
  });

  protected async onSubmit(): Promise<void> {
    if (this.form.invalid) return;
    this.loading.set(true);
    this.error.set('');

    try {
      const { email, password, name } = this.form.getRawValue();
      await this.auth.register(email, password, name || undefined);
      this.router.navigate(['/']);
    } catch (e: any) {
      this.error.set(e?.error?.error ?? 'Registration failed. Please try again.');
    } finally {
      this.loading.set(false);
    }
  }

  protected async onGoogleSignUp(idToken: string): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      await this.auth.googleAuth(idToken);
      this.router.navigate(['/']);
    } catch (e: any) {
      this.error.set(e?.error?.error ?? 'Google sign up failed.');
    } finally {
      this.loading.set(false);
    }
  }
}
