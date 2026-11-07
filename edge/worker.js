// This gateway has one operator-configured upstream. No caller chooses an origin.
function unavailable(status, detail) {
  return new Response(JSON.stringify({ detail }), { status, headers: {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store',
  } });
}

export async function proxyRequest(request, env, fetchUpstream = fetch) {
  let upstream;
  try {
    upstream = new URL(env.RENDER_ORIGIN);
    if (upstream.protocol !== 'https:' || !upstream.hostname.endsWith('.onrender.com') ||
        upstream.username || upstream.password || upstream.port || upstream.pathname !== '/' || upstream.search || upstream.hash ||
        typeof env.EDGE_TOKEN !== 'string' || env.EDGE_TOKEN.length < 32) throw new Error();
  } catch {
    return unavailable(503, 'API gateway is not configured.');
  }
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(request.method)) {
    return unavailable(405, 'Method not allowed.');
  }
  const incoming = new URL(request.url);
  upstream.pathname = incoming.pathname;
  upstream.search = incoming.search;
  try {
    // Cloning the Request preserves its streaming body and Upgrade headers.
    const forwarded = new Request(upstream, request);
    for (const header of ['Host', 'Forwarded', 'X-Forwarded-For', 'X-Real-IP', 'Client-IP', 'X-Bimo-Edge-Token-Previous']) {
      forwarded.headers.delete(header);
    }
    forwarded.headers.set('X-Bimo-Edge-Token', env.EDGE_TOKEN);
    forwarded.headers.set('X-Bimo-Client-IP', request.headers.get('CF-Connecting-IP') || '');
    const response = await fetchUpstream(forwarded, {
      redirect: 'manual', cf: { cacheTtl: 0, cacheEverything: false },
    });
    // Return the original response so Cloudflare retains its upgrade socket.
    if (response.status === 101) return response;
    const headers = new Headers(response.headers);
    const location = headers.get('Location');
    if (location && response.status >= 300 && response.status < 400) {
      const target = new URL(location, upstream);
      if (target.origin !== upstream.origin) return unavailable(502, 'Unexpected API redirect.');
      headers.set('Location', incoming.origin + target.pathname + target.search + target.hash);
    }
    for (const header of ['X-Bimo-Edge-Token', 'X-Bimo-Edge-Token-Previous', 'X-Bimo-Client-IP']) headers.delete(header);
    headers.set('Cache-Control', 'no-store');
    headers.set('CDN-Cache-Control', 'no-store');
    return new Response(response.body, {status: response.status, statusText: response.statusText, headers});
  } catch {
    return unavailable(502, 'API is temporarily unavailable. Please try again shortly.');
  }
}

export default { fetch: (request, env) => proxyRequest(request, env) };
