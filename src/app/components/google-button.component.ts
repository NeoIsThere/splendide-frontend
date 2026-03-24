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

@Component({
  selector: 'app-google-button',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="google-btn-wrapper">
      <div #googleBtn></div>
    </div>
  `,
  styles: `
    .google-btn-wrapper {
      display: flex;
      justify-content: center;
      margin: 4px 0;
    }
  `,
})
export class GoogleButtonComponent implements AfterViewInit {
  private readonly zone = inject(NgZone);
  private readonly buttonEl = viewChild.required<ElementRef<HTMLElement>>('googleBtn');

  readonly credentialResponse = output<string>();

  ngAfterViewInit(): void {
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
