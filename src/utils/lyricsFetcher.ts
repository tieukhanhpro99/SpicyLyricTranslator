import { warn } from './debug';
import { normalizeLanguageCode } from './languageDetection';

const SPICY_API_HOST = 'api.spicylyrics.org';
const SPICY_QUERY_PATH = '/query';
const SPICY_LYRICS_CACHE_NAMES = ['SpicyLyrics_LyricsStore_g1', 'SpicyLyrics_LyricsStore'];
const SPICY_LYRICS_DB_NAME = 'spicylyrics';
const SPICY_LYRICS_DB_STORE = 'lyricsStore';
const SPICY_LYRICS_G1_CACHE_VERSION = 1;
const MAX_CAPTURE_CACHE_ENTRIES = 50;

interface SyllableData {
    Text: string;
    StartTime: number;
    EndTime: number;
    IsPartOfWord?: boolean;
    RomanizedText?: string;
    TransliteratedText?: string;
}

interface VocalGroup {
    Type: 'Vocal' | 'Instrumental';
    OppositeAligned?: boolean;
    Text?: string;
    RomanizedText?: string;
    TransliteratedText?: string;
    StartTime?: number;
    EndTime?: number;
    Lead?: {
        Text?: string;
        RomanizedText?: string;
        TransliteratedText?: string;
        Syllables: SyllableData[];
        StartTime: number;
        EndTime: number;
    };
    Background?: Array<{
        Syllables: SyllableData[];
        StartTime: number;
        EndTime: number;
    }>;
}

interface StaticLine {
    Text: string;
    RomanizedText?: string;
    TransliteratedText?: string;
}

interface LyricsData {
    Type: 'Static' | 'Line' | 'Syllable';
    Content?: VocalGroup[];
    Lines?: StaticLine[];
    Language?: string;
    LanguageISO2?: string;
    HasTransliterations?: boolean;
    id?: string;
    alternative_api?: boolean;
}

export interface WordTimingData {
    text: string;
    startTime: number;
    endTime: number;
    isPartOfWord: boolean;
}

export interface LyricLineData {
    text: string;
    startTime: number;
    endTime: number;
    isInstrumental: boolean;
    romanizedText?: string;

    words?: WordTimingData[];
}

interface QueryResult {
    data: any;
    httpStatus: number;
    format: 'text' | 'json';
}

interface QueryResponse {
    queries: Array<{
        operationId: string;
        result: QueryResult;
    }>;
}

interface SpicyLyricsCacheItem {
    ExpiresAt?: number;
    CacheVersion?: number;
    Content?: any;
    Value?: string;
}

type JSONPrimitive = string | number | boolean | null;
type JSONValue = JSONPrimitive | JSONValue[] | { [key: string]: JSONValue };

const captureCache = new Map<string, LyricsData>();
const localLyricsCaptureCache = new Map<string, LyricsData>();
let interceptorInstalled = false;

function getRomanizedText(value: { RomanizedText?: string; TransliteratedText?: string } | null | undefined): string | undefined {
    const text = value?.TransliteratedText ?? value?.RomanizedText;
    return typeof text === 'string' && text.trim() ? text.trim() : undefined;
}

function unpackSpicyLyricsPayload(packed: unknown): unknown | null {
    try {
        if (!Array.isArray(packed) || packed.length !== 2) return null;
        const valuesRaw = packed[0];
        const streamRaw = packed[1];
        if (!Array.isArray(valuesRaw) || !Array.isArray(streamRaw)) return null;
        if (valuesRaw.length > (1 << 22) || streamRaw.length > (1 << 24)) return null;

        for (const value of valuesRaw) {
            if (value === null) continue;
            const valueType = typeof value;
            if (valueType === 'string' || valueType === 'boolean') continue;
            if (valueType === 'number' && Number.isFinite(value)) continue;
            return null;
        }

        const values = valuesRaw as JSONPrimitive[];
        const stream = streamRaw as unknown[];
        let cursor = 0;
        const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype']);

        const readStream = (): unknown => {
            if (cursor >= stream.length) throw new Error('Unexpected end of packed lyrics stream');
            return stream[cursor++];
        };

        const resolvePointer = (ptr: unknown): JSONPrimitive => {
            if (typeof ptr !== 'number' || !Number.isInteger(ptr) || ptr < 0 || ptr >= values.length) {
                throw new Error('Invalid packed lyrics pointer');
            }
            return values[ptr];
        };

        const readKey = (): string => {
            const key = resolvePointer(readStream());
            if (typeof key !== 'string' || forbiddenKeys.has(key)) {
                throw new Error('Invalid packed lyrics key');
            }
            return key;
        };

        const readCount = (max: number): number => {
            const count = readStream();
            if (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || count > max) {
                throw new Error('Invalid packed lyrics count');
            }
            return count;
        };

        const safeSet = (obj: Record<string, JSONValue>, key: string, value: JSONValue): void => {
            Object.defineProperty(obj, key, {
                value,
                writable: true,
                enumerable: true,
                configurable: true,
            });
        };

        const decode = (depth: number): JSONValue => {
            if (depth > 512) throw new Error('Packed lyrics depth limit exceeded');
            const op = readStream();
            if (typeof op !== 'number' || !Number.isInteger(op)) {
                throw new Error('Invalid packed lyrics opcode');
            }
            if (op >= 0) return resolvePointer(op);

            switch (op) {
                case -1: {
                    const keyCount = readCount(1 << 16);
                    const keys = new Array<string>(keyCount);
                    for (let i = 0; i < keyCount; i++) keys[i] = readKey();
                    const obj: Record<string, JSONValue> = {};
                    for (let i = 0; i < keyCount; i++) safeSet(obj, keys[i], decode(depth + 1));
                    return obj;
                }
                case -2: {
                    const length = readCount(1 << 20);
                    const arr = new Array<JSONValue>(length);
                    for (let i = 0; i < length; i++) arr[i] = decode(depth + 1);
                    return arr;
                }
                case -3: {
                    const length = readCount(1 << 20);
                    const keyCount = readCount(1 << 16);
                    if (length * keyCount > (1 << 22)) throw new Error('Packed lyrics schema budget exceeded');
                    const keys = new Array<string>(keyCount);
                    for (let i = 0; i < keyCount; i++) keys[i] = readKey();
                    const arr = new Array<JSONValue>(length);
                    for (let i = 0; i < length; i++) {
                        const obj: Record<string, JSONValue> = {};
                        for (let k = 0; k < keyCount; k++) safeSet(obj, keys[k], decode(depth + 1));
                        arr[i] = obj;
                    }
                    return arr;
                }
                case -4:
                    return [];
                case -5:
                    return [decode(depth + 1)];
                case -6:
                    return {};
                default:
                    throw new Error('Unknown packed lyrics opcode');
            }
        };

        const result = decode(0);
        return cursor === stream.length ? result : null;
    } catch (err) {
        warn('Failed to unpack Spicy Lyrics payload:', err);
        return null;
    }
}

function setCaptureCache(trackId: string, data: LyricsData): void {
    if (captureCache.has(trackId)) {
        captureCache.delete(trackId);
    }
    captureCache.set(trackId, data);
    if (captureCache.size > MAX_CAPTURE_CACHE_ENTRIES) {
        const oldest = captureCache.keys().next().value;
        if (oldest !== undefined) {
            captureCache.delete(oldest);
        }
    }
}

function isLyricsData(obj: any): obj is LyricsData {
    if (!obj || typeof obj !== 'object') return false;
    if (typeof obj.Type === 'string' && (obj.Type === 'Static' || obj.Type === 'Line' || obj.Type === 'Syllable')) {
        return true;
    }
    if (Array.isArray(obj.Content) || Array.isArray(obj.Lines)) return true;
    return false;
}

function normalizeCapturedLyricsData(data: unknown): LyricsData | null {
    if (isLyricsData(data)) return data;

    if (typeof data === 'string') {
        try {
            return normalizeCapturedLyricsData(JSON.parse(data));
        } catch {
            return null;
        }
    }

    const unpacked = unpackSpicyLyricsPayload(data);
    return isLyricsData(unpacked) ? unpacked : null;
}

interface CaptureRequestContext {
    trackId: string | null;
    parseTtmlOperationIds: Set<string>;
}

function extractCaptureContextFromBody(bodyText: string | null | undefined): CaptureRequestContext {
    const context: CaptureRequestContext = {
        trackId: null,
        parseTtmlOperationIds: new Set<string>(),
    };
    if (!bodyText) return context;
    try {
        const parsed = JSON.parse(bodyText);
        const queries = parsed?.queries;
        if (!Array.isArray(queries)) return context;
        for (let i = 0; i < queries.length; i++) {
            const query = queries[i];
            if (query?.operation === 'lyrics') {
                const id = query?.variables?.id;
                if (typeof id === 'string' && id.length > 0) context.trackId = id;
            } else if (query?.operation === 'parseTTML') {
                context.parseTtmlOperationIds.add(String(i));
            }
        }
    } catch {}
    return context;
}

function processCapturedResponse(trackId: string, payload: QueryResponse): void {
    const queries = Array.isArray(payload?.queries) ? payload.queries : [];
    for (const q of queries) {
        const result = q?.result;
        if (!result || result.httpStatus !== 200) continue;

        const lyricsData = normalizeCapturedLyricsData(result.data);

        if (lyricsData) {
            setCaptureCache(trackId, lyricsData);
            return;
        }
    }
}

function processCapturedLocalLyrics(
    trackUri: string | null,
    operationIds: Set<string>,
    payload: QueryResponse
): void {
    if (!trackUri || operationIds.size === 0) return;

    const queries = Array.isArray(payload?.queries) ? payload.queries : [];
    for (const query of queries) {
        if (!operationIds.has(String(query?.operationId))) continue;
        const result = query?.result;
        if (!result || result.httpStatus !== 200) continue;

        const data = result.data?.Result ?? result.data?.result ?? result.data;
        const lyricsData = normalizeCapturedLyricsData(data);
        if (lyricsData) {
            localLyricsCaptureCache.set(trackUri, lyricsData);
            return;
        }
    }
}

async function readSpicyLyricsCache(trackId: string): Promise<LyricsData | null> {
    try {
        if (!trackId || typeof caches === 'undefined' || typeof caches.open !== 'function') {
            return null;
        }

        for (const cacheName of SPICY_LYRICS_CACHE_NAMES) {
            if (typeof caches.has === 'function' && !(await caches.has(cacheName))) {
                continue;
            }

            const cache = await caches.open(cacheName);
            const response = await cache.match(`/${trackId}`);
            if (!response || typeof response.json !== 'function') {
                continue;
            }

            const item = await response.json() as SpicyLyricsCacheItem | LyricsData;
            if (isLyricsData(item)) {
                return item;
            }

            if (!item || typeof item !== 'object' || item.Value === 'NO_LYRICS') {
                continue;
            }

            // Mirror Spicy Lyrics 6.3.x's g1 cache contract. Reading a stale
            // envelope that Spicy Lyrics itself rejects can feed us a shape from
            // an older schema and silently corrupt source-line alignment.
            if (
                cacheName === 'SpicyLyrics_LyricsStore_g1' &&
                typeof item.CacheVersion === 'number' &&
                item.CacheVersion !== SPICY_LYRICS_G1_CACHE_VERSION
            ) {
                continue;
            }

            if (typeof item.ExpiresAt === 'number' && item.ExpiresAt < Date.now()) {
                continue;
            }

            const content = item.Content;
            // Spicy Lyrics 6.x stores the no-lyrics sentinel as a plain string
            // (`Content: "NO_LYRICS"`), older versions used `{ Value: "NO_LYRICS" }`.
            if (content === 'NO_LYRICS' || content?.Value === 'NO_LYRICS' || !content) {
                continue;
            }

            const normalizedContent = normalizeCapturedLyricsData(content);
            if (normalizedContent) return normalizedContent;
        }

        return null;
    } catch (err) {
        warn('Failed to read Spicy Lyrics cache:', err);
        return null;
    }
}

async function getStoredLyricsData(trackId: string): Promise<LyricsData | null> {
    const captured = captureCache.get(trackId);
    if (captured) return captured;

    const cached = await readSpicyLyricsCache(trackId);
    if (cached) {
        setCaptureCache(trackId, cached);
        return cached;
    }

    return null;
}

function installFetchInterceptor(): void {
    if (interceptorInstalled) return;
    if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;
    interceptorInstalled = true;

    const origFetch = window.fetch.bind(window);

    window.fetch = async function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        let url: string;
        try {
            if (typeof input === 'string') url = input;
            else if (input instanceof URL) url = input.href;
            else url = (input as Request).url;
        } catch {
            return origFetch(input as any, init);
        }

        if (!url.includes(SPICY_API_HOST) || !url.includes(SPICY_QUERY_PATH)) {
            return origFetch(input as any, init);
        }

        let captureContext: CaptureRequestContext = {
            trackId: null,
            parseTtmlOperationIds: new Set<string>(),
        };
        try {
            if (typeof init?.body === 'string') {
                captureContext = extractCaptureContextFromBody(init.body);
            } else if (input instanceof Request) {
                const cloned = input.clone();
                const bodyText = await cloned.text();
                captureContext = extractCaptureContextFromBody(bodyText);
            }
        } catch {}

        // LocalLyricsManager resolves uploaded TTML through the same query API,
        // but the request has no Spotify id. Bind it to the URI that was current
        // when the request started so local tracks with equal durations cannot
        // collide in the Translator cache.
        const localTrackUri = captureContext.parseTtmlOperationIds.size > 0
            ? getCurrentTrackUri()
            : null;

        const response = await origFetch(input as any, init);

        if (captureContext.trackId || captureContext.parseTtmlOperationIds.size > 0) {
            const capturedTrackId = captureContext.trackId;
            const parseTtmlOperationIds = captureContext.parseTtmlOperationIds;
            response.clone().json().then((data: QueryResponse) => {
                if (capturedTrackId) processCapturedResponse(capturedTrackId, data);
                processCapturedLocalLyrics(localTrackUri, parseTtmlOperationIds, data);
            }).catch(() => {});
        }

        return response;
    };
}

installFetchInterceptor();

async function waitForCapture(trackId: string, timeoutMs: number = 8000, pollMs: number = 100): Promise<LyricsData | null> {
    const start = Date.now();
    let nextStoreCheck = 0;

    while (Date.now() - start < timeoutMs) {
        const cached = captureCache.get(trackId);
        if (cached) return cached;

        if (Date.now() >= nextStoreCheck) {
            const stored = await getStoredLyricsData(trackId);
            if (stored) return stored;
            nextStoreCheck = Date.now() + 500;
        }

        await new Promise(resolve => setTimeout(resolve, pollMs));
    }
    return getStoredLyricsData(trackId);
}

function getCurrentTrackId(): string | null {
    const uri = getCurrentTrackUri();
    if (uri) {
        const parts = uri.split(':');
        return parts[parts.length - 1] || null;
    }
    return null;
}

function getCurrentTrackUri(): string | null {
    try {
        const uri = (globalThis as any).Spicetify?.Player?.data?.item?.uri;
        if (uri && typeof uri === 'string') return uri;
    } catch (e) {}
    return null;
}

function getTrackIdFromUri(trackUri: string): string | null {
    if (!trackUri || typeof trackUri !== 'string') {
        return null;
    }

    const parts = trackUri.split(':');
    return parts[parts.length - 1] || null;
}

function normalizeLocalLyricsResult(value: unknown): LyricsData | null {
    if (!value || typeof value !== 'object') return normalizeCapturedLyricsData(value);
    const record = value as Record<string, unknown>;
    return normalizeCapturedLyricsData(record.Result ?? record.result ?? value);
}

async function getLocalLyricsFromPublicApi(trackUri: string): Promise<LyricsData | null> {
    try {
        const root = (globalThis as any).SpicyLyrics ??
            (typeof window !== 'undefined' ? (window as any).SpicyLyrics : undefined);
        const manager = root?.db?.objectStores?.lyricsStore?.manager;
        if (typeof manager?.get !== 'function') return null;
        return normalizeLocalLyricsResult(await manager.get(trackUri));
    } catch (err) {
        warn('Failed to read Local Lyrics through the Spicy Lyrics API:', err);
        return null;
    }
}

function readLocalTtmlFromIndexedDb(trackUri: string): Promise<string | null> {
    if (typeof indexedDB === 'undefined' || typeof indexedDB.open !== 'function') {
        return Promise.resolve(null);
    }

    return new Promise(resolve => {
        let settled = false;
        const finish = (value: string | null): void => {
            if (settled) return;
            settled = true;
            resolve(value);
        };

        try {
            const openRequest = indexedDB.open(SPICY_LYRICS_DB_NAME);
            openRequest.onupgradeneeded = () => {
                // Spicy Lyrics has not created its database yet. Abort so this
                // compatibility read never creates an empty lookalike database.
                try { openRequest.transaction?.abort(); } catch {}
                finish(null);
            };
            openRequest.onerror = () => finish(null);
            openRequest.onblocked = () => finish(null);
            openRequest.onsuccess = () => {
                const db = openRequest.result;
                if (!db.objectStoreNames.contains(SPICY_LYRICS_DB_STORE)) {
                    db.close();
                    finish(null);
                    return;
                }

                try {
                    const transaction = db.transaction(SPICY_LYRICS_DB_STORE, 'readonly');
                    const request = transaction.objectStore(SPICY_LYRICS_DB_STORE).get(trackUri);
                    request.onsuccess = () => {
                        const value = request.result;
                        finish(typeof value === 'string' && value.trim() ? value : null);
                    };
                    request.onerror = () => finish(null);
                    transaction.oncomplete = () => db.close();
                    transaction.onabort = () => {
                        db.close();
                        finish(null);
                    };
                    transaction.onerror = () => {
                        db.close();
                        finish(null);
                    };
                } catch {
                    db.close();
                    finish(null);
                }
            };
        } catch {
            finish(null);
        }
    });
}

function getSpicyLyricsVersionHint(): string {
    try {
        const metadataVersion = (globalThis as any)._spicy_lyrics_metadata?.LoadedVersion;
        if (typeof metadataVersion === 'string' && metadataVersion) return metadataVersion;
    } catch {}

    const readUiState = (raw: string | null | undefined): string | null => {
        if (!raw) return null;
        try {
            const parsed = JSON.parse(raw);
            for (const key of ['fromVersion', 'previousVersion']) {
                if (typeof parsed?.[key] === 'string' && parsed[key]) return parsed[key];
            }
        } catch {}
        return null;
    };

    try {
        const value = readUiState((globalThis as any).Spicetify?.LocalStorage?.get?.('SL:uiState'));
        if (value) return value;
    } catch {}
    try {
        const value = readUiState(localStorage.getItem('SL:uiState'));
        if (value) return value;
    } catch {}
    return '';
}

async function parseLocalTtmlWithSpicyApi(ttml: string): Promise<LyricsData | null> {
    try {
        const response = await fetch(`https://${SPICY_API_HOST}${SPICY_QUERY_PATH}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'SpicyLyrics-Version': getSpicyLyricsVersionHint(),
                'X-mode': '2',
            },
            body: JSON.stringify({
                queries: [{ operation: 'parseTTML', variables: { ttml } }],
                client: { version: getSpicyLyricsVersionHint() || 'unknown' },
            }),
        });
        if (!response.ok) return null;
        const payload = await response.json() as QueryResponse;
        const result = payload?.queries?.find(query => String(query.operationId) === '0')?.result;
        if (!result || result.httpStatus !== 200) return null;
        return normalizeLocalLyricsResult(result.data);
    } catch (err) {
        warn('Failed to parse Local Lyrics TTML through the Spicy Lyrics API:', err);
        return null;
    }
}

async function getLocalLyricsData(trackUri: string): Promise<LyricsData | null> {
    const captured = localLyricsCaptureCache.get(trackUri);
    if (captured) return captured;

    const exposed = await getLocalLyricsFromPublicApi(trackUri);
    if (exposed) {
        localLyricsCaptureCache.set(trackUri, exposed);
        return exposed;
    }

    const rawTtml = await readLocalTtmlFromIndexedDb(trackUri);
    if (!rawTtml) return null;

    const parsed = await parseLocalTtmlWithSpicyApi(rawTtml);
    if (parsed) localLyricsCaptureCache.set(trackUri, parsed);
    return parsed;
}

function extractContentLinesData(lyrics: LyricsData): LyricLineData[] {
    const lineData: LyricLineData[] = [];
    if (!lyrics.Content) return lineData;

    for (const group of lyrics.Content) {
        if (group.Type === 'Instrumental') {
            const st = group.Lead?.StartTime ?? group.StartTime ?? 0;
            const et = group.Lead?.EndTime ?? group.EndTime ?? 0;
            lineData.push({
                text: '',
                startTime: st,
                endTime: et,
                isInstrumental: true
            });
            continue;
        }

        if (group.Lead?.Syllables && group.Lead.Syllables.length > 0) {
            const wordTimings: WordTimingData[] = [];
            let lineText = '';
            let romanizedText = '';
            let anyRomanized = false;
            const syllables = group.Lead.Syllables;
            for (let i = 0; i < syllables.length; i++) {
                const syllable = syllables[i];
                wordTimings.push({
                    text: syllable.Text,
                    startTime: syllable.StartTime,
                    endTime: syllable.EndTime,
                    isPartOfWord: syllable.IsPartOfWord === true,
                });
                const romanSyl = getRomanizedText(syllable) ?? syllable.Text;
                if (romanSyl && romanSyl !== syllable.Text) {
                    anyRomanized = true;
                }
                if (syllable.IsPartOfWord === true) {
                    lineText += syllable.Text;
                    romanizedText += romanSyl;
                } else {
                    if (lineText.length > 0) lineText += ' ';
                    lineText += syllable.Text;
                    if (romanizedText.length > 0) romanizedText += ' ';
                    romanizedText += romanSyl;
                }
            }
            lineData.push({
                text: lineText.trim(),
                startTime: group.Lead.StartTime,
                endTime: group.Lead.EndTime,
                isInstrumental: false,
                romanizedText: anyRomanized ? romanizedText.replace(/\s+/g, ' ').trim() : undefined,
                words: wordTimings,
            });
            continue;
        }

        if (group.Text !== undefined && group.StartTime !== undefined && group.EndTime !== undefined) {
            lineData.push({
                text: String(group.Text).trim(),
                startTime: group.StartTime,
                endTime: group.EndTime,
                isInstrumental: false,
                romanizedText: getRomanizedText(group),
            });
            continue;
        }

        if (group.Lead) {
            const leadText = (group.Lead as any).Text;
            if (leadText !== undefined) {
                lineData.push({
                    text: String(leadText).trim(),
                    startTime: group.Lead.StartTime,
                    endTime: group.Lead.EndTime,
                    isInstrumental: false,
                    romanizedText: getRomanizedText(group.Lead),
                });
                continue;
            }
        }

    }

    return lineData;
}

function extractStaticLinesData(lyrics: LyricsData): LyricLineData[] {
    if (!lyrics.Lines) return [];
    return lyrics.Lines.map(line => ({
        text: line.Text?.trim() || '',
        startTime: 0,
        endTime: 0,
        isInstrumental: false,
        romanizedText: getRomanizedText(line),
    }));
}

function extractLinesData(lyrics: LyricsData): LyricLineData[] {
    switch (lyrics.Type) {
        case 'Syllable':
        case 'Line':
            return extractContentLinesData(lyrics);
        case 'Static':
            return extractStaticLinesData(lyrics);
        default:
            if (lyrics.Content && lyrics.Content.length > 0) {
                return extractContentLinesData(lyrics);
            }
            warn('Unknown lyrics type and no Content:', lyrics.Type, JSON.stringify(Object.keys(lyrics)));
            return [];
    }
}

let cachedTrackKey: string | null = null;
let cachedLineData: LyricLineData[] | null = null;
let cachedLanguage: string | null = null;

function getLyricsLanguage(lyrics: LyricsData): string | undefined {
    const iso = normalizeLanguageCode(lyrics.LanguageISO2);
    if (iso !== 'unknown' && iso !== 'auto') return iso;

    const language = normalizeLanguageCode(lyrics.Language);
    if (language !== 'unknown' && language !== 'auto') return language;

    return undefined;
}

export function getCachedLineData(): LyricLineData[] | null {
    return cachedLineData;
}

function cacheParsedLyrics(trackKey: string, lyrics: LyricsData): { lines: string[]; lineData: LyricLineData[]; language?: string } | null {
    const lineData = extractLinesData(lyrics);
    if (lineData.length === 0) {
        return null;
    }

    cachedTrackKey = trackKey;
    cachedLineData = lineData;
    cachedLanguage = getLyricsLanguage(lyrics) || null;

    return {
        lines: lineData.map(l => l.text),
        lineData,
        language: cachedLanguage || undefined
    };
}

export async function fetchLyricsFromAPI(): Promise<{ lines: string[]; lineData: LyricLineData[]; language?: string } | null> {
    const trackUri = getCurrentTrackUri();
    const trackId = getCurrentTrackId();
    if (!trackUri || !trackId) {
        return null;
    }

    if (trackUri === cachedTrackKey && cachedLineData) {
        return {
            lines: cachedLineData.map(l => l.text),
            lineData: cachedLineData,
            language: cachedLanguage || undefined
        };
    }

    try {
        const lyrics = await getLocalLyricsData(trackUri) ||
            await getStoredLyricsData(trackId) ||
            await waitForCapture(trackId);
        if (!lyrics) {
            return null;
        }

        return cacheParsedLyrics(trackUri, lyrics);
    } catch (err) {
        warn('Failed to capture lyrics from Spicy Lyrics fetch:', err);
        return null;
    }
}

export async function fetchLyricsForTrackUri(trackUri: string): Promise<{ lines: string[]; lineData: LyricLineData[]; language?: string } | null> {
    const trackId = getTrackIdFromUri(trackUri);
    if (!trackId) {
        return null;
    }

    if (trackUri === cachedTrackKey && cachedLineData) {
        return {
            lines: cachedLineData.map(l => l.text),
            lineData: cachedLineData,
            language: cachedLanguage || undefined
        };
    }

    try {
        const lyrics = await getLocalLyricsData(trackUri) ||
            await getStoredLyricsData(trackId) ||
            await waitForCapture(trackId);
        if (!lyrics) {
            return null;
        }

        return cacheParsedLyrics(trackUri, lyrics);
    } catch (err) {
        warn('Failed to capture lyrics for track URI:', trackUri, err);
        return null;
    }
}

export function clearLyricsCache(): void {
    cachedTrackKey = null;
    cachedLineData = null;
    cachedLanguage = null;
    captureCache.clear();
    localLyricsCaptureCache.clear();
}

export default {
    fetchLyricsFromAPI,
    fetchLyricsForTrackUri,
    clearLyricsCache,
    getCachedLineData,
};
