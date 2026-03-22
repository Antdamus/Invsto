import SwiftUI

struct ReadyView: View {
    @StateObject private var viewModel: ReadyViewModel

    let onChangeStation: () -> Void
    let onRefreshStations: () async -> Void
    let onSignOut: () async -> Void

    init(
        employee: AuthenticatedEmployee,
        station: CaptureStation,
        onChangeStation: @escaping () -> Void,
        onRefreshStations: @escaping () async -> Void,
        onSignOut: @escaping () async -> Void
    ) {
        _viewModel = StateObject(wrappedValue: ReadyViewModel(employee: employee, station: station))
        self.onChangeStation = onChangeStation
        self.onRefreshStations = onRefreshStations
        self.onSignOut = onSignOut
    }

    var body: some View {
        List {
            Section("Listener") {
                LabeledContent("Station", value: viewModel.station.name)
                LabeledContent("Employee", value: viewModel.employee.displayName)
                LabeledContent("Connection", value: viewModel.listenerState.label)
                LabeledContent("Capture State", value: viewModel.captureState.label)
                LabeledContent("Camera", value: viewModel.cameraAvailability.label)

                if let role = viewModel.employee.role, !role.isEmpty {
                    LabeledContent("Role", value: role)
                }

                if let deviceLabel = viewModel.station.deviceLabel, !deviceLabel.isEmpty {
                    LabeledContent("Device", value: deviceLabel)
                }
            }

            if shouldShowPreview, let session = viewModel.previewSession {
                Section("Live Preview") {
                    CameraPreviewView(session: session)
                        .frame(height: 320)
                        .clipShape(RoundedRectangle(cornerRadius: 16))
                        .listRowInsets(EdgeInsets(top: 12, leading: 16, bottom: 12, trailing: 16))
                }
            }

            if let latestUploadResult = viewModel.latestUploadResult {
                Section("Latest Result") {
                    if let image = latestUploadResult.previewImage {
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFit()
                            .clipShape(RoundedRectangle(cornerRadius: 16))
                    }

                    LabeledContent("Job", value: String(latestUploadResult.jobID.uuidString.prefix(8)).uppercased())
                    LabeledContent("Captured", value: latestUploadResult.capturedAt.formatted(date: .abbreviated, time: .standard))
                    LabeledContent("Uploaded", value: latestUploadResult.uploadedAt.formatted(date: .abbreviated, time: .standard))
                    LabeledContent("Bucket", value: latestUploadResult.storageBucket)
                    LabeledContent("Path", value: latestUploadResult.storagePathSummary)
                    LabeledContent("Bytes", value: ByteCountFormatter.string(fromByteCount: latestUploadResult.fileSizeBytes, countStyle: .file))
                    LabeledContent("Type", value: latestUploadResult.mimeType)

                    if latestUploadResult.isSimulatorFallback {
                        Text("Captured using the simulator fallback path.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            } else if let latestLocalResult = viewModel.latestLocalResult {
                Section("Latest Capture") {
                    if let image = latestLocalResult.previewImage {
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFit()
                            .clipShape(RoundedRectangle(cornerRadius: 16))
                    }

                    LabeledContent("Job", value: String(latestLocalResult.jobID.uuidString.prefix(8)).uppercased())
                    LabeledContent("Captured", value: latestLocalResult.capturedAt.formatted(date: .abbreviated, time: .standard))
                    LabeledContent("Bytes", value: ByteCountFormatter.string(fromByteCount: Int64(latestLocalResult.fileSizeBytes), countStyle: .file))
                }
            }

            if case let .failed(jobID, message) = viewModel.captureState {
                Section("Capture Error") {
                    if let jobID {
                        LabeledContent("Job", value: String(jobID.uuidString.prefix(8)).uppercased())
                    }

                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            }

            Section {
                Button("Refresh Listener / Jobs") {
                    Task {
                        await onRefreshStations()
                        await viewModel.refreshPendingJob()
                    }
                }

#if DEBUG
                Button("Simulate Capture Request") {
                    Task {
                        await viewModel.simulateCaptureRequest()
                    }
                }
#endif

                Button("Change Station") {
                    onChangeStation()
                }

                Button("Log Out", role: .destructive) {
                    Task {
                        await onSignOut()
                    }
                }
            }
        }
        .task {
            await viewModel.start()
        }
        .onDisappear {
            Task {
                await viewModel.stop()
            }
        }
    }

    private var shouldShowPreview: Bool {
        switch viewModel.captureState {
        case .captureRequested, .capturing:
            true
        case .idle, .listening, .uploading, .completed, .failed:
            false
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
