declare global {
  type DesktopGoogleOAuthResult = {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  };

  interface Window {
    splendideDesktop?: {
      isDesktop: boolean;
      openExternal(url: string): Promise<void>;
      startGoogleOAuth(clientId: string): Promise<DesktopGoogleOAuthResult>;
    };
  }
}

import { Browser } from '@capacitor/browser';
import { environment } from '../../environments/environment';

export async function openExternalUrl(url: string): Promise<boolean> {
  if (environment.isMobile) {
    await Browser.open({ url });
    return true;
  }
  if (window.splendideDesktop?.isDesktop) {
    await window.splendideDesktop.openExternal(url);
    return true;
  }

  window.location.href = url;
  return false;
}
