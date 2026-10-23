import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

// Requires Node 22+ and a running Chromium with --remote-debugging-port=9223.
const cdp = process.env.CDP_URL ?? 'http://127.0.0.1:9223';
const app = process.env.APP_URL ?? 'http://127.0.0.1:5173';
const screenshots = process.env.SCREENSHOT_DIR;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function session(width = 1440, height = 900, mobile = false) {
  const target = await (await fetch(`${cdp}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  let id = 0;
  const pending = new Map(), listeners = new Map(), errors = [];
  ws.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
    listeners.get(message.method)?.(message.params);
    const request = pending.get(message.id);
    if (request) { pending.delete(message.id); clearTimeout(request.timer); message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result); }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const key = ++id;
    const timer = setTimeout(() => { pending.delete(key); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(key, { resolve, reject, timer });
    ws.send(JSON.stringify({ id: key, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  };
  const until = async (expression, timeout = 10000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await evaluate(expression)) return; await wait(70); }
    throw new Error(`UI timeout: ${expression}`);
  };
  const metrics = (w, h, touch = false) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: touch });
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const key = async (key, code = key) => { const windowsVirtualKeyCode = key === 'Escape' ? 27 : key === 'Tab' ? 9 : key === ' ' ? 32 : key.toUpperCase().charCodeAt(0); await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode }); };
  const navigate = async () => { await send('Page.navigate', { url: app }); await until('document.querySelectorAll(".world-card").length === 3 && document.querySelector("canvas").width > 300 && document.querySelector("#app").getAttribute("aria-busy") !== "true"'); await wait(400); };
  const enter = async index => { await click(`[data-world="${index}"]`); await until(`document.querySelector('#app').dataset.world === '${index}' && document.querySelector('#app').getAttribute('aria-busy') === 'false'`); await wait(450); };
  const back = async () => { await click('#back-button'); await until('!document.querySelector("#app").dataset.world && document.querySelector("#app").getAttribute("aria-busy") === "false"'); };
  const shot = async name => {
    if (!screenshots) return;
    await fs.mkdir(screenshots, { recursive: true });
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await fs.writeFile(path.join(screenshots, name + '.png'), Buffer.from(data, 'base64'));
  };
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true }); await metrics(width, height, mobile);
  return { send, evaluate, until, click, key, navigate, enter, back, shot, metrics, listeners, errors,
    close: async () => { ws.close(); await fetch(`${cdp}/json/close/${target.id}`); } };
}

const s = await session();
try {
  const failures = [];
  s.listeners.set('Network.loadingFailed', p => failures.push(p.errorText));
  await s.navigate();
  await s.evaluate('localStorage.removeItem("anime-worlds-discoveries-v1")');
  await s.navigate();
  await s.shot('hub');
  for (const [index, name] of [[0, 'one-piece'], [1, 'demon-slayer'], [2, 'attack-on-titan']]) {
    await s.enter(index);
    assert.equal(await s.evaluate('document.querySelector("#world-picker").inert'), true);
    assert.equal(await s.evaluate('document.activeElement.id'), 'world-canvas');
    await s.shot(name);
    await s.key(' ', 'Space');
    await s.until('document.querySelector("#world-action").disabled');
    await wait(450); await s.shot(name + '-action');
    await s.click('.landmark-marker:not([hidden])');
    await s.until('document.querySelector("#explore-dialog").open');
    await s.key('Escape');
    await s.until('!document.querySelector("#explore-dialog").open');
    assert.equal(await s.evaluate('document.querySelector("#app").dataset.world'), String(index));
    await s.click('#explore-toggle');
    for (let i = 0; i < 2; i++) await s.evaluate(`document.querySelectorAll('.note-choice')[${i}].click()`);
    assert.match(await s.evaluate('document.querySelector("#explore-toggle").textContent'), /2\/2/);
    if (index === 1) await s.shot('field-notes');
    await s.key('Escape');
    await s.key('c', 'KeyC');
    assert.equal(await s.evaluate('document.querySelector("#app").classList.contains("is-cinematic")'), true);
    if (index === 0) await s.shot('cinematic');
    await s.key('Escape');
    assert.equal(await s.evaluate('document.querySelector("#app").classList.contains("is-cinematic")'), false);
    await s.until('!document.querySelector("#world-action").disabled', 14000);
    await s.evaluate('document.querySelector("canvas").focus()');
    for (let n = 0; n < 10; n++) { await s.key('Tab'); assert.equal(await s.evaluate('!!document.activeElement.closest("#world-picker")'), false, 'hidden world cards cannot receive Tab'); }
    await s.back();
    assert.equal(await s.evaluate('document.activeElement.dataset.world'), String(index));
    assert.equal(await s.evaluate('document.querySelector("#toast").textContent'), '');
    console.log(`PASS desktop: ${name}, effect, markers, notes, cinematic, focus`);
  }
  await s.metrics(390, 844, true); await s.navigate(); await s.shot('mobile-hub');
  for (let i = 0; i < 3; i++) {
    await s.enter(i);
    assert.match(await s.evaluate('document.querySelector("#explore-toggle").textContent'), /2\/2/, 'progress survives page reload');
    const box = await s.evaluate('document.querySelector("#world-toolbar").getBoundingClientRect().toJSON()');
    assert.ok(box.left >= 0 && box.right <= 390 && box.bottom <= 844, 'toolbar fits mobile');
    await s.click('#explore-toggle');
    assert.equal(await s.evaluate('document.querySelectorAll(".note-choice").length'), 2, 'cropped landmarks remain accessible');
    await s.key('Escape');
    if (i === 1) await s.shot('mobile-demon-slayer');
    const point = await s.evaluate('(()=>{const r=document.querySelector("#world-action").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
    await s.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await s.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await s.until('document.querySelector("#world-action").disabled');
    await s.back();
  }
  await s.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }); await s.navigate();
  assert.equal(await s.evaluate('document.querySelector("canvas").width'), 585, 'retina mobile pixel ratio is capped consistently');
  await s.metrics(844, 390, true); await wait(250); await s.shot('landscape-hub'); await s.enter(2);
  const fits = await s.evaluate('(()=>{const p=document.querySelector("#world-panel").getBoundingClientRect(),t=document.querySelector("#world-toolbar").getBoundingClientRect();return {top:p.top,bottom:p.bottom,toolbar:t.top}})()');
  assert.ok(fits.top >= 62 && fits.bottom <= fits.toolbar, `landscape fits: ${JSON.stringify(fits)}`);
  await s.back();
  await s.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await s.metrics(1440, 900); await s.navigate(); await s.enter(1);
  const before = await s.evaluate('[...document.querySelectorAll(".landmark-marker")].map(x=>x.style.left).join()');
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1380, y: 740 }); await wait(300);
  assert.equal(await s.evaluate('[...document.querySelectorAll(".landmark-marker")].map(x=>x.style.left).join()'), before, 'reduced motion disables parallax');
  await s.click('#world-action'); await s.until('document.querySelector("#toast").textContent.includes("สายน้ำ")');
  assert.equal(s.errors.length, 0, JSON.stringify(s.errors));
  assert.equal(failures.length, 0, JSON.stringify(failures));
  console.log('PASS mobile/touch, landscape, reduced motion, no runtime/resource errors');
} finally { await s.close(); }

for (const mode of ['fail', 'cancel', 'timeout']) {
  const b = await session();
  const held = [];
  try {
    await b.send('Fetch.enable', { patterns: [{ urlPattern: '*/artwork/one-piece.webp', requestStage: 'Request' }] });
    b.listeners.set('Fetch.requestPaused', p => { if (mode === 'fail') void b.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'Failed' }); else held.push(p.requestId); });
    await b.navigate(); await b.click('[data-world="0"]');
    await b.until('document.querySelector("#app").getAttribute("aria-busy") === "true"');
    if (mode === 'cancel') { await b.key('Escape'); }
    else await b.until('document.querySelector("#toast").textContent.includes("ไม่สำเร็จ")', 13000);
    await b.until('document.querySelector("#app").getAttribute("aria-busy") === "false"');
    assert.equal(await b.evaluate('document.querySelector("#app").dataset.world'), undefined);
    for (const requestId of held) await b.send('Fetch.continueRequest', { requestId });
    await b.send('Fetch.disable'); await wait(700);
    assert.equal(await b.evaluate('document.querySelector("#app").dataset.world'), undefined, 'late response cannot reopen a cancelled world');
    await b.enter(0);
    assert.equal(b.errors.length, 0, JSON.stringify(b.errors));
    console.log(`PASS loading ${mode}: returns to hub and retries`);
  } finally { await b.close(); }
}
console.log('All browser checks passed.');
