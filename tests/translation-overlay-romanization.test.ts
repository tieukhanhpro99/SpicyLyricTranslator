import test from 'node:test';
import assert from 'node:assert/strict';
import {
    clearOverlayContent,
    disableOverlay,
    enableOverlay,
    setOriginalTextData,
    setRomanizationData,
    setTranslationContentData,
    updateOverlayContent
} from '../src/utils/translationOverlay';

class FakeClassList {
    private values = new Set<string>();

    constructor(...initial: string[]) {
        initial.forEach(value => this.values.add(value));
    }

    contains(value: string): boolean {
        return this.values.has(value);
    }

    add(...values: string[]): void {
        values.forEach(value => this.values.add(value));
    }

    remove(...values: string[]): void {
        values.forEach(value => this.values.delete(value));
    }

    toggle(value: string, force?: boolean): boolean {
        const shouldHave = force ?? !this.values.has(value);
        if (shouldHave) this.values.add(value);
        else this.values.delete(value);
        return shouldHave;
    }
}

class FakeStyle {
    private values = new Map<string, string>();

    setProperty(key: string, value: string): void {
        this.values.set(key, value);
    }

    getPropertyValue(key: string): string {
        return this.values.get(key) || '';
    }

    removeProperty(key: string): void {
        this.values.delete(key);
    }
}

class FakeElement {
    textContent: string | null;
    className = '';
    classList: FakeClassList;
    dataset: Record<string, string> = {};
    style = new FakeStyle();
    children: FakeElement[] = [];
    parentNode: FakeParent | null = null;
    parentElement: FakeParent | null = null;
    previousElementSibling: FakeElement | null = null;
    nextElementSibling: FakeElement | null = null;
    nextSibling: FakeElement | null = null;
    innerHTML = '';

    constructor(text: string = '', classes: string[] = []) {
        this.textContent = text;
        this.classList = new FakeClassList(...classes);
    }

    querySelectorAll(): FakeElement[] {
        return [];
    }

    querySelector(): FakeElement | null {
        return null;
    }

    closest(selector: string): FakeElement | null {
        if (selector === '[data-index]' && this.dataset.index !== undefined) return this;
        return null;
    }

    addEventListener(): void {}
    remove(): void {}
    appendChild(child: FakeElement): FakeElement {
        this.children.push(child);
        return child;
    }
}

class FakeParent {
    inserted: FakeElement[] = [];

    insertBefore(newEl: FakeElement, _reference: FakeElement | null): FakeElement {
        this.inserted.push(newEl);
        newEl.parentNode = this;
        newEl.parentElement = this;
        return newEl;
    }
}

class FakeDocument {
    body = new FakeElement('', []);
    parent = new FakeParent();
    line: FakeElement;

    constructor(line: FakeElement) {
        this.line = line;
        this.body.classList = new FakeClassList();
        this.line.parentNode = this.parent;
        this.line.parentElement = this.parent;
    }

    querySelector(selector: string): any {
        if (selector === '.spicy-pip-wrapper') return null;
        if (selector === '.slt-replace-line') return this.parent.inserted.find(el => el.classList.contains('slt-replace-line')) || null;
        if (selector === '.slt-interleaved-translation') return this.parent.inserted.find(el => el.classList.contains('slt-interleaved-translation')) || null;
        return null;
    }

    querySelectorAll(selector: string): FakeElement[] {
        if (selector === '.slt-replace-line') {
            return this.parent.inserted.filter(el => el.classList.contains('slt-replace-line'));
        }
        if (selector === '.slt-interleaved-translation') {
            return this.parent.inserted.filter(el => el.classList.contains('slt-interleaved-translation'));
        }
        return selector.includes('.line') && !selector.includes('.slt-') ? [this.line] : [];
    }

    createElement(): FakeElement {
        return new FakeElement();
    }

    getElementById(): FakeElement | null {
        return null;
    }
}

test('romanized visible lyrics render index translations when content lookup misses', () => {
    const line = new FakeElement('konomamayusaburareteitaina', ['line']);
    line.dataset.index = '0';
    const fakeDocument = new FakeDocument(line);

    (globalThis as any).document = fakeDocument;
    (globalThis as any).window = {};
    (globalThis as any).MutationObserver = class {
        observe(): void {}
        disconnect(): void {}
    };
    (globalThis as any).requestAnimationFrame = () => 1;
    (globalThis as any).cancelAnimationFrame = () => {};
    (globalThis as any).localStorage = {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
        key: () => null,
        length: 0
    };

    clearOverlayContent();
    setTranslationContentData(new Map([
        ['\u3053\u306e\u307e\u307e\u63fa\u3055\u3076\u3089\u308c\u3066\u3044\u305f\u3044\u306a', 'ignored content translation']
    ]));

    enableOverlay({ mode: 'replace', syncWordHighlight: false });
    updateOverlayContent(new Map([[0, 'Mu\u1ed1n m\u00e3i \u0111ung \u0111\u01b0a th\u1ebf n\u00e0y th\u00f4i']]));

    assert.equal(fakeDocument.parent.inserted.length, 1);
    assert.equal(fakeDocument.parent.inserted[0].textContent, 'Mu\u1ed1n m\u00e3i \u0111ung \u0111\u01b0a th\u1ebf n\u00e0y th\u00f4i');

    disableOverlay();
});

test('vocabulary mode keeps native romanized lyrics visible after translation renders', () => {
    const romanized = 'koi no hajimari mo yume no tsuzuki mo';
    const original = '\u604b\u306e\u59cb\u307e\u308a\u3082 \u5922\u306e\u7d9a\u304d\u3082';
    const line = new FakeElement(romanized, ['line']);
    line.dataset.index = '0';
    const fakeDocument = new FakeDocument(line);

    (globalThis as any).document = fakeDocument;
    (globalThis as any).window = {};
    (globalThis as any).MutationObserver = class {
        observe(): void {}
        disconnect(): void {}
    };
    let pendingFrame: FrameRequestCallback | null = null;
    (globalThis as any).requestAnimationFrame = (callback: FrameRequestCallback) => {
        pendingFrame = callback;
        return 1;
    };
    (globalThis as any).cancelAnimationFrame = () => {};
    (globalThis as any).localStorage = {
        getItem: (key: string) => key === 'spicy-lyric-translator:vocabulary-mode' ? 'true' : null,
        setItem: () => {},
        removeItem: () => {},
        key: () => null,
        length: 0
    };

    clearOverlayContent();
    setRomanizationData(new Map([[0, romanized]]));
    setOriginalTextData(new Map([[0, original]]));
    enableOverlay({ mode: 'interleaved', syncWordHighlight: false });
    updateOverlayContent(new Map([[0, 'T\u00ecnh y\u00eau b\u1eaft \u0111\u1ea7u, gi\u1ea5c m\u01a1 ti\u1ebfp n\u1ed1i']]));
    const renderFrame = pendingFrame as FrameRequestCallback | null;
    pendingFrame = null;
    renderFrame?.(0);

    assert.equal(line.classList.contains('slt-learning-hidden'), false);
    assert.equal(fakeDocument.parent.inserted.some(el => el.classList.contains('slt-original-line')), false);

    disableOverlay();
});

test('same-signature lyric rerender recreates missing translation elements after DOM rebuild', () => {
    const line = new FakeElement('\u541b\u306f\u4e16\u754c', ['line']);
    line.dataset.index = '0';
    const fakeDocument = new FakeDocument(line);

    (globalThis as any).document = fakeDocument;
    (globalThis as any).window = {};
    (globalThis as any).MutationObserver = class {
        observe(): void {}
        disconnect(): void {}
    };
    (globalThis as any).requestAnimationFrame = () => 1;
    (globalThis as any).cancelAnimationFrame = () => {};
    (globalThis as any).localStorage = {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
        key: () => null,
        length: 0
    };

    clearOverlayContent();
    enableOverlay({ mode: 'replace', syncWordHighlight: false });
    updateOverlayContent(new Map([[0, 'Em l\u00e0 th\u1ebf gi\u1edbi']]));

    assert.equal(fakeDocument.parent.inserted.length, 1);

    fakeDocument.parent.inserted = [];
    line.classList.remove('slt-replace-hidden');

    updateOverlayContent(new Map([[0, 'Em l\u00e0 th\u1ebf gi\u1edbi']]));

    assert.equal(fakeDocument.parent.inserted.length, 1);

    disableOverlay();
});
