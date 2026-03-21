import SwiftUI

struct ReadyView: View {
    let employee: AuthenticatedEmployee
    let station: CaptureStation
    let onChangeStation: () -> Void
    let onRefreshStations: () async -> Void
    let onSignOut: () async -> Void

    var body: some View {
        List {
            Section("Ready") {
                LabeledContent("Station", value: station.name)

                if let deviceLabel = station.deviceLabel, !deviceLabel.isEmpty {
                    LabeledContent("Device", value: deviceLabel)
                }

                Text("Capture flow is not enabled in this phase.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            Section("Operator") {
                LabeledContent("Employee", value: employee.displayName)
                LabeledContent("Email", value: employee.email)

                if let role = employee.role, !role.isEmpty {
                    LabeledContent("Role", value: role)
                }
            }

            Section {
                Button("Refresh Stations") {
                    Task {
                        await onRefreshStations()
                    }
                }

                Button("Change Station", role: .none) {
                    onChangeStation()
                }

                Button("Log Out", role: .destructive) {
                    Task {
                        await onSignOut()
                    }
                }
            }
        }
    }
}

#Preview {
    ReadyView(
        employee: AuthenticatedEmployee(
            employeeID: UUID(),
            userID: UUID(),
            email: "employee@example.com",
            displayName: "OG Employee",
            role: "employee"
        ),
        station: CaptureStation(
            id: UUID(),
            name: "Photo Table 1",
            active: true,
            assignedEmployeeID: nil,
            deviceLabel: "Front iPhone",
            iosDeviceIdentifier: nil,
            lastSeenAt: nil
        ),
        onChangeStation: {},
        onRefreshStations: {},
        onSignOut: {}
    )
}
