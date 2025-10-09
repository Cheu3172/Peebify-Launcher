const { promises: fs } = require('fs');
const path = require('path');
const { shell, dialog } = require('electron');

const {
    CONSTANTS,
    CoreUtils,
    GameUtils
} = require('./core');
const { logger } = require('./logger');
const { apiConfig } = require('./api-config');

class PlaytimeTracker {
    constructor(launcherConfig) {
        this.launcherConfig = launcherConfig;
        this.sessionStartTime = null;
    }

    startTracking() {
        this.sessionStartTime = Date.now();
        logger.info(`Playtime tracking started at ${new Date(this.sessionStartTime).toLocaleString()}`);
    }

    async stopTracking() {
        if (!this.sessionStartTime) return;

        const sessionDuration = Date.now() - this.sessionStartTime;
        logger.info(`Playtime session ended. Duration: ${Math.round(sessionDuration / 1000)}s`);

        await this.saveSessionData(sessionDuration);
        this.sessionStartTime = null;
    }

    async saveSessionData(sessionDuration) {
        const config = this.launcherConfig.getAll();
        const today = CoreUtils.getCurrentDateKey();
        const dailyPlaytime = config.dailyPlaytime || {};

        const newTotal = (config.totalPlaytime || 0) + sessionDuration;
        dailyPlaytime[today] = (dailyPlaytime[today] || 0) + sessionDuration;
        const newSessionCount = (config.sessionCount || 0) + 1;

        const mostRecentSession = {
            startTime: this.sessionStartTime,
            duration: sessionDuration,
        };

        this.launcherConfig.config.totalPlaytime = newTotal;
        this.launcherConfig.config.dailyPlaytime = dailyPlaytime;
        this.launcherConfig.config.mostRecentSession = mostRecentSession;
        this.launcherConfig.config.sessionCount = newSessionCount;

        try {
            await this.launcherConfig.save();
            logger.info(`Saved session. New total playtime: ${Math.round(newTotal / 1000 / 60)} minutes.`);
        } catch (error) {
            logger.error('Failed to save playtime data:', error);
        }
    }

    getStatistics() {
        const config = this.launcherConfig.getAll();
        const dailyPlaytime = config.dailyPlaytime || {};

        const {
            weekPlaytime,
            monthPlaytime
        } = this.calculateTimePeriods(dailyPlaytime);

        const totalPlaytime = config.totalPlaytime || 0;
        const sessionCount = config.sessionCount || 0;
        const averageSession = sessionCount > 0 ? totalPlaytime / sessionCount : 0;
        const todayKey = CoreUtils.getCurrentDateKey();

        return {
            today: dailyPlaytime[todayKey] || 0,
            week: weekPlaytime,
            month: monthPlaytime,
            total: totalPlaytime,
            averageSession: averageSession,
            mostRecentSession: config.mostRecentSession || null,
        };
    }

    calculateTimePeriods(dailyPlaytime) {
        let weekPlaytime = 0;
        let monthPlaytime = 0;
        const now = new Date();

        for (let i = 0; i < 31; i++) {
            const dateKey = CoreUtils.getDaysAgo(i);
            const playtime = dailyPlaytime[dateKey] || 0;

            if (i < 7) {
                weekPlaytime += playtime;
            }

            if (CoreUtils.isDateInCurrentMonth(dateKey)) {
                monthPlaytime += playtime;
            }
        }

        return {
            weekPlaytime,
            monthPlaytime
        };
    }
}

class GameManager {
    constructor(win, launcherConfig, appEvents) {
        this.mainWindow = win;
        this.launcherConfig = launcherConfig;
        this.appEvents = appEvents;

        this.isGameRunning = false;
        this.gameStartTime = null;
        this.monitorInterval = null;

        this.processCheckFailures = 0;
        this.maxProcessCheckFailures = 5;

        this.lastUpdateCheck = null;
        this.updateCheckCache = null;
        this.updateCacheTimeout = 5 * 60 * 1000;

        this.playtimeTracker = new PlaytimeTracker(launcherConfig);
        this.setupPlaytimeListeners();
    }

    setupPlaytimeListeners() {
        this.appEvents.on('game-started', () => this.playtimeTracker.startTracking());
        this.appEvents.on('game-stopped', async () => {
            try {
                await this.playtimeTracker.stopTracking();
            } catch (error) {
                logger.error('Error stopping playtime tracking:', error);
            }
        });
    }

    getPlaytimeStatistics() {
        try {
            const statistics = this.playtimeTracker.getStatistics();
            return CoreUtils.createStandardResponse(true, {
                statistics
            });
        } catch (error) {
            logger.error('Failed to get playtime statistics:', error);
            return CoreUtils.createStandardResponse(false, null, error.message);
        }
    }

    async launchGame() {
        try {
            if (this.isGameRunning) {
                logger.warn('Game launch attempted while game is already running');
                return CoreUtils.createStandardResponse(false, null, 'Game is already running.');
            }

            const gamePath = this.launcherConfig.get('gamePath');
            if (!gamePath) {
                return CoreUtils.createStandardResponse(false, null, 'Game path is not configured.');
            }

            const executablePath = path.join(gamePath, CONSTANTS.GAME_EXECUTABLE);

            if (!(await CoreUtils.fileExists(executablePath))) {
                logger.error(`Game executable not found at ${executablePath}`);
                return CoreUtils.createStandardResponse(false, null, 'Game executable not found. Please verify game files.');
            }

            if (process.platform === 'win32') {
                const needsAdmin = await this.checkAdminRequirement(executablePath);
                if (needsAdmin && !await this.hasAdminPrivileges()) {
                    logger.warn('Game requires admin privileges but launcher is not elevated');
                }
            }

            logger.info(`Launching game from: ${executablePath}`);
            await shell.openPath(executablePath);

            setTimeout(() => {
                this.startProcessMonitoring();
            }, 2000);

            return CoreUtils.createStandardResponse(true);

        } catch (error) {
            logger.error('Failed to launch game:', error);
            return CoreUtils.createStandardResponse(false, null, `Failed to launch: ${error.message}`);
        }
    }

    async checkAdminRequirement(executablePath) {
        try {
            const stats = await fs.stat(executablePath);
            return false;
        } catch {
            return false;
        }
    }

    async hasAdminPrivileges() {
        try {
            const isElevated = require('is-elevated');
            return await isElevated();
        } catch {
            return false;
        }
    }

    _isVersionNewer(v1, v2) {
        if (!v1 || !v2) return false;
        try {
            const parts1 = v1.split('.').map(Number);
            const parts2 = v2.split('.').map(Number);
            const len = Math.max(parts1.length, parts2.length);

            for (let i = 0; i < len; i++) {
                const p1 = parts1[i] || 0;
                const p2 = parts2[i] || 0;
                if (p1 > p2) return true;
                if (p1 < p2) return false;
            }
        } catch (error) {
            logger.error(`Failed to parse versions for comparison: v1=${v1}, v2=${v2}`, error);
            return false;
        }
        return false;
    }

    async checkForUpdates(forceCheck = false) {
        try {
            if (!(await CoreUtils.isOnline())) {
                logger.info('No internet connection, skipping game update check.');
                return CoreUtils.createStandardResponse(false, null, 'No internet connection.');
            }

            if (!forceCheck && this.isUpdateCacheValid()) {
                logger.info('Using cached update check result');
                return CoreUtils.createStandardResponse(true, this.updateCheckCache);
            }

            const gamePath = this.launcherConfig.get('gamePath');
            const localVersion = await GameUtils.getLocalGameVersion(gamePath);

            logger.info(`Checking for updates. Local version: ${localVersion || 'not installed'}`);

            const gameConfig = await this.fetchGameConfig();
            const remoteVersion = gameConfig.default?.version;

            if (!remoteVersion) {
                throw new Error('No default game configuration found in remote.');
            }

            const updateAvailable = localVersion ?
                this._isVersionNewer(remoteVersion, localVersion) : true;

            const result = {
                updateAvailable,
                currentVersion: localVersion,
                latestVersion: remoteVersion,
                downloadSize: this.calculateDownloadSize(gameConfig, updateAvailable)
            };

            this.updateCheckCache = result;
            this.lastUpdateCheck = Date.now();

            logger.info(`Update check complete. Update available: ${updateAvailable}`);
            return CoreUtils.createStandardResponse(true, result);

        } catch (error) {
            logger.error('Game update check failed:', error);
            return CoreUtils.createStandardResponse(false, null, error.message);
        }
    }

    async fetchGameConfig() {
        if (!apiConfig || !apiConfig.config) {
            throw new Error('API config is required to fetch game configuration');
        }

        const gameConfigUrl = apiConfig.getGameConfigUrl();
        logger.debug(`Fetching game config from: ${gameConfigUrl}`);
        const response = await CoreUtils.httpRequest(gameConfigUrl);
        return JSON.parse(response);
    }

    calculateDownloadSize(gameConfig, isFullDownload) {
        if (isFullDownload) {
            return gameConfig.default?.config?.fullSize || 'Unknown';
        }
        return gameConfig.default?.config?.updateSize || 'Unknown';
    }

    isUpdateCacheValid() {
        if (!this.updateCheckCache || !this.lastUpdateCheck) {
            return false;
        }

        const cacheAge = Date.now() - this.lastUpdateCheck;
        return cacheAge < this.updateCacheTimeout;
    }

    clearUpdateCache() {
        this.updateCheckCache = null;
        this.lastUpdateCheck = null;
    }

    startProcessMonitoring() {
        this.stopProcessMonitoring();

        logger.info('Starting game process monitoring');
        this.processCheckFailures = 0;

        this.checkGameProcess();

        this.monitorInterval = setInterval(
            () => this.checkGameProcess(),
            CONSTANTS.PROCESS_MONITOR_INTERVAL
        );
    }

    stopProcessMonitoring() {
        if (this.monitorInterval) {
            clearInterval(this.monitorInterval);
            this.monitorInterval = null;
            logger.info('Stopped game process monitoring');
        }
    }

    async checkGameProcess() {
        try {
            const wasRunning = this.isGameRunning;
            this.isGameRunning = await CoreUtils.isProcessRunning(CONSTANTS.GAME_CLIENT_PROCESS);

            this.processCheckFailures = 0;

            if (wasRunning !== this.isGameRunning) {
                this.handleGameStateChange(this.isGameRunning);
            }
        } catch (error) {
            logger.error('Failed to check game process:', error);
            this.processCheckFailures++;

            if (this.processCheckFailures >= this.maxProcessCheckFailures) {
                logger.error(`Process monitoring failed ${this.processCheckFailures} times, stopping monitor`);
                this.stopProcessMonitoring();

                if (this.isGameRunning) {
                    this.isGameRunning = false;
                    this.handleGameStateChange(false);
                }
            }
        }
    }

    handleGameStateChange(isRunning) {
        if (isRunning) {
            this.gameStartTime = Date.now();
            logger.info('Game process started');

            this.appEvents.emit('game-started');

            const launchAction = this.launcherConfig.get('behavior.launchAction', 'minimize');
            if (this.mainWindow && typeof this.mainWindow.performLaunchAction === 'function') {
                this.mainWindow.performLaunchAction(launchAction);
            }

            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                this.mainWindow.webContents.send('game-started');
            }
        } else {
            const sessionDuration = this.gameStartTime ?
                Date.now() - this.gameStartTime : 0;

            logger.info(`Game process stopped. Session duration: ${Math.round(sessionDuration / 1000)}s`);

            this.appEvents.emit('game-stopped');

            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                this.mainWindow.webContents.send('game-stopped');
            }

            this.stopProcessMonitoring();

            if (this.launcherConfig.get('isFirstRunPending')) {
                this.handleFirstRunCompletion();
            }

            this.clearUpdateCache();

            this.gameStartTime = null;
        }
    }

    async handleFirstRunCompletion() {
        logger.info('First run completed. Clearing flag and re-checking for updates.');
        this.launcherConfig.set('isFirstRunPending', false);

        const result = await this.checkForUpdates(true);

        if (result.success && result.updateAvailable) {
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                this.mainWindow.webContents.send('update-available', result);
            }
        }
    }

    async getGameInfo() {
        const gamePath = this.launcherConfig.get('gamePath');

        if (!gamePath) {
            return CoreUtils.createStandardResponse(true, {
                installed: false,
                path: null,
                version: null,
                isRunning: false
            });
        }

        const version = await GameUtils.getLocalGameVersion(gamePath);

        return CoreUtils.createStandardResponse(true, {
            installed: true,
            path: gamePath,
            version: version,
            isRunning: this.isGameRunning,
            lastPlayed: this.gameStartTime
        });
    }

    async moveGameLocation() {
        const oldPath = this.launcherConfig.get('gamePath');
        if (!oldPath) {
            return CoreUtils.createStandardResponse(false, null, 'Current game path is not set.');
        }

        const { canceled, filePaths } = await dialog.showOpenDialog(this.mainWindow, {
            title: 'Select New Game Location',
            properties: ['openDirectory', 'createDirectory'],
        });

        if (canceled || !filePaths?.length) {
            return CoreUtils.createStandardResponse(false, { cancelled: true }, 'No new location selected.');
        }
        const newPath = filePaths[0];

        if (CoreUtils.normalizePath(newPath) === CoreUtils.normalizePath(oldPath)) {
            return CoreUtils.createStandardResponse(false, null, 'The new location cannot be the same as the current one.');
        }

        try {
            const filesToMove = [];
            const walk = async (dir, root) => {
                const entries = await fs.readdir(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        await walk(fullPath, root);
                    } else {
                        filesToMove.push(path.relative(root, fullPath));
                    }
                }
            };
            await walk(oldPath, oldPath);

            const totalFiles = filesToMove.length;
            let movedFiles = 0;

            for (const relativeFile of filesToMove) {
                const sourceFile = path.join(oldPath, relativeFile);
                const destFile = path.join(newPath, relativeFile);

                await CoreUtils.ensureDirectory(path.dirname(destFile));
                await fs.copyFile(sourceFile, destFile);

                movedFiles++;
                const percentage = (movedFiles / totalFiles) * 100;
                if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                    this.mainWindow.webContents.send('move-progress', {
                        percentage,
                        file: path.basename(relativeFile),
                    });
                }
            }

            await fs.rm(oldPath, { recursive: true, force: true });
            this.launcherConfig.set('gamePath', newPath);

            logger.info(`Game moved successfully to ${newPath}`);
            return CoreUtils.createStandardResponse(true, { newPath });

        } catch (error) {
            logger.error('Failed to move game location:', error);
            await fs.rm(newPath, { recursive: true, force: true }).catch(() => {});
            return CoreUtils.createStandardResponse(false, null, `Move failed: ${error.message}`);
        }
    }

    async uninstallGame() {
        const gamePath = this.launcherConfig.get('gamePath');
        if (!gamePath || !(await CoreUtils.fileExists(gamePath))) {
            logger.warn('Uninstall requested for a non-existent game path.');
            this.launcherConfig.set('gamePath', '');
            return CoreUtils.createStandardResponse(true);
        }

        try {
            const filesToDelete = [];
            const walk = async (dir) => {
                const entries = await fs.readdir(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        await walk(fullPath);
                    } else {
                        filesToDelete.push(fullPath);
                    }
                }
            };
            await walk(gamePath);
            const totalFiles = filesToDelete.length;
            let deletedFiles = 0;

            for (const file of filesToDelete) {
                await fs.unlink(file);
                deletedFiles++;
                const percentage = totalFiles > 0 ? (deletedFiles / totalFiles) * 100 : 100;
                if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                    this.mainWindow.webContents.send('uninstall-progress', {
                        percentage,
                        file: path.basename(file),
                        currentFile: deletedFiles,
                        totalFiles
                    });
                }
            }

            await fs.rm(gamePath, { recursive: true, force: true });
            this.launcherConfig.set('gamePath', '');
            logger.info('Game uninstalled successfully.');
            return CoreUtils.createStandardResponse(true);
        } catch (error) {
            logger.error('Failed to uninstall game:', error);
            return CoreUtils.createStandardResponse(false, null, `Uninstall failed: ${error.message}`);
        }
    }

    async forceCloseGame() {
        if (!this.isGameRunning) {
            logger.warn('Attempted to force close game when it was not running.');
            return CoreUtils.createStandardResponse(true, {
                message: 'Game was not running.'
            });
        }

        logger.info(`Attempting to force close game process: ${CONSTANTS.GAME_CLIENT_PROCESS}`);
        try {
            const result = await CoreUtils.terminateProcess(CONSTANTS.GAME_CLIENT_PROCESS);

            if (result.success) {
                logger.info('Successfully terminated game process. Manually checking game state.');
                await this.checkGameProcess();
                return CoreUtils.createStandardResponse(true);
            } else {
                logger.error('Failed to terminate game process:', result.error);
                return CoreUtils.createStandardResponse(false, null, result.error);
            }
        } catch (error) {
            logger.error('An exception occurred during forceCloseGame:', error);
            return CoreUtils.createStandardResponse(false, null, error.message);
        }
    }

    cleanup() {
        this.stopProcessMonitoring();
        this.clearUpdateCache();
    }
}

function setupGameManagerIPC(ipcMain, gameManager) {
    const handlers = {
        'launch-game': () => gameManager.launchGame(),
        'force-close-game': () => gameManager.forceCloseGame(),
        'move-game-location': () => gameManager.moveGameLocation(),
        'uninstall-game': () => gameManager.uninstallGame(),

        'get-game-state': () => CoreUtils.createStandardResponse(true, {
            isRunning: gameManager.isGameRunning
        }),

        'get-game-info': () => gameManager.getGameInfo(),

        'check-for-updates': async () => {
            const result = await gameManager.checkForUpdates();

            if (result.success && result.updateAvailable) {
                if (gameManager.mainWindow && !gameManager.mainWindow.isDestroyed()) {
                    gameManager.mainWindow.webContents.send('update-available', result);
                }
            }

            return result;
        },

        'force-update-check': () => gameManager.checkForUpdates(true),

        'get-playtime-statistics': () => gameManager.getPlaytimeStatistics()
    };

    Object.entries(handlers).forEach(([event, handler]) => {
        ipcMain.handle(event, handler);
    });
}

module.exports = {
    GameManager,
    setupGameManagerIPC
};