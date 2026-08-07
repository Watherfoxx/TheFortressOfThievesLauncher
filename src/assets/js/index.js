/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */

const { ipcRenderer, shell } = require('electron');
const pkg = require('../package.json');
const os = require('os');
import { config } from './utils.js';
const nodeFetch = require("node-fetch");


class Splash {
    constructor() {
        this.splash = document.querySelector(".splash");
        this.splashMessage = document.querySelector(".splash-message");
        this.splashAuthor = document.querySelector(".splash-author");
        this.message = document.querySelector(".message");
        this.progress = document.querySelector(".progress");
        this.updateFlowFinished = false;
        this.maintenanceCheckStarted = false;
        document.addEventListener('DOMContentLoaded', async () => {
            document.body.className = 'dark global';
            if (process.platform == 'win32') ipcRenderer.send('update-window-progress-load')
            this.startAnimation()
        });
    }

    async startAnimation() {
        let splashes = [
            { "message": "Dressage du perroquet...", "author": "" },
            { "message": "Nettoyage des fonds marins...", "author": "" },
            { "message": "Production de grog...", "author": "" },
            { "message": "Affalage des voiles...", "author": "" }
        ];
        let splash = splashes[Math.floor(Math.random() * splashes.length)];
        this.splashMessage.textContent = splash.message;
        this.splashAuthor.children[0].textContent = "" + splash.author;
        await sleep(100);
        document.querySelector("#splash").style.display = "block";
        await sleep(500);
        this.splash.classList.add("opacity");
        await sleep(500);
        this.splash.classList.add("translate");
        this.splashMessage.classList.add("opacity");
        this.splashAuthor.classList.add("opacity");
        this.message.classList.add("opacity");
        await sleep(1000);
        this.checkUpdate();
    }

    async checkUpdate() {
        this.setStatus(`Recherche de mise à jour...`);

        ipcRenderer.on('updateAvailable', () => {
            if (this.updateFlowFinished) return;
            this.setStatus(`Mise à jour disponible !`);
            if (os.platform() == 'win32') {
                this.toggleProgress();
                ipcRenderer.send('start-update');
            }
            else this.downloadUpdate().catch(error => this.continueWithoutUpdate(error));
        })

        ipcRenderer.on('error', (event, err) => {
            if (err) this.continueWithoutUpdate(err);
        })

        ipcRenderer.on('download-progress', (event, progress) => {
            ipcRenderer.send('update-window-progress', { progress: progress.transferred, size: progress.total })
            this.setProgress(progress.transferred, progress.total);
        })

        ipcRenderer.on('update-not-available', () => {
            console.error("Mise à jour non disponible");
            this.runMaintenanceCheck();
        })

        try {
            const result = await ipcRenderer.invoke('update-app');
            if (result?.success === false) this.continueWithoutUpdate(result.error);
        } catch (error) {
            this.continueWithoutUpdate(error);
        }
    }

    continueWithoutUpdate(error) {
        if (this.updateFlowFinished) return;
        this.updateFlowFinished = true;
        console.warn("Le service de mise à jour est temporairement indisponible.", error);
        this.setStatus(`Service de mise à jour temporairement indisponible.<br>Démarrage de la version installée...`);
        setTimeout(() => this.runMaintenanceCheck(), 800);
    }

    runMaintenanceCheck() {
        if (this.maintenanceCheckStarted) return;
        this.maintenanceCheckStarted = true;
        this.updateFlowFinished = true;
        this.maintenanceCheck();
    }

    getLatestReleaseForOS(os, preferredFormat, asset) {
        return asset.filter(asset => {
            const name = asset.name.toLowerCase();
            const isOSMatch = name.includes(os);
            const isFormatMatch = name.endsWith(preferredFormat);
            return isOSMatch && isFormatMatch;
        }).sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
    }

    async downloadUpdate() {
        const repoURL = pkg.repository.url.replace("git+", "").replace(".git", "").replace("https://github.com/", "").split("/");
        const response = await nodeFetch(`https://api.github.com/repos/${repoURL[0]}/${repoURL[1]}/releases`, {
            headers: { 'User-Agent': pkg.name }
        });
        if (!response.ok) throw new Error(`GitHub a répondu avec le statut ${response.status}`);

        const releases = await response.json();
        const latestRelease = releases.find(release => !release.draft)?.assets;
        if (!latestRelease) throw new Error("Aucune release complète n'est disponible");
        let latest;

        if (os.platform() == 'darwin') latest = this.getLatestReleaseForOS('mac', '.dmg', latestRelease);
        else if (os.platform() == 'linux') latest = this.getLatestReleaseForOS('linux', '.appimage', latestRelease);
        if (!latest) throw new Error("Aucun fichier de mise à jour compatible n'est disponible");


        this.setStatus(`Mise à jour disponible !<br><div class="download-update">Télécharger</div>`);
        document.querySelector(".download-update").addEventListener("click", async () => {
            try {
                await shell.openExternal(latest.browser_download_url);
                this.shutdown("Téléchargement en cours...");
            } catch (error) {
                this.continueWithoutUpdate(error);
            }
        });
    }


    async maintenanceCheck() {
        config.GetConfig().then(res => {
            if (res.maintenance) return this.shutdown(res.maintenance_message);
            this.startLauncher();
        }).catch(e => {
            console.error(e);
            return this.shutdown("Aucune connexion internet détectée,<br>veuillez réessayer ultérieurement.");
        })
    }

    startLauncher() {
        this.setStatus(`Démarrage du launcher`);
        ipcRenderer.send('main-window-open');
        ipcRenderer.send('update-window-close');
    }

    shutdown(text) {
        this.setStatus(`${text}<br>Arrêt dans 5s`);
        let i = 4;
        setInterval(() => {
            this.setStatus(`${text}<br>Arrêt dans ${i--}s`);
            if (i < 0) ipcRenderer.send('update-window-close');
        }, 1000);
    }

    setStatus(text) {
        this.message.innerHTML = text;
    }

    toggleProgress() {
        if (this.progress.classList.toggle("show")) this.setProgress(0, 1);
    }

    setProgress(value, max) {
        this.progress.value = value;
        this.progress.max = max;
    }
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && e.keyCode == 73 || e.keyCode == 123) {
        ipcRenderer.send("update-window-dev-tools");
    }
})
new Splash();
