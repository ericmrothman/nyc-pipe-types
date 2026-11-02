// The Delete button in a moderation notification lands here.
// Body: { kind: 'pipe' | 'note', id, key }. The key is checked inside the database against the one in
// Vault (public.moderate_delete, callable only with the secret key). For a pipe, its photo and 3D scan
// files are removed from storage too. JWT verification is off: the moderation key is the authorization.
// Deployed to the nyc-pipe-types Supabase project as "moderate" with verify_jwt = false.

const URL_BASE = Deno.env.get('SUPABASE_URL')!;
const secretKeys = Deno.env.get('SUPABASE_SECRET_KEYS');
const SECRET = secretKeys ? JSON.parse(secretKeys).default : null;
const LEGACY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
// New secret keys go only in the apikey header; a legacy service_role JWT also goes as Bearer.
const adminHeaders: Record<string, string> = SECRET
  ? { apikey: SECRET }
  : { apikey: LEGACY!, Authorization: `Bearer ${LEGACY}` };

const reply = (status: number, text: string) => new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return reply(405, 'POST only');
  let body: { kind?: string; id?: string; key?: string };
  try { body = await req.json(); } catch { return reply(400, 'Bad JSON'); }
  const { kind, id, key } = body;
  if (!kind || !id || !key) return reply(400, 'Missing kind, id or key');

  const rpc = await fetch(`${URL_BASE}/rest/v1/rpc/moderate_delete`, {
    method: 'POST',
    headers: { ...adminHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_kind: kind, p_id: id, p_key: key }),
  });
  if (!rpc.ok) return reply(502, `Database error ${rpc.status}: ${(await rpc.text()).slice(0, 200)}`);
  const result = await rpc.json();
  if (!result.ok) return reply(403, result.error ?? 'Refused');

  if (kind === 'pipe') {
    // Best effort: the row is already gone; remove its photo and scan so the files aren't left public.
    await fetch(`${URL_BASE}/storage/v1/object/pipe-photos`, {
      method: 'DELETE',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: [`${id}.jpg`, `${id}.glb`] }),
    }).catch((err) => console.error('storage delete failed', err));
  }
  return reply(200, result.deleted ? `Deleted ${kind} ${id}` : `Already gone: ${kind} ${id}`);
});
