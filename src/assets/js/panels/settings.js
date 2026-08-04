/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */

import { changePanel, accountSelect, database, Slider, config, setStatus, popup, defaultGameDirectoryPath, gameDirectoryPath } from '../utils.js'
const { ipcRenderer } = require('electron');
const os = require('os');
const path = require('path');

class Settings {
    static id = "settings";
    async init(config) {
        this.config = config;
        this.db = new database();
        this.navBTN()
        this.accounts()
        this.ram()
        this.javaPath()
        this.resolution()
        this.launcher()
        this.gameDirectory()
    }

    escapeHTML(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;')
    }

    formatBytes(bytes) {
        if (!Number.isFinite(bytes) || bytes <= 0) return '0 octet'
        const units = ['octets', 'Ko', 'Mo', 'Go', 'To']
        const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
        const value = bytes / (1024 ** unitIndex)
        return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
    }

    samePath(firstPath, secondPath) {
        const first = path.resolve(firstPath)
        const second = path.resolve(secondPath)
        return process.platform === 'win32'
            ? first.toLowerCase() === second.toLowerCase()
            : first === second
    }

    navBTN() {
        document.querySelector('.nav-box').addEventListener('click', e => {
            if (e.target.classList.contains('nav-settings-btn')) {
                let id = e.target.id

                let activeSettingsBTN = document.querySelector('.active-settings-BTN')
                let activeContainerSettings = document.querySelector('.active-container-settings')

                if (id == 'save') {
                    if (activeSettingsBTN) activeSettingsBTN.classList.toggle('active-settings-BTN');
                    document.querySelector('#account').classList.add('active-settings-BTN');

                    if (activeContainerSettings) activeContainerSettings.classList.toggle('active-container-settings');
                    document.querySelector(`#account-tab`).classList.add('active-container-settings');
                    return changePanel('home')
                }

                if (activeSettingsBTN) activeSettingsBTN.classList.toggle('active-settings-BTN');
                e.target.classList.add('active-settings-BTN');

                if (activeContainerSettings) activeContainerSettings.classList.toggle('active-container-settings');
                document.querySelector(`#${id}-tab`).classList.add('active-container-settings');
            }
        })
    }

    accounts() {
        document.querySelector('.accounts-list').addEventListener('click', async e => {
            try {
                const deleteButton = e.target.closest('.delete-profile');
                if (deleteButton) {
                    const popupAccount = new popup();
                    popupAccount.openPopup({
                        title: 'Connexion',
                        content: 'Veuillez patienter...',
                        color: 'var(--color)'
                    })

                    const id = deleteButton.id;
                    await this.db.deleteData('accounts', id);
                    let deleteProfile = document.getElementById(`${id}`);
                    let accountListElement = document.querySelector('.accounts-list');
                    if (deleteProfile) accountListElement.removeChild(deleteProfile);

                    if (accountListElement.children.length == 1) {
                        popupAccount.closePopup();
                        return changePanel('login');
                    }

                    let configClient = await this.db.readData('configClient');

                    if (configClient.account_selected == id) {
                        let allAccounts = await this.db.readAllData('accounts');
                        let firstAccount = allAccounts[0];

                        if (firstAccount) {
                            configClient.account_selected = firstAccount.ID
                            await accountSelect(firstAccount);
                            let newInstanceSelect = await this.setInstance(firstAccount);
                            configClient.instance_selct = newInstanceSelect.instance_selct
                            await this.db.updateData('configClient', configClient);
                        }
                    }

                    return popupAccount.closePopup();
                }

                const accountElement = e.target.closest('.account');
                if (!accountElement) return;

                const id = accountElement.id;
                const popupAccount = new popup();
                popupAccount.openPopup({
                    title: 'Connexion',
                    content: 'Veuillez patienter...',
                    color: 'var(--color)'
                })

                if (id == 'add') {
                    let allAccounts = await this.db.readAllData('accounts')
                    let cancelButton = document.querySelector('.cancel-home')
                    if (cancelButton) cancelButton.style.display = allAccounts.length > 0 ? 'inline' : 'none'
                    let cancelOfflineButton = document.querySelector('.cancel-offline')
                    if (cancelOfflineButton) cancelOfflineButton.style.display = allAccounts.length > 0 ? 'inline' : 'none'
                    popupAccount.closePopup();
                    return changePanel('login')
                }

                let account = await this.db.readData('accounts', id);
                if (!account) {
                    popupAccount.closePopup();
                    return;
                }

                let configClient = await this.setInstance(account);
                await accountSelect(account);
                configClient.account_selected = account.ID;
                await this.db.updateData('configClient', configClient);
                popupAccount.closePopup();
            } catch (err) {
                console.error(err)
            }
        })
    }

    async setInstance(auth) {
        let configClient = await this.db.readData('configClient')
        let instancesList = await config.getInstanceList()
        let accessibleInstances = instancesList.filter(instance => {
            if (!instance.whitelistActive) return true
            return instance.whitelist?.includes(auth.name)
        })
        let selectedInstance = accessibleInstances.find(instance => instance.name == configClient.instance_selct)
        let fallbackInstance = selectedInstance
            || accessibleInstances.find(instance => instance.whitelistActive == false)
            || accessibleInstances[0]

        configClient.instance_selct = fallbackInstance?.name || null
        await setStatus(fallbackInstance?.status || null)
        return configClient
    }

    async ram() {
        let config = await this.db.readData('configClient');
        let totalMem = Math.trunc(os.totalmem() / 1073741824 * 10) / 10;
        let freeMem = Math.trunc(os.freemem() / 1073741824 * 10) / 10;

        document.getElementById("total-ram").textContent = `${totalMem} Go`;
        document.getElementById("free-ram").textContent = `${freeMem} Go`;

        let sliderDiv = document.querySelector(".memory-slider");
        sliderDiv.setAttribute("max", Math.trunc((80 * totalMem) / 100));

        let ram = config?.java_config?.java_memory ? {
            ramMin: config.java_config.java_memory.min,
            ramMax: config.java_config.java_memory.max
        } : { ramMin: "1", ramMax: "2" };

        if (totalMem < ram.ramMin) {
            config.java_config.java_memory = { min: 1, max: 2 };
            this.db.updateData('configClient', config);
            ram = { ramMin: "1", ramMax: "2" }
        };

        let slider = new Slider(".memory-slider", parseFloat(ram.ramMin), parseFloat(ram.ramMax));

        let minSpan = document.querySelector(".slider-touch-left span");
        let maxSpan = document.querySelector(".slider-touch-right span");

        minSpan.setAttribute("value", `${ram.ramMin} Go`);
        maxSpan.setAttribute("value", `${ram.ramMax} Go`);

        slider.on("change", async (min, max) => {
            let config = await this.db.readData('configClient');
            minSpan.setAttribute("value", `${min} Go`);
            maxSpan.setAttribute("value", `${max} Go`);
            config.java_config.java_memory = { min: min, max: max };
            this.db.updateData('configClient', config);
        });
    }

    async javaPath() {
        let javaPathText = document.querySelector(".java-path-txt")
        let configClient = await this.db.readData('configClient')
        javaPathText.textContent = path.join(
            await gameDirectoryPath(this.config.dataDirectory, configClient),
            'runtime'
        )

        let javaPath = configClient?.java_config?.java_path || 'Utiliser la version de java fournie avec le launcher';
        let javaPathInputTxt = document.querySelector(".java-path-input-text");
        let javaPathInputFile = document.querySelector(".java-path-input-file");
        javaPathInputTxt.value = javaPath;

        document.querySelector(".java-path-set").addEventListener("click", async () => {
            javaPathInputFile.value = '';
            javaPathInputFile.click();
            await new Promise((resolve) => {
                let interval;
                interval = setInterval(() => {
                    if (javaPathInputFile.value != '') resolve(clearInterval(interval));
                }, 100);
            });

            if (javaPathInputFile.value.replace(".exe", '').endsWith("java") || javaPathInputFile.value.replace(".exe", '').endsWith("javaw")) {
                let configClient = await this.db.readData('configClient')
                let file = javaPathInputFile.files[0].path;
                javaPathInputTxt.value = file;
                configClient.java_config.java_path = file
                await this.db.updateData('configClient', configClient);
            } else alert("Le nom du fichier doit être java ou javaw");
        });

        document.querySelector(".java-path-reset").addEventListener("click", async () => {
            let configClient = await this.db.readData('configClient')
            javaPathInputTxt.value = 'Utiliser la version de java livre avec le launcher';
            configClient.java_config.java_path = null
            await this.db.updateData('configClient', configClient);
        });
    }

    async gameDirectory() {
        const pathInput = document.querySelector('.game-directory-path')
        const moveButton = document.querySelector('.game-directory-move')
        const defaultButton = document.querySelector('.game-directory-default')
        const progressBox = document.querySelector('.game-directory-progress-box')
        const progressBar = document.querySelector('.game-directory-progress')
        const statusText = document.querySelector('.game-directory-status')

        let configClient = await this.db.readData('configClient')
        let currentPath = await gameDirectoryPath(this.config.dataDirectory, configClient)
        const defaultPath = await defaultGameDirectoryPath(this.config.dataDirectory)
        let gameActive = await ipcRenderer.invoke('game-activity-state')
        let migrationActive = false

        const refreshControls = () => {
            pathInput.value = currentPath
            pathInput.title = currentPath
            moveButton.disabled = migrationActive || gameActive
            defaultButton.disabled = migrationActive || gameActive || this.samePath(currentPath, defaultPath)
        }

        const showError = error => {
            new popup().openPopup({
                title: 'Déplacement impossible',
                content: this.escapeHTML(error?.message || error || 'Une erreur inconnue est survenue.'),
                color: 'red',
                options: true
            })
        }

        const setMigrationActive = active => {
            migrationActive = active
            progressBox.hidden = !active
            refreshControls()
        }

        const rollbackMigration = async (transactionId, previousSetting, configWasUpdated) => {
            let configRestored = !configWasUpdated
            let destinationPreserved = false

            if (configWasUpdated) {
                try {
                    const latestConfig = await this.db.readData('configClient')
                    latestConfig.launcher_config.game_directory = previousSetting
                    await this.db.updateData('configClient', latestConfig)
                    configRestored = true
                } catch (restoreError) {
                    console.error('[Game Directory] Impossible de restaurer le réglage précédent :', restoreError)
                }
            }

            if (configRestored) {
                try {
                    const rollback = await ipcRenderer.invoke('game-directory-rollback', transactionId)
                    destinationPreserved = Boolean(rollback.destinationPreserved)
                } catch (rollbackError) {
                    destinationPreserved = true
                    console.error('[Game Directory] Impossible d’annuler la copie :', rollbackError)
                }
            }

            return { configRestored, destinationPreserved }
        }

        const runMigration = async (destinationPath, useDefaultPath = false) => {
            if (migrationActive || gameActive) return

            let transactionId = null
            let configWasUpdated = false
            const previousSetting = configClient?.launcher_config?.game_directory ?? null

            setMigrationActive(true)
            progressBar.value = 0
            statusText.textContent = 'Préparation de la migration…'

            try {
                const result = await ipcRenderer.invoke('game-directory-migrate', {
                    sourcePath: currentPath,
                    destinationPath
                })
                transactionId = result.transactionId

                const latestConfig = await this.db.readData('configClient')
                latestConfig.launcher_config.game_directory = useDefaultPath ? null : result.destinationPath
                await this.db.updateData('configClient', latestConfig)
                configWasUpdated = true

                const commit = await ipcRenderer.invoke('game-directory-commit', transactionId)
                transactionId = null
                configClient = latestConfig
                currentPath = result.destinationPath

                const javaPathText = document.querySelector('.java-path-txt')
                if (javaPathText) javaPathText.textContent = path.join(currentPath, 'runtime')

                document.dispatchEvent(new CustomEvent('launcher-game-directory-changed', {
                    detail: { path: currentPath }
                }))

                progressBar.value = 100
                statusText.textContent = 'Migration terminée.'
                refreshControls()

                const warning = commit.sourceRemoved
                    ? ''
                    : `<br><br>${this.escapeHTML(commit.warning)}`
                new popup().openPopup({
                    title: 'Dossier du jeu déplacé',
                    content: `Le jeu utilise maintenant :<br>${this.escapeHTML(currentPath)}${warning}`,
                    color: 'var(--color)',
                    options: true
                })
            } catch (error) {
                if (transactionId) {
                    const rollback = await rollbackMigration(transactionId, previousSetting, configWasUpdated)
                    if (!rollback.configRestored) {
                        error = new Error(
                            `${error?.message || error} Le nouvel emplacement a été conservé car le réglage précédent n’a pas pu être restauré.`
                        )
                    } else if (rollback.destinationPreserved) {
                        error = new Error(
                            `${error?.message || error} Une copie modifiée a été conservée dans ${destinationPath} pour éviter toute perte.`
                        )
                    }
                }
                statusText.textContent = 'La migration a échoué. L’ancien dossier a été conservé.'
                showError(error)
            } finally {
                setMigrationActive(false)
            }
        }

        const confirmMigration = (destinationPath, useDefaultPath = false) => {
            if (this.samePath(currentPath, destinationPath)) {
                showError('Le jeu utilise déjà cet emplacement.')
                return
            }

            new popup().openPopup({
                title: 'Déplacer le dossier du jeu',
                content: `Tout le contenu sera déplacé vers :<br>${this.escapeHTML(destinationPath)}<br><br>N’éteignez pas le launcher pendant l’opération.`,
                color: 'var(--color)',
                buttons: [
                    {
                        text: 'Déplacer',
                        action: async () => await runMigration(destinationPath, useDefaultPath)
                    },
                    { text: 'Annuler' }
                ]
            })
        }

        ipcRenderer.on('game-directory-migration-progress', (_, progress) => {
            if (!migrationActive) return
            const percentage = progress.totalBytes > 0
                ? Math.min(100, Math.round(progress.copiedBytes / progress.totalBytes * 100))
                : 100
            progressBar.value = percentage
            statusText.textContent = progress.totalFiles > 0
                ? `Copie de ${progress.copiedFiles}/${progress.totalFiles} fichiers — ${this.formatBytes(progress.copiedBytes)} / ${this.formatBytes(progress.totalBytes)}`
                : 'Création du nouvel emplacement…'
        })

        document.addEventListener('launcher-game-activity-changed', event => {
            gameActive = Boolean(event.detail)
            refreshControls()
        })

        moveButton.addEventListener('click', async () => {
            if (gameActive) return showError('Fermez le jeu avant de déplacer son dossier.')
            const selection = await ipcRenderer.invoke('game-directory-select', { currentPath })
            if (!selection.canceled) confirmMigration(selection.destinationPath, false)
        })

        defaultButton.addEventListener('click', () => {
            if (gameActive) return showError('Fermez le jeu avant de déplacer son dossier.')
            confirmMigration(defaultPath, true)
        })

        refreshControls()
    }

    async resolution() {
        let configClient = await this.db.readData('configClient')
        let resolution = configClient?.game_config?.screen_size || { width: 1920, height: 1080 };

        let width = document.querySelector(".width-size");
        let height = document.querySelector(".height-size");
        let resolutionReset = document.querySelector(".size-reset");

        width.value = resolution.width;
        height.value = resolution.height;

        width.addEventListener("change", async () => {
            let configClient = await this.db.readData('configClient')
            configClient.game_config.screen_size.width = width.value;
            await this.db.updateData('configClient', configClient);
        })

        height.addEventListener("change", async () => {
            let configClient = await this.db.readData('configClient')
            configClient.game_config.screen_size.height = height.value;
            await this.db.updateData('configClient', configClient);
        })

        resolutionReset.addEventListener("click", async () => {
            let configClient = await this.db.readData('configClient')
            configClient.game_config.screen_size = { width: '854', height: '480' };
            width.value = '854';
            height.value = '480';
            await this.db.updateData('configClient', configClient);
        })
    }

    async launcher() {
        let configClient = await this.db.readData('configClient');
        configClient.launcher_config.theme = "dark";
        await this.db.updateData('configClient', configClient);

        let maxDownloadFiles = configClient?.launcher_config?.download_multi || 5;
        let maxDownloadFilesInput = document.querySelector(".max-files");
        let maxDownloadFilesReset = document.querySelector(".max-files-reset");
        maxDownloadFilesInput.value = maxDownloadFiles;

        maxDownloadFilesInput.addEventListener("change", async () => {
            let configClient = await this.db.readData('configClient')
            configClient.launcher_config.download_multi = maxDownloadFilesInput.value;
            await this.db.updateData('configClient', configClient);
        })

        maxDownloadFilesReset.addEventListener("click", async () => {
            let configClient = await this.db.readData('configClient')
            maxDownloadFilesInput.value = 5
            configClient.launcher_config.download_multi = 5;
            await this.db.updateData('configClient', configClient);
        })

        const closeBox = document.querySelector(".close-box");
        const closeButtons = [...closeBox.querySelectorAll(".close-btn")];
        const validCloseActions = closeButtons.map(button => button.dataset.closeAction);
        const savedCloseAction = configClient?.launcher_config?.closeLauncher;
        const initialCloseAction = validCloseActions.includes(savedCloseAction)
            ? savedCloseAction
            : "close-launcher";

        const selectCloseAction = closeAction => {
            for (const button of closeButtons) {
                const selected = button.dataset.closeAction === closeAction;
                button.classList.toggle('active-close', selected);
                button.setAttribute('aria-checked', String(selected));
            }
        }

        const saveCloseAction = async button => {
            const closeAction = button.dataset.closeAction;
            if (!validCloseActions.includes(closeAction) || button.classList.contains('active-close')) return;

            const previousCloseAction = closeButtons
                .find(candidate => candidate.classList.contains('active-close'))
                ?.dataset.closeAction || initialCloseAction;

            selectCloseAction(closeAction);

            try {
                const latestConfigClient = await this.db.readData('configClient');
                latestConfigClient.launcher_config.closeLauncher = closeAction;
                await this.db.updateData('configClient', latestConfigClient);
            } catch (error) {
                selectCloseAction(previousCloseAction);
                console.error('[Settings] Impossible d’enregistrer le comportement du launcher :', error);
            }
        }

        selectCloseAction(initialCloseAction);

        closeBox.addEventListener("click", event => {
            const button = event.target.closest('.close-btn');
            if (button && closeBox.contains(button)) saveCloseAction(button);
        })

        closeBox.addEventListener("keydown", event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            const button = event.target.closest('.close-btn');
            if (!button || !closeBox.contains(button)) return;
            event.preventDefault();
            saveCloseAction(button);
        })
    }
}
export default Settings;
