import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withHashLocation } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { routes } from './app.routes';
import { authInterceptor } from './interceptors/auth.interceptor';
import { environment } from '../environments/environment';
import { providePostHogErrorHandler } from './posthog-error-handler';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    providePostHogErrorHandler(),
    provideRouter(routes, ...((environment.isElectron || environment.isMobile) ? [withHashLocation()] : [])),
    provideHttpClient(withInterceptors([authInterceptor])),
  ]
};
