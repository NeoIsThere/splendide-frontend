import { HttpInterceptorFn, HttpRequest, HttpHandlerFn, HttpErrorResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, finalize, from, Observable, shareReplay, switchMap, throwError } from 'rxjs';
import { AuthService } from '../services/auth.service';
import { environment } from '../../environments/environment';

let refreshToken$: Observable<string> | null = null;
const DATA_MODEL_PARAM = 'dataModel';
const DATA_MODEL_VERSION = 'single-list-v3';

export const authInterceptor: HttpInterceptorFn = (req: HttpRequest<unknown>, next: HttpHandlerFn) => {
  const auth = inject(AuthService);
  const token = auth.getToken();

  let authReq = withDataModelVersion(req);
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
          catchError((refreshError: unknown) => {
            if (isRejectedRefreshCredential(refreshError)) {
              auth.expireSession();
            }
            // A network interruption or backend 5xx must not destroy a valid
            // long-lived session. The next protected request can refresh again.
            return throwError(() => error);
          }),
          switchMap((newToken) => {
            const retryReq = withDataModelVersion(originalReq.clone({
              setHeaders: {
                Authorization: `Bearer ${newToken}`,
                ...(environment.isMobile ? { 'X-Splendide-Client': 'mobile' } : {}),
              },
            }));
            return next(retryReq);
          }),
        );
      }
      return throwError(() => error);
    }),
  );
}

function withDataModelVersion(request: HttpRequest<unknown>): HttpRequest<unknown> {
  if (!request.url.includes('/sections')) return request;
  return request.clone({
    params: request.params.set(DATA_MODEL_PARAM, DATA_MODEL_VERSION),
  });
}

function refreshAccessToken(auth: AuthService): Observable<string> {
  refreshToken$ ??= from(auth.refreshToken()).pipe(
    finalize(() => {
      refreshToken$ = null;
    }),
    shareReplay({ bufferSize: 1, refCount: false }),
  );

  return refreshToken$;
}

function isRejectedRefreshCredential(error: unknown): boolean {
  return error instanceof HttpErrorResponse &&
    (error.status === 400 || error.status === 401 || error.status === 403);
}
