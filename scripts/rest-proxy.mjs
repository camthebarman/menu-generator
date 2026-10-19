// Dev/test helper: exposes PostgREST under /rest/v1 (the path supabase-js uses) with permissive CORS.
// Usage: node scripts/rest-proxy.mjs <listenPort> <postgrestUrl>
import http from 'node:http';

const [port, target] = [Number(process.argv[2]), new URL(process.argv[3])];
const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
  'access-control-expose-headers': 'content-range,content-profile',
};
http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (!req.url?.startsWith('/rest/v1')) { res.writeHead(404, cors); return res.end('only /rest/v1 is proxied'); }
  const p = http.request({ host: target.hostname, port: target.port, path: req.url.replace(/^\/rest\/v1/, '') || '/', method: req.method, headers: { ...req.headers, host: target.host } }, (r) => {
    res.writeHead(r.statusCode ?? 502, { ...r.headers, ...cors });
    r.pipe(res);
  });
  p.on('error', (e) => { res.writeHead(502, cors); res.end(String(e)); });
  req.pipe(p);
}).listen(port, '127.0.0.1', () => console.log(`rest proxy on ${port} -> ${target.href}`));
