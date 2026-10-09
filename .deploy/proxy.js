const http = require('http');

const LISTEN_PORT = 32287;
const PORTFOLIO_PORT = 8081;
const DIABCALC_PORT = 32289;
const READPROOF_PORT = 32288;
const PORTFOLIO_PATHS = new Set(['/api/subscribe', '/api/unsubscribe']);

// Ścieżki ReadProof. Proxy współdzieli :32287 z DiabCalc i portfolio, a ReadProof
// słucha osobno na :32288. Ścieżki muszą być wymienione wprost, bo oba projekty
// mają /api/users i /api/me — po domenie nie da się ich rozróżnić.
// Dopisuj tu KAŻDĄ nową ścieżkę ReadProof, inaczej trafi do DiabCalc i katalog
// książek wraca pusty.
const READPROOF_PATHS = [
  '/api/books',
  '/api/catalog',
  '/api/sessions',
  '/api/challenges',
  '/api/certificates',
  '/api/proofs',
  '/api/publisher',
  '/api/teacher',
  '/api/student',
  '/api/classes',
  '/api/secure',
  '/api/role-requests',
  '/api/users',
  '/api/me',
  '/api/waitlist',
  '/api/admin',
];

function isReadProof(url) {
  return READPROOF_PATHS.some((p) => url === p || url.startsWith(p + '/') || url.startsWith(p + '?'));
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const target = isReadProof(url)
    ? READPROOF_PORT
    : (url.startsWith('/api/admin') || PORTFOLIO_PATHS.has(url) ? PORTFOLIO_PORT : DIABCALC_PORT);
  const proxy = http.request(
    {
      host: '127.0.0.1',
      port: target,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: `127.0.0.1:${target}` }
    },
    (p) => {
      res.writeHead(p.statusCode, p.headers);
      p.pipe(res);
    }
  );
  proxy.on('error', (e) => {
    console.error(`[proxy] ${target} error:`, e.message);
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'bad gateway' }));
  });
  req.pipe(proxy);
});

server.listen(LISTEN_PORT, '0.0.0.0', () =>
  console.log(`[proxy] :${LISTEN_PORT} -> ReadProof :${READPROOF_PORT}, /api/subscribe:/api/unsubscribe :${PORTFOLIO_PORT}, rest -> :${DIABCALC_PORT}`)
);