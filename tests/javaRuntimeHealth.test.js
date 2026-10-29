const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')
const test = require('node:test')

// Exercise the actual runtime validation (also after build obfuscation), while
// substituting only the Java subprocess: no download or installed JRE is needed.
const sourcePath = path.resolve(__dirname, '../src/assets/js/utils/downloader-retry.js')
const source = fs.readFileSync(sourcePath, 'utf8')
const coreDirectory = path.dirname(require.resolve('minecraft-java-core'))
const JavaDownloader = require(path.join(coreDirectory, 'Minecraft/Minecraft-Java.js')).default
const { Launch } = require('minecraft-java-core')
let probes = []
let probeOverride
function fakeExecFile(executable, args, options, callback) {
    probes.push({ executable, args, options })
    if (probeOverride) return probeOverride(callback)
    const cfg = path.join(path.dirname(executable), '../lib/jvm.cfg')
    if (!fs.existsSync(cfg)) return callback(new Error('exit code 1'), '', `Error: could not open '${cfg}'`)
    callback(null, '', `openjdk version "${fs.readFileSync(cfg, 'utf8')}"\nOpenJDK Runtime Environment Zulu`)
}
function loadPatchedModule(code) {
    const loaded = new Module(sourcePath, module)
    loaded.filename = sourcePath
    loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath))
    loaded.require = name => name === 'child_process'
        ? { ...require('child_process'), execFile: fakeExecFile }
        : Module.prototype.require.call(loaded, name)
    loaded._compile(code, sourcePath)
}
loadPatchedModule(source)

async function setup(t) {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fortress-java-health-'))
    const runtime = path.join(root, 'runtime/jre-21')
    const executable = path.join(runtime, 'zulu/bin', process.platform === 'win32' ? 'java.exe' : 'java')
    const cfg = path.join(runtime, 'zulu/lib/jvm.cfg')
    const originalDownload = JavaDownloader.prototype.__fortressOriginalGetJavaOther
    const originalProbe = JavaDownloader.prototype.validateJavaRuntime
    probes = []
    probeOverride = null
    const java = new JavaDownloader({ path: root, java: { version: 21, type: 'jre' } })
    async function extract(version = null) {
        await fs.promises.mkdir(path.dirname(executable), { recursive: true })
        await fs.promises.writeFile(executable, 'fixture executable', { mode: 0o755 })
        if (version) {
            await fs.promises.mkdir(path.dirname(cfg), { recursive: true })
            await fs.promises.writeFile(cfg, version)
        }
        return { files: [], path: executable }
    }
    t.after(async () => {
        JavaDownloader.prototype.__fortressOriginalGetJavaOther = originalDownload
        JavaDownloader.prototype.validateJavaRuntime = originalProbe
        probeOverride = null
        await fs.promises.rm(root, { recursive: true, force: true })
    })
    return { root, runtime, executable, cfg, java, extract }
}

test('répare un runtime dont java existe mais lib/jvm.cfg est absent', async t => {
    const { java, extract, runtime, executable } = await setup(t)
    await extract()
    let downloads = 0
    JavaDownloader.prototype.__fortressOriginalGetJavaOther = async () => {
        downloads++
        assert.equal(fs.existsSync(runtime), false)
        return extract('21.0.12')
    }
    const result = await java.getJavaOther({}, 21)
    assert.equal(result.path, executable)
    assert.equal(downloads, 1)
    assert.equal(probes.length, 2)
    assert.deepEqual(probes[0].args, ['-version'])
})

test('contrôle aussi une nouvelle extraction et la recommence si elle est incomplète', async t => {
    const { java, extract, runtime, executable } = await setup(t)
    let downloads = 0
    JavaDownloader.prototype.__fortressOriginalGetJavaOther = async () => {
        assert.equal(fs.existsSync(runtime), false)
        return extract(++downloads === 1 ? null : '21.0.12')
    }
    const result = await java.getJavaOther({}, 21)
    assert.equal(result.path, executable)
    assert.equal(downloads, 2)
    assert.equal(probes.length, 2)
})

test('si Java reste inutilisable, renvoie une erreur et ne démarre pas le jeu', async t => {
    const { java, extract } = await setup(t)
    let downloads = 0
    JavaDownloader.prototype.__fortressOriginalGetJavaOther = () => { downloads++; return extract() }
    const result = await java.getJavaOther({}, 21)
    assert.match(result.error, /runtime Java 21 reste incomplet/)
    assert.equal(result.path, '')
    assert.match(result.message, /jvm.cfg/)
    assert.equal(downloads, 2)
    const launch = new Launch()
    const errors = []
    let started = false
    launch.DownloadGame = async () => result
    launch.on('error', error => errors.push(error))
    launch.on('game-process', () => { started = true })
    await launch.start()
    assert.equal(started, false)
    assert.equal(errors.length, 1)
})

test('réutilise un Java fonctionnel sans réseau mais le recontrôle à chaque lancement', async t => {
    const { java, extract, cfg } = await setup(t)
    await extract('21.0.12')
    let downloads = 0
    JavaDownloader.prototype.__fortressOriginalGetJavaOther = () => { downloads++; return extract('21.0.12') }
    await java.getJavaOther({}, 21)
    await java.getJavaOther({}, 21)
    assert.equal(downloads, 0)
    assert.equal(probes.length, 2)
    await fs.promises.unlink(cfg)
    await java.getJavaOther({}, 21)
    assert.equal(downloads, 1)
})

test('remplace un cache de mauvaise version majeure', async t => {
    const { java, extract } = await setup(t)
    await extract('17.0.1')
    let downloads = 0
    JavaDownloader.prototype.__fortressOriginalGetJavaOther = () => { downloads++; return extract('21.0.12') }
    const result = await java.getJavaOther({}, 21)
    assert.equal(result.error, undefined)
    assert.equal(downloads, 1)
})

test('borne la durée du test Java et ne modifie pas les options JVM de l’utilisateur', async t => {
    const { java, executable } = await setup(t)
    const saved = process.env._JAVA_OPTIONS
    process.env._JAVA_OPTIONS = '-Xmx768M'
    t.after(() => {
        if (saved === undefined) delete process.env._JAVA_OPTIONS
        else process.env._JAVA_OPTIONS = saved
    })
    probeOverride = callback => callback(new Error('Java timed out'), '', '')
    const result = await java.validateJavaRuntime(executable, 21)
    assert.equal(result.valid, false)
    assert.match(result.message, /timed out/)
    assert.equal(probes[0].options.timeout, 10000)
    assert.equal(probes[0].options.windowsHide, true)
    assert.equal(probes[0].options.maxBuffer, 65536)
    assert.equal(probes[0].options.env._JAVA_OPTIONS, undefined)
    assert.equal(process.env._JAVA_OPTIONS, '-Xmx768M')
})

test('un code 0 sans véritable version Java est refusé ; Java 8 est reconnu', async t => {
    const { java, executable } = await setup(t)
    probeOverride = callback => callback(null, 'unrelated program output', '')
    assert.equal((await java.validateJavaRuntime(executable, 21)).valid, false)
    probeOverride = callback => callback(null, '', 'java version "1.8.0_482"')
    assert.equal((await java.validateJavaRuntime(executable, 8)).valid, true)
    assert.equal((await java.validateJavaRuntime(executable, 21)).valid, false)
})

test('ne supprime jamais un dossier Java extérieur au cache via une jonction', async t => {
    const { root, runtime, java } = await setup(t)
    const outside = path.join(root, 'external-java')
    await fs.promises.mkdir(outside)
    await fs.promises.mkdir(path.dirname(runtime), { recursive: true })
    await fs.promises.writeFile(path.join(outside, 'keep.txt'), 'preserve')
    await fs.promises.symlink(outside, runtime, process.platform === 'win32' ? 'junction' : 'dir')
    JavaDownloader.prototype.__fortressOriginalGetJavaOther = async () => { throw new Error('Must not download') }
    const result = await java.getJavaOther({}, 21)
    assert.equal(typeof result.error, 'string')
    assert.match(result.message, /pas sûr/)
    assert.equal(await fs.promises.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'preserve')
})

test('le Java personnalisé défectueux revient au runtime intégré sans supprimer son dossier', async t => {
    const { root, executable, extract } = await setup(t)
    await extract()
    const launch = new Launch()
    let received
    launch.start = async function () { received = this.options }
    await launch.Launch({ authenticator: { name: 'Offline' }, java: { path: executable, version: 21 } })
    assert.equal(received.java.path, null)
    assert.equal(fs.existsSync(executable), true)
    assert.equal(fs.existsSync(root), true)
})

test('le code obfusqué répare également un cache Java dont jvm.cfg est absent', async t => {
    const { java, extract, executable } = await setup(t)
    const JavaScriptObfuscator = require('javascript-obfuscator')
    const options = require('../obfuscator-options.js')
    // Reload the actual wrappers rather than testing an already patched source.
    delete JavaDownloader.prototype.__fortressPatchedJavaExecutable
    loadPatchedModule(JavaScriptObfuscator.obfuscate(source, options).getObfuscatedCode())
    await extract()
    let downloads = 0
    JavaDownloader.prototype.__fortressOriginalGetJavaOther = () => { downloads++; return extract('21.0.12') }
    assert.equal((await java.getJavaOther({}, 21)).path, executable)
    assert.equal(downloads, 1)
})
