const assert = require('node:assert/strict')
const test = require('node:test')

const {
    classifyExternalBus,
    classifyMediaType,
    parseLinuxStorage,
    parseMacStorage,
    parseWindowsStorage
} = require('../src/storageMedia.js')

test('identifie les types de support Windows connus', () => {
    assert.equal(classifyMediaType('SSD'), 'ssd')
    assert.equal(classifyMediaType('HDD'), 'hdd')
    assert.equal(classifyMediaType('Unspecified'), 'unknown')
    assert.equal(classifyExternalBus('USB'), true)
    assert.equal(classifyExternalBus('NVMe'), false)
})

test('analyse le résultat de la détection Windows', () => {
    assert.deepEqual(
        parseWindowsStorage('{"MediaType":"SSD","BusType":"NVMe"}'),
        { type: 'ssd', external: false }
    )
    assert.deepEqual(
        parseWindowsStorage('{"MediaType":"HDD","BusType":"USB"}'),
        { type: 'hdd', external: true }
    )
})

test('analyse les informations plist de macOS', () => {
    const internalSsd = `
        <plist><dict>
            <key>SolidState</key><true/>
            <key>Internal</key><true/>
        </dict></plist>
    `
    const externalHdd = `
        <plist><dict>
            <key>SolidState</key><false/>
            <key>Internal</key><false/>
        </dict></plist>
    `

    assert.deepEqual(parseMacStorage(internalSsd), { type: 'ssd', external: false })
    assert.deepEqual(parseMacStorage(externalHdd), { type: 'hdd', external: true })
})

test('analyse uniquement les disques physiques remontés par lsblk', () => {
    assert.deepEqual(
        parseLinuxStorage('part 0 nvme\ndisk 0 nvme\n'),
        { type: 'ssd', external: false }
    )
    assert.deepEqual(
        parseLinuxStorage('crypt 0\npart 1 usb\ndisk 1 usb\n'),
        { type: 'hdd', external: true }
    )
    assert.deepEqual(
        parseLinuxStorage('disk 0 sata\ndisk 1 sata\n'),
        { type: 'unknown', external: false }
    )
    assert.deepEqual(parseLinuxStorage('loop 0\n'), { type: 'unknown', external: null })
})
