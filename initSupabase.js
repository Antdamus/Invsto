// Replace with your actual Supabase project details
const SUPABASE_URL = 'https://byhytmarmigalvawkedi.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ5aHl0bWFybWlnYWx2YXdrZWRpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDQ1MzI5MTcsImV4cCI6MjA2MDEwODkxN30.W5-2mXZ9FF9AVTkkhmH-UZUda4fU2rJB98vHDOWzGCQ';

function initSupabaseClient() {
  if (!window.supabase?.createClient) {
    console.error("Supabase library did not load before initSupabase.js ran.");
    document.dispatchEvent(new CustomEvent("supabase-init-error", {
      detail: { message: "Supabase library did not load. Please refresh and check your connection." },
    }));
    return;
  }

  // Create client once
  window.supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true, // important for invite/reset links
    },
  });
window.SUPABASE_URL = SUPABASE_URL;
window.SUPABASE_ANON_KEY = SUPABASE_KEY;
  
  // ✅ Alias for older code that expects supabaseClient
  window.supabaseClient = window.supabase;

  // Signal ready
  document.dispatchEvent(new Event("supabase-ready"));
}


if (document.readyState === "complete" || document.readyState === "interactive") {
  initSupabaseClient();
} else {
  document.addEventListener("DOMContentLoaded", initSupabaseClient);
}
