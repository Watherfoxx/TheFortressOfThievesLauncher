const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const pkg = require('../package.json')

const source = fs.readFileSync(path.join(__dirname, '../build.js'), 'utf8')
    .replace(/new Index\(\)\.init\(\)\.catch\([\s\S]*$/, 'globalThis.Build = Index;')

function setup(platform = 'darwin', metadata = '') {
    const builds = []
    const context = vm.createContext({
        require: name => {
            if (name === 'electron-builder') return { build: async options => { builds.push(options) } }
            if (name === './package.json') return pkg
            if (name === 'fs') return { existsSync: () => true, readFileSync: () => metadata }
            return {}
        },
        process: { platform, env: { ELECTRON_BUILDER_PUBLISH: 'never' } },
        console: { log() {}, error() {} }
    })
    vm.runInContext(source, context)
    const build = new context.Build()
    // No real packaging, file deletion, webhook access, or release publishing.
    build.Obfuscate = async () => {}
    return { build, builds }
}

function updateMetadata(file, version = pkg.version) {
    return `version: ${version}\nfiles:\n  - url: ${file}\n    sha512: fixture-sha512\n    size: 123\npath: ${file}\nsha512: fixture-sha512\n`
}

test('build Mac limité au DMG et au ZIP ARM64 avec une compression normale', async () => {
    const { build, builds } = setup('darwin', updateMetadata('The-Fortress-Of-Thieves-mac-arm64.zip'))
    await build.buildPlatform()
    assert.equal(builds.length, 1)
    const options = JSON.parse(JSON.stringify(builds[0]))
    assert.equal(options.config.compression, 'normal')
    assert.deepEqual(options.config.mac.target, [
        { target: 'dmg', arch: 'arm64' },
        { target: 'zip', arch: 'arm64' }
    ])
    assert.equal(options.publish, 'never')
    assert.deepEqual(options.config.win.target, [{ target: 'nsis', arch: 'x64' }])
    assert.deepEqual(options.config.linux.target.map(target => target.target), ['AppImage', 'deb', 'tar.gz', 'zip'])
})

test('le build accepte les métadonnées ARM64 requises par la publication', () => {
    const { build } = setup('darwin', updateMetadata('The-Fortress-Of-Thieves-mac-arm64.zip'))
    assert.doesNotThrow(() => build.verifyUpdateMetadata())
})

for (const file of ['The-Fortress-Of-Thieves-mac-x64.zip', 'The-Fortress-Of-Thieves-mac-arm64.dmg']) {
    test(`ne valide pas un mauvais fichier de mise à jour Mac : ${file}`, () => {
        const { build } = setup('darwin', updateMetadata(file))
        assert.throws(() => build.verifyUpdateMetadata(), /bon artefact/)
    })
}

test('les métadonnées Windows et Linux restent compatibles', () => {
    for (const [platform, file] of [['win32', 'The-Fortress-Of-Thieves-win-x64.exe'], ['linux', 'The-Fortress-Of-Thieves-linux-x64.AppImage']]) {
        const { build } = setup(platform, updateMetadata(file))
        assert.doesNotThrow(() => build.verifyUpdateMetadata())
    }
})

test('la validation de version des métadonnées est conservée', () => {
    const { build } = setup('darwin', updateMetadata('The-Fortress-Of-Thieves-mac-arm64.zip', '0.0.0'))
    assert.throws(() => build.verifyUpdateMetadata(), /ne référence pas la version/)
})
