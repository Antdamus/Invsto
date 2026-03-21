import Foundation
import Supabase

enum SupabaseService {
    static let shared = SupabaseClient(
        supabaseURL: AppConfig.current.supabaseURL,
        supabaseKey: AppConfig.current.supabaseAnonKey
    )
}
