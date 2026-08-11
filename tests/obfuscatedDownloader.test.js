const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const Module = require('node:module')
const os = require('node:os')
const path = require('node:path')
const { Readable } = require('node:stream')
const JavaScriptObfuscator = require('javascript-obfuscator')
const obfuscatorOptions = require('../obfuscator-options.js')

const sourcePath = path.resolve(__dirname, '../src/assets/js/utils/downloader-retry.js')
const source = fs.readFileSync(sourcePath, 'utf8')
const obfuscatedSource = JavaScriptObfuscator.obfuscate(source, obfuscatorOptions).getObfuscatedCode()
const obfuscatedModule = new Module(sourcePath, module)
obfuscatedModule.filename = sourcePath
obfuscatedModule.paths = Module._nodeModulePaths(path.dirname(sourcePath))
obfuscatedModule._compile(obfuscatedSource, sourcePath)

const { Downloader } = require('minecraft-java-core')

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
