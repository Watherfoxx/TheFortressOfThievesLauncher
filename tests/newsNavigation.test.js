const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { pathToFileURL } = require('node:url')

test('les liens des news ouvrent le navigateur, y compris les liens relatifs et les clics sur un enfant', async () => {
    const opened = []
    const listeners = new Map()
    const newsElement = {
        addEventListener: (type, handler) => listeners.set(type, handler),
        contains: () => true,
        appendChild() {}
    }
    const source = fs.readFileSync(path.join(__dirname, '../src/assets/js/panels/home.js'), 'utf8')
        .replace(/^import .*$/gm, '')
        .replace('export default Home;', 'globalThis.Home = Home;')
    const context = vm.createContext({
        require: name => name === 'electron' ? { shell: { openExternal: async url => opened.push(url) } }
            : ['fs', 'path', 'os', 'zlib', 'child_process'].includes(name) ? require(name) : {},
        process, URL, console,
        config: { getNews: async () => [] },
        document: {
            querySelector: () => newsElement,
            createElement: () => ({ classList: { add() {} } })
        }
    })
    vm.runInContext(source, context)
    await new context.Home().news()

    function click(href, type = 'click', button = 0) {
        let prevented = false
        const link = { getAttribute: () => href }
        listeners.get(type)({
            type, button,
            target: { closest: () => link },
            preventDefault: () => { prevented = true }
        })
        return prevented
    }
    assert.equal(click('https://example.com/news'), true)
    assert.equal(click('/actualites', 'auxclick', 1), true)
    assert.equal(click('javascript:alert(1)'), true)
    assert.equal(click('file:///C:/test.html'), true)
    assert.equal(click('#section'), true)
    assert.deepEqual(opened, ['https://example.com/news', 'https://thefortressofthieves.fr/actualites'])
})

test('la fenêtre principale bloque la navigation externe et les nouvelles fenêtres', () => {
    const opened = []
    let window
    class FakeWindow extends EventEmitter {
        constructor() {
            super()
            window = this
            this.webContents = new EventEmitter()
            this.webContents.setWindowOpenHandler = handler => { this.openHandler = handler }
        }
        setMenuBarVisibility() {}
        loadFile(filePath) { this.loadedPath = filePath }
    }
    const context = vm.createContext({
        require: name => {
            if (name === 'electron') return {
                app: { getAppPath: () => path.resolve(__dirname, '..'), quit() {} },
                BrowserWindow: FakeWindow,
                Menu: { setApplicationMenu() {} },
                shell: { openExternal: async url => opened.push(url) }
            }
            if (name.endsWith('package.json')) return {}
            return require(name)
        },
        process, URL, console, module: { exports: {} }
    })
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/assets/js/windows/mainWindow.js'), 'utf8'), context)
    context.module.exports.createWindow()
    function navigate(url) {
        let prevented = false
        window.webContents.emit('will-navigate', { preventDefault: () => { prevented = true } }, url)
        return prevented
    }
    assert.equal(navigate(pathToFileURL(window.loadedPath).href + '#news'), false)
    assert.equal(navigate('https://example.com/news'), true)
    assert.equal(navigate('file:///other.html'), true)
    assert.equal(window.openHandler({ url: 'https://example.com/new-tab' }).action, 'deny')
    assert.equal(window.openHandler({ url: 'javascript:alert(1)' }).action, 'deny')
    assert.deepEqual(opened, ['https://example.com/news', 'https://example.com/new-tab'])
})
