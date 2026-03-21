import SwiftUI

struct AuthenticatedView: View {
    @EnvironmentObject private var authViewModel: AuthViewModel

    let employee: AuthenticatedEmployee

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                Text("Authenticated")
                    .font(.title2.weight(.semibold))

                Text(employee.email)
                    .foregroundStyle(.secondary)

                if let role = employee.role, !role.isEmpty {
                    Text("Role: \(role)")
                        .foregroundStyle(.secondary)
                }

                Button("Log Out") {
                    Task {
                        await authViewModel.signOut()
                    }
                }
                .buttonStyle(.borderedProminent)

                Spacer()
            }
            .padding()
            .navigationTitle("OG Capture")
        }
    }
}

#Preview {
    AuthenticatedView(
        employee: AuthenticatedEmployee(
            userID: UUID(),
            email: "employee@example.com",
            role: "employee"
        )
    )
    .environmentObject(AuthViewModel())
}
