export async function onRequest(context){
  if(context.request.method === 'OPTIONS'){
    return new Response(null, {status: 204, headers:{
      'Access-Control-Allow-Origin':'*',
      'Access-Control-Allow-Methods':'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers':'Content-Type, Authorization, X-Lang, X-User-Id, X-Apple-User, X-Dev-Mode, X-Dev-Password',
      'Access-Control-Max-Age':'86400'
    }});
  }
  const url = new URL(context.request.url);
  const target = 'https://frog02-32287.wykr.es';

  const req = new Request(target + url.pathname + url.search, {
    method: context.request.method,
    headers: context.request.headers,
    body: context.request.method !== 'GET' && context.request.method !== 'HEAD' ? await context.request.arrayBuffer() : undefined,
    redirect: 'follow'
  });
  req.headers.set('host', 'frog02-32287.wykr.es');
  try{
    const res = await fetch(req);
    const h = new Headers(res.headers);
    h.set('Access-Control-Allow-Origin', '*');
    h.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    h.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Lang, X-User-Id, X-Apple-User, X-Dev-Mode, X-Dev-Password');
    return new Response(res.body, {status: res.status, headers:h});
  }catch(e){
    return new Response(JSON.stringify({error: 'proxy error: '+e.message}), {status: 502, headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}});
  }
}
