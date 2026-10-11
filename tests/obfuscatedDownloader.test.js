const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const Module = require('node:module')
const { createRequire } = require('node:module')
const os = require('node:os')
const path = require('node:path')
const { Readable } = require('node:stream')
const vm = require('node:vm')
const JavaScriptObfuscator = require('javascript-obfuscator')
const obfuscatorOptions = require('../obfuscator-options.js')
const forgeJar = require('./helpers/forge-jar.cjs')

const sourcePath = path.resolve(__dirname, '../src/assets/js/utils/downloader-retry.js')
const source = fs.readFileSync(sourcePath, 'utf8')
const obfuscatedSource = JavaScriptObfuscator.obfuscate(source, obfuscatorOptions).getObfuscatedCode()
const obfuscatedModule = new Module(sourcePath, module)
obfuscatedModule.filename = sourcePath
obfuscatedModule.paths = Module._nodeModulePaths(path.dirname(sourcePath))
obfuscatedModule._compile(obfuscatedSource, sourcePath)

const { Downloader } = require('minecraft-java-core')

test('le downloader obfusqué charge macArchitecture depuis launcher.html', () => {
    const launcherRequire = createRequire(path.resolve(__dirname, '../src/launcher.html'))
    const rendererProcess = Object.create(process)
    rendererProcess.type = 'renderer'

    assert.doesNotThrow(() => vm.runInNewContext(obfuscatedSource, {
        require: launcherRequire,
        process: rendererProcess,
        console,
        Buffer,
        URL,
        AbortController,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval
    }, { timeout: 5000 }))
})

test('le downloader reste fonctionnel après la même obfuscation que le build', async t => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tfot-obfuscated-download-'))
    const originalFetch = global.fetch
    const content = Buffer.from('server-config-content')
    const destination = path.join(temporaryDirectory, 'Butchery.toml')

    t.after(() => {
        global.fetch = originalFetch
        fs.rmSync(temporaryDirectory, { recursive: true, force: true })
    })

    global.fetch = async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: name => name === 'content-length' ? String(content.length) : null },
        body: Readable.from([content])
    })

    const downloader = new Downloader()
    await downloader.downloadFileMultiple([{
        folder: temporaryDirectory,
        path: destination,
        url: 'https://example.invalid/Butchery.toml',
        type: 'Config',
        size: content.length,
        sha1: crypto.createHash('sha1').update(content).digest('hex')
    }], content.length, 1, 1000)

    assert.deepEqual(fs.readFileSync(destination), content)
})

test('le build obfusqué répare aussi les bibliothèques Forge déjà corrompues', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tfot-obfuscated-forge-'))
    const originalFetch = global.fetch
    const content = forgeJar()
    const destination = path.join(root, 'libraries/org/ow2/asm/asm-commons/9.5/asm-commons-9.5.jar')
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.writeFileSync(destination, Buffer.alloc(content.length))
    t.after(() => {
        global.fetch = originalFetch
        fs.rmSync(root, { recursive: true, force: true })
    })
    let requests = 0
    global.fetch = async () => {
        requests++
        return {
            ok: true, status: 200,
            headers: { get: name => name === 'content-length' ? String(content.length) : null },
            body: Readable.from([content])
        }
    }
    const coreDirectory = path.dirname(require.resolve('minecraft-java-core'))
    const Forge = require(path.join(coreDirectory, 'Minecraft-Loader/loader/forge/forge.js')).default
    await new Forge({ path: root }).downloadLibraries({ install: { libraries: [{
        name: 'org.ow2.asm:asm-commons:9.5',
        downloads: { artifact: {
            url: 'https://example.invalid/asm-commons.jar',
            size: content.length,
            sha1: crypto.createHash('sha1').update(content).digest('hex')
        } }
    }] } }, true)
    assert.equal(requests, 1)
    assert.deepEqual(fs.readFileSync(destination), content)
})

test('le build obfusqué conserve le PID et le code 0 d’une fermeture normale', async t => {
    const { Launch } = require('minecraft-java-core')
    const coreDirectory = path.dirname(require.resolve('minecraft-java-core'))
    const MinecraftArguments = require(path.join(coreDirectory, 'Minecraft/Minecraft-Arguments.js')).default
    const MinecraftLoader = require(path.join(coreDirectory, 'Minecraft/Minecraft-Loader.js')).default
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tfot-obfuscated-exit-'))
    const originalArguments = MinecraftArguments.prototype.GetArguments
    const originalLoaderArguments = MinecraftLoader.prototype.GetArguments
    t.after(() => {
        MinecraftArguments.prototype.GetArguments = originalArguments
        MinecraftLoader.prototype.GetArguments = originalLoaderArguments
        fs.rmSync(root, { recursive: true, force: true })
    })
    MinecraftArguments.prototype.GetArguments = async () => ({
        jvm: [], classpath: [], mainClass: '-e', game: ['process.exit(0)']
    })
    MinecraftLoader.prototype.GetArguments = async () => ({ jvm: [], game: [] })
    const launch = new Launch()
    launch.options = { path: root, java: { path: process.execPath }, loader: { path: 'loader' }, authenticator: {} }
    launch.DownloadGame = async () => ({ minecraftJava: { path: process.execPath } })
    const errors = []
    launch.on('error', error => errors.push(error))
    let pid
    launch.on('game-process', data => { pid = data.pid })
    const closed = new Promise(resolve => launch.once('close', code => resolve(code)))
    const child = await launch.start()
    assert.equal(errors.length, 0, JSON.stringify(errors))
    assert.equal(pid, child.pid)
    assert.equal(await closed, 0)
})
