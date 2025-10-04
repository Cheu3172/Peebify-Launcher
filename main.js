const { initializeLogger, logger } = require('./backend/logger');
initializeLogger();

const { app, BrowserWindow, ipcMain, protocol } = require('electron');
const fs = require('fs');
const { EventEmitter } = require('events');
const path = require('path');
const { exec } = require('child_process');

try {
    const { CoreUtils, CONSTANTS } = require('./backend/core');
    const configPath = CoreUtils.getAppDataPath(CONSTANTS.CONFIG_FILE);
    if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (config?.behavior?.disableHardwareAcceleration) {
            app.disableHardwareAcceleration();
            logger.info('Hardware acceleration disabled by user setting.');
        }
    }
} catch (e) {
    logger.error('Could not read config for hardware acceleration pre-boot:', e);
}

const { createLauncherConfig, setupConfigIPC } = require('./backend/config-manager');
const { setupWindowManager } = require('./backend/window-manager');
const { GameManager, setupGameManagerIPC } = require('./backend/game-manager');
const { assetCache } = require('./backend/asset-cache');

let mainWindow;
let launcherConfig;
let windowManager;
let gameManager;
const appEvents = new EventEmitter();
let modulesInitialized = false;
let initialDataPromise = null;

process.on('uncaughtException', (error) => {
    logger.crash(`UNCAUGHT EXCEPTION: ${error.stack || error}`);
    app.quit();
});
process.on('unhandledRejection', (reason) => {
    logger.crash(`UNHANDLED REJECTION: ${reason}`);
});

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (!mainWindow.isVisible()) {
                mainWindow.show();
            }
            if (mainWindow.isMinimized()) {
                mainWindow.restore();
            }
            mainWindow.focus();
        }
    });
}

async function fetchInitialData() {
    try {
        const { CoreUtils } = require('./backend/core');
        const WALLPAPER_API_URL = 'https://prod-alicdn-gamestarter.kurogame.com/launcher/50004_obOHXFrFanqsaIEOmuKroCcbZkQRBC7c/G153/background/U82Wn9dbNc2o7zZBWz1cOnJm9r52qFKH/en.json';

        await assetCache.initialize();

        // Try to get cached assets for instant startup
        const cachedAssets = await assetCache.getInitialAssets(WALLPAPER_API_URL);
        if (cachedAssets) {
            logger.info('Using cached assets for instant startup');

            return {
                backgroundVideo: cachedAssets.backgroundFile,
                backgroundImage: null,
                updateImage: cachedAssets.slogan,
                functionSwitch: null,
                backgroundFileType: null,
                fromCache: true
            };
        }

        // First launch - fetch everything
        const timestamp = Date.now();
        const urlWithTimestamp = `${WALLPAPER_API_URL}?_t=${timestamp}`;

        logger.info('Fetching initial remote assets (first launch)...');
        const response = await CoreUtils.httpRequest(urlWithTimestamp);
        const wallpaperData = JSON.parse(response);

        const cachedData = await assetCache.updateAssets({
            backgroundFile: wallpaperData.backgroundFile,
            slogan: wallpaperData.slogan
        });

        // Cache social icons on first launch
        await assetCache.cacheSocialIcons();

        logger.info('Successfully fetched and cached initial remote assets.');
        return {
            backgroundVideo: cachedData?.backgroundFile || wallpaperData.backgroundFile,
            backgroundImage: wallpaperData.firstFrameImage,
            updateImage: cachedData?.slogan || wallpaperData.slogan,
            functionSwitch: wallpaperData.functionSwitch,
            backgroundFileType: wallpaperData.backgroundFileType
        };
    } catch (error) {
        logger.error('Failed to fetch initial remote assets:', error);
        return null;
    }
}

async function main() {
    try {
        const { CoreUtils, CONSTANTS } = require('./backend/core');
        if (process.platform === 'win32') {
            app.setAppUserModelId(CONSTANTS.APP_USER_MODEL_ID);
        }

        logger.info('Loading launcher configuration...');
        launcherConfig = await createLauncherConfig();
        await launcherConfig.waitForLoad();
        logger.info('Configuration loaded successfully');

        createWindow();
    } catch (error) {
        logger.crash(`FATAL ERROR in main(): ${error.stack || error}`);
        app.quit();
    }
}

function createWindow() {
    try {
        if (!launcherConfig.isLoaded) {
            logger.error('Attempting to create window before config is loaded');
            setTimeout(createWindow, 100);
            return;
        }

        const windowSettings = launcherConfig.get('window');

        mainWindow = new BrowserWindow({
            title: 'Peebify Launcher',
            width: windowSettings.width,
            height: windowSettings.height,
            minWidth: 940,
            minHeight: 560,
            frame: false,
            transparent: true,
            backgroundColor: '#00000000',
            show: false,
            icon: path.join(__dirname, 'frontend', 'icons', 'app.png'),
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: path.join(__dirname, 'preload.js')
            }
        });

        if (windowSettings.maximized) {
            mainWindow.maximize();
        }

        initialDataPromise = fetchInitialData();

        ipcMain.handle('get-social-icon', async (event, platform) => {
            const { CoreUtils } = require('./backend/core');
            try {
                const iconPath = await assetCache.getCachedSocialIcon(platform);
                if (iconPath) {
                    return { success: true, path: iconPath };
                }
                return { success: false, error: 'Icon not cached' };
            } catch (error) {
                logger.error(`Failed to get social icon ${platform}:`, error);
                return { success: false, error: error.message };
            }
        });

        mainWindow.loadFile(path.join(__dirname, 'frontend', 'index.html'));

        initializeModules();
        setupWindowListeners();

    } catch (error) {
        logger.crash(`FATAL STARTUP ERROR: ${error.stack || error}`);
        app.quit();
    }
}

function initializeModules() {
    if (modulesInitialized) {
        logger.warn('Attempted to initialize modules a second time. Aborting.');
        return;
    }
    modulesInitialized = true;

    try {
        logger.info('Initializing modules...');

        if (!launcherConfig.isLoaded) {
            logger.error('Config became unloaded during module initialization');
            return;
        }

        ipcMain.handle('get-initial-data', async () => {
            const { CoreUtils } = require('./backend/core');
            try {
                const data = await initialDataPromise;
                if (data) {
                    return CoreUtils.createStandardResponse(true, data);
                }
                return CoreUtils.createStandardResponse(false, null, 'Initial assets not available.');
            } catch (error) {
                logger.error('Error providing initial data to renderer:', error);
                return CoreUtils.createStandardResponse(false, null, error.message);
            }
        });

        appEvents.on('game-started', () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('game-started');
            }
            if (windowManager) windowManager.updateTrayMenu();

            const action = launcherConfig.get('behavior')?.launchAction;
            if (action === 'minimize') {
                mainWindow?.minimize();
            } else if (action === 'tray' && windowManager) {
                mainWindow?.hide();
                windowManager.createTray();
            }
        });

        appEvents.on('game-stopped', () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('game-stopped');
            }
            if (windowManager) windowManager.updateTrayMenu();
        });

        gameManager = new GameManager(mainWindow, launcherConfig, appEvents);
        windowManager = setupWindowManager(mainWindow, launcherConfig, app, gameManager);

        const { setupAutoUpdater } = require('./backend/updater');
        const { communityTools, setupExternalLinksIPC } = require('./backend/external-links');
        const { CONSTANTS } = require('./backend/core');

        ipcMain.handle('get-build-info', () => ({ buildType: CONSTANTS.BUILD_TYPE }));
        setupAutoUpdater(mainWindow, launcherConfig);

        setupGameManagerIPC(ipcMain, gameManager);

        setupConfigIPC(launcherConfig);

        require('./backend/notifications').setupNotificationIPC(ipcMain);

        require('./backend/file-handler').setupFileHandlerIPC(ipcMain, mainWindow, launcherConfig, gameManager);

        setupExternalLinksIPC(ipcMain, launcherConfig, mainWindow);

        ipcMain.handle('get-community-tools', () => communityTools);

        ipcMain.handle('load-view', async (event, viewName) => {
            try {
                const viewPath = path.join(__dirname, 'frontend', 'views', `${viewName}.html`);
                const content = await fs.promises.readFile(viewPath, 'utf-8');
                return content;
            } catch (error) {
                logger.error(`Failed to load view: ${viewName}`, error);
                return `<p style="color: white; text-align: center; padding: 20px;">Error loading view: ${viewName}. Please check the logs.</p>`;
            }
        });

        logger.info('All modules initialized successfully');
    } catch (error) {
        logger.error('Error initializing modules:', error);
    }
}

function setupWindowListeners() {
    mainWindow.once('ready-to-show', async () => {
        try {
            logger.info('Performing pre-show tasks...');

            const initialData = await initialDataPromise;

            if (initialData && initialData.fromCache) {
                logger.info('Assets loaded from cache, showing window immediately');
            } else {
                logger.info('Assets loaded from remote, showing window');
            }

            const { checkForLauncherUpdates } = require('./backend/updater');
            const { CoreUtils } = require('./backend/core');

            if (await CoreUtils.isOnline()) {
                logger.info('Internet connection detected. Checking for updates.');
                checkForLauncherUpdates();

                const gamePath = launcherConfig.get('gamePath');
                if (gamePath && gameManager) {
                    const updateResult = await gameManager.checkForUpdates();
                    if (updateResult.success && updateResult.updateAvailable) {
                        logger.info('Game update found during initialization, notifying renderer.');
                        mainWindow.webContents.send('update-available', updateResult);
                    }
                }
            } else {
                logger.info('No internet connection detected on startup. Skipping initial update checks.');
            }

            const autoLaunchEnabled = launcherConfig.get('behavior.autoLaunchGame');
            const gamePath = launcherConfig.get('gamePath');

            if (autoLaunchEnabled && gamePath && gameManager) {
                logger.info('Auto-launch enabled. Starting game...');
                gameManager.launchGame().catch(err => {
                    logger.error('Auto-launch failed:', err);
                });
            }

            const isBootLaunch = process.argv.includes('--from-boot');
            const startOnBootConfig = launcherConfig.get('behavior')?.startOnBoot;

            if (isBootLaunch && startOnBootConfig) {
                const bootAction = launcherConfig.get('behavior')?.startOnBootAction || 'open';
                logger.info(`Boot launch detected with action: ${bootAction}`);

                switch (bootAction) {
                    case 'minimized':
                        mainWindow.show();
                        mainWindow.minimize();
                        break;
                    case 'tray':
                        windowManager.createTray();
                        break;
                    default:
                        mainWindow.show();
                }
            } else {
                mainWindow.show();
            }
        } catch (error) {
            logger.error('Error in ready-to-show handler:', error);
            if (mainWindow && !mainWindow.isVisible()) {
                mainWindow.show();
            }
        }
    });

    mainWindow.on('blur', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.setBackgroundColor('#00000001');
        }
    });

    mainWindow.on('focus', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.setBackgroundColor('#00000000');
        }
    });

    mainWindow.on('close', (event) => {
        logger.info('Window is closing, cleaning up running operations...');

        if (gameManager) {
            gameManager.stopProcessMonitoring();
        }

        if (launcherConfig) {
            launcherConfig.cleanup();
        }

        if (mainWindow && !mainWindow.isDestroyed()) {
            try {

                mainWindow.webContents.send('app-closing');

                setTimeout(() => {
                    if (!mainWindow.isDestroyed()) {
                        logger.info('Force closing window after cleanup timeout');
                    }
                }, 1000);
            } catch (error) {
                logger.warn('Error during window close cleanup:', error);
            }
        }
    });

    mainWindow.on('closed', () => {
        logger.info('Window closed, performing final cleanup...');
        mainWindow = null;

        if (gameManager) {
            gameManager.stopProcessMonitoring();
        }
    });

    const saveWindowState = () => {
        if (!mainWindow || mainWindow.isDestroyed() || !launcherConfig.isLoaded) return;

        try {
            const isMaximized = mainWindow.isMaximized();
            const bounds = mainWindow.getBounds();
            const currentWindowConfig = launcherConfig.get('window');

            launcherConfig.set('window', {
                width: isMaximized ? currentWindowConfig.width : bounds.width,
                height: isMaximized ? currentWindowConfig.height : bounds.height,
                maximized: isMaximized,
            });
        } catch (error) {
            logger.error('Error saving window state:', error);
        }
    };

    mainWindow.on('resize', saveWindowState);
    mainWindow.on('move', saveWindowState);

    app.on('before-quit', () => {
        logger.info('Application is quitting, cleaning up...');
        app.isQuitting = true;

        if (windowManager) {
            windowManager.destroyTray();
        }

        if (gameManager) {
            gameManager.stopProcessMonitoring();
        }

        if (launcherConfig) {
            launcherConfig.cleanup();
        }
    });
}

function restartAsAdmin() {
    const command = `"${process.execPath}"`;
    const args = process.argv.slice(1);
    const psCommand = `Start-Process -FilePath "${command}" -ArgumentList '${args.join(' ')}' -Verb runas`;

    exec(`powershell.exe -Command "${psCommand}"`, (error) => {
        if (error) {
            logger.error('Failed to restart with admin rights:', error);
        }
        app.quit();
    });
}

app.whenReady().then(async () => {
    protocol.registerFileProtocol('local-resource', (request, callback) => {
        try {
            const decodedUrl = decodeURI(request.url);
            const filePath = path.normalize(decodedUrl.substring('local-resource:///'.length));
            callback({ path: filePath });
        } catch (error) {
            logger.error(`Failed to serve local resource: ${request.url}`, error);
            callback({ error: -6 });
        }
    });

    if (process.platform === 'win32') {
        try {
            const isElevated = require('is-elevated');
            if (!await isElevated()) {
                logger.warn('Restarting with admin rights...');
                restartAsAdmin();
                return;
            }
        } catch (e) {
            logger.error('Could not check admin privileges:', e);
        }
    }

    main();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});