const {
    Tray,
    Menu,
    ipcMain,
    app,
    BrowserWindow,
    shell
} = require('electron');
const path = require('path');

const {
    CoreUtils,
    GameUtils
} = require('./core');
const {
    logger
} = require('./logger');

class WindowManager {
    constructor(mainWindow, launcherConfig, app, gameManager) {
        this.mainWindow = mainWindow;
        this.launcherConfig = launcherConfig;
        this.app = app;
        this.gameManager = gameManager;
        this.tray = null;
        this.isQuitting = false;
        this.windowState = {
            isVisible: true,
            isMaximized: false,
            bounds: null
        };

        this.setupWindowEvents();
        this.setupIPCHandlers();
        this.setupWindowStateSaving();
        this.attachCustomHandlers();
    }

    handleStartupVisibility() {
        const startupMode = this.launcherConfig.get('behavior.startupMode', 'open');
        logger.info(`Handling startup visibility with mode: "${startupMode}"`);

        switch (startupMode) {
            case 'minimize':
                this.mainWindow.show();
                this.mainWindow.minimize();
                break;
            case 'tray':
                this.createTray();
                break;
            case 'open':
            default:
                this.mainWindow.show();
                break;
        }
    }

    attachCustomHandlers() {
        this.mainWindow.performLaunchAction = (action) => {
            logger.info(`Performing post-launch action via attached method: "${action}"`);
            switch (action) {
                case 'minimize':
                    if (this.mainWindow && !this.mainWindow.isDestroyed()) this.mainWindow.minimize();
                    break;
                case 'tray':
                    this.hideWindow();
                    break;
                case 'close':
                    this.quitApp();
                    break;
            }
        };
    }

    createTray() {
        if (this.tray) return;

        try {
            const iconPath = path.join(this.app.getAppPath(), 'frontend', 'icons', 'app.png');
            this.tray = new Tray(iconPath);

            const contextMenu = this.createTrayMenu();
            this.tray.setToolTip('Peebify Launcher');
            this.tray.setContextMenu(contextMenu);

            this.tray.on('double-click', () => this.showWindow());

            if (process.platform === 'win32') {
                this.tray.on('click', () => this.tray.popUpContextMenu());
            }

            logger.info('System tray created');
        } catch (error) {
            logger.error('Failed to create system tray:', error);
        }
    }

    createTrayMenu() {
        const gamePath = this.launcherConfig.get('gamePath');
        const isGameRunning = this.gameManager ? this.gameManager.isGameRunning : false;

        return Menu.buildFromTemplate([{
            label: 'Show Launcher',
            click: () => this.showWindow(),
            accelerator: 'CmdOrCtrl+Shift+L'
        }, {
            type: 'separator'
        }, {
            label: 'Launch Game',
            click: () => {
                if (this.gameManager) {
                    this.gameManager.launchGame();
                } else {
                    logger.error('GameManager not available to launch game from tray.');
                }
            },
            enabled: !!gamePath && !isGameRunning
        }, {
            label: 'Force Close Game',
            click: async () => {
                try {
                    if (this.gameManager) {
                        await this.gameManager.forceCloseGame();
                    } else {
                        logger.error('GameManager not available to force close game from tray.');
                    }
                } catch (error) {
                    logger.error(`Failed to force close game from tray: ${error.stack || error}`);
                }
            },
            enabled: isGameRunning
        }, {
            type: 'separator'
        }, {
            label: 'Game Folder',
            click: () => {
                if (gamePath) {
                    shell.openPath(gamePath).catch(err => logger.error('Failed to open game folder:', err));
                }
            },
            enabled: !!gamePath
        }, {
            label: 'Screenshots',
            click: () => {
                if (gamePath) {
                    const screenshotPath = GameUtils.getScreenshotPath(gamePath);
                    shell.openPath(screenshotPath).catch(err => {
                        logger.error(`Failed to open screenshots folder at ${screenshotPath}:`, err);
                    });
                }
            },
            enabled: !!gamePath
        }, {
            type: 'separator'
        }, {
            label: 'Quit',
            click: () => this.quitApp(),
            accelerator: 'CmdOrCtrl+Q'
        }]);
    }

    updateTrayMenu() {
        if (!this.tray) return;

        const contextMenu = this.createTrayMenu();
        this.tray.setContextMenu(contextMenu);
    }

    destroyTray() {
        if (this.tray) {
            this.tray.destroy();
            this.tray = null;
            logger.info('System tray destroyed');
        }
    }

    showWindow() {
        if (!this.mainWindow || this.mainWindow.isDestroyed()) return;

        if (this.mainWindow.isMinimized()) {
            this.mainWindow.restore();
        }

        this.mainWindow.show();
        this.mainWindow.focus();

        if (!this.launcherConfig.get('behavior')?.alwaysShowTray) {
            this.destroyTray();
        }

        this.windowState.isVisible = true;
    }

    hideWindow() {
        if (!this.mainWindow || this.mainWindow.isDestroyed()) return;

        this.mainWindow.hide();
        this.createTray();
        this.windowState.isVisible = false;
    }

    minimizeWindow() {
        if (!this.mainWindow || this.mainWindow.isDestroyed()) return;

        const minimizeAction = this.launcherConfig.get('behavior')?.minimizeAction;

        if (minimizeAction === 'tray') {
            this.hideWindow();
        } else if (minimizeAction === 'close') {
            this.mainWindow.close();
        } else {
            this.mainWindow.minimize();
        }
    }

    quitApp() {
        this.isQuitting = true;
        this.app.quit();
    }

    setupWindowEvents() {
        this.mainWindow.on('close', (event) => {
            if (this.isQuitting) {
                return;
            }

            const closeAction = this.launcherConfig.get('behavior')?.closeAction || 'close';

            switch (closeAction) {
                case 'minimize':
                    event.preventDefault();
                    this.mainWindow.minimize();
                    break;
                case 'tray':
                    event.preventDefault();
                    this.hideWindow();
                    break;
                case 'close':
                default:
                    break;
            }
        });

        this.mainWindow.on('minimize', () => {
            this.windowState.isVisible = false;
        });

        this.mainWindow.on('restore', () => {
            this.windowState.isVisible = true;
        });

        this.mainWindow.on('show', () => {
            this.windowState.isVisible = true;

            this.updateTrayMenu();

            if (!this.launcherConfig.get('behavior')?.alwaysShowTray) {
                this.destroyTray();
            }
        });

        this.mainWindow.on('hide', () => {
            this.windowState.isVisible = false;
        });

        this.mainWindow.on('maximize', () => {
            this.windowState.isMaximized = true;
        });

        this.mainWindow.on('unmaximize', () => {
            this.windowState.isMaximized = false;
        });

        this.mainWindow.on('focus', () => {
            this.mainWindow.webContents.send('window-focused');
        });

        this.mainWindow.on('blur', () => {
            this.mainWindow.webContents.send('window-blurred');
        });
    }

    setupWindowStateSaving() {
        let saveTimer = null;

        const saveWindowState = () => {
            if (!this.mainWindow || this.mainWindow.isDestroyed() || !this.launcherConfig.isLoaded) {
                return;
            }

            if (saveTimer) {
                clearTimeout(saveTimer);
            }

            saveTimer = setTimeout(() => {
                try {
                    const isMaximized = this.mainWindow.isMaximized();
                    const bounds = this.mainWindow.getBounds();
                    const currentWindowConfig = this.launcherConfig.get('window') || {};

                    const newConfig = {
                        width: isMaximized ? currentWindowConfig.width : bounds.width,
                        height: isMaximized ? currentWindowConfig.height : bounds.height,
                        x: isMaximized ? currentWindowConfig.x : bounds.x,
                        y: isMaximized ? currentWindowConfig.y : bounds.y,
                        maximized: isMaximized
                    };

                    this.launcherConfig.set('window', newConfig);
                } catch (error) {
                    logger.error('Error saving window state:', error);
                }
            }, 500);
        };

        this.mainWindow.on('resize', saveWindowState);
        this.mainWindow.on('move', saveWindowState);
        this.mainWindow.on('maximize', saveWindowState);
        this.mainWindow.on('unmaximize', saveWindowState);
    }

    setupIPCHandlers() {
        ipcMain.handle('minimize-window', () => {
            this.minimizeWindow();
            return CoreUtils.createStandardResponse(true);
        });

        ipcMain.handle('close-window', () => {
            this.mainWindow.close();
            return CoreUtils.createStandardResponse(true);
        });

        ipcMain.handle('show-window', () => {
            this.showWindow();
            return CoreUtils.createStandardResponse(true);
        });

        ipcMain.handle('hide-window', () => {
            this.hideWindow();
            return CoreUtils.createStandardResponse(true);
        });

        ipcMain.handle('toggle-maximize', () => {
            if (this.mainWindow.isMaximized()) {
                this.mainWindow.unmaximize();
            } else {
                this.mainWindow.maximize();
            }
            return CoreUtils.createStandardResponse(true);
        });

        ipcMain.handle('get-window-state', () => {
            return CoreUtils.createStandardResponse(true, {
                isVisible: this.windowState.isVisible,
                isMaximized: this.windowState.isMaximized,
                isMinimized: this.mainWindow.isMinimized(),
                isFocused: this.mainWindow.isFocused()
            });
        });

        ipcMain.handle('create-tray', () => {
            this.createTray();
            return CoreUtils.createStandardResponse(true);
        });

        ipcMain.handle('destroy-tray', () => {
            this.destroyTray();
            return CoreUtils.createStandardResponse(true);
        });

        ipcMain.handle('update-tray-menu', () => {
            this.updateTrayMenu();
            return CoreUtils.createStandardResponse(true);
        });
    }

    restoreWindowState() {
        const windowConfig = this.launcherConfig.get('window');
        if (!windowConfig) return;

        try {
            if (windowConfig.x !== undefined && windowConfig.y !== undefined) {
                const {
                    screen
                } = require('electron');
                const displays = screen.getAllDisplays();
                const inBounds = displays.some(display => {
                    const {
                        x,
                        y,
                        width,
                        height
                    } = display.bounds;
                    return windowConfig.x >= x &&
                        windowConfig.y >= y &&
                        windowConfig.x < x + width &&
                        windowConfig.y < y + height;
                });

                if (inBounds) {
                    this.mainWindow.setPosition(windowConfig.x, windowConfig.y);
                }
            }

            if (windowConfig.width && windowConfig.height) {
                this.mainWindow.setSize(windowConfig.width, windowConfig.height);
            }

            if (windowConfig.maximized) {
                this.mainWindow.maximize();
            }
        } catch (error) {
            logger.error('Failed to restore window state:', error);
        }
    }

    cleanup() {
        this.destroyTray();

        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.removeAllListeners();
        }
    }
}

function setupWindowManager(mainWindow, launcherConfig, app, gameManager) {
    const windowManager = new WindowManager(mainWindow, launcherConfig, app, gameManager);

    windowManager.restoreWindowState();

    app.on('before-quit', () => {
        windowManager.isQuitting = true;
        windowManager.cleanup();
    });

    app.on('activate', () => {
        if (process.platform === 'darwin') {
            windowManager.showWindow();
        }
    });

    return windowManager;
}

module.exports = {
    setupWindowManager
};