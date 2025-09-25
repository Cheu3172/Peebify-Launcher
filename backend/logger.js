const { promises: fs } = require('fs');
const path = require('path');

const { CoreUtils } = require('./core');

const LOGS_DIR = CoreUtils.getAppDataPath('logs');
const LOG_FILE = path.join(LOGS_DIR, `launch-${new Date().toISOString().replace(/:/g, '-')}.log`);
const CRASH_LOG_FILE = path.join(LOGS_DIR, 'crashes.log');

let initialized = false;

async function ensureLogDir() {
    if (initialized) return;

    const result = await CoreUtils.ensureDirectory(LOGS_DIR);
    if (result.success) {
        initialized = true;
    } else {
        console.error('Could not create log directory:', result.error);
    }
}

async function writeLog(filePath, level, message) {
    await ensureLogDir();

    const timestamp = new Date().toISOString();
    const formattedMessage = `[${timestamp}] [${level}] ${message}\n`;

    try {
        await fs.appendFile(filePath, formattedMessage);
    } catch (error) {
        console.error('Failed to write log:', error);
    }
}

const logger = {
    debug: (message) => writeLog(LOG_FILE, 'DEBUG', message),
    info: (message) => writeLog(LOG_FILE, 'INFO', message),
    warn: (message) => writeLog(LOG_FILE, 'WARN', message),
    error: (message) => writeLog(LOG_FILE, 'ERROR', String(message.stack || message)),
    crash: (message) => writeLog(CRASH_LOG_FILE, 'CRASH', String(message.stack || message)),
};

async function initializeLogger() {
    await ensureLogDir();

    const originalMethods = {
        log: console.log,
        warn: console.warn,
        error: console.error
    };

    console.log = (...args) => {
        const message = args.join(' ');
        logger.info(message);
        originalMethods.log(message);
    };

    console.warn = (...args) => {
        const message = args.join(' ');
        logger.warn(message);
        originalMethods.warn(message);
    };

    console.error = (...args) => {
        const message = args.join(' ');
        logger.error(message);
        originalMethods.error(message);
    };

    console.log('Logger initialized. Log file:', LOG_FILE);
}

module.exports = {
    logger,
    initializeLogger,
    LOGS_DIR
};
