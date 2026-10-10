/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */

const { app, BrowserWindow, Menu, shell } = require("electron");
const path = require("path");
const { pathToFileURL } = require('url');
const os = require("os");
const pkg = require("../../../../package.json");
let dev = process.env.DEV_TOOL === 'open';
let mainWindow = undefined;

function getWindow() {
    return mainWindow;
}

function destroyWindow() {
    if (!mainWindow) return;
    app.quit();
    mainWindow = undefined;
}

function createWindow() {
    destroyWindow();
    mainWindow = new BrowserWindow({
        title: pkg.preductname,
        width: 1280,
        height: 720,
        minWidth: 980,
        minHeight: 552,
        resizable: true,
        icon: `./src/assets/images/icon.${os.platform() === "win32" ? "ico" : "png"}`,
        frame: false,
        show: false,
        webPreferences: {
            contextIsolation: false,
            nodeIntegration: true,
            backgroundThrottling: false
        },
    });
    Menu.setApplicationMenu(null);
    mainWindow.setMenuBarVisibility(false);
    // Resolve from this module: its root is src in dev and app in packaged builds.
    const launcherPath = path.resolve(__dirname, '../../..', 'launcher.html');
    const launcherURL = pathToFileURL(launcherPath).href;
    const openWebsite = targetURL => {
        try {
            const url = new URL(targetURL);
            if (!['https:', 'http:'].includes(url.protocol)) return;
            shell.openExternal(url.href).catch(error => console.error('[Navigation] Impossible d’ouvrir le lien :', error));
        } catch {
            // Invalid URLs must not navigate the launcher window.
        }
    };
    mainWindow.webContents.on('will-navigate', (event, targetURL) => {
        // Allow only navigation within the launcher document (including anchors).
        if (targetURL.split('#')[0] === launcherURL) return;
        event.preventDefault();
        openWebsite(targetURL);
    });
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        openWebsite(url);
        return { action: 'deny' };
    });
    mainWindow.loadFile(launcherPath);
    mainWindow.once('ready-to-show', () => {
        if (mainWindow) {
            if (dev) mainWindow.webContents.openDevTools({ mode: 'detach' })
            mainWindow.show()
        }
    });
}

module.exports = {
    getWindow,
    createWindow,
    destroyWindow,
};
