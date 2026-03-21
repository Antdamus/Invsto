import SwiftUI

@main
struct OGJewelryCaptureApp: App {
    @StateObject private var authViewModel = AuthViewModel()

    var body: some Scene {
        WindowGroup {
            AppRootView()
                .environmentObject(authViewModel)
        }
    }
}
