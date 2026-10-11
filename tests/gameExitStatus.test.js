const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

require('../src/assets/js/utils/downloader-retry.js')
const { Launch } = require('minecraft-java-core')
const coreDirectory = path.dirname(require.resolve('minecraft-java-core'))
const MinecraftArguments = require(path.join(coreDirectory, 'Minecraft/Minecraft-Arguments.js')).default
const MinecraftLoader = require(path.join(coreDirectory, 'Minecraft/Minecraft-Loader.js')).default

for (const exitCode of [0, 1]) {
    test(`transmet le vrai code de sortie ${exitCode} et le PID du jeu`, async t => {
        const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tfot-exit-status-'))
        const originalArguments = MinecraftArguments.prototype.GetArguments
        const originalLoaderArguments = MinecraftLoader.prototype.GetArguments
        t.after(async () => {
            MinecraftArguments.prototype.GetArguments = originalArguments
            MinecraftLoader.prototype.GetArguments = originalLoaderArguments
            await fs.promises.rm(root, { recursive: true, force: true })
        })
        MinecraftArguments.prototype.GetArguments = async () => ({
            jvm: [], classpath: [], mainClass: '-e', game: [`console.log('fixture-output');process.exit(${exitCode})`]
        })
        MinecraftLoader.prototype.GetArguments = async () => ({ jvm: [], game: [] })
        const launch = new Launch()
        launch.options = { path: root, java: { path: process.execPath }, loader: { path: 'loader' }, authenticator: {}, detached: false }
        launch.DownloadGame = async () => ({ minecraftJava: { path: process.execPath } })
        const errors = []
        const output = []
        let pid
        launch.on('game-process', data => { pid = data.pid })
        launch.on('error', error => errors.push(error))
        launch.on('data', data => output.push(data))
        const closed = new Promise(resolve => launch.once('close', (code, signal) => resolve({ code, signal })))
        const child = await launch.start()
        assert.equal(errors.length, 0, JSON.stringify(errors))
        assert.equal(pid, child.pid)
        assert.ok(Number.isInteger(pid) && pid > 0)
        assert.deepEqual(await closed, { code: exitCode, signal: null })
        assert.match(output.join(''), /fixture-output/)
        assert.equal(errors.length, 0)
    })
}
