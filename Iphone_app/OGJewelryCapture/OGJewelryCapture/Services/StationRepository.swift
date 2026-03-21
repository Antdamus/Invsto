import Foundation
import Supabase

struct StationRepository {
    private let client: SupabaseClient

    init(client: SupabaseClient = SupabaseService.shared) {
        self.client = client
    }

    func fetchAvailableStations() async throws -> [CaptureStation] {
        try await client
            .from("capture_stations")
            .select("id, name, active, assigned_employee_id, device_label, ios_device_identifier, last_seen_at")
            .eq("active", value: true)
            .order("name")
            .execute()
            .value
    }

    // TODO: Add a low-risk last_seen_at heartbeat in Phase 3 once station update rules are finalized.
}
