import SwiftUI

struct AppRootView: View {
    @EnvironmentObject private var authViewModel: AuthViewModel

    var body: some View {
        ZStack {
            OGScreenBackground()

            Group {
                switch authViewModel.state {
                case .loading:
                    VStack(spacing: 16) {
                        ProgressView()
                            .tint(OGVisualStyle.gold)
                            .scaleEffect(1.2)

                        Text("Checking session…")
                            .font(.headline)
                            .foregroundStyle(OGVisualStyle.textPrimary)
                    }
                    .ogCard(elevated: true, padding: 28)
                    .padding(.horizontal, 24)
                case .signedOut:
                    LoginView()
                case let .authenticated(employee):
                    AuthenticatedView(employee: employee)
                }
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
