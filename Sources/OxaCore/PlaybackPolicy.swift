import Foundation

enum PlaybackPolicy {
    static func nextEpisodePrompt(at seconds: Double, duration: Double, creditsStart: Double?) -> Bool {
        guard seconds.isFinite, duration.isFinite, duration > 5, seconds >= 0 else { return false }
        let marker: Double
        if let creditsStart, creditsStart.isFinite, creditsStart > duration / 2, creditsStart < duration { marker = creditsStart }
        else { marker = duration - min(30, max(5, duration * 0.02)) }
        return seconds >= marker
    }
}
