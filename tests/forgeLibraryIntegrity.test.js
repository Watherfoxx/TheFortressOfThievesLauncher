const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Readable } = require('node:stream')
const test = require('node:test')
const forgeJar = require('./helpers/forge-jar.cjs')

require('../src/assets/js/utils/downloader-retry.js')
const { Downloader } = require('minecraft-java-core')
const coreDirectory = path.dirname(require.resolve('minecraft-java-core'))
const Forge = require(path.join(coreDirectory, 'Minecraft-Loader/loader/forge/forge.js')).default
const NeoForge = require(path.join(coreDirectory, 'Minecraft-Loader/loader/neoForge/neoForge.js')).default
const Patcher = require(path.join(coreDirectory, 'Minecraft-Loader/patcher.js')).default
const Loader = require(path.join(coreDirectory, 'Minecraft-Loader/index.js')).default

const coordinate = 'org.ow2.asm:asm-commons:9.5'
const relativePath = 'libraries/org/ow2/asm/asm-commons/9.5/asm-commons-9.5.jar'
const content = forgeJar()
const library = {
    name: coordinate,
    downloads: { artifact: {
        url: 'https://example.invalid/asm-commons-9.5.jar',
        size: content.length,
        sha1: crypto.createHash('sha1').update(content).digest('hex')
    } }
}
const profile = { version: { libraries: [library] }, install: { libraries: [library] } }

async function setup(t) {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fortress-forge-integrity-'))
    const originalFetch = global.fetch
    const originalMirror = Downloader.prototype.checkMirror
    const filePath = path.join(root, relativePath)
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
    const requests = []
    global.fetch = async url => {
        requests.push(url)
        return response(content)
    }
    Downloader.prototype.checkMirror = async () => { throw new Error('Unexpected mirror request') }
    t.after(async () => {
        global.fetch = originalFetch
        Downloader.prototype.checkMirror = originalMirror
        await fs.promises.rm(root, { recursive: true, force: true })
    })
    return { root, filePath, requests }
}

function response(body) {
    return {
        ok: true, status: 200,
        headers: { get: name => name === 'content-length' ? String(body.length) : null },
        body: Readable.from([body])
    }
}

for (const LoaderClass of [Forge, NeoForge]) {
    test(`${LoaderClass.name} répare un JAR existant de même taille mais de SHA-1 incorrect`, async t => {
        const { root, filePath, requests } = await setup(t)
        await fs.promises.writeFile(filePath, Buffer.alloc(content.length, 0x78))
        const result = await new LoaderClass({ path: root }).downloadLibraries(profile, true)
        assert.deepEqual(result, [library])
        assert.equal(requests.length, 1)
        assert.deepEqual(await fs.promises.readFile(filePath), content)
        assert.equal(fs.existsSync(`${filePath}.part`), false)
    })
}

test('aucun téléchargement ni requête miroir pour un JAR valide', async t => {
    const { root, filePath, requests } = await setup(t)
    await fs.promises.writeFile(filePath, content)
    await new Forge({ path: root }).downloadLibraries(profile, true)
    assert.equal(requests.length, 0)
})

test('retélécharge un JAR absent et ignore un ancien téléchargement partiel', async t => {
    const { root, filePath, requests } = await setup(t)
    await fs.promises.writeFile(`${filePath}.part`, 'download interrupted')
    await new Forge({ path: root }).downloadLibraries(profile, true)
    assert.equal(requests.length, 1)
    assert.deepEqual(await fs.promises.readFile(filePath), content)
    assert.equal(fs.existsSync(`${filePath}.part`), false)
})

test('un téléchargement de même taille mais corrompu est retenté avant le patcher', async t => {
    const { root, filePath } = await setup(t)
    let attempts = 0
    global.fetch = async () => response(++attempts === 1 ? Buffer.alloc(content.length) : content)
    await new Forge({ path: root }).downloadLibraries(profile, true)
    assert.equal(attempts, 2)
    assert.deepEqual(await fs.promises.readFile(filePath), content)
})

test('réutilise le SHA-1 du profil installateur si le profil version ne le donne pas', async t => {
    const { root, filePath, requests } = await setup(t)
    await fs.promises.writeFile(filePath, Buffer.alloc(content.length))
    await new Forge({ path: root }).downloadLibraries({
        version: { libraries: [{ name: coordinate }] }, install: profile.install
    }, true)
    assert.equal(requests.length, 1)
})

test('les règles OS ignorées ne déclenchent ni vérification ni téléchargement', async t => {
    const { root, requests } = await setup(t)
    const ignored = { ...library, rules: [{ action: 'disallow' }] }
    await new Forge({ path: root }).downloadLibraries({ version: { libraries: [ignored] } }, true)
    assert.equal(requests.length, 0)
})

test('ne retélécharge pas les JAR Forge embarqués dans l’installateur', async t => {
    const { root, requests } = await setup(t)
    const embedded = { name: 'net.minecraftforge:forge:1.20.1-47.4.20:universal', downloads: { artifact: { url: '' } } }
    await new Forge({ path: root }).downloadLibraries({ install: { libraries: [embedded] } }, true)
    assert.equal(requests.length, 0)
})

test('sans SHA-1, un JAR tronqué puis une réponse HTML sont détectés et réparés', async t => {
    const { root, filePath } = await setup(t)
    await fs.promises.writeFile(filePath, content.subarray(0, content.length - 22))
    const legacy = { name: coordinate, url: 'https://legacy.invalid/maven/' }
    let attempts = 0
    global.fetch = async () => response(++attempts === 1 ? Buffer.from('<html>error</html>') : content)
    await new Forge({ path: root }).downloadLibraries({ install: { libraries: [legacy] } }, true)
    assert.equal(attempts, 2)
    assert.deepEqual(await fs.promises.readFile(filePath), content)
})

test('sans SHA-1, détecte aussi un CRC incorrect dans un JAR non compressé', async t => {
    const { root, filePath, requests } = await setup(t)
    const damaged = forgeJar('stored fixture', false)
    damaged[30 + Buffer.byteLength('org/objectweb/asm/commons/Remapper.class')] ^= 1
    await fs.promises.writeFile(filePath, damaged)
    await new Forge({ path: root }).downloadLibraries({
        install: { libraries: [{ name: coordinate, downloads: { artifact: { url: library.downloads.artifact.url } } }] }
    }, true)
    assert.equal(requests.length, 1)
})

test('sans SHA-1, réutilise les archives valides stockées ou compressées', async t => {
    const { root, filePath, requests } = await setup(t)
    for (const compressed of [false, true]) {
        await fs.promises.writeFile(filePath, forgeJar('healthy legacy library', compressed))
        await new Forge({ path: root }).downloadLibraries({
            install: { libraries: [{ name: coordinate }] }
        }, true)
    }
    assert.equal(requests.length, 0)
})

test('utilise un miroir pour les anciens profils sans URL et conserve la vérification', async t => {
    const { root, filePath, requests } = await setup(t)
    Downloader.prototype.checkMirror = async repositoryPath => {
        assert.equal(repositoryPath, relativePath.replace('libraries/', ''))
        return { status: 200, url: 'https://mirror.invalid/asm-commons.jar', size: content.length }
    }
    await new Forge({ path: root }).downloadLibraries({ install: { libraries: [{ name: coordinate }] } }, true)
    assert.deepEqual(requests, ['https://mirror.invalid/asm-commons.jar'])
    assert.deepEqual(await fs.promises.readFile(filePath), content)
})

test('vérifie les métadonnées du classifier natif, pas celles du JAR principal', async t => {
    const { root, requests } = await setup(t)
    const osName = { win32: 'windows', linux: 'linux', darwin: 'osx' }[process.platform]
    const natives = {
        name: coordinate,
        natives: { [osName]: `natives-${osName}` },
        downloads: {
            artifact: { ...library.downloads.artifact, sha1: '0'.repeat(40), size: 12345 },
            classifiers: { [`natives-${osName}`]: library.downloads.artifact }
        }
    }
    await new Forge({ path: root }).downloadLibraries({ version: { libraries: [natives] } }, true)
    assert.equal(requests.length, 1)
    const nativePath = path.join(root, relativePath.replace('.jar', `-natives-${osName}.jar`))
    assert.deepEqual(await fs.promises.readFile(nativePath), content)
})

test('échec définitif : Loader émet une seule erreur et ne lance jamais le patcher', async t => {
    const { root, filePath } = await setup(t)
    const originalMethods = ['downloadInstaller', 'extractProfile', 'extractUniversalJar', 'patchForge']
        .map(name => [name, Forge.prototype[name]])
    t.after(() => { for (const [name, method] of originalMethods) Forge.prototype[name] = method })
    Forge.prototype.downloadInstaller = async () => ({ filePath: 'fixture-installer.jar' })
    Forge.prototype.extractProfile = async () => profile
    Forge.prototype.extractUniversalJar = async () => true
    let patched = false
    Forge.prototype.patchForge = async () => { patched = true; return true }
    let attempts = 0
    global.fetch = async () => { attempts++; return response(Buffer.alloc(content.length)) }
    const loader = new Loader({ path: root, loader: { type: 'forge' } })
    const errors = []
    const completed = []
    loader.on('error', error => errors.push(error))
    loader.on('json', json => completed.push(json))
    await loader.install()
    assert.equal(attempts, 3)
    assert.equal(patched, false)
    assert.equal(completed.length, 0)
    assert.equal(errors.length, 1)
    assert.match(errors[0].message, /SHA-1/)
    assert.equal(fs.existsSync(filePath), false)
    assert.equal(fs.existsSync(`${filePath}.part`), false)
})

test('sans source de réparation, ne poursuit pas avec des dépendances absentes', async t => {
    const { root } = await setup(t)
    Downloader.prototype.checkMirror = async () => null
    await assert.rejects(new Forge({ path: root }).downloadLibraries({
        install: { libraries: [{ name: coordinate }] }
    }, true), /aucune source/)
})

test('le patcher refuse une dépendance classpath absente avant de chercher la classe principale', async t => {
    const { root, filePath } = await setup(t)
    await fs.promises.writeFile(filePath, content)
    const patcher = new Patcher({ path: root })
    const errors = []
    patcher.on('error', error => errors.push(error))
    patcher.readJarManifest = async () => { throw new Error('Must not start Java') }
    const result = await patcher.patcher({
        libraries: [library],
        processors: [{ jar: coordinate, classpath: ['example:missing:1.0'], args: [] }]
    }, { java: process.execPath })
    assert.match(result.error, /missing-1.0.jar/)
    assert.equal(errors.length, 1)
})
