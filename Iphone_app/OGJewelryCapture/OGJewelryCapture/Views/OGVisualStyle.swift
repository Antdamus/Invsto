import SwiftUI

enum OGVisualStyle {
    static let backgroundTop = Color(red: 0.06, green: 0.06, blue: 0.07)
    static let backgroundBottom = Color(red: 0.02, green: 0.02, blue: 0.03)
    static let panel = Color(red: 0.10, green: 0.10, blue: 0.12)
    static let panelElevated = Color(red: 0.14, green: 0.14, blue: 0.17)
    static let stroke = Color.white.opacity(0.08)
    static let strokeStrong = Color.white.opacity(0.14)
    static let gold = Color(red: 0.84, green: 0.70, blue: 0.37)
    static let goldSoft = Color(red: 0.94, green: 0.84, blue: 0.55)
    static let textPrimary = Color(red: 0.95, green: 0.95, blue: 0.96)
    static let textSecondary = Color.white.opacity(0.72)
    static let destructive = Color(red: 0.81, green: 0.28, blue: 0.29)
}

struct OGScreenBackground: View {
    var body: some View {
        ZStack {
            LinearGradient(
                colors: [OGVisualStyle.backgroundTop, OGVisualStyle.backgroundBottom],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )

            RadialGradient(
                colors: [OGVisualStyle.gold.opacity(0.18), .clear],
                center: .topLeading,
                startRadius: 20,
                endRadius: 360
            )

            RadialGradient(
                colors: [Color.white.opacity(0.06), .clear],
                center: .bottomTrailing,
                startRadius: 20,
                endRadius: 420
            )
        }
        .ignoresSafeArea()
    }
}

struct OGCardModifier: ViewModifier {
    var elevated = false
    var padding: CGFloat = 18

    func body(content: Content) -> some View {
        content
            .padding(padding)
            .background(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .fill(elevated ? OGVisualStyle.panelElevated : OGVisualStyle.panel)
                    .overlay(
                        RoundedRectangle(cornerRadius: 22, style: .continuous)
                            .stroke(elevated ? OGVisualStyle.strokeStrong : OGVisualStyle.stroke, lineWidth: 1)
                    )
            )
    }
}

enum OGActionRole {
    case primary
    case secondary
    case destructive
}

struct OGActionButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    let role: OGActionRole

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline.weight(.semibold))
            .foregroundStyle(foregroundColor)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .background(background(configuration.isPressed))
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(borderColor, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            .opacity(isEnabled ? 1 : 0.58)
            .saturation(isEnabled ? 1 : 0.2)
            .scaleEffect(configuration.isPressed && isEnabled ? 0.99 : 1)
            .shadow(color: shadowColor.opacity(shadowOpacity(isPressed: configuration.isPressed)), radius: 18, y: 10)
            .animation(.easeOut(duration: 0.16), value: configuration.isPressed)
    }

    private var foregroundColor: Color {
        if !isEnabled {
            return OGVisualStyle.textSecondary.opacity(0.9)
        }

        switch role {
        case .primary:
            return Color.black.opacity(0.88)
        case .secondary, .destructive:
            return OGVisualStyle.textPrimary
        }
    }

    private var borderColor: Color {
        if !isEnabled {
            return OGVisualStyle.strokeStrong.opacity(0.6)
        }

        switch role {
        case .primary:
            return OGVisualStyle.goldSoft.opacity(0.4)
        case .secondary:
            return OGVisualStyle.strokeStrong
        case .destructive:
            return OGVisualStyle.destructive.opacity(0.5)
        }
    }

    private var shadowColor: Color {
        switch role {
        case .primary:
            return OGVisualStyle.gold
        case .secondary:
            return Color.black
        case .destructive:
            return OGVisualStyle.destructive
        }
    }

    @ViewBuilder
    private func background(_ isPressed: Bool) -> some View {
        if !isEnabled {
            LinearGradient(
                colors: [
                    OGVisualStyle.panelElevated.opacity(0.72),
                    OGVisualStyle.panel.opacity(0.84)
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        } else {
        switch role {
        case .primary:
            LinearGradient(
                colors: [
                    OGVisualStyle.goldSoft.opacity(isPressed ? 0.92 : 1),
                    OGVisualStyle.gold.opacity(isPressed ? 0.82 : 0.9)
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        case .secondary:
            LinearGradient(
                colors: [
                    OGVisualStyle.panelElevated.opacity(isPressed ? 0.9 : 1),
                    OGVisualStyle.panel.opacity(isPressed ? 0.88 : 0.96)
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        case .destructive:
            LinearGradient(
                colors: [
                    OGVisualStyle.destructive.opacity(isPressed ? 0.7 : 0.82),
                    OGVisualStyle.destructive.opacity(isPressed ? 0.48 : 0.62)
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        }
        }
    }

    private func shadowOpacity(isPressed: Bool) -> Double {
        guard isEnabled else { return 0 }
        return isPressed ? 0.18 : 0.3
    }
}

struct OGInputFieldStyle: TextFieldStyle {
    func _body(configuration: TextField<Self._Label>) -> some View {
        configuration
            .font(.body)
            .foregroundStyle(OGVisualStyle.textPrimary)
            .padding(.horizontal, 14)
            .padding(.vertical, 14)
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(OGVisualStyle.panelElevated)
                    .overlay(
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .stroke(OGVisualStyle.strokeStrong, lineWidth: 1)
                    )
            )
    }
}

struct OGDetailRow: View {
    let title: String
    let value: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(title)
                .font(.footnote.weight(.medium))
                .foregroundStyle(OGVisualStyle.textSecondary)

            Spacer(minLength: 12)

            Text(value)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(OGVisualStyle.textPrimary)
                .multilineTextAlignment(.trailing)
        }
    }
}

extension View {
    func ogCard(elevated: Bool = false, padding: CGFloat = 18) -> some View {
        modifier(OGCardModifier(elevated: elevated, padding: padding))
    }

    func ogListChrome() -> some View {
        scrollContentBackground(.hidden)
            .background(OGScreenBackground())
            .listStyle(.insetGrouped)
            .tint(OGVisualStyle.gold)
    }
}
