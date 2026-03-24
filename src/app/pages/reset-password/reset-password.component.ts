import { ChangeDetectionStrategy, Component, inject, signal, OnInit } from '@angular/core';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { ActivatedRoute, RouterLink, Router } from '@angular/router';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-reset-password',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink],
  template: `
    <div class="auth-page">
      <div class="auth-card">
        <h1 class="auth-logo">splendide.</h1>
        <h2 class="auth-title">Reset password</h2>

        @if (success()) {
          <p class="auth-success" role="status">
            Password has been reset successfully.
          </p>
          <p class="auth-switch">
            <a routerLink="/sign-in">Sign in with your new password</a>
          </p>
        } @else {
          @if (error()) {
            <p class="auth-error" role="alert">{{ error() }}</p>
          }

          <form [formGroup]="form" (ngSubmit)="onSubmit()" class="auth-form">
            <label class="auth-label" for="password">New password</label>
            <input
              id="password"
              class="auth-input"
              type="password"
              formControlName="password"
              autocomplete="new-password"
            />

            <button class="auth-btn" type="submit" [disabled]="loading()">
              @if (loading()) { Resetting… } @else { Reset password }
            </button>
          </form>
        }
      </div>
    </div>
  `,
})
export class ResetPasswordComponent implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly fb = inject(FormBuilder);

  protected readonly error = signal('');
  protected readonly loading = signal(false);
  protected readonly success = signal(false);
  private token = '';

  protected readonly form = this.fb.nonNullable.group({
    password: ['', [Validators.required, Validators.minLength(8)]],
  });

  ngOnInit(): void {
    this.token = this.route.snapshot.queryParamMap.get('token') ?? '';
    if (!this.token) {
      this.error.set('Invalid or missing reset token.');
    }
  }

  protected async onSubmit(): Promise<void> {
    if (this.form.invalid || !this.token) return;
    this.loading.set(true);
    this.error.set('');

    try {
      await this.auth.resetPassword(this.token, this.form.getRawValue().password);
      this.success.set(true);
    } catch (e: any) {
      this.error.set(e?.error?.error ?? 'Reset failed. The link may have expired.');
    } finally {
      this.loading.set(false);
    }
  }
}
