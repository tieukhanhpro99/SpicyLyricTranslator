import Orion
import Foundation
import SwiftUI
import MediaPlayer

//

struct BaseLyricsGroup: HookGroup { }

struct LegacyLyricsGroup: HookGroup { }
struct ModernLyricsGroup: HookGroup { }
struct V91LyricsGroup: HookGroup { }  // For Spotify 9.1.x - excludes incompatible hooks
struct LyricsErrorHandlingGroup: HookGroup { }  // ErrorViewController hooks - not compatible with 9.1.x

var lyricsState = LyricsLoadingState()

var hasShownRestrictedPopUp = false
var hasShownUnauthorizedPopUp = false

func writeLyricsDebugLog(_ message: String) {
    writeDebugLog("[Lyrics] \(message)")
}

func lyricsDebugErrorDescription(_ error: Error) -> String {
    if let lyricsError = error as? LyricsError {
        return "LyricsError.\(lyricsErrorDebugName(lyricsError))"
    }

    let nsError = error as NSError
    return "\(String(reflecting: type(of: error)))(domain=\(nsError.domain), code=\(nsError.code))"
}

private func lyricsErrorDebugName(_ error: LyricsError) -> String {
    switch error {
    case .noCurrentTrack: return "noCurrentTrack"
    case .trackMismatch: return "trackMismatch"
    case .musixmatchRestricted: return "musixmatchRestricted"
    case .invalidMusixmatchToken: return "invalidMusixmatchToken"
    case .decodingError: return "decodingError"
    case .noSuchSong: return "noSuchSong"
    case .unknownError: return "unknownError"
    case .invalidSource: return "invalidSource"
    }
}

func makeLyricsHTTPResponse(for url: URL) -> HTTPURLResponse {
    HTTPURLResponse(
        url: url,
        statusCode: 200,
        httpVersion: "2.0",
        headerFields: [
            "Content-Type": "application/protobuf",
            "Cache-Control": "no-store"
        ]
    )!
}

private let lyricsTaskStateQueue = DispatchQueue(label: "com.eeveespotify.lyrics.tasks")
private var handledLyricsTasks = Set<ObjectIdentifier>()

func markLyricsTaskHandled(_ task: URLSessionTask) {
    lyricsTaskStateQueue.sync {
        handledLyricsTasks.insert(ObjectIdentifier(task))
    }
}

func isLyricsTaskHandled(_ task: URLSessionTask) -> Bool {
    lyricsTaskStateQueue.sync {
        handledLyricsTasks.contains(ObjectIdentifier(task))
    }
}

func consumeLyricsTaskHandled(_ task: URLSessionTask) -> Bool {
    lyricsTaskStateQueue.sync {
        handledLyricsTasks.remove(ObjectIdentifier(task)) != nil
    }
}

private let geniusLyricsRepository = GeniusLyricsRepository()
private let petitLyricsRepository = PetitLyricsRepository()

// Overload for 9.1.6 where we only have track ID from URL
private func loadCustomLyricsForTrackId(_ trackId: String) throws -> Lyrics {

    let source = UserDefaults.lyricsSource
    writeLyricsDebugLog("provider=\(source.description) trackId=\(trackId) fetch=start")

    // Always clear captured metadata to ensure we fetch fresh info
    var currentTitle: String? = nil
    var currentArtist: String? = nil
    var hasMetadata = false

    // If metadata is needed (Genius/LRCLIB/Petit), fetch using token
    let needsMetadata = source == .genius || source == .lrclib || source == .petit

    // Check if we already have the metadata cached for this exact trackId
    if capturedTrackId == trackId, let title = capturedTrackTitle, let artist = capturedArtistName {
        currentTitle = title
        currentArtist = artist
        hasMetadata = true
    }

    // Fetch if missing
    if !hasMetadata {

        // Try getting metadata from the current player state (most reliable)
        if let player = statefulPlayer,
           let track = player.currentTrack() {
            let currentId = track.URI().spt_trackIdentifier()

            if currentId == trackId {
                currentTitle = track.trackTitle()
                currentArtist = track.artistName()
                hasMetadata = true

                // Cache it
                capturedTrackId = trackId
                capturedTrackTitle = currentTitle
                capturedArtistName = currentArtist
            } else {
            }
        } else {
        }

        if !hasMetadata {
            // Try MPNowPlayingInfoCenter (always available, version-independent)
            if let info = MPNowPlayingInfoCenter.default().nowPlayingInfo,
               let title = info[MPMediaItemPropertyTitle] as? String,
               let artist = info[MPMediaItemPropertyArtist] as? String,
               !title.isEmpty, !artist.isEmpty {
                currentTitle = title
                currentArtist = artist
                hasMetadata = true
                capturedTrackId = trackId
                capturedTrackTitle = title
                capturedArtistName = artist
            }
        }

        if !hasMetadata {
            if let token = spotifyAccessToken {
                if let info = fetchTrackDetails(trackId: trackId, token: token) {
                    currentTitle = info.title
                    currentArtist = info.artist
                    hasMetadata = true

                    // Cache it
                    capturedTrackId = trackId
                    capturedTrackTitle = currentTitle
                    capturedArtistName = currentArtist
                }
            }
        }
    }

    if needsMetadata && !hasMetadata {
        writeLyricsDebugLog("provider=\(source.description) trackId=\(trackId) metadata=missing")
        throw LyricsError.noSuchSong
    }

    writeLyricsDebugLog(
        "provider=\(source.description) trackId=\(trackId) title=\"\(currentTitle ?? "")\" artist=\"\(currentArtist ?? "")\" metadata=\(hasMetadata ? "present" : "not-required")"
    )

    // Create search query with available data
    let searchQuery = LyricsSearchQuery(
        title: currentTitle ?? "",
        primaryArtist: currentArtist ?? "",
        spotifyTrackId: trackId
    )

    let options = UserDefaults.lyricsOptions

    var repository: LyricsRepository

    switch source {
    case .genius:
        repository = geniusLyricsRepository
    case .lrclib:
        repository = LrclibLyricsRepository.shared
    case .musixmatch:
        repository = MusixmatchLyricsRepository.shared
    case .petit:
        repository = petitLyricsRepository
    case .notReplaced:
        throw LyricsError.invalidSource
    }

    let lyricsDto: LyricsDto

    lyricsState = LyricsLoadingState()

    do {
        lyricsDto = try repository.getLyrics(searchQuery, options: options)
    }
    catch let error {
        writeLyricsDebugLog("provider=\(source.description) trackId=\(trackId) fetch=failed error=\(lyricsDebugErrorDescription(error))")
        throw error
    }

    lyricsState.isEmpty = lyricsDto.lines.isEmpty

    lyricsState.wasRomanized = lyricsDto.romanization == .romanized
        || (lyricsDto.romanization == .canBeRomanized && UserDefaults.lyricsOptions.romanization)

    lyricsState.loadedSuccessfully = true


    let lyrics = Lyrics.with {
        $0.data = lyricsDto.toSpotifyLyricsData(source: source.description, trackId: trackId)
    }

    writeLyricsDebugLog(
        "provider=\(source.description) trackId=\(trackId) fetch=success lines=\(lyricsDto.lines.count) synced=\(lyricsDto.timeSynced) romanization=\(lyricsDto.romanization) romanizedLines=\(lyricsDto.lines.filter { $0.romanizedContent != nil }.count)"
    )

    return lyrics
}

//

private func loadCustomLyricsForCurrentTrack() throws -> Lyrics {

    guard
        let track = statefulPlayer?.currentTrack() ??
                    nowPlayingScrollViewController?.loadedTrack
        else {
            throw LyricsError.noCurrentTrack
        }

    let trackTitle = track.trackTitle()
    let artistName = EeveeSpotify.hookTarget == .lastAvailableiOS14
        ? track.artistName()
        : track.artistName()


    let searchQuery = LyricsSearchQuery(
        title: trackTitle,
        primaryArtist: artistName,
        spotifyTrackId: track.trackIdentifier
    )

    let options = UserDefaults.lyricsOptions
    var source = UserDefaults.lyricsSource
    writeLyricsDebugLog(
        "provider=\(source.description) trackId=\(track.trackIdentifier) title=\"\(trackTitle)\" artist=\"\(artistName)\" fetch=start"
    )

    // switched to swift 5.8 syntax to compile with Theos on Linux.
    var repository: LyricsRepository

    switch source {
    case .genius:
        repository = geniusLyricsRepository
    case .lrclib:
        repository = LrclibLyricsRepository.shared
    case .musixmatch:
        repository = MusixmatchLyricsRepository.shared
    case .petit:
        repository = petitLyricsRepository
    case .notReplaced:
        throw LyricsError.invalidSource
    }

    let lyricsDto: LyricsDto

    lyricsState = LyricsLoadingState()

    do {
        lyricsDto = try repository.getLyrics(searchQuery, options: options)
    }
    catch let error {
        writeLyricsDebugLog("provider=\(source.description) trackId=\(track.trackIdentifier) fetch=failed error=\(lyricsDebugErrorDescription(error))")
        if let error = error as? LyricsError {
            lyricsState.fallbackError = error

            switch error {

            case .invalidMusixmatchToken:
                if !hasShownUnauthorizedPopUp {
                    PopUpHelper.showPopUp(
                        delayed: false,
                        message: "musixmatch_unauthorized_popup".localized,
                        buttonText: "OK".uiKitLocalized
                    )

                    hasShownUnauthorizedPopUp.toggle()
                }

            case .musixmatchRestricted:
                if !hasShownRestrictedPopUp {
                    PopUpHelper.showPopUp(
                        delayed: false,
                        message: "musixmatch_restricted_popup".localized,
                        buttonText: "OK".uiKitLocalized
                    )

                    hasShownRestrictedPopUp.toggle()
                }

            default:
                break
            }
        }
        else {
            lyricsState.fallbackError = .unknownError
        }

        if source == .genius || !UserDefaults.lyricsOptions.geniusFallback {
            throw error
        }

        source = .genius
        repository = GeniusLyricsRepository()

        lyricsDto = try repository.getLyrics(searchQuery, options: options)
        writeLyricsDebugLog("provider=Genius trackId=\(track.trackIdentifier) fallback=success")
    }

    lyricsState.isEmpty = lyricsDto.lines.isEmpty

    lyricsState.wasRomanized = lyricsDto.romanization == .romanized
        || (lyricsDto.romanization == .canBeRomanized && UserDefaults.lyricsOptions.romanization)

    lyricsState.loadedSuccessfully = true

    let lyrics = Lyrics.with {
        $0.data = lyricsDto.toSpotifyLyricsData(source: source.description, trackId: track.trackIdentifier)
    }

    writeLyricsDebugLog(
        "provider=\(source.description) trackId=\(track.trackIdentifier) fetch=success lines=\(lyricsDto.lines.count) synced=\(lyricsDto.timeSynced) romanization=\(lyricsDto.romanization) romanizedLines=\(lyricsDto.lines.filter { $0.romanizedContent != nil }.count)"
    )

    return lyrics
}

// Developer note: fetched custom lyrics enter Spotify's display pipeline here.
// The URLSession hooks replace `/color-lyrics/v2/track/...` responses with this
// protobuf payload. Older code fetched provider lyrics but only populated the
// legacy field names and sometimes sent synthetic responses without a protobuf
// content type, so the current lyrics UI could receive bytes it did not accept
// as a mobile lyrics response. The mapping below keeps the existing provider
// flow but emits the wire-compatible mobile shape and safe diagnostics.
func getLyricsDataForCurrentTrack(_ originalPath: String, originalLyrics: Lyrics? = nil) throws -> Data {

    // Extract track ID from URL path since player objects are nil in 9.1.6
    // Format: /color-lyrics/v2/track/{trackId} or /lyrics/.../{trackId}
    let trackIdentifier: String
    if let range = originalPath.range(of: #"/track/([a-zA-Z0-9]+)"#, options: .regularExpression) {
        let match = originalPath[range]
        trackIdentifier = String(match.split(separator: "/").last ?? "")
    } else {
        writeLyricsDebugLog("path=\(originalPath) trackId=missing")
        throw LyricsError.noCurrentTrack
    }

    // Verify track ID was extracted
    if trackIdentifier.isEmpty {
        writeLyricsDebugLog("path=\(originalPath) trackId=empty")
        throw LyricsError.noCurrentTrack
    }

    writeLyricsDebugLog("trackId=\(trackIdentifier) responseReplacement=start path=\(originalPath)")

    // Try to capture metadata from view hierarchy at lyrics request time
    // Always try to capture fresh metadata when track changes
    // Clear old metadata if track ID changed
    if capturedTrackId != trackIdentifier {
        capturedTrackTitle = nil
        capturedArtistName = nil
        capturedTrackId = nil
    }


    // We strictly use API fetching now (handled in loadCustomLyricsForTrackId)
    // No more UI scraping or system info hacking

    // Use track ID version for 9.1.6 where we don't have track objects
    var lyrics = try loadCustomLyricsForTrackId(trackIdentifier)

    let lyricsColorsSettings = UserDefaults.lyricsColors

    if lyricsColorsSettings.displayOriginalColors, let originalLyrics = originalLyrics {
        lyrics.colors = originalLyrics.colors
    }
    else {
        // For 9.1.6, we don't have track object to extract color from
        // Use static color if enabled, otherwise use background color or gray
        var color: Color

        if lyricsColorsSettings.useStaticColor {
            color = Color(hex: lyricsColorsSettings.staticColor)
        }
        else if let uiColor = backgroundViewModel?.color() {
            color = Color(uiColor)
                .normalized(lyricsColorsSettings.normalizationFactor)
        }
        else {
            color = Color.gray
        }

        lyrics.colors = LyricsColors.with {
            $0.backgroundColor = color.uInt32
            $0.lineColor = Color.black.uInt32
            $0.activeLineColor = Color.white.uInt32
        }
    }

    let serializedData = try lyrics.serializedData()
    writeLyricsDebugLog(
        "trackId=\(trackIdentifier) responseShape=root{lyrics{syncType=\(lyrics.data.timeSynchronized ? 1 : 0), lines=\(lyrics.data.lines.count), provider=\"\(lyrics.data.provider)\", providerDisplayName=\"\(lyrics.data.providedBy)\", romanized=\(lyricsState.wasRomanized)}, colors=\(lyrics.hasColors)} bytes=\(serializedData.count)"
    )
    return serializedData
}
