const { promises: fs } = require('fs');
const path = require('path');
const { app, ipcMain, dialog, shell } = require('electron');

const {
    CONSTANTS,
    DEFAULT_CONFIGS,
    CoreUtils,
    GameUtils
} = require('./core');
const { logger } = require('./logger');
const { LOGS_DIR } = require('./logger');

class LauncherConfig {
    constructor() {
        this.configPath = CoreUtils.getAppDataPath(CONSTANTS.CONFIG_FILE);
        this.config = {};
        this.isLoaded = false;
        this.loadPromise = null;
        this.saveInProgress = false;
        this.pendingSave = false;
    }

    async load() {
        if (this.loadPromise) {
            return this.loadPromise;
        }

        this.loadPromise = this._loadConfig();
        return this.loadPromise;
    }

    async _loadConfig() {
        try {
            logger.info(`Loading config from: ${this.configPath}`);

            const configDir = path.dirname(this.configPath);
            try {
                await fs.mkdir(configDir, {
                    recursive: true
                });
            } catch (error) {
                if (error.code !== 'EEXIST') {
                    logger.error('Failed to create config directory:', error);
                }
            }

            let existingConfig = {};
            try {
                const data = await fs.readFile(this.configPath, 'utf-8');
                existingConfig = JSON.parse(data);
                logger.info('Existing configuration loaded');
            } catch (error) {
                if (error.code !== 'ENOENT') {
                    logger.warn('Failed to read existing config, using defaults:', error.message);
                }
            }

            this.config = this._mergeWithDefaults(existingConfig);

            this.isLoaded = true;
            logger.info('Configuration loaded successfully');

            try {
                await this._saveConfigDirect();
                logger.info('Configuration merged and saved');
            } catch (saveError) {
                logger.warn('Could not save merged config immediately:', saveError.message);
            }

        } catch (error) {
            logger.error('Failed to load configuration:', error);

            this.config = { ...DEFAULT_CONFIGS.LAUNCHER };
            this.isLoaded = true;
            logger.info('Using default configuration as fallback');
        }
    }

    _mergeWithDefaults(userConfig) {
        const merged = JSON.parse(JSON.stringify(DEFAULT_CONFIGS.LAUNCHER));

        function deepMerge(target, source) {
            for (const key in source) {
                if (source.hasOwnProperty(key)) {
                    if (target[key] && typeof target[key] === 'object' &&
                        typeof source[key] === 'object' &&
                        !Array.isArray(target[key]) && !Array.isArray(source[key])) {
                        deepMerge(target[key], source[key]);
                    } else {
                        target[key] = source[key];
                    }
                }
            }
        }

        deepMerge(merged, userConfig);
        return merged;
    }

    async waitForLoad() {
        if (!this.isLoaded) {
            await this.load();
        }
    }

    get(key, defaultValue = null) {
        if (!this.isLoaded) {
            logger.warn(`Config access attempted before loading: ${key}`);
            return defaultValue;
        }

        if (!key) return this.config;

        const keys = key.split('.');
        let value = this.config;

        for (const k of keys) {
            if (value && typeof value === 'object' && k in value) {
                value = value[k];
            } else {
                return defaultValue;
            }
        }

        return value;
    }

    set(key, value) {
        if (!this.isLoaded) {
            logger.warn(`Config modification attempted before loading: ${key}`);
            return false;
        }

        if (!key) return false;

        const keys = key.split('.');
        let current = this.config;

        for (let i = 0; i < keys.length - 1; i++) {
            const k = keys[i];
            if (!(k in current) || typeof current[k] !== 'object') {
                current[k] = {};
            }
            current = current[k];
        }

        current[keys[keys.length - 1]] = value;

        this._debouncedSave();

        return true;
    }

    _debouncedSave() {
        if (this.saveInProgress) {
            this.pendingSave = true;
            return;
        }

        clearTimeout(this.saveTimeout);
        this.saveTimeout = setTimeout(async () => {
            await this.save();
        }, 100);
    }

    async save() {
        if (this.saveInProgress) {
            this.pendingSave = true;
            return;
        }

        this.saveInProgress = true;

        try {
            await this._saveConfigDirect();
            logger.debug('Configuration saved successfully');

            if (this.pendingSave) {
                this.pendingSave = false;
                setTimeout(() => this.save(), 50);
            }
        } catch (error) {
            logger.error('Failed to save configuration:', error);
            throw error;
        } finally {
            this.saveInProgress = false;
        }
    }

    async _saveConfigDirect() {
        const tempPath = `${this.configPath}.tmp`;

        try {
            const configData = JSON.stringify(this.config, null, 2);
            await fs.writeFile(tempPath, configData, 'utf-8');

            await fs.rename(tempPath, this.configPath);

        } catch (error) {
            try {
                await fs.unlink(tempPath);
            } catch {}

            throw new Error(`Failed to save config: ${error.message}`);
        }
    }

    async wipe() {
        try {
            logger.info('Wiping launcher configuration data...');

            try {
                await fs.unlink(this.configPath);
                logger.info('Configuration file deleted successfully');
            } catch (error) {
                if (error.code !== 'ENOENT') {
                    logger.warn('Failed to delete config file:', error.message);
                }
            }

            try {
                await fs.unlink(`${this.configPath}.tmp`);
            } catch (error) {}

            this.config = JSON.parse(JSON.stringify(DEFAULT_CONFIGS.LAUNCHER));
            this.isLoaded = true;

            try {
                const configDir = path.dirname(this.configPath);
                const files = await fs.readdir(configDir);

                const relevantFiles = files.filter(file =>
                    !file.startsWith('.') &&
                    !file.includes('config') &&
                    !file.includes('log')
                );

                if (relevantFiles.length === 0) {
                    await fs.rmdir(configDir);
                    logger.info('Empty app data directory removed');
                }
            } catch (error) {
                logger.debug('Could not remove app data directory:', error.message);
            }

            logger.info('Configuration data wiped successfully');
            return {
                success: true
            };

        } catch (error) {
            logger.error('Failed to wipe configuration data:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    getAll() {
        return JSON.parse(JSON.stringify(this.config));
    }

    cleanup() {
        clearTimeout(this.saveTimeout);
        if (this.pendingSave && !this.saveInProgress) {
            this.save().catch(error => {
                logger.error('Failed final config save during cleanup:', error);
            });
        }
    }
}

async function validateGamePath(gamePath) {
    const validation = await GameUtils.validateGamePath(gamePath);
    return validation;
}

async function manageStartupMethods(enable, execPath, appName = 'PeebifyLauncher') {
    return await CoreUtils.manageWindowsStartup(enable, execPath, appName);
}

function setupConfigIPC(launcherConfig) {
    ipcMain.handle('get-config', () => {
        try {
            return CoreUtils.createStandardResponse(true, launcherConfig.getAll());
        } catch (error) {
            logger.error('Failed to get config:', error);
            return CoreUtils.createStandardResponse(false, null, error.message);
        }
    });

    ipcMain.handle('set-config', async (event, key, value) => {
        try {
            const success = launcherConfig.set(key, value);
            if (success) {
                logger.debug(`Config updated: ${key} = ${JSON.stringify(value)}`);
                return CoreUtils.createStandardResponse(true);
            } else {
                throw new Error('Failed to set config value');
            }
        } catch (error) {
            logger.error(`Failed to set config ${key}:`, error);
            return CoreUtils.createStandardResponse(false, null, error.message);
        }
    });

    ipcMain.handle('get-app-version', () => {
        let version = app.getVersion();
        if (CONSTANTS.BUILD_TYPE === 'beta') {
            version = `${version}-beta`;
        } else if (CONSTANTS.BUILD_TYPE === 'stable') {
            version = `${version}-stable`;
        }
        return CoreUtils.createStandardResponse(true, {
            version: version
        });
    });

    ipcMain.handle('get-launcher-settings', () =>
        launcherConfig.getAll()
    );

    ipcMain.handle('browse-game-path', async () => {
        const {
            filePaths
        } = await dialog.showOpenDialog({
            title: 'Select Wuthering Waves Installation Folder',
            properties: ['openDirectory']
        });

        if (!filePaths?.length) {
            return CoreUtils.createStandardResponse(false, {
                cancelled: true
            });
        }

        const selectedPath = filePaths[0];
        const validation = await validateGamePath(selectedPath);

        if (validation.isValid) {
            launcherConfig.set('gamePath', selectedPath);
            return CoreUtils.createStandardResponse(true, {
                path: selectedPath
            });
        } else {
            return CoreUtils.createStandardResponse(false, null, validation.error);
        }
    });

    ipcMain.handle('save-behavior-settings', async (event, newBehavior) => {
        try {
            const currentBehavior = launcherConfig.get('behavior');

            if ('startOnBoot' in newBehavior &&
                newBehavior.startOnBoot !== currentBehavior.startOnBoot) {

                const startupResult = await manageStartupMethods(
                    newBehavior.startOnBoot,
                    process.execPath
                );

                if (startupResult.success) {
                    logger.info(`Start on boot ${newBehavior.startOnBoot ? 'enabled' : 'disabled'} via dual method`);
                } else {
                    logger.error('Failed to manage startup methods, falling back to standard method:', startupResult.error);

                    app.setLoginItemSettings({
                        openAtLogin: newBehavior.startOnBoot,
                        path: process.execPath,
                        args: newBehavior.startOnBoot ? ['--from-boot'] : []
                    });
                }
            }

            const updatedBehavior = { ...currentBehavior,
                ...newBehavior
            };
            launcherConfig.set('behavior', updatedBehavior);
            return CoreUtils.createStandardResponse(true);

        } catch (error) {
            logger.error('Failed to save behavior settings:', error);
            return CoreUtils.createStandardResponse(false, null, error.message);
        }
    });

    ipcMain.handle('select-wallpaper-file', async () => {
        const {
            filePaths
        } = await dialog.showOpenDialog({
            title: 'Select Custom Wallpaper',
            properties: ['openFile'],
            filters: [{
                name: 'Wallpapers',
                extensions: ['png', 'jpg', 'jpeg', 'mp4']
            }]
        });

        if (!filePaths?.length) {
            return CoreUtils.createStandardResponse(false, {
                cancelled: true
            });
        }

        return CoreUtils.createStandardResponse(true, {
            path: filePaths[0]
        });
    });

    ipcMain.handle('save-wallpaper', (event, wallpaperConfig) => {
        try {
            launcherConfig.set('wallpaper', wallpaperConfig);
            return CoreUtils.createStandardResponse(true);
        } catch (error) {
            logger.error('Failed to save wallpaper setting:', error);
            return CoreUtils.createStandardResponse(false, null, error.message);
        }
    });

    ipcMain.handle('open-logs-folder', async () => {
        try {
            await CoreUtils.ensureDirectory(LOGS_DIR);
            await shell.openPath(LOGS_DIR);
            return CoreUtils.createStandardResponse(true, {
                path: LOGS_DIR
            });
        } catch (error) {
            logger.error('Failed to open logs folder:', error);
            return CoreUtils.createStandardResponse(false, null, error.message);
        }
    });

    ipcMain.handle('wipe-launcher-data', async () => {
        try {
            try {
                const cleanupResult = await manageStartupMethods(false, process.execPath);
                if (cleanupResult.success) {
                    logger.info('Cleaned up startup methods during data wipe');
                } else {
                    logger.warn('Could not clean up startup methods during wipe:', cleanupResult.error);
                }
            } catch (startupError) {
                logger.warn('Could not clean up startup methods during wipe:', startupError);
            }

            const wipeResult = await launcherConfig.wipe();
            if (!wipeResult.success) {
                throw new Error(wipeResult.error);
            }

            app.relaunch();
            app.quit();
            return CoreUtils.createStandardResponse(true);

        } catch (error) {
            logger.error('Failed to wipe launcher data:', error);
            return CoreUtils.createStandardResponse(false, null, error.message);
        }
    });

    ipcMain.handle('restart-app', () => {
        logger.info('Restarting app on user request...');
        app.relaunch();
        app.quit();
        return CoreUtils.createStandardResponse(true);
    });
}

async function createLauncherConfig() {
    const config = new LauncherConfig();
    await config.load();
    return config;
}

module.exports = {
    LauncherConfig,
    createLauncherConfig,
    setupConfigIPC
};