import { contextBridge, ipcRenderer } from "electron";

// Safe API exposition to Renderer process
contextBridge.exposeInMainWorld("electronAPI", {
  toggleOverlay: (visible: boolean) => {
    ipcRenderer.send("toggle-overlay", visible);
  },
  updateSubtitles: (data: any) => {
    ipcRenderer.send("update-subtitles", data);
  },
  onSubtitlesData: (callback: (data: any) => void) => {
    // Wrap handler to strip electron-specific event argument
    const subscription = (event: any, data: any) => callback(data);
    ipcRenderer.on("subtitles-data", subscription);
    
    // Return cleanup function
    return () => {
      ipcRenderer.removeListener("subtitles-data", subscription);
    };
  }
});
