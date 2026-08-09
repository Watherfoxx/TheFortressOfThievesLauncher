/**
 * @author Luuxis
 * @license CC-BY-NC 4.0 - https://creativecommons.org/licenses/by-nc/4.0
 */

const { app, dialog, ipcMain, nativeTheme, systemPreferences } = require('electron');
const { Microsoft } = require('minecraft-java-core');
const { autoUpdater } = require('electron-updater')

const path = require('path');
const fs = require('fs');

const UpdateWindow = require("./assets/js/windows/updateWindow.js");
const MainWindow = require("./assets/js/windows/mainWindow.js");
const { GameDirectoryMigrationManager } = require('./gameDirectory.js')
const { detectStorageMedia } = require('./storageMedia.js')

let dev = process.env.NODE_ENV === 'dev';
let gameActivityActive = false
const gameDirectoryMigration = new GameDirectoryMigrationManager()

if (dev) {
    let appPath = path.resolve('./data/Launcher').replace(/\\/g, '/');
    let appdata = path.resolve('./data').replace(/\\/g, '/');
    if (!fs.existsSync(appPath)) fs.mkdirSync(appPath, { recursive: true });
    if (!fs.existsSync(appdata)) fs.mkdirSync(appdata, { recursive: true });
    app.setPath('userData', appPath);
    app.setPath('appData', appdata)
}

if (!app.requestSingleInstanceLock()) app.quit();
else app.whenReady().then(() => {
    if (dev) return MainWindow.createWindow()
    UpdateWindow.createWindow()
});

ipcMain.on('main-window-open', () => MainWindow.createWindow())
ipcMain.on('main-window-dev-tools', () => MainWindow.getWindow().webContents.openDevTools({ mode: 'detach' }))
ipcMain.on('main-window-dev-tools-close', () => MainWindow.getWindow().webContents.closeDevTools())
ipcMain.on('main-window-close', () => MainWindow.destroyWindow())
ipcMain.on('main-window-reload', () => MainWindow.getWindow().reload())
ipcMain.on('main-window-progress', (event, options) => MainWindow.getWindow().setProgressBar(options.progress / options.size))
ipcMain.on('main-window-progress-reset', () => MainWindow.getWindow().setProgressBar(-1))
ipcMain.on('main-window-progress-load', () => MainWindow.getWindow().setProgressBar(2))
ipcMain.on('main-window-minimize', () => MainWindow.getWindow().minimize())

ipcMain.on('update-window-close', () => UpdateWindow.destroyWindow())
ipcMain.on('update-window-dev-tools', () => UpdateWindow.getWindow().webContents.openDevTools({ mode: 'detach' }))
ipcMain.on('update-window-progress', (event, options) => UpdateWindow.getWindow().setProgressBar(options.progress / options.size))
ipcMain.on('update-window-progress-reset', () => UpdateWindow.getWindow().setProgressBar(-1))
ipcMain.on('update-window-progress-load', () => UpdateWindow.getWindow().setProgressBar(2))

ipcMain.handle('path-user-data', () => app.getPath('userData'))
ipcMain.handle('appData', e => app.getPath('appData'))

ipcMain.handle('game-directory-select', async (_, { currentPath }) => {
    const selection = await dialog.showOpenDialog(MainWindow.getWindow(), {
        title: 'Choisir le nouvel emplacement du jeu',
        buttonLabel: 'Choisir cet emplacement',
        defaultPath: path.dirname(currentPath),
        properties: ['openDirectory', 'createDirectory']
    })

    if (selection.canceled || !selection.filePaths.length) return { canceled: true }

    const selectedPath = path.resolve(selection.filePaths[0])
    const gameFolderName = path.basename(currentPath)
    const destinationPath = path.basename(selectedPath).toLowerCase() === gameFolderName.toLowerCase()
        ? selectedPath
        : path.join(selectedPath, gameFolderName)

    const storage = await detectStorageMedia(selectedPath)
    return { canceled: false, destinationPath, storage }
})

ipcMain.handle('game-directory-storage-info', async (_, targetPath) => {
    return await detectStorageMedia(targetPath)
})

ipcMain.handle('game-directory-migrate', async (event, options) => {
    if (gameActivityActive) {
        throw new Error('Le jeu ou son téléchargement est actuellement en cours. Fermez-le avant de déplacer le dossier.')
    }

    const storage = await detectStorageMedia(options.destinationPath)
    if (storage.type === 'hdd') {
        const error = new Error('Cet emplacement se trouve sur un HDD. Le jeu doit être installé sur un SSD.')
        error.code = 'HDD_NOT_ALLOWED'
        throw error
    }

    return await gameDirectoryMigration.migrate(options, progress => {
        if (!event.sender.isDestroyed()) {
            event.sender.send('game-directory-migration-progress', progress)
        }
    })
})

ipcMain.handle('game-directory-commit', async (_, transactionId) => {
    return await gameDirectoryMigration.commit(transactionId)
})

ipcMain.handle('game-directory-rollback', async (_, transactionId) => {
    return await gameDirectoryMigration.rollback(transactionId)
})

ipcMain.handle('game-activity-begin', () => {
    if (gameActivityActive || gameDirectoryMigration.isBusy()) return false
    gameActivityActive = true
    return true
})

ipcMain.handle('game-activity-end', () => {
    gameActivityActive = false
    return true
})

ipcMain.handle('game-activity-state', () => gameActivityActive)

ipcMain.on('main-window-maximize', () => {
    if (MainWindow.getWindow().isMaximized()) {
        MainWindow.getWindow().unmaximize();
    } else {
        MainWindow.getWindow().maximize();
    }
})

ipcMain.on('main-window-hide', () => MainWindow.getWindow().hide())
ipcMain.on('main-window-show', () => MainWindow.getWindow().show())

ipcMain.handle('Microsoft-window', async (_, client_id) => {
    return await new Microsoft(client_id).getAuth();
})

ipcMain.handle('is-dark-theme', (_, theme) => {
    if (theme === 'dark') return true
    if (theme === 'light') return false
    return nativeTheme.shouldUseDarkColors;
})

ipcMain.handle('macos-microphone-access-status', () => {
    if (process.platform !== 'darwin') return 'granted'
    return systemPreferences.getMediaAccessStatus('microphone')
})

ipcMain.handle('macos-request-microphone-access', async () => {
    if (process.platform !== 'darwin') return true
    return await systemPreferences.askForMediaAccess('microphone')
})

app.on('window-all-closed', () => app.quit());

autoUpdater.autoDownload = false;

const serializeUpdaterError = error => ({
    message: error?.message || String(error || 'Erreur de mise à jour inconnue'),
    code: error?.code || null
});

ipcMain.handle('update-app', async () => {
    try {
        await autoUpdater.checkForUpdates();
        return { success: true };
    } catch (error) {
        console.error("Impossible de rechercher une mise à jour :", error);
        return { success: false, error: serializeUpdaterError(error) };
    }
})

autoUpdater.on('update-available', () => {
    const updateWindow = UpdateWindow.getWindow();
    if (updateWindow) updateWindow.webContents.send('updateAvailable');
});

ipcMain.on('start-update', () => {
    autoUpdater.downloadUpdate().catch(error => {
        console.error("Impossible de télécharger la mise à jour :", error);
        const updateWindow = UpdateWindow.getWindow();
        if (updateWindow) updateWindow.webContents.send('error', serializeUpdaterError(error));
    });
})

autoUpdater.on('update-not-available', () => {
    const updateWindow = UpdateWindow.getWindow();
    if (updateWindow) updateWindow.webContents.send('update-not-available');
});

autoUpdater.on('update-downloaded', () => {
    autoUpdater.quitAndInstall();
});

autoUpdater.on('download-progress', (progress) => {
    const updateWindow = UpdateWindow.getWindow();
    if (updateWindow) updateWindow.webContents.send('download-progress', progress);
})

autoUpdater.on('error', (err) => {
    const updateWindow = UpdateWindow.getWindow();
    if (updateWindow) updateWindow.webContents.send('error', serializeUpdaterError(err));
});
