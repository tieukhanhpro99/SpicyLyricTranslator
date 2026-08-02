import type { LyricLineData } from './lyricsFetcher';

const KANA_OR_KANJI_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/u;
const KANA_RE = /[\u3040-\u30ff]/u;
const LATIN_RE = /\p{Script=Latin}/u;

type KuromojiToken = {
    surface_form?: string;
    reading?: string;
    pronunciation?: string;
    pos?: string;
};

type KuromojiTokenizer = {
    tokenize(text: string): KuromojiToken[];
};

type KuromojiLibrary = {
    builder(options: { dicPath: string }): {
        build(callback: (error: unknown, tokenizer: KuromojiTokenizer) => void): void;
    };
};

let tokenizerPromise: Promise<KuromojiTokenizer | null> | null = null;

export function containsJapaneseScript(text: string | null | undefined): boolean {
    return KANA_OR_KANJI_RE.test(text || '');
}

const basicKana: Record<string, string> = {
    あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o',
    か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko',
    さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so',
    た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to',
    な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no',
    は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho',
    ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo',
    や: 'ya', ゆ: 'yu', よ: 'yo',
    ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro',
    わ: 'wa', ゐ: 'i', ゑ: 'e', を: 'o', ん: 'n',
    が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go',
    ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo',
    だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do',
    ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo',
    ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po',
    ゔ: 'vu',
    ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o',
    ゃ: 'ya', ゅ: 'yu', ょ: 'yo', ゎ: 'wa',
};

const compoundKana: Record<string, string> = {
    きゃ: 'kya', きゅ: 'kyu', きょ: 'kyo',
    しゃ: 'sha', しゅ: 'shu', しょ: 'sho',
    ちゃ: 'cha', ちゅ: 'chu', ちょ: 'cho',
    にゃ: 'nya', にゅ: 'nyu', にょ: 'nyo',
    ひゃ: 'hya', ひゅ: 'hyu', ひょ: 'hyo',
    みゃ: 'mya', みゅ: 'myu', みょ: 'myo',
    りゃ: 'rya', りゅ: 'ryu', りょ: 'ryo',
    ぎゃ: 'gya', ぎゅ: 'gyu', ぎょ: 'gyo',
    じゃ: 'ja', じゅ: 'ju', じょ: 'jo',
    びゃ: 'bya', びゅ: 'byu', びょ: 'byo',
    ぴゃ: 'pya', ぴゅ: 'pyu', ぴょ: 'pyo',
    いぇ: 'ye', うぃ: 'wi', うぇ: 'we', うぉ: 'wo',
    きぇ: 'kye', しぇ: 'she', ちぇ: 'che', にぇ: 'nye',
    ひぇ: 'hye', みぇ: 'mye', りぇ: 'rye', ぎぇ: 'gye',
    じぇ: 'je', びぇ: 'bye', ぴぇ: 'pye',
    てぃ: 'ti', てゅ: 'tyu', とぅ: 'tu',
    でぃ: 'di', でゅ: 'dyu', どぅ: 'du',
    ふぁ: 'fa', ふぃ: 'fi', ふぇ: 'fe', ふぉ: 'fo', ふゅ: 'fyu',
    ゔぁ: 'va', ゔぃ: 'vi', ゔぇ: 've', ゔぉ: 'vo', ゔゅ: 'vyu',
};

function toHiragana(text: string): string {
    return Array.from(text).map(char => {
        const code = char.charCodeAt(0);
        return code >= 0x30a1 && code <= 0x30f6
            ? String.fromCharCode(code - 0x60)
            : char;
    }).join('');
}

function lastVowel(text: string): string {
    const match = text.match(/[aeiou](?!.*[aeiou])/);
    return match?.[0] || '';
}

function geminatePrefix(romaji: string): string {
    if (/^ch/.test(romaji)) return 't';
    if (/^sh/.test(romaji)) return 's';
    if (/^ts/.test(romaji)) return 't';
    return /^[bcdfghjklmpqrstvwxyz]/.test(romaji) ? romaji[0] : '';
}

export function kanaToRomaji(text: string): string {
    const kana = toHiragana(text);
    let result = '';
    let geminate = false;

    for (let i = 0; i < kana.length; i++) {
        const char = kana[i];
        if (char === 'っ') {
            geminate = true;
            continue;
        }
        if (char === 'ー') {
            result += lastVowel(result);
            continue;
        }

        const pair = kana.slice(i, i + 2);
        let romaji = compoundKana[pair];
        if (romaji) {
            i++;
        } else {
            romaji = basicKana[char] ?? char;
        }

        if (geminate) {
            result += geminatePrefix(romaji);
            geminate = false;
        }
        result += romaji;
    }

    return result;
}

async function waitForKuromojiLibrary(timeoutMs: number = 2500): Promise<KuromojiLibrary | null> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const library = (globalThis as any).kuromoji as KuromojiLibrary | undefined;
        if (library?.builder) return library;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    return null;
}

async function getTokenizer(): Promise<KuromojiTokenizer | null> {
    if (tokenizerPromise) return tokenizerPromise;

    tokenizerPromise = (async () => {
        const kuromoji = await waitForKuromojiLibrary();
        if (!kuromoji) return null;

        return new Promise<KuromojiTokenizer | null>(resolve => {
            let settled = false;
            const finish = (tokenizer: KuromojiTokenizer | null) => {
                if (settled) return;
                settled = true;
                resolve(tokenizer);
            };

            const timeout = setTimeout(() => finish(null), 12000);
            try {
                kuromoji.builder({
                    dicPath: 'https://kuromoji.pkgs.spikerko.org'
                }).build((error, tokenizer) => {
                    clearTimeout(timeout);
                    finish(error ? null : tokenizer);
                });
            } catch {
                clearTimeout(timeout);
                finish(null);
            }
        });
    })();

    const tokenizer = await tokenizerPromise;
    if (!tokenizer) tokenizerPromise = null;
    return tokenizer;
}

function romanizeTokens(tokens: KuromojiToken[]): string {
    const converted = tokens.map(token => {
        const surface = token.surface_form || '';
        if (token.pos === '助詞') {
            if (surface === 'は') return 'wa';
            if (surface === 'へ') return 'e';
            if (surface === 'を') return 'o';
        }
        const reading = token.reading && token.reading !== '*'
            ? token.reading
            : token.pronunciation && token.pronunciation !== '*'
                ? token.pronunciation
                : surface;
        return kanaToRomaji(reading);
    });

    return converted
        .join(' ')
        .replace(/\s+([,.;:!?%)\]}\u3001\u3002\uff01\uff1f])/g, '$1')
        .replace(/([(\[{\u300c\u300e])\s+/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
}

function residualScriptCount(text: string): number {
    return Array.from(text || '').filter(char => KANA_OR_KANJI_RE.test(char)).length;
}

export async function improveJapaneseRomanization(
    lineData: LyricLineData[],
    language?: string
): Promise<number> {
    const sourceText = lineData.map(line => line.text).join('\n');
    const normalizedLanguage = (language || '').toLowerCase();
    const isJapanese = normalizedLanguage === 'ja' ||
        normalizedLanguage === 'jpn' ||
        KANA_RE.test(sourceText);
    if (!isJapanese) return 0;

    const candidates = lineData.filter(line =>
        !line.isInstrumental &&
        containsJapaneseScript(line.text) &&
        (!line.romanizedText || containsJapaneseScript(line.romanizedText))
    );
    if (candidates.length === 0) return 0;

    const tokenizer = await getTokenizer();
    if (!tokenizer) return 0;

    let improved = 0;
    for (const line of candidates) {
        try {
            const generated = romanizeTokens(tokenizer.tokenize(line.text));
            const previous = line.romanizedText || line.text;
            if (
                generated &&
                LATIN_RE.test(generated) &&
                residualScriptCount(generated) < residualScriptCount(previous)
            ) {
                line.romanizedText = generated;
                improved++;
            }
        } catch {
            // Keep Spicy Lyrics' original transliteration when local analysis fails.
        }
    }

    return improved;
}
