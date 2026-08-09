/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */
import { config, database, logger, changePanel, gameDirectoryPath, setStatus, pkg, popup } from '../utils.js'
import '../utils/downloader-retry.js'

const { Launch } = require('minecraft-java-core')
const { shell, ipcRenderer, systemPreferences } = require('electron')
const { execFile } = require('child_process')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const fetch = require('node-fetch')
const FormData = require('form-data')

const DISCORD_CRASH_WEBHOOK_URL = process.env.DISCORD_CRASH_WEBHOOK_URL || '__BUILD_DISCORD_CRASH_WEBHOOK_URL__'
const MAX_CRASH_REPORT_CHARS = 500000
const MAX_LOG_CHARS = 160000
const MAX_PENDING_LOG_CHARS = 2000000
const NATIVE_LOG_STARTUP_GRACE_MS = 10000

class Home {
    static id = "home";

    escapeHTML(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;')
    }

    wait(ms) {
        return new Promise(resolve => setTimeout(resolve, ms))
    }

    async beginGameActivity() {
        const allowed = await ipcRenderer.invoke('game-activity-begin')
        if (!allowed) {
            new popup().openPopup({
                title: 'Action impossible',
                content: 'Le jeu est déjà actif ou son dossier est en cours de déplacement. Patientez avant de réessayer.',
                color: 'var(--color)',
                options: true
            })
            return false
        }

        document.dispatchEvent(new CustomEvent('launcher-game-activity-changed', { detail: true }))
        return true
    }

    async endGameActivity() {
        await ipcRenderer.invoke('game-activity-end')
        document.dispatchEvent(new CustomEvent('launcher-game-activity-changed', { detail: false }))
    }

    async finishGameActivity(callback) {
        try {
            await callback()
        } finally {
            await this.endGameActivity()
        }
    }

    createGameLogCapture(instancePath) {
        const logsDirectory = path.join(instancePath, 'logs')
        const latestLogPath = path.join(logsDirectory, 'latest.log')
        const initialStats = fs.existsSync(latestLogPath) ? fs.statSync(latestLogPath) : null

        return {
            logsDirectory,
            latestLogPath,
            initialMtimeMs: initialStats?.mtimeMs ?? null,
            initialSize: initialStats?.size ?? null,
            pendingOutput: '',
            fallbackActive: false,
            nativeLogActive: false,
            activationTimer: null
        }
    }

    nativeLatestLogWasUpdated(logCapture) {
        if (!fs.existsSync(logCapture.latestLogPath)) return false

        const currentStats = fs.statSync(logCapture.latestLogPath)
        if (logCapture.initialMtimeMs === null) return currentStats.size > 0

        return currentStats.mtimeMs > logCapture.initialMtimeMs
            || currentStats.size !== logCapture.initialSize
    }

    getLogArchivePath(logCapture, latestLogStats) {
        const date = latestLogStats.mtime
        const datePrefix = [
            date.getFullYear(),
            String(date.getMonth() + 1).padStart(2, '0'),
            String(date.getDate()).padStart(2, '0')
        ].join('-')

        let archiveIndex = 1
        let archivePath
        do {
            archivePath = path.join(logCapture.logsDirectory, `${datePrefix}-${archiveIndex++}.log.gz`)
        } while (fs.existsSync(archivePath))

        return archivePath
    }

    rotateFallbackLatestLog(logCapture) {
        if (!fs.existsSync(logCapture.latestLogPath)) return

        const latestLogStats = fs.statSync(logCapture.latestLogPath)
        if (latestLogStats.size === 0) {
            fs.unlinkSync(logCapture.latestLogPath)
            return
        }

        const archivePath = this.getLogArchivePath(logCapture, latestLogStats)
        const compressedLog = zlib.gzipSync(fs.readFileSync(logCapture.latestLogPath))
        fs.writeFileSync(archivePath, compressedLog)
        fs.unlinkSync(logCapture.latestLogPath)
    }

    activateFallbackGameLog(logCapture) {
        if (logCapture.fallbackActive || logCapture.nativeLogActive) return

        if (this.nativeLatestLogWasUpdated(logCapture)) {
            logCapture.nativeLogActive = true
            logCapture.pendingOutput = ''
            return
        }

        fs.mkdirSync(logCapture.logsDirectory, { recursive: true })
        this.rotateFallbackLatestLog(logCapture)

        const header = `[${new Date().toISOString()}] [Launcher/INFO]: Journal de secours activé : Minecraft n'a pas créé latest.log.\n`
        fs.writeFileSync(logCapture.latestLogPath, `${header}${logCapture.pendingOutput}`, 'utf8')
        logCapture.pendingOutput = ''
        logCapture.fallbackActive = true
    }

    appendGameLogOutput(logCapture, output) {
        if (!logCapture || logCapture.nativeLogActive) return

        const text = String(output ?? '')
        if (!text) return

        if (logCapture.fallbackActive) {
            fs.appendFileSync(logCapture.latestLogPath, text, 'utf8')
            return
        }

        if (this.nativeLatestLogWasUpdated(logCapture)) {
            logCapture.nativeLogActive = true
            logCapture.pendingOutput = ''
            if (logCapture.activationTimer) clearTimeout(logCapture.activationTimer)
            return
        }

        logCapture.pendingOutput = `${logCapture.pendingOutput}${text}`.slice(-MAX_PENDING_LOG_CHARS)
        if (!logCapture.activationTimer) {
            logCapture.activationTimer = setTimeout(
                () => this.activateFallbackGameLog(logCapture),
                NATIVE_LOG_STARTUP_GRACE_MS
            )
        }
    }

    finalizeGameLogCapture(logCapture) {
        if (!logCapture) return
        if (logCapture.activationTimer) clearTimeout(logCapture.activationTimer)

        this.activateFallbackGameLog(logCapture)
        if (logCapture.fallbackActive) {
            fs.appendFileSync(
                logCapture.latestLogPath,
                `\n[${new Date().toISOString()}] [Launcher/INFO]: Fin du processus Minecraft.\n`,
                'utf8'
            )
        }
    }

    listFiles(directoryPath, extension = '.txt') {
        if (!fs.existsSync(directoryPath)) return null

        return fs.readdirSync(directoryPath)
            .filter(fileName => fileName.toLowerCase().endsWith(extension))
            .map(fileName => {
                const filePath = path.join(directoryPath, fileName)
                const stats = fs.statSync(filePath)
                return { filePath, key: path.resolve(filePath).toLowerCase(), mtimeMs: stats.mtimeMs }
            })
    }

    getInstanceReportPaths(baseDataPath, instanceName) {
        return [
            path.join(baseDataPath, 'instances', instanceName),
            path.join(baseDataPath, instanceName)
        ]
    }

    createCrashReportSnapshot(instancePaths) {
        const snapshot = new Map()
        const files = instancePaths.flatMap(instancePath => [
            ...(this.listFiles(path.join(instancePath, 'crash-reports')) || []),
            ...[
                path.join(instancePath, 'logs', 'latest.log'),
                path.join(instancePath, 'logs', 'debug.log')
            ].filter(filePath => fs.existsSync(filePath)).map(filePath => {
                const stats = fs.statSync(filePath)
                return { filePath, key: path.resolve(filePath).toLowerCase(), mtimeMs: stats.mtimeMs }
            })
        ])

        for (const file of files) snapshot.set(file.key, file.mtimeMs)

        return snapshot
    }

    hasFileChangedSinceSnapshot(file, snapshot) {
        const previousMtime = snapshot?.get(file.key)
        return previousMtime === undefined || file.mtimeMs > previousMtime
    }

    getNewestChangedFile(directoryPath, extension = '.txt', snapshot = new Map()) {
        return (this.listFiles(directoryPath, extension) || [])
            .filter(file => this.hasFileChangedSinceSnapshot(file, snapshot))
            .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.filePath || null
    }

    getNewestChangedFileInPaths(directoryPaths, extension = '.txt', snapshot = new Map()) {
        return directoryPaths
            .flatMap(directoryPath => this.listFiles(directoryPath, extension) || [])
            .filter(file => this.hasFileChangedSinceSnapshot(file, snapshot))
            .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.filePath || null
    }

    getChangedFileInPaths(instancePaths, relativeFilePath, snapshot = new Map()) {
        const changedFiles = instancePaths
            .map(instancePath => path.join(instancePath, relativeFilePath))
            .map(filePath => {
                if (!fs.existsSync(filePath)) return null
                const stats = fs.statSync(filePath)
                return { filePath, key: path.resolve(filePath).toLowerCase(), mtimeMs: stats.mtimeMs }
            })
            .filter(Boolean)
            .filter(file => this.hasFileChangedSinceSnapshot(file, snapshot))
            .sort((a, b) => b.mtimeMs - a.mtimeMs)

        return changedFiles[0]?.filePath || null
    }

    getChangedFile(filePath, snapshot = new Map()) {
        if (!filePath || !fs.existsSync(filePath)) return null

        const stats = fs.statSync(filePath)
        const file = { filePath, key: path.resolve(filePath).toLowerCase(), mtimeMs: stats.mtimeMs }
        return this.hasFileChangedSinceSnapshot(file, snapshot) ? filePath : null
    }

    readTextFileTail(filePath, maxChars = MAX_LOG_CHARS) {
        if (!filePath || !fs.existsSync(filePath)) return null

        const stats = fs.statSync(filePath)
        const bytesToRead = Math.min(stats.size, maxChars * 2)
        const buffer = Buffer.alloc(bytesToRead)
        const fd = fs.openSync(filePath, 'r')

        try {
            fs.readSync(fd, buffer, 0, bytesToRead, Math.max(0, stats.size - bytesToRead))
            const content = buffer.toString('utf8').slice(-maxChars)
            return stats.size > bytesToRead
                ? `[Log tronqué aux ${maxChars} derniers caractères]\n${content}`
                : content
        } finally {
            fs.closeSync(fd)
        }
    }

    buildCrashReport({ exitCode, baseDataPath, instanceName, instanceFolderName, authenticator, options, crashReportSnapshot }) {
        const instancePaths = this.getInstanceReportPaths(baseDataPath, instanceFolderName)
        const newestCrashReport = this.getNewestChangedFileInPaths(
            instancePaths.map(instancePath => path.join(instancePath, 'crash-reports')),
            '.txt',
            crashReportSnapshot
        )
        const reportFiles = [
            { label: 'Crash report', filePath: newestCrashReport },
            { label: 'Latest log', filePath: this.getChangedFileInPaths(instancePaths, path.join('logs', 'latest.log'), crashReportSnapshot) },
            { label: 'Debug log', filePath: this.getChangedFileInPaths(instancePaths, path.join('logs', 'debug.log'), crashReportSnapshot) }
        ].filter(entry => entry.filePath && fs.existsSync(entry.filePath))

        const sections = [
            'The Fortress Of Thieves - rapport de crash',
            `Date: ${new Date().toISOString()}`,
            `Code de sortie: ${exitCode}`,
            `Instance: ${instanceName}`,
            `Joueur: ${authenticator?.name || 'inconnu'}`,
            `Launcher: ${pkg.name} ${pkg.version}`,
            `Plateforme: ${process.platform} ${process.arch}`,
            `Node: ${process.versions.node}`,
            `Electron: ${process.versions.electron || 'inconnu'}`,
            `Minecraft: ${options?.loadder?.minecraft_version || 'inconnu'}`,
            `Loader: ${options?.loadder?.loadder_type || 'none'} ${options?.loadder?.loadder_version || ''}`.trim(),
            `Dossiers surveillés: ${instancePaths.join(' | ')}`,
            ''
        ]

        for (const reportFile of reportFiles) {
            sections.push(`===== ${reportFile.label}: ${reportFile.filePath} =====`)
            sections.push(this.readTextFileTail(reportFile.filePath) || 'Fichier illisible.')
            sections.push('')
        }

        if (!reportFiles.length) sections.push('Aucun fichier de log ou crash-report trouvé.')

        return {
            content: sections.join('\n').slice(0, MAX_CRASH_REPORT_CHARS),
            hasReportFiles: reportFiles.length > 0,
            hasCrashReport: Boolean(newestCrashReport)
        }
    }

    async sendCrashReportToWebhook(report, { exitCode, instanceName, playerName }) {
        const safeInstanceName = String(instanceName || 'instance').replace(/[^a-z0-9._-]/gi, '_')
        const form = new FormData()
        form.append('payload_json', JSON.stringify({
            username: 'Crash Reporter',
            content: `Crash détecté sur ${instanceName || 'instance inconnue'} (code ${exitCode}) par ${playerName || 'joueur inconnu'}.`,
            allowed_mentions: { parse: [] }
        }))
        form.append('file', Buffer.from(report, 'utf8'), {
            filename: `crash-report-${safeInstanceName}-${Date.now()}.txt`,
            contentType: 'text/plain'
        })

        const response = await fetch(DISCORD_CRASH_WEBHOOK_URL, {
            method: 'POST',
            body: form,
            headers: form.getHeaders()
        })

        if (!response.ok) {
            throw new Error(`Discord a refusé le rapport (${response.status} ${response.statusText}).`)
        }
    }

    showCrashReportPopup(crashReport, crashContext) {
        const crashPopup = new popup()
        const canSendCrashReport = crashReport.hasCrashReport
        const content = canSendCrashReport
            ? `Le jeu s'est fermé d'une manière inattendue<br><br>Voulez-vous envoyer votre rapport de plantage ? Cela peut aider à corriger le soucis.`
            : `Le jeu s'est fermé d'une manière inattendue`

        crashPopup.openPopup({
            title: 'Crash du jeu',
            content,
            color: 'var(--color)',
            options: !canSendCrashReport,
            buttons: canSendCrashReport ? [
                {
                    text: 'Ignorer',
                    className: 'secondary'
                },
                {
                    text: 'Envoyer',
                    action: async () => {
                        const sendingPopup = new popup()
                        sendingPopup.openPopup({
                            title: 'Rapport de crash',
                            content: 'Envoi du rapport en cours...',
                            color: 'var(--color)'
                        })

                        try {
                            await this.sendCrashReportToWebhook(crashReport.content, crashContext)
                            sendingPopup.openPopup({
                                title: 'Rapport envoyé',
                                content: 'Merci, le rapport de crash a bien été transmis.',
                                color: 'var(--color)',
                                options: true
                            })
                        } catch (error) {
                            sendingPopup.openPopup({
                                title: 'Envoi impossible',
                                content: this.escapeHTML(error?.message || 'Une erreur inconnue est survenue.'),
                                color: 'red',
                                options: true
                            })
                            console.error('[Crash Report] Failed to send crash report:', error)
                        }
                    }
                }
            ] : []
        })
    }

    isMissingRuntimeDependency(error) {
        const errorPayload = [
            error?.friendlyMessage,
            error?.error,
            error?.message,
            error?.details
        ].filter(Boolean).join(' ')

        return /(?:NoClassDefFoundError|ClassNotFoundException):\s*org(?:\.|\/)lwjgl/i.test(errorPayload)
    }

    async repairCorruptedRuntimeFiles(basePath) {
        const candidatePaths = [
            path.join(basePath, 'libraries', 'org', 'lwjgl')
        ]

        const deletedPaths = []
        for (const candidatePath of candidatePaths) {
            if (!fs.existsSync(candidatePath)) continue
            await fs.promises.rm(candidatePath, { recursive: true, force: true })
            deletedPaths.push(candidatePath)
        }

        return {
            repaired: deletedPaths.length > 0,
            deletedPaths,
            runtimePath: basePath
        }
    }

    getHiddenEntries(options) {
        const hiddenEntries = options?.hidden ?? options?.hiddenPaths ?? options?.hiddenFiles ?? options?.hide

        if (!Array.isArray(hiddenEntries)) return []

        return hiddenEntries
            .map(entry => typeof entry === 'string' ? entry : entry?.path)
            .filter(entry => typeof entry === 'string' && entry.trim())
    }

    resolveInstanceRelativePath(instanceBasePath, relativePath) {
        const normalizedRelativePath = relativePath.replace(/\\/g, '/').replace(/^\/+/, '')

        if (
            path.isAbsolute(normalizedRelativePath) ||
            normalizedRelativePath === '..' ||
            normalizedRelativePath.startsWith('../') ||
            normalizedRelativePath.includes('/../')
        ) {
            return null
        }

        const resolvedBasePath = path.resolve(instanceBasePath)
        const resolvedTargetPath = path.resolve(resolvedBasePath, normalizedRelativePath)
        const relativeFromBase = path.relative(resolvedBasePath, resolvedTargetPath)

        if (relativeFromBase.startsWith('..') || path.isAbsolute(relativeFromBase)) return null

        return resolvedTargetPath
    }

    setWindowsHiddenAttribute(targetPath) {
        return new Promise(resolve => {
            execFile('attrib', ['+H', targetPath], { windowsHide: true }, error => {
                if (error) console.warn('[Hidden Files] Impossible de cacher le chemin:', targetPath, error)
                resolve(!error)
            })
        })
    }

    async applyHiddenAttributes(baseDataPath, instanceName, hiddenEntries) {
        if (process.platform !== 'win32' || !Array.isArray(hiddenEntries) || hiddenEntries.length === 0) return

        const instanceBasePaths = [
            path.join(baseDataPath, 'instances', instanceName),
            path.join(baseDataPath, instanceName)
        ]

        for (const hiddenEntry of hiddenEntries) {
            for (const instanceBasePath of instanceBasePaths) {
                const targetPath = this.resolveInstanceRelativePath(instanceBasePath, hiddenEntry)
                if (!targetPath || !fs.existsSync(targetPath)) continue

                await this.setWindowsHiddenAttribute(targetPath)
            }
        }
    }

    async init(config) {
        this.config = config;
        this.db = new database();
        this.news()
        this.socialLick()
        this.instancesSelect()
        document.querySelector('.settings-btn').addEventListener('click', e => changePanel('settings'))
    }

    async ensureMicrophoneAccessForMac() {
        if (process.platform !== 'darwin') return true

        const currentStatus = await ipcRenderer.invoke('macos-microphone-access-status')
        if (currentStatus === 'granted') return true

        const granted = await ipcRenderer.invoke('macos-request-microphone-access')
        if (!granted) {
            alert("Le microphone est requis pour le chat vocal. Autorisez l'accès au microphone dans Réglages Système > Confidentialité et sécurité > Microphone, puis relancez le jeu.")
            return false
        }

        return true
    }

    async news() {
        let newsElement = document.querySelector('.news-list');
        let news = await config.getNews().then(res => res).catch(err => false);
        if (news) {
            if (!news.length) {
                let blockNews = document.createElement('div');
                blockNews.classList.add('news-block');
                blockNews.innerHTML = `
                    <div class="news-header">
                        <div class="header-text">
                            <div class="title">Aucun news n'ai actuellement disponible.</div>
                        </div>
                        <div class="date">
                            <div class="day">1</div>
                            <div class="month">Janvier</div>
                        </div>
                    </div>
                    <div class="news-content">
                        <div class="bbWrapper">
                            <p>Vous pourrez suivre ici toutes les news relative au serveur.</p>
                        </div>
                    </div>`
                newsElement.appendChild(blockNews);
            } else {
                for (let News of news) {
                    let date = this.getdate(News.publish_date)
                    let blockNews = document.createElement('div');
                    blockNews.classList.add('news-block');
                    blockNews.innerHTML = `
                        <div class="news-header">
                            <div class="header-text">
                                <div class="title">${News.title}</div>
                            </div>
                            <div class="date">
                                <div class="day">${date.day}</div>
                                <div class="month">${date.month}</div>
                                <div class="year">${date.year}</div>
                            </div>
                        </div>
                        <div class="news-content">
                            <div class="bbWrapper">
                                <p>${News.content.replace(/\n/g, '</br>')}</p>
                                <p class="news-author"></span></p>
                            </div>
                        </div>`
                    newsElement.appendChild(blockNews);
                }
            }
        } else {
            let blockNews = document.createElement('div');
            blockNews.classList.add('news-block');
            blockNews.innerHTML = `
                <div class="news-header">
                        <div class="header-text">
                            <div class="title">Error.</div>
                        </div>
                        <div class="date">
                            <div class="day">1</div>
                            <div class="month">Janvier</div>
                            <div class="year">2021</div>
                        </div>
                    </div>
                    <div class="news-content">
                        <div class="bbWrapper">
                            <p>Impossible de contacter le serveur des news.</br>Merci de vérifier votre configuration.</p>
                        </div>
                    </div>`
            newsElement.appendChild(blockNews);
        }
    }

    socialLick() {
        let socials = document.querySelectorAll('.social-block')

        socials.forEach(social => {
            social.addEventListener('click', e => {
                shell.openExternal(e.target.dataset.url)
            })
        });
    }

    async instancesSelect() {
        let configClient = await this.db.readData('configClient')
        let auth = await this.db.readData('accounts', configClient.account_selected)
        let instancesList = await config.getInstanceList()
        let instanceSelect = instancesList.find(i => i.name == configClient?.instance_selct) ? configClient?.instance_selct : null
        let noInstancePopupAccount = null

        let instanceBTN = document.querySelector('.play-instance')
        let playElements = document.querySelector('.play-elements')
        let instancePopup = document.querySelector('.instance-popup')
        let instancesListPopup = document.querySelector('.instances-List')
        let instanceCloseBTN = document.querySelector('.close-popup')
        let instanceSelector = document.querySelector('.instance-select')

        const toggleInstanceSelector = (shouldDisplay) => {
            if (!instanceSelector || !instanceBTN) return
            if (shouldDisplay) {
                instanceSelector.style.display = 'flex'
            } else {
                instanceSelector.style.display = 'none'
            }
        }

        const getAccessibleInstances = (accountName) => {
            return instancesList.filter(instance => {
                if (!instance.whitelistActive) return true
                return instance.whitelist?.includes(accountName)
            })
        }

        const selectFallbackInstance = (accessibleInstances) => {
            return accessibleInstances.find(instance => instance.whitelistActive == false) || accessibleInstances[0]
        }

        const refreshInstanceAccess = async (event) => {
            let configClient = await this.db.readData('configClient')
            let currentAuth = event?.detail || await this.db.readData('accounts', configClient.account_selected)
            let accessibleInstances = getAccessibleInstances(currentAuth?.name)

            toggleInstanceSelector(accessibleInstances.length > 1)

            let selectedInstance = instancesList.find(instance => instance.name == configClient?.instance_selct)

            if (!selectedInstance || !accessibleInstances.some(instance => instance.name == selectedInstance.name)) {
                let fallbackInstance = selectFallbackInstance(accessibleInstances)

                if (fallbackInstance) {
                    configClient.instance_selct = fallbackInstance.name
                    instanceSelect = fallbackInstance.name
                    await this.db.updateData('configClient', configClient)
                    await setStatus(fallbackInstance.status)
                } else {
                    configClient.instance_selct = null
                    instanceSelect = null
                    await this.db.updateData('configClient', configClient)
                    await setStatus(null)

                    let accountIdentifier = currentAuth?.ID || currentAuth?.name
                    if (currentAuth && (event || noInstancePopupAccount !== accountIdentifier)) {
                        noInstancePopupAccount = accountIdentifier
                        new popup().openPopup({
                            title: 'Aucune instance disponible',
                            content: `Aucune instance n'est disponible pour le compte ${currentAuth.name}.`,
                            options: true
                        })
                    }
                }
            } else {
                instanceSelect = selectedInstance.name
                await setStatus(selectedInstance.status)
                noInstancePopupAccount = null
            }

            auth = currentAuth
        }

        await refreshInstanceAccess()

        document.addEventListener('launcher-account-changed', refreshInstanceAccess)

        instancePopup.addEventListener('click', async e => {
            let configClient = await this.db.readData('configClient')

            if (e.target.classList.contains('instance-elements')) {
                let newInstanceSelect = e.target.id
                let activeInstanceSelect = document.querySelector('.active-instance')

                if (activeInstanceSelect) activeInstanceSelect.classList.toggle('active-instance');
                e.target.classList.add('active-instance');

                configClient.instance_selct = newInstanceSelect
                await this.db.updateData('configClient', configClient)
                instanceSelect = newInstanceSelect
                instancePopup.style.display = 'none'
                let instance = await config.getInstanceList()
                let options = instance.find(i => i.name == configClient.instance_selct)
                if (options) await setStatus(options.status)
            }
        })

        playElements.addEventListener('click', async e => {
            let configClient = await this.db.readData('configClient')
            instanceSelect = configClient.instance_selct
            let activeAuth = auth
            if (!activeAuth) {
                activeAuth = await this.db.readData('accounts', configClient.account_selected)
                auth = activeAuth
            }

            if (e.target.closest('.instance-select')) {
                instancesListPopup.innerHTML = ''
                for (let instance of instancesList) {
                    if (instance.whitelistActive) {
                        instance.whitelist.map(whitelist => {
                            if (whitelist == activeAuth?.name) {
                                if (instance.name == instanceSelect) {
                                    instancesListPopup.innerHTML += `<div id="${instance.name}" class="instance-elements active-instance">${instance.name}</div>`
                                } else {
                                    instancesListPopup.innerHTML += `<div id="${instance.name}" class="instance-elements">${instance.name}</div>`
                                }
                            }
                        })
                    } else {
                        if (instance.name == instanceSelect) {
                            instancesListPopup.innerHTML += `<div id="${instance.name}" class="instance-elements active-instance">${instance.name}</div>`
                        } else {
                            instancesListPopup.innerHTML += `<div id="${instance.name}" class="instance-elements">${instance.name}</div>`
                        }
                    }
                }

                instancePopup.style.display = 'flex'
            }

            if (!e.target.closest('.instance-select')) this.startGame()
        })

        instanceCloseBTN.addEventListener('click', () => instancePopup.style.display = 'none')
    }

    async startGame() {
        const microphoneGranted = await this.ensureMicrophoneAccessForMac()
        if (!microphoneGranted) return

        const activityStarted = await this.beginGameActivity()
        if (!activityStarted) return

        try {

        let launch = new Launch()
        let configClient = await this.db.readData('configClient')
        let instance = await config.getInstanceList()
        let authenticator = await this.db.readData('accounts', configClient.account_selected)
        let options = instance.find(i => i.name == configClient.instance_selct)

        if (!options) {
            let accessibleInstances = instance.filter(i => !i.whitelistActive || i.whitelist?.includes(authenticator?.name))
            let fallback = accessibleInstances.find(i => !i.whitelistActive) || accessibleInstances[0]
            configClient.instance_selct = fallback ? fallback.name : null
            await this.db.updateData('configClient', configClient)
            await setStatus(fallback ? fallback.status : null)
            if (!fallback && authenticator) {
                new popup().openPopup({
                    title: 'Aucune instance disponible',
                    content: `Aucune instance n'est disponible pour le compte ${authenticator.name}.`,
                    options: true
                })
            }
            await this.endGameActivity()
            return
        }

        let playInstanceBTN = document.querySelector('.play-instance')
        let infoStartingBOX = document.querySelector('.info-starting-game')
        let infoStarting = document.querySelector(".info-starting-game-text")
        let progressBar = document.querySelector('.progress-bar')
        let instanceSelector = document.querySelector('.instance-select')

        const baseDataPath = await gameDirectoryPath(this.config.dataDirectory, configClient)
        const hiddenEntries = this.getHiddenEntries(options)
        const instanceFolderName = options.folderName || options.name

        let opt = {
            url: options.url,
            authenticator: authenticator,
            timeout: 10000,
            path: baseDataPath,
            instance: instanceFolderName,
            version: options.loadder.minecraft_version,
            detached: configClient.launcher_config.closeLauncher == "close-all" ? false : true,
            downloadFileMultiple: configClient.launcher_config.download_multi,
            intelEnabledMac: configClient.launcher_config.intelEnabledMac,

            loader: {
                type: options.loadder.loadder_type,
                build: options.loadder.loadder_version,
                enable: options.loadder.loadder_type == 'none' ? false : true
            },

            verify: options.verify,

            ignored: [...options.ignored],

            hidden: hiddenEntries,

            java: {
                path: configClient.java_config.java_path || null,
                version: 21,
                type: 'jre'
            },

            screen: {
                width: configClient.game_config.screen_size.width,
                height: configClient.game_config.screen_size.height
            },

            memory: {
                min: `${configClient.java_config.java_memory.min * 1024}M`,
                max: `${configClient.java_config.java_memory.max * 1024}M`
            },

            JVM_ARGS: [
                //'-Dio.netty.maxDirectMemory=0', Retiré pour l'ajoute de ZGC
                //'-XX:+UseG1GC', Retiré pour l'ajoute de ZGC
                //'-XX:+ParallelRefProcEnabled', Retiré pour l'ajoute de ZGC
                ///'-XX:MaxGCPauseMillis=100', Retiré pour l'ajoute de ZGC
                //'-XX:+UnlockExperimentalVMOptions', Retiré pour l'ajoute de ZGC
                '-XX:+DisableExplicitGC',
                //'-XX:G1NewSizePercent=20', Retiré pour l'ajoute de ZGC
                //'-XX:G1MaxNewSizePercent=60', Retiré pour l'ajoute de ZGC
                //'-XX:G1HeapRegionSize=8M', Retiré pour l'ajoute de ZGC
                //'-XX:G1ReservePercent=20', Retiré pour l'ajoute de ZGC
                //'-XX:InitiatingHeapOccupancyPercent=15', Retiré pour l'ajoute de ZGC
                '-XX:+AlwaysPreTouch',
                //'-XX:+PerfDisableSharedMem', Retiré pour l'ajoute de ZGC
                //'-XX:+UseStringDeduplication', Retiré pour l'ajoute de ZGC
                '-XX:+UseZGC', // Ajouté pour la v3 de Distant Horizon
                '-XX:+ZGenerational' // Ajouté pour la v3 de Distant Horizon
            ]
        }
        const crashReportSnapshot = this.createCrashReportSnapshot(this.getInstanceReportPaths(baseDataPath, instanceFolderName))
        const instancePath = path.join(baseDataPath, 'instances', instanceFolderName)
        const gameLogCapture = this.createGameLogCapture(instancePath)
        let launchOutput = ''
        await this.applyHiddenAttributes(baseDataPath, instanceFolderName, hiddenEntries)

        playInstanceBTN.style.display = "none"
        if (instanceSelector) instanceSelector.style.display = 'none'
        infoStartingBOX.style.display = "block"
        progressBar.style.display = "";
        ipcRenderer.send('main-window-progress-load')

        launch.on('extract', extract => {
            ipcRenderer.send('main-window-progress-load')
            console.log(extract);
        });

        launch.on('progress', (progress, size) => {
            infoStarting.innerHTML = `Téléchargement ${((progress / size) * 100).toFixed(0)}%`
            ipcRenderer.send('main-window-progress', { progress, size })
            progressBar.value = progress;
            progressBar.max = size;
        });

        launch.on('check', (progress, size) => {
            infoStarting.innerHTML = `Vérification ${((progress / size) * 100).toFixed(0)}%`
            ipcRenderer.send('main-window-progress', { progress, size })
            progressBar.value = progress;
            progressBar.max = size;
        });

        launch.on('estimated', (time) => {
            let hours = Math.floor(time / 3600);
            let minutes = Math.floor((time - hours * 3600) / 60);
            let seconds = Math.floor(time - hours * 3600 - minutes * 60);
            console.log(`${hours}h ${minutes}m ${seconds}s`);
        })

        launch.on('speed', (speed) => {
            console.log(`${(speed / 1067008).toFixed(2)} Mb/s`)
        })

        launch.on('patch', patch => {
            console.log(patch);
            ipcRenderer.send('main-window-progress-load')
            infoStarting.innerHTML = `Finition de la proue`
        });

        let hiddenAttributesAppliedAfterDownload = false
        launch.on('data', (e) => {
            launchOutput = `${launchOutput}${String(e ?? '')}`.slice(-MAX_LOG_CHARS)
            try {
                this.appendGameLogOutput(gameLogCapture, e)
            } catch (logError) {
                console.error('[Game Logs] Impossible d’écrire la sortie Minecraft :', logError)
            }

            if (!hiddenAttributesAppliedAfterDownload) {
                hiddenAttributesAppliedAfterDownload = true
                this.applyHiddenAttributes(baseDataPath, instanceFolderName, hiddenEntries)
            }

            progressBar.style.display = "none"
            if (configClient.launcher_config.closeLauncher == 'close-launcher') {
                ipcRenderer.send("main-window-hide")
            };
            new logger('Minecraft', '#36b030');
            ipcRenderer.send('main-window-progress-load')
            infoStarting.innerHTML = `Ancre levée !`
            console.log(e);
        })

        launch.on('close', async code => this.finishGameActivity(async () => {
            try {
                this.finalizeGameLogCapture(gameLogCapture)
            } catch (logError) {
                console.error('[Game Logs] Impossible de finaliser le journal Minecraft :', logError)
            }

            if (configClient.launcher_config.closeLauncher == 'close-launcher') {
                ipcRenderer.send("main-window-show")
            };
            ipcRenderer.send('main-window-progress-reset')
            infoStartingBOX.style.display = "none"
            playInstanceBTN.style.display = "flex"
            if (instanceSelector) instanceSelector.style.display = 'flex'
            infoStarting.innerHTML = `Vérification`
            new logger(pkg.name, '#7289da');
            console.log('Close');

            await this.wait(750)
            const crashReport = this.buildCrashReport({
                exitCode: code,
                baseDataPath,
                instanceName: options.name,
                instanceFolderName,
                authenticator,
                options,
                crashReportSnapshot
            })

            if (this.isMissingRuntimeDependency({ message: launchOutput })) {
                try {
                    const repair = await this.repairCorruptedRuntimeFiles(baseDataPath)
                    new popup().openPopup({
                        title: 'Dépendances du jeu réparées',
                        content: repair.repaired
                            ? `Une bibliothèque graphique LWJGL était manquante ou incomplète. Relancez le jeu pour la retélécharger.`
                            : `Une bibliothèque graphique LWJGL est manquante. Relancez le jeu pour lancer une nouvelle vérification.`,
                        color: 'var(--color)',
                        options: true
                    })
                    console.warn('[Repair] Missing LWJGL dependency detected after Minecraft closed:', repair.deletedPaths)
                } catch (repairError) {
                    console.error('[Repair] Failed to remove corrupted LWJGL files:', repairError)
                    this.showCrashReportPopup(crashReport, {
                        exitCode: code,
                        instanceName: options.name,
                        playerName: authenticator?.name
                    })
                }
            } else if (crashReport.hasCrashReport) {
                this.showCrashReportPopup(crashReport, {
                    exitCode: code,
                    instanceName: options.name,
                    playerName: authenticator?.name
                })
            }
        }));

        launch.on('error', async err => this.finishGameActivity(async () => {
            try {
                this.finalizeGameLogCapture(gameLogCapture)
            } catch (logError) {
                console.error('[Game Logs] Impossible de finaliser le journal Minecraft :', logError)
            }

            const canRepairRuntime = this.isMissingRuntimeDependency(err)
            if (canRepairRuntime) {
                try {
                    const result = await this.repairCorruptedRuntimeFiles(baseDataPath)
                    if (result.repaired) {
                        new popup().openPopup({
                            title: 'Réparation appliquée',
                            content: `Des fichiers critiques ont été réparés (${result.deletedPaths.length}). Relancez le jeu pour retélécharger les dépendances manquantes.`,
                            color: 'var(--color)',
                            options: true
                        })
                        console.warn('[Repair] Missing LWJGL dependency detected. Removed runtime folders:', result.deletedPaths)
                    }
                } catch (repairError) {
                    console.error('[Repair] Failed to remove corrupted runtime folders:', repairError)
                }
            }

            let popupError = new popup()

            const userFacingMessage = err?.friendlyMessage || err?.error || err?.message || 'Une erreur inconnue est survenue.'
            const extraDetails = []

            if (err?.details && err.details !== userFacingMessage) {
                extraDetails.push(err.details)
            } else if (err?.message && err.message !== userFacingMessage) {
                extraDetails.push(err.message)
            }

            if (err?.file) {
                extraDetails.push(`Fichier : ${err.file}`)
            }

            const formattedDetails = extraDetails
                .filter(Boolean)
                .map(detail => `<br><small>${this.escapeHTML(detail)}</small>`)
                .join('')

            popupError.openPopup({
                title: 'Erreur',
                content: `${this.escapeHTML(userFacingMessage)}${formattedDetails}`,
                color: 'red',
                options: true
            })

            if (configClient.launcher_config.closeLauncher == 'close-launcher') {
                ipcRenderer.send("main-window-show")
            };
            ipcRenderer.send('main-window-progress-reset')
            infoStartingBOX.style.display = "none"
            playInstanceBTN.style.display = "flex"
            if (instanceSelector) instanceSelector.style.display = 'flex'
            infoStarting.innerHTML = `Vérification`
            new logger(pkg.name, '#7289da');
            console.error(err);
        }));

        launch.Launch(opt);
        } catch (error) {
            await this.endGameActivity()
            console.error('[Launcher] Impossible de préparer le démarrage du jeu :', error)
            new popup().openPopup({
                title: 'Erreur',
                content: this.escapeHTML(error?.message || 'Impossible de préparer le démarrage du jeu.'),
                color: 'red',
                options: true
            })
        }
    }

    getdate(e) {
        let date = new Date(e)
        let year = date.getFullYear()
        let month = date.getMonth() + 1
        let day = date.getDate()
        let allMonth = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']
        return { year: year, month: allMonth[month - 1], day: day }
    }

}
export default Home;
