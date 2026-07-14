import { Injectable, NgZone, inject } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';
import type posthog from 'posthog-js';
import type { CaptureResult, Properties } from 'posthog-js';
import { APP_VERSION, environment } from '../../environments/environment';

interface AnalyticsUser {
  id: string;
  isPremium: boolean;
  hasPassword?: boolean;
}

@Injectable({ providedIn: 'root' })
export class PosthogService {
  private readonly ngZone = inject(NgZone);
  private readonly router = inject(Router);
  private posthog: typeof posthog | null = null;
  private pendingUser: AnalyticsUser | null = null;
  private initialized = false;
  private lastTrackedPath: string | null = null;

  constructor() {
    void this.init().catch(() => {});
  }

  identifyUser(user: AnalyticsUser): void {
    this.pendingUser = user;
    if (!this.initialized) return;
    this.applyUserIdentity(user);
  }

  reset(): void {
    this.pendingUser = null;
    this.posthog?.reset();
  }

  captureException(error: unknown): void {
    if (!this.initialized || !this.posthog) return;
    this.ngZone.runOutsideAngular(() => {
      this.posthog?.captureException(error);
    });
  }

  private async init(): Promise<void> {
    const projectKey = environment.posthogKey.trim();
    const apiHost = environment.posthogHost.trim();
    if (!projectKey || !apiHost) return;

    const { default: posthogClient } = await import('posthog-js');
    this.posthog = posthogClient;

    this.ngZone.runOutsideAngular(() => {
      posthogClient.init(projectKey, {
        api_host: apiHost,
        defaults: '2026-05-30',
        autocapture: false,
        capture_pageview: false,
        capture_pageleave: false,
        capture_heatmaps: false,
        capture_dead_clicks: false,
        capture_performance: false,
        rageclick: false,
        disable_session_recording: true,
        capture_exceptions: {
          capture_unhandled_errors: true,
          capture_unhandled_rejections: true,
          capture_console_errors: false,
        },
        disable_capture_url_hashes: true,
        persistence: 'localStorage',
        person_profiles: 'identified_only',
        before_send: (event) => this.sanitizeCaptureResult(event),
        loaded: () => {
          this.initialized = true;
          if (this.pendingUser) {
            this.applyUserIdentity(this.pendingUser);
          }
          this.capturePageview(this.router.url);
        },
      });

      this.router.events
        .pipe(filter((event): event is NavigationEnd => event instanceof NavigationEnd))
        .subscribe((event) => this.capturePageview(event.urlAfterRedirects));
    });
  }

  private capturePageview(rawUrl: string): void {
    if (!this.initialized || !this.posthog) return;

    const path = this.sanitizePath(rawUrl);
    if (path === this.lastTrackedPath) return;
    this.lastTrackedPath = path;

    this.posthog.capture('$pageview', {
      $current_url: this.absoluteUrl(path),
      $pathname: path,
      app_version: APP_VERSION,
      app_shell: environment.isElectron ? 'electron' : environment.isMobile ? 'mobile' : 'web',
    });
  }

  private applyUserIdentity(user: AnalyticsUser): void {
    this.posthog?.identify(user.id, {
      is_premium: user.isPremium,
      ...(user.hasPassword !== undefined ? { has_password: user.hasPassword } : {}),
    });
  }

  private sanitizeCaptureResult(event: CaptureResult | null): CaptureResult | null {
    if (!event) return event;
    return {
      ...event,
      properties: this.sanitizeProperties(event.properties),
      ...(event.$set ? { $set: this.sanitizeProperties(event.$set) } : {}),
      ...(event.$set_once ? { $set_once: this.sanitizeProperties(event.$set_once) } : {}),
    };
  }

  private sanitizeProperties(properties: Properties): Properties {
    const sanitized: Properties = { ...properties };
    for (const [key, value] of Object.entries(sanitized)) {
      if (typeof value !== 'string') continue;
      if (this.isUrlProperty(key)) {
        sanitized[key] = this.sanitizeUrl(value);
      }
    }
    return sanitized;
  }

  private isUrlProperty(key: string): boolean {
    const normalized = key.toLowerCase();
    return normalized.includes('url') ||
      normalized.includes('href') ||
      normalized.includes('referrer') ||
      normalized === '$pathname' ||
      normalized === 'pathname';
  }

  private sanitizeUrl(rawUrl: string): string {
    try {
      const url = new URL(rawUrl, this.locationOrigin());
      return url.origin + this.sanitizePath(url.pathname);
    } catch {
      return this.sanitizePath(rawUrl);
    }
  }

  private sanitizePath(rawUrl: string): string {
    const [withoutQuery] = rawUrl.split('?');
    const [withoutHash] = (withoutQuery ?? rawUrl).split('#');
    const path = withoutHash && withoutHash.length > 0 ? withoutHash : '/';
    return path.replace(/^\/share\/[^/]+/, '/share/[token]');
  }

  private absoluteUrl(path: string): string {
    return this.locationOrigin() + path;
  }

  private locationOrigin(): string {
    return typeof window === 'undefined' ? 'https://splendide.app' : window.location.origin;
  }
}
