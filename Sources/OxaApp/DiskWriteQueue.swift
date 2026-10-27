import Foundation

/// Serializes encrypted file work away from the UI executor. Frequent progress
/// updates replace the pending write, while an explicit flush is a durability barrier.
final class DiskWriteQueue: @unchecked Sendable {
    private let queue = DispatchQueue(label: "app.oxas.library.persistence", qos: .utility)
    private let delay: TimeInterval
    private struct Pending {
        let work: DispatchWorkItem
        var write: () throws -> Void
        var onError: (Error) -> Void
    }
    private var pending: [String: Pending] = [:]

    init(delay: TimeInterval = 0.35) { self.delay = delay }

    func schedule(key: String, write: @escaping () throws -> Void, onError: @escaping (Error) -> Void) {
        queue.async {
            if var current = self.pending[key] {
                current.write = write; current.onError = onError; self.pending[key] = current
                return
            }
            let work = DispatchWorkItem {
                guard let current = self.pending.removeValue(forKey: key) else { return }
                do { try current.write() } catch { current.onError(error) }
            }
            // Keep the first deadline so a busy download cannot postpone saving forever.
            self.pending[key] = Pending(work: work, write: write, onError: onError)
            self.queue.asyncAfter(deadline: .now() + self.delay, execute: work)
        }
    }

    func flush(key: String, write: @escaping () throws -> Void) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            queue.async {
                self.pending.removeValue(forKey: key)?.work.cancel()
                do { try write(); continuation.resume() }
                catch { continuation.resume(throwing: error) }
            }
        }
    }

    func read<Value>(_ operation: @escaping () throws -> Value) async throws -> Value {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                do { continuation.resume(returning: try operation()) }
                catch { continuation.resume(throwing: error) }
            }
        }
    }
}
