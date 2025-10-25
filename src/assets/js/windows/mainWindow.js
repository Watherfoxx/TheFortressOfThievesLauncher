/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */

const { app, BrowserWindow, Menu, screen } = require("electron");
const path = require("path");
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
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.workAreaSize;
    const targetWidth = Math.max(720, Math.round(width * 0.5));
    const targetHeight = Math.max(480, Math.round(height * 0.5));
    const initialWidth = Math.min(width, targetWidth);
    const initialHeight = Math.min(height, targetHeight);
    const minWidth = Math.min(initialWidth, Math.max(600, Math.round(width * 0.35)));
    const minHeight = Math.min(initialHeight, Math.max(420, Math.round(height * 0.35)));

    mainWindow = new BrowserWindow({
        title: pkg.preductname,
        width: initialWidth,
        height: initialHeight,
        minWidth,
        minHeight,
        resizable: true,
        icon: `./src/assets/images/icon.${os.platform() === "win32" ? "ico" : "png"}`,
        frame: false,
        show: false,
        webPreferences: {
            contextIsolation: false,
            nodeIntegration: true
        },
    });
    Menu.setApplicationMenu(null);
    mainWindow.setMenuBarVisibility(false);
    mainWindow.loadFile(path.join(`${app.getAppPath()}/src/launcher.html`));
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