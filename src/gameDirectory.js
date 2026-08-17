const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

class GameDirectoryError extends Error {
    constructor(code, message) {
        super(message)
        this.name = 'GameDirectoryError'
        this.code = code
    }
}

function comparablePath(targetPath) {
    const resolvedPath = path.resolve(targetPath)
    return process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath
}

function isPathInside(parentPath, candidatePath) {
    const relativePath = path.relative(path.resolve(parentPath), path.resolve(candidatePath))
    return relativePath !== ''
        && relativePath !== '..'
        && !relativePath.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relativePath)
}

async function pathExists(targetPath) {
    try {
        await fs.promises.access(targetPath)
        return true
    } catch {
        return false
    }
}

async function ensureDirectoryExists(directoryPath) {
    try {
        const stats = await fs.promises.stat(directoryPath)
        if (!stats.isDirectory()) {
            throw new GameDirectoryError(
                'PARENT_NOT_DIRECTORY',
                'Le dossier parent de l’emplacement choisi n’est pas un dossier.'
            )
        }
    } catch (error) {
        if (error.code !== 'ENOENT') throw error
        await fs.promises.mkdir(directoryPath, { recursive: true })
    }
}

async function buildManifest(rootPath) {
    if (!await pathExists(rootPath)) return []

    const manifest = []

    async function visit(relativeDirectory = '') {
        const absoluteDirectory = path.join(rootPath, relativeDirectory)
        const entries = await fs.promises.readdir(absoluteDirectory, { withFileTypes: true })

        for (const entry of entries) {
            const relativePath = path.join(relativeDirectory, entry.name)
            const absolutePath = path.join(rootPath, relativePath)
            const stats = await fs.promises.lstat(absolutePath)

            if (stats.isSymbolicLink()) {
                throw new GameDirectoryError(
                    'UNSUPPORTED_LINK',
                    `Le dossier contient un lien symbolique non déplaçable de façon sûre : ${relativePath}`
                )
            }

            if (stats.isDirectory()) {
                manifest.push({ type: 'directory', relativePath, mode: stats.mode, mtimeMs: stats.mtimeMs })
                await visit(relativePath)
                continue
            }

            if (!stats.isFile()) {
                throw new GameDirectoryError(
                    'UNSUPPORTED_ENTRY',
                    `Le dossier contient un élément non pris en charge : ${relativePath}`
                )
            }

            manifest.push({
                type: 'file',
                relativePath,
                size: stats.size,
                mode: stats.mode,
                mtimeMs: stats.mtimeMs
            })
        }
    }

    await visit()
    return manifest
}

function manifestsMatch(expectedManifest, currentManifest, compareModificationTime = false) {
    if (expectedManifest.length !== currentManifest.length) return false

    const currentEntries = new Map(currentManifest.map(entry => [entry.relativePath, entry]))
    return expectedManifest.every(expectedEntry => {
        const currentEntry = currentEntries.get(expectedEntry.relativePath)
        if (!currentEntry || currentEntry.type !== expectedEntry.type) return false
        if (expectedEntry.type !== 'file') return true

        return currentEntry.size === expectedEntry.size
            && (!compareModificationTime || currentEntry.mtimeMs === expectedEntry.mtimeMs)
    })
}

async function ensureDestinationIsAvailable(destinationPath) {
    if (!await pathExists(destinationPath)) return

    const stats = await fs.promises.lstat(destinationPath)
    if (!stats.isDirectory()) {
        throw new GameDirectoryError(
            'DESTINATION_NOT_DIRECTORY',
            'Un fichier existe déjà à l’emplacement choisi.'
        )
    }

    const entries = await fs.promises.readdir(destinationPath)
    if (entries.length > 0) {
        throw new GameDirectoryError(
            'DESTINATION_NOT_EMPTY',
            'Le dossier de destination existe déjà et n’est pas vide. Choisissez un autre emplacement.'
        )
    }

    await fs.promises.rmdir(destinationPath)
}

async function checkFreeSpace(destinationParent, requiredBytes) {
    if (typeof fs.promises.statfs !== 'function' || requiredBytes === 0) return

    try {
        const stats = await fs.promises.statfs(destinationParent)
        const availableBytes = Number(stats.bavail) * Number(stats.bsize)
        if (Number.isFinite(availableBytes) && availableBytes < requiredBytes) {
            throw new GameDirectoryError(
                'NOT_ENOUGH_SPACE',
                'L’espace disponible sur le disque de destination est insuffisant.'
            )
        }
    } catch (error) {
        if (error instanceof GameDirectoryError) throw error
        // Certains systèmes de fichiers ne fournissent pas cette information.
    }
}

async function copyManifest(sourcePath, stagingPath, manifest, onProgress) {
    const files = manifest.filter(entry => entry.type === 'file')
    const totalBytes = files.reduce((total, entry) => total + entry.size, 0)
    let copiedBytes = 0
    let copiedFiles = 0

    await fs.promises.mkdir(stagingPath, { recursive: false })

    for (const entry of manifest.filter(item => item.type === 'directory')) {
        await fs.promises.mkdir(path.join(stagingPath, entry.relativePath), { recursive: true })
    }

    onProgress?.({ copiedBytes, totalBytes, copiedFiles, totalFiles: files.length, currentFile: null })

    for (const entry of files) {
        const sourceFile = path.join(sourcePath, entry.relativePath)
        const destinationFile = path.join(stagingPath, entry.relativePath)

        await fs.promises.mkdir(path.dirname(destinationFile), { recursive: true })
        await fs.promises.copyFile(sourceFile, destinationFile, fs.constants.COPYFILE_EXCL)

        const copiedStats = await fs.promises.stat(destinationFile)
        const currentSourceStats = await fs.promises.stat(sourceFile)
        if (
            copiedStats.size !== entry.size
            || currentSourceStats.size !== entry.size
            || currentSourceStats.mtimeMs !== entry.mtimeMs
        ) {
            throw new GameDirectoryError(
                'SOURCE_CHANGED',
                `Le fichier a changé pendant la migration : ${entry.relativePath}`
            )
        }

        try {
            await fs.promises.chmod(destinationFile, entry.mode)
            await fs.promises.utimes(destinationFile, copiedStats.atime, new Date(entry.mtimeMs))
        } catch {
            // Les métadonnées ne sont pas indispensables au fonctionnement sous Windows.
        }

        copiedBytes += entry.size
        copiedFiles++
        onProgress?.({
            copiedBytes,
            totalBytes,
            copiedFiles,
            totalFiles: files.length,
            currentFile: entry.relativePath
        })
    }

    const copiedManifest = await buildManifest(stagingPath)
    if (copiedManifest.length !== manifest.length) {
        throw new GameDirectoryError('VERIFICATION_FAILED', 'La vérification de la copie a échoué.')
    }

    const copiedEntries = new Map(copiedManifest.map(entry => [entry.relativePath, entry]))
    for (const sourceEntry of manifest) {
        const copiedEntry = copiedEntries.get(sourceEntry.relativePath)
        if (
            !copiedEntry
            || copiedEntry.type !== sourceEntry.type
            || (sourceEntry.type === 'file' && copiedEntry.size !== sourceEntry.size)
        ) {
            throw new GameDirectoryError(
                'VERIFICATION_FAILED',
                `La vérification a échoué pour : ${sourceEntry.relativePath}`
            )
        }
    }

    return { copiedBytes, copiedFiles, totalBytes, totalFiles: files.length }
}

class GameDirectoryMigrationManager {
    constructor() {
        this.transactions = new Map()
        this.migrationInProgress = false
    }

    isBusy() {
        return this.migrationInProgress || this.transactions.size > 0
    }

    validatePaths(sourcePath, destinationPath) {
        if (!sourcePath || !destinationPath) {
            throw new GameDirectoryError('INVALID_PATH', 'Le chemin source ou de destination est invalide.')
        }

        const resolvedSource = path.resolve(sourcePath)
        const resolvedDestination = path.resolve(destinationPath)

        if (comparablePath(resolvedSource) === comparablePath(resolvedDestination)) {
            throw new GameDirectoryError('SAME_PATH', 'Le jeu utilise déjà cet emplacement.')
        }

        if (isPathInside(resolvedSource, resolvedDestination) || isPathInside(resolvedDestination, resolvedSource)) {
            throw new GameDirectoryError(
                'NESTED_PATH',
                'Le dossier source et le dossier de destination ne peuvent pas être imbriqués.'
            )
        }

        if (path.parse(resolvedSource).root === resolvedSource || path.parse(resolvedDestination).root === resolvedDestination) {
            throw new GameDirectoryError('ROOT_PATH', 'La racine d’un disque ne peut pas être utilisée directement.')
        }

        return { sourcePath: resolvedSource, destinationPath: resolvedDestination }
    }

    async migrate({ sourcePath, destinationPath }, onProgress) {
        if (this.isBusy()) {
            throw new GameDirectoryError('MIGRATION_BUSY', 'Une migration est déjà en cours.')
        }

        const paths = this.validatePaths(sourcePath, destinationPath)
        const transactionId = crypto.randomUUID()
        const destinationParent = path.dirname(paths.destinationPath)
        const stagingPath = path.join(
            destinationParent,
            `.${path.basename(paths.destinationPath)}.migration-${transactionId}`
        )

        this.migrationInProgress = true
        let destinationCreated = false

        try {
            // Sous Windows, tenter de recréer une racine existante (par exemple D:\)
            // peut échouer avec EPERM. Ne créons le parent que s’il manque réellement.
            await ensureDirectoryExists(destinationParent)
            await ensureDestinationIsAvailable(paths.destinationPath)

            const sourceExisted = await pathExists(paths.sourcePath)
            const manifest = await buildManifest(paths.sourcePath)
            const totalBytes = manifest
                .filter(entry => entry.type === 'file')
                .reduce((total, entry) => total + entry.size, 0)

            await checkFreeSpace(destinationParent, totalBytes)
            const summary = await copyManifest(paths.sourcePath, stagingPath, manifest, onProgress)
            await fs.promises.rename(stagingPath, paths.destinationPath)
            destinationCreated = true

            this.transactions.set(transactionId, {
                ...paths,
                destinationCreated,
                summary,
                manifest,
                sourceExisted
            })

            return { transactionId, ...paths, ...summary, sourceExisted }
        } catch (error) {
            if (await pathExists(stagingPath)) {
                await fs.promises.rm(stagingPath, { recursive: true, force: true }).catch(() => {})
            }
            if (destinationCreated && await pathExists(paths.destinationPath)) {
                await fs.promises.rm(paths.destinationPath, { recursive: true, force: true }).catch(() => {})
            }
            throw error
        } finally {
            this.migrationInProgress = false
        }
    }

    getTransaction(transactionId) {
        const transaction = this.transactions.get(transactionId)
        if (!transaction) {
            throw new GameDirectoryError('UNKNOWN_TRANSACTION', 'Cette migration n’est plus valide.')
        }
        return transaction
    }

    async commit(transactionId) {
        const transaction = this.getTransaction(transactionId)

        const destinationManifest = await buildManifest(transaction.destinationPath)
        const destinationFiles = destinationManifest.filter(entry => entry.type === 'file')
        const destinationBytes = destinationFiles.reduce((total, entry) => total + entry.size, 0)
        if (
            !manifestsMatch(transaction.manifest, destinationManifest)
            || destinationFiles.length !== transaction.summary.totalFiles
            || destinationBytes !== transaction.summary.totalBytes
        ) {
            throw new GameDirectoryError(
                'DESTINATION_CHANGED',
                'Le dossier copié a changé avant la fin de la migration. L’ancien dossier a été conservé.'
            )
        }

        const currentSourceManifest = await buildManifest(transaction.sourcePath)
        if (!manifestsMatch(transaction.manifest, currentSourceManifest, true)) {
            throw new GameDirectoryError(
                'SOURCE_CHANGED',
                'L’ancien dossier a changé pendant la migration. Il a été conservé pour éviter toute perte.'
            )
        }

        this.transactions.delete(transactionId)

        try {
            if (await pathExists(transaction.sourcePath)) {
                await fs.promises.rm(transaction.sourcePath, { recursive: true, force: false })
            }
            return { sourceRemoved: true }
        } catch (error) {
            return {
                sourceRemoved: false,
                warning: `Le nouvel emplacement est actif, mais l’ancien dossier n’a pas pu être supprimé : ${error.message}`
            }
        }
    }

    async rollback(transactionId) {
        const transaction = this.getTransaction(transactionId)
        this.transactions.delete(transactionId)

        if (transaction.destinationCreated && await pathExists(transaction.destinationPath)) {
            const destinationManifest = await buildManifest(transaction.destinationPath)
            if (!manifestsMatch(transaction.manifest, destinationManifest)) {
                return { rolledBack: false, destinationPreserved: true }
            }
            await fs.promises.rm(transaction.destinationPath, { recursive: true, force: true })
        }

        return { rolledBack: true, destinationPreserved: false }
    }
}

module.exports = {
    GameDirectoryError,
    GameDirectoryMigrationManager,
    buildManifest,
    isPathInside,
    manifestsMatch
}
