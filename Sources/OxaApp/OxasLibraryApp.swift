import SwiftUI
import UIKit

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String, completionHandler: @escaping () -> Void) {
        Task { @MainActor in BackgroundEvents.completions[identifier] = completionHandler }
    }
}
@main struct OxasLibraryApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @State private var store = AppStore()
    init() {
        URLCache.shared = URLCache(memoryCapacity: 32 * 1024 * 1024, diskCapacity: 0, diskPath: nil)
        let appearance = UITabBarAppearance(); appearance.configureWithOpaqueBackground(); appearance.backgroundColor = .black
        appearance.stackedLayoutAppearance.normal.iconColor = .lightGray
        appearance.stackedLayoutAppearance.normal.titleTextAttributes = [.foregroundColor: UIColor.lightGray]
        appearance.stackedLayoutAppearance.selected.iconColor = .white
        appearance.stackedLayoutAppearance.selected.titleTextAttributes = [.foregroundColor: UIColor.white]
        UITabBar.appearance().standardAppearance = appearance; UITabBar.appearance().scrollEdgeAppearance = appearance
        let navigation = UINavigationBarAppearance(); navigation.configureWithOpaqueBackground(); navigation.backgroundColor = .black
        navigation.titleTextAttributes = [.foregroundColor: UIColor.white]; navigation.largeTitleTextAttributes = [.foregroundColor: UIColor.white]
        UINavigationBar.appearance().standardAppearance = navigation; UINavigationBar.appearance().scrollEdgeAppearance = navigation
    }
    var body: some Scene {
        WindowGroup { RootView().environment(store).preferredColorScheme(.dark).environment(\.locale, Locale(identifier: "en")) }
    }
}
struct RootView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("hide-account-welcome") private var hideAccountWelcome = false
    @State private var showAccountWelcome = false
    @State private var consideredAccountWelcome = false
    var body: some View {
        @Bindable var store = store
        TabView(selection: $store.selectedTab) {
            NavigationStack { LibraryView() }.tabItem { Label("Library", systemImage: "rectangle.stack") }.tag(0)
            NavigationStack { SearchView() }.tabItem { Label("Search", systemImage: "magnifyingglass") }.tag(1)
            NavigationStack { IPTVView() }.tabItem { Label("IPTV", systemImage: "tv") }.tag(2)
            NavigationStack { DownloadsView() }.tabItem { Label("Downloads", systemImage: "arrow.down.circle") }.tag(3)
            NavigationStack { SettingsView() }.tabItem { Label("Settings", systemImage: "slider.horizontal.3") }.tag(4)
        }.tint(.white)
            .sheet(isPresented: $showAccountWelcome) { AccountWelcome().environment(store) }
            .sheet(isPresented: $store.showAddSource) { SourceEditor().environment(store) }
            .sheet(item: Binding(get: { store.playback == nil ? store.sourceSelection : nil }, set: { store.sourceSelection = $0 }), onDismiss: { store.presentPendingPlayback() }) { SourcePicker(selection: $0).environment(store) }
            .fullScreenCover(item: $store.playback) { playback in PlaybackScreen(playback: playback).environment(store) }
            .alert("Oxa’s Library", isPresented: Binding(get: { store.error != nil }, set: { if !$0 { store.error = nil } })) { Button("OK") { store.error = nil } } message: { Text(store.error ?? "") }
            .onAppear {
                guard !consideredAccountWelcome else { return }; consideredAccountWelcome = true
                let args = ProcessInfo.processInfo.arguments
                if (!hideAccountWelcome || args.contains("--ui-test-account-welcome")), store.account?.identity == nil, (!args.contains("--ui-test-reset") || args.contains("--ui-test-account-welcome")), !store.preview { showAccountWelcome = true }
            }
            .overlay { if store.preparingPlayback { ProgressView("Preparing playback…").padding(24).background(OxaTheme.raised, in: RoundedRectangle(cornerRadius: 20)) } }
            .onChange(of: scenePhase) { _, phase in if phase != .active { store.saveForBackground() } else { store.startRefresh(); Task { await store.account?.sync(); await store.checkForUpdate() } } }
            .task { await store.checkForUpdate() }
            .task { store.startRefresh(); while !Task.isCancelled { try? await Task.sleep(for: .seconds(ProcessInfo.processInfo.isLowPowerModeEnabled ? 120 : 30)); if scenePhase == .active { await store.account?.sync() } } }
    }
}

struct AccountWelcome: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @AppStorage("hide-account-welcome") private var hideAccountWelcome = false
    var body: some View {
        NavigationStack {
            Form {
                Section { OxaMark(size: 48).padding(.vertical, 16); Text("Your library, across devices").font(.title2.weight(.bold)); Text("Sign in to sync your sources, watchlist and viewing progress. An account is optional.").foregroundStyle(OxaTheme.secondary) }
                Section {
                    NavigationLink("Sign In") { AccountView().environment(store) }
                    NavigationLink("Create Account") { AccountView(initialMode: "signup").environment(store) }
                    Button("Continue Without Account") { dismiss() }.accessibilityIdentifier("welcome-guest")
                }
                Section { Toggle("Don’t show this message again", isOn: $hideAccountWelcome).tint(OxaTheme.accent) }
            }.scrollContentBackground(.hidden).background(.black).navigationTitle("Oxa’s Library").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        }.preferredColorScheme(.dark).tint(.white).onChange(of: store.account?.unlocked) { _, unlocked in if unlocked == true { dismiss() } }
    }
}
