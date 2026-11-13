'use strict';

const http = require('http');

const PORT = Number(process.env.PORT || 3000);
const DEFAULT_DELAY_MS = Number(process.env.DEFAULT_DELAY_MS || 140000);
const MAX_DELAY_MS = Number(process.env.MAX_DELAY_MS || 300000);
const DRIP_CHUNKS = Number(process.env.DRIP_CHUNKS || 14);

// Keep the socket open longer than the longest delay we will ever serve,
// otherwise Node's own 5s header timeout / 2min keep-alive kills the test.
const SOCKET_TIMEOUT_MS = MAX_DELAY_MS + 60000;

function parseDelay(url) {
  const raw = url.searchParams.get('ms');
  if (raw === null) return { ms: DEFAULT_DELAY_MS };
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms < 0) {
    return { error: `'ms' must be a non-negative number, got: ${raw}` };
  }
  if (ms > MAX_DELAY_MS) {
    return { error: `'ms' exceeds MAX_DELAY_MS (${MAX_DELAY_MS}), got: ${ms}` };
  }
  return { ms };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

// Resolves after ms, or rejects if the client disconnects first.
function delay(ms, req) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      req.off('aborted', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new Error('client aborted'));
    }
    req.once('aborted', onAbort);
  });
}

// Silent stall, then a full response. Exercises client total/response timeout.
async function handleSlow(req, res, startedAt, ms) {
  await delay(ms, req);
  sendJson(res, 200, {
    endpoint: '/slow',
    requestedDelayMs: ms,
    actualDelayMs: Date.now() - startedAt,
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date().toISOString(),
  });
}

// Headers immediately, body trickles. Separates idle/read timeout from total timeout.
async function handleDrip(req, res, startedAt, ms) {
  const chunks = Math.max(1, DRIP_CHUNKS);
  const interval = ms / chunks;

  res.writeHead(200, {
    'content-type': 'application/x-ndjson',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no', // ask proxies not to buffer the stream
  });
  // Without this, Node holds the headers until the first chunk, which would
  // collapse the gap between time_starttransfer and time_total.
  res.flushHeaders();

  for (let i = 1; i <= chunks; i++) {
    await delay(interval, req);
    if (res.writableEnded) return;
    res.write(
      JSON.stringify({
        chunk: i,
        of: chunks,
        elapsedMs: Date.now() - startedAt,
      }) + '\n'
    );
  }
  res.end();
}

// Stall, then destroy the socket with no response. Simulates upstream death.
async function handleHangup(req, res, startedAt, ms) {
  await delay(ms, req);
  res.socket?.destroy();
}

const ROUTES = {
  '/slow': handleSlow,
  '/slow/drip': handleDrip,
  '/slow/hangup': handleHangup,
};

const server = http.createServer(async (req, res) => {
  const startedAt = Date.now();
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/health') {
    return sendJson(res, 200, { status: 'ok', uptimeSec: Math.round(process.uptime()) });
  }

  const handler = ROUTES[url.pathname];
  if (!handler) {
    return sendJson(res, 404, {
      error: 'not found',
      routes: ['/health', '/slow?ms=', '/slow/drip?ms=', '/slow/hangup?ms='],
      defaultDelayMs: DEFAULT_DELAY_MS,
      maxDelayMs: MAX_DELAY_MS,
    });
  }

  const parsed = parseDelay(url);
  if (parsed.error) return sendJson(res, 400, { error: parsed.error });

  console.log(`${req.method} ${url.pathname} delay=${parsed.ms}ms`);

  try {
    await handler(req, res, startedAt, parsed.ms);
  } catch (err) {
    console.log(`${url.pathname} ended early: ${err.message}`);
    if (!res.headersSent && !res.writableEnded) {
      sendJson(res, 500, { error: err.message });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
});

server.requestTimeout = 0;
server.headersTimeout = 0;
server.setTimeout(SOCKET_TIMEOUT_MS);
server.keepAliveTimeout = SOCKET_TIMEOUT_MS;

server.listen(PORT, () => {
  console.log(
    `slow-api listening on :${PORT} default=${DEFAULT_DELAY_MS}ms max=${MAX_DELAY_MS}ms`
  );
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
