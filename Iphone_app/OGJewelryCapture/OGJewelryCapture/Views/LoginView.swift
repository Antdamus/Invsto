import SwiftUI

struct LoginView: View {
    @EnvironmentObject private var authViewModel: AuthViewModel
    @FocusState private var focusedField: Field?

    private enum Field {
        case email
        case password
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Employee Login") {
                    TextField("Email", text: $authViewModel.email)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focusedField, equals: .email)

                    SecureField("Password", text: $authViewModel.password)
                        .textInputAutocapitalization(.never)
                        .focused($focusedField, equals: .password)

                    Button(authViewModel.isSubmitting ? "Signing In…" : "Log In") {
                        Task {
                            await authViewModel.signIn()
                        }
                    }
                    .disabled(authViewModel.isSubmitting || authViewModel.email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || authViewModel.password.isEmpty)
                }

                if let errorMessage = authViewModel.errorMessage {
                    Section {
                        Text(errorMessage)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("OG Capture")
        }
    }
}

#Preview {
    LoginView()
        .environmentObject(AuthViewModel())
}
