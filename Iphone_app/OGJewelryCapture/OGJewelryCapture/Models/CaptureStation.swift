import Foundation

struct CaptureStation: Codable, Equatable, Identifiable {
    let id: UUID
    let name: String
    let active: Bool
    let assignedEmployeeID: UUID?
    let deviceLabel: String?
    let iosDeviceIdentifier: String?
    let lastSeenAt: Date?

    private enum CodingKeys: String, CodingKey {
        case id
        case name
        case active
        case assignedEmployeeID = "assigned_employee_id"
        case deviceLabel = "device_label"
        case iosDeviceIdentifier = "ios_device_identifier"
        case lastSeenAt = "last_seen_at"
    }
}
