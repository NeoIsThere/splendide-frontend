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

  return send(authReq, req, next, auth);
};

function send(
  authReq: HttpRequest<unknown>,
  originalReq: HttpRequest<unknown>,
  next: HttpHandlerFn,
  auth: AuthService,
) {
  return next(authReq).pipe(
    catchError((error: HttpErrorResponse) => {
      const isPublicAuthRoute =
        originalReq.url.includes('/auth/refresh') ||
        originalReq.url.includes('/auth/login') ||
        originalReq.url.includes('/auth/register') ||
        originalReq.url.includes('/auth/google') ||
        originalReq.url.includes('/auth/forgot-password') ||
        originalReq.url.includes('/auth/reset-password') ||
        originalReq.url.includes('/auth/verify-email') ||
        originalReq.url.includes('/auth/resend-verification');

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
              const retryReq = originalReq.clone({
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
}
