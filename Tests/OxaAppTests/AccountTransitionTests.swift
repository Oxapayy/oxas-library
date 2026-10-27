import XCTest
import CryptoKit
import Supabase
@testable import OxasLibrary

@MainActor final class AccountTransitionTests: XCTestCase {
    func testSignOutLibraryWriteFailureRetainsAccountEvenWhenJournalAndMetadataCanSave() async throws {
        let fixture = try TransitionFixture(signedIn: true)
        defer { fixture.cleanUp() }
        let store = fixture.store, controller = fixture.controller
        store.state.progress[fixture.accountMedia.id] = WatchProgress(seconds: 321, duration: 1000)
        controller.journal.pending["preferences:playback"] = CloudChange(kind: "preferences", key: "playback", payload: CloudPayload(value: "fixture"), deleted: false, base_revision: 0)
        fixture.disk.failAccountLibraryWrites = true
        // The regression occurs when a small journal/Keychain operation succeeds
        // but the much larger account catalog hits ENOSPC afterwards.
        try fixture.markerVault.write(Data("metadata can still save".utf8), key: "probe")
        do { try await controller.signOut(); XCTFail("Sign-out should fail before changing scope") } catch { }
        XCTAssertEqual(controller.identity?.id, fixture.owner.id)
        XCTAssertEqual(controller.settings?.user_id, fixture.owner.id)
        XCTAssertTrue(controller.unlocked)
        assertAccountScope(fixture)
        XCTAssertEqual(store.state.progress[fixture.accountMedia.id]?.seconds, 321)
        XCTAssertEqual(fixture.sessionEnds, 0)
        XCTAssertNotNil(try fixture.markerVault.read("auth-oxa-account-session"))
        let journal = try XCTUnwrap(fixture.disk.loadNamed("journal-\(fixture.owner.id)", as: SyncJournal.self))
        XCTAssertEqual(journal.pending.count, 1, "The injected failure must affect the library, not the earlier journal flush")
    }

    func testSDKSessionOwnerMismatchNeverSendsRetainedAccountsOutbox() async throws {
        let fixture = try TransitionFixture(signedIn: true, sessionOwnerID: UUID())
        defer { fixture.cleanUp() }
        let id = "preferences:playback"
        let pending = CloudChange(kind: "preferences", key: "playback", payload: CloudPayload(value: "fixture"), deleted: false, base_revision: 0)
        fixture.controller.journal.pending[id] = pending
        let previousCursor = fixture.controller.journal.cursor
        // A failed local account attachment can leave the SDK with a newly
        // authenticated owner while the old library stays correctly scoped.
        XCTAssertTrue(fixture.controller.unlocked)
        await fixture.controller.sync()
        XCTAssertEqual(fixture.syncRequests.calls, 0)
        XCTAssertEqual(fixture.controller.journal.pending[id]?.mutationID, pending.mutationID)
        XCTAssertEqual(fixture.controller.journal.cursor, previousCursor)
        XCTAssertEqual(fixture.controller.identity?.id, fixture.owner.id)
        XCTAssertNotNil(fixture.controller.message)
        assertAccountScope(fixture)
    }

    func testSessionSwitchBetweenVerificationAndTransportKeepsVerifiedBearer() async throws {
        let fixture = try TransitionFixture(signedIn: true)
        defer { fixture.cleanUp() }
        let oldToken = "fixture-token-for-retained-owner", newToken = "fixture-token-for-new-sdk-owner"
        let current = SyncSessionSwitch(owner: fixture.owner.id, token: oldToken)
        let switchedOwner = UUID(), generation = fixture.settings.generation
        let captured = CapturedSyncRequest()
        let controller = AccountController(store: fixture.store, startAutomatically: false, syncSession: {
            // The provider returns the owner/token pair atomically from one SDK
            // Session value, then another login wins before HTTP transport runs.
            let verified = AccountSyncSession(ownerID: current.owner, accessToken: current.token)
            current.owner = switchedOwner; current.token = newToken
            return verified
        }, syncFetch: { request in
            captured.record(request)
            let body = try JSONEncoder().encode(CloudReply(records: [], conflicts: [], generation: generation))
            return (body, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!)
        })
        fixture.store.account = controller
        controller.journal.pending["preferences:playback"] = CloudChange(kind: "preferences", key: "playback", payload: CloudPayload(value: "fixture-retained-outbox"), deleted: false, base_revision: 0)
        await controller.sync()
        XCTAssertEqual(current.owner, switchedOwner)
        XCTAssertEqual(current.token, newToken)
        let request = try XCTUnwrap(captured.request)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer \(oldToken)")
        XCTAssertFalse(request.value(forHTTPHeaderField: "Authorization")?.contains(newToken) == true)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertTrue(request.url?.path.hasSuffix("/rest/v1/rpc/sync_library") == true)
        let body = try XCTUnwrap(request.httpBody)
        let decoded = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual((decoded["changes"] as? [[String: Any]])?.count, 1)
        XCTAssertEqual(decoded["expected_generation"] as? String, generation.uuidString)
        XCTAssertTrue(controller.journal.pending.isEmpty, "A reply for the frozen original owner can acknowledge that owner's batch")
        XCTAssertEqual(controller.identity?.id, fixture.owner.id)
        assertAccountScope(fixture)
    }

    func testSignOutCorruptGuestReadRetainsIdentityMarkerAndAccountLibrary() async throws {
        let fixture = try TransitionFixture(signedIn: true)
        defer { fixture.cleanUp() }
        try Data("corrupt guest ciphertext".utf8).write(to: fixture.disk.root.appendingPathComponent("library.sealed"), options: .atomic)
        fixture.store.state.progress[fixture.accountMedia.id] = WatchProgress(seconds: 456, duration: 1000)
        do { try await fixture.controller.signOut(); XCTFail("Corrupt guest data must not become a partial sign-out") } catch { }
        assertAccountScope(fixture)
        XCTAssertEqual(fixture.controller.identity?.id, fixture.owner.id)
        XCTAssertTrue(fixture.controller.unlocked)
        XCTAssertEqual(fixture.sessionEnds, 0)
        XCTAssertNotNil(try fixture.markerVault.read("auth-oxa-account-session"))
        let account = try XCTUnwrap(fixture.disk.loadNamed("library-\(fixture.owner.id)", as: LibrarySnapshot.self))
        XCTAssertEqual(account.progress[fixture.accountMedia.id]?.seconds, 456)
    }

    func testSuccessfulSignOutCommitsGuestBeforeEndingAuthSession() async throws {
        let fixture = try TransitionFixture(signedIn: true)
        defer { fixture.cleanUp() }
        fixture.onSessionEnd = {
            XCTAssertNil(fixture.store.accountID)
            XCTAssertNil(fixture.controller.identity)
            XCTAssertEqual(fixture.store.vault.namespace, "")
            XCTAssertEqual(fixture.store.catalog.map(\.id), [fixture.guestMedia.id])
            XCTAssertNil(try fixture.markerVault.read("active-account"))
        }
        try await fixture.controller.signOut()
        XCTAssertEqual(fixture.sessionEnds, 1)
        XCTAssertNil(fixture.store.accountID); XCTAssertNil(fixture.controller.identity)
        XCTAssertEqual(fixture.store.catalog.map(\.id), [fixture.guestMedia.id])
        XCTAssertNil(try fixture.markerVault.read("auth-oxa-account-session"))
        XCTAssertNotNil(try fixture.disk.loadNamed("library-\(fixture.owner.id)", as: LibrarySnapshot.self))
        let relaunched = AppStore(disk: fixture.disk, identityVault: fixture.markerVault, startServices: false)
        XCTAssertNil(relaunched.accountID)
        XCTAssertEqual(relaunched.catalog.map(\.id), [fixture.guestMedia.id])
    }

    func testSignInTargetLibraryWriteFailureDoesNotPublishAccountIdentityOrNamespace() async throws {
        let fixture = try TransitionFixture(signedIn: false)
        defer { fixture.cleanUp() }
        fixture.disk.failAccountLibraryWrites = true
        let settings = fixture.settings
        do {
            try await fixture.controller.attachAccount(identity: fixture.owner, settings: settings, key: nil, merge: true)
            XCTFail("Destination catalog must be durable before publishing a sign-in")
        } catch { }
        XCTAssertNil(fixture.controller.identity); XCTAssertNil(fixture.controller.settings)
        XCTAssertNil(fixture.store.accountID)
        XCTAssertEqual(fixture.store.vault.namespace, "")
        XCTAssertEqual(fixture.store.catalog.map(\.id), [fixture.guestMedia.id])
        XCTAssertNil(try fixture.markerVault.read("active-account"))
        XCTAssertEqual(try fixture.store.vault.credentials(fixture.source.id).endpoint, "https://fixture.invalid/library")
        XCTAssertEqual(try fixture.disk.load().media.map(\.id), [fixture.guestMedia.id])
    }

    func testSignInCorruptDestinationReadLeavesGuestScopeUntouched() async throws {
        let fixture = try TransitionFixture(signedIn: false)
        defer { fixture.cleanUp() }
        try Data("corrupt account ciphertext".utf8).write(to: fixture.disk.root.appendingPathComponent("library-\(fixture.owner.id).sealed"), options: .atomic)
        do { try await fixture.store.activateAccount(fixture.owner, mergeGuest: true); XCTFail("Expected destination decode failure") } catch { }
        XCTAssertNil(fixture.store.accountID)
        XCTAssertEqual(fixture.store.vault.namespace, "")
        XCTAssertEqual(fixture.store.catalog.map(\.id), [fixture.guestMedia.id])
        XCTAssertNil(try fixture.markerVault.read("active-account"))
    }

    func testSuccessfulAccountActivationPersistsMergedSnapshotBeforeScopeAndSurvivesRelaunch() async throws {
        let fixture = try TransitionFixture(signedIn: false)
        defer { fixture.cleanUp() }
        fixture.store.state.favorites = [fixture.guestMedia.id]
        fixture.store.state.progress[fixture.guestMedia.id] = WatchProgress(seconds: 88, duration: 1000)
        fixture.store.state.transfers = [Transfer(id: fixture.guestMedia.id, media: fixture.guestMedia, state: .ready, relativePath: "fixture.mp4")]
        try await fixture.store.activateAccount(fixture.owner, mergeGuest: true)
        XCTAssertEqual(fixture.store.accountID, fixture.owner.id)
        XCTAssertEqual(fixture.store.vault.namespace, fixture.owner.id.uuidString + ":")
        XCTAssertEqual(Set(fixture.store.catalog.map(\.id)), [fixture.guestMedia.id, fixture.accountMedia.id])
        XCTAssertEqual(try fixture.store.vault.credentials(fixture.source.id).endpoint, "https://fixture.invalid/library")
        let relaunched = AppStore(disk: fixture.disk, identityVault: fixture.markerVault, startServices: false)
        XCTAssertEqual(relaunched.accountID, fixture.owner.id)
        XCTAssertEqual(Set(relaunched.catalog.map(\.id)), [fixture.guestMedia.id, fixture.accountMedia.id])
        XCTAssertEqual(relaunched.state.progress[fixture.guestMedia.id]?.seconds, 88)
        XCTAssertEqual(relaunched.state.favorites, [fixture.guestMedia.id])
        XCTAssertEqual(relaunched.state.transfers.map(\.id), [fixture.guestMedia.id])
        XCTAssertTrue(try fixture.disk.load().transfers.isEmpty)
    }

    private func assertAccountScope(_ fixture: TransitionFixture, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(fixture.store.accountID, fixture.owner.id, file: file, line: line)
        XCTAssertEqual(fixture.store.vault.namespace, fixture.owner.id.uuidString + ":", file: file, line: line)
        XCTAssertEqual(fixture.store.catalog.map(\.id), [fixture.accountMedia.id], file: file, line: line)
        do {
            let marker = try XCTUnwrap(fixture.markerVault.read("active-account"))
            XCTAssertEqual(try JSONDecoder().decode(AccountIdentity.self, from: marker).id, fixture.owner.id, file: file, line: line)
        } catch { XCTFail("Active marker was changed: \(error)", file: file, line: line) }
    }
}

@MainActor private final class TransitionFixture {
    let owner = AccountIdentity(id: UUID(), email: "fixture@example.invalid")
    let markerVault = Vault(), diskVault = Vault(), sourceVault = Vault()
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let disk: LibraryFailureDisk
    let store: AppStore
    let controller: AccountController
    let source: MediaSource
    let guestMedia: Media
    let accountMedia: Media
    let settings: VaultSettings
    let syncRequests = TransitionSyncSpy()
    var sessionEnds = 0
    var onSessionEnd: (() throws -> Void)?

    init(signedIn: Bool, sessionOwnerID: UUID? = nil) throws {
        markerVault.namespace = "transition-marker-\(UUID()):"; diskVault.namespace = "transition-disk-\(UUID()):"
        disk = try LibraryFailureDisk(root: folder.appendingPathComponent("state"), mediaRoot: folder.appendingPathComponent("media"), vault: diskVault)
        source = MediaSource(name: "Fixture Source", kind: .jellyfin, host: "fixture.invalid")
        guestMedia = Media(id: "guest-title", sourceID: source.id, providerID: "guest", title: "Guest Fixture", kind: .movie)
        accountMedia = Media(id: "private-account-title", sourceID: source.id, providerID: "private", title: "Private Account Fixture", kind: .movie)
        var guest = LibrarySnapshot(), account = LibrarySnapshot()
        guest.sources = [source]; guest.media = [guestMedia]
        account.media = [accountMedia]
        try disk.save(guest); try disk.saveNamed(account, name: "library-\(owner.id)")
        settings = VaultSettings(user_id: owner.id, generation: UUID(), salt: "fixture", wrapped_key: "fixture", iterations: 600_000)
        if signedIn {
            try markerVault.write(JSONEncoder().encode(owner), key: "active-account")
            try markerVault.write(JSONEncoder().encode(settings), key: "cloud-settings-\(owner.id)")
            try markerVault.write(JSONEncoder().encode(CachedVaultKey(generation: settings.generation, key: Data(repeating: 7, count: 32))), key: "cloud-key-\(owner.id)")
        }
        try markerVault.write(Data("fixture-auth".utf8), key: "auth-oxa-account-session")
        store = AppStore(disk: disk, vault: sourceVault, identityVault: markerVault, startServices: false)
        try sourceVault.save(Credentials(endpoint: "https://fixture.invalid/library"), id: source.id)
        // Capture a separate box first; the actual callback is installed after
        // initialization so no partially initialized fixture escapes.
        let callback = TransitionCallback()
        let ownerID = sessionOwnerID ?? owner.id, generation = settings.generation, requests = syncRequests
        controller = AccountController(store: store, startAutomatically: false, endSession: { await callback.call() }, syncSession: { AccountSyncSession(ownerID: ownerID, accessToken: "fixture-access-token") }, sendSyncRequest: { request, session in
            requests.calls += 1
            return CloudReply(records: [], conflicts: [], generation: generation)
        })
        store.account = controller
        callback.action = { [weak self] in
            guard let self else { return }
            self.sessionEnds += 1
            do { try self.onSessionEnd?() } catch { XCTFail("Session callback failed: \(error)") }
        }
    }

    func cleanUp() {
        onSessionEnd = nil; store.account = nil
        try? FileManager.default.removeItem(at: folder)
        for key in ["active-account", "auth-oxa-account-session", "cloud-key-\(owner.id)", "cloud-settings-\(owner.id)", "probe"] { try? markerVault.remove(key) }
        try? diskVault.remove("catalog-key")
        let credentials = Vault()
        for namespace in ["", owner.id.uuidString + ":"] { credentials.namespace = namespace; try? credentials.remove(source.id.uuidString) }
    }
}

@MainActor private final class TransitionCallback {
    var action: (() -> Void)?
    func call() { action?() }
}

@MainActor private final class TransitionSyncSpy {
    var calls = 0
}

private final class LibraryFailureDisk: EncryptedDisk {
    private let failureLock = NSLock()
    private var fails = false
    var failAccountLibraryWrites: Bool {
        get { failureLock.lock(); defer { failureLock.unlock() }; return fails }
        set { failureLock.lock(); defer { failureLock.unlock() }; fails = newValue }
    }
    override func saveNamed<Value: Encodable>(_ value: Value, name: String) throws {
        if name.hasPrefix("library-"), failAccountLibraryWrites { throw NSError(domain: NSPOSIXErrorDomain, code: Int(ENOSPC)) }
        try super.saveNamed(value, name: name)
    }
}

@MainActor private final class SyncSessionSwitch {
    var owner: UUID
    var token: String
    init(owner: UUID, token: String) { self.owner = owner; self.token = token }
}

private final class CapturedSyncRequest: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: URLRequest?
    var request: URLRequest? { lock.lock(); defer { lock.unlock() }; return stored }
    func record(_ request: URLRequest) { lock.lock(); defer { lock.unlock() }; stored = request }
}
