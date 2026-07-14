import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ThemeService } from './services/theme.service';
import { PremiumActivationService } from './services/premium-activation.service';
import { PosthogService } from './services/posthog.service';
import { SeoService } from './services/seo.service';
import { NativePlatformService } from './services/native-platform.service';
import { MobileNotificationsService } from './services/mobile-notifications.service';
import { MobilePurchasesService } from './services/mobile-purchases.service';

@Component({
  selector: 'app-root',
  template: `<router-outlet />`,
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet],
  host: {
    '[class.dark]': 'theme.dark()',
  },
})
export class App {
  protected readonly theme = inject(ThemeService);
  private readonly premiumActivation = inject(PremiumActivationService);
  private readonly posthog = inject(PosthogService);
  private readonly seo = inject(SeoService);
  private readonly nativePlatform = inject(NativePlatformService);
  private readonly mobileNotifications = inject(MobileNotificationsService);
  private readonly mobilePurchases = inject(MobilePurchasesService);
}
