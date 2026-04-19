import SwiftUI

struct AuthenticatedView: View {
    @EnvironmentObject private var authViewModel: AuthViewModel
    @EnvironmentObject private var stationViewModel: StationViewModel

    let employee: AuthenticatedEmployee

    var body: some View {
        NavigationStack {
            Group {
                if let selectedStation = stationViewModel.selectedStation {
                    ReadyView(
                        employee: employee,
                        station: selectedStation,
                        onChangeStation: {
                            stationViewModel.clearSelection()
                        },
                        onRefreshStations: {
                            await stationViewModel.refreshStations()
                        },
                        onSignOut: {
                            await authViewModel.signOut()
                        }
                    )
                } else {
                    StationSelectionView(
                        employee: employee,
                        stations: stationViewModel.stations,
                        isLoading: stationViewModel.isLoading,
                        errorMessage: stationViewModel.errorMessage,
                        onSelectStation: { station in
                            stationViewModel.selectStation(station)
                        },
                        onRetry: {
                            await stationViewModel.refreshStations()
                        },
                        onSignOut: {
                            await authViewModel.signOut()
                        }
                    )
                }
            }
            .navigationTitle("OG Capture")
            .navigationBarTitleDisplayMode(.inline)
        }
        .task {
            await stationViewModel.bootstrap()
        }
    }
}

#Preview {
    AuthenticatedView(
        employee: AuthenticatedEmployee(
            employeeID: UUID(),
            userID: UUID(),
            email: "employee@example.com",
            displayName: "OG Employee",
            role: "employee"
        )
    )
    .environmentObject(AuthViewModel())
    .environmentObject(StationViewModel())
}
