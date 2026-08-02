export function shouldStartTranslationAfterSongChange(
    isEnabled: boolean,
    autoTranslate: boolean,
    previousTrackUri: string | null,
    currentTrackUri: string | null
): boolean {
    if (isEnabled) return true;
    if (!autoTranslate) return false;

    return !previousTrackUri || !currentTrackUri || previousTrackUri !== currentTrackUri;
}
