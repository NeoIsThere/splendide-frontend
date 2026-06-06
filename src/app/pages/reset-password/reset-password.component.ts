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
            <input
              id="password"
              class="auth-input"
              [class.auth-input--error]="form.controls.password.invalid && form.controls.password.touched"
              type="password"
              formControlName="password"
              autocomplete="new-password"
            />
            @if (form.controls.password.touched && form.controls.password.errors?.['minlength']) {
              <p class="auth-field-error" role="alert">password must be at least 8 characters</p>
            }

            <label class="auth-label" for="confirmPassword">confirm new password</label>
            <input
              id="confirmPassword"
              class="auth-input"
              [class.auth-input--error]="form.controls.confirmPassword.touched && passwordsMismatch()"
              type="password"
              formControlName="confirmPassword"
              autocomplete="new-password"
            />
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
