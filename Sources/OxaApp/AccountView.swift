import SwiftUI
import Supabase

struct AccountView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var mode = "signin"
    @State private var email = ""
    @State private var password = ""
    @State private var code = ""
    @State private var libraryPassword = ""
    @State private var includeLocal = true
    @State private var message: String?
    @State private var resendAfter = Date.distantPast
    @State private var deleting = false
    @State private var changingPassword = false
    init(initialMode: String = "signin") { _mode = State(initialValue: initialMode) }
    var body: some View {
        let account = store.account!
        Form {
            if !CloudConfiguration.isConfigured {
                Section { Text("Account services are not configured in this build. You can use your library and downloads without an account.") }
            } else if let identity = account.identity {
                Section {
                    Text(identity.email).font(.headline)
                    LabeledContent("Sync", value: account.syncing ? "Syncing…" : account.unlocked ? "Ready" : "Waiting for connection")
                    if let date = account.lastSync { LabeledContent("Last synced", value: date.formatted(date: .abbreviated, time: .shortened)) }
                    if account.pendingCount > 0 { LabeledContent("Pending changes", value: String(account.pendingCount)) }
                    Button("Sync Now") { run { await account.sync() } }.disabled(account.busy || account.syncing || !account.unlocked)
                } footer: { Text("Sources and server logins, watchlist and viewing history sync across your devices. Downloaded videos stay on this iPhone. Your server must still be reachable from the current network.") }
                if let notice = account.message { Section { Text(notice).font(.subheadline).foregroundStyle(OxaTheme.secondary) } }
                Section {
                    Button("Change Password") { changingPassword = true }.disabled(account.busy || !account.unlocked)
                    Button("Sign Out") { run { try await account.signOut() } }.disabled(account.busy)
                    Button("Delete Account", role: .destructive) { deleting = true }.disabled(account.busy)
                }
            } else {
                Section {
                    Text("Your library, across devices").font(.title3.weight(.semibold))
                    Text("An account is optional. Sync your connections, watchlist and where you stopped watching. You can always use this app without one.").font(.subheadline).foregroundStyle(OxaTheme.secondary)
                }
                Section {
                    TextField("Email", text: $email).keyboardType(.emailAddress).textContentType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled().accessibilityIdentifier("account-email")
                    if ["signin", "signup", "verify", "reset"].contains(mode) {
                        SecureField(mode == "reset" ? "New password" : "Password", text: $password).textContentType(mode == "signup" || mode == "reset" ? .newPassword : .password).accessibilityIdentifier("account-password")
                    }
                    if mode == "verify" || mode == "reset" {
                        TextField("Verification code", text: $code).keyboardType(.numberPad).textContentType(.oneTimeCode).onChange(of: code) { _, value in code = String(value.filter(\.isNumber).prefix(8)) }.accessibilityIdentifier("account-code")
                    }
                    if mode == "signin" || mode == "signup" || mode == "verify" { Toggle("Include this iPhone’s library", isOn: $includeLocal).tint(OxaTheme.accent) }
                    Button(actionTitle) { submit() }.fontWeight(.semibold).frame(minHeight: 32).disabled(account.busy || !validEmail || (["verify", "reset"].contains(mode) && code.count < 6)).accessibilityIdentifier("account-submit")
                    if mode == "verify" || mode == "reset" {
                        TimelineView(.periodic(from: .now, by: 1)) { context in
                            Button("Send code again") { resend() }.disabled(account.busy || context.date < resendAfter)
                        }
                    }
                } header: { Text(formTitle) } footer: {
                    if mode == "signup" || mode == "reset" { Text("Use at least 10 characters. Resetting your password keeps your sources, watchlist and viewing history.") }
                    else if mode == "verify" { Text("If registration is available for this address, check your email for a code. Enter the password you used to register.") }
                }
                if !account.emailReady {
                    Section { Text("Account emails aren’t available yet. You can keep using your local library without an account.").font(.subheadline).foregroundStyle(OxaTheme.secondary) }
                }
                Section {
                    if mode == "signin" {
                        Button("Create Account") { mode = "signup"; message = nil }
                        Button("Forgot Password?") { mode = "recovery"; password = ""; message = nil }
                    } else { Button("Back to Sign In") { mode = "signin"; code = ""; message = nil } }
                    Button("Continue Without Account") { dismiss() }
                }
            }
            if account.busy { Section { ProgressView("Please wait…") } }
            if let message { Section { Text(message).font(.subheadline).accessibilityIdentifier("account-message") } }
        }.scrollDismissesKeyboard(.interactively).scrollContentBackground(.hidden).background(.black).tint(.white)
            .navigationTitle("Account").navigationBarTitleDisplayMode(.inline)
            .task { await account.refreshReadiness() }
            .sheet(isPresented: $changingPassword) { ChangePasswordView().environment(store) }
            .confirmationDialog("Delete your account, synced library and this account’s downloaded media? This cannot be undone. Your guest library is kept.", isPresented: $deleting, titleVisibility: .visible) { Button("Delete Account", role: .destructive) { run { try await account.deleteAccount() } } }
    }
    private var validEmail: Bool { email.contains("@") && email.contains(".") && email.count <= 254 }
    private var formTitle: String { switch mode { case "signup": "Create account"; case "verify": "Confirm your email"; case "recovery": "Reset password"; case "reset": "Enter recovery code"; default: "Sign in with email" } }
    private var actionTitle: String { switch mode { case "signup": "Send Verification Code"; case "verify": "Verify & Sign In"; case "recovery": "Send Recovery Code"; case "reset": "Reset Password"; default: "Sign In" } }
    private func run(_ action: @escaping @MainActor () async throws -> Void) {
        let account = store.account!; guard !account.busy else { return }; account.busy = true; message = nil
        Task {
            do { try await action() }
            catch { message = account.userMessage(error) }
            account.busy = false
        }
    }
    private func submit() {
        let account = store.account!
        run {
            let email = email.trimmingCharacters(in: .whitespacesAndNewlines)
            switch mode {
            case "signup": try await account.signUp(email: email, password: password); mode = "verify"; resendAfter = .now.addingTimeInterval(60)
            case "verify": try await account.verifySignup(email: email, code: code, password: password, merge: includeLocal); password = ""; code = ""
            case "recovery": try await account.requestRecovery(email: email); mode = "reset"; resendAfter = .now.addingTimeInterval(60); message = "If recovery is available for this address, a code has been sent."
            case "reset": try await account.recover(email: email, code: code, newPassword: password); password = ""; code = ""
            default: try await account.signIn(email: email, password: password, merge: includeLocal); password = ""
            }
        }
    }
    private func resend() { run { if mode == "verify" { try await store.account.resendSignup(email: email) } else { try await store.account.requestRecovery(email: email) }; resendAfter = .now.addingTimeInterval(60); message = "If available, a new code has been sent." } }
}
struct ChangePasswordView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var current = ""
    @State private var password = ""
    @State private var busy = false
    @State private var message: String?
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    SecureField("Current password", text: $current).textContentType(.password)
                    SecureField("New password", text: $password).textContentType(.newPassword)
                    Text("Use at least 10 characters. Your library stays available after a password change.").font(.subheadline).foregroundStyle(OxaTheme.secondary)
                    Button(busy ? "Updating…" : "Update Password") {
                        busy = true
                        Task {
                            do { try await store.account.changePassword(current: current, new: password); dismiss() }
                            catch { message = store.account.userMessage(error) }
                            busy = false
                        }
                    }.disabled(busy || current.isEmpty || password.count < 10)
                    if let message { Text(message) }
                }
            }.scrollContentBackground(.hidden).background(.black).navigationTitle("Change Password").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(busy) } }
                .interactiveDismissDisabled(busy)
        }.preferredColorScheme(.dark).tint(.white)
    }
}
