import Foundation
import Supabase

struct CaptureJobRepository {
    enum RepositoryError: LocalizedError {
        case transitionRejected

        var errorDescription: String? {
            switch self {
            case .transitionRejected:
                "The capture job lifecycle update was rejected."
            }
        }
    }

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

    func claimJobForCapture(id: UUID) async throws -> Bool {
        return try await updateLifecycle(
            jobID: id,
            targetStatus: .capturing
        )
    }

    func markUploading(id: UUID, captureCompletedAt: Date) async throws -> Bool {
        return try await updateLifecycle(
            jobID: id,
            targetStatus: .uploading,
            captureCompletedAt: captureCompletedAt
        )
    }

    func markCompleted(id: UUID, uploadResult: CapturePhotoUploadService.UploadResult) async throws -> Bool {
        return try await updateLifecycle(
            jobID: id,
            targetStatus: .completed,
            storageBucket: uploadResult.bucket,
            storagePath: uploadResult.path,
            fileSizeBytes: uploadResult.fileSizeBytes,
            mimeType: uploadResult.mimeType,
            uploadCompletedAt: uploadResult.uploadedAt
        )
    }

    func markFailed(id: UUID, code: String, message: String) async throws -> Bool {
        return try await updateLifecycle(
            jobID: id,
            targetStatus: .failed,
            failureCode: code,
            failureMessage: message
        )
    }

    private func updateLifecycle(
        jobID: UUID,
        targetStatus: CaptureJobStatus,
        failureCode: String? = nil,
        failureMessage: String? = nil,
        storageBucket: String? = nil,
        storagePath: String? = nil,
        fileSizeBytes: Int64? = nil,
        mimeType: String? = nil,
        captureCompletedAt: Date? = nil,
        uploadCompletedAt: Date? = nil
    ) async throws -> Bool {
        let params = UpdateCaptureJobLifecycleParams(
            jobID: jobID,
            targetStatus: targetStatus.rawValue,
            failureCode: failureCode,
            failureMessage: failureMessage,
            storageBucket: storageBucket,
            storagePath: storagePath,
            fileSizeBytes: fileSizeBytes,
            mimeType: mimeType,
            captureCompletedAt: captureCompletedAt,
            uploadCompletedAt: uploadCompletedAt
        )

        return try await client
            .rpc("update_capture_job_lifecycle", params: params)
            .execute()
            .value
    }
}

private struct UpdateCaptureJobLifecycleParams: Encodable, Sendable {
    let jobID: UUID
    let targetStatus: String
    let failureCode: String?
    let failureMessage: String?
    let storageBucket: String?
    let storagePath: String?
    let fileSizeBytes: Int64?
    let mimeType: String?
    let captureCompletedAt: Date?
    let uploadCompletedAt: Date?

    private enum CodingKeys: String, CodingKey {
        case jobID = "_job_id"
        case targetStatus = "_target_status"
        case failureCode = "_failure_code"
        case failureMessage = "_failure_message"
        case storageBucket = "_storage_bucket"
        case storagePath = "_storage_path"
        case fileSizeBytes = "_file_size_bytes"
        case mimeType = "_mime_type"
        case captureCompletedAt = "_capture_completed_at"
        case uploadCompletedAt = "_upload_completed_at"
    }

    nonisolated func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(jobID, forKey: .jobID)
        try container.encode(targetStatus, forKey: .targetStatus)
        try container.encodeIfPresent(failureCode, forKey: .failureCode)
        try container.encodeIfPresent(failureMessage, forKey: .failureMessage)
        try container.encodeIfPresent(storageBucket, forKey: .storageBucket)
        try container.encodeIfPresent(storagePath, forKey: .storagePath)
        try container.encodeIfPresent(fileSizeBytes, forKey: .fileSizeBytes)
        try container.encodeIfPresent(mimeType, forKey: .mimeType)
        try container.encodeIfPresent(captureCompletedAt, forKey: .captureCompletedAt)
        try container.encodeIfPresent(uploadCompletedAt, forKey: .uploadCompletedAt)
    }
}
