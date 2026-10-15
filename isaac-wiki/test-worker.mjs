import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {createHash, webcrypto} from 'node:crypto';

const sharedSource = await fs.readFile(new URL('./shared.js', import.meta.url), 'utf8');
const workerSource = await fs.readFile(new URL('./desktop/worker.js', import.meta.url), 'utf8');
const origin = 'https://isaac.huijiwiki.com';

function sharedContext(digest = (...args) => webcrypto.subtle.digest(...args)) {
  const context = vm.createContext({URL, TextEncoder, TextDecoder, Uint8Array, crypto:{subtle:{digest}}});
  vm.runInContext(sharedSource, context);
  return context;
}

async function workerFailure(code, header = null) {
  const context = sharedContext();
  let resolveMessage;
  const message = new Promise(resolve => { resolveMessage = resolve; });
  let fetchCount = 0;
  Object.assign(context, {
    window:context,
    location:{origin},
    AbortSignal:{timeout(milliseconds) { assert.equal(milliseconds, 90000); return 'fixture-signal'; }},
    fetch:async (url, options) => {
      fetchCount++;
      assert.equal(new URL(url).origin, origin);
      assert.equal(options.credentials, 'include');
      assert.equal(options.signal, 'fixture-signal');
      return {ok:false, status:code, url, headers:{get:name => name.toLowerCase() === 'retry-after' ? header : null}};
    },
    chrome:{webview:{postMessage:resolveMessage}}
  });
  vm.runInContext(workerSource, context);
  context.IsaacDesktopRun('fixture-id', {kind:'page', url:origin + '/wiki/Fixture', title:'Fixture'}, {});
  const result = await message;
  assert.equal(result.channel, 'isaac-desktop');
  assert.equal(result.id, 'fixture-id');
  assert.equal(result.ok, false);
  assert.equal(fetchCount, 1);
  return result;
}

test('HTTP 500 is retryable server failure without verification advice', async () => {
  const result = await workerFailure(500);
  assert.equal(result.statusCode, 500);
  assert.equal(result.blocked, false);
  assert.equal(result.retryAfterMs, 0);
  assert.match(result.error, /服务器错误.*稍后重试/);
  assert.doesNotMatch(result.error, /验证/);
});

test('HTTP 429 is rate limiting and preserves Retry-After seconds', async () => {
  const result = await workerFailure(429, '15');
  assert.equal(result.statusCode, 429);
  assert.equal(result.blocked, true);
  assert.equal(result.retryAfterMs, 15000);
  assert.match(result.error, /限流/);
  assert.doesNotMatch(result.error, /验证/);
});

test('Retry-After dates and invalid values are handled without negative waits', async () => {
  const date = new Date(Date.now() + 30000).toUTCString();
  const dated = await workerFailure(429, date);
  assert.ok(dated.retryAfterMs > 27000 && dated.retryAfterMs <= 30000);
  assert.equal((await workerFailure(429, 'invalid')).retryAfterMs, 0);
  assert.equal((await workerFailure(429, '-2')).retryAfterMs, 0);
  assert.equal((await workerFailure(429, '999999999999')).retryAfterMs, 2147483647);
});

test('HTTP 401/403 retain verification handling, HTTP 400 does not', async () => {
  for (const code of [401, 403]) {
    const result = await workerFailure(code);
    assert.equal(result.statusCode, code);
    assert.equal(result.blocked, true);
    assert.match(result.error, /完成验证/);
  }
  const result = await workerFailure(400);
  assert.equal(result.statusCode, 400);
  assert.equal(result.blocked, false);
  assert.doesNotMatch(result.error, /验证/);
});

test('repeated and concurrent digest requests reuse one unchanged SHA-256 result', async () => {
  let digestCalls = 0;
  const context = sharedContext((...args) => { digestCalls++; return webcrypto.subtle.digest(...args); });
  const url = origin + '/images/common.png';
  const expected = createHash('sha256').update(url).digest('hex');
  const results = await Promise.all([context.IsaacMirror.hash(url), context.IsaacMirror.hash(url)]);
  assert.deepEqual(results, [expected, expected]);
  assert.equal(await context.IsaacMirror.hash(url), expected);
  assert.equal(digestCalls, 1);
  const assets = new Set();
  assets.rejected = new Set();
  assert.equal(await context.IsaacMirror.asset(url + '#sprite', origin, '../assets/', assets), '../assets/' + expected + '.asset#sprite');
  assert.equal(digestCalls, 1);
  assert.ok(assets.has(url));
});

test('digest cache keeps at most 8192 recent entries and evicts oldest requests', async () => {
  let digestCalls = 0;
  const context = sharedContext((...args) => { digestCalls++; return webcrypto.subtle.digest(...args); });
  for (let i = 0; i < 8192; i++) await context.IsaacMirror.hash('fixture-cache-' + i);
  assert.equal(digestCalls, 8192);
  await context.IsaacMirror.hash('fixture-cache-0');
  assert.equal(digestCalls, 8192);
  await context.IsaacMirror.hash('fixture-overflow');
  assert.equal(digestCalls, 8193);
  await context.IsaacMirror.hash('fixture-cache-0');
  assert.equal(digestCalls, 8193);
  await context.IsaacMirror.hash('fixture-cache-1');
  assert.equal(digestCalls, 8194);
});

test('rejected digest requests are removed so a later attempt can succeed', async () => {
  let digestCalls = 0;
  const context = sharedContext((...args) => {
    digestCalls++;
    return digestCalls === 1 ? Promise.reject(new Error('fixture digest failure')) : webcrypto.subtle.digest(...args);
  });
  await assert.rejects(context.IsaacMirror.hash('fixture-retry'), /fixture digest failure/);
  const expected = createHash('sha256').update('fixture-retry').digest('hex');
  assert.equal(await context.IsaacMirror.hash('fixture-retry'), expected);
  assert.equal(digestCalls, 2);
});
