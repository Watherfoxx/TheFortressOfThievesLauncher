const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '../src/assets/js/panels/home.js'), 'utf8')
    .replace(/^import .*$/gm, '')
    .replace('export default Home;', 'globalThis.Home = Home;')
const context = vm.createContext({
    require: name => ['fs', 'path', 'os', 'zlib', 'child_process'].includes(name) ? require(name) : {},
    process,
    Buffer,
    pkg: { name: 'test-launcher', version: 'test' },
    console,
    setTimeout,
    clearTimeout
})
vm.runInContext(source, context)

async function setup(t) {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tfot-native-crash-'))
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }))
    const home = new context.Home()
    const instancePath = path.join(root, 'instances', 'main')
    fs.mkdirSync(instancePath, { recursive: true })
    // Keep tests isolated from real Java reports on the computer.
    home.getNativeCrashReportPaths = instancePaths => [...instancePaths, root]
    const instancePaths = home.getInstanceReportPaths(root, 'main')
    const build = snapshot => home.buildCrashReport({
        exitCode: 1,
        baseDataPath: root,
        instanceName: 'main',
        instanceFolderName: 'main',
        authenticator: { name: 'Player' },
        options: {},
        crashReportSnapshot: snapshot
    })
    return { root, home, instancePath, instancePaths, build }
}

test('un nouveau hs_err déclenche la proposition d’envoi sans crash-report Minecraft', async t => {
    const { root, home, instancePaths, build } = await setup(t)
    const snapshot = home.createCrashReportSnapshot(instancePaths, root)
    fs.writeFileSync(path.join(root, 'hs_err_pid123.log'), 'EXCEPTION_ACCESS_VIOLATION\nProblematic frame: graphics.dll')
    const report = build(snapshot)
    assert.equal(report.hasCrashReport, true)
    assert.match(report.content, /Crash natif Java/)
    assert.match(report.content, /EXCEPTION_ACCESS_VIOLATION/)
})

test('les anciens hs_err et les fichiers log sans nom Java ne sont pas envoyés', async t => {
    const { root, home, instancePath, instancePaths, build } = await setup(t)
    fs.writeFileSync(path.join(instancePath, 'hs_err_pid456.log'), 'old fatal error')
    const snapshot = home.createCrashReportSnapshot(instancePaths, root)
    fs.writeFileSync(path.join(instancePath, 'unrelated.log'), 'unrelated')
    fs.mkdirSync(path.join(instancePath, 'hs_err_pid789.log'))
    const report = build(snapshot)
    assert.equal(report.hasCrashReport, false)
    assert.doesNotMatch(report.content, /old fatal error|unrelated/)
})

test('un hs_err modifié depuis le snapshot est inclus et garde son début et sa fin', async t => {
    const { root, home, instancePath, instancePaths, build } = await setup(t)
    const filePath = path.join(instancePath, 'hs_err_pid456.log')
    fs.writeFileSync(filePath, 'old fatal error')
    fs.utimesSync(filePath, new Date(1000), new Date(1000))
    const snapshot = home.createCrashReportSnapshot(instancePaths, root)
    fs.writeFileSync(filePath, 'FATAL HEADER\n' + 'x'.repeat(200000) + '\nEND OF REPORT')
    const report = build(snapshot)
    assert.equal(report.hasCrashReport, true)
    assert.match(report.content, /FATAL HEADER/)
    assert.match(report.content, /END OF REPORT/)
    assert.match(report.content, /début et fin conservés/)
})
