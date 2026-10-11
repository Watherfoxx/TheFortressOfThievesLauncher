const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const JavaScriptObfuscator = require('javascript-obfuscator')
const obfuscatorOptions = require('../obfuscator-options.js')

const source = fs.readFileSync(path.join(__dirname, '../src/assets/js/panels/home.js'), 'utf8')
    .replace(/^import .*$/gm, '')
    .replace('export default Home;', 'globalThis.Home = Home;')
const fakeWebhook = 'https://discord.com/api/webhooks/123456/test-token'

function setup({ configuredUrl, compiledUrl, obfuscated = false } = {}) {
    const requests = []
    const popups = []
    const forms = []
    class Form {
        constructor() { this.entries = []; forms.push(this) }
        append(...args) { this.entries.push(args) }
        getHeaders() { return { 'content-type': 'test-multipart' } }
    }
    const context = vm.createContext({
        require: name => name === 'node-fetch' ? async (url, options) => {
            requests.push({ url, options }); return { ok: true, status: 204 }
        } : name === 'form-data' ? Form : {},
        process: { env: { DISCORD_CRASH_WEBHOOK_URL: configuredUrl } },
        URL, Buffer, console,
        popup: class { openPopup(options) { popups.push(options) } }
    })
    let code = compiledUrl ? source.replace("'__BUILD_DISCORD_CRASH_WEBHOOK_URL__'", JSON.stringify(compiledUrl)) : source
    if (obfuscated) code = JavaScriptObfuscator.obfuscate(code, obfuscatorOptions).getObfuscatedCode()
    vm.runInContext(code, context)
    return { home: new context.Home(), requests, popups, forms }
}

const crashContext = { exitCode: 1, instanceName: 'Main', playerName: 'Player' }

test('sans configuration, refuse l’envoi avant toute requête HTTP', async () => {
    const { home, requests } = setup()
    await assert.rejects(home.sendCrashReportToWebhook('report', crashContext), /n’est pas configuré/)
    assert.equal(requests.length, 0)
})

test('ne propose pas de bouton Envoyer si le webhook est absent', () => {
    const { home, popups } = setup()
    home.showCrashReportPopup({ hasCrashReport: true, content: 'report' }, crashContext)
    assert.equal(popups[0].buttons.length, 0)
    assert.match(popups[0].content, /n’est pas configuré/)
})

for (const url of ['relative/url', '__BUILD_DISCORD_CRASH_WEBHOOK_URL__', 'http://discord.com/api/webhooks/123/token',
    'https://discord.com.evil.invalid/api/webhooks/123/token', 'https://discord.com/api/webhooks/']) {
    test(`refuse une configuration non valide sans effectuer de requête (${url})`, async () => {
        const { home, requests } = setup({ configuredUrl: url })
        await assert.rejects(home.sendCrashReportToWebhook('report', crashContext), /n’est pas configuré/)
        assert.equal(requests.length, 0)
    })
}

for (const obfuscated of [false, true]) {
    test(`la configuration injectée au build permet l’envoi (${obfuscated ? 'obfusqué' : 'source'})`, async () => {
        const { home, requests, forms } = setup({ compiledUrl: fakeWebhook, obfuscated })
        await home.sendCrashReportToWebhook('test report', crashContext)
        assert.equal(requests.length, 1)
        assert.equal(requests[0].url, fakeWebhook)
        assert.equal(requests[0].options.method, 'POST')
        assert.equal(forms[0].entries.find(([name]) => name === 'file')[1].toString(), 'test report')
    })
}

test('un override invalide ne masque pas le webhook valide injecté au build', async () => {
    const { home, requests } = setup({ configuredUrl: 'invalid', compiledUrl: fakeWebhook })
    await home.sendCrashReportToWebhook('report', crashContext)
    assert.equal(requests[0].url, fakeWebhook)
})

test('le webhook de développement valide est utilisé pour l’envoi', async () => {
    const { home, requests } = setup({ configuredUrl: fakeWebhook })
    await home.sendCrashReportToWebhook('report', crashContext)
    assert.equal(requests[0].url, fakeWebhook)
})
