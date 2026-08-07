/**
 * Enhances minecraft-java-core's Downloader by smoothing throughput
 * metrics and normalising error handling. When a download fails the
 * entire queue is cancelled and a clear, user-friendly message is
 * emitted so the launcher can surface the problem immediately.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Downloader } = require('minecraft-java-core');
const nodeFetch = require('node-fetch');
const { Readable } = require('stream');
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

    const originalDownloadFileMultiple = Downloader.prototype.downloadFileMultiple;

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

    Downloader.prototype.downloadFileMultiple = async function patchedDownloadFileMultiple(
        files,
        size,
        limit = 1,
        timeout = 10000
    ) {
        if (!Array.isArray(files) || files.length === 0) {
            return Promise.resolve();
        }

        limit = Math.max(1, limit);
        const queue = files.map((file) => ({ ...file }));
        const totalFiles = queue.length;

        let downloaded = 0;
        let active = 0;
        let completed = 0;
        let previousDownloaded = 0;
        let lastTick = Date.now();
        const recentSpeeds = [];
        const activeControllers = new Set();
        let hasFatalError = false;

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

        let resolvePromise = null;
        const tryResolve = () => {
            if (!resolvePromise) return;
            if (hasFatalError || (completed >= totalFiles && active === 0 && queue.length === 0)) {
                clearInterval(throughputInterval);
                const resolver = resolvePromise;
                resolvePromise = null;
                resolver();
            }
        };

        const pumpQueue = () => {
            while (active < limit && queue.length > 0) {
                const nextFile = queue.shift();
                active += 1;
                processFile(nextFile);
            }
            tryResolve();
        };

        const processFile = async (file) => {
            if (!fs.existsSync(file.folder)) {
                fs.mkdirSync(file.folder, { recursive: true, mode: 0o777 });
            }

            let bytesThisAttempt = 0;
            const writer = fs.createWriteStream(file.path, { flags: 'w', mode: 0o777 });
            const controller = new AbortController();
            activeControllers.add(controller);
            const timeoutId = setTimeout(() => controller.abort(), timeout);

            const cleanupPartial = () => {
                if (bytesThisAttempt > 0) {
                    downloaded = Math.max(0, downloaded - bytesThisAttempt);
                    bytesThisAttempt = 0;
                }
                try {
                    if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
                } catch (e) {
                    // Ignore cleanup errors to avoid masking the original failure.
                }
            };

            const handleFailure = (error) => {
                clearTimeout(timeoutId);
                writer.destroy();
                cleanupPartial();
                activeControllers.delete(controller);

                if (hasFatalError) {
                    active = Math.max(0, active - 1);
                    completed = Math.min(totalFiles, completed + 1);
                    pumpQueue();
                    tryResolve();
                    return;
                }

                active = Math.max(0, active - 1);

                const formattedError = formatError(error, file);
                hasFatalError = true;
                completed = Math.min(totalFiles, completed + 1);
                abortAllActive();
                queue.length = 0;
                this.emit('error', formattedError);
                pumpQueue();
                tryResolve();
            };

            try {
                const response = await fetch(file.url, { signal: controller.signal });
                clearTimeout(timeoutId);

                if (!response.ok || !response.body) {
                    throw new Error(`Échec du téléchargement (${response.status} ${response.statusText})`);
                }

                const stream = toNodeStream(response.body);
                stream.on('data', (chunk) => {
                    bytesThisAttempt += chunk.length;
                    downloaded += chunk.length;
                    this.emit('progress', downloaded, size, file.type);
                    writer.write(chunk);
                });

                stream.on('end', () => {
                    writer.end();
                    activeControllers.delete(controller);
                    active = Math.max(0, active - 1);
                    completed = Math.min(totalFiles, completed + 1);
                    pumpQueue();
                    tryResolve();
                });

                stream.on('error', (err) => {
                    handleFailure(err);
                });
            } catch (error) {
                handleFailure(error);
            }
        };

        return new Promise((resolve) => {
            resolvePromise = resolve;
            pumpQueue();
        });
    };

    Downloader.prototype.__fortressPatchedRetry = true;
    Downloader.prototype.__fortressOriginalDownloadFileMultiple = originalDownloadFileMultiple;
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

const patchForgePatcherExecution = () => {
    const coreEntry = require.resolve('minecraft-java-core');
    const coreDirectory = path.dirname(coreEntry);
    const ForgePatcher = require(path.join(coreDirectory, 'Minecraft-Loader', 'patcher.js')).default;
    const { getPathLibraries } = require(path.join(coreDirectory, 'utils', 'Index.js'));

    if (ForgePatcher.prototype.__fortressPatchedSafeExecution) return;

    const originalPatcher = ForgePatcher.prototype.patcher;

    ForgePatcher.prototype.patcher = async function patchedForgePatcher(profile, config, neoForgeOld = true) {
        const javaPath = config?.java ? path.resolve(config.java) : null;

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
patchBundleIgnoreVerification();
patchMinecraftLibraryArtifacts();
patchForgePatcherExecution();
patchModLoaderErrorHandling();
patchLoaderErrorPropagation();
