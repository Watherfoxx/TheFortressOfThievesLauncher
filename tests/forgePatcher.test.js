const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

require('../src/assets/js/utils/downloader-retry.js')

const coreEntry = require.resolve('minecraft-java-core')
const coreDirectory = path.dirname(coreEntry)
const ForgePatcher = require(path.join(coreDirectory, 'Minecraft-Loader', 'patcher.js')).default
const Forge = require(path.join(coreDirectory, 'Minecraft-Loader', 'loader', 'forge', 'forge.js')).default
const Loader = require(path.join(coreDirectory, 'Minecraft-Loader', 'index.js')).default
const JavaDownloader = require(path.join(coreDirectory, 'Minecraft', 'Minecraft-Java.js')).default
const { Launch } = require('minecraft-java-core')

test('réutilise le véritable exécutable du runtime Java déjà extrait', async t => {
    const temporaryPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fortress-java-runtime-'))
    t.after(() => fs.promises.rm(temporaryPath, { recursive: true, force: true }))

    const executableName = process.platform === 'win32' ? 'java.exe' : 'java'
    const executablePath = path.join(
        temporaryPath,
        'runtime',
        'jre-21',
        'zulu-jre-21',
        'bin',
        executableName
    )
    await fs.promises.mkdir(path.dirname(executablePath), { recursive: true })
    await fs.promises.writeFile(executablePath, 'java-runtime')
    if (process.platform !== 'win32') await fs.promises.chmod(executablePath, 0o755)

    const java = new JavaDownloader({
        path: temporaryPath,
        java: { version: 21, type: 'jre' }
    })
    const result = await java.getJavaOther({ javaVersion: { majorVersion: 21 } }, 21)

    assert.equal(path.resolve(result.path), path.resolve(executablePath))
})

test('supprime et reconstruit automatiquement un runtime Java extrait sans exécutable', async t => {
    const temporaryPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fortress-corrupt-runtime-'))
    const runtimeFolder = path.join(temporaryPath, 'runtime', 'jre-21')
    const staleArchive = path.join(runtimeFolder, 'runtime-corrompu.zip')
    const executableName = process.platform === 'win32' ? 'java.exe' : 'java'
    const executablePath = path.join(runtimeFolder, 'runtime-repare', 'bin', executableName)
    const originalGetJavaOther = JavaDownloader.prototype.__fortressOriginalGetJavaOther
    let attempts = 0

    await fs.promises.mkdir(runtimeFolder, { recursive: true })
    await fs.promises.writeFile(staleArchive, 'archive-incomplete')

    t.after(async () => {
        JavaDownloader.prototype.__fortressOriginalGetJavaOther = originalGetJavaOther
        await fs.promises.rm(temporaryPath, { recursive: true, force: true })
    })

    JavaDownloader.prototype.__fortressOriginalGetJavaOther = async function simulatedJavaExtraction() {
        attempts += 1
        if (attempts === 1) {
            assert.equal(fs.existsSync(staleArchive), true)
            return { files: [], path: path.join(runtimeFolder, 'runtime-corrompu', 'bin', 'java') }
        }

        assert.equal(fs.existsSync(runtimeFolder), false)
        await fs.promises.mkdir(path.dirname(executablePath), { recursive: true })
        await fs.promises.writeFile(executablePath, 'java-runtime')
        if (process.platform !== 'win32') await fs.promises.chmod(executablePath, 0o755)
        return { files: [], path: executablePath.replace(/\.exe$/i, '') }
    }

    const java = new JavaDownloader({
        path: temporaryPath,
        java: { version: 21, type: 'jre' }
    })
    const result = await java.getJavaOther({ javaVersion: { majorVersion: 21 } }, 21)

    assert.equal(attempts, 2)
    assert.equal(path.resolve(result.path), path.resolve(executablePath))
    assert.equal(fs.existsSync(staleArchive), false)
})

test('Forge complète automatiquement l’extension .exe manquante sous Windows', {
    skip: process.platform !== 'win32'
}, async t => {
    const temporaryPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fortress-java-extension-'))
    t.after(() => fs.promises.rm(temporaryPath, { recursive: true, force: true }))

    const javaPathWithoutExtension = path.join(temporaryPath, 'bin', 'java')
    await fs.promises.mkdir(path.dirname(javaPathWithoutExtension), { recursive: true })
    await fs.promises.writeFile(`${javaPathWithoutExtension}.exe`, 'java-runtime')

    const patcher = new ForgePatcher({ path: temporaryPath })
    const result = await patcher.patcher({ processors: [] }, {
        java: javaPathWithoutExtension,
        minecraft: 'minecraft.jar',
        minecraftJson: 'minecraft.json'
    })

    assert.deepEqual(result, { success: true })
})

test('un chemin Java configuré mais disparu revient au runtime intégré', async t => {
    const launch = new Launch()
    let receivedOptions = null

    launch.start = async function captureOptions() {
        receivedOptions = this.options
    }

    await launch.Launch({
        authenticator: { name: 'Offline' },
        java: {
            path: path.join(os.tmpdir(), 'java-qui-n-existe-plus', 'bin', 'java.exe'),
            version: 21,
            type: 'jre'
        }
    })

    assert.equal(receivedOptions.java.path, null)
})

test('Forge retrouve Java dans un runtime Windows profondément imbriqué', {
    skip: process.platform !== 'win32'
}, async t => {
    const temporaryPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fortress-forge-runtime-'))
    t.after(() => fs.promises.rm(temporaryPath, { recursive: true, force: true }))

    const executablePath = path.join(
        temporaryPath,
        'runtime',
        'jre-21',
        'archive',
        'zulu21',
        'bin',
        'java.exe'
    )
    await fs.promises.mkdir(path.dirname(executablePath), { recursive: true })
    await fs.promises.writeFile(executablePath, 'java-runtime')

    const patcher = new ForgePatcher({ path: temporaryPath })
    const result = await patcher.patcher({ processors: [] }, {
        java: path.join(temporaryPath, 'ancien-runtime', 'bin', 'java.exe'),
        minecraft: 'minecraft.jar',
        minecraftJson: 'minecraft.json'
    })

    assert.deepEqual(result, { success: true })
})

test('un processus Forge non nul remonte une erreur sans exception EventEmitter', async () => {
    const patcher = new ForgePatcher({ path: process.cwd() })
    const errors = []

    patcher.on('error', error => errors.push(error))
    patcher.readJarManifest = async () => 'example.invalid.Main'

    const result = await patcher.patcher({
        processors: [{
            jar: 'example:invalid-processor:1.0.0',
            classpath: [],
            args: [],
            sides: ['client']
        }]
    }, {
        java: process.execPath,
        minecraft: 'minecraft.jar',
        minecraftJson: 'minecraft.json'
    })

    assert.equal(typeof result.error, 'string')
    assert.match(result.error, /patcher Forge|démarrer Java/i)
    assert.equal(errors.length, 1)
})

test('Forge convertit une erreur du patcher en résultat contrôlé', async t => {
    const originalCheck = ForgePatcher.prototype.check
    const originalPatcher = ForgePatcher.prototype.patcher

    t.after(() => {
        ForgePatcher.prototype.check = originalCheck
        ForgePatcher.prototype.patcher = originalPatcher
    })

    ForgePatcher.prototype.check = () => false
    ForgePatcher.prototype.patcher = async function simulatedFailure() {
        const message = 'Échec Forge simulé'
        this.emit('error', message)
        return { error: message }
    }

    const forge = new Forge({
        loader: {
            config: {
                javaPath: process.execPath,
                minecraftJar: 'minecraft.jar',
                minecraftJson: 'minecraft.json'
            }
        }
    })
    const result = await forge.patchForge({ processors: [{}] })

    assert.deepEqual(result, { error: 'Échec Forge simulé' })
})

test('les erreurs objet du loader deviennent de vraies instances Error', () => {
    const loader = new Loader({})
    let receivedError = null

    loader.on('error', error => {
        receivedError = error
    })
    loader.emit('error', { error: 'Installation Forge impossible', details: 'code 127' })

    assert.equal(receivedError instanceof Error, true)
    assert.equal(receivedError.message, 'Installation Forge impossible')
    assert.equal(receivedError.details, 'code 127')
})
