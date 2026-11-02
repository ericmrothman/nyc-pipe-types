// Public, client-side configuration for the Pipe Atlas (docs/explore.html).
//
// Leave supabaseUrl blank and the atlas runs entirely in each visitor's browser (localStorage):
// uploads, appreciations and field notes persist on that device only. Great for testing.
//
// To make it a shared, live map:
//   1. Create a Supabase project, open the SQL editor, run docs/supabase-pipes-setup.sql.
//   2. Paste the Project URL and the *publishable* key (sb_publishable_…) below, from Project Settings ->
//      API Keys. (A legacy "anon" key, eyJ…, also works.) This key is designed to be public; the
//      row-level-security policies in the SQL file are what protect the data. Never paste a secret key.
window.PIPE_CONFIG = {
  supabaseUrl: 'https://vzkoaosxknmfebgorxut.supabase.co',
  supabaseAnonKey: 'sb_publishable_n33iboKfa2I5_WraeB8XYA_AqgaJO5c',
  photoBucket: 'pipe-photos',
};
