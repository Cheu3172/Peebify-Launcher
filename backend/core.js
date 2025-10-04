const https = require('https');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const dns = require('dns');
const { promises: fs } = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { app } = require('electron');

const CONSTANTS = {
    GAME_CONFIG_URL: 'https://prod-alicdn-gamestarter.kurogame.com/launcher/game/G153/50004_obOHXFrFanqsaIEOmuKroCcbZkQRBC7c/index.json',
    NEWS_URL: 'https://prod-alicdn-gamestarter.kurogame.com/launcher/50004_obOHXFrFanqsaIEOmuKroCcbZkQRBC7c/G153/information/en.json',

    GAME_EXECUTABLE: 'Wuthering Waves.exe',
    GAME_CLIENT_PROCESS: 'Client-Win64-Shipping.exe',

    SCREENSHOT_PATH: ['Client', 'Saved', 'ScreenShot'],
    CONFIG_FILE: 'launcher-config.json',
    GAME_CONFIG_FILE: 'launcherDownloadConfig.json',

    HTTP_TIMEOUT: 30000,
    PROCESS_MONITOR_INTERVAL: 50,
    PROGRESS_UPDATE_INTERVAL: 50,
    VALIDATION_BATCH_SIZE: 100,
    VALIDATION_UPDATE_INTERVAL: 100,
    STREAM_CHUNK_SIZE: 1024 * 1024,
    AUTO_UPDATE_INTERVAL: 4 * 60 * 60 * 1000,

    MAX_RETRIES: 10,
    MAX_REPAIR_RETRIES: 10,
    RETRY_DELAY_BASE: 1000,

    MAX_CONCURRENT_DOWNLOADS: 8,
    MAX_CONCURRENT_REPAIRS: 8,

    BUILD_TYPE: 'stable', // Set to 'stable' or 'beta'
    APP_ID: '50004',
    APP_USER_MODEL_ID: 'com.peebify.launcher',
    TASK_NAME: 'PeebifyLauncherStartup'
};

const STATUS = {
    DOWNLOAD: Object.freeze({
        FETCHING_CONFIG: 'Fetching remote configuration...',
        VERIFYING: 'Verifying existing files...',
        DOWNLOADING: 'Downloading...',
        PAUSED: 'Paused',
        CANCELLED: 'Cancelled',
        COMPLETED: 'Completed',
        ERROR: 'Error'
    }),

    REPAIR: Object.freeze({
        FETCHING_CONFIG: 'Fetching configuration...',
        FETCHING_INDEX: 'Fetching file index...',
        VALIDATING: 'Validating',
        REPAIRING: 'Repairing',
        COMPLETED: 'Completed',
        CANCELLED: 'Cancelled',
        ERROR: 'Error'
    })
};

const VERSION_TYPES = {
    DEFAULT: 'default'
};

const DURATION_FORMATS = {
    DEFAULT: 'default',
    SHORT: 'short',
    SHORT_SECONDS: 'short_seconds'
};

const DEFAULT_CONFIGS = {
    LAUNCHER: {
        gamePath: '',
        window: {
            width: 1280,
            height: 720,
            maximized: false,
        },
        behavior: {
            closeAction: 'close',
            minimizeAction: 'minimize',
            startOnBoot: false,
            autoLaunchGame: false,
            startOnBootAction: 'open',
            launchAction: 'minimize',
            invisibleSidebar: false,
            hideSocials: false,
            hideBottomRightButtons: false,
            hidePlaytime: false,
            uiCornerRadius: 'round',
            hideVersionTitle: false,
            updateBranch: 'stable',
            hideNewsPanel: false,
        },
        wallpaper: {
            type: 'default',
            path: null,
        },
        totalPlaytime: 0,
        mostRecentSession: null,
        isFirstRunPending: false,
        dailyPlaytime: {},
        sessionCount: 0,
    },

    GAME_DOWNLOAD: {
        version: '',
        reUseVersion: '',
        state: '',
        appId: CONSTANTS.APP_ID
    }
};

const EXTERNAL_LINKS = {
    COMMUNITY_TOOLS: {
        official: [{
            id: 'wuthering-waves-official',
            name: 'Wuthering Waves Official',
            url: 'https://wutheringwaves.kurogames.com/en/main',
            icon: 'fas fa-globe'
        }, {
            id: 'wuthering-waves-news',
            name: 'Wuthering Waves News',
            url: 'https://wutheringwaves.kurogames.com/en/main#news',
            icon: 'fas fa-newspaper'
        }],
        community: [{
            id: 'wuwa-tracker',
            name: 'Wuwa Tracker',
            url: 'https://wuwatracker.com/',
            icon: 'fas fa-chart-line'
        }, {
            id: 'wuwa-map',
            name: 'Wuwa Map',
            url: 'https://wuthering.gg/map',
            icon: 'fas fa-map'
        }]
    },

    SOCIAL: {
        discord: 'https://discord.gg/wutheringwaves',
        youtube: 'https://www.youtube.com/c/WutheringWaves',
        x: 'https://twitter.com/Wuthering_Waves',
        lunite: 'https://payment.kurogame-service.com/pay/wutheringwaves/'
    }
};

class CoreUtils {
    static isOnline() {
        return new Promise((resolve) => {
            dns.lookup('google.com', (err) => {
                resolve(err === null);
            });
        });
    }

    static httpRequest(url, signal) {
        return new Promise((resolve, reject) => {
            const protocol = url.startsWith('https:') ? https : http;
            const request = protocol.get(url, {
                signal
            }, (response) => {
                if (response.statusCode !== 200) {
                    return reject(new Error(`HTTP ${response.statusCode} for ${url}`));
                }

                const stream = response.headers['content-encoding'] === 'gzip' ?
                    response.pipe(zlib.createGunzip()) :
                    response;

                let data = '';
                stream.on('data', chunk => data += chunk);
                stream.on('end', () => resolve(data));
                stream.on('error', err => reject(new Error(`Stream error: ${err.message}`)));
            });

            request.on('error', err => {
                const message = err.name === 'AbortError' ? 'Request aborted' : `Request error: ${err.message}`;
                reject(new Error(message));
            });

            request.setTimeout(CONSTANTS.HTTP_TIMEOUT, () => {
                request.destroy(new Error(`Request timeout: ${url}`));
            });
        });
    }

    static calculateMD5(filePath) {
        return new Promise((resolve, reject) => {
            const hash = crypto.createHash('md5');
            const stream = require('fs').createReadStream(filePath);
            stream.on('data', data => hash.update(data));
            stream.on('end', () => resolve(hash.digest('hex')));
            stream.on('error', err => reject(new Error(`MD5 calculation failed: ${err.message}`)));
        });
    }

    static async validateFile(filePath, expectedSize, expectedMD5, isQuickCheck = false) {
        try {
            const stats = await fs.stat(filePath);
            if (stats.size !== expectedSize) return false;

            if (isQuickCheck) {
                return true;
            }

            if (expectedMD5) {
                const actualMD5 = await this.calculateMD5(filePath);
                return actualMD5.toLowerCase() === expectedMD5.toLowerCase();
            }
            return true;
        } catch (error) {
            if (error.code === 'ENOENT') return false;
            throw new Error(`File validation failed: ${error.message}`);
        }
    }

    static async ensureDirectory(dirPath) {
        try {
            await fs.mkdir(dirPath, {
                recursive: true
            });
            return {
                success: true
            };
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }

    static async fileExists(filePath) {
        try {
            await fs.access(filePath);
            return true;
        } catch {
            return false;
        }
    }

    static async moveFileOrDirectory(sourcePath, destPath) {
        try {
            await fs.rename(sourcePath, destPath);
            return {
                success: true,
                method: 'rename'
            };
        } catch (error) {
            if (error.code === 'EXDEV') {
                const stats = await fs.stat(sourcePath);
                if (stats.isDirectory()) {
                    await fs.cp(sourcePath, destPath, {
                        recursive: true
                    });
                } else {
                    await fs.copyFile(sourcePath, destPath);
                }
                await fs.rm(sourcePath, {
                    recursive: true,
                    force: true
                });
                return {
                    success: true,
                    method: 'copy-delete'
                };
            }
            throw error;
        }
    }

    static combineUrl(base, ...parts) {
        let result = base.endsWith('/') ? base.slice(0, -1) : base;
        for (const part of parts) {
            const p = part.startsWith('/') ? part.slice(1) : part;
            result += `/${p}`;
        }
        return result;
    }

    static normalizePath(...pathParts) {
        return path.join(...pathParts).replace(/\\/g, path.sep);
    }

    static getAppDataPath(...subPaths) {
        return path.join(app.getPath('userData'), ...subPaths);
    }

    static execAsync(command) {
        return new Promise((resolve, reject) => {
            exec(command, (error, stdout, stderr) => {
                if (error) reject(error);
                else resolve(stdout);
            });
        });
    }

    static async isProcessRunning(processName) {
        try {
            const command = `tasklist /FI "IMAGENAME eq ${processName}"`;
            const stdout = await this.execAsync(command);
            return stdout.toLowerCase().includes(processName.toLowerCase());
        } catch {
            return false;
        }
    }

    static async terminateProcess(processName) {
        try {
            await this.execAsync(`taskkill /F /T /IM "${processName}"`);
            return {
                success: true
            };
        } catch (error) {
            if (error.message.includes('not found')) {
                return {
                    success: true
                };
            }
            return {
                success: false,
                error: 'Could not terminate process.'
            };
        }
    }

    static formatDuration(totalSeconds, format = DURATION_FORMATS.DEFAULT) {
        if (isNaN(totalSeconds) || totalSeconds <= 0) return '00:00:00';

        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = Math.floor(totalSeconds % 60);

        switch (format) {
            case DURATION_FORMATS.SHORT_SECONDS:
                return `${hours}h ${minutes}m ${seconds}s`;
            case DURATION_FORMATS.SHORT:
                return `${hours}h ${minutes}m`;
            default:
                return [hours, minutes, seconds]
                    .map(v => String(v).padStart(2, '0'))
                    .join(':');
        }
    }

    static formatDurationMs(ms, format = DURATION_FORMATS.DEFAULT) {
        if (ms < 0) ms = 0;
        const totalSeconds = Math.floor(ms / 1000);
        const totalMinutes = Math.floor(totalSeconds / 60);
        const totalHours = Math.floor(totalMinutes / 60);
        const days = Math.floor(totalHours / 24);

        const hours = totalHours % 24;
        const minutes = totalMinutes % 60;
        const seconds = totalSeconds % 60;

        switch (format) {
            case DURATION_FORMATS.SHORT_SECONDS:
                return `${totalHours}h ${minutes}m ${seconds}s`;
            case DURATION_FORMATS.SHORT:
                return `${totalHours}h ${minutes}m`;
            default:
                return days > 0 ? `${days}d ${hours}h` : `${hours}h ${minutes}m`;
        }
    }

    static isVersionNewer(remoteVersion, localVersion) {
        if (!remoteVersion || !localVersion) return false;
        return remoteVersion.localeCompare(localVersion, undefined, {
            numeric: true,
            sensitivity: 'base'
        }) > 0;
    }

    static shouldUpdateProgress(lastUpdate, interval = CONSTANTS.PROGRESS_UPDATE_INTERVAL) {
        return (Date.now() - lastUpdate) >= interval;
    }

    static calculateProgress(downloaded, total) {
        return total > 0 ? (downloaded / total) * 100 : 0;
    }

    static calculateSpeed(byteDiff, timeDiff) {
        return timeDiff > 0 ? byteDiff / timeDiff : 0;
    }

    static calculateETA(remainingBytes, speed) {
        return speed > 0 ? remainingBytes / speed : 0;
    }

    static createStandardResponse(success, data = null, error = null) {
        const response = {
            success
        };
        if (data) Object.assign(response, data);
        if (error) response.error = error;
        return response;
    }

    static async withRetry(operation, maxRetries = CONSTANTS.MAX_RETRIES, baseDelay = CONSTANTS.RETRY_DELAY_BASE) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await operation();
            } catch (error) {
                if (attempt === maxRetries) throw error;
                await new Promise(resolve => setTimeout(resolve, baseDelay * attempt));
            }
        }
    }

    static mergeConfig(defaultConfig, userConfig) {
        const merged = { ...defaultConfig
        };

        for (const [key, value] of Object.entries(userConfig)) {
            if (key in defaultConfig) {
                if (typeof defaultConfig[key] === 'object' &&
                    defaultConfig[key] !== null &&
                    !Array.isArray(defaultConfig[key])) {
                    merged[key] = { ...defaultConfig[key],
                        ...(value || {})
                    };
                } else {
                    merged[key] = value;
                }
            }
        }

        return merged;
    }

    static async readJsonFile(filePath, defaultValue = null) {
        try {
            const data = await fs.readFile(filePath, 'utf-8');
            return JSON.parse(data);
        } catch {
            return defaultValue;
        }
    }

    static async writeJsonFile(filePath, data) {
        const tempPath = `${filePath}.tmp`;
        try {
            await this.ensureDirectory(path.dirname(filePath));
            await fs.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf-8');
            await fs.rename(tempPath, filePath);
            return {
                success: true
            };
        } catch (error) {
            try {
                await fs.unlink(tempPath);
            } catch {}
            return {
                success: false,
                error: error.message
            };
        }
    }

    static _getLocalISODate(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    static getCurrentDateKey() {
        return this._getLocalISODate(new Date());
    }

    static isDateInCurrentMonth(dateString) {
        const [year, month, day] = dateString.split('-').map(Number);
        const date = new Date(year, month - 1, day);
        const now = new Date();
        return date.getMonth() === now.getMonth() &&
            date.getFullYear() === now.getFullYear();
    }

    static getDaysAgo(days) {
        const date = new Date();
        date.setDate(date.getDate() - days);
        return this._getLocalISODate(date);
    }

    static async manageWindowsStartup(enable, execPath) {
        const taskName = CONSTANTS.TASK_NAME;
        const appName = 'PeebifyLauncher';

        try {
            if (enable) {

                const escapedPath = execPath.replace(/\\/g, '\\\\');
                const regCommand = `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "${appName}" /t REG_SZ /d "\\"${escapedPath}\\" --from-boot" /f`;
                await this.execAsync(regCommand);

                const command = `schtasks /create /tn "${taskName}" /tr "\\"${execPath}\\" --from-boot" /sc onlogon /rl highest /f`;
                await this.execAsync(command);
            } else {

                const regCommand = `reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "${appName}" /f`;
                try {
                    await this.execAsync(regCommand);
                } catch (error) {
                    if (!error.message.includes('unable to find')) {
                        throw error;
                    }
                }

                const command = `schtasks /delete /tn "${taskName}" /f`;
                try {
                    await this.execAsync(command);
                } catch (error) {
                    if (!error.message.includes('cannot find')) {
                        throw error;
                    }
                }
            }
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    static async fetchNewsData() {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), CONSTANTS.HTTP_TIMEOUT);

            const data = await this.httpRequest(CONSTANTS.NEWS_URL, controller.signal);
            clearTimeout(timeoutId);

            const newsData = JSON.parse(data);

            return this.createStandardResponse(true, { data: newsData });
        } catch (error) {
            console.error('Failed to fetch news data:', error);
            return this.createStandardResponse(false, null, error.message);
        }
    }
}

class GameUtils extends CoreUtils {
    static async getLocalGameVersion(gamePath) {
        if (!gamePath) return null;

        const configPath = path.join(gamePath, CONSTANTS.GAME_CONFIG_FILE);
        const config = await this.readJsonFile(configPath);
        return config?.version || null;
    }

    static async validateGamePath(gamePath) {
        if (!gamePath) return {
            isValid: false,
            error: 'No path provided.'
        };

        const executablePath = path.join(gamePath, CONSTANTS.GAME_EXECUTABLE);
        const exists = await this.fileExists(executablePath);

        if (!exists) {
            return {
                isValid: false,
                error: `"${CONSTANTS.GAME_EXECUTABLE}" not found in this directory.`
            };
        }

        return {
            isValid: true
        };
    }

    static getScreenshotPath(gamePath) {
        return path.join(gamePath, ...CONSTANTS.SCREENSHOT_PATH);
    }

    static async updateGameConfig(installPath, version) {
        const configPath = path.join(installPath, CONSTANTS.GAME_CONFIG_FILE);
        const config = { ...DEFAULT_CONFIGS.GAME_DOWNLOAD,
            version
        };
        return await CoreUtils.writeJsonFile(configPath, config);
    }
}

class ProgressTracker {
    constructor() {
        this.reset();
    }

    reset() {
        this.totalBytes = 0;
        this.downloadedBytes = 0;
        this.lastUpdate = {
            time: 0,
            bytes: 0
        };
        this.currentSpeed = 0;
    }

    updateProgress(bytesDownloaded) {
        this.downloadedBytes += bytesDownloaded;
    }

    calculateMetrics() {
        const now = Date.now();
        const timeDiff = (now - this.lastUpdate.time) / 1000;
        const byteDiff = this.downloadedBytes - this.lastUpdate.bytes;

        if (timeDiff > 0) {
            this.currentSpeed = CoreUtils.calculateSpeed(byteDiff, timeDiff);
        }

        const percentage = CoreUtils.calculateProgress(this.downloadedBytes, this.totalBytes);
        const remainingBytes = this.totalBytes - this.downloadedBytes;
        const eta = CoreUtils.calculateETA(remainingBytes, this.currentSpeed);

        this.lastUpdate = {
            time: now,
            bytes: this.downloadedBytes
        };

        return {
            percentage,
            speed: this.currentSpeed,
            eta,
            etaFormatted: CoreUtils.formatDuration(eta)
        };
    }

    shouldUpdate(interval = CONSTANTS.PROGRESS_UPDATE_INTERVAL) {
        return CoreUtils.shouldUpdateProgress(this.lastUpdate.time, interval);
    }
}

module.exports = {
    CONSTANTS,
    STATUS,
    VERSION_TYPES,
    DURATION_FORMATS,
    DEFAULT_CONFIGS,
    EXTERNAL_LINKS,
    CoreUtils,
    GameUtils,
    ProgressTracker
};