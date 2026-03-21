import Foundation

struct AppConfig {
    let supabaseURL: URL
    let supabaseAnonKey: String

    static let current = load()

    private static func load(bundle: Bundle = .main) -> AppConfig {
        guard
            let url = bundle.url(forResource: "SupabaseConfig", withExtension: "plist"),
            let data = try? Data(contentsOf: url),
            let rawConfig = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
            let urlString = rawConfig["SUPABASE_URL"] as? String,
            let supabaseURL = URL(string: urlString),
            let supabaseAnonKey = rawConfig["SUPABASE_ANON_KEY"] as? String,
            !supabaseAnonKey.isEmpty
        else {
            fatalError("Missing or invalid SupabaseConfig.plist. Copy SupabaseConfig.example.plist and provide the project URL plus anon key.")
        }

        return AppConfig(
            supabaseURL: supabaseURL,
            supabaseAnonKey: supabaseAnonKey
        )
    }
}
