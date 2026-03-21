import Combine
import Foundation

@MainActor
final class AuthViewModel: ObservableObject {
    enum State: Equatable {
        case loading
        case signedOut
        case authenticated(AuthenticatedEmployee)
    }

    @Published private(set) var state: State = .loading
    @Published var email = ""
    @Published var password = ""
    @Published private(set) var isSubmitting = false
    @Published var errorMessage: String?

    private let authService: AuthService

    init(authService: AuthService? = nil) {
        self.authService = authService ?? AuthService()
    }

    func bootstrap() async {
        state = .loading
        errorMessage = nil

        do {
            let employee = try await authService.restoreAuthenticatedEmployee()
            state = .authenticated(employee)
        } catch {
            state = .signedOut
        }
    }

    func signIn() async {
        guard !isSubmitting else { return }

        isSubmitting = true
        errorMessage = nil

        defer { isSubmitting = false }

        do {
            let employee = try await authService.signIn(
                email: email.trimmingCharacters(in: .whitespacesAndNewlines),
                password: password
            )
            password = ""
            state = .authenticated(employee)
        } catch {
            errorMessage = error.localizedDescription
            state = .signedOut
        }
    }

    func signOut() async {
        guard !isSubmitting else { return }

        isSubmitting = true
        errorMessage = nil

        defer { isSubmitting = false }

        do {
            try await authService.signOut()
        } catch {
            errorMessage = error.localizedDescription
        }

        password = ""
        state = .signedOut
    }
}
