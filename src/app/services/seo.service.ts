import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';

interface SeoMetadata {
  title: string;
  description: string;
  canonicalPath: string;
  robots: string;
}

const SITE_ORIGIN = 'https://splendide.app';
const SITE_NAME = 'Splendide';
const DEFAULT_TITLE = 'Splendide - Calm Now/Later Task Manager';
const DEFAULT_DESCRIPTION = 'Splendide is a calm, local-first task manager for now/later planning. Capture tasks, add subtasks, sync across devices, and share editable pages.';
const SOCIAL_DESCRIPTION = 'A calm, local-first task manager for now/later planning, subtasks, sync, and shareable pages.';
const PREVIEW_IMAGE = `${SITE_ORIGIN}/og-image.svg`;
const INDEX_ROBOTS = 'index, follow, max-image-preview:large';
const NOINDEX_ROBOTS = 'noindex, nofollow';

@Injectable({ providedIn: 'root' })
export class SeoService {
  private readonly router = inject(Router);
  private readonly title = inject(Title);
  private readonly meta = inject(Meta);
  private readonly document = inject(DOCUMENT);

  constructor() {
    this.applyForUrl(this.router.url);
    this.router.events
      .pipe(filter((event): event is NavigationEnd => event instanceof NavigationEnd))
      .subscribe((event) => this.applyForUrl(event.urlAfterRedirects));
  }

  private applyForUrl(rawUrl: string): void {
    const metadata = this.metadataForPath(this.pathOnly(rawUrl));
    const canonicalUrl = `${SITE_ORIGIN}${metadata.canonicalPath}`;

    this.title.setTitle(metadata.title);
    this.meta.updateTag({ name: 'description', content: metadata.description });
    this.meta.updateTag({ name: 'robots', content: metadata.robots });
    this.meta.updateTag({ name: 'googlebot', content: metadata.robots });
    this.meta.updateTag({ property: 'og:site_name', content: SITE_NAME });
    this.meta.updateTag({ property: 'og:type', content: 'website' });
    this.meta.updateTag({ property: 'og:title', content: metadata.title });
    this.meta.updateTag({ property: 'og:description', content: this.socialDescription(metadata) });
    this.meta.updateTag({ property: 'og:url', content: canonicalUrl });
    this.meta.updateTag({ property: 'og:image', content: PREVIEW_IMAGE });
    this.meta.updateTag({ property: 'og:image:alt', content: 'Splendide task manager preview' });
    this.meta.updateTag({ name: 'twitter:card', content: 'summary_large_image' });
    this.meta.updateTag({ name: 'twitter:title', content: metadata.title });
    this.meta.updateTag({ name: 'twitter:description', content: this.socialDescription(metadata) });
    this.meta.updateTag({ name: 'twitter:image', content: PREVIEW_IMAGE });
    this.setCanonicalUrl(canonicalUrl);
  }

  private metadataForPath(path: string): SeoMetadata {
    if (path === '/terms') {
      return {
        title: 'Terms of Use | Splendide',
        description: 'Read the Splendide Terms of Use for private task pages, synced accounts, shared pages, and Premium subscriptions.',
        canonicalPath: '/terms',
        robots: INDEX_ROBOTS,
      };
    }

    if (path === '/privacy') {
      return {
        title: 'Privacy Policy | Splendide',
        description: 'Read how Splendide handles private local task data, account sync, shared pages, analytics, and Premium billing data.',
        canonicalPath: '/privacy',
        robots: INDEX_ROBOTS,
      };
    }

    if (this.isPrivateOrUtilityPath(path)) {
      return {
        title: `${SITE_NAME} | App`,
        description: DEFAULT_DESCRIPTION,
        canonicalPath: '/',
        robots: NOINDEX_ROBOTS,
      };
    }

    return {
      title: DEFAULT_TITLE,
      description: DEFAULT_DESCRIPTION,
      canonicalPath: '/',
      robots: INDEX_ROBOTS,
    };
  }

  private isPrivateOrUtilityPath(path: string): boolean {
    return path.startsWith('/share/') ||
      path === '/sign-in' ||
      path === '/sign-up' ||
      path === '/forgot-password' ||
      path === '/reset-password' ||
      path === '/payment' ||
      path === '/payment/success' ||
      path === '/payment/cancel' ||
      path === '/settings' ||
      path === '/verify-email';
  }

  private socialDescription(metadata: SeoMetadata): string {
    return metadata.canonicalPath === '/' ? SOCIAL_DESCRIPTION : metadata.description;
  }

  private pathOnly(rawUrl: string): string {
    const [withoutQuery] = rawUrl.split('?');
    const [withoutHash] = (withoutQuery ?? rawUrl).split('#');
    const path = withoutHash && withoutHash.length > 0 ? withoutHash : '/';
    return path.endsWith('/') && path.length > 1 ? path.slice(0, -1) : path;
  }

  private setCanonicalUrl(url: string): void {
    let canonical = this.document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!canonical) {
      canonical = this.document.createElement('link');
      canonical.rel = 'canonical';
      this.document.head.appendChild(canonical);
    }
    canonical.href = url;
  }
}
