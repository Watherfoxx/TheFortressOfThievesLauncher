const fs = require("fs");

const builder = require('electron-builder')
const JavaScriptObfuscator = require('javascript-obfuscator');
const nodeFetch = require('node-fetch')
const png2icons = require('png2icons');
const Jimp = require('jimp');

const { preductname, version } = require('./package.json');

class Index {
    async init() {
        this.obf = true
        this.Fileslist = []
        this.discordCrashWebhookUrl = process.env.DISCORD_CRASH_WEBHOOK_URL
        for (const val of process.argv) {
            if (val.startsWith('--icon')) {
                await this.iconSet(val.split('=')[1])
            }

            if (val.startsWith('--obf')) {
                this.obf = JSON.parse(val.split('=')[1])
                this.Fileslist = this.getFiles("src");
            }

            if (val.startsWith('--build')) {
                let buildType = val.split('=')[1]
                if (buildType == 'platform') return await this.buildPlatform()
            }
        }
    }

    async Obfuscate() {
        this.validateDiscordCrashWebhookUrl()

        if (fs.existsSync("./app")) fs.rmSync("./app", { recursive: true })

        for (let path of this.Fileslist) {
            let fileName = path.split('/').pop()
            let extFile = fileName.split(".").pop()
            let folder = path.replace(`/${fileName}`, '').replace('src', 'app')

            if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true })

            if (extFile == 'js') {
                let code = fs.readFileSync(path, "utf8");
                code = code.replace(/src\//g, 'app/');
                code = code.replace(
                    "'__BUILD_DISCORD_CRASH_WEBHOOK_URL__'",
                    JSON.stringify(this.discordCrashWebhookUrl)
                );
                if (this.obf) {
                    await new Promise((resolve) => {
                        console.log(`Obfuscate ${path}`);
                        let obf = JavaScriptObfuscator.obfuscate(code, { optionsPreset: 'medium-obfuscation', disableConsoleOutput: false });
                        resolve(fs.writeFileSync(`${folder}/${fileName}`, obf.getObfuscatedCode(), { encoding: "utf-8" }));
                    })
                } else {
                    console.log(`Copy ${path}`);
                    fs.writeFileSync(`${folder}/${fileName}`, code, { encoding: "utf-8" });
                }
            } else {
                fs.copyFileSync(path, `${folder}/${fileName}`);
            }
        }
    }

    validateDiscordCrashWebhookUrl() {
        if (!this.discordCrashWebhookUrl) {
            throw new Error(
                "La variable DISCORD_CRASH_WEBHOOK_URL est requise pour compiler le launcher."
            )
        }

        let webhookUrl
        try {
            webhookUrl = new URL(this.discordCrashWebhookUrl)
        } catch {
            throw new Error("DISCORD_CRASH_WEBHOOK_URL n'est pas une URL valide.")
        }

        const allowedHosts = new Set(['discord.com', 'discordapp.com'])
        if (
            webhookUrl.protocol !== 'https:'
            || !allowedHosts.has(webhookUrl.hostname)
            || !webhookUrl.pathname.startsWith('/api/webhooks/')
        ) {
            throw new Error("DISCORD_CRASH_WEBHOOK_URL n'est pas un webhook Discord valide.")
        }
    }

    async buildPlatform() {
        await this.Obfuscate();
        await builder.build({
            config: {
                generateUpdatesFilesForAllChannels: false,
                appId: preductname,
                productName: preductname,
                copyright: 'Copyright © 2020-2024 Luuxis',
                artifactName: "${productName}-${os}-${arch}.${ext}",
                extraMetadata: { main: 'app/app.js' },
                files: ["app/**/*", "package.json", "LICENSE.md"],
                directories: { "output": "dist" },
                compression: 'maximum',
                asar: true,
                publish: [{
                    provider: "github",
                    releaseType: 'release',
                }],
                win: {
                    icon: "./app/assets/images/icon.ico",
                    target: [{
                        target: "nsis",
                        arch: "x64"
                    }]
                },
                nsis: {
                    oneClick: true,
                    allowToChangeInstallationDirectory: false,
                    createDesktopShortcut: true,
                    runAfterFinish: true
                },
                mac: {
                    icon: "./app/assets/images/icon.icns",
                    category: "public.app-category.games",
                    identity: null,
                    extendInfo: {
                        NSMicrophoneUsageDescription: "Le chat vocal en jeu nécessite l'accès au microphone."
                    },
                    target: [{
                        target: "dmg",
                        arch: "x64"
                    },
                    {
                        target: "zip",
                        arch: "x64"
                    },
                    {
                        target: "dmg",
                        arch: "arm64"
                    }, {
                        target: "zip",
                        arch: "arm64"
                    }]
                },
                linux: {
                    icon: "./app/assets/images/icon.png",
                    target: [{
                        target: "AppImage",
                        arch: "x64"
                    }, {
                        target: "deb",
                        arch: "x64"
                    }, {
                        target: "tar.gz",
                        arch: "x64"
                    }, {
                        target: "zip",
                        arch: "x64"
                    }]
                }
            }
        }).then(() => {
            this.verifyUpdateMetadata()
            console.log('le build est terminé')
        }).catch(err => {
            console.error('Error during build!', err)
            throw err
        })
    }

    verifyUpdateMetadata() {
        const metadataByPlatform = {
            win32: { file: 'latest.yml', artifact: /\.exe\b/i },
            darwin: { file: 'latest-mac.yml', artifact: /\.zip\b/i },
            linux: { file: 'latest-linux.yml', artifact: /\.AppImage\b/i }
        }
        const expected = metadataByPlatform[process.platform]
        if (!expected) throw new Error(`Plateforme de build non prise en charge: ${process.platform}`)

        const metadataPath = `./dist/${expected.file}`
        if (!fs.existsSync(metadataPath)) {
            throw new Error(`Métadonnées de mise à jour manquantes: ${metadataPath}`)
        }

        const metadata = fs.readFileSync(metadataPath, 'utf8')
        const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        if (!new RegExp(`^version:\\s*['"]?${escapedVersion}['"]?\\s*$`, 'm').test(metadata)) {
            throw new Error(`${expected.file} ne référence pas la version ${version}`)
        }
        if (!/^\s*sha512:\s*\S+/m.test(metadata) || !expected.artifact.test(metadata)) {
            throw new Error(`${expected.file} est incomplet ou ne référence pas le bon artefact`)
        }

        console.log(`Métadonnées de mise à jour vérifiées: ${metadataPath}`)
    }

    getFiles(path, file = []) {
        if (fs.existsSync(path)) {
            let files = fs.readdirSync(path);
            if (files.length == 0) file.push(path);
            for (let i in files) {
                let name = `${path}/${files[i]}`;
                if (fs.statSync(name).isDirectory()) this.getFiles(name, file);
                else file.push(name);
            }
        }
        return file;
    }

    async iconSet(url) {
        let Buffer = await nodeFetch(url)
        if (Buffer.status == 200) {
            Buffer = await Buffer.buffer()
            const image = await Jimp.read(Buffer);
            Buffer = await image.resize(256, 256).getBufferAsync(Jimp.MIME_PNG)
            fs.writeFileSync("src/assets/images/icon.icns", png2icons.createICNS(Buffer, png2icons.BILINEAR, 0));
            fs.writeFileSync("src/assets/images/icon.ico", png2icons.createICO(Buffer, png2icons.HERMITE, 0, false));
            fs.writeFileSync("src/assets/images/icon.png", Buffer);
            console.log('new icon set')
        } else {
            console.log('connection error')
        }
    }
}

new Index().init().catch(err => {
    console.error('Build failed!', err)
    process.exitCode = 1
});
