import Foundation
import Supabase

enum CaptureJobStatus: String, Codable, Equatable {
    case queued
    case assigned
    case capturing
    case uploading
    case completed
    case failed
    case canceled
}

struct CaptureJob: Codable, Equatable, Identifiable {
    let id: UUID
    let requestedBy: UUID?
    let stationID: UUID
    let status: CaptureJobStatus
    let requestedAt: Date
    let claimedAt: Date?
    let captureStartedAt: Date?
    let captureCompletedAt: Date?
    let uploadCompletedAt: Date?
    let storageBucket: String?
    let storagePath: String?
    let fileSizeBytes: Int64?
    let mimeType: String?
    let failureCode: String?
    let failureMessage: String?
    let controlPayload: JSONObject?
    let resultPayload: JSONObject?
    let createdAt: Date
    let updatedAt: Date

    nonisolated var isCaptureRequestCandidate: Bool {
        status == .queued || status == .assigned
    }

    nonisolated var shortReference: String {
        String(id.uuidString.prefix(8)).uppercased()
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case requestedBy = "requested_by"
        case stationID = "station_id"
        case status
        case requestedAt = "requested_at"
        case claimedAt = "claimed_at"
        case captureStartedAt = "capture_started_at"
        case captureCompletedAt = "capture_completed_at"
        case uploadCompletedAt = "upload_completed_at"
        case storageBucket = "storage_bucket"
        case storagePath = "storage_path"
        case fileSizeBytes = "file_size_bytes"
        case mimeType = "mime_type"
        case failureCode = "failure_code"
        case failureMessage = "failure_message"
        case controlPayload = "control_payload"
        case resultPayload = "result_payload"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}
