const { CoreUtils } = require('./core');
const { logger } = require('./logger');
const path = require('path');
const { promises: fs } = require('fs');

const API_CONFIG_URL = 'https://raw.githubusercontent.com/Cheu3172/Wuwa-Web-Request/main/api.json';
const CACHE_FILE = CoreUtils.getAppDataPath('api-config-cache.json');
const CACHE_DURATION = 1000 * 60 * 60 * 12;

class ApiConfig {
    constructor() {
        this.config = null;
        this.lastFetched = null;
    }

    async initialize() {
        try {
            await this.loadFromCache();

            if (this.shouldRefresh()) {
                logger.info('API config cache expired or missing, fetching from GitHub...');
                await this.fetchAndCache();
            } else {
                logger.info('Using cached API config');

                this.refreshInBackground();
            }

            if (!this.config) {
                throw new Error('Failed to load API config from cache or GitHub');
            }

            this.logCurrentUrls();

            logger.info('API config initialized successfully');
        } catch (error) {
            logger.error('Failed to initialize API config:', error);
            throw new Error('Cannot proceed without API configuration from GitHub. Please check your internet connection and try again.');
        }
    }

    logCurrentUrls() {
        try {
            logger.info('=== Dynamic Visual Asset URLs from GitHub ===');
            logger.info(`News: ${this.getNewsUrl()}`);
            logger.info(`Wallpaper: ${this.getWallpaperUrl()}`);
            logger.info(`Social Icons: ${this.getSocialIconsUrl()}`);
            logger.info('==============================================');
        } catch (error) {
            logger.warn('Could not log API URLs:', error.message);
        }
    }

    async loadFromCache() {
        try {
            const data = await fs.readFile(CACHE_FILE, 'utf-8');
            const cached = JSON.parse(data);

            if (cached.config && cached.timestamp) {
                this.config = cached.config;
                this.lastFetched = cached.timestamp;
                logger.debug('Loaded API config from cache');
            }
        } catch (error) {
            if (error.code !== 'ENOENT') {
                logger.warn('Failed to load API config cache:', error.message);
            }
        }
    }

    async saveToCache() {
        try {
            const cacheData = {
                config: this.config,
                timestamp: this.lastFetched
            };

            await CoreUtils.ensureDirectory(path.dirname(CACHE_FILE));
            await fs.writeFile(CACHE_FILE, JSON.stringify(cacheData, null, 2), 'utf-8');
            logger.debug('Saved API config to cache');
        } catch (error) {
            logger.warn('Failed to save API config cache:', error.message);
        }
    }

    shouldRefresh() {
        if (!this.config || !this.lastFetched) {
            return true;
        }

        const age = Date.now() - this.lastFetched;
        return age > CACHE_DURATION;
    }

    async fetchAndCache() {
        try {
            logger.info(`Fetching API config from ${API_CONFIG_URL}`);
            const response = await CoreUtils.httpRequest(API_CONFIG_URL);
            const config = JSON.parse(response);

            if (!this.validateConfig(config)) {
                throw new Error('Invalid API config structure from GitHub');
            }

            this.config = config;
            this.lastFetched = Date.now();

            await this.saveToCache();
            logger.info('API config fetched and cached successfully');
        } catch (error) {
            logger.error('Failed to fetch API config from GitHub:', error);
            throw error;
        }
    }

    validateConfig(config) {
        try {

            if (!config?.clients?.osLive) {
                logger.error('Missing clients.osLive in API config');
                return false;
            }

            const osLive = config.clients.osLive;
            const requiredKeys = ['news-notices', 'wallpapers-slogan', 'socials-icons'];

            for (const key of requiredKeys) {
                if (!osLive[key]?.url) {
                    logger.error(`Missing ${key}.url in API config`);
                    return false;
                }
            }

            logger.debug('API config structure validated successfully');
            return true;
        } catch (error) {
            logger.error('Error validating config structure:', error);
            return false;
        }
    }

    refreshInBackground() {
        setTimeout(async () => {
            try {
                await this.fetchAndCache();
                logger.info('Background API config refresh completed');
            } catch (error) {
                logger.warn('Background API config refresh failed:', error.message);
            }
        }, 5000);
    }

    getNewsUrl() {
        if (!this.config?.clients?.osLive?.['news-notices']?.url) {
            throw new Error('News URL not available in API configuration');
        }
        return this.config.clients.osLive['news-notices'].url;
    }

    getWallpaperUrl() {
        if (!this.config?.clients?.osLive?.['wallpapers-slogan']?.url) {
            throw new Error('Wallpaper URL not available in API configuration');
        }
        return this.config.clients.osLive['wallpapers-slogan'].url;
    }

    getSocialIconsUrl() {
        if (!this.config?.clients?.osLive?.['socials-icons']?.url) {
            throw new Error('Social media URL not available in API configuration');
        }
        const url = this.config.clients.osLive['socials-icons'].url;
        return url.split('?')[0];
    }

    getAllUrls() {
        return {
            news: this.getNewsUrl(),
            wallpaper: this.getWallpaperUrl(),
            socialIcons: this.getSocialIconsUrl()
        };
    }
}

const apiConfig = new ApiConfig();

module.exports = {
    ApiConfig,
    apiConfig
};