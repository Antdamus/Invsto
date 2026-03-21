import SwiftUI

@main
struct OGJewelryCaptureApp: App {
    @StateObject private var authViewModel = AuthViewModel()
    @StateObject private var stationViewModel = StationViewModel()

    var body: some Scene {
        WindowGroup {
            AppRootView()
                .environmentObject(authViewModel)
                .environmentObject(stationViewModel)
        }
    }
}
