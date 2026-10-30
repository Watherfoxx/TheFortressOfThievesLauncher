const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const yaml = require('js-yaml')
const { version } = require('../package.json')
const { mergeMacUpdateMetadata } = require('../scripts/merge-mac-update-metadata.js')
const { resolveFiles, findFile } = require('electron-updater/out/providers/Provider.js')
const { getLatestReleaseAsset } = require('../src/releaseAsset.js')

async function setup(t) {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fortress-mac-metadata-'))
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }))
    const infos = {}
    for (const arch of ['arm64', 'x64']) {
        const files = ['zip', 'dmg'].map(format => ({
            url: `The-Fortress-Of-Thieves-mac-${arch}.${format}`, sha512: `fixture-${arch}-${format}`, size: 4
        }))
        for (const file of files) await fs.promises.writeFile(path.join(root, file.url), 'data')
        infos[arch] = {
            version, files, path: files[0].url, sha512: files[0].sha512,
            releaseDate: '2026-10-30T00:00:00.000Z', releaseNotes: 'Notes\nWith a second line'
        }
        await fs.promises.writeFile(path.join(root, `latest-mac-${arch}.yml`), yaml.dump(infos[arch]))
    }
    const write = (arch, info) => fs.promises.writeFile(path.join(root, `latest-mac-${arch}.yml`), yaml.dump(info))
    return { root, infos, write }
}

test('fusionne les deux architectures sans perdre leurs fichiers ni empreintes', async t => {
    const { root, infos } = await setup(t)
    const result = mergeMacUpdateMetadata(root)
    const saved = yaml.load(await fs.promises.readFile(path.join(root, 'latest-mac.yml'), 'utf8'))
    assert.deepEqual(saved, result)
    assert.equal(saved.version, version)
    assert.equal(saved.releaseNotes, infos.arm64.releaseNotes)
    assert.equal(saved.files.length, 4)
    assert.deepEqual(saved.files.map(entry => entry.sha512), [
        'fixture-arm64-zip', 'fixture-x64-zip', 'fixture-arm64-dmg', 'fixture-x64-dmg'
    ])
    assert.equal(saved.path, 'The-Fortress-Of-Thieves-mac-arm64.zip')
    assert.equal(saved.sha512, 'fixture-arm64-zip')
    for (const arch of ['arm64', 'x64']) assert.equal(fs.existsSync(path.join(root, `latest-mac-${arch}.yml`)), false)
    assert.equal((await fs.promises.readdir(root)).length, 5)
})

test('le format fusionné permet à l’updater de sélectionner le ZIP de chaque architecture', async t => {
    const { root } = await setup(t)
    const merged = mergeMacUpdateMetadata(root)
    const resolved = resolveFiles(merged, new URL('https://example.invalid/releases/'))
    for (const arch of ['arm64', 'x64']) {
        const compatible = resolved.filter(file => file.url.pathname.includes(`-${arch}.`))
        assert.equal(findFile(compatible, 'zip', ['pkg', 'dmg']).info.url, `The-Fortress-Of-Thieves-mac-${arch}.zip`)
        const assets = merged.files.map(file => ({ name: file.url }))
        assert.equal(getLatestReleaseAsset(assets, { os: 'mac', format: '.dmg', architecture: arch }).name,
            `The-Fortress-Of-Thieves-mac-${arch}.dmg`)
    }
})

for (const problem of ['version', 'missing-architecture', 'missing-file', 'incomplete-file', 'no-zip', 'no-dmg', 'wrong-arch', 'no-hash', 'duplicate']) {
    test(`bloque la publication pour des métadonnées Mac incorrectes : ${problem}`, async t => {
        const { root, infos, write } = await setup(t)
        const info = infos.x64
        if (problem === 'version') info.version = '0.0.0'
        if (problem === 'missing-architecture') await fs.promises.unlink(path.join(root, 'latest-mac-x64.yml'))
        if (problem === 'missing-file') await fs.promises.unlink(path.join(root, info.files[0].url))
        if (problem === 'incomplete-file') await fs.promises.writeFile(path.join(root, info.files[0].url), 'x')
        if (problem === 'no-zip') info.files = info.files.filter(file => !file.url.endsWith('.zip'))
        if (problem === 'no-dmg') info.files = info.files.filter(file => !file.url.endsWith('.dmg'))
        if (problem === 'wrong-arch') info.files[0] = infos.arm64.files[0]
        if (problem === 'no-hash') delete info.files[0].sha512
        if (problem === 'duplicate') info.files.push(info.files[0])
        if (problem !== 'missing-architecture') await write('x64', info)
        assert.throws(() => mergeMacUpdateMetadata(root))
        assert.equal(fs.existsSync(path.join(root, 'latest-mac.yml')), false)
        assert.equal(fs.existsSync(path.join(root, 'latest-mac-arm64.yml')), true)
    })
}

test('les quatre jobs ont des noms d’artefacts distincts et ne se dépendent pas entre eux', () => {
    const workflow = yaml.load(fs.readFileSync(path.join(__dirname, '../.github/workflows/build.yml'), 'utf8'))
    const job = workflow.jobs['build-launcher']
    const matrix = job.strategy.matrix.include
    assert.equal(matrix.length, 4)
    assert.deepEqual(matrix.filter(entry => entry.platform === 'mac').map(entry => entry.arch), ['arm64', 'x64'])
    assert.equal(job.needs, 'create_release')
    assert.equal(job.strategy['max-parallel'], undefined)
    assert.ok(job.steps.find(step => step.name === 'Build').env.MAC_BUILD_ARCH.includes('matrix.arch'))
    const upload = job.steps.find(step => step.uses?.startsWith('actions/upload-artifact'))
    assert.equal(upload.with.name, 'release-${{ matrix.platform }}-${{ matrix.arch }}')
    assert.equal(new Set(matrix.map(entry => `${entry.platform}-${entry.arch}`)).size, 4)
    const isolate = job.steps.find(step => step.name === 'Isolate macOS update metadata')
    assert.equal(isolate.if, "matrix.platform == 'mac'")
    assert.ok(isolate.run.includes('latest-mac-${{ matrix.arch }}.yml'))
    const publishing = workflow.jobs['publish-release']
    assert.deepEqual(publishing.needs, ['create_release', 'build-launcher'])
    const mergeIndex = publishing.steps.findIndex(step => step.name === 'Merge macOS update metadata')
    const verifyIndex = publishing.steps.findIndex(step => step.name === 'Verify collected release files')
    const uploadIndex = publishing.steps.findIndex(step => step.name === 'Upload all release files')
    assert.ok(mergeIndex >= 0 && mergeIndex < verifyIndex && verifyIndex < uploadIndex)
})

test('la commande de fusion utilisée dans GitHub écrit les métadonnées finales', async t => {
    const { root } = await setup(t)
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/merge-mac-update-metadata.js'), root], {
        encoding: 'utf8', windowsHide: true
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /4 fichiers/)
    const merged = yaml.load(await fs.promises.readFile(path.join(root, 'latest-mac.yml'), 'utf8'))
    assert.equal(merged.files.length, 4)
})

test('la dépendance YAML des outils de publication est déclarée et verrouillée', () => {
    const pkg = require('../package.json')
    const lock = require('../package-lock.json')
    assert.equal(pkg.devDependencies['js-yaml'], '4.1.1')
    assert.deepEqual(lock.packages[''].devDependencies, pkg.devDependencies)
    assert.equal(lock.packages['node_modules/js-yaml'].version, pkg.devDependencies['js-yaml'])
})
