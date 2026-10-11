import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ConnectionError, CONNECTION_MESSAGES } from './connection-errors.mjs';

const OPERATIONS = new Set(['connect', 'models', 'preferences', 'preview', 'apply', 'restore', 'disconnect', 'register']);
export async function startControlServer(service, { port = 0, idleMs = 4 * 60_000 } = {}) {
  const token = randomBytes(32).toString('hex');
  const template = await readFile(new URL('../ui/index.html', import.meta.url), 'utf8');
  let origin;
  let closed = false;
  let inFlight = 0;
  let lastActivity = Date.now();
  function json(response, status, value) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(value));
  }
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    if (request.headers.host !== origin?.slice(7)) return json(response, 403, { error: 'Заголовок Host не соответствует адресу локальной панели.' });
    if (request.url === '/' && request.method === 'GET') {
      const nonce = randomBytes(16).toString('hex');
      response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(template.replaceAll('__NONCE__', nonce).replace('__CONNECTION_MESSAGES__', JSON.stringify(CONNECTION_MESSAGES).replaceAll('<', '\\u003c')));
      return;
    }
    if (request.headers.origin && request.headers.origin !== origin) return json(response, 403, { error: 'Запрос отправлен не со страницы локальной панели.' });
    if (request.headers['sec-fetch-site'] === 'cross-site') return json(response, 403, { error: 'Межсайтовый запрос запрещён.' });
    const authorization = request.headers.authorization;
    const expected = Buffer.from(`Bearer ${token}`);
    const supplied = Buffer.from(typeof authorization === 'string' ? authorization : '');
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return json(response, 401, { error: 'Нет доступа к панели. Откройте её командой «WikiVibe: Открыть защищённую настройку» в Orca.' });
    let action;
    if (request.url === '/api/state' && request.method === 'GET') action = 'state';
    else if (request.method === 'POST' && request.url?.startsWith('/api/') && OPERATIONS.has(request.url.slice(5))) action = request.url.slice(5);
    else return json(response, 404, { error: 'Маршрут не найден.' });
    lastActivity = Date.now();
    inFlight++;
    try {
      let body = {};
      if (request.method === 'POST') {
        if (!request.headers['content-type']?.startsWith('application/json')) return json(response, 415, { error: 'Запрос должен содержать JSON с Content-Type: application/json.' });
        let size = 0;
        const chunks = [];
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 16384) return json(response, 413, { error: 'Размер запроса превышает 16 КиБ.' });
          chunks.push(chunk);
        }
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { return json(response, 400, { error: 'Не удалось прочитать JSON запроса.' }); }
      }
      const value = await service.request(action, body);
      json(response, 200, value);
    } catch (error) {
      if (action === 'connect') {
        const code = error instanceof ConnectionError && Object.hasOwn(CONNECTION_MESSAGES, error.code) ? error.code : 'unknown';
        json(response, 400, { code, error: CONNECTION_MESSAGES[code] });
      } else {
        const message = error instanceof Error ? error.message : 'Операция не выполнена.';
        json(response, 400, { error: message.slice(0, 512) });
      }
    } finally { inFlight--; lastActivity = Date.now(); }
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  const timer = setInterval(() => {
    if (!inFlight && Date.now() - lastActivity >= idleMs) void close();
  }, Math.min(idleMs, 15000));
  timer.unref();
  async function close() {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  return { url: `${origin}/#token=${token}`, origin, get closed() { return closed; }, close };
}
