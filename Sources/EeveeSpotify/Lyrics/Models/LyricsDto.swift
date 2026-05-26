import Foundation

struct LyricsDto {
    var lines: [LyricsLineDto]
    var timeSynced: Bool
    var romanization: LyricsRomanizationStatus
    var translation: LyricsTranslationDto?

    func toSpotifyLyricsData(source: String, trackId: String) -> LyricsData {
        let provider = source.lowercased().replacingOccurrences(of: " ", with: "")
        var lyricsData = LyricsData.with {
            $0.timeSynchronized = timeSynced
            $0.provider = provider
            $0.providerLyricsId = "\(provider)-\(trackId)"
            $0.restriction = .unrestricted
            $0.providedBy = "\(source) (EeveeSpotify)"
        }

        let shouldRomanize = UserDefaults.lyricsOptions.romanization

        if lines.isEmpty {
            lyricsData.lines = [
                LyricsLine.with {
                    $0.content = "song_is_instrumental".localized
                },
                LyricsLine.with {
                    $0.content = "let_the_music_play".localized
                },
                LyricsLine.with {
                    $0.content = ""
                }
            ]
        }
        else {
            let displayLines: [LyricsLineDto]
            if timeSynced {
                displayLines = lines.sorted { ($0.offsetMs ?? 0) < ($1.offsetMs ?? 0) }
            }
            else {
                displayLines = lines
            }

            lyricsData.lines = displayLines.map { line in
                LyricsLine.with {
                    $0.content = displayContent(for: line, shouldRomanize: shouldRomanize)
                    $0.offsetMs = Int32(line.offsetMs ?? 0)
                }
            }
        }

        if let translation = translation {
            lyricsData.translation = LyricsTranslation.with {
                $0.languageCode = translation.languageCode
                $0.lines = translation.lines
            }
        }

        return lyricsData
    }

    private func displayContent(for line: LyricsLineDto, shouldRomanize: Bool) -> String {
        guard shouldRomanize else {
            return line.content
        }

        let romanized = line.romanizedContent
            ?? (romanization == .canBeRomanized
                ? line.content.applyingTransform(.toLatin, reverse: false)
                : nil)

        guard
            let romanized = romanized?.trimmingCharacters(in: .whitespacesAndNewlines),
            !romanized.isEmpty,
            romanized != line.content
        else {
            return line.content
        }

        return "\(line.content)\n\(romanized)"
    }
}
