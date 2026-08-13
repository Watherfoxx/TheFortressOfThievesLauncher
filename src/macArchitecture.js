const { execFileSync } = require('child_process')

function getMacHardwareArchitecture({
    platform = process.platform,
    runtimeArchitecture = process.arch,
    runSysctl = execFileSync
} = {}) {
    if (platform !== 'darwin') return runtimeArchitecture
    if (runtimeArchitecture === 'arm64') return 'arm64'

    try {
        const arm64Supported = runSysctl('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        }).trim()

        return arm64Supported === '1' ? 'arm64' : 'x64'
    } catch (error) {
        return runtimeArchitecture === 'x64' ? 'x64' : runtimeArchitecture
    }
}

function isMacJavaExecutableCompatible(candidatePath, {
    platform = process.platform,
    runtimeArchitecture = process.arch,
    inspectBinary = execFileSync
} = {}) {
    if (platform !== 'darwin') return true
    if (!['arm64', 'x64'].includes(runtimeArchitecture)) return true

    try {
        const description = inspectBinary('/usr/bin/file', ['-b', candidatePath], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        }).toLowerCase()

        return runtimeArchitecture === 'arm64'
            ? /\barm64e?\b/.test(description)
            : /\bx86_64\b/.test(description)
    } catch (error) {
        return false
    }
}

module.exports = {
    getMacHardwareArchitecture,
    isMacJavaExecutableCompatible
}
