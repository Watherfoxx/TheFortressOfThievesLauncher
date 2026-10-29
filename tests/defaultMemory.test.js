const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const JavaScriptObfuscator = require('javascript-obfuscator')
const obfuscatorOptions = require('../obfuscator-options.js')

const source = fs.readFileSync(path.join(__dirname, '../src/assets/js/launcher.js'), 'utf8')
    .replace(/^import .*$/gm, '')
    .replace('new Launcher().init();', 'globalThis.Launcher = Launcher;')

function setup(totalGiB, existingConfig, obfuscated = false) {
    let detected = 0
    const context = vm.createContext({
        require: name => name === 'os' ? {
            totalmem: () => { detected++; return totalGiB * 1073741824 },
            freemem: () => { throw new Error('Free memory must not affect the default') }
        } : {},
        console
    })
    vm.runInContext(obfuscated ? JavaScriptObfuscator.obfuscate(source, obfuscatorOptions).getObfuscatedCode() : source, context)
    const launcher = new context.Launcher()
    let config = existingConfig
    let creations = 0
    launcher.db = {
        readData: async () => config,
        createData: async (table, data) => { creations++; config = JSON.parse(JSON.stringify(data)) },
        updateData: async (table, data) => { config = JSON.parse(JSON.stringify(data)) }
    }
    return { launcher, getConfig: () => config, getDetections: () => detected, getCreations: () => creations }
}

for (const [total, max] of [[8, 4], [7.7, 4], [6, 4], [4, 2], [2, 1], [12, 6], [16, 6], [32, 6]]) {
    test(`premier démarrage avec ${total} Go : maximum de ${max} Go`, async () => {
        const state = setup(total)
        await state.launcher.initConfigClient()
        assert.deepEqual(state.getConfig().java_config.java_memory, { min: Math.min(3, max), max })
        assert.equal(state.getDetections(), 1)
        assert.equal(state.getCreations(), 1)
    })
}

test('conserve le choix RAM d’un joueur existant, même sur une machine de 8 Go', async () => {
    const state = setup(8, {
        java_config: { java_memory: { min: 1, max: 5 } },
        launcher_config: { game_directory: null, intelEnabledMac: false }
    })
    await state.launcher.initConfigClient()
    assert.deepEqual(state.getConfig().java_config.java_memory, { min: 1, max: 5 })
    assert.equal(state.getDetections(), 0)
    assert.equal(state.getCreations(), 0)
})

test('ne recalcule pas la RAM au deuxième démarrage', async () => {
    const state = setup(8)
    await state.launcher.initConfigClient()
    state.getConfig().java_config.java_memory = { min: 2, max: 3 }
    await state.launcher.initConfigClient()
    assert.deepEqual(state.getConfig().java_config.java_memory, { min: 2, max: 3 })
    assert.equal(state.getDetections(), 1)
    assert.equal(state.getCreations(), 1)
})

test('la version obfusquée initialise également 4 Go sur une machine de 8 Go', async () => {
    const state = setup(8, undefined, true)
    await state.launcher.initConfigClient()
    assert.deepEqual(state.getConfig().java_config.java_memory, { min: 3, max: 4 })
})
