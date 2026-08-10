const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

require('../src/assets/js/utils/downloader-retry.js')

const { Downloader, Launch } = require('minecraft-java-core')

test('a fatal download error rejects and cannot continue the launch chain', async t => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tfot-download-failure-'))
    const originalFetch = global.fetch

    t.after(() => {
        global.fetch = originalFetch
        fs.rmSync(temporaryDirectory, { recursive: true, force: true })
    })

    global.fetch = async () => ({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        body: null
    })

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
