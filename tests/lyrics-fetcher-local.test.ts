import test from 'node:test';
import assert from 'node:assert/strict';
import type {
    fetchLyricsForTrackUri as FetchLyricsForTrackUri,
    clearLyricsCache as ClearLyricsCache
} from '../src/utils/lyricsFetcher';

const trackUri = 'spotify:local:Artist:Album:Song:180';
let managerCalls = 0;

const localLyrics = {
    Type: 'Line',
    LanguageISO2: 'ja',
    HasTransliterations: true,
    Content: [
        {
            Type: 'Vocal',
            Text: '今日は',
            TransliteratedText: 'kyou wa',
            StartTime: 0,
            EndTime: 1200,
        },
        {
            Type: 'Vocal',
            Text: 'いい日だ',
            TransliteratedText: 'ii hi da',
            StartTime: 1200,
            EndTime: 2400,
        },
    ],
};

(globalThis as any).window = {
    fetch: async () => {
        throw new Error('Local Lyrics should be read before waiting for the remote lyrics request');
    },
};
(globalThis as any).SpicyLyrics = {
    db: {
        objectStores: {
            lyricsStore: {
                manager: {
                    get: async (uri: string) => {
                        managerCalls++;
                        assert.equal(uri, trackUri);
                        return localLyrics;
                    },
                },
            },
        },
    },
};

const { fetchLyricsForTrackUri, clearLyricsCache } = require('../src/utils/lyricsFetcher') as {
    fetchLyricsForTrackUri: typeof FetchLyricsForTrackUri;
    clearLyricsCache: typeof ClearLyricsCache;
};

test('reads complete Spicy Lyrics 6.3 Local Lyrics through the exposed manager without an 8-second wait', async () => {
    clearLyricsCache();
    const start = Date.now();
    const result = await fetchLyricsForTrackUri(trackUri);

    assert.ok(Date.now() - start < 1000);
    assert.equal(managerCalls, 1);
    assert.deepEqual(result?.lines, ['今日は', 'いい日だ']);
    assert.deepEqual(result?.lineData.map(line => line.romanizedText), ['kyou wa', 'ii hi da']);
    assert.equal(result?.language, 'ja');
});

test('reads production Local Lyrics from IndexedDB and parses TTML through the Spicy Lyrics endpoint', async () => {
    const productionTrackUri = 'spotify:track:uploaded-ttml-test';
    const rawTtml = '<tt xmlns="http://www.w3.org/ns/ttml"><body /></tt>';
    const requests: Array<{ url: string; init?: RequestInit }> = [];

    delete (globalThis as any).SpicyLyrics;
    clearLyricsCache();

    (globalThis as any).indexedDB = {
        open: (name: string) => {
            assert.equal(name, 'spicylyrics');
            const openRequest: any = {};
            const db: any = {
                objectStoreNames: { contains: (storeName: string) => storeName === 'lyricsStore' },
                close: () => {},
                transaction: (storeName: string, mode: string) => {
                    assert.equal(storeName, 'lyricsStore');
                    assert.equal(mode, 'readonly');
                    const transaction: any = {
                        objectStore: () => ({
                            get: (uri: string) => {
                                assert.equal(uri, productionTrackUri);
                                const request: any = { result: rawTtml };
                                queueMicrotask(() => {
                                    request.onsuccess?.();
                                    transaction.oncomplete?.();
                                });
                                return request;
                            },
                        }),
                    };
                    return transaction;
                },
            };
            openRequest.result = db;
            queueMicrotask(() => openRequest.onsuccess?.());
            return openRequest;
        },
    };

    (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        return new Response(JSON.stringify({
            queries: [{
                operationId: '0',
                result: {
                    httpStatus: 200,
                    format: 'json',
                    data: { Result: localLyrics },
                },
            }],
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    };

    const start = Date.now();
    const result = await fetchLyricsForTrackUri(productionTrackUri);

    assert.ok(Date.now() - start < 1000);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://api.spicylyrics.org/query');
    const body = JSON.parse(String(requests[0].init?.body));
    assert.equal(body.queries[0].operation, 'parseTTML');
    assert.equal(body.queries[0].variables.ttml, rawTtml);
    assert.deepEqual(result?.lines, ['今日は', 'いい日だ']);
});
