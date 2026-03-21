import Foundation

struct EmployeeProfile: Decodable, Equatable {
    let id: UUID
    let displayName: String
    let role: String?
    let active: Bool?

    private enum CodingKeys: String, CodingKey {
        case id
        case displayName = "display_name"
        case role
        case active
    }
}

struct AuthenticatedEmployee: Equatable {
    let employeeID: UUID
    let userID: UUID
    let email: String
    let displayName: String
    let role: String?
}
