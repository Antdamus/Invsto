import Foundation
import Supabase

enum CaptureListenerState: Equatable {
    case idle
    case connecting
    case listening
    case disconnected
    case error(String)

    var label: String {
        switch self {
        case .idle:
            "Idle"
        case .connecting:
            "Connecting"
        case .listening:
            "Listening"
        case .disconnected:
            "Disconnected"
        case let .error(message):
            "Error: \(message)"
        }
    }
}

actor CaptureJobListener {
    private let client: SupabaseClient
    private let repository: CaptureJobRepository

    private var channel: RealtimeChannelV2?
    private var statusTask: Task<Void, Never>?
    private var insertTask: Task<Void, Never>?
    private var updateTask: Task<Void, Never>?

    init(
        client: SupabaseClient = SupabaseService.shared,
        repository: CaptureJobRepository = CaptureJobRepository()
    ) {
        self.client = client
        self.repository = repository
    }

    func startListening(
        stationID: UUID,
        onStateChange: @escaping @Sendable (CaptureListenerState) -> Void,
        onJobDetected: @escaping @Sendable (CaptureJob) -> Void
    ) async {
        await stopListening()

        onStateChange(.connecting)

        let channelName = "capture-jobs-\(stationID.uuidString.lowercased())"
        let channel = client.channel(channelName)
        let filter = RealtimePostgresFilter.eq("station_id", value: stationID)
        let insertions = channel.postgresChange(
            InsertAction.self,
            schema: "public",
            table: "capture_jobs",
            filter: filter
        )
        let updates = channel.postgresChange(
            UpdateAction.self,
            schema: "public",
            table: "capture_jobs",
            filter: filter
        )

        self.channel = channel

        statusTask = Task {
            for await status in channel.statusChange {
                switch status {
                case .unsubscribed:
                    onStateChange(.disconnected)
                case .subscribing:
                    onStateChange(.connecting)
                case .subscribed:
                    onStateChange(.listening)
                case .unsubscribing:
                    onStateChange(.disconnected)
                }
            }
        }

        insertTask = Task {
            for await action in insertions {
                await self.handleActionRecord(action.record, onJobDetected: onJobDetected)
            }
        }

        updateTask = Task {
            for await action in updates {
                await self.handleActionRecord(action.record, onJobDetected: onJobDetected)
            }
        }

        do {
            try await channel.subscribeWithError()
        } catch {
            onStateChange(.error(error.localizedDescription))
        }
    }

    func stopListening() async {
        statusTask?.cancel()
        insertTask?.cancel()
        updateTask?.cancel()
        statusTask = nil
        insertTask = nil
        updateTask = nil

        if let channel {
            await client.removeChannel(channel)
        }

        channel = nil
    }

    private func handleActionRecord(
        _ record: [String: AnyJSON],
        onJobDetected: @escaping @Sendable (CaptureJob) -> Void
    ) async {
        guard
            let idString = record["id"]?.stringValue,
            let jobID = UUID(uuidString: idString),
            let job = try? await repository.fetchJob(id: jobID),
            job.isCaptureRequestCandidate
        else {
            return
        }

        onJobDetected(job)
    }
}
