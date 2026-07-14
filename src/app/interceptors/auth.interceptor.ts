import { HttpInterceptorFn, HttpRequest, HttpHandlerFn, HttpErrorResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, finalize, from, Observable, of, shareReplay, switchMap, throwError } from 'rxjs';
import { AuthService } from '../services/auth.service';
import { environment } from '../../environments/environment';

let refreshToken$: Observable<string | null> | null = null;

export const authInterceptor: HttpInterceptorFn = (req: HttpRequest<unknown>, next: HttpHandlerFn) => {
  const auth = inject(AuthService);
  const token = auth.getToken();

  let authReq = req;
  if (environment.isMobile) {
    authReq = authReq.clone({ setHeaders: { 'X-Splendide-Client': 'mobile' } });
  }
  if (token && !req.url.includes('/auth/refresh') && !req.url.includes('/auth/login') && !req.url.includes('/auth/register')) {
    authReq = authReq.clone({
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
        originalReq.url.includes('/auth/google/oauth') ||
        originalReq.url.includes('/auth/apple') ||
        originalReq.url.includes('/auth/forgot-password') ||
        originalReq.url.includes('/auth/reset-password') ||
        originalReq.url.includes('/auth/verify-email') ||
        originalReq.url.includes('/auth/resend-verification');

      if (error.status === 401 && !isPublicAuthRoute) {
        return refreshAccessToken(auth).pipe(
          catchError(() => of(null)),
          switchMap((newToken) => {
            if (newToken) {
              const retryReq = originalReq.clone({
                setHeaders: {
                  Authorization: `Bearer ${newToken}`,
                  ...(environment.isMobile ? { 'X-Splendide-Client': 'mobile' } : {}),
                },
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

function refreshAccessToken(auth: AuthService): Observable<string | null> {
  refreshToken$ ??= from(auth.refreshToken()).pipe(
    finalize(() => {
      refreshToken$ = null;
    }),
    shareReplay({ bufferSize: 1, refCount: false }),
  );

  return refreshToken$;
}
