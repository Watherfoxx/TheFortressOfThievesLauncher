const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
    GameDirectoryMigrationManager
} = require('../src/gameDirectory.js')

async function createWorkspace(t) {
    const workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fortress-game-directory-'))
    t.after(async () => {
        await fs.promises.rm(workspace, { recursive: true, force: true })
    })
    return workspace
}

async function createSource(workspace) {
    const sourcePath = path.join(workspace, 'source', '.TheFortressOfThieves')
    await fs.promises.mkdir(path.join(sourcePath, 'instances', 'main', 'saves', 'world'), { recursive: true })
    await fs.promises.mkdir(path.join(sourcePath, 'empty-directory'), { recursive: true })
    await fs.promises.writeFile(path.join(sourcePath, 'runtime.txt'), 'java-runtime')
    await fs.promises.writeFile(
        path.join(sourcePath, 'instances', 'main', 'saves', 'world', 'level.dat'),
        'player-world'
    )
    return sourcePath
}

test('migre tout le contenu puis supprime la source au commit', async t => {
    const workspace = await createWorkspace(t)
    const sourcePath = await createSource(workspace)
    const destinationPath = path.join(workspace, 'destination', '.TheFortressOfThieves')
    const manager = new GameDirectoryMigrationManager()
    const progressEvents = []

    const migration = await manager.migrate(
        { sourcePath, destinationPath },
        progress => progressEvents.push(progress)
    )

    assert.equal(await fs.promises.readFile(path.join(destinationPath, 'runtime.txt'), 'utf8'), 'java-runtime')
    assert.equal(
        await fs.promises.readFile(
            path.join(destinationPath, 'instances', 'main', 'saves', 'world', 'level.dat'),
            'utf8'
        ),
        'player-world'
    )
    assert.equal((await fs.promises.stat(path.join(destinationPath, 'empty-directory'))).isDirectory(), true)
    assert.equal(progressEvents.at(-1).copiedFiles, 2)

    const commit = await manager.commit(migration.transactionId)
    assert.equal(commit.sourceRemoved, true)
    assert.equal(fs.existsSync(sourcePath), false)
    assert.equal(fs.existsSync(destinationPath), true)
})

test('un rollback conserve la source et supprime uniquement la copie', async t => {
    const workspace = await createWorkspace(t)
    const sourcePath = await createSource(workspace)
    const destinationPath = path.join(workspace, 'destination', '.TheFortressOfThieves')
    const manager = new GameDirectoryMigrationManager()

    const migration = await manager.migrate({ sourcePath, destinationPath })
    await manager.rollback(migration.transactionId)

    assert.equal(fs.existsSync(sourcePath), true)
    assert.equal(fs.existsSync(destinationPath), false)
})

test('configure un nouvel emplacement lorsque le jeu n’a jamais été téléchargé', async t => {
    const workspace = await createWorkspace(t)
    const sourcePath = path.join(workspace, 'source-absente', '.TheFortressOfThieves')
    const destinationParent = path.join(workspace, 'destination-existante')
    const destinationPath = path.join(destinationParent, '.TheFortressOfThieves')
    const manager = new GameDirectoryMigrationManager()

    await fs.promises.mkdir(destinationParent, { recursive: true })

    const migration = await manager.migrate({ sourcePath, destinationPath })

    assert.equal(migration.sourceExisted, false)
    assert.equal(migration.totalFiles, 0)
    assert.equal(migration.totalBytes, 0)
    assert.equal((await fs.promises.stat(destinationPath)).isDirectory(), true)

    const commit = await manager.commit(migration.transactionId)
    assert.equal(commit.sourceRemoved, true)
    assert.equal(fs.existsSync(sourcePath), false)
    assert.equal(fs.existsSync(destinationPath), true)
})

test('refuse d’écraser un dossier de destination non vide', async t => {
    const workspace = await createWorkspace(t)
    const sourcePath = await createSource(workspace)
    const destinationPath = path.join(workspace, 'destination', '.TheFortressOfThieves')
    const manager = new GameDirectoryMigrationManager()

    await fs.promises.mkdir(destinationPath, { recursive: true })
    await fs.promises.writeFile(path.join(destinationPath, 'keep.txt'), 'do-not-overwrite')

    await assert.rejects(
        manager.migrate({ sourcePath, destinationPath }),
        error => error.code === 'DESTINATION_NOT_EMPTY'
    )
    assert.equal(await fs.promises.readFile(path.join(destinationPath, 'keep.txt'), 'utf8'), 'do-not-overwrite')
    assert.equal(fs.existsSync(sourcePath), true)
})

test('refuse une destination imbriquée dans le dossier source', async t => {
    const workspace = await createWorkspace(t)
    const sourcePath = await createSource(workspace)
    const destinationPath = path.join(sourcePath, 'nested', '.TheFortressOfThieves')
    const manager = new GameDirectoryMigrationManager()

    await assert.rejects(
        manager.migrate({ sourcePath, destinationPath }),
        error => error.code === 'NESTED_PATH'
    )
})

test('annule la suppression si la source change avant le commit', async t => {
    const workspace = await createWorkspace(t)
    const sourcePath = await createSource(workspace)
    const destinationPath = path.join(workspace, 'destination', '.TheFortressOfThieves')
    const manager = new GameDirectoryMigrationManager()

    const migration = await manager.migrate({ sourcePath, destinationPath })
    await fs.promises.writeFile(path.join(sourcePath, 'new-save.txt'), 'new player data')

    await assert.rejects(
        manager.commit(migration.transactionId),
        error => error.code === 'SOURCE_CHANGED'
    )
    assert.equal(fs.existsSync(sourcePath), true)
    assert.equal(fs.existsSync(destinationPath), true)

    const rollback = await manager.rollback(migration.transactionId)
    assert.equal(rollback.destinationPreserved, false)
    assert.equal(fs.existsSync(destinationPath), false)
})

test('annule la suppression si la destination change avant le commit', async t => {
    const workspace = await createWorkspace(t)
    const sourcePath = await createSource(workspace)
    const destinationPath = path.join(workspace, 'destination', '.TheFortressOfThieves')
    const manager = new GameDirectoryMigrationManager()

    const migration = await manager.migrate({ sourcePath, destinationPath })
    await fs.promises.rename(
        path.join(destinationPath, 'runtime.txt'),
        path.join(destinationPath, 'unexpected-name.txt')
    )

    await assert.rejects(
        manager.commit(migration.transactionId),
        error => error.code === 'DESTINATION_CHANGED'
    )
    assert.equal(fs.existsSync(sourcePath), true)

    const rollback = await manager.rollback(migration.transactionId)
    assert.equal(rollback.destinationPreserved, true)
    assert.equal(fs.existsSync(destinationPath), true)
})
