const SELECTORS = {
    APP_CONTAINER: '.app-container',
    BACKGROUND_CONTAINER: '#background-container',
    BETA_BUILD_INDICATOR: '#betaBuildIndicator',
    VIEWS: '.view',
    SIDEBAR: '.sidebar',
    NAV_ITEMS: '.sidebar .nav-item',
    START_GAME_BTN: '#startGameBtn',
    MINIMIZE_BTN: '#minimizeBtn',
    CLOSE_BTN: '#closeBtn',
    COMMUNITY_TOOLS_DROPDOWN: '#communityToolsDropdown',
    DOWNLOAD_PROGRESS_CONTAINER: '#downloadProgressContainer',
    DOWNLOAD_STATUS: '#downloadStatus',
    DOWNLOAD_PERCENTAGE: '#downloadPercentage',
    DOWNLOAD_FILL: '#downloadFill',
    DOWNLOAD_SPEED: '#downloadSpeed',
    DOWNLOAD_ETA: '#downloadEta',
    HOME_REPAIR_PROGRESS_CONTAINER: '#homeRepairProgressContainer',
    HOME_REPAIR_STATUS: '#homeRepairStatus',
    HOME_REPAIR_PERCENTAGE: '#homeRepairPercentage',
    HOME_REPAIR_FILL: '#homeRepairFill',
    HOME_REPAIR_SUB_STATUS: '#homeRepairSubStatus',
    REPAIR_VIEW: '#repairView',
    REPAIR_IDLE_CONTAINER: '#repairIdleContainer',
    REPAIR_PROGRESS_UI: '#repairProgressContainer',
    REPAIR_STATUS_TEXT: '#repairStatusText',
    REPAIR_SUB_STATUS_TEXT: '#repairSubStatusText',
    REPAIR_LOG: '#repairLog',
    REPAIR_FILES_CHECKED: '#filesChecked',
    REPAIR_FILES_TO_REPAIR: '#filesToRepair',
    REPAIR_CURRENT_FILE: '#currentFileAction',
    REPAIR_TOTAL_PROGRESS_BAR: '#totalProgress',
    REPAIR_TOTAL_PERCENTAGE: '#totalPercentage',
    REPAIR_CANCEL_BTN: '#cancelRepairBtn',
    REPAIR_COMPLETE_BTN: '#completeRepairBtn',
    INSTALLATION_MODAL: '#installationModal',
    ACTION_PROMPT_MODAL: '#actionPromptModal',
    LAUNCHER_UPDATE_MODAL: '#launcherUpdateModal',
    RESTART_UPDATE_MODAL: '#restartForUpdateModal',
    SETTINGS_VIEW: '#appSettingsView',
    WALLPAPER_PATH_DISPLAY: '#currentWallpaperPath',
    LAUNCHER_VERSION_DISPLAY: '#launcherVersionDisplay',
    START_ON_BOOT_CARD: '#startOnBootActionCard',
    PLAYTIME_DISPLAY: '#playtimeDisplay',
    PLAYTIME_TODAY: '#playtimeToday',
    PLAYTIME_WEEK: '#playtimeWeek',
    PLAYTIME_MONTH: '#playtimeMonth',
    PLAYTIME_TOTAL: '#playtimeTotal',
    AVERAGE_SESSION: '#averageSession',
    RECENT_SESSION: '#recentSessionDuration',
    HOME_LAYOUT: '.home-layout',
    NEWS_PANEL: '.news-panel',
    NEWS_BANNER_CONTAINER: '.news-banner-container',
    SLIDESHOW_CONTAINER: '.slideshow-container',
    SLIDESHOW_DOTS: '.slideshow-dots',
    NEWS_TABS: '.news-tab',
    NEWS_CONTENT_NOTICE: '#news-content-notice',
    NEWS_CONTENT_NEWS: '#news-content-news',
    UPDATE_TITLE_IMAGE: '.update-title-image',
};

const CLASSES = {
    ACTIVE: 'active',
    DISABLED: 'disabled',
    HIDDEN: 'hidden',
    SETTINGS_ACTIVE: 'settings-active'
};

const DURATION_FORMATS = {
    DEFAULT: 'default',
    SHORT: 'short',
    SHORT_SECONDS: 'short_seconds'
};

class LauncherUI {
    constructor() {
        this.state = {
            isGameRunning: false,
            isDownloading: false,
            isRepairing: false,
            isMoving: false,
            isVerifying: false,
            isUninstalling: false,
            isDownloadPaused: false,
            isUpdateAvailable: false,
            isPreparingDownload: false,
            isAwaitingRepairCompletion: false,
        };
        this.data = {
            settings: {},
            updateInfo: null,
            lastKnownTotalPlaytime: 0,
            lastValidatedCount: 0,
            remoteAssets: null,
            slideshow: {
                currentIndex: 0,
                timer: null
            }
        };
        this.timers = {
            playtimeUpdateInterval: null,
            sessionStartTime: 0,
        };
        this.elements = {};
        document.addEventListener('DOMContentLoaded', () => this.init());
    }

    async init() {
        console.log("🚀 Initializing Peebify Launcher UI...");
        document.body.style.opacity = '0';
        this.cacheDOMElements();

        if (this.elements.UPDATE_TITLE_IMAGE) {
            this.elements.UPDATE_TITLE_IMAGE.addEventListener('error', () => {
                this.elements.UPDATE_TITLE_IMAGE.style.display = 'none';
            });
        }

        this._checkForBetaBuild();
        try {
            this.data.settings = await window.api.invoke('get-launcher-settings');

            const initialDataResponse = await window.api.invoke('get-initial-data');
            if (initialDataResponse.success) {
                this.data.remoteAssets = initialDataResponse;

                if (this.data.remoteAssets.updateImage) {
                    if (this.data.remoteAssets.fromCache || this.data.remoteAssets.updateImage.includes('\\') || this.data.remoteAssets.updateImage.includes('C:')) {
                        this.elements.UPDATE_TITLE_IMAGE.src = `local-resource:///${this.data.remoteAssets.updateImage.replace(/\\/g, '/')}`;
                    } else {
                        this.elements.UPDATE_TITLE_IMAGE.src = this.data.remoteAssets.updateImage;
                    }
                }
            } else {
                console.warn('Could not fetch initial remote assets:', initialDataResponse.error);
            }

            this.setupEventListeners();
            this._setupCommunityTools();
            this._setupNewsPanel();
            await this._loadSocialIcons();
            this._applyAppearanceSettings();
            this._loadSettingsToUI();
            this.updateUI();
            console.log("✅ UI Initialized Successfully");
        } catch (error) {
            console.error("Fatal UI initialization failed:", error);
        }
    }

    cacheDOMElements() {
        for (const key in SELECTORS) {
            const selector = SELECTORS[key];
            this.elements[key] = document.querySelector(selector);
        }
    }

    setupEventListeners() {
        document.querySelectorAll(SELECTORS.NAV_ITEMS).forEach(item => {
            item.addEventListener('click', () => this._switchView(item));
        });
        this.elements.MINIMIZE_BTN?.addEventListener('click', () => window.api.invoke('minimize-window'));
        this.elements.CLOSE_BTN?.addEventListener('click', () => window.api.invoke('close-window'));
        document.querySelector('.socials-tray')?.addEventListener('click', (e) => {
            const socialItem = e.target.closest('.social-item');
            if (socialItem) {
                e.preventDefault();
                window.api.invoke('open-social-link', socialItem.dataset.platform);
            }
        });
        document.querySelectorAll('.dropdown-container').forEach(container => {
            container.querySelector('.action-btn')?.addEventListener('click', e => {
                e.stopPropagation();
                const isActive = container.classList.contains(CLASSES.ACTIVE);
                document.querySelectorAll('.dropdown-container').forEach(d => d.classList.remove(CLASSES.ACTIVE));
                if (!isActive) container.classList.add(CLASSES.ACTIVE);
            });
        });
        document.body.addEventListener('click', () =>
            document.querySelectorAll('.dropdown-container').forEach(d => d.classList.remove(CLASSES.ACTIVE))
        );
        document.body.addEventListener('click', e => {
            const actionTarget = e.target.closest('[data-action]');
            if (actionTarget) this.handleAction(actionTarget.dataset.action, actionTarget.dataset.url);
        });
        this._setupIPCListeners();
        this._setupSettingsListeners();
        this._setupRepairListeners();
        this._setupInstallationModalListeners();
    }

    updateUI() {
        this._updateStartButton();
        this._updateProgressDisplays();
        this._updateDisabledStates();
        this.refreshPlaytime();
    }

    async _checkForBetaBuild() {
        try {
            const { buildType } = await window.api.invoke('get-build-info');
            if (buildType === 'beta' && this.elements.BETA_BUILD_INDICATOR) {
                this.elements.BETA_BUILD_INDICATOR.classList.remove('hidden');
            }
        } catch (error) {
            console.error('Failed to check for beta build:', error);
        }
    }

    _switchView(activeItem) {
        document.querySelectorAll(SELECTORS.NAV_ITEMS).forEach(nav => nav.classList.remove(CLASSES.ACTIVE));
        activeItem.classList.add(CLASSES.ACTIVE);
        const viewId = activeItem.dataset.view;
        document.querySelectorAll(SELECTORS.VIEWS).forEach(view => view.classList.remove(CLASSES.ACTIVE));
        document.getElementById(viewId)?.classList.add(CLASSES.ACTIVE);
        const isSettingsView = ['appSettingsView', 'repairView'].includes(viewId);
        this.elements.SIDEBAR?.classList.toggle(CLASSES.SETTINGS_ACTIVE, isSettingsView);
        if (this.state.isAwaitingRepairCompletion && viewId !== 'repairView') {
            this._finishRepairProcess();
        }
    }

    _updateStartButton() {
        const btn = this.elements.START_GAME_BTN;
        if (!btn) return;
        const icon = btn.querySelector('i');
        const text = btn.querySelector('span');
        const spinner = btn.querySelector('.spinner');
        if (icon) icon.style.display = 'none';
        if (spinner) spinner.style.display = 'none';
        const buttonConfigs = [{
            condition: this.state.isPreparingDownload,
            icon: 'fas fa-hourglass-start',
            text: 'Preparing...',
            disabled: true,
        }, {
            condition: this.state.isMoving,
            icon: 'fas fa-truck',
            text: 'Moving...',
            disabled: true,
        }, {
            condition: this.state.isVerifying,
            icon: 'fas fa-shield-alt',
            text: 'Verifying...',
            disabled: true,
        }, {
            condition: this.state.isUninstalling,
            icon: 'fas fa-trash-alt',
            text: 'Uninstalling...',
            disabled: true,
        }, {
            condition: this.state.isRepairing || this.state.isAwaitingRepairCompletion,
            icon: 'fas fa-wrench',
            text: 'Repairing',
            disabled: true
        }, {
            condition: this.state.isDownloading && this.state.isDownloadPaused,
            icon: 'fas fa-play',
            text: 'Resume',
            onclick: () => this.handleAction('resume-download')
        }, {
            condition: this.state.isDownloading,
            icon: 'fas fa-pause',
            text: 'Pause',
            onclick: () => this.handleAction('pause-download')
        }, {
            condition: this.state.isGameRunning,
            icon: 'fas fa-gamepad',
            text: 'Running',
            disabled: true
        }, {
            condition: this.state.isUpdateAvailable,
            icon: 'fas fa-sync-alt',
            text: 'Update',
            onclick: () => this.handleAction('update-game')
        }, {
            condition: !this.data.settings.gamePath,
            icon: 'fas fa-download',
            text: 'Install',
            onclick: () => this.handleAction('install-game')
        }, {
            condition: true,
            icon: 'fas fa-play',
            text: 'Start',
            onclick: () => this.handleAction('launch-game')
        }];
        const config = buttonConfigs.find(c => c.condition);
        if (config) {
            if (config.spinner) {
                if (spinner) spinner.style.display = 'block';
            } else if (config.icon) {
                if (icon) {
                    icon.className = config.icon;
                    icon.style.display = 'inline-block';
                }
            }
            if (text) text.textContent = config.text;
            btn.onclick = config.onclick || null;
            btn.disabled = config.disabled || false;
        }
    }

    _updateProgressDisplays() {
        const repairContainer = this.elements.HOME_REPAIR_PROGRESS_CONTAINER;
        const homeLayout = this.elements.HOME_LAYOUT;

        const isDownloadVisible = (this.state.isDownloading || this.state.isVerifying || this.state.isPreparingDownload);
        this.elements.DOWNLOAD_PROGRESS_CONTAINER.style.display = isDownloadVisible ? 'flex' : 'none';

        let isRepairVisible = false;
        if (this.state.isRepairing || this.state.isAwaitingRepairCompletion) {
            repairContainer.style.display = 'flex';
            this._updateText(this.elements.HOME_REPAIR_STATUS, 'Repairing...');
            isRepairVisible = true;
        } else if (this.state.isMoving) {
            repairContainer.style.display = 'flex';
            this._updateText(this.elements.HOME_REPAIR_STATUS, 'Moving Game...');
            isRepairVisible = true;
        } else if (this.state.isUninstalling) {
            repairContainer.style.display = 'flex';
            this._updateText(this.elements.HOME_REPAIR_STATUS, 'Uninstalling...');
            isRepairVisible = true;
        } else {
            repairContainer.style.display = 'none';
        }

        homeLayout?.classList.toggle('progress-visible', isDownloadVisible || isRepairVisible);
    }

    _updateDisabledStates() {
        const gamePathSet = !!this.data.settings.gamePath;
        const isBusy = this.state.isDownloading || this.state.isRepairing || this.state.isVerifying || this.state.isAwaitingRepairCompletion || this.state.isPreparingDownload || this.state.isMoving || this.state.isUninstalling;
        const elementsToDisable = [
            ...document.querySelectorAll('[data-action="check-updates"], [data-action="open-game-folder"], [data-action="open-screenshot-folder"], [data-action="move-game-location"], [data-action="uninstall-game"], [data-action="force-close-game"]'),
            document.querySelector('#communityToolsBtn'),
            document.querySelector('#quickSettingsBtn'),
        ];
        elementsToDisable.forEach(el => {
            if (el) el.classList.toggle(CLASSES.DISABLED, !gamePathSet || isBusy);
        });
    }

    async _runPostLocationChangeFlow() {
        this.state.isVerifying = true;
        this.updateUI();

        const verificationResult = await window.api.invoke('verify-game-integrity');

        setTimeout(() => {
            this.state.isVerifying = false;
            this.updateUI();
        }, 2000);

        if (verificationResult.success) {
            const invalidCount = verificationResult.invalidFiles?.length || 0;
            if (invalidCount > 0) {
                this._showNotification('Verification Complete', `${invalidCount} corrupt file(s) found. An update is required to fix them.`);
            } else {
                this._showNotification('Verification Complete', 'All files are valid. Now checking for game updates.');
            }
            this.handleAction('check-for-updates');
        } else {
            this._showNotification('Verification Failed', verificationResult.error, 'error');
        }
    }

    async handleAction(action, url = null) {
        if (!action) return;
        const nonInterruptingActions = ['pause-download', 'resume-download'];
        if ((this.state.isDownloading || this.state.isRepairing || this.state.isVerifying || this.state.isPreparingDownload || this.state.isMoving || this.state.isUninstalling) && !nonInterruptingActions.includes(action)) {
            this._showNotification('Busy', 'An operation is currently in progress.');
            return;
        }
        const actionMap = {
            'launch-game': async () => {
                const result = await window.api.invoke('launch-game');
                if (!result.success) this._showNotification('Launch Error', result.error, 'error');
            },
            'install-game': () => this.elements.INSTALLATION_MODAL.classList.add(CLASSES.ACTIVE),
            'update-game': () => {
                this.state.isUpdateAvailable = false;
                this._startDownload(this.data.settings.gamePath, 'default', this.data.updateInfo?.currentVersion);
            },
            'check-updates': async () => {
                this._showNotification('Checking for Updates', 'Contacting server...');
                const result = await window.api.invoke('check-for-updates');
                if (result.success && !result.updateAvailable) {
                    this._showNotification('Up to Date', 'Your game is on the latest version.', 'success');
                } else if (!result.success) {
                    this._showNotification('Update Check Failed', result.error, 'error');
                }
            },
            'pause-download': () => {
                if ((this.state.isDownloading || this.state.isPreparingDownload) && !this.state.isDownloadPaused) {
                    this.state.isDownloadPaused = true;
                    this.updateUI();
                    window.api.invoke('pause-download');
                }
            },
            'resume-download': () => {
                if ((this.state.isDownloading || this.state.isPreparingDownload) && this.state.isDownloadPaused) {
                    this.state.isDownloadPaused = false;
                    this.updateUI();
                    window.api.invoke('resume-download');
                }
            },
            'uninstall-game': () => this._showActionPrompt({
                title: 'Uninstall Game?',
                message: 'This will delete all game files. This action is irreversible.',
                isDanger: true,
                confirmAction: async () => {
                    this.state.isUninstalling = true;
                    this.updateUI();

                    const result = await window.api.invoke('uninstall-game');

                    this.state.isUninstalling = false;

                    if (result.success) {
                        this.data.settings.gamePath = '';
                        this.state.isUpdateAvailable = false;
                        this.updateUI();
                        this._showNotification('Uninstalled', 'Game removed successfully.', 'success');
                    } else {
                        this.updateUI();
                        this._showNotification('Uninstall Failed', result.error, 'error');
                    }
                }
            }),
            'move-game-location': () => this._showActionPrompt({
                title: 'Move Game Location?',
                message: 'This will move the game to a new folder. This may take some time.',
                isDanger: false,
                confirmAction: async () => {
                    this.state.isMoving = true;
                    this.updateUI();

                    const result = await window.api.invoke('move-game-location');

                    this.state.isMoving = false;
                    this.updateUI();

                    if (result.success) {
                        this.data.settings.gamePath = result.newPath;
                        await this._runPostLocationChangeFlow();
                    } else if (result.error && !result.cancelled) {
                        this._showNotification('Move Failed', result.error, 'error');
                    }
                }
            }),
            'force-close-game': () => this._showActionPrompt({
                title: 'Force Close Game?',
                message: 'This will terminate the game process immediately. Only use this if the game is unresponsive.',
                confirmText: 'Force Close',
                isDanger: false,
                confirmAction: async () => {
                    const result = await window.api.invoke('force-close-game');
                    if (result.success) {
                        this._showNotification('Game Closed', 'The game process has been terminated.', 'success');
                    } else {
                        this._showNotification('Action Failed', result.error, 'error');
                    }
                }
            }),
            'change-install-location': () => this._showActionPrompt({
                title: 'Change Game Location?',
                message: 'Please select the folder containing "Wuthering Waves.exe". The launcher will verify the files.',
                isDanger: false,
                confirmText: 'Select Folder',
                confirmAction: async () => {
                    const result = await window.api.invoke('browse-game-path');
                    if (result.success) {
                        this.data.settings.gamePath = result.path;
                        await this._runPostLocationChangeFlow();
                    } else if (result.error && !result.cancelled) {
                        this._showNotification('Invalid Path', result.error, 'error');
                    }
                }
            }),
            'open-screenshot-folder': async () => {
                const result = await window.api.invoke('open-screenshot-folder');
                if (!result.success) {
                    if (result.error.includes('not found')) {
                        this._showNotification('Folder Not Found', 'Take a screenshot in-game first to create the folder.');
                    } else {
                        this._showNotification('Error', result.error, 'error');
                    }
                }
            },
            'open-external-url': () => window.api.invoke('open-external-url', url),
            'default': () => window.api.invoke(action)
        };
        const handler = actionMap[action] || actionMap['default'];
        try {
            await handler();
        } catch (error) {
            console.error(`Action '${action}' failed:`, error);
            this._showNotification('Action Failed', error.message, 'error');
        }
    }

    _startDownload(installPath = null, versionType = 'default', localVersion = null) {
        this.elements.INSTALLATION_MODAL?.classList.remove(CLASSES.ACTIVE);
        this.state.isDownloading = true;
        this.state.isDownloadPaused = false;
        this.state.isPreparingDownload = true;
        this.updateUI();
        window.api.invoke('start-download', {
            installPath,
            versionType,
            localVersion
        });
    }

    async _startRepair(type) {
        this.elements.REPAIR_LOG.value = '';
        this.data.lastValidatedCount = 0;
        this.state.isAwaitingRepairCompletion = false;
        this.state.isRepairing = true;
        this.elements.REPAIR_IDLE_CONTAINER.style.display = 'none';
        this.elements.REPAIR_PROGRESS_UI.style.display = 'block';
        this.elements.REPAIR_COMPLETE_BTN.style.display = 'none';
        this.elements.REPAIR_CANCEL_BTN.style.display = 'inline-flex';
        this._updateText(this.elements.REPAIR_STATUS_TEXT, 'Initializing...');
        this._updateText(this.elements.REPAIR_SUB_STATUS_TEXT, 'Please wait...');
        this.updateUI();
        const result = await window.api.invoke(type === 'quick' ? 'start-quick-repair' : 'start-repair');
        if (!result.success) {
            this._showNotification('Repair Failed', result.error, 'error');
            this.state.isRepairing = false;
            this.elements.REPAIR_IDLE_CONTAINER.style.display = 'flex';
            this.elements.REPAIR_PROGRESS_UI.style.display = 'none';
            this.updateUI();
        }
    }

    _finishRepairProcess() {
        this.state.isRepairing = false;
        this.state.isAwaitingRepairCompletion = false;
        this.elements.REPAIR_IDLE_CONTAINER.style.display = 'flex';
        this.elements.REPAIR_PROGRESS_UI.style.display = 'none';
        this.updateUI();
    }

    _setupIPCListeners() {
        const ipcEvents = {
            'game-started': () => {
                this.state.isGameRunning = true;
                this._startLivePlaytimeCounter();
                this.updateUI();
            },
            'game-stopped': () => {
                this.state.isGameRunning = false;
                this._stopLivePlaytimeCounter();
                this.updateUI();
            },
            'update-available': (info) => {
                this.data.updateInfo = info;
                this.state.isUpdateAvailable = info.updateAvailable;
                if (info.updateAvailable) {
                    this._showNotification('Update Available', `Version ${info.latestVersion} is ready to install.`);
                }
                this.updateUI();
            },
            'download-progress': (progress) => this.onDownloadProgress(progress),
            'repair-progress': (progress) => this.onRepairProgress(progress),
            'move-progress': (progress) => {
                if (!this.state.isMoving) {
                    this.state.isMoving = true;
                    this._updateProgressDisplays();
                }
                this._updateText(this.elements.HOME_REPAIR_STATUS, 'Moving Game...');
                this._updateText(this.elements.HOME_REPAIR_PERCENTAGE, `${Math.round(progress.percentage)}%`);
                this.elements.HOME_REPAIR_FILL.style.width = `${progress.percentage}%`;
                this._updateText(this.elements.HOME_REPAIR_SUB_STATUS, `${progress.file}`);
            },
            'uninstall-progress': (progress) => {
                if (!this.state.isUninstalling) {
                    this.state.isUninstalling = true;
                    this._updateProgressDisplays();
                }
                this._updateText(this.elements.HOME_REPAIR_STATUS, 'Uninstalling...');
                this._updateText(this.elements.HOME_REPAIR_PERCENTAGE, `${Math.round(progress.percentage)}%`);
                this.elements.HOME_REPAIR_FILL.style.width = `${progress.percentage}%`;
                this._updateText(this.elements.HOME_REPAIR_SUB_STATUS, `${progress.file}`);
            },
            'installation-complete': async () => {
                this._showNotification('Installation Complete', 'The game has been installed successfully.', 'success');
                this.data.settings = await window.api.invoke('get-launcher-settings');
                this.handleAction('check-for-updates');
                this.updateUI();
            },
            'game-path-updated': ({
                newPath
            }) => {
                this._showNotification('Move Complete', `Game successfully moved.`, 'success');
                this.data.settings.gamePath = newPath;
                this.updateUI();
            },
            'launcher-update-available': (info) => this.onLauncherUpdateAvailable(info),
            'launcher-up-to-date': () => this.onLauncherUpToDate(),
            'launcher-download-progress': (progress) => this.onLauncherDownloadProgress(progress),
            'launcher-update-ready': (version) => this.onLauncherUpdateReady(version),
        };
        for (const [event, handler] of Object.entries(ipcEvents)) {
            window.api.on(event, handler);
        }
    }

    onDownloadProgress(progress) {
        this.state.isPreparingDownload = false;

        const status = progress.status.toLowerCase();
        const isVerification = status.includes('verifying') || status.includes('integrity');
        const isFinished = ['completed', 'error', 'cancelled', 'verification complete', 'verification failed'].includes(status);

        if (isVerification) {
            this.state.isVerifying = !isFinished;
            this.state.isDownloading = false;
        } else {
            this.state.isDownloading = !isFinished;
            this.state.isVerifying = false;
        }

        if (status === 'paused') this.state.isDownloadPaused = true;
        if (isFinished) this.state.isDownloadPaused = false;

        this._updateText(this.elements.DOWNLOAD_STATUS, progress.status);
        this._updateText(this.elements.DOWNLOAD_PERCENTAGE, `${Math.floor(progress.percentage)}%`);
        this.elements.DOWNLOAD_FILL.style.width = `${progress.percentage}%`;

        if (isVerification) {
            this._updateText(this.elements.DOWNLOAD_SPEED, progress.currentFile || '...');
            this._updateText(this.elements.DOWNLOAD_ETA, `(${progress.processedFiles} / ${progress.totalFiles})`);
        } else {
            const speed = progress.speed ? (progress.speed / 1024 / 1024).toFixed(2) : '0.00';
            this._updateText(this.elements.DOWNLOAD_SPEED, `${speed} MB/s`);
            this._updateText(this.elements.DOWNLOAD_ETA, `ETA: ${progress.etaFormatted}`);
        }

        this.updateUI();
    }

    onRepairProgress(progress) {
        if (progress.logMessage && Object.keys(progress).length <= 2) {
            this._updateRepairLog(progress);
            return;
        }

        const isFinished = ['completed', 'cancelled', 'error'].includes(progress.status.toLowerCase());
        if (isFinished) {
            this._handleRepairCompletion(progress);
        } else {
            this.state.isRepairing = true;
            this.state.isAwaitingRepairCompletion = false;
            this._updateRepairUIData(progress);
        }
        this.updateUI();
    }

    _updateRepairUIData(progress) {
        const totalPercent = progress.totalFiles > 0 ? (progress.validatedFiles / progress.totalFiles) * 100 : 0;
        this._updateText(this.elements.HOME_REPAIR_STATUS, progress.status);
        this._updateText(this.elements.HOME_REPAIR_PERCENTAGE, `${Math.round(totalPercent)}%`);
        this.elements.HOME_REPAIR_FILL.style.width = `${totalPercent}%`;
        this._updateText(this.elements.HOME_REPAIR_SUB_STATUS, progress.currentFile || 'Please wait...');
        this._updateText(this.elements.REPAIR_STATUS_TEXT, progress.status);
        this._updateText(this.elements.REPAIR_SUB_STATUS_TEXT, `Checking file ${progress.validatedFiles || 0} of ${progress.totalFiles || 0}...`);
        this._updateText(this.elements.REPAIR_FILES_CHECKED, `${progress.validatedFiles || 0} / ${progress.totalFiles || 0}`);
        this._updateText(this.elements.REPAIR_FILES_TO_REPAIR, progress.filesToRepair || 0);
        this._updateText(this.elements.REPAIR_CURRENT_FILE, progress.currentFile || '---');
        this.elements.REPAIR_TOTAL_PROGRESS_BAR.value = totalPercent;
        this._updateText(this.elements.REPAIR_TOTAL_PERCENTAGE, `${Math.round(totalPercent)}%`);
        this._updateRepairLog(progress);
    }

    _updateRepairLog(progress) {
        const log = this.elements.REPAIR_LOG;
        if (!log) return;
        const append = (msg) => {
            log.value += msg + '\n';
            log.scrollTop = log.scrollHeight;
        };
        if (progress.logMessage) append(progress.logMessage);
        if (progress.logMessages) progress.logMessages.forEach(append);
    }

    _handleRepairCompletion(progress) {
        this.state.isRepairing = false;
        let finalMessage = '';
        let notificationType = 'info';
        const finalFileCount = progress.totalFiles || 0;
        this._updateText(this.elements.HOME_REPAIR_PERCENTAGE, '100%');
        this.elements.HOME_REPAIR_FILL.style.width = '100%';
        this._updateText(this.elements.REPAIR_FILES_CHECKED, `${finalFileCount} / ${finalFileCount}`);
        this.elements.REPAIR_TOTAL_PROGRESS_BAR.value = 100;
        this._updateText(this.elements.REPAIR_TOTAL_PERCENTAGE, '100%');
        if (progress.status.toLowerCase() === 'completed') {
            finalMessage = progress.message || 'All files have been successfully verified.';
            notificationType = 'success';
            this._updateText(this.elements.REPAIR_STATUS_TEXT, 'Repair Complete');
        } else if (progress.status.toLowerCase() === 'error') {
            finalMessage = progress.error || 'An unknown error occurred during the repair.';
            notificationType = 'error';
            this._updateText(this.elements.REPAIR_STATUS_TEXT, 'Repair Failed');
        } else {
            finalMessage = 'The repair process was cancelled by the user.';
            this._updateText(this.elements.REPAIR_STATUS_TEXT, 'Repair Cancelled');
        }
        this._showNotification(`Repair ${progress.status}`, finalMessage, notificationType);
        this._updateText(this.elements.REPAIR_SUB_STATUS_TEXT, finalMessage);
        if (this.elements.REPAIR_VIEW.classList.contains(CLASSES.ACTIVE)) {
            this.state.isAwaitingRepairCompletion = true;
            this.elements.REPAIR_COMPLETE_BTN.style.display = 'inline-flex';
            this.elements.REPAIR_CANCEL_BTN.style.display = 'none';
        } else {
            setTimeout(() => this._finishRepairProcess(), 2000);
        }
    }

    onLauncherUpdateAvailable(info) {
        this._showNotification('Update Available', `Launcher version ${info.version} is now available.`);
        this._showLauncherUpdateModal(info);
    }

    onLauncherUpToDate() {
        this._showNotification('Up to Date', 'Your launcher is on the latest version.', 'success');
    }

    onLauncherDownloadProgress(progress) {
        const statusContainer = document.querySelector('#launcherUpdateStatusContainer');
        if (statusContainer) {
            statusContainer.style.display = 'flex';
            this._updateText(statusContainer.querySelector('#launcherUpdateStatusText'), `Downloading: ${Math.round(progress.percent)}%`);
        }
    }

    onLauncherUpdateReady(version) {
        const statusContainer = document.querySelector('#launcherUpdateStatusContainer');
        if (statusContainer) {
            statusContainer.style.display = 'flex';
            this._updateText(statusContainer.querySelector('#launcherUpdateStatusText'), `Update v${version} ready. Restart to install.`);
            const installBtn = statusContainer.querySelector('#installUpdateBtn');
            if (installBtn) {
                installBtn.style.display = 'inline-flex';
                installBtn.onclick = () => window.api.invoke('restart-and-install-update');
            }
        }
        this._showRestartUpdateModal(version);
    }

    _setupSettingsListeners() {
        this.elements.SETTINGS_VIEW.querySelectorAll('.settings-nav-item').forEach(item => {
            item.addEventListener('click', () => {
                const category = item.dataset.category;
                this.elements.SETTINGS_VIEW.querySelectorAll('.settings-nav-item').forEach(nav => nav.classList.remove(CLASSES.ACTIVE));
                item.classList.add(CLASSES.ACTIVE);
                this.elements.SETTINGS_VIEW.querySelectorAll('.settings-category').forEach(cat => {
                    cat.classList.toggle(CLASSES.ACTIVE, cat.id === `settings-category-${category}`);
                });
            });
        });
        this.elements.SETTINGS_VIEW.addEventListener('click', e => {
            const segmentedButton = e.target.closest('.segmented-control button');
            if (segmentedButton) {
                const control = segmentedButton.parentElement;
                control.querySelectorAll('button').forEach(btn => btn.classList.remove(CLASSES.ACTIVE));
                segmentedButton.classList.add(CLASSES.ACTIVE);
                control.setAttribute('data-value', segmentedButton.dataset.value);
                this._saveSettingsFromUI();
            } else if (e.target.closest('#wipeDataBtn')) {
                this._showActionPrompt({
                    title: 'Wipe All Launcher Data?',
                    message: 'This will delete all settings and history. The launcher will restart.',
                    confirmAction: () => window.api.invoke('wipe-launcher-data')
                });
            } else if (e.target.closest('#selectWallpaperBtn')) {
                this._selectWallpaper();
            } else if (e.target.closest('#resetWallpaperBtn')) {
                this._resetWallpaper();
            } else if (e.target.closest('#openLogsBtn')) {
                window.api.invoke('open-logs-folder');
            } else if (e.target.closest('#checkLauncherUpdateBtn')) {
                window.api.invoke('check-for-launcher-update');
            }
        });
        document.querySelector('[data-setting="startOnBoot"]')?.addEventListener('click', () => this._updateDependentSettings());
    }

    _loadSettingsToUI() {
        if (!this.data.settings.behavior) return;
        const behavior = this.data.settings.behavior;
        document.querySelectorAll('.segmented-control[data-setting]').forEach(control => {
            const key = control.dataset.setting;
            const value = behavior[key];
            if (value !== undefined && value !== null) {
                const stringValue = String(value);
                control.setAttribute('data-value', stringValue);
                control.querySelectorAll('button').forEach(btn => {
                    btn.classList.toggle(CLASSES.ACTIVE, btn.dataset.value === stringValue);
                });
            }
        });
        window.api.invoke('get-app-version').then(result => {
            if (result.success) this._updateText(this.elements.LAUNCHER_VERSION_DISPLAY, `v${result.version}`);
        });
        this._updateDependentSettings();
    }

    async _saveSettingsFromUI() {
        const behavior = {};
        document.querySelectorAll('.segmented-control[data-setting]').forEach(el => {
            const key = el.dataset.setting;
            let value = el.getAttribute('data-value');
            if (value === 'true') {
                value = true;
            } else if (value === 'false') {
                value = false;
            }
            behavior[key] = value;
        });
        const result = await window.api.invoke('save-behavior-settings', behavior);
        if (result.success) {
            this.data.settings.behavior = behavior;
            this._applyAppearanceSettings();
            this._updateDependentSettings();
        } else {
            this._showNotification('Save Failed', result.error, 'error');
        }
    }

    _applyAppearanceSettings() {
        const behavior = this.data.settings.behavior || {};
        const appContainer = this.elements.APP_CONTAINER;
        appContainer.classList.toggle('invisible-sidebar-enabled', behavior.invisibleSidebar);
        appContainer.classList.toggle('corners-square', behavior.uiCornerRadius === 'square');
        const visibilityMap = {
            '.socials-tray': !behavior.hideSocials,
            '.bottom-right-actions': !behavior.hideBottomRightButtons,
            '.playtime-tracker': !behavior.hidePlaytime,
            '.update-title-image': !behavior.hideVersionTitle,
            '.news-panel': !behavior.hideNewsPanel,
        };
        for (const [selector, isVisible] of Object.entries(visibilityMap)) {
            document.querySelector(selector)?.classList.toggle(CLASSES.HIDDEN, !isVisible);
        }
        this._applyWallpaper();
    }

    _applyWallpaper() {
        const config = this.data.settings.wallpaper || { type: 'default', path: null };
        const container = this.elements.BACKGROUND_CONTAINER;
        const currentWallpaperSrc = container.dataset.wallpaperSrc;

        let newWallpaperSrc;
        if (config.type === 'custom' && config.path) {
            newWallpaperSrc = `file:///${config.path.replace(/\\/g, '/')}`;
        } else if (this.data.remoteAssets?.backgroundVideo) {
            if (this.data.remoteAssets.fromCache || this.data.remoteAssets.backgroundVideo.includes('\\') || this.data.remoteAssets.backgroundVideo.includes('C:')) {
                newWallpaperSrc = `local-resource:///${this.data.remoteAssets.backgroundVideo.replace(/\\/g, '/')}`;
            } else {
                newWallpaperSrc = this.data.remoteAssets.backgroundVideo;
            }
        } else {
            newWallpaperSrc = 'images/wallpaper.mp4';
        }

        if (currentWallpaperSrc === newWallpaperSrc) {
            if (parseFloat(document.body.style.opacity) !== 1) {
                document.body.style.transition = 'opacity 0.5s ease';
                document.body.style.opacity = '1';
            }
            return;
        }

        container.innerHTML = '';
        let element;

        const showBody = () => {
            clearTimeout(fallbackTimeout);
            if (parseFloat(document.body.style.opacity) !== 1) {
                document.body.style.transition = 'opacity 0.5s ease';
                document.body.style.opacity = '1';
            }
        };

        const fallbackTimeout = setTimeout(showBody, 3000);

        if (newWallpaperSrc.toLowerCase().endsWith('.mp4')) {
            element = document.createElement('video');
            element.autoplay = true;
            element.muted = true;
            element.loop = true;
            element.addEventListener('loadeddata', showBody);
            element.addEventListener('error', showBody);
        } else {
            element = document.createElement('img');
            element.addEventListener('load', showBody);
            element.addEventListener('error', showBody);
        }
        element.src = newWallpaperSrc;
        container.appendChild(element);
        container.dataset.wallpaperSrc = newWallpaperSrc;

        this._updateText(this.elements.WALLPAPER_PATH_DISPLAY, config.path || 'Default');
    }

    _updateDependentSettings() {
        const startOnBootEnabled = this.data.settings.behavior?.startOnBoot;
        this.elements.START_ON_BOOT_CARD?.classList.toggle(CLASSES.DISABLED, !startOnBootEnabled);
    }

    async _selectWallpaper() {
        const result = await window.api.invoke('select-wallpaper-file');
        if (result.success && result.path) {
            const newWallpaperSetting = {
                type: 'custom',
                path: result.path
            };
            await window.api.invoke('save-wallpaper', newWallpaperSetting);
            this.data.settings.wallpaper = newWallpaperSetting;
            this._applyWallpaper();

            if (this.data.settings.behavior) {
                this.data.settings.behavior.hideVersionTitle = true;
                await window.api.invoke('save-behavior-settings', this.data.settings.behavior);
                this._loadSettingsToUI();
                this._applyAppearanceSettings();
            }

            this._showNotification('Wallpaper Set', 'Background updated successfully.', 'success');
        }
    }

    async _resetWallpaper() {
        const newWallpaperSetting = {
            type: 'default',
            path: null
        };
        await window.api.invoke('save-wallpaper', newWallpaperSetting);
        this.data.settings.wallpaper = newWallpaperSetting;
        this._applyWallpaper();

        if (this.data.settings.behavior) {
            this.data.settings.behavior.hideVersionTitle = false;
            await window.api.invoke('save-behavior-settings', this.data.settings.behavior);
            this._loadSettingsToUI();
            this._applyAppearanceSettings();
        }

        this._showNotification('Wallpaper Reset', 'Background restored to default.', 'success');
    }

    _setupRepairListeners() {
        document.getElementById('startQuickRepairBtn')?.addEventListener('click', () => this._startRepair('quick'));
        document.getElementById('startFullRepairBtn')?.addEventListener('click', () => this._startRepair('full'));
        this.elements.REPAIR_CANCEL_BTN?.addEventListener('click', () => window.api.invoke('cancel-repair'));
        this.elements.REPAIR_COMPLETE_BTN?.addEventListener('click', () => this._finishRepairProcess());
    }

    _setupInstallationModalListeners() {
        document.getElementById('closeInstallationModalBtn')?.addEventListener('click', () => {
            this.elements.INSTALLATION_MODAL.classList.remove(CLASSES.ACTIVE);
        });
        document.getElementById('selectInstallDirBtn')?.addEventListener('click', async () => {
            const result = await window.api.invoke('select-install-directory');
            if (result && !result.canceled) this._startDownload(result.path);
        });
        document.getElementById('selectExistingPathBtn')?.addEventListener('click', async () => {
            this.elements.INSTALLATION_MODAL.classList.remove(CLASSES.ACTIVE);
            const result = await window.api.invoke('browse-game-path');
            if (result.success) {
                this.data.settings.gamePath = result.path;
                this.updateUI();
                this._showNotification('Game Path Set', 'Path validated successfully.', 'success');
            } else if (result.error && !result.cancelled) {
                this._showNotification('Invalid Path', result.error, 'error');
            }
        });
    }

    async _setupCommunityTools() {
        const dropdown = this.elements.COMMUNITY_TOOLS_DROPDOWN;
        if (!dropdown) return;
        try {
            const tools = await window.api.invoke('get-community-tools');
            dropdown.innerHTML = '';
            const createSection = (title, items) => {
                const sectionDiv = document.createElement('div');
                sectionDiv.className = 'dropdown-section';
                const titleDiv = document.createElement('div');
                titleDiv.className = 'dropdown-section-title';
                titleDiv.textContent = title;
                sectionDiv.appendChild(titleDiv);
                items.forEach(tool => {
                    const link = document.createElement('a');
                    link.className = 'dropdown-option';
                    link.dataset.action = 'open-external-url';
                    link.dataset.url = tool.url;
                    link.innerHTML = `<i class="${tool.icon}"></i><span>${tool.name}</span>`;
                    sectionDiv.appendChild(link);
                });
                return sectionDiv;
            };
            if (tools.official?.length) dropdown.appendChild(createSection('Official', tools.official));
            if (tools.community?.length) dropdown.appendChild(createSection('Community', tools.community));
        } catch (error) {
            console.error("Failed to setup community tools:", error);
            dropdown.innerHTML = '<div class="dropdown-option">Could not load tools.</div>';
        }
    }

    async _loadSocialIcons() {
        try {
            const platforms = ['discord', 'youtube', 'x'];

            for (const platform of platforms) {
                const result = await window.api.invoke('get-social-icon', platform);

                if (result.success && result.path) {
                    const iconElement = document.querySelector(`.social-item[data-platform="${platform}"] img`);
                    if (iconElement) {
                        const iconPath = result.path.replace(/\\/g, '/');
                        iconElement.src = `local-resource:///${iconPath}`;
                    }
                }
            }
        } catch (error) {
            console.error('Failed to load social icons:', error);
        }
    }

    async _setupNewsPanel() {
        const noticeContainer = this.elements.NEWS_CONTENT_NOTICE;
        const newsContainer = this.elements.NEWS_CONTENT_NEWS;
        const tabs = document.querySelectorAll(SELECTORS.NEWS_TABS);
        const newsPanel = this.elements.NEWS_PANEL;

        if (!newsPanel) return;

        const populate = (container, items) => {
            if (!items || !items.length) {
                container.innerHTML = '<p class="news-empty">No new announcements.</p>';
                return;
            }
            container.innerHTML = items.map(item => `
                <a href="#" class="news-item" data-url="${item.jumpUrl}">
                    <span class="news-item-title" title="${item.content}">${item.content}</span>
                    <span class="news-item-date">${item.time}</span>
                </a>
            `).join('');
        };

        try {
            const result = await window.api.invoke('get-news-data');
            if (result.success) {
                const {
                    notice,
                    news
                } = result.data.guidance;
                const slideshow = result.data.slideshow;

                populate(noticeContainer, notice.contents);
                populate(newsContainer, news.contents);

                this._setupSlideshow(slideshow);
            } else {
                throw new Error(result.error);
            }
        } catch (error) {
            console.error('Failed to load news:', error);
            noticeContainer.innerHTML = '<p class="news-empty">Could not load content.</p>';
            newsContainer.innerHTML = '<p class="news-empty">Could not load content.</p>';
        }

        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                tabs.forEach(t => t.classList.remove(CLASSES.ACTIVE));
                tab.classList.add(CLASSES.ACTIVE);

                const tabType = tab.dataset.tab;
                document.querySelectorAll('.news-content').forEach(content => {
                    content.classList.toggle(CLASSES.ACTIVE, content.id === `news-content-${tabType}`);
                });
            });
        });

        newsPanel.addEventListener('click', (e) => {
            const targetLink = e.target.closest('a[data-url]');
            if (targetLink) {
                e.preventDefault();
                const url = targetLink.dataset.url;
                if (url) {
                    window.api.invoke('open-external-url', url);
                }
            }
        });
    }

    _setupSlideshow(slides) {
        const container = this.elements.SLIDESHOW_CONTAINER;
        const dotsContainer = this.elements.SLIDESHOW_DOTS;

        if (!container || !dotsContainer || !slides || slides.length === 0) return;

        container.innerHTML = slides.map(slide => {
            let imageUrl = slide.url;
            if (slide.cachedUrl) {
                imageUrl = `local-resource:///${slide.cachedUrl.replace(/\\/g, '/')}`;
            }
            return `
                <div class="slide">
                    <a href="#" data-url="${slide.jumpUrl}">
                        <img src="${imageUrl}" alt="${slide.carouselNotes || 'Banner'}">
                    </a>
                </div>
            `;
        }).join('');

        dotsContainer.innerHTML = slides.map((_, i) => `<div class="dot" data-index="${i}"></div>`).join('');

        this.data.slideshow.slides = slides;
        this.data.slideshow.slideElements = container.querySelectorAll('.slide');
        this.data.slideshow.dotElements = dotsContainer.querySelectorAll('.dot');

        this._showSlide(0);
        this._startSlideshow();

        dotsContainer.addEventListener('click', e => {
            if (e.target.classList.contains('dot')) {
                const index = parseInt(e.target.dataset.index);
                this._showSlide(index);
                this._resetSlideshowTimer();
            }
        });
    }

    _showSlide(index) {
        const {
            slideshow
        } = this.data;
        slideshow.currentIndex = index;

        const offset = -index * 100;
        this.elements.SLIDESHOW_CONTAINER.style.transform = `translateX(${offset}%)`;

        slideshow.dotElements.forEach((dot, i) => {
            dot.classList.toggle(CLASSES.ACTIVE, i === index);
        });
    }

    _startSlideshow() {
        this.data.slideshow.timer = setInterval(() => {
            const {
                slideshow
            } = this.data;
            let nextIndex = slideshow.currentIndex + 1;
            if (nextIndex >= slideshow.slides.length) {
                nextIndex = 0;
            }
            this._showSlide(nextIndex);
        }, 5000);
    }

    _resetSlideshowTimer() {
        clearInterval(this.data.slideshow.timer);
        this._startSlideshow();
    }

    async refreshPlaytime() {
        const result = await window.api.invoke('get-playtime-statistics');
        if (!result.success) return;
        const {
            total,
            today,
            week,
            month,
            mostRecentSession,
            averageSession
        } = result.statistics;
        this.data.lastKnownTotalPlaytime = total;
        if (!this.state.isGameRunning) {
            this._updateText(this.elements.PLAYTIME_DISPLAY, this._formatDuration(total, DURATION_FORMATS.SHORT_SECONDS));
        }
        this._updateText(this.elements.PLAYTIME_TODAY, this._formatDuration(today));
        this._updateText(this.elements.PLAYTIME_WEEK, this._formatDuration(week));
        this._updateText(this.elements.PLAYTIME_MONTH, this._formatDuration(month));
        this._updateText(this.elements.PLAYTIME_TOTAL, this._formatDuration(total));
        this._updateText(this.elements.AVERAGE_SESSION, this._formatDuration(averageSession));
        this._updateText(this.elements.RECENT_SESSION, mostRecentSession?.startTime ? new Date(mostRecentSession.startTime).toLocaleDateString() : 'N/A');
    }

    _startLivePlaytimeCounter() {
        if (this.timers.playtimeUpdateInterval) clearInterval(this.timers.playtimeUpdateInterval);
        this.timers.sessionStartTime = Date.now();
        this.timers.playtimeUpdateInterval = setInterval(() => {
            const elapsed = Date.now() - this.timers.sessionStartTime;
            const liveTotal = this.data.lastKnownTotalPlaytime + elapsed;
            this._updateText(this.elements.PLAYTIME_DISPLAY, this._formatDuration(liveTotal, DURATION_FORMATS.SHORT_SECONDS));
        }, 1000);
    }

    _stopLivePlaytimeCounter() {
        clearInterval(this.timers.playtimeUpdateInterval);
        this.timers.playtimeUpdateInterval = null;
        this.refreshPlaytime();
    }

    _showLauncherUpdateModal(info) {
        const modal = this.elements.LAUNCHER_UPDATE_MODAL;
        if (!modal) return;
        modal.querySelector('#updateAvailableMessage').textContent = `Launcher v${info.version} is available.`;
        const downloadBtn = modal.querySelector('#downloadUpdateBtn');
        const laterBtn = modal.querySelector('#updateLaterBtn');
        const newDownloadBtn = downloadBtn.cloneNode(true);
        downloadBtn.parentNode.replaceChild(newDownloadBtn, downloadBtn);
        newDownloadBtn.addEventListener('click', () => {
            window.api.invoke('download-launcher-update');
            modal.classList.remove(CLASSES.ACTIVE);
            this._showLauncherUpdateProgress();
        }, {
            once: true
        });
        laterBtn.onclick = () => modal.classList.remove(CLASSES.ACTIVE);
        modal.classList.add(CLASSES.ACTIVE);
    }

    _showLauncherUpdateProgress() {
        const statusContainer = document.querySelector('#launcherUpdateStatusContainer');
        if (statusContainer) {
            statusContainer.style.display = 'flex';
            this._updateText(statusContainer.querySelector('#launcherUpdateStatusText'), 'Downloading: 0%');
            const installBtn = statusContainer.querySelector('#installUpdateBtn');
            if (installBtn) installBtn.style.display = 'none';
        }
    }

    _showRestartUpdateModal(version) {
        const modal = this.elements.RESTART_UPDATE_MODAL;
        if (!modal) return;
        modal.querySelector('#restartUpdateMessage').textContent = `Update v${version} has been downloaded. Restart now to apply it.`;
        const restartNowBtn = modal.querySelector('#restartNowBtn');
        const restartLaterBtn = modal.querySelector('#restartLaterBtn');
        restartNowBtn.onclick = () => window.api.invoke('restart-and-install-update');
        restartLaterBtn.onclick = () => modal.classList.remove(CLASSES.ACTIVE);
        modal.classList.add(CLASSES.ACTIVE);
    }

    _showNotification(title, body, type = 'info') {
        window.api.invoke('show-notification', {
            title,
            body,
            type
        });
    }

    _showActionPrompt({
        title,
        message,
        confirmText = 'Confirm',
        confirmAction,
        isDanger = true
    }) {
        const modal = this.elements.ACTION_PROMPT_MODAL;
        const confirmBtn = modal.querySelector('#promptConfirmBtn');
        const cancelBtn = modal.querySelector('#promptCancelBtn');
        modal.querySelector('#promptTitle').textContent = title;
        modal.querySelector('#promptMessage').textContent = message;
        confirmBtn.textContent = confirmText;
        confirmBtn.classList.toggle('danger', isDanger);
        const newConfirmBtn = confirmBtn.cloneNode(true);
        confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);
        const closePrompt = () => modal.classList.remove(CLASSES.ACTIVE);
        newConfirmBtn.addEventListener('click', () => {
            if (confirmAction) confirmAction();
            closePrompt();
        }, {
            once: true
        });
        cancelBtn.onclick = closePrompt;
        modal.classList.add(CLASSES.ACTIVE);
    }

    _updateText(element, text) {
        if (element && text !== undefined && text !== null) {
            element.textContent = text;
        }
    }

    _formatDuration(ms, format = DURATION_FORMATS.DEFAULT) {
        if (isNaN(ms) || ms < 0) ms = 0;
        const totalSeconds = Math.floor(ms / 1000);
        const totalHours = Math.floor(totalSeconds / 3600);
        const days = Math.floor(totalHours / 24);
        const hoursPart = totalHours % 24;
        const displayMinutes = Math.floor((totalSeconds % 3600) / 60);
        const displaySeconds = totalSeconds % 60;
        switch (format) {
            case DURATION_FORMATS.SHORT_SECONDS:
                return `${totalHours}h ${displayMinutes}m ${displaySeconds}s`;
            case DURATION_FORMATS.SHORT:
                return `${totalHours}h ${displayMinutes}m`;
            default:
                return days > 0 ? `${days}d ${hoursPart}h` : `${totalHours}h ${displayMinutes}m`;
        }
    }
}
new LauncherUI();