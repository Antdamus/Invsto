import Foundation
import Supabase

enum AuthError: LocalizedError {
    case missingEmail
    case missingEmployeeRecord
    case inactiveEmployee

    var errorDescription: String? {
        switch self {
        case .missingEmail:
            return "The authenticated account does not have an email address."
        case .missingEmployeeRecord:
            return "This account is not linked to an active employee record."
        case .inactiveEmployee:
            return "This employee account is inactive. Contact an admin."
        }
    }
}

struct AuthService {
    private let client: SupabaseClient

    init(client: SupabaseClient = SupabaseService.shared) {
        self.client = client
    }

    func restoreAuthenticatedEmployee() async throws -> AuthenticatedEmployee {
        let session = try await client.auth.session
        return try await validatedEmployee(from: session)
    }

    func signIn(email: String, password: String) async throws -> AuthenticatedEmployee {
        _ = try await client.auth.signIn(
            email: email,
            password: password
        )

        do {
            let session = try await client.auth.session
            return try await validatedEmployee(from: session)
        } catch {
            try? await client.auth.signOut()
            throw error
        }
    }

    func signOut() async throws {
        try await client.auth.signOut()
    }

    private func validatedEmployee(from session: Session) async throws -> AuthenticatedEmployee {
        guard let email = session.user.email else {
            throw AuthError.missingEmail
        }

        let employees: [EmployeeProfile] = try await client
            .from("employees")
            .select("id, display_name, role, active")
            .eq("user_id", value: session.user.id)
            .limit(1)
            .execute()
            .value

        let employee = employees.first

        guard let employee else {
            throw AuthError.missingEmployeeRecord
        }

        if employee.active == false {
            throw AuthError.inactiveEmployee
        }

        return AuthenticatedEmployee(
            employeeID: employee.id,
            userID: session.user.id,
            email: email,
            displayName: employee.displayName,
            role: employee.role
        )
    }
}
