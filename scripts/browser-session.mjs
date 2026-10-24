import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

// Requires Node 22+ and a running Chromium with --remote-debugging-port=9223.
const cdp = process.env.CDP_URL ?? 'http://127.0.0.1:9223';
const app = process.env.APP_URL ?? 'http://127.0.0.1:5173';
const screenshots = process.env.SCREENSHOT_DIR;
export const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function session(width = 1440, height = 900, mobile = false) {
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
    const timer = setTimeout(() => { pending.delete(key); reject(new Error(`CDP timeout: ${method}`)); }, method==='Page.captureScreenshot'?45000:15000);
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
  const key = async (key, code = key) => { const windowsVirtualKeyCode = ({Escape:27,Tab:9,Enter:13,Home:36,ArrowLeft:37,ArrowUp:38,ArrowRight:39,ArrowDown:40,' ':32})[key] ?? key.toUpperCase().charCodeAt(0); await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, ...(key==='Enter'?{text:'\r',unmodifiedText:'\r'}:{}) }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode }); };
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

