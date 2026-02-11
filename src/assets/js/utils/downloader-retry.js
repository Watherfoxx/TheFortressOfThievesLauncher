/**
 * Enhances minecraft-java-core's Downloader by smoothing throughput
 * metrics and normalising error handling. When a download fails the
 * entire queue is cancelled and a clear, user-friendly message is
 * emitted so the launcher can surface the problem immediately.
 */

const fs = require('fs');
const { Downloader } = require('minecraft-java-core');
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
        const originalMessage = formatted.error || formatted.message || formatted?.cause?.message || formatted.toString();
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

patchDownloader();
