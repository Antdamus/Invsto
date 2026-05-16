import Foundation
import Supabase

struct CaptureJobRepository {
    enum RepositoryError: LocalizedError {
        case transitionRejected
        case invalidUploadingState
        case lifecycleRejected(targetStatus: CaptureJobStatus)

        var errorDescription: String? {
            switch self {
            case .transitionRejected:
                "The capture job lifecycle update was rejected."
            case .invalidUploadingState:
                "The capture job is not in a retryable uploading state for this multi-photo finalization attempt."
            case let .lifecycleRejected(targetStatus):
                "The server rejected the \(targetStatus.rawValue) lifecycle update for this capture job."
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

    func claimNewestCaptureJobForStation(stationID: UUID) async throws -> CaptureJob? {
        let params = ClaimNewestCaptureJobForStationParams(stationID: stationID)

        do {
            let claimResults: [ClaimNewestCaptureJobForStationResponse] = try await client
                .rpc("claim_newest_capture_job_for_station", params: params)
                .execute()
                .value

            guard let claimResult = claimResults.first else {
                return nil
            }

            guard let job = try await fetchJob(id: claimResult.jobID) else {
                throw RepositoryError.transitionRejected
            }

            return job
        } catch let error as PostgrestError where Self.isNoClaimableJobError(error) {
            return nil
        }
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
        let accepted = try await updateLifecycle(
            jobID: id,
            targetStatus: .failed,
            failureCode: code,
            failureMessage: message
        )

        guard accepted else {
            throw RepositoryError.lifecycleRejected(targetStatus: .failed)
        }

        return true
    }

    func ensureUploadingForMultiPhotoRetry(id: UUID, captureCompletedAt: Date) async throws -> Bool {
        if try await markUploading(id: id, captureCompletedAt: captureCompletedAt) {
            return true
        }

        guard let job = try await fetchJob(id: id), job.status == .uploading else {
            throw RepositoryError.invalidUploadingState
        }

        return true
    }

    func recordCaptureJobPhoto(
        jobID: UUID,
        sortOrder: Int,
        isPrimary: Bool,
        storageBucket: String,
        storagePath: String,
        fileSizeBytes: Int64,
        imageWidth: Int?,
        imageHeight: Int?,
        mimeType: String,
        label: String? = nil
    ) async throws -> Bool {
        let params = RecordCaptureJobPhotoParams(
            jobID: jobID,
            sortOrder: sortOrder,
            isPrimary: isPrimary,
            storageBucket: storageBucket,
            storagePath: storagePath,
            fileSizeBytes: fileSizeBytes,
            imageWidth: imageWidth,
            imageHeight: imageHeight,
            mimeType: mimeType,
            label: label
        )

        return try await client
            .rpc("record_capture_job_photo", params: params)
            .execute()
            .value
    }

    func completeCaptureJobMultiPhoto(
        jobID: UUID,
        expectedPhotoCount: Int,
        uploadCompletedAt: Date
    ) async throws -> Bool {
        let params = CompleteCaptureJobMultiPhotoParams(
            jobID: jobID,
            expectedPhotoCount: expectedPhotoCount,
            uploadCompletedAt: uploadCompletedAt
        )

        return try await client
            .rpc("complete_capture_job_multi_photo", params: params)
            .execute()
            .value
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

    private static func isNoClaimableJobError(_ error: PostgrestError) -> Bool {
        if error.code == "PGRST116" || error.code == "P0002" {
            return true
        }

        let message = error.message.lowercased()
        return message.contains("no claimable")
            || message.contains("no pending")
            || message.contains("no queued")
            || message.contains("no capture job")
            || message.contains("not_found")
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

private struct ClaimNewestCaptureJobForStationParams: Encodable, Sendable {
    let stationID: UUID

    private enum CodingKeys: String, CodingKey {
        case stationID = "_station_id"
    }

    nonisolated func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(stationID, forKey: .stationID)
    }
}

private struct ClaimNewestCaptureJobForStationResponse: Decodable, Sendable {
    let jobID: UUID
    let stationID: UUID
    let status: CaptureJobStatus
    let requestedAt: Date
    let targetSwitched: Bool
    let originalActiveJobID: UUID?
    let supersededCount: Int
    let message: String?

    private enum CodingKeys: String, CodingKey {
        case jobID = "job_id"
        case stationID = "station_id"
        case status
        case requestedAt = "requested_at"
        case targetSwitched = "target_switched"
        case originalActiveJobID = "original_active_job_id"
        case supersededCount = "superseded_count"
        case message
    }
}

private struct RecordCaptureJobPhotoParams: Encodable, Sendable {
    let jobID: UUID
    let sortOrder: Int
    let isPrimary: Bool
    let storageBucket: String
    let storagePath: String
    let fileSizeBytes: Int64
    let imageWidth: Int?
    let imageHeight: Int?
    let mimeType: String
    let label: String?

    private enum CodingKeys: String, CodingKey {
        case jobID = "_job_id"
        case sortOrder = "_sort_order"
        case isPrimary = "_is_primary"
        case storageBucket = "_storage_bucket"
        case storagePath = "_storage_path"
        case fileSizeBytes = "_file_size_bytes"
        case imageWidth = "_image_width"
        case imageHeight = "_image_height"
        case mimeType = "_mime_type"
        case label = "_label"
    }

    nonisolated func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(jobID, forKey: .jobID)
        try container.encode(sortOrder, forKey: .sortOrder)
        try container.encode(isPrimary, forKey: .isPrimary)
        try container.encode(storageBucket, forKey: .storageBucket)
        try container.encode(storagePath, forKey: .storagePath)
        try container.encode(fileSizeBytes, forKey: .fileSizeBytes)
        try container.encodeIfPresent(imageWidth, forKey: .imageWidth)
        try container.encodeIfPresent(imageHeight, forKey: .imageHeight)
        try container.encode(mimeType, forKey: .mimeType)
        try container.encodeIfPresent(label, forKey: .label)
    }
}

private struct CompleteCaptureJobMultiPhotoParams: Encodable, Sendable {
    let jobID: UUID
    let expectedPhotoCount: Int
    let uploadCompletedAt: Date

    private enum CodingKeys: String, CodingKey {
        case jobID = "_job_id"
        case expectedPhotoCount = "_expected_photo_count"
        case uploadCompletedAt = "_upload_completed_at"
    }

    nonisolated func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(jobID, forKey: .jobID)
        try container.encode(expectedPhotoCount, forKey: .expectedPhotoCount)
        try container.encode(uploadCompletedAt, forKey: .uploadCompletedAt)
    }
}
