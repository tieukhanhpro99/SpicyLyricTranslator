import test from 'node:test';
import assert from 'node:assert/strict';
import {
    containsJapaneseScript,
    improveJapaneseRomanization,
    kanaToRomaji
} from '../src/utils/japaneseRomanization';
import type { LyricLineData } from '../src/utils/lyricsFetcher';

test('converts hiragana and katakana readings to romaji', () => {
    assert.equal(kanaToRomaji('\u304d\u3087\u3046\u306f'), 'kyouha');
    assert.equal(kanaToRomaji('\u30ce\u30b9\u30bf\u30eb\u30b8\u30a2'), 'nosutarujia');
    assert.equal(kanaToRomaji('\u304c\u3063\u3053\u3046'), 'gakkou');
});

test('detects Japanese script residue', () => {
    assert.equal(containsJapaneseScript('kimi wa \u4e16\u754c'), true);
    assert.equal(containsJapaneseScript('kimi wa sekai'), false);
});

test('fills incomplete line romanization with the existing Kuromoji runtime', async () => {
    const line: LyricLineData = {
        text: '\u541b\u306f\u4e16\u754c',
        romanizedText: 'kimi wa \u4e16\u754c',
        startTime: 0,
        endTime: 1000,
        isInstrumental: false
    };

    (globalThis as any).kuromoji = {
        builder: () => ({
            build: (callback: (error: unknown, tokenizer: any) => void) => callback(null, {
                tokenize: () => [
                    { surface_form: '\u541b', reading: '\u30ad\u30df' },
                    { surface_form: '\u306f', reading: '\u30cf', pos: '\u52a9\u8a5e' },
                    { surface_form: '\u4e16\u754c', reading: '\u30bb\u30ab\u30a4' }
                ]
            })
        })
    };

    const count = await improveJapaneseRomanization([line], 'ja');

    assert.equal(count, 1);
    assert.equal(line.romanizedText, 'kimi wa sekai');
});
