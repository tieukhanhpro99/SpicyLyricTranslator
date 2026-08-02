import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldStartTranslationAfterSongChange } from '../src/utils/translationLifecycle';

test('a looped track does not re-enable translation after a manual toggle-off', () => {
    const uri = 'spotify:track:looped-song';

    assert.equal(
        shouldStartTranslationAfterSongChange(false, true, uri, uri),
        false
    );
});

test('auto translate still starts when playback moves to a different track', () => {
    assert.equal(
        shouldStartTranslationAfterSongChange(
            false,
            true,
            'spotify:track:first-song',
            'spotify:track:second-song'
        ),
        true
    );
});
