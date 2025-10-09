const {
    shell,
    dialog,
    Notification
} = require('electron');
const {
    promises: fs
} = require('fs');
const path = require('path');

const {
    CONSTANTS,
    EXTERNAL_LINKS,
    CoreUtils,
    GameUtils
} = require('./core');
const {
    logger
} = require('./logger');
const { apiConfig } = require('./api-config');

async function openExternalUrl(url) {
    if (!url?.trim()) {
        return CoreUtils.createStandardResponse(false, null, 'Invalid URL provided.');
    }

    try {
        await shell.openExternal(url);
        return CoreUtils.createStandardResponse(true);
    } catch (error) {
        logger.error(`Failed to open external URL: ${url}`, error);
        return CoreUtils.createStandardResponse(false, null, error.message);
    }
}

async function openSocialLink(platform) {
    const url = EXTERNAL_LINKS.SOCIAL[platform];
    if (!url) {
        logger.warn(`No URL found for social platform: ${platform}`);
        return CoreUtils.createStandardResponse(false, null, 'Platform not found');
    }

    try {
        await shell.openExternal(url);
        logger.info(`Successfully opened ${platform} link: ${url}`);
        return CoreUtils.createStandardResponse(true);
    } catch (error) {
        logger.error(`Failed to open ${platform} link: ${url}`, error);
        return CoreUtils.createStandardResponse(false, null, error.message);
    }
}

async function moveGameLocation(currentPath, newPath, win) {
    const finalPath = path.join(newPath, path.basename(currentPath));
    logger.info(`Moving game from ${currentPath} to ${finalPath}`);

    const validationResult = await validateMoveOperation(currentPath, finalPath);
    if (!validationResult.success) {
        return validationResult;
    }

    return await executeMoveOperation(currentPath, finalPath, win);
}

async function validateMoveOperation(currentPath, finalPath) {
    if (!(await CoreUtils.fileExists(currentPath))) {
        return CoreUtils.createStandardResponse(false, null, 'Source game directory does not exist.');
    }

    if (await CoreUtils.fileExists(finalPath)) {
        return CoreUtils.createStandardResponse(false, null, `Destination already exists: ${finalPath}`);
    }

    return CoreUtils.createStandardResponse(true);
}

async function executeMoveOperation(currentPath, finalPath, win) {
    win.webContents.send('move-progress', {
        status: 'Starting move...'
    });

    try {
        const result = await CoreUtils.moveFileOrDirectory(currentPath, finalPath);

        if (result.method === 'copy-delete') {
            logger.info('Cross-drive move detected, used copy + delete');
            win.webContents.send('move-progress', {
                status: 'Copying files...'
            });
            win.webContents.send('move-progress', {
                status: 'Cleaning up...'
            });
        }

        logger.info(`Game moved to: ${finalPath}`);
        return CoreUtils.createStandardResponse(true, {
            newPath: finalPath
        });
    } catch (error) {
        logger.error('Move operation failed:', error);
        return CoreUtils.createStandardResponse(false, null, error.message);
    }
}

async function uninstallGame(gamePath, launcherConfig, win) {
    if (!gamePath) {
        return CoreUtils.createStandardResponse(false, null, 'Game path not configured.');
    }

    try {
        logger.warn(`Uninstalling game from: ${gamePath}`);

        const getAllFiles = async (dir) => {
            const files = [];
            const items = await fs.readdir(dir, { withFileTypes: true });

            for (const item of items) {
                const fullPath = path.join(dir, item.name);
                if (item.isDirectory()) {
                    files.push(...await getAllFiles(fullPath));
                } else {
                    files.push(fullPath);
                }
            }
            return files;
        };

        const allFiles = await getAllFiles(gamePath);
        let deletedCount = 0;

        for (const filePath of allFiles) {
            try {
                await fs.unlink(filePath);
                deletedCount++;

                const progress = (deletedCount / allFiles.length) * 100;
                win.webContents.send('uninstall-progress', {
                    percentage: progress,
                    file: path.basename(filePath)
                });
            } catch (error) {

                logger.warn(`Failed to delete file: ${filePath}`, error);
            }
        }

        await fs.rm(gamePath, { recursive: true, force: true });

        launcherConfig.set('gamePath', '');
        return CoreUtils.createStandardResponse(true);
    } catch (error) {
        logger.error('Uninstall failed:', error);
        return CoreUtils.createStandardResponse(false, null, error.message);
    }
}

async function forceCloseGame() {
    logger.info('Force-closing game processes');
    return await CoreUtils.terminateProcess(CONSTANTS.GAME_CLIENT_PROCESS);
}

async function openGameFolder(gamePath) {
    if (!gamePath) {
        return CoreUtils.createStandardResponse(false, null, 'Game path not configured.');
    }

    try {
        await shell.openPath(gamePath);
        return CoreUtils.createStandardResponse(true);
    } catch (error) {
        return CoreUtils.createStandardResponse(false, null, error.message);
    }
}

async function openScreenshotFolder(gamePath) {
    if (!gamePath) {
        return CoreUtils.createStandardResponse(false, null, 'Game path not configured.');
    }

    const screenshotPath = GameUtils.getScreenshotPath(gamePath);

    if (!(await CoreUtils.fileExists(screenshotPath))) {
        return CoreUtils.createStandardResponse(false, null, 'Screenshot folder not found.');
    }

    try {
        await shell.openPath(screenshotPath);
        return CoreUtils.createStandardResponse(true);
    } catch (error) {
        return CoreUtils.createStandardResponse(false, null, error.message);
    }
}

async function selectNewGameLocation(win) {
    const {
        canceled,
        filePaths
    } = await dialog.showOpenDialog(win, {
        title: 'Select New Game Location',
        properties: ['openDirectory']
    });

    return {
        canceled,
        path: filePaths?.[0]
    };
}

function showMoveNotification(newPath) {
    if (Notification.isSupported()) {
        new Notification({
            title: 'Move Complete',
            body: `Game moved to ${newPath}`,
        }).show();
    }
}

async function handleMoveGameLocation(launcherConfig, win) {
    const currentPath = launcherConfig.get('gamePath');
    if (!currentPath) {
        return CoreUtils.createStandardResponse(false, null, 'Game path not configured.');
    }

    const {
        canceled,
        path: newParentPath
    } = await selectNewGameLocation(win);
    if (canceled || !newParentPath) {
        return CoreUtils.createStandardResponse(false, {
            cancelled: true
        });
    }

    const result = await moveGameLocation(currentPath, newParentPath, win);

    if (result.success) {
        launcherConfig.set('gamePath', result.newPath);
        showMoveNotification(result.newPath);
        win.webContents.send('game-path-updated', {
            newPath: result.newPath
        });
    }

    return result;
}

async function getNewsData() {
    try {
        const { assetCache } = require('./asset-cache');

        const cachedNews = await assetCache.getCachedNewsData();
        if (cachedNews) {
            logger.info('Returning cached news data');
            return CoreUtils.createStandardResponse(true, { data: cachedNews });
        }

        logger.info('Fetching news data from server (no cache available)');
        const result = await CoreUtils.fetchNewsData(apiConfig);

        if (result.success) {
            await assetCache.cacheNewsBanners(result.data.data);
            logger.info('Successfully fetched and cached news data');
            return result;
        } else {
            logger.error('Failed to fetch news data:', result.error);
            return CoreUtils.createStandardResponse(false, null, 'Failed to load news data');
        }
    } catch (error) {
        logger.error('Error fetching news data:', error);
        return CoreUtils.createStandardResponse(false, null, 'Failed to load news data');
    }
}

function setupExternalLinksIPC(ipcMain, launcherConfig, win) {
    ipcMain.handle('open-external-url', async (event, url) => openExternalUrl(url));
    ipcMain.handle('open-social-link', async (event, platform) => openSocialLink(platform));
    ipcMain.handle('get-community-tools', async () => EXTERNAL_LINKS.COMMUNITY_TOOLS);
    ipcMain.handle('get-news-data', async () => getNewsData());

    ipcMain.handle('open-game-folder', async () => {
        const gamePath = launcherConfig.get('gamePath');
        return await openGameFolder(gamePath);
    });

    ipcMain.handle('open-screenshot-folder', async () => {
        const gamePath = launcherConfig.get('gamePath');
        return await openScreenshotFolder(gamePath);
    });

    ipcMain.handle('uninstall-game', async () => {
        const gamePath = launcherConfig.get('gamePath');
        return await uninstallGame(gamePath, launcherConfig, win);
    });

    ipcMain.handle('move-game-location', async () => {
        return await handleMoveGameLocation(launcherConfig, win);
    });

    ipcMain.handle('force-close-game', async () => {
        return await forceCloseGame();
    });
}

module.exports = {
    communityTools: EXTERNAL_LINKS.COMMUNITY_TOOLS,
    setupExternalLinksIPC
};