import { state } from './state';
import { storage } from './storage';
import { setPreferredApi, clearTranslationCache, getCacheStats, getCachedTranslations, deleteCachedTranslation } from './translator';
import { clearLyricsCache } from './lyricsFetcher';
import { getCurrentTrackUri } from './trackCache';
import { injectStyles } from '../styles/main';
import { registerSettings } from './settings';
import { initConnectionIndicator, cleanupConnectionIndicator, getConnectionState, refreshConnection } from './connectivity';
import { startUpdateChecker, stopUpdateChecker, checkForUpdates, getUpdateInfo, VERSION, showPostUpdateChangelog } from './updater';


import { 
    translateCurrentLyrics, 
    removeTranslations, 
    handleTranslateToggle, 
    isSpicyLyricsOpen, 
    onSpicyLyricsOpen, 
    onSpicyLyricsClose,
    waitForLyricsAndTranslate,
    getLyricsFirstLineText,
    updateButtonState,
    setupKeyboardShortcut,
    setupViewModeObserver,
    cleanupCoreRuntime
} from './core';

const RUNTIME_KEY = '__spicyLyricTranslatorRuntime';

type RuntimeHandle = {
    version: string;
    cleanup: () => void;
};

function cleanupPreviousRuntime(): void {
    const previous = (window as any)[RUNTIME_KEY] as RuntimeHandle | undefined;
    if (previous?.cleanup) {
        try {
            previous.cleanup();
        } catch (e) {}
    }
    document.querySelectorAll('#TranslateToggle').forEach(button => button.remove());
}

export async function initialize(): Promise<void> {
    cleanupPreviousRuntime();

    while (typeof Spicetify === 'undefined' || !Spicetify.Platform) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    const cleanupHandlers: Array<() => void> = [];
    const runtime: RuntimeHandle = {
        version: VERSION,
        cleanup: () => {
            const handlers = cleanupHandlers.splice(0);
            for (const cleanup of handlers) {
                try {
                    cleanup();
                } catch (e) {}
            }
            cleanupCoreRuntime();
            cleanupConnectionIndicator();
            stopUpdateChecker();
            if ((window as any).SpicyLyricTranslator?.version === VERSION) {
                delete (window as any).SpicyLyricTranslator;
            }
        }
    };
    (window as any)[RUNTIME_KEY] = runtime;
    
    setPreferredApi(state.preferredApi, state.customApiUrl, {
        customApiKey: state.customApiKey,
        customApiFormat: state.customApiFormat,
        customApiModel: state.customApiModel,
        libreTranslateApiUrl: state.libreTranslateApiUrl,
        libreTranslateApiKey: state.libreTranslateApiKey,
        deeplApiKey: state.deeplApiKey,
        openaiApiKey: state.openaiApiKey,
        openaiModel: state.openaiModel,
        geminiApiKey: state.geminiApiKey,
        geminiModel: state.geminiModel,
        geminiTemperature: state.geminiTemperature
    });
    injectStyles();
    initConnectionIndicator();

    if (state.hideConnectionIndicator) {
        document.body.classList.add('slt-hide-connection-indicator');
    }
    
    await registerSettings();
    
    startUpdateChecker(30 * 60 * 1000);
    setupKeyboardShortcut();

    showPostUpdateChangelog().catch(() => {});
    
    let wasSpicyLyricsOpen = false;
    const observer = new MutationObserver((mutations) => {
        const isOpen = isSpicyLyricsOpen();
        if (isOpen && !wasSpicyLyricsOpen) {
            wasSpicyLyricsOpen = true;
            onSpicyLyricsOpen();
        } else if (!isOpen && wasSpicyLyricsOpen) {
            wasSpicyLyricsOpen = false;
            onSpicyLyricsClose();
        }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    cleanupHandlers.push(() => observer.disconnect());
    
    setupViewModeObserver();
    let lastPlayerTrackUri = getCurrentTrackUri();
    
    if (Spicetify.Player?.addEventListener) {
        const songChangeHandler = () => {
            const previousFirstLine = getLyricsFirstLineText();
            const previousTrackUri = lastPlayerTrackUri;
            lastPlayerTrackUri = getCurrentTrackUri();
            setTimeout(() => {
                lastPlayerTrackUri = getCurrentTrackUri();
            }, 1200);
            state.isTranslating = false;
            state.translatedLyrics.clear();
            state._translationsByIndex = undefined;
            state._qualityByIndex = undefined;
            state.detectedLanguage = null;
            state.lastTranslatedSongUri = null;
            clearLyricsCache();
            removeTranslations();
            
            if (state.isEnabled || state.autoTranslate) {
                if (!state.isEnabled) {
                    state.isEnabled = true;
                    storage.set('translation-enabled', 'true');
                    updateButtonState();
                }
                waitForLyricsAndTranslate(20, 800, previousFirstLine, previousTrackUri);
            }
        };
        Spicetify.Player.addEventListener('songchange', songChangeHandler);
        cleanupHandlers.push(() => {
            try {
                (Spicetify.Player as any)?.removeEventListener?.('songchange', songChangeHandler);
            } catch (e) {}
        });
    }
    
    (window as any).SpicyLyricTranslator = {
        enable: () => {
            state.isEnabled = true;
            storage.set('translation-enabled', 'true');
            translateCurrentLyrics();
        },
        disable: () => {
            state.isEnabled = false;
            storage.set('translation-enabled', 'false');
            removeTranslations();
        },
        toggle: () => {
            if (isSpicyLyricsOpen()) handleTranslateToggle();
        },
        setLanguage: (lang: string) => {
            state.targetLanguage = lang;
            storage.set('target-language', lang);
        },
        translate: translateCurrentLyrics,
        clearCache: clearTranslationCache,
        getCacheStats: getCacheStats,
        getCachedTranslations: getCachedTranslations,
        deleteCachedTranslation: deleteCachedTranslation,
        getState: () => ({ ...state }),
        checkForUpdates: () => checkForUpdates(true),
        getUpdateInfo: getUpdateInfo,
        version: VERSION,
        runtimeVersion: VERSION,
        connectivity: {
            getState: getConnectionState,
            refresh: refreshConnection
        }
    };
    
}
