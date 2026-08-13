const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const vm = require('node:vm')
const JavaScriptObfuscator = require('javascript-obfuscator')
const obfuscatorOptions = require('../obfuscator-options.js')

const projectRoot = path.resolve(__dirname, '..')
const splashHtmlPath = path.join(projectRoot, 'src', 'index.html')
const splashScriptPath = path.join(projectRoot, 'src', 'assets', 'js', 'index.js')

test('les modules locaux de la popup sont résolus depuis index.html', () => {
    const source = fs.readFileSync(splashScriptPath, 'utf8')
    const pageRequire = createRequire(splashHtmlPath)
    const localRequires = Array.from(
        source.matchAll(/require\((['"])(\.{1,2}\/[^'"]+)\1\)/g),
        match => match[2]
    )

    assert.deepEqual(localRequires, [
        '../package.json',
        './macArchitecture.js',
        './releaseAsset.js'
    ])

    for (const request of localRequires) {
        assert.doesNotThrow(() => pageRequire(request), `${request} doit exister depuis index.html`)
    }
})

test('le logo et le statut restent visibles si le script principal échoue', () => {
    const html = fs.readFileSync(splashHtmlPath, 'utf8')

    assert.doesNotMatch(html, /id="splash"[^>]*display\s*:\s*none/i)
    assert.match(html, /class="splash splash-fallback-visible"/)
    assert.match(html, /class="message splash-fallback-visible"/)
})

test('la popup obfusquée charge ses modules avant de démarrer', () => {
    const pageRequire = createRequire(splashHtmlPath)
    const source = fs.readFileSync(splashScriptPath, 'utf8').replace(
        "import { config } from './utils.js';",
        'const config = { GetConfig: async () => ({ maintenance: false }) };'
    )
    const obfuscatedSource = JavaScriptObfuscator
        .obfuscate(source, obfuscatorOptions)
        .getObfuscatedCode()
    const requestedModules = []
    const domListeners = new Map()
    const elements = new Map()

    const getElement = selector => {
        if (!elements.has(selector)) {
            elements.set(selector, {
                children: [{ textContent: '' }],
                classList: {
                    add() {},
                    remove() {},
                    toggle() { return false }
                },
                style: {},
                addEventListener() {},
                textContent: '',
                innerHTML: '',
                value: 0,
                max: 0
            })
        }
        return elements.get(selector)
    }

    const rendererRequire = request => {
        requestedModules.push(request)
        if (request === 'electron') {
            return {
                ipcRenderer: { send() {}, on() {}, invoke: async () => ({ success: true }) },
                shell: { openExternal: async () => {} }
            }
        }
        if (request === 'os') return require('node:os')
        if (request === 'node-fetch') return async () => ({ ok: true, json: async () => [] })
        return pageRequire(request)
    }

    const context = {
        require: rendererRequire,
        document: {
            querySelector: getElement,
            addEventListener: (event, listener) => domListeners.set(event, listener)
        },
        process,
        console,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval
    }

    assert.doesNotThrow(() => vm.runInNewContext(obfuscatedSource, context, { timeout: 5000 }))
    assert.ok(requestedModules.includes('./macArchitecture.js'))
    assert.ok(requestedModules.includes('./releaseAsset.js'))
    assert.equal(typeof domListeners.get('DOMContentLoaded'), 'function')
})
