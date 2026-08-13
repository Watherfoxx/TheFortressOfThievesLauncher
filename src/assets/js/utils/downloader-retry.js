/**
 * Enhances minecraft-java-core's Downloader by smoothing throughput
 * metrics and normalising error handling. When a download fails the
 * entire queue is cancelled and a clear, user-friendly message is
 * emitted so the launcher can surface the problem immediately.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Downloader, Launch } = require('minecraft-java-core');
const nodeFetch = require('node-fetch');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const macArchitectureModule = process.type === 'renderer'
    ? './macArchitecture.js'
    : '../../../macArchitecture.js';
const { isMacJavaExecutableCompatible } = require(macArchitectureModule);
let WebReadableStream;

try {
    ({ ReadableStream: WebReadableStream } = require('stream/web'));
} catch (error) {
    WebReadableStream = null;
}

const networkErrorCodes = new Set([
    'etimedout',
    'econnreset',
    'econnaborted',
    'eai_again',
    'enotfound',
    'enetworkdown',
    'enetworkunreachable'
]);

const getFriendlyMessage = (error) => {
    if (!error) return null;

    const code = typeof error.code === 'string' ? error.code.toLowerCase() : '';
    if (networkErrorCodes.has(code)) {
        return 'Connexion perdue. Vérifiez votre connexion Internet et réessayez.';
    }

    const causeCode = typeof error?.cause?.code === 'string' ? error.cause.code.toLowerCase() : '';
    if (networkErrorCodes.has(causeCode)) {
        return 'Connexion perdue. Vérifiez votre connexion Internet et réessayez.';
    }

    if (error.name === 'AbortError') {
        return 'Connexion perdue. Vérifiez votre connexion Internet et réessayez.';
    }

    const message = (
        error?.error ||
        error?.message ||
        error?.cause?.message ||
        (typeof error === 'string' ? error : '')
    )
        .toString()
        .toLowerCase();

    if (!message) return null;

    const networkHints = [
        'timeout',
        'timed out',
        'network',
        'fetch failed',
        'aborted',
        'socket',
        'temporarily unavailable',
        'connection reset',
        'connection closed'
    ];

    if (networkHints.some((hint) => message.includes(hint))) {
        return 'Connexion perdue. Vérifiez votre connexion Internet et réessayez.';
    }

    return null;
};

const formatError = (error, file) => {
    if (!error) {
        return {
            error: 'Une erreur inconnue est survenue lors du téléchargement.',
            file: file?.path
        };
    }

    if (typeof error === 'object') {
        const formatted = { ...error };
        const originalMessage = formatted.error || error.message || error?.cause?.message || error.toString();
        const originalStack = typeof error.stack === 'string' ? error.stack : null;
        const fallback = 'Une erreur inconnue est survenue lors du téléchargement.';
        const friendly = getFriendlyMessage(error);

        if (friendly) {
            formatted.friendlyMessage = friendly;
            formatted.details = originalMessage && originalMessage !== friendly ? originalMessage : undefined;
            formatted.error = friendly;
        } else {
            formatted.error = originalMessage || fallback;
        }

        if (!formatted.error) {
            formatted.error = fallback;
        }

        if (file?.path) {
            formatted.file = file.path;
        }

        if (!formatted.details && originalStack && originalStack !== originalMessage) {
            formatted.details = originalStack;
        }

        return formatted;
    }

    const friendly = getFriendlyMessage(error);
    if (friendly) {
        return {
            error: friendly,
            friendlyMessage: friendly,
            details: error.toString(),
            file: file?.path
        };
    }

    return {
        error: error.toString(),
        file: file?.path
    };
};

const patchDownloader = () => {
    if (Downloader.prototype.__fortressPatchedRetry) return;

    const originalDownloadFile = Downloader.prototype.downloadFile;
    const originalDownloadFileMultiple = Downloader.prototype.downloadFileMultiple;
    const maximumAttempts = 3;

    const toNodeStream = (webStream) => {
        if (!webStream) return Readable.from([]);

        if (WebReadableStream && webStream instanceof WebReadableStream && typeof Readable.fromWeb === 'function') {
            try {
                return Readable.fromWeb(webStream);
            } catch (error) {
                // Fallback handled below.
            }
        }

        if (typeof webStream?.getReader === 'function') {
            const nodeStream = new Readable({ read() { } });
            const reader = webStream.getReader();

            (function pump() {
                reader.read().then(({ done, value }) => {
                    if (done) return nodeStream.push(null);
                    nodeStream.push(Buffer.from(value));
                    pump();
                }).catch((err) => nodeStream.destroy(err));
            })();

            return nodeStream;
        }

        return webStream;
    };

    const waitBeforeRetry = attempt => new Promise(resolve => {
        setTimeout(resolve, 400 * (2 ** (attempt - 1)));
    });

    const removeFile = filePath => {
        try {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (error) {
            // The original download error is more useful than a cleanup error.
        }
    };

    const expectedResponseSize = response => {
        const getHeader = response && response.headers && typeof response.headers.get === 'function'
            ? response.headers.get.bind(response.headers)
            : null;
        if (!getHeader || getHeader('content-encoding')) return 0;
        const value = Number(getHeader('content-length'));
        return Number.isFinite(value) && value > 0 ? value : 0;
    };

    const downloadVerifiedFile = async ({
        file,
        timeout,
        controller,
        onResponse,
        onChunk
    }) => {
        const temporaryPath = `${file.path}.part`;
        removeFile(temporaryPath);

        const timeoutId = setTimeout(() => controller.abort(), timeout);
        let response;
        try {
            response = await fetch(file.url, {
                signal: controller.signal,
                cache: 'no-store'
            });
        } finally {
            clearTimeout(timeoutId);
        }

        if (!response?.ok || !response.body) {
            throw new Error(`Échec du téléchargement (${response?.status || 'sans réponse'} ${response?.statusText || ''})`.trim());
        }

        const metadataSize = Number(file.size);
        const responseSize = expectedResponseSize(response);
        const expectedSize = Number.isFinite(metadataSize) && metadataSize > 0
            ? metadataSize
            : responseSize;
        if (typeof onResponse === 'function') onResponse(expectedSize);

        const expectedSha1 = typeof file.sha1 === 'string' && file.sha1.length > 0
            ? file.sha1.toLowerCase()
            : null;
        const hash = expectedSha1 ? crypto.createHash('sha1') : null;
        let receivedSize = 0;
        let inactivityTimeout = null;
        const resetInactivityTimeout = () => {
            clearTimeout(inactivityTimeout);
            inactivityTimeout = setTimeout(() => controller.abort(), timeout);
        };
        resetInactivityTimeout();

        const meter = new Transform({
            transform(chunk, encoding, callback) {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
                resetInactivityTimeout();
                receivedSize += buffer.length;
                if (hash) hash.update(buffer);
                if (typeof onChunk === 'function') onChunk(buffer.length);
                callback(null, buffer);
            }
        });

        try {
            await pipeline(
                toNodeStream(response.body),
                meter,
                fs.createWriteStream(temporaryPath, { flags: 'w', mode: 0o777 })
            );

            if (expectedSize > 0 && receivedSize !== expectedSize) {
                throw new Error(`Fichier incomplet : ${receivedSize} octets reçus sur ${expectedSize}.`);
            }

            if (expectedSha1) {
                const receivedSha1 = hash.digest('hex').toLowerCase();
                if (receivedSha1 !== expectedSha1) {
                    throw new Error(`Somme SHA-1 incorrecte : ${receivedSha1} au lieu de ${expectedSha1}.`);
                }
            }

            const diskSize = fs.statSync(temporaryPath).size;
            if (diskSize !== receivedSize) {
                throw new Error(`Écriture disque incomplète : ${diskSize} octets écrits sur ${receivedSize}.`);
            }

            removeFile(file.path);
            fs.renameSync(temporaryPath, file.path);

            const promotedSize = fs.statSync(file.path).size;
            if (promotedSize !== receivedSize) {
                removeFile(file.path);
                throw new Error(`Validation finale impossible : ${promotedSize} octets disponibles sur ${receivedSize}.`);
            }
            return receivedSize;
        } catch (error) {
            removeFile(temporaryPath);
            throw error;
        } finally {
            clearTimeout(inactivityTimeout);
        }
    };

    const markAndEmitTerminalError = (downloader, error) => {
        if (downloader.listenerCount('error') === 0) return error;

        Object.defineProperty(error, '__fortressErrorEmitted', {
            value: true,
            enumerable: false
        });
        downloader.emit('error', error);
        return error;
    };

    Downloader.prototype.downloadFile = async function patchedDownloadFile(url, directory, fileName) {
        if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true, mode: 0o777 });

        const file = {
            url,
            folder: directory,
            path: path.join(directory, fileName),
            name: fileName
        };
        let lastError = null;

        for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
            let downloadedThisAttempt = 0;
            let totalSize = 0;
            const controller = new AbortController();

            try {
                await downloadVerifiedFile({
                    file,
                    timeout: 10000,
                    controller,
                    onResponse: expectedSize => { totalSize = expectedSize; },
                    onChunk: chunkSize => {
                        downloadedThisAttempt += chunkSize;
                        this.emit('progress', downloadedThisAttempt, totalSize);
                    }
                });
                return;
            } catch (error) {
                lastError = error;
                removeFile(file.path);
                if (attempt < maximumAttempts) await waitBeforeRetry(attempt);
            }
        }

        const formattedError = formatError(lastError, file);
        markAndEmitTerminalError(this, formattedError);
        throw formattedError;
    };

    Downloader.prototype.downloadFileMultiple = async function patchedDownloadFileMultiple(
        files,
        size,
        limit = 1,
        timeout = 10000
    ) {
        if (!Array.isArray(files) || files.length === 0) {
            return Promise.resolve();
        }

        limit = Math.min(Math.max(1, limit), files.length);
        const queue = files.map(file => ({ ...file }));

        let downloaded = 0;
        let queueIndex = 0;
        let previousDownloaded = 0;
        let lastTick = Date.now();
        const recentSpeeds = [];
        const activeControllers = new Set();
        let fatalError = null;

        const updateThroughput = () => {
            const now = Date.now();
            const elapsed = (now - lastTick) / 1000;
            const delta = downloaded - previousDownloaded;
            if (elapsed <= 0) return;

            if (delta > 0) {
                if (recentSpeeds.length >= 5) recentSpeeds.shift();
                recentSpeeds.push(delta / elapsed);
                const avgSpeed = recentSpeeds.reduce((a, b) => a + b, 0) / recentSpeeds.length;
                this.emit('speed', avgSpeed);
                if (avgSpeed > 0) {
                    const remaining = Math.max(size - downloaded, 0);
                    this.emit('estimated', remaining / avgSpeed);
                }
            }

            lastTick = now;
            previousDownloaded = downloaded;
        };

        const throughputInterval = setInterval(updateThroughput, 500);

        const abortAllActive = () => {
            for (const controller of activeControllers) {
                try {
                    controller.abort();
                } catch (error) {
                    // Ignore abort errors; the important part is stopping the download.
                }
            }
            activeControllers.clear();
        };

        const downloadWithRetry = async file => {
            if (!fs.existsSync(file.folder)) {
                fs.mkdirSync(file.folder, { recursive: true, mode: 0o777 });
            }

            let lastError = null;
            for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
                if (fatalError) throw fatalError;

                let downloadedThisAttempt = 0;
                const controller = new AbortController();
                activeControllers.add(controller);

                try {
                    await downloadVerifiedFile({
                        file,
                        timeout,
                        controller,
                        onChunk: chunkSize => {
                            downloadedThisAttempt += chunkSize;
                            downloaded += chunkSize;
                            this.emit('progress', downloaded, size, file.type);
                        }
                    });
                    activeControllers.delete(controller);
                    return;
                } catch (error) {
                    activeControllers.delete(controller);
                    downloaded = Math.max(0, downloaded - downloadedThisAttempt);
                    removeFile(file.path);
                    lastError = error;

                    if (fatalError) throw fatalError;
                    if (attempt < maximumAttempts) await waitBeforeRetry(attempt);
                }
            }

            throw lastError;
        };

        const worker = async () => {
            while (!fatalError && queueIndex < queue.length) {
                const file = queue[queueIndex++];
                try {
                    await downloadWithRetry(file);
                } catch (error) {
                    if (!fatalError) {
                        fatalError = formatError(error, file);
                        markAndEmitTerminalError(this, fatalError);
                        abortAllActive();
                    }
                }
            }
        };

        try {
            await Promise.all(Array.from({ length: limit }, () => worker()));
        } finally {
            clearInterval(throughputInterval);
        }

        if (fatalError) throw fatalError;
        this.emit('progress', size, size, undefined);
    };

    Downloader.prototype.__fortressPatchedRetry = true;
    Downloader.prototype.__fortressOriginalDownloadFile = originalDownloadFile;
    Downloader.prototype.__fortressOriginalDownloadFileMultiple = originalDownloadFileMultiple;
};

const patchLaunchErrorHandling = () => {
    if (Launch.prototype.__fortressPatchedTerminalErrors) return;

    const originalStart = Launch.prototype.start;

    Launch.prototype.start = async function patchedLaunchStart(...args) {
        try {
            return await originalStart.apply(this, args);
        } catch (error) {
            // The downloader forwards its fatal error to Launch before rejecting.
            // Swallow that already-reported rejection so the original launch chain
            // stops without producing an unhandled rejection or a duplicate popup.
            if (!error?.__fortressErrorEmitted) {
                this.emit('error', formatError(error));
            }
            return null;
        }
    };

    Launch.prototype.__fortressPatchedTerminalErrors = true;
    Launch.prototype.__fortressOriginalStart = originalStart;
};

const patchBundleIgnoreVerification = () => {
    const coreEntry = require.resolve('minecraft-java-core');
    const MinecraftBundle = require(path.join(path.dirname(coreEntry), 'Minecraft', 'Minecraft-Bundle.js')).default;

    if (MinecraftBundle.prototype.__fortressPatchedIgnoredVerification) return;

    const originalCheckBundle = MinecraftBundle.prototype.checkBundle;

    const normalizePath = (value) => value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

    const matchesIgnoredEntry = (relativePath, ignoredList) => {
        const normalizedPath = normalizePath(relativePath);

        return ignoredList.some((entry) => {
            const normalizedEntry = normalizePath(entry);
            if (!normalizedEntry) return false;
            return normalizedPath === normalizedEntry || normalizedPath.startsWith(`${normalizedEntry}/`);
        });
    };

    MinecraftBundle.prototype.checkBundle = async function patchedCheckBundle(bundle) {
        const ignoredList = Array.isArray(this.options?.ignored) ? this.options.ignored : [];

        if (ignoredList.length === 0 || !Array.isArray(bundle)) {
            return originalCheckBundle.call(this, bundle);
        }

        const instanceBase = this.options?.instance
            ? path.resolve(this.options.path, 'instances', this.options.instance)
            : path.resolve(this.options.path);

        const filteredBundle = bundle.filter((file) => {
            if (!file?.path || file.type === 'CFILE') return true;

            const localPath = path.resolve(this.options.path, file.path);
            if (!fs.existsSync(localPath)) return true;

            const relativePath = path.relative(instanceBase, localPath);
            return !matchesIgnoredEntry(relativePath, ignoredList);
        });

        return originalCheckBundle.call(this, filteredBundle);
    };

    MinecraftBundle.prototype.__fortressPatchedIgnoredVerification = true;
    MinecraftBundle.prototype.__fortressOriginalCheckBundle = originalCheckBundle;
};

const patchMinecraftLibraryArtifacts = () => {
    const coreEntry = require.resolve('minecraft-java-core');
    const Libraries = require(path.join(path.dirname(coreEntry), 'Minecraft', 'Minecraft-Libraries.js')).default;

    if (Libraries.prototype.__fortressPatchedLibraryArtifacts) return;

    const originalGetLibraries = Libraries.prototype.Getlibraries;
    const mojangOS = {
        win32: 'windows',
        darwin: 'osx',
        linux: 'linux'
    };

    Libraries.prototype.Getlibraries = async function patchedGetLibraries(json) {
        const bundle = await originalGetLibraries.call(this, json);
        if (!Array.isArray(bundle) || !Array.isArray(json?.libraries)) return bundle;

        const existingPaths = new Set(bundle.map(file => file?.path).filter(Boolean));
        const currentOS = mojangOS[process.platform] || process.platform;

        for (const library of json.libraries) {
            const nativeClassifier = library?.natives?.[currentOS] || library?.natives?.[process.platform];
            const artifact = library?.downloads?.artifact;

            // minecraft-java-core downloads only the native classifier when
            // "natives" is present. LWJGL also needs this platform-independent
            // Java artifact on the classpath.
            if (!nativeClassifier || !artifact?.path) continue;

            const artifactPath = `libraries/${artifact.path}`;
            if (existingPaths.has(artifactPath)) continue;

            bundle.push({
                sha1: artifact.sha1,
                size: artifact.size,
                path: artifactPath,
                type: 'Libraries',
                url: artifact.url
            });
            existingPaths.add(artifactPath);
        }

        return bundle;
    };

    Libraries.prototype.__fortressPatchedLibraryArtifacts = true;
    Libraries.prototype.__fortressOriginalGetLibraries = originalGetLibraries;
};

const patchForgeFetchFallback = () => {
    if (globalThis.__fortressPatchedForgeFetch || typeof globalThis.fetch !== 'function') return;

    const originalFetch = globalThis.fetch.bind(globalThis);
    const forgeHost = 'files.minecraftforge.net';

    globalThis.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input?.url;

        try {
            return await originalFetch(input, init);
        } catch (error) {
            let parsedUrl;
            try {
                parsedUrl = new URL(url);
            } catch (parseError) {
                throw error;
            }

            if (parsedUrl.hostname !== forgeHost) throw error;

            // Chromium can reject a Forge response with
            // ERR_CONTENT_DECODING_FAILED when a proxy/CDN advertises an
            // encoding that does not match the body. Retry through Node and
            // explicitly request the uncompressed representation.
            try {
                const headers = {
                    ...(init?.headers || {}),
                    'accept-encoding': 'identity'
                };

                return await nodeFetch(url, { ...init, headers });
            } catch (fallbackError) {
                if (!fallbackError.cause) fallbackError.cause = error;
                throw fallbackError;
            }
        }
    };

    globalThis.__fortressPatchedForgeFetch = true;
    globalThis.__fortressOriginalFetch = originalFetch;
};

const normalizeProcessorArgument = (argument) => {
    // Forge surrounds paths with quotes because its original implementation
    // launches through a shell. spawn() receives an argument array and does not
    // need shell quoting, even when paths contain spaces.
    return String(argument ?? '').replace(/"([^"]*)"/g, '$1');
};

const isUsableJavaExecutable = (candidatePath) => {
    try {
        const stat = fs.statSync(candidatePath);
        if (!stat.isFile() || stat.size === 0) return false;
        if (!isMacJavaExecutableCompatible(candidatePath)) return false;

        if (process.platform !== 'win32') {
            try {
                fs.accessSync(candidatePath, fs.constants.X_OK);
            } catch (error) {
                fs.chmodSync(candidatePath, 0o755);
                fs.accessSync(candidatePath, fs.constants.X_OK);
            }
        }

        return true;
    } catch (error) {
        return false;
    }
};

const resolveExistingJavaExecutable = (candidatePath) => {
    if (!candidatePath) return null;

    const resolvedPath = path.resolve(candidatePath);
    const directory = path.dirname(resolvedPath);
    const baseName = path.basename(resolvedPath).toLowerCase();
    const candidates = [resolvedPath];

    if (process.platform === 'win32') {
        if (!baseName.endsWith('.exe')) candidates.push(`${resolvedPath}.exe`);

        const executableName = baseName.replace(/\.exe$/i, '');
        if (executableName === 'java') candidates.push(path.join(directory, 'javaw.exe'));
        if (executableName === 'javaw') candidates.push(path.join(directory, 'java.exe'));
    }

    return [...new Set(candidates)].find(isUsableJavaExecutable) || null;
};

const findBundledJavaExecutable = (runtimeFolder) => {
    if (!fs.existsSync(runtimeFolder)) return null;

    const directories = [{ directory: runtimeFolder, depth: 0 }];
    const maximumDepth = 5;

    while (directories.length > 0) {
        const { directory, depth } = directories.shift();
        const candidates = process.platform === 'win32'
            ? [path.join(directory, 'java.exe'), path.join(directory, 'javaw.exe')]
            : [path.join(directory, 'java')];
        const executable = candidates.find(isUsableJavaExecutable);
        if (executable) return executable;
        if (depth >= maximumDepth) continue;

        try {
            for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
                if (entry.isDirectory()) {
                    directories.push({ directory: path.join(directory, entry.name), depth: depth + 1 });
                }
            }
        } catch (error) {
            // A partially extracted or protected directory must not prevent the
            // launcher from checking the other installed runtimes.
        }
    }

    return null;
};

const patchConfiguredJavaFallback = () => {
    if (Launch.prototype.__fortressPatchedConfiguredJavaFallback) return;

    const originalLaunch = Launch.prototype.Launch;

    Launch.prototype.Launch = function patchedConfiguredJavaFallback(options) {
        const configuredPath = options?.java?.path;
        if (!configuredPath) return originalLaunch.call(this, options);

        const executable = resolveExistingJavaExecutable(configuredPath);
        const normalizedOptions = {
            ...options,
            java: {
                ...options.java,
                path: executable
            }
        };

        if (!executable) {
            console.warn(`[Launcher] Le chemin Java configuré n'existe plus (${configuredPath}). Utilisation du runtime intégré.`);
        }

        return originalLaunch.call(this, normalizedOptions);
    };

    Launch.prototype.__fortressPatchedConfiguredJavaFallback = true;
    Launch.prototype.__fortressOriginalLaunch = originalLaunch;
};

const patchJavaRuntimeExecutable = () => {
    const coreEntry = require.resolve('minecraft-java-core');
    const coreDirectory = path.dirname(coreEntry);
    const JavaDownloader = require(path.join(coreDirectory, 'Minecraft', 'Minecraft-Java.js')).default;

    if (JavaDownloader.prototype.__fortressPatchedJavaExecutable) return;

    const originalGetJavaOther = JavaDownloader.prototype.getJavaOther;

    JavaDownloader.prototype.getJavaOther = async function patchedGetJavaOther(jsonVersion, versionDownload) {
        const majorVersion = versionDownload || jsonVersion?.javaVersion?.majorVersion || 8;
        const runtimeFolder = path.resolve(this.options.path, `runtime/jre-${majorVersion}`);
        const existingExecutable = findBundledJavaExecutable(runtimeFolder);

        if (existingExecutable) return { files: [], path: existingExecutable };

        const runtimeRoot = path.resolve(this.options.path, 'runtime');
        const relativeRuntimePath = path.relative(runtimeRoot, runtimeFolder);
        const safeRuntimeFolder = relativeRuntimePath
            && !relativeRuntimePath.startsWith('..')
            && !path.isAbsolute(relativeRuntimePath);
        let lastError = null;

        for (let attempt = 1; attempt <= 2; attempt += 1) {
            if (attempt === 2) {
                if (!safeRuntimeFolder) {
                    return {
                        files: [],
                        path: '',
                        error: true,
                        message: `Le dossier du runtime Java n'est pas sûr : ${runtimeFolder}`
                    };
                }

                try {
                    fs.rmSync(runtimeFolder, { recursive: true, force: true });
                } catch (cleanupError) {
                    return {
                        files: [],
                        path: '',
                        error: true,
                        message: `Impossible de supprimer le runtime Java incomplet : ${cleanupError.message}`
                    };
                }
            }

            let result;
            try {
                const getJavaOther = JavaDownloader.prototype.__fortressOriginalGetJavaOther;
                result = await getJavaOther.call(this, jsonVersion, versionDownload);
            } catch (error) {
                lastError = error;
                continue;
            }

            if (!result || result.error) {
                lastError = new Error(result?.message || 'Le téléchargement du runtime Java a échoué.');
                continue;
            }

            const executable = resolveExistingJavaExecutable(result.path)
                || findBundledJavaExecutable(runtimeFolder);
            if (executable) return { ...result, path: executable };

            lastError = new Error(`Aucun exécutable Java n'a été extrait dans ${runtimeFolder}.`);
        }

        return {
            files: [],
            path: '',
            error: true,
            message: `Le runtime Java ${majorVersion} reste incomplet après sa réinstallation. `
                + `Vérifiez si l'antivirus a placé java.exe en quarantaine. ${lastError?.message || ''}`.trim()
        };
    };

    JavaDownloader.prototype.__fortressPatchedJavaExecutable = true;
    JavaDownloader.prototype.__fortressOriginalGetJavaOther = originalGetJavaOther;
};

const patchForgePatcherExecution = () => {
    const coreEntry = require.resolve('minecraft-java-core');
    const coreDirectory = path.dirname(coreEntry);
    const ForgePatcher = require(path.join(coreDirectory, 'Minecraft-Loader', 'patcher.js')).default;
    const { getPathLibraries } = require(path.join(coreDirectory, 'utils', 'Index.js'));

    if (ForgePatcher.prototype.__fortressPatchedSafeExecution) return;

    const originalPatcher = ForgePatcher.prototype.patcher;

    ForgePatcher.prototype.patcher = async function patchedForgePatcher(profile, config, neoForgeOld = true) {
        const configuredJavaPath = config?.java ? path.resolve(config.java) : null;
        const javaPath = resolveExistingJavaExecutable(configuredJavaPath)
            || findBundledJavaExecutable(path.resolve(this.options.path, 'runtime'))
            || configuredJavaPath;

        if (!javaPath || !fs.existsSync(javaPath)) {
            const message = `L’exécutable Java requis par Forge est introuvable : ${javaPath || 'chemin non défini'}`;
            this.emit('error', message);
            return { error: message };
        }

        if (process.platform !== 'win32') {
            try {
                fs.accessSync(javaPath, fs.constants.X_OK);
            } catch (accessError) {
                try {
                    fs.chmodSync(javaPath, 0o755);
                    fs.accessSync(javaPath, fs.constants.X_OK);
                } catch (chmodError) {
                    const message = `Java n’est pas exécutable : ${javaPath} (${chmodError.message})`;
                    this.emit('error', message);
                    return { error: message };
                }
            }
        }

        const processors = Array.isArray(profile?.processors)
            ? profile.processors
            : Object.values(profile?.processors || {});
        for (const processor of processors) {
            if (processor.sides && !processor.sides.includes('client')) continue;

            const jarInfo = getPathLibraries(processor.jar);
            const jarPath = path.resolve(this.options.path, 'libraries', jarInfo.path, jarInfo.name);
            const processorArguments = (processor.args || [])
                .map(argument => this.setArgument(argument, profile, config, neoForgeOld))
                .map(argument => this.computePath(argument))
                .map(normalizeProcessorArgument);
            const classPaths = (processor.classpath || []).map(classPath => {
                const classPathInfo = getPathLibraries(classPath);
                return path.join(this.options.path, 'libraries', classPathInfo.path, classPathInfo.name);
            });
            const mainClass = await this.readJarManifest(jarPath);

            if (!mainClass) {
                const message = `Impossible de déterminer la classe principale dans le JAR : ${jarPath}`;
                this.emit('error', message);
                return { error: message };
            }

            const result = await new Promise(resolve => {
                let stderr = '';
                let settled = false;
                let childProcess;

                const finish = (error = null) => {
                    if (settled) return;
                    settled = true;
                    if (error) this.emit('error', error);
                    resolve(error ? { error } : { success: true });
                };

                try {
                    childProcess = spawn(javaPath, [
                        '-classpath',
                        [jarPath, ...classPaths].join(path.delimiter),
                        mainClass,
                        ...processorArguments
                    ], {
                        shell: false,
                        windowsHide: true
                    });
                } catch (error) {
                    finish(`Impossible de démarrer Java pour installer Forge : ${error.message}`);
                    return;
                }

                childProcess.stdout.on('data', data => {
                    this.emit('patch', data.toString('utf-8'));
                });
                childProcess.stderr.on('data', data => {
                    const output = data.toString('utf-8');
                    stderr = `${stderr}${output}`.slice(-4000);
                    this.emit('patch', output);
                });
                childProcess.once('error', error => {
                    finish(`Impossible de démarrer Java pour installer Forge : ${error.message}`);
                });
                childProcess.once('close', (code, signal) => {
                    if (code === 0) return finish();

                    const exitReason = code !== null ? `code ${code}` : `signal ${signal || 'inconnu'}`;
                    const details = stderr.trim();
                    finish(
                        `Le patcher Forge s’est terminé avec le ${exitReason}`
                        + (details ? ` : ${details}` : '.')
                    );
                });
            });

            if (result.error) return result;
        }

        return { success: true };
    };

    ForgePatcher.prototype.__fortressPatchedSafeExecution = true;
    ForgePatcher.prototype.__fortressOriginalPatcher = originalPatcher;
};

const patchModLoaderErrorHandling = () => {
    const coreEntry = require.resolve('minecraft-java-core');
    const coreDirectory = path.dirname(coreEntry);
    const ForgePatcher = require(path.join(coreDirectory, 'Minecraft-Loader', 'patcher.js')).default;
    const Forge = require(path.join(coreDirectory, 'Minecraft-Loader', 'loader', 'forge', 'forge.js')).default;
    const NeoForge = require(path.join(coreDirectory, 'Minecraft-Loader', 'loader', 'neoForge', 'neoForge.js')).default;

    const runPatcher = async function runPatcher(profile, neoForgeOld = true) {
        if (!profile?.processors?.length) return true;

        const patcher = new ForgePatcher(this.options);
        let patchError = null;

        patcher.on('patch', data => this.emit('patch', data));
        patcher.on('error', error => {
            if (!patchError) patchError = error?.error || error?.message || String(error);
        });

        try {
            if (!patcher.check(profile)) {
                const config = {
                    java: this.options.loader.config.javaPath,
                    minecraft: this.options.loader.config.minecraftJar,
                    minecraftJson: this.options.loader.config.minecraftJson
                };
                const result = await patcher.patcher(profile, config, neoForgeOld);
                if (!patchError && result?.error) patchError = result.error;
            }
        } catch (error) {
            patchError = error?.error || error?.message || String(error);
        }

        return patchError ? { error: patchError } : true;
    };

    if (!Forge.prototype.__fortressPatchedPatcherErrors) {
        Forge.prototype.patchForge = async function patchedForge(profile) {
            return await runPatcher.call(this, profile, true);
        };
        Forge.prototype.__fortressPatchedPatcherErrors = true;
    }

    if (!NeoForge.prototype.__fortressPatchedPatcherErrors) {
        NeoForge.prototype.patchneoForge = async function patchedNeoForge(profile, oldAPI) {
            return await runPatcher.call(this, profile, oldAPI);
        };
        NeoForge.prototype.__fortressPatchedPatcherErrors = true;
    }
};

const patchLoaderErrorPropagation = () => {
    const coreEntry = require.resolve('minecraft-java-core');
    const Loader = require(path.join(path.dirname(coreEntry), 'Minecraft-Loader', 'index.js')).default;

    if (Loader.prototype.__fortressPatchedErrorPropagation) return;

    const originalInstall = Loader.prototype.install;
    const originalEmit = Loader.prototype.emit;

    Loader.prototype.emit = function patchedLoaderEmit(eventName, ...args) {
        if (eventName === 'error' && args[0] && !(args[0] instanceof Error)) {
            const payload = args[0];
            const message = payload?.friendlyMessage || payload?.error || payload?.message || String(payload);
            const normalizedError = new Error(message);
            if (typeof payload === 'object') Object.assign(normalizedError, payload);
            normalizedError.message = message;
            args[0] = normalizedError;
        }
        return originalEmit.call(this, eventName, ...args);
    };

    Loader.prototype.install = async function patchedLoaderInstall(...args) {
        try {
            return await originalInstall.apply(this, args);
        } catch (error) {
            const formattedError = formatError(error);

            // MinecraftLoader starts install() without awaiting its promise.
            // Converting rejected promises into the expected EventEmitter error
            // prevents an unhandled rejection and lets the launcher restore its UI.
            this.emit('error', formattedError);
            return formattedError;
        }
    };

    Loader.prototype.__fortressPatchedErrorPropagation = true;
    Loader.prototype.__fortressOriginalInstall = originalInstall;
    Loader.prototype.__fortressOriginalEmit = originalEmit;
};

patchForgeFetchFallback();
patchDownloader();
patchLaunchErrorHandling();
patchBundleIgnoreVerification();
patchMinecraftLibraryArtifacts();
patchConfiguredJavaFallback();
patchJavaRuntimeExecutable();
patchForgePatcherExecution();
patchModLoaderErrorHandling();
patchLoaderErrorPropagation();
