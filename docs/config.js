// Public, client-side configuration for the Pipe Atlas (docs/explore.html).
//
// Leave supabaseUrl blank and the atlas runs entirely in each visitor's browser (localStorage):
// uploads, appreciations and field notes persist on that device only. Great for testing.
//
// To make it a shared, live map:
//   1. Create a Supabase project, open the SQL editor, run docs/supabase-pipes-setup.sql.
//   2. Paste the project URL and the *anon public* key below (Settings -> API). The anon key is
//      designed to be public; the row-level-security policies in the SQL file are what protect data.
window.PIPE_CONFIG = {
  supabaseUrl: '',
  supabaseAnonKey: '',
  photoBucket: 'pipe-photos',
};
