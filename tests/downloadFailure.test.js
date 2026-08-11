const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const crypto = require('node:crypto')
const os = require('node:os')
const path = require('node:path')
const { Readable } = require('node:stream')

require('../src/assets/js/utils/downloader-retry.js')

const { Downloader, Launch } = require('minecraft-java-core')

test('a fatal download error rejects and cannot continue the launch chain', async t => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tfot-download-failure-'))
    const originalFetch = global.fetch

    t.after(() => {
        global.fetch = originalFetch
        fs.rmSync(temporaryDirectory, { recursive: true, force: true })
    })

    let attempts = 0
    global.fetch = async () => {
        attempts += 1
        return {
            ok: false,
            status: 503,
            statusText: 'Service Unavailable',
            body: null
        }
    }

    const downloader = new Downloader()
    const emittedErrors = []
    downloader.on('error', error => emittedErrors.push(error))

    await assert.rejects(
        downloader.downloadFileMultiple([{
            folder: temporaryDirectory,
            path: path.join(temporaryDirectory, 'failed-download.jar'),
            url: 'https://invalid.local/failed-download.jar',
            type: 'Library'
        }], 1, 1, 1000),
        error => error === emittedErrors[0] && error.__fortressErrorEmitted === true
    )

    assert.equal(emittedErrors.length, 1)
    assert.equal(attempts, 3)
    assert.equal(fs.existsSync(path.join(temporaryDirectory, 'failed-download.jar')), false)
    assert.equal(fs.existsSync(path.join(temporaryDirectory, 'failed-download.jar.part')), false)
})

test('a corrupted file is retried and verified before the queue completes', async t => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tfot-download-integrity-'))
    const originalFetch = global.fetch
    const validContent = Buffer.from('valid-library-content')
    const invalidContent = Buffer.alloc(validContent.length, 0x78)
    const destination = path.join(temporaryDirectory, 'verified-library.jar')
    let attempts = 0

    t.after(() => {
        global.fetch = originalFetch
        fs.rmSync(temporaryDirectory, { recursive: true, force: true })
    })

    global.fetch = async () => {
        attempts += 1
        const content = attempts === 1 ? invalidContent : validContent
        return {
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: { get: name => name === 'content-length' ? String(content.length) : null },
            body: Readable.from([content])
        }
    }

    const downloader = new Downloader()
    await downloader.downloadFileMultiple([{
        folder: temporaryDirectory,
        path: destination,
        url: 'https://example.invalid/verified-library.jar',
        type: 'Library',
        size: validContent.length,
        sha1: crypto.createHash('sha1').update(validContent).digest('hex')
    }], validContent.length, 1, 1000)

    assert.equal(attempts, 2)
    assert.deepEqual(fs.readFileSync(destination), validContent)
    assert.equal(fs.existsSync(`${destination}.part`), false)
})

test('single-file downloads wait for disk completion and retry incomplete content', async t => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tfot-single-download-'))
    const originalFetch = global.fetch
    const destination = path.join(temporaryDirectory, 'runtime.zip')
    let attempts = 0

    t.after(() => {
        global.fetch = originalFetch
        fs.rmSync(temporaryDirectory, { recursive: true, force: true })
    })

    global.fetch = async () => {
        attempts += 1
        const content = attempts === 1 ? Buffer.from('bad') : Buffer.from('good')
        return {
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: { get: name => name === 'content-length' ? '4' : null },
            body: Readable.from([content])
        }
    }

    const downloader = new Downloader()
    await downloader.downloadFile('https://example.invalid/runtime.zip', temporaryDirectory, 'runtime.zip')

    assert.equal(attempts, 2)
    assert.equal(fs.readFileSync(destination, 'utf8'), 'good')
    assert.equal(fs.existsSync(`${destination}.part`), false)
})

test('an already reported terminal error is swallowed by Launch.start', async () => {
    const launch = new Launch()
    const terminalError = new Error('download failed')
    Object.defineProperty(terminalError, '__fortressErrorEmitted', { value: true })
    let duplicateErrors = 0

    launch.DownloadGame = async () => {
        throw terminalError
    }
    launch.on('error', () => {
        duplicateErrors += 1
    })

    const result = await launch.start()

    assert.equal(result, null)
    assert.equal(duplicateErrors, 0)
})

test('an unexpected Launch.start rejection is emitted once', async () => {
    const launch = new Launch()
    const emittedErrors = []

    launch.DownloadGame = async () => {
        throw new Error('unexpected preparation failure')
    }
    launch.on('error', error => emittedErrors.push(error))

    const result = await launch.start()

    assert.equal(result, null)
    assert.equal(emittedErrors.length, 1)
    assert.match(emittedErrors[0].error, /unexpected preparation failure/)
})
