import { HttpInterceptorFn, HttpRequest, HttpHandlerFn, HttpErrorResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, switchMap, throwError, from } from 'rxjs';
import { AuthService } from '../services/auth.service';

let isRefreshing = false;

export const authInterceptor: HttpInterceptorFn = (req: HttpRequest<unknown>, next: HttpHandlerFn) => {
  const auth = inject(AuthService);
  const token = auth.getToken();

  let authReq = req;
  if (token && !req.url.includes('/auth/refresh') && !req.url.includes('/auth/login') && !req.url.includes('/auth/register')) {
    authReq = req.clone({
      setHeaders: { Authorization: `Bearer ${token}` },
    });
  }

  // Attach CSRF token to all state-changing requests
  const MUTATING = ['POST', 'PUT', 'PATCH', 'DELETE'];
  if (MUTATING.includes(req.method.toUpperCase())) {
    const csrf = auth.getCsrfToken();
    if (csrf) {
      authReq = authReq.clone({ setHeaders: { 'x-csrf-token': csrf } });
    }
  }

  return next(authReq).pipe(
    catchError((error: HttpErrorResponse) => {
      const isPublicAuthRoute =
        req.url.includes('/auth/refresh') ||
        req.url.includes('/auth/login') ||
        req.url.includes('/auth/register') ||
        req.url.includes('/auth/google') ||
        req.url.includes('/auth/forgot-password') ||
        req.url.includes('/auth/reset-password') ||
        req.url.includes('/auth/verify-email') ||
        req.url.includes('/auth/resend-verification');

      if (error.status === 401 && !isPublicAuthRoute && !isRefreshing) {
        isRefreshing = true;
        return from(auth.refreshToken()).pipe(
          catchError(() => {
            isRefreshing = false;
            auth.logout();
            return throwError(() => error);
          }),
          switchMap((newToken) => {
            isRefreshing = false;
            if (newToken) {
              const retryReq = req.clone({
                setHeaders: { Authorization: `Bearer ${newToken}` },
              });
              return next(retryReq);
            }
            auth.logout();
            return throwError(() => error);
          }),
        );
      }
      return throwError(() => error);
    }),
  );
};
