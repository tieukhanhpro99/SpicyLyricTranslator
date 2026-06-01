import { warn } from './debug';
import { normalizeLanguageCode } from './languageDetection';

const SPICY_API_HOST = 'api.spicylyrics.org';
const SPICY_QUERY_PATH = '/query';
const SPICY_LYRICS_CACHE_NAME = 'SpicyLyrics_LyricsStore';
const SPICY_LYRICS_CACHE_VERSION = 13;
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

function extractTrackIdFromBody(bodyText: string | null | undefined): string | null {
    if (!bodyText) return null;
    try {
        const parsed = JSON.parse(bodyText);
        const queries = parsed?.queries;
        if (!Array.isArray(queries)) return null;
        for (const q of queries) {
            const id = q?.variables?.id;
            if (typeof id === 'string' && id.length > 0) return id;
        }
    } catch {}
    return null;
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

async function readSpicyLyricsCache(trackId: string): Promise<LyricsData | null> {
    try {
        if (!trackId || typeof caches === 'undefined' || typeof caches.open !== 'function') {
            return null;
        }

        const cache = await caches.open(SPICY_LYRICS_CACHE_NAME);
        const response = await cache.match(`/${trackId}`);
        if (!response || typeof response.json !== 'function') {
            return null;
        }

        const item = await response.json() as SpicyLyricsCacheItem | LyricsData;
        if (isLyricsData(item)) {
            return item;
        }

        if (!item || typeof item !== 'object' || item.Value === 'NO_LYRICS') {
            return null;
        }

        if (typeof item.ExpiresAt === 'number' && item.ExpiresAt < Date.now()) {
            return null;
        }

        const content = item.Content;
        if (!content || content.Value === 'NO_LYRICS') {
            return null;
        }

        return normalizeCapturedLyricsData(content);
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

        let trackId: string | null = null;
        try {
            if (typeof init?.body === 'string') {
                trackId = extractTrackIdFromBody(init.body);
            } else if (input instanceof Request) {
                const cloned = input.clone();
                const bodyText = await cloned.text();
                trackId = extractTrackIdFromBody(bodyText);
            }
        } catch {}

        const response = await origFetch(input as any, init);

        if (trackId) {
            const capturedTrackId = trackId;
            response.clone().json().then((data: QueryResponse) => {
                processCapturedResponse(capturedTrackId, data);
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
    try {
        const uri = (globalThis as any).Spicetify?.Player?.data?.item?.uri;
        if (uri && typeof uri === 'string') {
            const parts = uri.split(':');
            return parts[parts.length - 1] || null;
        }
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
            for (const syllable of group.Lead.Syllables) {
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

let cachedTrackId: string | null = null;
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

function cacheParsedLyrics(trackId: string, lyrics: LyricsData): { lines: string[]; lineData: LyricLineData[]; language?: string } | null {
    const lineData = extractLinesData(lyrics);
    if (lineData.length === 0) {
        return null;
    }

    cachedTrackId = trackId;
    cachedLineData = lineData;
    cachedLanguage = getLyricsLanguage(lyrics) || null;

    return {
        lines: lineData.map(l => l.text),
        lineData,
        language: cachedLanguage || undefined
    };
}

export async function fetchLyricsFromAPI(): Promise<{ lines: string[]; lineData: LyricLineData[]; language?: string } | null> {
    const trackId = getCurrentTrackId();
    if (!trackId) {
        return null;
    }

    if (trackId === cachedTrackId && cachedLineData) {
        return {
            lines: cachedLineData.map(l => l.text),
            lineData: cachedLineData,
            language: cachedLanguage || undefined
        };
    }

    try {
        const lyrics = await getStoredLyricsData(trackId) || await waitForCapture(trackId);
        if (!lyrics) {
            return null;
        }

        return cacheParsedLyrics(trackId, lyrics);
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

    if (trackId === cachedTrackId && cachedLineData) {
        return {
            lines: cachedLineData.map(l => l.text),
            lineData: cachedLineData,
            language: cachedLanguage || undefined
        };
    }

    try {
        const lyrics = await getStoredLyricsData(trackId) || await waitForCapture(trackId);
        if (!lyrics) {
            return null;
        }

        return cacheParsedLyrics(trackId, lyrics);
    } catch (err) {
        warn('Failed to capture lyrics for track URI:', trackUri, err);
        return null;
    }
}


export function clearLyricsCache(): void {
    cachedTrackId = null;
    cachedLineData = null;
    cachedLanguage = null;
    captureCache.clear();
}

export default {
    fetchLyricsFromAPI,
    fetchLyricsForTrackUri,
    clearLyricsCache,
    getCachedLineData,
};
