import test from 'node:test';
import assert from 'node:assert/strict';
import type {
    fetchLyricsForTrackUri as FetchLyricsForTrackUri,
    clearLyricsCache as ClearLyricsCache
} from '../src/utils/lyricsFetcher';

const trackId = 'spotify-track-cache-test';
const trackUri = `spotify:track:${trackId}`;

(globalThis as any).window = {
    fetch: async () => {
        throw new Error('Spicy Lyrics API should not be fetched when cache has lyrics');
    }
};

function installSpicyLyricsCache(content: any, cacheVersion = 12): void {
    (globalThis as any).caches = {
        open: async (name: string) => {
            assert.equal(name, 'SpicyLyrics_LyricsStore');
            return {
                match: async (key: string) => {
                    assert.equal(key, `/${trackId}`);
                    return {
                        json: async () => ({
                            ExpiresAt: Date.now() + 60_000,
                            CacheVersion: cacheVersion,
                            Content: content
                        })
                    };
                }
            };
        }
    };
}

const {
    fetchLyricsForTrackUri,
    clearLyricsCache
} = require('../src/utils/lyricsFetcher') as {
    fetchLyricsForTrackUri: typeof FetchLyricsForTrackUri;
    clearLyricsCache: typeof ClearLyricsCache;
};

test('reads original lyrics from Spicy Lyrics Cache API when query capture is unavailable', async () => {
    clearLyricsCache();
    installSpicyLyricsCache({
        id: trackId,
        Type: 'Syllable',
        LanguageISO2: 'ja',
        Content: [
            {
                Type: 'Vocal',
                Lead: {
                    StartTime: 0,
                    EndTime: 1000,
                    Syllables: [
                        {
                            Text: '\u541b',
                            RomanizedText: 'kimi',
                            StartTime: 0,
                            EndTime: 300,
                            IsPartOfWord: false
                        },
                        {
                            Text: '\u306f',
                            RomanizedText: 'wa',
                            StartTime: 300,
                            EndTime: 500,
                            IsPartOfWord: false
                        },
                        {
                            Text: '\u4e16\u754c',
                            RomanizedText: 'sekai',
                            StartTime: 500,
                            EndTime: 1000,
                            IsPartOfWord: false
                        }
                    ]
                }
            }
        ]
    });

    const result = await fetchLyricsForTrackUri(trackUri);

    assert.deepEqual(result?.lines, ['\u541b \u306f \u4e16\u754c']);
    assert.equal(result?.lineData[0]?.romanizedText, 'kimi wa sekai');
    assert.equal(result?.language, 'ja');
});

test('preserves line-synced romanized text from Spicy Lyrics cache', async () => {
    clearLyricsCache();
    installSpicyLyricsCache({
        id: trackId,
        Type: 'Line',
        LanguageISO2: 'ja',
        Content: [
            {
                Type: 'Vocal',
                Text: '\u541b\u306f\u4e16\u754c',
                RomanizedText: 'kimi wa sekai',
                StartTime: 0,
                EndTime: 1000
            }
        ]
    });

    const result = await fetchLyricsForTrackUri(trackUri);

    assert.deepEqual(result?.lines, ['\u541b\u306f\u4e16\u754c']);
    assert.equal(result?.lineData[0]?.romanizedText, 'kimi wa sekai');
});

test('preserves static romanized text from Spicy Lyrics cache', async () => {
    clearLyricsCache();
    installSpicyLyricsCache({
        id: trackId,
        Type: 'Static',
        LanguageISO2: 'ja',
        Lines: [
            {
                Text: '\u541b\u306f\u4e16\u754c',
                RomanizedText: 'kimi wa sekai'
            }
        ]
    });

    const result = await fetchLyricsForTrackUri(trackUri);

    assert.deepEqual(result?.lines, ['\u541b\u306f\u4e16\u754c']);
    assert.equal(result?.lineData[0]?.romanizedText, 'kimi wa sekai');
});

test('reads Spicy Lyrics 6 transliterated syllable fields from cache version 13', async () => {
    clearLyricsCache();
    installSpicyLyricsCache({
        id: trackId,
        Type: 'Syllable',
        LanguageISO2: 'ja',
        Content: [
            {
                Type: 'Vocal',
                Lead: {
                    StartTime: 0,
                    EndTime: 1000,
                    Syllables: [
                        {
                            Text: '\u4eca\u65e5',
                            TransliteratedText: 'kyou',
                            StartTime: 0,
                            EndTime: 500,
                            IsPartOfWord: false
                        },
                        {
                            Text: '\u306f',
                            TransliteratedText: 'wa',
                            StartTime: 500,
                            EndTime: 1000,
                            IsPartOfWord: false
                        }
                    ]
                }
            }
        ]
    }, 13);

    const result = await fetchLyricsForTrackUri(trackUri);

    assert.deepEqual(result?.lines, ['\u4eca\u65e5 \u306f']);
    assert.equal(result?.lineData[0]?.romanizedText, 'kyou wa');
});

test('reads Spicy Lyrics 6 transliterated line fields from cache version 13', async () => {
    clearLyricsCache();
    installSpicyLyricsCache({
        id: trackId,
        Type: 'Line',
        LanguageISO2: 'ja',
        Content: [
            {
                Type: 'Vocal',
                Text: '\u4eca\u65e5\u306f',
                TransliteratedText: 'kyou wa',
                StartTime: 0,
                EndTime: 1000
            }
        ]
    }, 13);

    const result = await fetchLyricsForTrackUri(trackUri);

    assert.deepEqual(result?.lines, ['\u4eca\u65e5\u306f']);
    assert.equal(result?.lineData[0]?.romanizedText, 'kyou wa');
});
