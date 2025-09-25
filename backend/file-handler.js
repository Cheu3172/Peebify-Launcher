const {
    promises: fs,
    createWriteStream,
    createReadStream
} = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const {
    Transform,
    pipeline
} = require('stream');
const {
    dialog
} = require('electron');

const {
    CONSTANTS,
    STATUS,
    VERSION_TYPES,
    CoreUtils,
    GameUtils
} = require('./core');
const {
    logger
} = require('./logger');

class UIUpdateThrottler {
    constructor(minInterval = 50) {
        this.minInterval = minInterval;
        this.lastUpdate = 0;
        this.pendingUpdate = null;
        this.updateTimer = null;
        this.forceNextUpdate = false;
    }

    shouldUpdate(force = false) {
        const now = Date.now();
        const timeSinceLastUpdate = now - this.lastUpdate;

        if (force || this.forceNextUpdate || timeSinceLastUpdate >= this.minInterval) {
            this.lastUpdate = now;
            this.forceNextUpdate = false;
            return true;
        }
        return false;
    }

    forceUpdate() {
        this.forceNextUpdate = true;
    }
}

class FileValidator {
    constructor() {
        this.validationCache = new Map();
    }

    async quickValidate(filePath, expectedSize) {
        try {
            const stats = await fs.stat(filePath);
            return stats.size === expectedSize;
        } catch (error) {
            if (error.code === 'ENOENT') return false;
            throw error;
        }
    }

    async deepValidate(filePath, expectedSize, expectedMD5, onProgress) {
        try {
            const stats = await fs.stat(filePath);
            if (stats.size !== expectedSize) return false;

            const cacheKey = `${filePath}_${stats.mtime.getTime()}_${stats.size}`;
            if (this.validationCache.has(cacheKey)) {
                const cachedMD5 = this.validationCache.get(cacheKey);
                if (onProgress) onProgress(stats.size, stats.size, stats.size);
                return cachedMD5.toLowerCase() === expectedMD5.toLowerCase();
            }

            const actualMD5 = await this.calculateMD5WithProgress(filePath, stats.size, onProgress);

            this.validationCache.set(cacheKey, actualMD5);

            return actualMD5.toLowerCase() === expectedMD5.toLowerCase();
        } catch {
            return false;
        }
    }

    calculateMD5WithProgress(filePath, fileSize, onProgress) {
        return new Promise((resolve, reject) => {
            const hash = crypto.createHash('md5');
            const stream = createReadStream(filePath, {
                highWaterMark: CONSTANTS.STREAM_CHUNK_SIZE || 1024 * 1024
            });

            let processed = 0;

            stream.on('data', (chunk) => {
                hash.update(chunk);
                processed += chunk.length;

                if (onProgress) {
                    onProgress(chunk.length, processed, fileSize);
                }
            });

            stream.on('end', () => {
                resolve(hash.digest('hex'));
            });

            stream.on('error', reject);
        });
    }

    clearCache() {
        this.validationCache.clear();
    }
}

class ProgressTracker {
    constructor() {
        this.reset();
        this.uiThrottler = new UIUpdateThrottler(CONSTANTS.MIN_UI_UPDATE_INTERVAL || 50);
    }

    reset() {
        this.totalBytes = 0;
        this.processedBytes = 0;
        this.downloadedBytes = 0;

        this.totalFiles = 0;
        this.processedFiles = 0;
        this.currentFile = null;
        this.fileProgress = new Map();
        this.fileSizes = new Map();

        this.currentSpeed = 0;
        this.averageSpeed = 0;
        this.speedHistory = [];
        this.lastUpdate = Date.now();
        this.lastBytes = 0;

        this.phase = 'idle';
        this.subMessage = '';

        this.corruptFiles = [];
        this.repairedFiles = 0;
    }

    updateValidationProgress(bytesProcessed, currentFile = null, filesProcessed = 0) {
        this.processedBytes += bytesProcessed;
        if (currentFile) this.currentFile = currentFile;
        if (filesProcessed > 0) this.processedFiles += filesProcessed;

        return this.calculateMetrics();
    }

    updateDownloadProgress(bytesDownloaded, fileName = null) {
        this.downloadedBytes += bytesDownloaded;
        if (fileName) this.currentFile = fileName;
        return this.calculateMetrics();
    }

    updateFileProgress(fileId, bytesDownloaded, isComplete = false) {
        const currentFileProgress = this.fileProgress.get(fileId) || 0;
        const fileSize = this.fileSizes.get(fileId) || 0;
        const newFileProgress = isComplete ? fileSize : currentFileProgress + bytesDownloaded;

        const progressDiff = newFileProgress - currentFileProgress;
        this.fileProgress.set(fileId, newFileProgress);
        this.downloadedBytes += progressDiff;

        this.downloadedBytes = Math.min(this.downloadedBytes, this.totalBytes);
    }

    setFileSizes(fileSizeMap) {
        this.fileSizes = fileSizeMap;
    }

    setCorruptFiles(files) {
        this.corruptFiles = files;
    }

    incrementProcessedFiles() {
        this.processedFiles++;
    }

    incrementRepairedFiles() {
        this.repairedFiles++;
    }

    updateProgress(bytesProcessed, currentFile = null) {
        this.processedBytes += bytesProcessed;
        if (currentFile) this.currentFile = currentFile;
        this.updateSpeedMetrics();
    }

    updateSpeedMetrics() {
        const now = Date.now();
        const timeDiff = (now - this.lastUpdate) / 1000;

        if (timeDiff > 0.1) {
            const bytesDiff = this.phase === 'downloading' || this.phase === 'repairing' ?
                this.downloadedBytes - this.lastBytes :
                this.processedBytes - this.lastBytes;

            const instantSpeed = bytesDiff / timeDiff;

            const smoothingFactor = CONSTANTS.SPEED_SMOOTHING_FACTOR || 0.7;
            this.currentSpeed = this.averageSpeed * smoothingFactor +
                instantSpeed * (1 - smoothingFactor);

            this.speedHistory.push(this.currentSpeed);
            if (this.speedHistory.length > 10) this.speedHistory.shift();
            this.averageSpeed = this.speedHistory.reduce((a, b) => a + b, 0) / this.speedHistory.length;

            this.lastUpdate = now;
            this.lastBytes = this.phase === 'downloading' || this.phase === 'repairing' ? 
                this.downloadedBytes : this.processedBytes;
        }
    }

    calculateMetrics() {
        this.updateSpeedMetrics();

        const currentBytes = this.phase === 'downloading' || this.phase === 'repairing' ? 
            this.downloadedBytes : this.processedBytes;
        const percentage = this.totalBytes > 0 ? (currentBytes / this.totalBytes) * 100 : 0;

        const remainingBytes = this.totalBytes - currentBytes;
        const eta = this.averageSpeed > 0 ? remainingBytes / this.averageSpeed : 0;

        return {
            percentage: Math.min(100, percentage),
            speed: this.averageSpeed,
            eta,
            etaFormatted: this.formatETA(eta),
            currentFile: this.currentFile ? path.basename(this.currentFile) : null,
            processedBytes: currentBytes,
            totalBytes: this.totalBytes,
            processedFiles: this.processedFiles,
            totalFiles: this.totalFiles,
            phase: this.phase,
            subMessage: this.subMessage,
            validatedFiles: this.processedFiles,
            filesToRepair: this.corruptFiles.length,
            repairedFiles: this.repairedFiles
        };
    }

    formatETA(seconds) {
        if (seconds <= 0 || !isFinite(seconds)) return 'Calculating...';
        if (seconds < 1) return '<1s';

        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);

        if (hours > 0) return `${hours}h ${minutes}m`;
        if (minutes > 0) return `${minutes}m ${secs}s`;
        return `${secs}s`;
    }

    setPhase(phase, subMessage = '') {
        this.phase = phase;
        this.subMessage = subMessage;
        this.lastUpdate = Date.now();
        this.lastBytes = phase === 'downloading' || phase === 'repairing' ? 
            this.downloadedBytes : this.processedBytes;
    }

    forceCompletion() {
        this.downloadedBytes = this.totalBytes;
        this.processedBytes = this.totalBytes;
        logger.info('Progress forced to completion state.');
    }
}

class ProgressStream extends Transform {
    constructor(fileId, progressTracker, options) {
        super(options);
        this.fileId = fileId;
        this.progressTracker = progressTracker;
        this.lastProgressUpdate = 0;
        this.onProgress = null;
    }

    static createForRepair(onProgress, options) {
        const stream = new ProgressStream(null, null, options);
        stream.onProgress = onProgress;
        stream.isDestroyed = false;
        return stream;
    }

    _transform(chunk, encoding, callback) {
        if (this.isDestroyed) {
            callback();
            return;
        }

        try {
            if (this.fileId && this.progressTracker) {

                this.progressTracker.updateFileProgress(this.fileId, chunk.length);
                const now = Date.now();
                if (now - this.lastProgressUpdate > 100) {
                    this.lastProgressUpdate = now;
                }
            } else if (this.onProgress) {

                this.onProgress(chunk.length);
            }

            this.push(chunk);
            callback();
        } catch (error) {
            callback(error);
        }
    }

    destroy() {
        this.isDestroyed = true;
        super.destroy();
    }
}

class ValidationPipeline {
    constructor(progressTracker, mainWindow) {
        this.progressTracker = progressTracker;
        this.mainWindow = mainWindow;
        this.validator = new FileValidator();
        this.abortSignal = null;
    }

    async validateResources(resources, installPath, abortSignal, metadata = {}) {
        this.abortSignal = abortSignal;
        this.metadata = metadata;
        const invalidFiles = [];

        const totalSize = resources.reduce((sum, r) => sum + parseInt(r.size, 10), 0);
        this.progressTracker.reset();
        this.progressTracker.totalBytes = totalSize;
        this.progressTracker.totalFiles = resources.length;
        this.progressTracker.setPhase('validating', 'Verifying file integrity...');

        logger.info(`Starting validation of ${resources.length} files...`);

        for (const resource of resources) {
            if (this.abortSignal?.aborted) throw new Error('Validation cancelled');

            const filePath = path.join(installPath, resource.dest);
            const expectedSize = parseInt(resource.size, 10);
            const expectedMD5 = resource.md5;
            let bytesHashed = 0;

            const isValid = await this.validator.deepValidate(
                filePath,
                expectedSize,
                expectedMD5,
                (chunkSize) => {
                    bytesHashed += chunkSize;
                    this.progressTracker.updateValidationProgress(chunkSize, resource.dest);
                    this.sendProgress();
                }
            );

            const remainingBytes = expectedSize - bytesHashed;
            if (remainingBytes > 0) {
                this.progressTracker.updateValidationProgress(remainingBytes, null);
            }
            this.progressTracker.processedFiles += 1;

            if (!isValid) {
                invalidFiles.push(resource);
                logger.warn(`Invalid file detected: ${resource.dest}`);
            }

            this.sendProgress();
        }

        this.validator.clearCache();
        logger.info(`Validation complete. Found ${invalidFiles.length} invalid files.`);
        return invalidFiles;
    }

    sendProgress() {
        if (!this.progressTracker.uiThrottler.shouldUpdate()) return;

        const metrics = this.progressTracker.calculateMetrics();
        const progress = {
            status: this.getStatusText(metrics, this.metadata),
            ...metrics,
            message: this.getProgressMessage(metrics)
        };

        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send('download-progress', progress);
        }
    }

    getStatusText(metrics, metadata = {}) {
        switch (metrics.phase) {
            case 'checking':
                return 'Checking resources';
            case 'validating':
                {
                    if (metadata.isFinal) {
                        return 'Verifying integrity...';
                    }
                    const version = metadata.version;
                    return version ? `Preparing Patch ${version}` : 'Preparing download...';
                }
            case 'downloading':
                return 'Downloading';
            default:
                return 'Processing';
        }
    }

    getProgressMessage(metrics) {
        const processedGB = (metrics.processedBytes / 1024 / 1024 / 1024).toFixed(2);
        const totalGB = (metrics.totalBytes / 1024 / 1024 / 1024).toFixed(2);

        if (metrics.phase === 'validating') {
            return `${processedGB}GB/${totalGB}GB - Verifying integrity. This will not consume data.`;
        }
        return `${processedGB}GB/${totalGB}GB`;
    }
}

class GameDownloadManager {
    constructor(win, gameManager = null) {
        this.mainWindow = win;
        this.gameManager = gameManager;
        this.progressTracker = new ProgressTracker();
        this.validationPipeline = new ValidationPipeline(this.progressTracker, win);
        this.reset();
    }

    reset() {
        this.state = {
            isDownloading: false,
            isPaused: false,
            abortController: null
        };
        this.progressTracker.reset();
        this.activeStreams = new Set();
        this.completedFiles = new Set();
        this.currentPatchVersion = null;
    }

    async downloadGame(installPath, versionType = VERSION_TYPES.DEFAULT, localVersion = null) {
        if (this.state.isDownloading) {
            return CoreUtils.createStandardResponse(false, null, 'A download is already in progress.');
        }

        this.initializeDownload();

        try {
            const config = await this.getGameConfig(versionType);
            this.currentPatchVersion = config.version;
            await CoreUtils.ensureDirectory(installPath);

            const filesToDownload = await this.getFilesToDownload(config.resources, installPath);

            if (filesToDownload.length === 0) {
                logger.info('All files are valid, no download needed.');
                return await this.completeDownload(installPath, config.version, config.resources);
            }

            await this.executeDownload(filesToDownload, config.baseUrl, installPath);

            logger.info('Running final, full validation to ensure integrity...');
            const finalInvalid = await this.validationPipeline.validateResources(
                config.resources,
                installPath,
                this.state.abortController?.signal, {
                    isFinal: true,
                    version: this.currentPatchVersion
                }
            );

            if (finalInvalid.length > 0) {
                throw new Error(`Validation failed: ${finalInvalid.length} files are still corrupt after download.`);
            }

            return await this.completeDownload(installPath, config.version, config.resources);

        } catch (error) {
            return this.handleDownloadError(error);
        } finally {
            this.reset();
        }
    }

    initializeDownload() {
        this.reset();
        this.state.isDownloading = true;
        this.state.abortController = new AbortController();
    }

    async getGameConfig(versionType = VERSION_TYPES.DEFAULT) {
        this.sendProgress(STATUS.DOWNLOAD.FETCHING_CONFIG);

        const gameConfig = JSON.parse(await CoreUtils.httpRequest(
            CONSTANTS.GAME_CONFIG_URL,
            this.state.abortController?.signal
        ));

        const channelConfig = gameConfig[versionType];
        if (!channelConfig) {
            throw new Error(`Could not find a '${versionType}' configuration.`);
        }

        const cdnUrl = channelConfig.cdnList[0].url;
        const resourceListUrl = CoreUtils.combineUrl(cdnUrl, channelConfig.config.indexFile);
        const baseUrl = CoreUtils.combineUrl(cdnUrl, channelConfig.config.baseUrl);
        const response = await CoreUtils.httpRequest(resourceListUrl, this.state.abortController?.signal);
        const resources = JSON.parse(response).resource;

        return {
            resources,
            baseUrl,
            version: channelConfig.version
        };
    }

    async getFilesToDownload(resources, installPath) {
        const invalidFiles = await this.validationPipeline.validateResources(
            resources,
            installPath,
            this.state.abortController?.signal, {
                isFinal: false,
                version: this.currentPatchVersion
            }
        );

        const totalSizeToDownload = invalidFiles.reduce((sum, r) =>
            sum + parseInt(r.size, 10), 0
        );

        this.progressTracker.reset();
        this.progressTracker.totalBytes = totalSizeToDownload;
        this.progressTracker.totalFiles = invalidFiles.length;

        const fileSizeMap = new Map(invalidFiles.map(r => [r.dest, parseInt(r.size, 10)]));
        this.progressTracker.setFileSizes(fileSizeMap);

        logger.info(`Files to download: ${invalidFiles.length}, Total size: ${(totalSizeToDownload/1024/1024/1024).toFixed(2)}GB`);

        return invalidFiles;
    }

    async executeDownload(filesToDownload, baseUrl, installPath) {
        logger.info(`Starting download of ${filesToDownload.length} files...`);
        const statusText = this.currentPatchVersion ? `Downloading Patch ${this.currentPatchVersion}` : STATUS.DOWNLOAD.DOWNLOADING;
        this.progressTracker.setPhase('downloading', 'Downloading files...');
        this.sendProgress(statusText);

        const queue = [...filesToDownload];
        const workers = Array(CONSTANTS.MAX_CONCURRENT_DOWNLOADS).fill(null)
            .map(() => this.worker(queue, baseUrl, installPath));

        await Promise.all(workers);

        if (this.state.abortController.signal.aborted) {
            throw new Error("Download was cancelled by the user.");
        }
    }

    async worker(queue, baseUrl, installPath) {
        while (queue.length > 0) {
            if (this.state.abortController?.signal.aborted) {
                throw new Error("Download aborted by user.");
            }

            if (this.state.isPaused) {
                await this.waitForResume();
                continue;
            }

            const resource = queue.shift();
            if (resource) {
                await this.downloadFileWithRetry(resource, baseUrl, installPath);
            }
        }
    }

    waitForResume() {
        return new Promise((resolve) => {
            const checkInterval = setInterval(() => {
                if (!this.state.isPaused || this.state.abortController?.signal.aborted) {
                    clearInterval(checkInterval);
                    resolve();
                }
            }, 100);
        });
    }

    async downloadFileWithRetry(resource, baseUrl, installPath) {
        const filePath = CoreUtils.normalizePath(installPath, resource.dest);
        const fileSize = parseInt(resource.size, 10);
        const fileId = resource.dest;

        return await CoreUtils.withRetry(async () => {
            if (this.state.abortController?.signal.aborted) {
                throw new Error('Download aborted by user.');
            }

            await CoreUtils.ensureDirectory(path.dirname(filePath));

            const url = CoreUtils.combineUrl(baseUrl, resource.dest);
            await this.downloadAndPipe(url, filePath, fileId, fileSize);

            const validator = new FileValidator();
            if (!(await validator.quickValidate(filePath, fileSize))) {
                throw new Error('File validation failed after download.');
            }

            this.progressTracker.updateFileProgress(fileId, 0, true);
            this.completedFiles.add(fileId);

        }, CONSTANTS.MAX_RETRIES);
    }

    downloadAndPipe(url, filePath, fileId, fileSize) {
        return new Promise((resolve, reject) => {
            const protocol = url.startsWith('https') ? https : http;
            const request = protocol.get(url, {
                signal: this.state.abortController?.signal
            }, (res) => {
                if (res.statusCode !== 200) {
                    res.resume();
                    return reject(new Error(`HTTP Error: ${res.statusCode} for URL ${url}`));
                }

                this.setupDownloadStream(res, filePath, fileId, fileSize, resolve, reject);
            });

            request.on('error', reject);
        });
    }

    setupDownloadStream(res, filePath, fileId, fileSize, resolve, reject) {
        this.activeStreams.add(res);

        if (this.state.isPaused && !res.destroyed) {
            res.pause();
        }

        const fileStream = createWriteStream(filePath);
        const progressStream = new ProgressStream(fileId, this.progressTracker);

        const progressInterval = setInterval(() => {
            if (!this.state.isPaused && this.state.isDownloading &&
                this.progressTracker.uiThrottler.shouldUpdate()) {
                const statusText = this.currentPatchVersion ? `Downloading Patch ${this.currentPatchVersion}` : STATUS.DOWNLOAD.DOWNLOADING;
                this.sendProgress(statusText);
            }
        }, CONSTANTS.PROGRESS_UPDATE_INTERVAL || 50);

        pipeline(res, progressStream, fileStream, (err) => {
            clearInterval(progressInterval);
            this.activeStreams.delete(res);

            if (err) {
                fileStream.close(() => {
                    fs.unlink(filePath)
                        .catch(() => {})
                        .finally(() => reject(err));
                });
            } else {
                this.progressTracker.uiThrottler.forceUpdate();
                const statusText = this.currentPatchVersion ? `Downloading Patch ${this.currentPatchVersion}` : STATUS.DOWNLOAD.DOWNLOADING;
                this.sendProgress(statusText);
                resolve();
            }
        });
    }

    sendProgress(status, extra = {}) {
        if (!this.mainWindow || this.mainWindow.isDestroyed()) return;

        const metrics = this.progressTracker.calculateMetrics();
        const progressData = {
            status,
            ...metrics,
            ...extra
        };

        try {
            this.mainWindow.webContents.send('download-progress', progressData);
        } catch (error) {
            logger.warn('Failed to send download progress:', error.message);
        }
    }

    pauseDownload() {
        if (this.state.isDownloading && !this.state.isPaused) {
            this.state.isPaused = true;

            this.activeStreams.forEach(stream => {
                try {
                    if (stream && !stream.destroyed) stream.pause();
                } catch (error) {
                    logger.warn('Error pausing stream:', error.message);
                }
            });

            this.sendProgress(STATUS.DOWNLOAD.PAUSED);
            logger.info('Download paused.');
        }
    }

    resumeDownload() {
        if (this.state.isDownloading && this.state.isPaused) {
            this.state.isPaused = false;

            this.progressTracker.lastUpdate = Date.now();

            this.activeStreams.forEach(stream => {
                try {
                    if (stream && !stream.destroyed) stream.resume();
                } catch (error) {
                    logger.warn('Error resuming stream:', error.message);
                }
            });

            const statusText = this.currentPatchVersion ? `Downloading Patch ${this.currentPatchVersion}` : STATUS.DOWNLOAD.DOWNLOADING;
            this.sendProgress(statusText);
            logger.info('Download resumed.');
        }
    }

    cancelDownload() {
        if (this.state.isDownloading && this.state.abortController) {
            logger.info('Cancelling download...');
            this.state.abortController.abort();
            this.activeStreams.forEach(stream => stream.destroy());
            this.activeStreams.clear();
        }
    }

    async completeDownload(installPath, version, resources) {
        logger.info("Game download completed successfully.");

        await GameUtils.updateGameConfig(installPath, version);
        logger.info(`Game config updated to version ${version}`);

        await new Promise(resolve => setTimeout(resolve, 500));

        if (this.gameManager) {
            this.gameManager.clearUpdateCache();
            logger.info('GameManager update cache cleared after successful download.');
        }

        try {
            const indexPath = path.join(installPath, 'LocalGameResources.json');
            await CoreUtils.writeJsonFile(indexPath, {
                resource: resources
            });
            logger.info('Local game resources index saved for quick repair.');
        } catch (error) {
            logger.error('Failed to save local resources index:', error);
        }

        if (this.gameManager) {
            logger.info('Running fresh update check after download completion...');
            const freshUpdateCheck = await this.gameManager.checkForUpdates(true);

            if (freshUpdateCheck.success) {
                logger.info(`Post-download update check: Update available = ${freshUpdateCheck.updateAvailable}`);

                if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                    this.mainWindow.webContents.send('update-status-refreshed', {
                        updateAvailable: freshUpdateCheck.updateAvailable,
                        currentVersion: freshUpdateCheck.currentVersion,
                        latestVersion: freshUpdateCheck.latestVersion
                    });
                }
            }
        }

        this.sendProgress(STATUS.DOWNLOAD.COMPLETED, {
            percentage: 100
        });
        return CoreUtils.createStandardResponse(true, {
            installPath,
            version
        });
    }

    handleDownloadError(error) {
        logger.error(`Download failed: ${error.stack || error.message}`);

        const isCancelled = this.state.abortController?.signal.aborted;
        const status = isCancelled ? STATUS.DOWNLOAD.CANCELLED : STATUS.DOWNLOAD.ERROR;

        this.sendProgress(status, {
            error: error.message
        });
        return CoreUtils.createStandardResponse(false, {
            cancelled: isCancelled
        }, error.message);
    }

    cleanup() {
        this.activeStreams.forEach(stream => {
            if (stream && typeof stream.destroy === 'function') {
                stream.destroy();
            }
        });
        this.activeStreams.clear();

        if (this.state.abortController) {
            this.state.abortController.abort();
        }

        this.reset();
    }

    emergencyReset() {
        logger.warn('Emergency reset triggered - clearing all download state');
        this.cleanup();
        this.sendProgress(STATUS.DOWNLOAD.CANCELLED);
    }
}

class GameRepairManager {
    constructor(win, gameManager = null) {
        this.mainWindow = win;
        this.gameManager = gameManager;
        this.progressTracker = new ProgressTracker();
        this.validator = new FileValidator();
        this.isRepairing = false;
        this.abortController = null;
    }

    async repairGame(gamePath, mode = 'full') {
        if (this.isRepairing) {
            this.sendProgress({
                status: STATUS.REPAIR.ERROR,
                error: 'Repair process is already running.'
            });
            return;
        }

        this.isRepairing = true;
        this.abortController = new AbortController();
        this.progressTracker.reset();
        const startTime = Date.now();

        try {
            let resources;
            let baseUrl;

            if (mode === 'quick') {
                try {
                    resources = await this.getLocalResources(gamePath);
                    logger.info(`Quick repair using local index: ${resources.length} files`);
                } catch (localError) {
                    logger.warn(`Local index failed (${localError.message}), falling back to remote index`);
                    const config = await this.fetchGameConfig();
                    resources = config.resources;
                    baseUrl = config.baseUrl;
                    logger.info(`Quick repair using remote index: ${resources.length} files`);
                }
            } else {
                const config = await this.fetchGameConfig();
                resources = config.resources;
                baseUrl = config.baseUrl;
                logger.info(`Full repair using remote index: ${resources.length} files`);
            }

            if (!resources || !Array.isArray(resources)) {
                throw new Error('Invalid game index structure.');
            }

            if (resources.length < 100) {
                logger.warn(`Found only ${resources.length} files in index, this seems low. Fetching remote index as backup.`);
                if (mode === 'quick') {
                    const config = await this.fetchGameConfig();
                    resources = config.resources;
                    baseUrl = config.baseUrl;
                    logger.info(`Using remote index instead: ${resources.length} files`);
                }
            }

            const corruptFiles = await this.validateGameFilesWithPerFileUpdates(resources, gamePath, mode);

            if (this.abortController?.signal.aborted) {
                throw new Error('cancelled');
            }

            if (corruptFiles.length === 0) {
                this.handleRepairComplete(startTime, 0, resources.length);
                return;
            }

            if (mode === 'quick' && !baseUrl) {
                const config = await this.fetchGameConfig();
                baseUrl = config.baseUrl;
            }

            await this.repairCorruptFiles(corruptFiles, baseUrl, gamePath);

            if (this.abortController?.signal.aborted) {
                throw new Error('cancelled');
            }

            this.handleRepairComplete(startTime, corruptFiles.length, resources.length);

        } catch (error) {
            this.handleRepairError(error);
        } finally {
            this.cleanup();
        }
    }

    async getLocalResources(gamePath) {
        this.progressTracker.phase = 'fetching';
        this.sendProgress({
            status: STATUS.REPAIR.FETCHING_INDEX,
            message: 'Reading local file index...'
        });

        const possiblePaths = [
            path.join(gamePath, 'OriginResource.json'),
            path.join(gamePath, 'LocalGameResources.json'),
        ];

        for (const indexPath of possiblePaths) {
            if (await CoreUtils.fileExists(indexPath)) {
                logger.info(`Checking local index at: ${indexPath}`);
                const localIndex = await CoreUtils.readJsonFile(indexPath);

                let resources = null;
                if (localIndex?.resource) {
                    resources = localIndex.resource;
                } else if (localIndex?.resources) {
                    resources = localIndex.resources;
                }

                if (resources && Array.isArray(resources) && resources.length > 0) {
                    logger.info(`Found ${resources.length} files in ${path.basename(indexPath)}`);

                    if (resources.length >= 100) {
                        return resources;
                    } else {
                        logger.warn(`Only ${resources.length} files found in ${path.basename(indexPath)}, checking next option...`);
                    }
                }
            }
        }

        throw new Error('Quick Check failed: No valid local index found with sufficient files. Please run a Full Check.');
    }

    async fetchGameConfig() {
        this.progressTracker.phase = 'fetching';
        this.sendProgress({
            status: STATUS.REPAIR.FETCHING_CONFIG
        });

        const gameConfig = JSON.parse(await CoreUtils.httpRequest(
            CONSTANTS.GAME_CONFIG_URL,
            this.abortController?.signal
        ));

        const channelConfig = gameConfig.default;
        if (!channelConfig) {
            throw new Error('Could not find default configuration for repair.');
        }

        const cdnUrl = channelConfig.cdnList[0].url;
        const indexUrl = CoreUtils.combineUrl(cdnUrl, channelConfig.config.indexFile);
        const baseUrl = CoreUtils.combineUrl(cdnUrl, channelConfig.config.baseUrl);

        this.sendProgress({
            status: STATUS.REPAIR.FETCHING_INDEX
        });

        const indexData = JSON.parse(await CoreUtils.httpRequest(
            indexUrl,
            this.abortController?.signal
        ));

        return {
            resources: indexData.resource || indexData.resources,
            baseUrl
        };
    }

    async validateGameFilesWithPerFileUpdates(resources, gamePath, mode) {
        const totalFiles = resources.length;
        const totalBytes = resources.reduce((sum, r) => sum + parseInt(r.size, 10), 0);

        this.progressTracker.totalFiles = totalFiles;
        this.progressTracker.totalBytes = totalBytes;
        this.progressTracker.phase = 'validating';

        logger.info(`Starting validation of ${totalFiles} files (${(totalBytes/1024/1024/1024).toFixed(2)}GB) in ${mode} mode`);

        this.sendProgress({
            status: STATUS.REPAIR.VALIDATING,
            totalFiles,
            validatedFiles: 0,
            filesToRepair: 0,
            message: `Validating ${totalFiles} files...`
        });

        const corruptFiles = [];
        const batchSize = CONSTANTS.VALIDATION_BATCH_SIZE || 100;
        const isQuickMode = mode === 'quick';

        for (let i = 0; i < resources.length; i += batchSize) {
            if (this.abortController?.signal.aborted) {
                throw new Error('cancelled');
            }

            const batch = resources.slice(i, Math.min(i + batchSize, resources.length));

            for (const resource of batch) {
                if (this.abortController?.signal.aborted) {
                    throw new Error('cancelled');
                }

                const filePath = path.join(gamePath, resource.dest);
                const expectedSize = parseInt(resource.size, 10);

                this.progressTracker.currentFile = resource.dest;

                let isValid;
                if (isQuickMode) {
                    isValid = await this.validator.quickValidate(filePath, expectedSize);
                } else {
                    isValid = await this.validator.deepValidate(
                        filePath,
                        expectedSize,
                        resource.md5,
                        (chunkSize) => {
                            this.progressTracker.updateProgress(chunkSize);
                            if (this.progressTracker.uiThrottler.shouldUpdate()) {
                                this.sendValidationProgress(corruptFiles.length);
                            }
                        }
                    );
                }

                if (isQuickMode) {
                    this.progressTracker.updateProgress(expectedSize);
                }

                if (!isValid) {
                    corruptFiles.push(resource);
                    this.logCorruptFile(resource.dest);
                } else {
                    this.logValidFile(resource.dest);
                }

                this.progressTracker.incrementProcessedFiles();

                if (this.progressTracker.uiThrottler.shouldUpdate()) {
                    this.sendValidationProgress(corruptFiles.length);
                }
            }
        }

        this.progressTracker.setCorruptFiles(corruptFiles);
        logger.info(`Validation complete: ${corruptFiles.length} corrupt files found out of ${totalFiles} total files`);

        return corruptFiles;
    }

    async repairCorruptFiles(corruptFiles, baseUrl, gamePath) {
        const totalFiles = corruptFiles.length;
        const totalBytes = corruptFiles.reduce((sum, r) => sum + parseInt(r.size, 10), 0);

        this.progressTracker.downloadedBytes = 0;
        this.progressTracker.repairedFiles = 0;
        this.progressTracker.totalBytes = totalBytes;
        this.progressTracker.phase = 'repairing';
        this.progressTracker.setCorruptFiles(corruptFiles);

        logger.info(`Starting repair of ${totalFiles} files (${(totalBytes/1024/1024/1024).toFixed(2)}GB)`);

        this.sendProgress({
            status: 'Downloading missing/corrupted files',
            totalFiles: this.progressTracker.totalFiles,
            validatedFiles: this.progressTracker.processedFiles,
            repairedFiles: 0,
            totalToRepair: totalFiles,
            downloadProgress: 0,
            logMessage: `[INFO] Starting download of ${totalFiles} missing/corrupted files...`
        });

        const queue = [...corruptFiles];
        const workers = Array(CONSTANTS.MAX_CONCURRENT_REPAIRS || 4)
            .fill(null)
            .map(() => this.repairWorker(queue, baseUrl, gamePath));

        await Promise.all(workers);

        logger.info(`Repair complete: ${this.progressTracker.repairedFiles} files repaired`);
    }

    async repairWorker(queue, baseUrl, gamePath) {
        while (queue.length > 0) {
            if (this.abortController?.signal.aborted) {
                throw new Error('Repair aborted');
            }

            const resource = queue.shift();
            if (resource) {
                await this.repairFile(resource, baseUrl, gamePath);
                this.progressTracker.incrementRepairedFiles();
            }
        }
    }

    async repairFile(resource, baseUrl, gamePath) {
        const filePath = path.join(gamePath, resource.dest);
        const fileName = path.basename(resource.dest);
        const fileSize = parseInt(resource.size, 10);

        this.progressTracker.currentFile = resource.dest;

        this.logRepairAction(fileName, 'repairing');

        return await CoreUtils.withRetry(async () => {
            if (this.abortController?.signal.aborted) {
                throw new Error('Download aborted');
            }

            const url = CoreUtils.combineUrl(baseUrl, resource.dest);
            await CoreUtils.ensureDirectory(path.dirname(filePath));

            await this.downloadFile(url, filePath, fileSize);

            const isValid = await this.validator.quickValidate(filePath, fileSize);
            if (!isValid) {
                throw new Error('File verification failed after download.');
            }

            this.logRepairAction(fileName, 'repaired');

        }, CONSTANTS.MAX_REPAIR_RETRIES);
    }

    downloadFile(url, filePath, fileSize) {
        return new Promise((resolve, reject) => {
            let downloadedBytes = 0;
            const protocol = url.startsWith('https:') ? https : http;

            const request = protocol.get(url, {
                signal: this.abortController?.signal
            }, (response) => {
                if (response.statusCode !== 200) {
                    response.resume();
                    return reject(new Error(`HTTP Error: ${response.statusCode}`));
                }

                const fileStream = createWriteStream(filePath);
                const progressStream = ProgressStream.createForRepair(chunkLength => {
                    downloadedBytes += chunkLength;
                    this.progressTracker.updateDownloadProgress(chunkLength);

                    if (this.progressTracker.uiThrottler.shouldUpdate()) {
                        this.sendRepairProgress();
                    }
                });

                pipeline(response, progressStream, fileStream, (err) => {
                    if (err) {
                        fileStream.close(() =>
                            fs.unlink(filePath)
                            .catch(() => {})
                            .finally(() => reject(err))
                        );
                    } else {
                        this.progressTracker.uiThrottler.forceUpdate();
                        this.sendRepairProgress();
                        resolve();
                    }
                });
            });

            request.on('error', reject);
        });
    }

    sendProgress(data) {
        if (!this.mainWindow || this.mainWindow.isDestroyed()) return;

        try {
            this.mainWindow.webContents.send('repair-progress', data);
        } catch (error) {
            logger.warn('Failed to send repair progress:', error.message);
        }
    }

    sendValidationProgress(corruptCount) {
        const progress = this.progressTracker.calculateMetrics();

        this.sendProgress({
            status: STATUS.REPAIR.VALIDATING,
            ...progress,
            message: this.getProgressMessage(progress),
            currentFile: progress.currentFile
        });
    }

    sendRepairProgress() {
        const progress = this.progressTracker.calculateMetrics();

        this.sendProgress({
            status: STATUS.REPAIR.REPAIRING,
            ...progress,
            message: this.getProgressMessage(progress),
            currentFile: progress.currentFile,
            downloadProgress: progress.percentage
        });
    }

    getProgressMessage(progress) {
        const processedGB = (progress.processedBytes / 1024 / 1024 / 1024).toFixed(2);
        const totalGB = (progress.totalBytes / 1024 / 1024 / 1024).toFixed(2);

        switch (progress.phase) {
            case 'validating':
                return `Checking: ${processedGB}GB/${totalGB}GB - Files: ${progress.validatedFiles}/${progress.totalFiles}`;
            case 'repairing':
                const speed = progress.speed > 0 ? ` - ${(progress.speed / 1024 / 1024).toFixed(2)} MB/s` : '';
                return `Repairing: ${progress.repairedFiles}/${progress.filesToRepair} files - ${processedGB}GB/${totalGB}GB${speed}`;
            default:
                return `Processing: ${processedGB}GB/${totalGB}GB`;
        }
    }

    logValidFile(fileName) {
        const message = `[Valid] ${fileName}`;
        this.sendProgress({
            logMessage: message
        });
    }

    logCorruptFile(fileName) {
        const message = `[Invalid] ${fileName}`;
        this.sendProgress({
            logMessage: message
        });
    }

    logRepairAction(fileName, type) {
        let prefix;
        switch (type) {
            case 'repairing':
                prefix = '[Repairing]';
                break;
            case 'repaired':
                prefix = '[Repaired]';
                break;
            default:
                prefix = '[INFO]';
        }
        const logMessage = `${prefix} ${fileName}`;
        this.sendProgress({
            logMessage
        });
    }

    handleRepairComplete(startTime, repairedCount, totalValidated) {
        const duration = (Date.now() - startTime) / 1000;
        const message = repairedCount > 0 ?
            `Successfully repaired ${repairedCount} files out of ${totalValidated} validated in ${duration.toFixed(1)}s` :
            `All ${totalValidated} files are valid!`;

        logger.info(`Repair completed: ${message}`);

        if (this.gameManager && repairedCount > 0) {
            logger.info('Clearing GameManager update cache after repair completion');
            this.gameManager.clearUpdateCache();
        }

        this.sendProgress({
            status: STATUS.REPAIR.COMPLETED,
            message,
            totalFiles: this.progressTracker.totalFiles,
            validatedFiles: this.progressTracker.totalFiles,
            filesToRepair: repairedCount,
            repairedFiles: repairedCount,
            downloadProgress: 100,
            logMessage: `[COMPLETED] ${message}`
        });
    }

    handleRepairError(error) {
        const isCancelled = error.message.includes('cancelled') ||
            this.abortController?.signal.aborted;

        if (isCancelled) {
            this.sendProgress({
                status: STATUS.REPAIR.CANCELLED
            });
            logger.info('Repair process was cancelled.');
        } else {
            this.sendProgress({
                status: STATUS.REPAIR.ERROR,
                error: error.message
            });
            logger.error(`Game repair failed: ${error.stack || error.message}`);
        }
    }

    cancelRepair() {
        if (this.isRepairing && this.abortController) {
            logger.info('Cancelling repair...');
            this.abortController.abort();
        }
    }

    cleanup() {
        this.isRepairing = false;
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
        this.progressTracker.reset();
        this.validator.clearCache();
    }
}

function setupFileHandlerIPC(ipcMain, win, launcherConfig, gameManager = null) {
    const downloadManager = new GameDownloadManager(win, gameManager);
    const repairManager = new GameRepairManager(win, gameManager);

    ipcMain.handle('start-download', async (event, {
        installPath,
        versionType = VERSION_TYPES.DEFAULT,
        localVersion = null
    }) => {
        let selectedPath = installPath || launcherConfig.get('gamePath');

        if (!selectedPath) {
            const {
                canceled,
                filePaths
            } = await dialog.showOpenDialog(win, {
                title: 'Select Installation Folder',
                defaultPath: CoreUtils.getAppDataPath('Games'),
                properties: ['openDirectory', 'createDirectory']
            });

            if (canceled || !filePaths?.length) {
                return CoreUtils.createStandardResponse(false, {
                    cancelled: true
                }, 'Installation path not selected.');
            }
            selectedPath = filePaths[0];
        }

        launcherConfig.set('gamePath', selectedPath);
        const result = await downloadManager.downloadGame(selectedPath, versionType, null);

        if (result.success) {
            if (versionType === VERSION_TYPES.DEFAULT) {
                launcherConfig.set('isFirstRunPending', true);
            }

            win.webContents.send('installation-complete', {
                gamePath: result.installPath,
                version: result.version,
            });
        }

        return result;
    });

    const downloadControlHandlers = {
        'pause-download': () => {
            downloadManager.pauseDownload();
            return CoreUtils.createStandardResponse(true);
        },
        'resume-download': () => {
            downloadManager.resumeDownload();
            return CoreUtils.createStandardResponse(true);
        },
        'cancel-download': () => {
            downloadManager.cancelDownload();
            return CoreUtils.createStandardResponse(true);
        },
        'reset-download-progress': () => {
            downloadManager.emergencyReset();
            return CoreUtils.createStandardResponse(true);
        }
    };

    Object.entries(downloadControlHandlers).forEach(([event, handler]) => {
        ipcMain.handle(event, handler);
    });

    const handleRepairRequest = async (mode) => {
        const gamePath = launcherConfig.get('gamePath');
        if (!gamePath) {
            logger.warn(`Repair attempted without a configured game path (mode: ${mode}).`);
            return CoreUtils.createStandardResponse(false, null, 'Game path is not configured.');
        }

        repairManager.repairGame(gamePath, mode);
        return CoreUtils.createStandardResponse(true);
    };

    ipcMain.handle('start-repair', () => handleRepairRequest('full'));
    ipcMain.handle('start-quick-repair', () => handleRepairRequest('quick'));

    ipcMain.handle('cancel-repair', async () => {
        repairManager.cancelRepair();
        return CoreUtils.createStandardResponse(true);
    });

    ipcMain.handle('select-install-directory', async () => {
        const {
            canceled,
            filePaths
        } = await dialog.showOpenDialog(win, {
            title: 'Select Custom Installation Folder',
            properties: ['openDirectory', 'createDirectory']
        });
        return {
            canceled,
            path: filePaths?.[0]
        };
    });

    ipcMain.handle('verify-game-integrity', async () => {
        const gamePath = launcherConfig.get('gamePath');
        if (!gamePath) {
            return CoreUtils.createStandardResponse(false, null, 'Game path not set.');
        }

        try {
            const { resources } = await downloadManager.getGameConfig();
            const pipeline = new ValidationPipeline(new ProgressTracker(), win);

            const invalidFiles = await pipeline.validateResources(
                resources,
                gamePath,
                null,
                { isFinal: true }
            );

            const finalStatus = invalidFiles.length > 0 ? 'Verification Failed' : 'Verification Complete';
            pipeline.progressTracker.forceCompletion();
            win.webContents.send('download-progress', {
                status: finalStatus,
                ...pipeline.progressTracker.calculateMetrics(),
                percentage: 100
            });

            return CoreUtils.createStandardResponse(true, { invalidFiles });

        } catch (error) {
            logger.error('Game integrity verification failed:', error);
            win.webContents.send('download-progress', { status: 'Error', error: error.message });
            return CoreUtils.createStandardResponse(false, null, error.message);
        }
    });

    win.on('close', () => {
        downloadManager.cleanup();
        repairManager.cleanup();
    });
}

module.exports = {
    setupFileHandlerIPC,
    GameDownloadManager,
    GameRepairManager
};