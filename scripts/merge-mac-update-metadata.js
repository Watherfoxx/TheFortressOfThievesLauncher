const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')
const { version } = require('../package.json')

function mergeMacUpdateMetadata(directory, expectedVersion = version) {
    const root = path.resolve(directory)
    const architectures = ['arm64', 'x64']
    const inputs = architectures.map(arch => path.join(root, `latest-mac-${arch}.yml`))
    const metadata = inputs.map(file => yaml.load(fs.readFileSync(file, 'utf8'), { schema: yaml.JSON_SCHEMA }))
    const files = []
    const names = new Set()
    for (const [index, info] of metadata.entries()) {
        const arch = architectures[index]
        if (info?.version !== expectedVersion || !Array.isArray(info.files)) {
            throw new Error(`Métadonnées Mac ${arch} invalides ou de mauvaise version`)
        }
        for (const entry of info.files) {
            const name = entry?.url
            // Generated artifact names are plain filenames, never remote URLs
            // or paths outside the release directory.
            if (typeof name !== 'string' || !/^[\w.-]+$/.test(name)
                || (!name.endsWith(`-${arch}.zip`) && !name.endsWith(`-${arch}.dmg`))) {
                throw new Error(`Fichier Mac ${arch} invalide : ${name}`)
            }
            if (names.has(name)) throw new Error(`Fichier Mac dupliqué : ${name}`)
            const stat = fs.statSync(path.join(root, name))
            if (!stat.isFile() || !stat.size || stat.size !== entry.size || typeof entry.sha512 !== 'string' || !entry.sha512) {
                throw new Error(`Fichier Mac absent, incomplet ou sans empreinte : ${name}`)
            }
            names.add(name)
            files.push({ ...entry })
        }
        for (const format of ['zip', 'dmg']) {
            if (!info.files.some(entry => entry.url.endsWith(`-${arch}.${format}`))) {
                throw new Error(`Fichier Mac ${arch} ${format} manquant`)
            }
        }
    }
    // As in electron-builder's combined output, ZIPs come first. The updater
    // selects the appropriate architecture from files[], not from the fallback path.
    files.sort((a, b) => Number(b.url.endsWith('.zip')) - Number(a.url.endsWith('.zip')))
    const primary = files[0]
    const merged = { ...metadata[0], files, path: primary.url, sha512: primary.sha512 }
    const destination = path.join(root, 'latest-mac.yml')
    // Leave the individual inputs intact on failure; remove them only after a
    // valid combined file has been written, so they aren't published as channels.
    fs.writeFileSync(destination, yaml.dump(merged, { lineWidth: -1, noRefs: true }))
    for (const input of inputs) fs.unlinkSync(input)
    return merged
}

if (require.main === module) {
    try {
        const merged = mergeMacUpdateMetadata(process.argv[2] || 'dist')
        console.log(`Métadonnées macOS fusionnées : ${merged.files.length} fichiers Intel / ARM64`)
    } catch (error) {
        console.error(`Fusion macOS impossible : ${error.message}`)
        process.exitCode = 1
    }
}

module.exports = { mergeMacUpdateMetadata }
