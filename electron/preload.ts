import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('splendideDesktop', {
  isDesktop: true,
  platform: process.platform,
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
});
