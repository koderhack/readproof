export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      return new Response('Not found', { status: 404 });
    }

    const parts = url.pathname.split('/').filter(Boolean);

    // ===== CLASSES API =====
    if(parts[1]==='classes'){
      const code = parts[2];
      const method = request.method;
      const base = 'https://frog02-32287.wykr.es/api/classes';
      try{
        if(method==='GET' && !code){
          const teacher = url.searchParams.get('teacher');
          const t = teacher ? '?teacher='+encodeURIComponent(teacher) : '';
          const r = await fetch(base+t, {headers:{'Content-Type':'application/json','X-Lang':'pl'}});
          return new Response(JSON.stringify(await r.json()), {status: r.status, headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET, POST, PUT, DELETE, OPTIONS'}});
        }
        if(method==='POST' && !code){
          const body = await request.json();
          const r = await fetch(base, {method:'POST', headers:{'Content-Type':'application/json','X-Lang':'pl'}, body:JSON.stringify(body)});
          return new Response(JSON.stringify(await r.json()), {status: r.status, headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET, POST, PUT, DELETE, OPTIONS'}});
        }
        if(method==='GET' && code && parts[3]==='students'){
          const r = await fetch(base+'/'+code+'/students', {headers:{'Content-Type':'application/json','X-Lang':'pl'}});
          return new Response(JSON.stringify(await r.json()), {status: r.status, headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET, POST, PUT, DELETE, OPTIONS'}});
        }
        if(method==='GET' && code){
          const r = await fetch(base+'/'+code, {headers:{'Content-Type':'application/json','X-Lang':'pl'}});
          return new Response(JSON.stringify(await r.json()), {status: r.status, headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET, POST, PUT, DELETE, OPTIONS'}});
        }
        if(method==='POST' && code && parts[3]==='join'){
          const body = await request.json();
          const r = await fetch(base+'/'+code+'/join', {method:'POST', headers:{'Content-Type':'application/json','X-Lang':'pl'}, body:JSON.stringify(body)});
          return new Response(JSON.stringify(await r.json()), {status: r.status, headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET, POST, PUT, DELETE, OPTIONS'}});
        }
      }catch(e){
        return new Response(JSON.stringify({error:'class error: '+e.message}), {status: 502, headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}});
      }
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