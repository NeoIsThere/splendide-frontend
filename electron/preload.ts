import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('splendideDesktop', {
  isDesktop: true,
  platform: process.platform,
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  startGoogleOAuth: (clientId: string) => ipcRenderer.invoke('google-oauth-start', clientId),
});
