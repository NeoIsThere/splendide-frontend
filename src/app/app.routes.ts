import { Routes } from '@angular/router';
import { authGuard, guestGuard } from './guards/auth.guard';
import { environment } from '../environments/environment';

const loadPaymentComponent = () => environment.isMobile
  ? import('./pages/payment/mobile-payment.component').then(component => component.MobilePaymentComponent)
  : import('./pages/payment/payment.component').then(component => component.PaymentComponent);

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./pages/home/home.component').then(m => m.HomeComponent),
  },
  {
    path: 'share/:token',
    loadComponent: () => import('./pages/home/home.component').then(m => m.HomeComponent),
  },
  {
    path: 'sign-in',
    loadComponent: () => import('./pages/sign-in/sign-in.component').then(m => m.SignInComponent),
    canActivate: [guestGuard],
  },
  {
    path: 'sign-up',
    loadComponent: () => import('./pages/sign-up/sign-up.component').then(m => m.SignUpComponent),
    canActivate: [guestGuard],
  },
  {
    path: 'forgot-password',
    loadComponent: () => import('./pages/forgot-password/forgot-password.component').then(m => m.ForgotPasswordComponent),
    canActivate: [guestGuard],
  },
  {
    path: 'reset-password',
    loadComponent: () => import('./pages/reset-password/reset-password.component').then(m => m.ResetPasswordComponent),
  },
  {
    path: 'payment',
    loadComponent: loadPaymentComponent,
    canActivate: [authGuard],
  },
  {
    path: 'payment/success',
    loadComponent: loadPaymentComponent,
    canActivate: [authGuard],
  },
  {
    path: 'payment/cancel',
    loadComponent: loadPaymentComponent,
    canActivate: [authGuard],
  },
  {
    path: 'terms',
    loadComponent: () => import('./pages/legal/terms.component').then(m => m.TermsComponent),
  },
  {
    path: 'privacy',
    loadComponent: () => import('./pages/legal/privacy.component').then(m => m.PrivacyComponent),
  },
  {
    path: 'delete-account',
    loadComponent: () => import('./pages/legal/account-deletion.component').then(m => m.AccountDeletionComponent),
  },
  {
    path: 'verify-email',
    loadComponent: () => import('./pages/verify-email/verify-email.component').then(m => m.VerifyEmailComponent),
  },
  {
    path: 'settings',
    loadComponent: () => import('./pages/settings/settings.component').then(m => m.SettingsComponent),
    canActivate: [authGuard],
  },
  {
    path: '**',
    redirectTo: '',
  },
];
