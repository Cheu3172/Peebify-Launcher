const { Notification, nativeImage } = require('electron');
const path = require('path');

const { CoreUtils } = require('./core');
const { logger } = require('./logger');

const ICON_PATH = path.join(__dirname, '..', '..', 'frontend', 'icons', 'app.png');

function showNotification({
    title,
    body,
    silent = false
}) {
    if (!Notification.isSupported()) {
        logger.warn('Native notifications not supported');
        return CoreUtils.createStandardResponse(false, null, 'Notifications not supported');
    }

    try {
        const appIcon = nativeImage.createFromPath(ICON_PATH);

        const notification = new Notification({
            title,
            body,
            icon: appIcon,
            silent,
        });

        notification.on('click', () => {
            logger.info(`Notification clicked: "${title}"`);
        });

        notification.show();
        return CoreUtils.createStandardResponse(true);
    } catch (error) {
        logger.error('Failed to show notification:', error);
        return CoreUtils.createStandardResponse(false, null, error.message);
    }
}

function setupNotificationIPC(ipcMain) {
    ipcMain.handle('show-notification', (event, options) => {
        return showNotification(options);
    });
}

module.exports = {
    setupNotificationIPC
};