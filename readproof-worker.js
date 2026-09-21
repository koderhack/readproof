export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      return new Response('Not found', { status: 404 });
    }
    
    const targetUrl = 'https://frog02-32287.wykr.es' + url.pathname + url.search;
    const newRequest = new Request(targetUrl, {
      method: request.method,
      headers: request.headers,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? await request.arrayBuffer() : undefined,
      redirect: 'follow'
    });
    newRequest.headers.set('host', 'frog02-32287.wykr.es');
    
    try {
      const response = await fetch(newRequest);
      const headers = new Headers(response.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Lang, X-User-Id, X-Apple-User, X-Dev-Mode, X-Dev-Password');
      return new Response(response.body, { status: response.status, headers });
    } catch (e) {
      return new Response(JSON.stringify({ error: 'proxy error: ' + e.message }), { 
        status: 502, 
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } 
      });
    }
  }
};