const { promises: fs } = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { CoreUtils, CONSTANTS } = require('./core');
const { logger } = require('./logger');

const CACHE_DIR = CoreUtils.getAppDataPath('asset-cache');
const CACHE_MANIFEST_FILE = path.join(CACHE_DIR, 'manifest.json');
const SOCIAL_ICONS_API = 'https://prod-alicdn-gamestarter.kurogame.com/launcher/G153/50004_obOHXFrFanqsaIEOmuKroCcbZkQRBC7c/social/en.json';

class AssetCache {
    constructor() {
        this.manifest = {
            backgroundFile: null,
            slogan: null,
            backgroundFileHash: null,
            sloganHash: null,
            socialIcons: {},
            socialIconsTimestamp: null,
            newsBanners: {},
            newsData: null,
            newsDataTimestamp: null,
            lastUpdated: null
        };
    }

    async initialize() {
        try {
            await CoreUtils.ensureDirectory(CACHE_DIR);
            await this.loadManifest();
            logger.info('Asset cache initialized');
        } catch (error) {
            logger.error('Failed to initialize asset cache:', error);
        }
    }

    async loadManifest() {
        try {
            const data = await fs.readFile(CACHE_MANIFEST_FILE, 'utf-8');
            this.manifest = JSON.parse(data);
            logger.debug('Loaded asset cache manifest');
        } catch (error) {
            if (error.code !== 'ENOENT') {
                logger.warn('Failed to load cache manifest:', error.message);
            }
        }
    }

    async saveManifest() {
        try {
            await fs.writeFile(CACHE_MANIFEST_FILE, JSON.stringify(this.manifest, null, 2), 'utf-8');
            logger.debug('Saved asset cache manifest');
        } catch (error) {
            logger.error('Failed to save cache manifest:', error);
        }
    }

    async downloadFile(url, destPath) {
        return new Promise((resolve, reject) => {
            const protocol = url.startsWith('https:') ? https : http;
            const file = require('fs').createWriteStream(destPath);

            protocol.get(url, (response) => {
                if (response.statusCode !== 200) {
                    file.close();
                    fs.unlink(destPath).catch(() => {});
                    return reject(new Error(`HTTP ${response.statusCode} for ${url}`));
                }

                response.pipe(file);

                file.on('finish', () => {
                    file.close();
                    resolve();
                });

                file.on('error', (err) => {
                    file.close();
                    fs.unlink(destPath).catch(() => {});
                    reject(err);
                });
            }).on('error', (err) => {
                file.close();
                fs.unlink(destPath).catch(() => {});
                reject(err);
            });
        });
    }

    async calculateFileHash(filePath) {
        try {
            const data = await fs.readFile(filePath);
            return crypto.createHash('md5').update(data).digest('hex');
        } catch (error) {
            logger.error('Failed to calculate file hash:', error);
            return null;
        }
    }

    async fetchRemoteHash(url) {
        try {
            const response = await CoreUtils.httpRequest(url);
            return crypto.createHash('md5').update(response).digest('hex');
        } catch (error) {
            logger.warn('Failed to fetch remote hash for comparison:', error.message);
            return null;
        }
    }

    async cacheBackgroundFile(url) {
        try {
            const fileName = 'background' + path.extname(url.split('?')[0]);
            const destPath = path.join(CACHE_DIR, fileName);

            const remoteHash = await this.fetchRemoteHash(url);

            if (this.manifest.backgroundFileHash === remoteHash && await CoreUtils.fileExists(destPath)) {
                logger.info('Background file is up to date, using cache');
                return destPath;
            }

            logger.info('Downloading new background file...');
            await this.downloadFile(url, destPath);

            this.manifest.backgroundFile = destPath;
            this.manifest.backgroundFileHash = remoteHash;
            await this.saveManifest();

            logger.info('Background file cached successfully');
            return destPath;
        } catch (error) {
            logger.error('Failed to cache background file:', error);
            return null;
        }
    }

    async cacheSlogan(url) {
        try {
            const fileName = 'slogan' + path.extname(url.split('?')[0]);
            const destPath = path.join(CACHE_DIR, fileName);

            const remoteHash = await this.fetchRemoteHash(url);

            if (this.manifest.sloganHash === remoteHash && await CoreUtils.fileExists(destPath)) {
                logger.info('Slogan is up to date, using cache');
                return destPath;
            }

            logger.info('Downloading new slogan image...');
            await this.downloadFile(url, destPath);

            this.manifest.slogan = destPath;
            this.manifest.sloganHash = remoteHash;
            await this.saveManifest();

            logger.info('Slogan cached successfully');
            return destPath;
        } catch (error) {
            logger.error('Failed to cache slogan:', error);
            return null;
        }
    }

    async cacheSocialIcons(forceRedownload = false) {
        try {
            logger.info('Caching social icons from Kuro Games API...');
            logger.debug(`API URL: ${SOCIAL_ICONS_API}`);
            const results = {};

            const response = await CoreUtils.httpRequest(SOCIAL_ICONS_API);
            logger.debug(`API Response length: ${response.length}`);

            const apiData = JSON.parse(response);
            logger.debug(`Parsed API data: ${JSON.stringify(apiData).substring(0, 200)}...`);

            if (!apiData.data || !Array.isArray(apiData.data)) {
                logger.warn('Invalid social icons API response');
                return results;
            }

            logger.info(`Found ${apiData.data.length} social media entries`);

            const iconMap = {
                'Discord': 'discord',
                'twitter': 'x',
                'youtube': 'youtube'
            };

            for (const item of apiData.data) {
                const platformKey = iconMap[item.name];
                if (!platformKey) {
                    logger.debug(`Skipping ${item.name} - not in icon map`);
                    continue;
                }

                logger.info(`Processing ${platformKey} icon from ${item.icon}`);

                const fileExtension = path.extname(new URL(item.icon).pathname) || '.png';
                const fileName = `${platformKey}${fileExtension}`;
                const destPath = path.join(CACHE_DIR, fileName);

                if (!forceRedownload && await CoreUtils.fileExists(destPath)) {
                    logger.info(`Social icon ${platformKey} already cached at ${destPath}`);
                    results[platformKey] = destPath;
                    continue;
                }

                if (forceRedownload && await CoreUtils.fileExists(destPath)) {
                    try {
                        await fs.unlink(destPath);
                        logger.info(`Deleted old ${platformKey} icon for re-download`);
                    } catch (error) {
                        logger.warn(`Failed to delete old ${platformKey} icon:`, error.message);
                    }
                }

                try {
                    logger.info(`Downloading ${platformKey} icon to ${destPath}...`);
                    await this.downloadFile(item.icon, destPath);
                    results[platformKey] = destPath;
                    logger.info(`Successfully cached social icon: ${platformKey}`);
                } catch (error) {
                    logger.error(`Failed to cache ${platformKey} icon:`, error.message);
                }
            }

            this.manifest.socialIcons = results;
            await this.saveManifest();

            logger.info(`Social icons cached successfully. Cached: ${JSON.stringify(results)}`);
            return results;
        } catch (error) {
            logger.error('Failed to cache social icons:', error.stack || error);
            return {};
        }
    }

    async getCachedBackgroundFile() {
        if (this.manifest.backgroundFile && await CoreUtils.fileExists(this.manifest.backgroundFile)) {
            return this.manifest.backgroundFile;
        }
        return null;
    }

    async getCachedSlogan() {
        if (this.manifest.slogan && await CoreUtils.fileExists(this.manifest.slogan)) {
            return this.manifest.slogan;
        }
        return null;
    }

    async getCachedSocialIcon(platform) {
        const iconPath = this.manifest.socialIcons?.[platform];
        if (iconPath && await CoreUtils.fileExists(iconPath)) {
            return iconPath;
        }
        return null;
    }

    async cacheNewsBanners(newsData) {
        try {
            if (!newsData || !newsData.guidance || !newsData.guidance.slideshow) {
                logger.warn('Invalid news data for banner caching');
                return {};
            }

            logger.info('Caching news banners...');
            const results = {};
            const slideshow = newsData.guidance.slideshow;

            for (let i = 0; i < slideshow.length; i++) {
                const slide = slideshow[i];
                const fileExtension = path.extname(new URL(slide.url).pathname) || '.jpg';
                const fileName = `news-banner-${i}${fileExtension}`;
                const destPath = path.join(CACHE_DIR, fileName);

                if (await CoreUtils.fileExists(destPath)) {
                    logger.debug(`News banner ${i} already cached`);
                    results[i] = destPath;
                    continue;
                }

                try {
                    await this.downloadFile(slide.url, destPath);
                    results[i] = destPath;
                    logger.debug(`Cached news banner ${i}`);
                } catch (error) {
                    logger.warn(`Failed to cache news banner ${i}:`, error.message);
                }
            }

            this.manifest.newsBanners = results;
            this.manifest.newsData = newsData;
            this.manifest.newsDataTimestamp = Date.now();
            await this.saveManifest();

            logger.info('News banners cached successfully');
            return results;
        } catch (error) {
            logger.error('Failed to cache news banners:', error);
            return {};
        }
    }

    async getCachedNewsData() {
        const ONE_HOUR = 1000 * 60 * 60;
        const now = Date.now();

        if (this.manifest.newsData &&
            this.manifest.newsDataTimestamp &&
            (now - this.manifest.newsDataTimestamp) < ONE_HOUR) {

            const newsData = JSON.parse(JSON.stringify(this.manifest.newsData));

            if (newsData.guidance && newsData.guidance.slideshow && this.manifest.newsBanners) {
                for (let i = 0; i < newsData.guidance.slideshow.length; i++) {
                    if (this.manifest.newsBanners[i] && await CoreUtils.fileExists(this.manifest.newsBanners[i])) {
                        newsData.guidance.slideshow[i].cachedUrl = this.manifest.newsBanners[i];
                    }
                }
            }

            const REFRESH_THRESHOLD = 1000 * 60 * 45;
            if ((now - this.manifest.newsDataTimestamp) > REFRESH_THRESHOLD) {
                (async () => {
                    try {
                        await this.checkAndUpdateNewsData();
                    } catch (error) {
                        logger.warn('Background news update check failed:', error.message);
                    }
                })();
            }

            return newsData;
        }

        return null;
    }

    async checkAndUpdateNewsData() {
        try {
            logger.info('Checking news data for updates...');
            const result = await CoreUtils.fetchNewsData();

            if (result.success) {
                await this.cacheNewsBanners(result.data.data);
                logger.info('News data update check completed');
            }
        } catch (error) {
            logger.warn('Failed to check for news updates:', error.message);
        }
    }

    async updateAssets(remoteData) {
        try {
            logger.info('Updating cached assets...');

            const results = {
                backgroundFile: null,
                slogan: null,
                socialIcons: {}
            };

            if (remoteData.backgroundFile) {
                const cachedBg = await this.cacheBackgroundFile(remoteData.backgroundFile);
                if (cachedBg) results.backgroundFile = cachedBg;
            }

            if (remoteData.slogan) {
                const cachedSlogan = await this.cacheSlogan(remoteData.slogan);
                if (cachedSlogan) results.slogan = cachedSlogan;
            }

            results.socialIcons = await this.cacheSocialIcons();

            this.manifest.lastUpdated = Date.now();
            await this.saveManifest();

            logger.info('Asset cache updated successfully');
            return results;
        } catch (error) {
            logger.error('Failed to update assets:', error);
            return null;
        }
    }

    async checkAndUpdateAllAssets(wallpaperApiUrl) {
        try {
            logger.info('Checking all assets for updates...');

            const backgroundUpdatePromise = this.checkAndUpdateBackgroundAssets(wallpaperApiUrl);

            const socialIconsUpdatePromise = this.checkAndUpdateSocialIcons();

            await Promise.all([backgroundUpdatePromise, socialIconsUpdatePromise]);

            logger.info('All asset update checks completed');
        } catch (error) {
            logger.error('Failed to check for asset updates:', error);
        }
    }

    async checkAndUpdateBackgroundAssets(apiUrl) {
        try {
            const timestamp = Date.now();
            const urlWithTimestamp = `${apiUrl}?_t=${timestamp}`;

            const response = await CoreUtils.httpRequest(urlWithTimestamp);
            const wallpaperData = JSON.parse(response);

            await this.updateAssets({
                backgroundFile: wallpaperData.backgroundFile,
                slogan: wallpaperData.slogan
            });

            logger.info('Background assets update check completed');
        } catch (error) {
            logger.warn('Failed to check for background asset updates:', error.message);
        }
    }

    async checkAndUpdateSocialIcons() {
        try {
            const ONE_HOUR = 1000 * 60 * 60;
            const now = Date.now();

            if (this.manifest.socialIconsTimestamp &&
                (now - this.manifest.socialIconsTimestamp) < ONE_HOUR) {
                logger.debug('Social icons are up to date, skipping update check');
                return;
            }

            logger.info('Checking social icons for updates...');
            await this.cacheSocialIcons();
            this.manifest.socialIconsTimestamp = now;
            await this.saveManifest();

            logger.info('Social icons update check completed');
        } catch (error) {
            logger.warn('Failed to check for social icon updates:', error.message);
        }
    }

    async getInitialAssets(wallpaperApiUrl) {
        try {
            const cachedBg = await this.getCachedBackgroundFile();
            const cachedSlogan = await this.getCachedSlogan();

            if (cachedBg && cachedSlogan) {
                logger.info('Using cached assets for quick startup');

                if (wallpaperApiUrl) {
                    (async () => {
                        try {
                            await this.checkAndUpdateAllAssets(wallpaperApiUrl);
                        } catch (error) {
                            logger.warn('Background asset update check failed:', error.message);
                        }
                    })();
                }

                return {
                    backgroundFile: cachedBg,
                    slogan: cachedSlogan,
                    socialIcons: this.manifest.socialIcons || {},
                    fromCache: true
                };
            }

            return null;
        } catch (error) {
            logger.error('Failed to get cached assets:', error);
            return null;
        }
    }

    async clearCache() {
        try {
            logger.info('Clearing asset cache...');
            const files = await fs.readdir(CACHE_DIR);

            for (const file of files) {
                const filePath = path.join(CACHE_DIR, file);
                await fs.unlink(filePath);
            }

            this.manifest = {
                backgroundFile: null,
                slogan: null,
                backgroundFileHash: null,
                sloganHash: null,
                socialIcons: {},
                socialIconsTimestamp: null,
                newsBanners: {},
                newsData: null,
                newsDataTimestamp: null,
                lastUpdated: null
            };

            logger.info('Asset cache cleared');
            return true;
        } catch (error) {
            logger.error('Failed to clear asset cache:', error);
            return false;
        }
    }
}

const assetCache = new AssetCache();

module.exports = {
    AssetCache,
    assetCache,
    CACHE_DIR
};