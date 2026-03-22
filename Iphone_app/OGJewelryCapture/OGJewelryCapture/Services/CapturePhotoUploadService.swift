import Foundation
import Supabase

struct CapturePhotoUploadService {
    struct UploadResult: Equatable {
        let bucket: String
        let path: String
        let fileSizeBytes: Int64
        let mimeType: String
        let uploadedAt: Date
    }

    static let captureBucket = "capture-photos"

    private let client: SupabaseClient
    private let formatter: DateFormatter

    init(client: SupabaseClient = SupabaseService.shared) {
        self.client = client

        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyyMMdd'T'HHmmssSSS'Z'"
        self.formatter = formatter
    }

    func uploadCapture(_ capture: LocalCaptureResult, stationID: UUID) async throws -> UploadResult {
        let objectPath = makeObjectPath(for: capture, stationID: stationID)
        let mimeType = "image/jpeg"
        let uploadTimestamp = Date()

        _ = try await client.storage
            .from(Self.captureBucket)
            .upload(
                objectPath,
                data: capture.imageData,
                options: FileOptions(
                    cacheControl: "3600",
                    contentType: mimeType,
                    upsert: true
                )
            )

        return UploadResult(
            bucket: Self.captureBucket,
            path: objectPath,
            fileSizeBytes: Int64(capture.fileSizeBytes),
            mimeType: mimeType,
            uploadedAt: uploadTimestamp
        )
    }

    private func makeObjectPath(for capture: LocalCaptureResult, stationID: UUID) -> String {
        let timestamp = formatter.string(from: capture.capturedAt)
        return "\(stationID.uuidString.lowercased())/\(capture.jobID.uuidString.lowercased())/\(timestamp)-capture.jpg"
    }
}

