import test from 'node:test';
import assert from 'node:assert/strict';

const storageMap = new Map<string, string>();

(globalThis as any).localStorage = {
    getItem: (key: string) => storageMap.get(key) ?? null,
    setItem: (key: string, value: string) => {
        storageMap.set(key, String(value));
    },
    removeItem: (key: string) => {
        storageMap.delete(key);
    },
    key: (index: number) => Array.from(storageMap.keys())[index] ?? null,
    get length() {
        return storageMap.size;
    }
};

const { getSettingField, readSettingValue } = require('../src/utils/settingsModel') as {
    getSettingField: (id: string) => any;
    readSettingValue: (field: any) => string | boolean;
};

test('Gemini model setting is a free text field and preserves custom pasted model ids', () => {
    storageMap.clear();
    storageMap.set('spicy-lyric-translator:gemini-model', 'models/gemini-2.5-flash-preview-05-20');

    const field = getSettingField('gemini-model');

    assert.equal(field?.type, 'text');
    assert.equal(field?.options, undefined);
    assert.equal(readSettingValue(field), 'models/gemini-2.5-flash-preview-05-20');
});
