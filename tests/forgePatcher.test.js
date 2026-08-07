const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')

require('../src/assets/js/utils/downloader-retry.js')

const coreEntry = require.resolve('minecraft-java-core')
const coreDirectory = path.dirname(coreEntry)
const ForgePatcher = require(path.join(coreDirectory, 'Minecraft-Loader', 'patcher.js')).default
const Forge = require(path.join(coreDirectory, 'Minecraft-Loader', 'loader', 'forge', 'forge.js')).default
const Loader = require(path.join(coreDirectory, 'Minecraft-Loader', 'index.js')).default

test('un processus Forge non nul remonte une erreur sans exception EventEmitter', async () => {
    const patcher = new ForgePatcher({ path: process.cwd() })
    const errors = []

    patcher.on('error', error => errors.push(error))
    patcher.readJarManifest = async () => 'example.invalid.Main'

    const result = await patcher.patcher({
        processors: [{
            jar: 'example:invalid-processor:1.0.0',
            classpath: [],
            args: [],
            sides: ['client']
        }]
    }, {
        java: process.execPath,
        minecraft: 'minecraft.jar',
        minecraftJson: 'minecraft.json'
    })

    assert.equal(typeof result.error, 'string')
    assert.match(result.error, /patcher Forge|démarrer Java/i)
    assert.equal(errors.length, 1)
})

test('Forge convertit une erreur du patcher en résultat contrôlé', async t => {
    const originalCheck = ForgePatcher.prototype.check
    const originalPatcher = ForgePatcher.prototype.patcher

    t.after(() => {
        ForgePatcher.prototype.check = originalCheck
        ForgePatcher.prototype.patcher = originalPatcher
    })

    ForgePatcher.prototype.check = () => false
    ForgePatcher.prototype.patcher = async function simulatedFailure() {
        const message = 'Échec Forge simulé'
        this.emit('error', message)
        return { error: message }
    }

    const forge = new Forge({
        loader: {
            config: {
                javaPath: process.execPath,
                minecraftJar: 'minecraft.jar',
                minecraftJson: 'minecraft.json'
            }
        }
    })
    const result = await forge.patchForge({ processors: [{}] })

    assert.deepEqual(result, { error: 'Échec Forge simulé' })
})

test('les erreurs objet du loader deviennent de vraies instances Error', () => {
    const loader = new Loader({})
    let receivedError = null

    loader.on('error', error => {
        receivedError = error
    })
    loader.emit('error', { error: 'Installation Forge impossible', details: 'code 127' })

    assert.equal(receivedError instanceof Error, true)
    assert.equal(receivedError.message, 'Installation Forge impossible')
    assert.equal(receivedError.details, 'code 127')
})
