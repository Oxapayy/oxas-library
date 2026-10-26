// Verify the caller with Auth; never accept a user ID from request input.
Deno.serve(async (request: Request) => {
  const reply = (status: number, body: object) => new Response(JSON.stringify(body), {status, headers: {'Content-Type':'application/json','Cache-Control':'no-store'}});
  if (request.method !== 'DELETE') return reply(405,{error:'Method not allowed'});
  const authorization = request.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) return reply(401,{error:'Sign in required'});
  const base = Deno.env.get('SUPABASE_URL')!;
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const checked = await fetch(`${base}/auth/v1/user`,{headers:{Authorization:authorization,apikey:key}});
  if (!checked.ok) return reply(401,{error:'Sign in again'});
  const user = await checked.json();
  if (typeof user.id !== 'string') return reply(401,{error:'Sign in again'});
  // Revoke refresh sessions, then cascade-delete only this verified Auth user.
  const revoked = await fetch(`${base}/auth/v1/logout?scope=global`,{method:'POST',headers:{Authorization:authorization,apikey:key}});
  if (!revoked.ok) return reply(503,{error:'Could not revoke sessions. Try again.'});
  const deleted = await fetch(`${base}/auth/v1/admin/users/${encodeURIComponent(user.id)}`,{method:'DELETE',headers:{Authorization:`Bearer ${key}`,apikey:key}});
  return deleted.ok ? reply(200,{deleted:true}) : reply(503,{error:'Could not delete account. Try again.'});
});
