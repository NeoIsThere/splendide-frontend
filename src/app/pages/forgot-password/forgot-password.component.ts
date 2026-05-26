import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-forgot-password',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink],
  template: `
    <div class="auth-page">
      <div class="auth-card">
        <h1 class="auth-logo">splendide.</h1>
        <h2 class="auth-title">forgot password</h2>

        @if (sent()) {
          <p class="auth-success" role="status">
            if an account with that email exists, a reset link has been sent. check your inbox.
          </p>
          <p class="auth-switch">
            <a routerLink="/sign-in">back to sign in</a>
          </p>
        } @else {
          @if (error()) {
            <p class="auth-error" role="alert">{{ error() }}</p>
          }

          <p class="auth-subtitle">enter your email and we'll send you a reset link.</p>

          <form [formGroup]="form" (ngSubmit)="onSubmit()" class="auth-form">
            <label class="auth-label" for="email">email</label>
            <input
              id="email"
              class="auth-input"
              type="email"
              formControlName="email"
              autocomplete="email"
            />

            <button class="auth-btn" type="submit" [disabled]="loading()">
              @if (loading()) { sending... } @else { send reset link }
            </button>
          </form>

          <p class="auth-switch">
            <a routerLink="/sign-in">back to sign in</a>
          </p>
        }
      </div>
    </div>
  `,
})
export class ForgotPasswordComponent {
  private readonly auth = inject(AuthService);
  private readonly fb = inject(FormBuilder);

  protected readonly error = signal('');
  protected readonly loading = signal(false);
  protected readonly sent = signal(false);

  protected readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
  });

  protected async onSubmit(): Promise<void> {
    if (this.form.invalid) return;
    this.loading.set(true);
    this.error.set('');

    try {
      await this.auth.forgotPassword(this.form.getRawValue().email);
      this.sent.set(true);
    } catch {
      this.error.set('something went wrong. please try again.');
    } finally {
      this.loading.set(false);
    }
  }
}
