const { autoUpdater } = require('electron-updater');
const { dialog, ipcMain } = require('electron');

const { CONSTANTS, CoreUtils } = require('./core');
const { logger } = require('./logger');

let isSilentUpdateCheck = false;

async function checkForLauncherUpdates(isSilent = false) {
    if (!(await CoreUtils.isOnline())) {
        logger.info('No internet connection, skipping launcher update check.');
        return;
    }
    logger.info(`Triggering check for launcher updates. Silent: ${isSilent}`);
    isSilentUpdateCheck = isSilent;
    autoUpdater.checkForUpdates();
}

function setupAutoUpdater(mainWindow, launcherConfig) {
    autoUpdater.logger = logger;
    autoUpdater.autoDownload = false;

    const initialBranch = launcherConfig.get('behavior')?.updateBranch || 'stable';
    autoUpdater.allowPrerelease = (initialBranch === 'beta');
    logger.info(`Updater initialized on '${initialBranch}' branch. allowPrerelease: ${autoUpdater.allowPrerelease}`);

    const eventHandlers = {
        'checking-for-update': () => {
            logger.info('Checking for launcher update...');
        },

        'update-available': (info) => {
            logger.info(`Launcher update available: v${info.version}`);
            isSilentUpdateCheck = false;
            mainWindow.webContents.send('launcher-update-available', info);
        },

        'update-not-available': () => {
            logger.info('Launcher is already up-to-date.');
            if (!isSilentUpdateCheck) {
                mainWindow.webContents.send('launcher-up-to-date');
            }
            isSilentUpdateCheck = false;
        },

        'download-progress': (progress) => {
            logger.info(`Launcher download progress: ${progress.percent.toFixed(2)}%`);
            mainWindow.webContents.send('launcher-download-progress', {
                percent: progress.percent,
            });
        },

        'update-downloaded': (info) => {
            logger.info(`Launcher update v${info.version} downloaded.`);
            mainWindow.webContents.send('launcher-update-ready', info.version);
        },

        'error': (error) => {
            logger.error('Error in auto-updater:', error);
            isSilentUpdateCheck = false;

            if (error.message.includes('net::ERR_INTERNET_DISCONNECTED')) {
                logger.warn('Auto-updater failed due to no internet connection.');
                return;
            }
            dialog.showErrorBox(
                'Update Error',
                `An error occurred while checking for updates. Please see the logs for details.\n\n${error.message}`
            );
        }
    };

    Object.entries(eventHandlers).forEach(([event, handler]) => {
        autoUpdater.on(event, handler);
    });

    const ipcHandlers = {
        'download-launcher-update': () => {
            logger.info('User triggered launcher update download from the UI.');
            autoUpdater.downloadUpdate();
        },

        'restart-and-install-update': () => {
            logger.info('Restart and install triggered from renderer.');
            autoUpdater.quitAndInstall();
        },

        'update-branch-changed': (event, branch) => {
            const allowPrerelease = (branch === 'beta');
            if (autoUpdater.allowPrerelease !== allowPrerelease) {
                autoUpdater.allowPrerelease = allowPrerelease;
                logger.info(`Update branch switched to '${branch}'. New updates will be checked from this branch. Setting allowPrerelease to ${autoUpdater.allowPrerelease}.`);
                checkForLauncherUpdates(false);
            }
        }
    };

    Object.entries(ipcHandlers).forEach(([event, handler]) => {
        ipcMain.handle(event, handler);
    });

    ipcMain.handle('check-for-launcher-update', () => {
        logger.info('Manual check for launcher update triggered.');
        checkForLauncherUpdates(false);
    });

    setInterval(() => {
        logger.info('Triggering periodic check for launcher updates.');
        checkForLauncherUpdates(true);
    }, CONSTANTS.AUTO_UPDATE_INTERVAL);
}

module.exports = { setupAutoUpdater, checkForLauncherUpdates };