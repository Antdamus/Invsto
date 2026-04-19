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
            ZStack {
                OGScreenBackground()

                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("OG")
                                .font(.system(size: 18, weight: .bold, design: .serif))
                                .foregroundStyle(Color.black.opacity(0.88))
                                .frame(width: 58, height: 58)
                                .background(
                                    LinearGradient(
                                        colors: [OGVisualStyle.goldSoft, OGVisualStyle.gold],
                                        startPoint: .topLeading,
                                        endPoint: .bottomTrailing
                                    )
                                )
                                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                                .shadow(color: OGVisualStyle.gold.opacity(0.22), radius: 24, y: 12)

                            Text("Capture Station")
                                .font(.system(.largeTitle, design: .serif).weight(.bold))
                                .foregroundStyle(OGVisualStyle.textPrimary)

                            Text("Sign in to continue the current OG Jewelry capture workflow on this device.")
                                .font(.subheadline)
                                .foregroundStyle(OGVisualStyle.textSecondary)
                        }

                        VStack(alignment: .leading, spacing: 18) {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("Employee Login")
                                    .font(.headline.weight(.semibold))
                                    .foregroundStyle(OGVisualStyle.textPrimary)

                                Text("Use your employee account to access station selection and active capture jobs.")
                                    .font(.footnote)
                                    .foregroundStyle(OGVisualStyle.textSecondary)
                            }

                            VStack(alignment: .leading, spacing: 8) {
                                Text("Email")
                                    .font(.footnote.weight(.medium))
                                    .foregroundStyle(OGVisualStyle.textSecondary)

                                TextField("employee@ogjewelers.com", text: $authViewModel.email)
                                    .keyboardType(.emailAddress)
                                    .textInputAutocapitalization(.never)
                                    .autocorrectionDisabled()
                                    .focused($focusedField, equals: .email)
                                    .textFieldStyle(OGInputFieldStyle())
                            }

                            VStack(alignment: .leading, spacing: 8) {
                                Text("Password")
                                    .font(.footnote.weight(.medium))
                                    .foregroundStyle(OGVisualStyle.textSecondary)

                                SecureField("Enter password", text: $authViewModel.password)
                                    .textInputAutocapitalization(.never)
                                    .focused($focusedField, equals: .password)
                                    .textFieldStyle(OGInputFieldStyle())
                            }

                            Button(authViewModel.isSubmitting ? "Signing In…" : "Sign In") {
                                Task {
                                    await authViewModel.signIn()
                                }
                            }
                            .buttonStyle(OGActionButtonStyle(role: .primary))
                            .disabled(
                                authViewModel.isSubmitting ||
                                authViewModel.email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                                authViewModel.password.isEmpty
                            )

                            if let errorMessage = authViewModel.errorMessage {
                                Text(errorMessage)
                                    .font(.footnote)
                                    .foregroundStyle(Color.red.opacity(0.92))
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(14)
                                    .background(
                                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                                            .fill(OGVisualStyle.destructive.opacity(0.12))
                                            .overlay(
                                                RoundedRectangle(cornerRadius: 16, style: .continuous)
                                                    .stroke(OGVisualStyle.destructive.opacity(0.32), lineWidth: 1)
                                            )
                                    )
                            }
                        }
                        .ogCard(elevated: true, padding: 22)

                        Text("Premium shell polish only. Authentication behavior remains unchanged.")
                            .font(.caption)
                            .foregroundStyle(OGVisualStyle.textSecondary)
                            .frame(maxWidth: .infinity, alignment: .center)
                    }
                    .padding(.horizontal, 20)
                    .padding(.vertical, 32)
                }
            }
            .toolbar(.hidden, for: .navigationBar)
        }
    }
}

#Preview {
    LoginView()
        .environmentObject(AuthViewModel())
}
