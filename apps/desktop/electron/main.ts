import { app, BrowserWindow, ipcMain, screen } from "electron";
import * as path from "path";

let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "LiveSub AI",
    backgroundColor: "#0d0e12",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Load Next.js dev server or production export
  const isDev = process.env.NODE_ENV !== "production";
  if (isDev) {
    mainWindow.loadURL("http://localhost:4000");
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/out/index.html"));
  }

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    if (overlayWindow) {
      overlayWindow.close();
    }
  });
}

function createOverlayWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;

  overlayWindow = new BrowserWindow({
    width: Math.min(width, 1000),
    height: 150,
    x: Math.floor((width - Math.min(width, 1000)) / 2),
    y: height - 180, // Positioned near bottom of screen
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const isDev = process.env.NODE_ENV !== "production";
  if (isDev) {
    overlayWindow.loadURL("http://localhost:4000/overlay");
  } else {
    overlayWindow.loadFile(path.join(__dirname, "../renderer/out/overlay.html"));
  }

  // Allow click-through
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });

  overlayWindow.on("closed", () => {
    overlayWindow = null;
  });
}

app.whenReady().then(() => {
  createMainWindow();
  createOverlayWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// IPC communication channel to toggle and update subtitles
ipcMain.on("toggle-overlay", (event, visible: boolean) => {
  if (!overlayWindow) {
    createOverlayWindow();
  }

  if (visible) {
    overlayWindow?.showInactive();
  } else {
    overlayWindow?.hide();
  }
});

ipcMain.on("update-subtitles", (event, data: any) => {
  // Broadcast subtitles to overlay window
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send("subtitles-data", data);
  }
});
