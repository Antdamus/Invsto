import SwiftUI

struct AppRootView: View {
    @EnvironmentObject private var authViewModel: AuthViewModel

    var body: some View {
        Group {
            switch authViewModel.state {
            case .loading:
                ProgressView("Checking session…")
            case .signedOut:
                LoginView()
            case let .authenticated(employee):
                AuthenticatedView(employee: employee)
            }
        }
        .task {
            if case .loading = authViewModel.state {
                await authViewModel.bootstrap()
            }
        }
    }
}

#Preview {
    AppRootView()
        .environmentObject(AuthViewModel())
        .environmentObject(StationViewModel())
}
