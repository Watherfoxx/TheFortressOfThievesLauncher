/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */
import { config, database, logger, changePanel, appdata, setStatus, pkg, popup } from '../utils.js'
import '../utils/downloader-retry.js'

const { Launch } = require('minecraft-java-core')
const { shell, ipcRenderer } = require('electron')
const fs = require('fs')
const path = require('path')

class Home {
    static id = "home";
    async init(config) {
        this.config = config;
        this.db = new database();
        this.news()
        this.socialLick()
        this.instancesSelect()
        document.querySelector('.settings-btn').addEventListener('click', e => changePanel('settings'))
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

        let instanceBTN = document.querySelector('.play-instance')
        let instancePopup = document.querySelector('.instance-popup')
        let instancesListPopup = document.querySelector('.instances-List')
        let instanceCloseBTN = document.querySelector('.close-popup')
        let instanceSelector = document.querySelector('.instance-select')

        const toggleInstanceSelector = (shouldDisplay) => {
            if (!instanceSelector || !instanceBTN) return
            if (shouldDisplay) {
                instanceSelector.style.display = 'flex'
                instanceBTN.style.paddingRight = ''
            } else {
                instanceSelector.style.display = 'none'
                instanceBTN.style.paddingRight = '0'
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
                }
            } else {
                instanceSelect = selectedInstance.name
                await setStatus(selectedInstance.status)
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
                await setStatus(options.status)
            }
        })

        instanceBTN.addEventListener('click', async e => {
            let configClient = await this.db.readData('configClient')
            instanceSelect = configClient.instance_selct
            let activeAuth = auth
            if (!activeAuth) {
                activeAuth = await this.db.readData('accounts', configClient.account_selected)
                auth = activeAuth
            }

            if (e.target.classList.contains('instance-select')) {
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

            if (!e.target.classList.contains('instance-select')) this.startGame()
        })

        instanceCloseBTN.addEventListener('click', () => instancePopup.style.display = 'none')
    }

    async startGame() {
        let launch = new Launch()
        let configClient = await this.db.readData('configClient')
        let instance = await config.getInstanceList()
        let authenticator = await this.db.readData('accounts', configClient.account_selected)
        let options = instance.find(i => i.name == configClient.instance_selct)

        let playInstanceBTN = document.querySelector('.play-instance')
        let infoStartingBOX = document.querySelector('.info-starting-game')
        let infoStarting = document.querySelector(".info-starting-game-text")
        let progressBar = document.querySelector('.progress-bar')

        const dataDirectoryName = process.platform == 'darwin'
            ? this.config.dataDirectory
            : `.${this.config.dataDirectory}`
        const baseDataPath = path.join(await appdata(), dataDirectoryName)

        this.clearDistantHorizonsNormalizationTimer()
        this.distantHorizonsNormalizationAttempts = 0

        let opt = {
            url: options.url,
            authenticator: authenticator,
            timeout: 10000,
            path: baseDataPath,
            instance: options.name,
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

            javaPath: configClient.java_config.java_path,

            screen: {
                width: configClient.game_config.screen_size.width,
                height: configClient.game_config.screen_size.height
            },

            memory: {
                min: `${configClient.java_config.java_memory.min * 1024}M`,
                max: `${configClient.java_config.java_memory.max * 1024}M`
            },

            JVM_ARGS: [
                //`-XX:MaxDirectMemorySize=${configClient.java_config.java_memory.max * 1024 / 2}M`,
                //'-XX:MaxDirectMemorySize=6G',
                //'-XX:+PrintFlagsFinal',
                //'-Dio.netty.leakDetectionLevel=paranoid',
                '-Dio.netty.maxDirectMemory=0',
                '-XX:+UseG1GC',
                '-XX:+ParallelRefProcEnabled',
                '-XX:MaxGCPauseMillis=100',
                '-XX:+UnlockExperimentalVMOptions',
                '-XX:+DisableExplicitGC',
                '-XX:G1NewSizePercent=20',
                '-XX:G1MaxNewSizePercent=60',
                '-XX:G1HeapRegionSize=8M',
                '-XX:G1ReservePercent=20',
                '-XX:InitiatingHeapOccupancyPercent=15',
                '-XX:+AlwaysPreTouch',
                '-XX:+PerfDisableSharedMem',
                '-XX:+UseStringDeduplication'
            ]
        }


        console.log(opt);

        const normalizeDistantHorizonsData = () => {
            const normalized = this.normalizeDistantHorizonsData(baseDataPath, options.name)
            return normalized
        }

        normalizeDistantHorizonsData()

        const MAX_NORMALIZATION_ATTEMPTS = 60
        const NORMALIZATION_INTERVAL_MS = 5000

        this.distantHorizonsNormalizationTimer = setInterval(() => {
            const normalized = normalizeDistantHorizonsData()
            this.distantHorizonsNormalizationAttempts += 1

            if (normalized || this.distantHorizonsNormalizationAttempts >= MAX_NORMALIZATION_ATTEMPTS) {
                this.clearDistantHorizonsNormalizationTimer()
            }
        }, NORMALIZATION_INTERVAL_MS)

        launch.Launch(opt);

        playInstanceBTN.style.display = "none"
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

        launch.on('data', (e) => {
            if (typeof e === 'string' && e.startsWith('Launching with arguments')) {
                normalizeDistantHorizonsData()
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

        launch.on('close', code => {
            this.clearDistantHorizonsNormalizationTimer()
            if (configClient.launcher_config.closeLauncher == 'close-launcher') {
                ipcRenderer.send("main-window-show")
            };
            ipcRenderer.send('main-window-progress-reset')
            infoStartingBOX.style.display = "none"
            playInstanceBTN.style.display = "flex"
            infoStarting.innerHTML = `Vérification`
            new logger(pkg.name, '#7289da');
            console.log('Close');
        });

        launch.on('error', err => {
            this.clearDistantHorizonsNormalizationTimer()
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
                .map(detail => `<br><small>${detail}</small>`)
                .join('')

            popupError.openPopup({
                title: 'Erreur',
                content: `${userFacingMessage}${formattedDetails}`,
                color: 'red',
                options: true
            })

            if (configClient.launcher_config.closeLauncher == 'close-launcher') {
                ipcRenderer.send("main-window-show")
            };
            ipcRenderer.send('main-window-progress-reset')
            infoStartingBOX.style.display = "none"
            playInstanceBTN.style.display = "flex"
            infoStarting.innerHTML = `Vérification`
            new logger(pkg.name, '#7289da');
            console.error(err);
        });
    }

    getdate(e) {
        let date = new Date(e)
        let year = date.getFullYear()
        let month = date.getMonth() + 1
        let day = date.getDate()
        let allMonth = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']
        return { year: year, month: allMonth[month - 1], day: day }
    }

    clearDistantHorizonsNormalizationTimer() {
        if (this.distantHorizonsNormalizationTimer) {
            clearInterval(this.distantHorizonsNormalizationTimer)
            this.distantHorizonsNormalizationTimer = null
        }
        this.distantHorizonsNormalizationAttempts = 0
    }

    normalizeDistantHorizonsData(basePath, instanceName) {
        let hasNormalized = false

        try {
            const instancePath = path.join(basePath, 'instances', instanceName)
            const dhPath = path.join(instancePath, 'Distant_Horizons_server_data')

            if (!fs.existsSync(dhPath)) return false

            const walkAndNormalize = (directory) => {
                const entries = fs.readdirSync(directory, { withFileTypes: true })

                for (const entry of entries) {
                    if (!entry.isDirectory()) continue

                    const source = path.join(directory, entry.name)
                    const normalizedName = this.getNormalizedDistantHorizonsSegment(entry.name)
                    const needsRename = normalizedName && normalizedName !== entry.name

                    if (needsRename) {
                        const target = path.join(directory, normalizedName)

                        if (fs.existsSync(target)) {
                            this.mergeDistantHorizonsDirectory(source, target)
                            this.removeEmptyDistantHorizonsDirectory(source)
                            hasNormalized = true
                            walkAndNormalize(target)
                        } else {
                            fs.renameSync(source, target)
                            hasNormalized = true
                            walkAndNormalize(target)
                        }

                        continue
                    }

                    walkAndNormalize(source)
                }
            }

            walkAndNormalize(dhPath)
        } catch (error) {
            console.warn('[Launcher] Unable to normalize Distant Horizons data directory names:', error)
        }

        return hasNormalized
    }

    getNormalizedDistantHorizonsSegment(name) {
        let decodedName = name

        try {
            decodedName = decodeURIComponent(name)
        } catch (error) {
            decodedName = name
        }

        const normalized = decodedName.replace(/\./g, '%2E')
        return normalized
    }

    mergeDistantHorizonsDirectory(sourceDir, targetDir) {
        try {
            const entries = fs.readdirSync(sourceDir, { withFileTypes: true })

            for (const entry of entries) {
                const sourcePath = path.join(sourceDir, entry.name)
                const targetPath = path.join(targetDir, entry.name)

                if (entry.isDirectory()) {
                    if (!fs.existsSync(targetPath)) {
                        fs.renameSync(sourcePath, targetPath)
                    } else {
                        this.mergeDistantHorizonsDirectory(sourcePath, targetPath)
                        this.removeEmptyDistantHorizonsDirectory(sourcePath)
                    }
                } else {
                    if (!fs.existsSync(targetPath)) {
                        fs.renameSync(sourcePath, targetPath)
                    }
                }
            }
        } catch (error) {
            console.warn('[Launcher] Unable to merge Distant Horizons data directory contents:', error)
        }
    }

    removeEmptyDistantHorizonsDirectory(directory) {
        try {
            if (!fs.existsSync(directory)) return

            const remainingEntries = fs.readdirSync(directory)
            if (remainingEntries.length === 0) {
                fs.rmdirSync(directory)
            }
        } catch (error) {
            console.warn('[Launcher] Unable to clean up Distant Horizons directory placeholder:', error)
        }
    }
}
export default Home;