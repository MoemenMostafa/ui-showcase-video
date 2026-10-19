// Serve the Acme Board test pages for examples/acme/acme.tour.json:
//   node examples/acme/serve.ts      → http://127.0.0.1:8765 (PORT=… to change; the tour's "base" must match)
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('site/', import.meta.url)), port = Number(process.env.PORT ?? 8765);
const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.js': 'text/javascript' };
createServer(async (req, res) => {
  const path = normalize(new URL(req.url ?? '/', 'http://x').pathname).replace(/^(\.\.[/\\])+/, '');
  try {
    const body = await readFile(join(root, path === '/' ? 'index.html' : path));
    res.writeHead(200, { 'content-type': types[extname(path)] ?? types['.html'] }).end(body);
  } catch { res.writeHead(404).end('not found'); }
}).listen(port, '127.0.0.1', () => console.log(`Acme Board on http://127.0.0.1:${port}`));
