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
        ZStack {
            OGScreenBackground()

            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Select Station")
                            .font(.system(.largeTitle, design: .serif).weight(.bold))
                            .foregroundStyle(OGVisualStyle.textPrimary)

                        Text("Choose the active capture station for this device. The selection flow stays exactly the same.")
                            .font(.subheadline)
                            .foregroundStyle(OGVisualStyle.textSecondary)
                    }

                    VStack(alignment: .leading, spacing: 14) {
                        Text("Signed In")
                            .font(.headline.weight(.semibold))
                            .foregroundStyle(OGVisualStyle.textPrimary)

                        OGDetailRow(title: "Employee", value: employee.displayName)
                        OGDetailRow(title: "Email", value: employee.email)

                        if let role = employee.role, !role.isEmpty {
                            OGDetailRow(title: "Role", value: role)
                        }
                    }
                    .ogCard()

                    VStack(alignment: .leading, spacing: 14) {
                        HStack {
                            Text("Available Stations")
                                .font(.headline.weight(.semibold))
                                .foregroundStyle(OGVisualStyle.textPrimary)

                            Spacer()

                            if !stations.isEmpty {
                                Text("\(stations.count)")
                                    .font(.footnote.weight(.semibold))
                                    .foregroundStyle(OGVisualStyle.goldSoft)
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 6)
                                    .background(OGVisualStyle.gold.opacity(0.14), in: Capsule())
                            }
                        }

                        if isLoading && stations.isEmpty {
                            ProgressView("Loading stations…")
                                .tint(OGVisualStyle.gold)
                                .foregroundStyle(OGVisualStyle.textSecondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.vertical, 8)
                        } else if stations.isEmpty {
                            Text("No active stations are available.")
                                .font(.subheadline)
                                .foregroundStyle(OGVisualStyle.textSecondary)

                            Button("Refresh") {
                                Task {
                                    await onRetry()
                                }
                            }
                            .buttonStyle(OGActionButtonStyle(role: .secondary))
                        } else {
                            VStack(spacing: 12) {
                                ForEach(stations) { station in
                                    Button {
                                        onSelectStation(station)
                                    } label: {
                                        HStack(alignment: .center, spacing: 14) {
                                            VStack(alignment: .leading, spacing: 6) {
                                                Text(station.name)
                                                    .font(.headline.weight(.semibold))
                                                    .foregroundStyle(OGVisualStyle.textPrimary)

                                                if let deviceLabel = station.deviceLabel, !deviceLabel.isEmpty {
                                                    Text(deviceLabel)
                                                        .font(.footnote)
                                                        .foregroundStyle(OGVisualStyle.textSecondary)
                                                } else {
                                                    Text("Ready for assignment")
                                                        .font(.footnote)
                                                        .foregroundStyle(OGVisualStyle.textSecondary)
                                                }
                                            }

                                            Spacer()

                                            Image(systemName: "chevron.right")
                                                .font(.footnote.weight(.bold))
                                                .foregroundStyle(OGVisualStyle.goldSoft)
                                        }
                                        .padding(16)
                                        .background(
                                            RoundedRectangle(cornerRadius: 18, style: .continuous)
                                                .fill(OGVisualStyle.panelElevated)
                                                .overlay(
                                                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                                                        .stroke(OGVisualStyle.strokeStrong, lineWidth: 1)
                                                )
                                        )
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }
                    }
                    .ogCard(elevated: true)

                    if let errorMessage {
                        Text(errorMessage)
                            .font(.footnote)
                            .foregroundStyle(Color.red.opacity(0.92))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(14)
                            .background(
                                RoundedRectangle(cornerRadius: 16, style: .continuous)
                                    .fill(OGVisualStyle.destructive.opacity(0.12))
                                    .overlay(
                                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                                            .stroke(OGVisualStyle.destructive.opacity(0.32), lineWidth: 1)
                                    )
                            )
                    }

                    VStack(spacing: 12) {
                        Button("Refresh") {
                            Task {
                                await onRetry()
                            }
                        }
                        .buttonStyle(OGActionButtonStyle(role: .secondary))

                        Button("Log Out") {
                            Task {
                                await onSignOut()
                            }
                        }
                        .buttonStyle(OGActionButtonStyle(role: .destructive))
                    }
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 24)
            }
        }
        .navigationTitle("OG Capture")
        .navigationBarTitleDisplayMode(.inline)
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
