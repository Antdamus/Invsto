import Foundation

struct EmployeeProfile: Decodable, Equatable {
    let role: String?
    let active: Bool?
}

struct AuthenticatedEmployee: Equatable {
    let userID: UUID
    let email: String
    let role: String?
}
