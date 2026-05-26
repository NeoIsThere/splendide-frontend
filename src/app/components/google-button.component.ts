import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  NgZone,
  inject,
  output,
  viewChild,
} from '@angular/core';
import { environment } from '../../environments/environment';

declare const google: any;

const GOOGLE_SCRIPT_SRC = 'https://accounts.google.com/gsi/client';
let googleScriptLoad: Promise<void> | null = null;

function loadGoogleScript(): Promise<void> {
  if (typeof google !== 'undefined') {
    return Promise.resolve();
  }

  googleScriptLoad ??= new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GOOGLE_SCRIPT_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('google sign-in failed to load.')), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = GOOGLE_SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('google sign-in failed to load.'));
    document.head.appendChild(script);
  });

  return googleScriptLoad;
}

@Component({
  selector: 'app-google-button',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (isElectron) {
      <button class="google-native-btn" type="button" (click)="desktopSignIn.emit()">
        <span class="google-mark" aria-hidden="true">g</span>
        continue with google
      </button>
    } @else {
      <div class="google-btn-wrapper">
        <div #googleBtn></div>
      </div>
    }
  `,
  styles: `
    .google-btn-wrapper {
      display: flex;
      justify-content: center;
      margin: 4px 0;
    }
    .google-native-btn {
      width: 300px;
      min-height: 42px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      margin: 4px auto;
      padding: 9px 12px;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--card);
      color: var(--text);
      font: inherit;
      font-size: 0.875rem;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.2s, border-color 0.2s;
    }
    .google-native-btn:hover {
      background: var(--hover);
    }
    .google-native-btn:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .google-mark {
      width: 18px;
      height: 18px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
    }
  `,
})
export class GoogleButtonComponent implements AfterViewInit {
  private readonly zone = inject(NgZone);
  private readonly buttonEl = viewChild.required<ElementRef<HTMLElement>>('googleBtn');
  protected readonly isElectron = environment.isElectron;

  readonly credentialResponse = output<string>();
  readonly desktopSignIn = output<void>();

  ngAfterViewInit(): void {
    if (environment.isElectron) return;
    void this.renderGoogleButton().catch(() => undefined);
  }

  private async renderGoogleButton(): Promise<void> {
    await loadGoogleScript();
    if (typeof google === 'undefined') return;

    google.accounts.id.initialize({
      client_id: environment.googleClientId,
      callback: (response: { credential: string }) => {
        this.zone.run(() => this.credentialResponse.emit(response.credential));
      },
    });

    google.accounts.id.renderButton(this.buttonEl().nativeElement, {
      theme: 'outline',
      size: 'large',
      width: 300,
      text: 'continue_with',
    });
  }
}
