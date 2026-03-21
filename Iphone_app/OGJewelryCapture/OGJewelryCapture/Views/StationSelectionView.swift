import SwiftUI

struct StationSelectionView: View {
    let employee: AuthenticatedEmployee
    let stations: [CaptureStation]
    let isLoading: Bool
    let errorMessage: String?
    let onSelectStation: (CaptureStation) -> Void
    let onRetry: () async -> Void
    let onSignOut: () async -> Void

    var body: some View {
        List {
            Section("Signed In") {
                LabeledContent("Employee", value: employee.displayName)
                LabeledContent("Email", value: employee.email)

                if let role = employee.role, !role.isEmpty {
                    LabeledContent("Role", value: role)
                }
            }

            Section("Select Station") {
                if isLoading && stations.isEmpty {
                    ProgressView("Loading stations…")
                } else if stations.isEmpty {
                    Text("No active stations are available.")
                        .foregroundStyle(.secondary)

                    Button("Reload Stations") {
                        Task {
                            await onRetry()
                        }
                    }
                } else {
                    ForEach(stations) { station in
                        Button {
                            onSelectStation(station)
                        } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(station.name)
                                    .foregroundStyle(.primary)

                                if let deviceLabel = station.deviceLabel, !deviceLabel.isEmpty {
                                    Text(deviceLabel)
                                        .font(.footnote)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
            }

            if let errorMessage {
                Section {
                    Text(errorMessage)
                        .foregroundStyle(.red)
                }
            }

            Section {
                Button("Log Out") {
                    Task {
                        await onSignOut()
                    }
                }
            }
        }
    }
}

#Preview {
    StationSelectionView(
        employee: AuthenticatedEmployee(
            employeeID: UUID(),
            userID: UUID(),
            email: "employee@example.com",
            displayName: "OG Employee",
            role: "employee"
        ),
        stations: [
            CaptureStation(
                id: UUID(),
                name: "Photo Table 1",
                active: true,
                assignedEmployeeID: nil,
                deviceLabel: "Front iPhone",
                iosDeviceIdentifier: nil,
                lastSeenAt: nil
            )
        ],
        isLoading: false,
        errorMessage: nil,
        onSelectStation: { _ in },
        onRetry: {},
        onSignOut: {}
    )
}
