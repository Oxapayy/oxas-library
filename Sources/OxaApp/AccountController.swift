import Foundation
import Observation
import CryptoKit
import Supabase

@MainActor @Observable final class AccountController {
    let client: SupabaseClient
    weak var store: AppStore?
    var identity: AccountIdentity?
    var busy = false
    var syncing = false
    var message: String?
    var lastSync: Date?
    var emailReady = false
    var needsUnlock = false
    var newVault = false
    var settings: VaultSettings?
    var journal = SyncJournal()
    private var key: SymmetricKey?
    private var epoch = UUID()
    private var timer: Task<Void, Never>?
    private var initialMerge = false
    private var lastPreferences: [String: String]?
    private var operationTask: Task<Void, Never>?
    var pendingCount: Int { journal.pending.count }
    var unlocked: Bool { key != nil && identity?.id == store?.accountID }
    init(store: AppStore) {
        self.store = store
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil; config.urlCache = nil
        config.timeoutIntervalForRequest = 30
        client = SupabaseClient(supabaseURL: CloudConfiguration.url, supabaseKey: CloudConfiguration.key, options: .init(auth: .init(storage: AuthKeychainStorage(), redirectToURL: CloudConfiguration.callback, storageKey: "oxa-account-session", flowType: .pkce, emitLocalSessionAsInitialSession: true), global: .init(session: URLSession(configuration: config))))
        if let bytes = try? Vault().read("active-account"), let owner = try? JSONDecoder().decode(AccountIdentity.self, from: bytes) {
            identity = owner
            journal = (try? store.disk?.loadNamed("journal-\(owner.id)", as: SyncJournal.self)) ?? SyncJournal()
            if let data = try? Vault().read("cloud-settings-\(owner.id)"), let cachedSettings = try? JSONDecoder().decode(VaultSettings.self, from: data), let bytes = try? Vault().read("cloud-key-\(owner.id)"), let cached = try? JSONDecoder().decode(CachedVaultKey.self, from: bytes), cached.generation == cachedSettings.generation {
                settings = cachedSettings; key = SymmetricKey(data: cached.key)
            }
        }
        operationTask = Task { await restore() }
    }
    func refreshReadiness() async {
        do {
            let flags: AuthReadiness = try await client.from("app_configuration").select("auth_emails_ready").single().execute().value
            emailReady = flags.auth_emails_ready

        } catch { /* Guest use and existing cached account state remain available. */ }
    }
    private func restore() async {
        await refreshReadiness()
        guard let identity else { return }
        let token = epoch
        do {
            let session = try await client.auth.session
            guard token == epoch, session.user.id == identity.id else { return }
            if let pending = try Vault().read("pending-wrap-\(identity.id)"), let replacement = try? JSONDecoder().decode(VaultSettings.self, from: pending) { try await finishPendingWrap(replacement) }
            if let pending = try Vault().read("pending-reset-\(identity.id)"), let reset = try? JSONDecoder().decode(VaultSettings.self, from: pending), let bytes = try Vault().read("cloud-key-\(identity.id)"), let cached = try? JSONDecoder().decode(CachedVaultKey.self, from: bytes), cached.generation == reset.generation { try await finishRecovery(reset, key: SymmetricKey(data: cached.key)); return }
            settings = try await fetchSettings(identity.id)
            if let settings, let data = try Vault().read("cloud-key-\(identity.id)"), let cached = try? JSONDecoder().decode(CachedVaultKey.self, from: data), cached.generation == settings.generation {
                key = SymmetricKey(data: cached.key); journal = try store?.disk?.loadNamed("journal-\(identity.id)", as: SyncJournal.self) ?? SyncJournal()
                needsUnlock = false; await sync()
            } else { key = nil; needsUnlock = true; newVault = settings == nil; message = "Unlock your encrypted server connections to resume sync." }
        } catch { message = "Account sync is unavailable. Your saved library and downloads remain on this iPhone." }
    }
    private func fetchSettings(_ id: UUID) async throws -> VaultSettings? {
        let rows: [VaultSettings] = try await client.from("vault_settings").select().eq("user_id", value: id).limit(1).execute().value
        return rows.first
    }
    func signIn(email: String, password: String, merge: Bool) async throws {
        let session = try await client.auth.signIn(email: email, password: password)
        try await authenticated(session.user, password: password, merge: merge)
    }
    func signUp(email: String, password: String) async throws {
        guard emailReady else { throw OxaError.message("Verification emails are not ready yet. The project owner needs to finish email setup. You can use the full app without an account.") }
        guard password.count >= 10, password.utf8.count <= 1024 else { throw OxaError.message("Use a password with 10–1,024 characters.") }
        _ = try await client.auth.signUp(email: email, password: password)
    }
    func verifySignup(email: String, code: String, password: String, merge: Bool) async throws {
        let session = try await client.auth.verifyOTP(email: email, token: code, type: .signup)
        try await authenticated(session.user, password: password, merge: merge)
    }
    func resendSignup(email: String) async throws { try await client.auth.resend(email: email, type: .signup) }
    func requestRecovery(email: String) async throws {
        guard emailReady else { throw OxaError.message("Password recovery emails are waiting for the project's email setup.") }
        try await client.auth.resetPasswordForEmail(email)
    }
    func recover(email: String, code: String, newPassword: String) async throws {
        guard newPassword.count >= 10 else { throw OxaError.message("Use at least 10 characters.") }
        let session = try await client.auth.verifyOTP(email: email, token: code, type: .recovery)
        let owner = AccountIdentity(id: session.user.id, email: session.user.email ?? email)
        epoch = UUID(); timer?.cancel(); key = nil; identity = owner
        let (fresh, freshKey) = try await Task.detached { try CloudCrypto.create(owner: owner.id, password: newPassword) }.value
        _ = try await client.auth.update(user: UserAttributes(password: newPassword))
        // A durable pending reset survives network loss after the password changes.
        try Vault().write(JSONEncoder().encode(fresh), key: "pending-reset-\(owner.id)")
        try cache(freshKey, settings: fresh)
        try await finishRecovery(fresh, key: freshKey)
    }
    private func finishRecovery(_ fresh: VaultSettings, key freshKey: SymmetricKey) async throws {
        struct Params: Encodable { var new_generation: UUID; var new_salt: String; var new_wrapped_key: String; var new_iterations: Int }
        try await client.rpc("reset_connection_vault", params: Params(new_generation: fresh.generation, new_salt: fresh.salt, new_wrapped_key: fresh.wrapped_key, new_iterations: fresh.iterations)).execute()
        try Vault().remove("pending-reset-\(fresh.user_id)")
        settings = fresh; key = freshKey; needsUnlock = false; newVault = false
        await store?.downloads.stopForAccountChange()
        try store?.activateAccount(identity!, mergeGuest: false)
        // Keep progress/watchlist and downloads; discard only provider connection state.
        if let store {
            for source in store.sources { try? store.vault.remove(source.id.uuidString) }
            store.state.sources = []; store.state.websitePages = []; store.save()
        }
        journal = SyncJournal(); journal.generation = fresh.generation; try saveJournal()
        await sync(); message = "Password updated. Reconnect your media servers; your watchlist and viewing history are retained."
    }
    private func authenticated(_ user: User, password: String?, merge: Bool) async throws {
        epoch = UUID(); timer?.cancel(); key = nil
        identity = AccountIdentity(id: user.id, email: user.email ?? "Signed-in account")
        initialMerge = merge
        if let bytes = try Vault().read("pending-reset-\(user.id)"), let reset = try? JSONDecoder().decode(VaultSettings.self, from: bytes), let cachedBytes = try Vault().read("cloud-key-\(user.id)"), let cached = try? JSONDecoder().decode(CachedVaultKey.self, from: cachedBytes), cached.generation == reset.generation {
            try await finishRecovery(reset, key: SymmetricKey(data: cached.key)); return
        }
        settings = try await fetchSettings(user.id); newVault = settings == nil
        if let settings, let data = try Vault().read("cloud-key-\(user.id)"), let cached = try? JSONDecoder().decode(CachedVaultKey.self, from: data), cached.generation == settings.generation { try await attach(key: SymmetricKey(data: cached.key)); return }
        needsUnlock = true
        if let password { try await unlock(password: password) }
    }
    func unlock(password: String) async throws {
        guard let identity else { return }
        let unlockedKey: SymmetricKey
        if let settings {
            do { unlockedKey = try await Task.detached { try CloudCrypto.unlock(settings, password: password) }.value }
            catch { throw OxaError.message("This password could not unlock your server connections. Use your library password. Your encrypted data has not been reset.") }
        } else {
            let (fresh, created) = try await Task.detached { try CloudCrypto.create(owner: identity.id, password: password) }.value
            do { try await client.from("vault_settings").insert(fresh).execute(); settings = fresh; unlockedKey = created }
            catch {
                // Another device may have initialized the vault. Never overwrite its key.
                guard let existing = try await fetchSettings(identity.id) else { throw error }
                settings = existing
                do { unlockedKey = try await Task.detached { try CloudCrypto.unlock(existing, password: password) }.value }
                catch { throw OxaError.message("This account already has an encrypted library. Enter its existing library password.") }
            }
        }
        try await attach(key: unlockedKey)
    }
    private func cache(_ key: SymmetricKey, settings: VaultSettings) throws {
        try Vault().write(JSONEncoder().encode(settings), key: "cloud-settings-\(settings.user_id)")
        try Vault().write(JSONEncoder().encode(CachedVaultKey(generation: settings.generation, key: key.withUnsafeBytes { Data($0) })), key: "cloud-key-\(settings.user_id)")
    }
    private func attach(key: SymmetricKey) async throws {
        guard let settings, let identity, let store else { return }
        self.key = key; try cache(key, settings: settings)
        if store.accountID != identity.id { await store.downloads.stopForAccountChange() }
        try store.activateAccount(identity, mergeGuest: initialMerge)
        journal = try store.disk?.loadNamed("journal-\(identity.id)", as: SyncJournal.self) ?? SyncJournal()
        if let previous = journal.generation, previous != settings.generation {
            journal.pending = journal.pending.filter { $0.value.kind != "source" }
            journal.cursor = 0
        }
        journal.generation = settings.generation
        needsUnlock = false; newVault = false
        // Pull first so imported guest data uses known server revisions.
        await sync()
        if initialMerge || !journal.initialized { queueLibrary(); journal.initialized = true; try saveJournal(); initialMerge = false; await sync() }
    }
    func signOut() async throws {
        epoch = UUID(); timer?.cancel(); operationTask?.cancel()
        let owner = identity?.id
        // Local sign-out must succeed even when the network is unavailable.
        try? await client.auth.signOut(scope: .local)
        try Vault().remove("auth-oxa-account-session")
        if let owner { try Vault().remove("cloud-key-\(owner)"); try Vault().remove("cloud-settings-\(owner)") }
        try Vault().remove("active-account")
        key = nil; settings = nil; identity = nil; needsUnlock = false; journal = SyncJournal(); message = nil
        await store?.downloads.stopForAccountChange()
        try store?.activateGuest()
    }
    func deleteAccount() async throws {
        let session = try await client.auth.session
        let owner = session.user.id
        guard identity?.id == owner else { throw OxaError.message("Sign in again before deleting this account.") }
        var request = URLRequest(url: CloudConfiguration.url.appendingPathComponent("functions/v1/delete-account")); request.httpMethod = "DELETE"
        request.setValue("Bearer \(session.accessToken)", forHTTPHeaderField: "Authorization"); request.setValue(CloudConfiguration.key, forHTTPHeaderField: "apikey")
        let response = try await BoundedHTTP.fetch(request, limit: 64 * 1024, publicOnly: true)
        guard (200...299).contains(response.response.statusCode) else { throw OxaError.message("The account could not be deleted. Sign in again and retry.") }
        if let store, store.accountID == owner {
            for transfer in store.state.transfers { store.downloads.delete(transfer.id) }
            for source in store.sources { try? store.vault.remove(source.id.uuidString) }
        }
        // A locked login can coexist with the guest library. Clean only the deleted account.
        if let store, store.accountID != owner, let snapshot = try store.disk?.loadNamed("library-\(owner)", as: LibrarySnapshot.self) {
            let accountVault = Vault(); accountVault.namespace = owner.uuidString + ":"
            for source in snapshot.sources { try? accountVault.remove(source.id.uuidString) }
            for transfer in snapshot.transfers {
                if let path = transfer.relativePath, let root = store.disk?.mediaRoot, let url = URLPolicy.relativeFile(path, root: root) { try? FileManager.default.removeItem(at: url) }
                if let path = transfer.systemRelativePath, path.hasPrefix("Library/"), let url = URLPolicy.relativeFile(path, root: URL(fileURLWithPath: NSHomeDirectory())) { try? FileManager.default.removeItem(at: url) }
            }
        }
        try await signOut()
        try store?.disk?.removeNamed("library-\(owner)"); try store?.disk?.removeNamed("journal-\(owner)")
    }
    func userMessage(_ error: Error) -> String {
        if let error = error as? OxaError { return error.localizedDescription }
        if error is CancellationError { return "The request was cancelled." }
        return "This account action could not be completed. Check your connection, email, password or verification code and try again."
    }
    func changePassword(current: String, new: String) async throws {
        guard let settings, let identity else { throw OxaError.message("Sign in and unlock your library first.") }
        let oldKey: SymmetricKey
        do { oldKey = try await Task.detached { try CloudCrypto.unlock(settings, password: current) }.value }
        catch { throw OxaError.message("The current library password is incorrect. Nothing was changed.") }
        let replacement = try await Task.detached { try CloudCrypto.rewrap(settings, key: oldKey, password: new) }.value
        _ = try await client.auth.update(user: UserAttributes(password: new))
        try Vault().write(JSONEncoder().encode(replacement), key: "pending-wrap-\(identity.id)")
        try await finishPendingWrap(replacement)
    }
    private func finishPendingWrap(_ replacement: VaultSettings) async throws {
        let changed: [VaultSettings] = try await client.from("vault_settings").update(replacement).eq("user_id", value: replacement.user_id).eq("generation", value: replacement.generation).select().execute().value
        guard changed.count == 1 else { throw OxaError.message("The vault changed on another device. Sign in again.") }
        settings = replacement; try Vault().remove("pending-wrap-\(replacement.user_id)")
    }
    private func saveJournal() throws {
        guard let owner = identity?.id else { return }
        try store?.disk?.saveNamed(journal, name: "journal-\(owner)")
    }
    private func queue<T: Encodable>(_ kind: String, key recordKey: String, value: T, deleted: Bool = false, encrypt: Bool = false) {
        guard unlocked, let identity, let key, let settings else { return }
        do {
            let bytes = try JSONEncoder().encode(value)
            let text = encrypt ? try CloudCrypto.seal(bytes, key: key, owner: identity.id, purpose: "source:\(settings.generation):\(recordKey)") : bytes.base64EncodedString()
            let id = "\(kind):\(recordKey)"
            journal.pending[id] = CloudChange(kind: kind, key: recordKey, payload: CloudPayload(value: text), deleted: deleted, base_revision: journal.revisions[id] ?? 0)
            try saveJournal(); schedule()
        } catch { message = "Could not queue encrypted library changes. Your local library is still available." }
    }
    func sourceChanged(_ source: MediaSource, deleted: Bool = false) {
        guard let credentials = try? store?.vault.credentials(source.id) else {
            if deleted { queue("source", key: source.id.uuidString, value: "", deleted: true) }; return
        }
        queue("source", key: source.id.uuidString, value: CloudSource(source: source, credentials: credentials), deleted: deleted, encrypt: true)
    }
    func progressChanged(_ media: Media) { queue("progress", key: media.cloudKey, value: CloudMediaState(media: media.cloudMetadata, progress: store?.state.progress[media.id])) }
    func watchlistChanged(_ media: Media, present: Bool) { queue("watchlist", key: media.cloudKey, value: CloudMediaState(media: media.cloudMetadata), deleted: !present) }
    func preferencesChanged() {
        guard let p = store?.state.preferences else { return }
        let values = ["audio": p.audioLanguage, "subtitle": p.subtitleLanguage, "autoplay": p.autoplay ? "true" : "false"]
        guard values != lastPreferences else { return }; lastPreferences = values
        queue("preferences", key: "playback", value: values)
    }
    private func queueLibrary() {
        guard let store else { return }
        for source in store.sources { sourceChanged(source) }
        for media in store.catalog where store.state.progress[media.id] != nil { progressChanged(media) }
        for media in store.catalog where store.state.favorites.contains(media.id) { watchlistChanged(media, present: true) }
        preferencesChanged()
    }
    func schedule() {
        guard unlocked, !syncing else { return }
        timer?.cancel()
        timer = Task { try? await Task.sleep(for: .milliseconds(700)); guard !Task.isCancelled else { return }; await sync() }
    }
    func sync() async {
        guard !syncing, unlocked, let identity, let key, let settings, let store else { return }
        syncing = true; defer { syncing = false }
        let token = epoch
        do {
            for _ in 0..<20 {
                let batch = Array(journal.pending.values.prefix(200))
                var cursor = journal.cursor
                var returned: [CloudRecord] = []; var conflicts: [CloudConflict] = []
                var send = batch
                var repulledConflicts = false
                for _ in 0..<100 {
                    let reply: CloudReply = try await client.rpc("sync_library", params: CloudRequest(changes: send, after_revision: cursor, expected_generation: settings.generation)).execute().value
                    guard token == epoch, store.accountID == identity.id else { return }
                    guard reply.generation == settings.generation else { throw OxaError.message("Your encrypted connections changed on another device. Sign in again.") }
                    conflicts += reply.conflicts
                    if !reply.conflicts.isEmpty && !repulledConflicts {
                        // A conflicting record can predate our cursor. Pull it before dropping the stale edit.
                        repulledConflicts = true; cursor = 0; send = []; continue
                    }
                    returned += reply.records
                    if let last = reply.records.last { cursor = max(cursor, last.revision) }
                    send = []
                    if reply.records.count < 1000 { break }
                }
                let sent = Dictionary(uniqueKeysWithValues: batch.map { ($0.id, $0.mutationID) })
                for record in returned {
                    let pending = journal.pending[record.id]
                    let changedDuringRequest = pending != nil && pending?.mutationID != sent[record.id]
                    journal.revisions[record.id] = record.revision
                    if changedDuringRequest { journal.pending[record.id]?.base_revision = record.revision; continue }
                    try apply(record, owner: identity.id, key: key, generation: settings.generation)
                }
                for change in batch where journal.pending[change.id]?.mutationID == change.mutationID { journal.pending.removeValue(forKey: change.id) }
                journal.cursor = cursor; try store.persistSnapshot(); try saveJournal()
                message = conflicts.isEmpty ? nil : "A newer change from another device was kept. Review your library before editing it again."
                lastSync = .now
                if journal.pending.isEmpty { break }
            }
        } catch {
            guard token == epoch else { return }
            if let failure = error as? PostgrestError, failure.message.contains("Vault generation changed") {
                self.key = nil; needsUnlock = true
                self.settings = try? await fetchSettings(identity.id)
                message = "Your encrypted connections changed on another device. Unlock with your current library password; server connections may need to be restored."
                return
            }
            message = "Could not sync. Local changes are saved and will retry. If your password was reset on another device, sign out and sign in again."
        }
    }
    private func apply(_ record: CloudRecord, owner: UUID, key: SymmetricKey, generation: UUID) throws {
        guard let store else { return }
        if record.kind == "source" {
            guard let sourceID = UUID(uuidString: record.key) else { return }
            if record.deleted {
                try? store.vault.remove(sourceID.uuidString)
                store.state.sources.removeAll { $0.id == sourceID }; store.state.websitePages?.removeAll { $0.sourceID == sourceID }
                return
            }
            let bytes = try CloudCrypto.open(record.payload.value, key: key, owner: owner, purpose: "source:\(generation):\(record.key)")
            let remote = try JSONDecoder().decode(CloudSource.self, from: bytes)
            guard remote.source.id == sourceID else { throw OxaError.message("Invalid encrypted connection identity.") }
            _ = try URLPolicy.validate(remote.credentials.endpoint, allowHTTP: remote.source.allowHTTP)
            try store.vault.save(remote.credentials, id: sourceID)
            let wasNew = store.source(sourceID) == nil
            store.state.sources.removeAll { $0.id == sourceID }; store.state.sources.append(remote.source)
            if wasNew { Task { [weak store] in await store?.refresh(remote.source) } }
        } else if record.kind == "progress" || record.kind == "watchlist" {
            guard let bytes = Data(base64Encoded: record.payload.value) else { return }
            let remote = try JSONDecoder().decode(CloudMediaState.self, from: bytes)
            guard remote.media.cloudKey == record.key else { return }
            let target = store.catalog.first(where: { $0.cloudKey == record.key }) ?? remote.media.cloudMetadata
            if store.media(target.id) == nil { store.state.media.append(target) }
            if record.kind == "progress" {
                if record.deleted { store.state.progress.removeValue(forKey: target.id) }
                else if let progress = remote.progress { store.state.progress[target.id] = WatchProgress(seconds: progress.seconds.boundedDuration, duration: progress.duration.boundedDuration, playedAt: progress.playedAt, completed: progress.completed) }
            } else {
                if record.deleted { store.state.favorites.remove(target.id) } else { store.state.favorites.insert(target.id) }
            }
        } else if record.kind == "preferences", !record.deleted, let bytes = Data(base64Encoded: record.payload.value), let p = try? JSONDecoder().decode([String: String].self, from: bytes) {
            lastPreferences = p
            if ["en", "de"].contains(p["audio"] ?? "") { store.state.preferences.audioLanguage = p["audio"]! }
            if ["en", "de", "off"].contains(p["subtitle"] ?? "") { store.state.preferences.subtitleLanguage = p["subtitle"]! }
            store.state.preferences.autoplay = p["autoplay"] == "true"
        }
    }
}
