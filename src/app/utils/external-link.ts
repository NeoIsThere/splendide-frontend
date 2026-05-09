declare global {
  interface Window {
    splendideDesktop?: {
      isDesktop: boolean;
      platform: string;
      openExternal(url: string): Promise<void>;
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
