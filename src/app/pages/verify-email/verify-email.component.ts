import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { AuthService } from '../../services/auth.service';

type State = 'loading' | 'success' | 'invalid' | 'expired';

@Component({
  selector: 'app-verify-email',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, ReactiveFormsModule],
  template: `
    <div class="auth-page">
      <div class="auth-card">
        <h1 class="auth-logo">splendide.</h1>

        @switch (state()) {
          @case ('loading') {
            <p class="auth-loading">Verifying your email…</p>
          }

          @case ('success') {
            <h2 class="auth-title">Email verified</h2>
            <p class="verify-msg">Your account is ready. Redirecting…</p>
          }

          @case ('invalid') {
            <h2 class="auth-title">Invalid link</h2>
            <p class="verify-msg">This verification link is invalid or has already been used.</p>
            <a class="auth-btn auth-btn--block" routerLink="/sign-up">Back to sign up</a>
          }

          @case ('expired') {
            <h2 class="auth-title">Link expired</h2>
            <p class="verify-msg">Your verification link has expired. Enter your email to receive a new one.</p>

            @if (resendSuccess()) {
              <p class="verify-resend-success">A new verification link has been sent. Check your inbox.</p>
            } @else {
              <form [formGroup]="resendForm" (ngSubmit)="onResend()" class="auth-form">
                @if (resendError()) {
                  <p class="auth-error" role="alert">{{ resendError() }}</p>
                }
                <label class="auth-label" for="resend-email">Email</label>
                <input
                  id="resend-email"
                  class="auth-input"
                  type="email"
                  formControlName="email"
                  autocomplete="email"
                />
                @if (resendForm.controls.email.touched && resendForm.controls.email.errors) {
                  <p class="auth-field-error" role="alert">Enter a valid email address.</p>
                }
                <button class="auth-btn" type="submit" [disabled]="resendLoading()">
                  {{ resendLoading() ? 'Sending…' : 'Resend verification email' }}
                </button>
              </form>
            }
          }
        }
      </div>
    </div>
  `,
  styles: [`
    .verify-msg {
      font-size: 0.9rem;
      color: var(--text-muted);
      line-height: 1.5;
      margin: 0 0 24px;
      text-align: center;
    }
    .auth-btn--block {
      display: block;
      text-align: center;
      text-decoration: none;
    }
    .auth-field-error {
      font-size: 0.8rem;
      color: #e53e3e;
      margin: -6px 0 4px;
    }
    .verify-resend-success {
      font-size: 0.9rem;
      color: #2f9e44;
      text-align: center;
      line-height: 1.5;
    }
    .auth-loading {
      text-align: center;
      color: var(--text-muted);
      margin: 24px 0;
    }
  `],
})
export class VerifyEmailComponent implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly fb = inject(FormBuilder);

  protected readonly state = signal<State>('loading');
  protected readonly resendLoading = signal(false);
  protected readonly resendSuccess = signal(false);
  protected readonly resendError = signal('');

  protected readonly resendForm = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
  });

  async ngOnInit(): Promise<void> {
    const token = this.route.snapshot.queryParamMap.get('token');

    if (!token) {
      this.state.set('invalid');
      return;
    }

    try {
      await this.auth.verifyEmail(token);
      this.state.set('success');
      setTimeout(() => this.router.navigate(['/']), 1500);
    } catch (e: any) {
      const status = e?.status;
      const code = e?.error?.error;
      if (status === 410 || code === 'LINK_EXPIRED') {
        this.state.set('expired');
      } else {
        this.state.set('invalid');
      }
    }
  }

  protected async onResend(): Promise<void> {
    this.resendForm.markAllAsTouched();
    if (this.resendForm.invalid) return;
    this.resendLoading.set(true);
    this.resendError.set('');

    try {
      await this.auth.resendVerification(this.resendForm.getRawValue().email);
      this.resendSuccess.set(true);
    } catch {
      // API always returns 200 on resend — this shouldn't normally fire
      this.resendSuccess.set(true);
    } finally {
      this.resendLoading.set(false);
    }
  }
}
