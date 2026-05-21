declare global {
  type DesktopGoogleOAuthResult = {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  };

  interface Window {
    splendideDesktop?: {
      isDesktop: boolean;
      platform: string;
      openExternal(url: string): Promise<void>;
      startGoogleOAuth(clientId: string): Promise<DesktopGoogleOAuthResult>;
    };
  }
}

export async function openExternalUrl(url: string): Promise<boolean> {
  if (window.splendideDesktop?.isDesktop) {
    await window.splendideDesktop.openExternal(url);
    return true;
  }

  window.location.href = url;
  return false;
}
