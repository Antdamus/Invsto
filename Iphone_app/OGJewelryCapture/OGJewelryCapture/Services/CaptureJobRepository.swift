import Foundation
import Supabase

struct CaptureJobRepository {
    private let client: SupabaseClient

    init(client: SupabaseClient = SupabaseService.shared) {
        self.client = client
    }

    func fetchNextPendingJob(for stationID: UUID) async throws -> CaptureJob? {
        let jobs: [CaptureJob] = try await client
            .from("capture_jobs")
            .select("""
                id,
                requested_by,
                station_id,
                status,
                requested_at,
                claimed_at,
                capture_started_at,
                capture_completed_at,
                upload_completed_at,
                storage_bucket,
                storage_path,
                file_size_bytes,
                mime_type,
                failure_code,
                failure_message,
                control_payload,
                result_payload,
                created_at,
                updated_at
                """)
            .eq("station_id", value: stationID)
            .in("status", values: [CaptureJobStatus.queued.rawValue, CaptureJobStatus.assigned.rawValue])
            .order("requested_at", ascending: true)
            .limit(1)
            .execute()
            .value

        return jobs.first
    }

    func fetchJob(id: UUID) async throws -> CaptureJob? {
        let jobs: [CaptureJob] = try await client
            .from("capture_jobs")
            .select("""
                id,
                requested_by,
                station_id,
                status,
                requested_at,
                claimed_at,
                capture_started_at,
                capture_completed_at,
                upload_completed_at,
                storage_bucket,
                storage_path,
                file_size_bytes,
                mime_type,
                failure_code,
                failure_message,
                control_payload,
                result_payload,
                created_at,
                updated_at
                """)
            .eq("id", value: id)
            .limit(1)
            .execute()
            .value

        return jobs.first
    }
}
