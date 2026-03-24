import { Injectable, signal, effect, inject } from '@angular/core';
import { DOCUMENT } from '@angular/common';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly doc = inject(DOCUMENT);
  readonly dark = signal(this.loadDark());

  constructor() {
    effect(() => {
      const isDark = this.dark();
      try { localStorage.setItem('fusione_dark', JSON.stringify(isDark)); } catch {}
      this.doc.body.classList.toggle('dark', isDark);
    });
  }

  toggle(): void {
    this.dark.update(v => !v);
  }

  private loadDark(): boolean {
    try {
      const raw = localStorage.getItem('fusione_dark') ?? localStorage.getItem('chiaro_dark');
      return raw === 'true';
    } catch { return false; }
  }
}
