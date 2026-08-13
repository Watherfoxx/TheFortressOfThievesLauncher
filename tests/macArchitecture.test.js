const test = require('node:test')
const assert = require('node:assert/strict')

const {
    getMacHardwareArchitecture,
    isMacJavaExecutableCompatible
} = require('../src/macArchitecture.js')
const { getLatestReleaseAsset } = require('../src/releaseAsset.js')

test('conserve arm64 pour un launcher macOS natif Apple Silicon', () => {
    assert.equal(getMacHardwareArchitecture({
        platform: 'darwin',
        runtimeArchitecture: 'arm64'
    }), 'arm64')
})

test('détecte Apple Silicon même si le launcher courant tourne sous Rosetta', () => {
    assert.equal(getMacHardwareArchitecture({
        platform: 'darwin',
        runtimeArchitecture: 'x64',
        runSysctl: () => '1\n'
    }), 'arm64')
})

test('conserve x64 sur un véritable Mac Intel', () => {
    assert.equal(getMacHardwareArchitecture({
        platform: 'darwin',
        runtimeArchitecture: 'x64',
        runSysctl: () => '0\n'
    }), 'x64')
})

test('sélectionne le DMG arm64 et jamais le DMG Intel sur Apple Silicon', () => {
    const assets = [
        { name: 'The-Fortress-Of-Thieves-mac-x64.dmg', created_at: '2026-08-13T10:00:00Z' },
        { name: 'The-Fortress-Of-Thieves-mac-arm64.dmg', created_at: '2026-08-13T09:00:00Z' }
    ]

    assert.equal(getLatestReleaseAsset(assets, {
        os: 'mac',
        format: '.dmg',
        architecture: 'arm64'
    }).name, 'The-Fortress-Of-Thieves-mac-arm64.dmg')
})

test('refuse un ancien Java Intel dans le cache du launcher ARM64', () => {
    assert.equal(isMacJavaExecutableCompatible('/runtime/bin/java', {
        platform: 'darwin',
        runtimeArchitecture: 'arm64',
        inspectBinary: () => 'Mach-O 64-bit executable x86_64\n'
    }), false)
})

test('accepte Zulu Java ARM64 dans le cache du launcher ARM64', () => {
    assert.equal(isMacJavaExecutableCompatible('/runtime/bin/java', {
        platform: 'darwin',
        runtimeArchitecture: 'arm64',
        inspectBinary: () => 'Mach-O 64-bit executable arm64\n'
    }), true)
})
