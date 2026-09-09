const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const express = require('express');

// Execute the real entrypoint without refactoring the integration to make it testable.
async function start(t, { env = {}, provider, signal = AbortSignal } = {}) {
  let server;
  const calls = [];
  const source = readFileSync(require.resolve('../server.js'), 'utf8');
  runInNewContext(source, {
    require(name) {
      if (name !== 'express') throw new Error('Unexpected dependency: ' + name);
      return () => {
        const app = express();
        const listen = app.listen.bind(app);
        app.listen = (_port, callback) => (server = listen(0, '127.0.0.1', callback));
        return app;
      };
    },
    process: { env: { FMCSA_KEY: 'synthetic-test-key&secret', ...env } },
    console: { log() {}, error() {}, warn() {} },
    AbortSignal: signal,
    fetch: async (...args) => {
      calls.push(args);
      return provider ? provider(...args) : { ok: true, json: async () => ({ content: { carrier: { legalName: 'Synthetic Fleet' } } }) };
    },
  }, { filename: 'server.js' });
  if (!server.listening) await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return {
    calls,
    request: (path, options) => fetch(`http://127.0.0.1:${server.address().port}${path}`, options),
  };
}

test('health response reports configuration without exposing the key', async t => {
  const s = await start(t);
  const r = await s.request('/');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, service: 'fmcsa-lookup', keyConfigured: true });
  assert.equal(s.calls.length, 0);
});

test('valid DOT preserves the carrier route, provider URL, and all response fields', async t => {
  const carrier = { legalName: 'Synthetic Fleet', dbaName: 'Test DBA', phyStreet: '1 Test St', phyCity: 'Test City', phyState: 'NY', phyZipcode: '14609', telephone: '555-0100', mcNumber: 'MC-123', safetyRating: 'Satisfactory', totalPowerUnits: 2, totalDrivers: 3 };
  const s = await start(t, { provider: async () => ({ ok: true, json: async () => ({ content: { carrier } }) }) });
  const r = await s.request('/carrier/00123456');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { usdot: '00123456', legalName: 'Synthetic Fleet', dba: 'Test DBA', addr: '1 Test St', city: 'Test City', state: 'NY', zip: '14609', phone: '555-0100', mcNumber: 'MC-123', safetyRating: 'Satisfactory', powerUnits: 2, drivers: 3 });
  const url = new URL(s.calls[0][0]);
  assert.equal(url.origin, 'https://mobile.fmcsa.dot.gov');
  assert.equal(url.pathname, '/qc/services/carriers/00123456');
  assert.equal(url.searchParams.get('webKey'), 'synthetic-test-key&secret');
  assert.equal(s.calls[0][1].headers.Accept, 'application/json');
});

test('direct content and legacy missing-value fallbacks remain compatible', async t => {
  const s = await start(t, { provider: async () => ({ ok: true, json: async () => ({ content: { legalName: 'Test', mcs150Number: 'legacy', totalPowerUnits: 0, totalDrivers: 0 } }) }) });
  const r = await s.request('/carrier/12');
  assert.deepEqual(await r.json(), { usdot: '12', legalName: 'Test', dba: '', addr: '', city: '', state: '', zip: '', phone: '', mcNumber: 'legacy', safetyRating: '', powerUnits: '', drivers: '' });
});

test('invalid DOT inputs never reach FMCSA', async t => {
  const s = await start(t);
  for (const dot of ['1', '123456789', '-12', '12.3', 'abc', '12%26webKey%3Dbad']) {
    const r = await s.request('/carrier/' + dot);
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: 'Invalid USDOT number.' });
  }
  assert.equal(s.calls.length, 0);
});

test('missing key fails before a provider request', async t => {
  const s = await start(t, { env: { FMCSA_KEY: '' } });
  assert.equal((await s.request('/carrier/123456')).status, 500);
  assert.equal(s.calls.length, 0);
});

test('upstream error statuses retain the existing 502 contract', async t => {
  const s = await start(t, { provider: async () => ({ ok: false, status: 429 }) });
  const r = await s.request('/carrier/123456');
  assert.equal(r.status, 502);
  assert.deepEqual(await r.json(), { error: 'FMCSA returned HTTP 429.' });
});

test('missing carrier remains 404', async t => {
  const s = await start(t, { provider: async () => ({ ok: true, json: async () => ({ content: {} }) }) });
  const r = await s.request('/carrier/123456');
  assert.equal(r.status, 404);
  assert.deepEqual(await r.json(), { error: 'No carrier found for USDOT 123456.' });
});

test('network and malformed JSON failures return JSON with a 500 status', async t => {
  for (const provider of [async () => { throw new Error('network error'); }, async () => ({ ok: true, json: async () => { throw new SyntaxError('invalid JSON'); } })]) {
    const s = await start(t, { provider });
    const r = await s.request('/carrier/123456');
    assert.equal(r.status, 500);
    assert.equal(typeof (await r.json()).error, 'string');
  }
});

test('CORS defaults, custom origins, denied origins and preflight are preserved', async t => {
  const s = await start(t);
  for (const origin of ['https://dieselservice.io', 'https://www.dieselservice.io', 'https://dieselservice-app.onrender.com']) {
    const r = await s.request('/', { headers: { Origin: origin } });
    assert.equal(r.headers.get('access-control-allow-origin'), origin);
    assert.equal(r.headers.get('vary'), 'Origin');
  }
  const denied = await s.request('/', { headers: { Origin: 'https://untrusted.example' } });
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
  const preflight = await s.request('/carrier/123456', { method: 'OPTIONS', headers: { Origin: 'https://dieselservice.io' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'Content-Type');
  assert.equal(s.calls.length, 0);
  const custom = await start(t, { env: { ALLOWED_ORIGINS: ' https://staging.example , https://second.example ' } });
  assert.equal((await custom.request('/', { headers: { Origin: 'https://staging.example' } })).headers.get('access-control-allow-origin'), 'https://staging.example');
  assert.equal((await custom.request('/', { headers: { Origin: 'https://dieselservice.io' } })).headers.get('access-control-allow-origin'), null);
});

test('unexpected upstream errors cannot expose URLs, keys, or response contents', async t => {
  const s = await start(t, { provider: async () => { throw new Error('https://mobile.fmcsa.dot.gov/?webKey=synthetic-test-key&secret PRIVATE CONTENT'); } });
  const r = await s.request('/carrier/123456');
  assert.equal(r.status, 500);
  assert.deepEqual(await r.json(), { error: 'Lookup failed. Please try again.' });
});

test('an upstream deadline aborts both stalled headers and stalled JSON', async t => {
  for (const stallBody of [false, true]) {
    let observedSignal;
    const s = await start(t, {
      signal: { timeout(ms) { assert.equal(ms, 20000); return AbortSignal.timeout(20); } },
      provider: (_url, options) => {
        observedSignal = options.signal;
        assert.ok(observedSignal, 'The upstream request must have an abort signal');
        const stalled = () => new Promise((resolve, reject) => {
          if (observedSignal.aborted) return reject(observedSignal.reason);
          observedSignal.addEventListener('abort', () => reject(observedSignal.reason), { once: true });
        });
        return stallBody ? { ok: true, json: stalled } : stalled();
      },
    });
    const r = await s.request('/carrier/123456');
    assert.equal(r.status, 504);
    assert.deepEqual(await r.json(), { error: 'FMCSA lookup timed out. Please try again.' });
    assert.equal(observedSignal.aborted, true);
    assert.equal(s.calls.length, 1, 'No automatic retry may amplify provider traffic');
  }
});
