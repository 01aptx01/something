import assert from 'node:assert/strict';
import { session, wait } from './browser-session.mjs';

const s = await session();
const position = () => s.evaluate('document.querySelector("#world-canvas").dataset.position.split(",").map(Number)');
const hold = async (key, code, condition) => {
  await s.evaluate('document.querySelector("#world-canvas").focus()');
  await s.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code });
  try { await s.until(condition, 15000); }
  finally { await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code }); }
};
try {
  const failures = [], warnings = [], requests=new Map();
  s.listeners.set('Network.requestWillBeSent',p=>requests.set(p.requestId,p.request.url));
  s.listeners.set('Network.loadingFailed',p=>{const url=requests.get(p.requestId);if(p.canceled&&p.errorText==='net::ERR_ABORTED'&&/\/models\/[^/]+\.glb$/.test(url??''))return;failures.push({error:p.errorText,url});});
  s.listeners.set('Runtime.consoleAPICalled', p => { if (p.type === 'error') warnings.push(p.args.map(a => a.value).join(' ')); });
  await s.navigate();
  await s.evaluate('localStorage.removeItem("anime-worlds-discoveries-v1")'); await s.navigate();
  await s.shot('hub');
  const hubGeometry = Number(await s.evaluate('document.querySelector("canvas").dataset.geometries'));
  for (const [index, name, models] of [[0, 'one-piece', ['luffy','zoro']], [1, 'demon-slayer', ['tanjiro','nezuko']], [2, 'attack-on-titan', ['levi','mikasa']]]) {
    await s.enter(index);
    assert.equal(await s.evaluate('document.querySelector("#world-picker").inert'), true);
    assert.equal(await s.evaluate('document.activeElement.id'), 'world-canvas');
    assert.equal(await s.evaluate('document.querySelector("#app").dataset.presentation'),'anime','anime art is the default');
    await s.until('document.querySelector("#app").dataset.artworkState === "ready" && document.querySelector("canvas").dataset.artBlend === "1.00"');
    assert.equal(await s.evaluate('document.querySelector("canvas").dataset.environmentBuilt'),'false','painted mode does not allocate the 3D environment');
    await s.shot(name);
    await s.click('#explore-toggle');
    assert.equal(await s.evaluate('document.querySelectorAll(".note-choice").length'),6,'journal contains six distinct discoveries');
    for(let note=0;note<2;note++)await s.evaluate(`document.querySelectorAll('.journal-scene')[0].querySelectorAll('.note-choice')[${note}].click()`);
    await s.key('Escape');
    const artView=await s.evaluate('document.querySelector("canvas").dataset.artView');
    await s.click('#view-zoom-in');await s.until('Number(document.querySelector("canvas").dataset.artView.split(",")[2])>1.1');await s.click('#view-reset');
    await hold('d','KeyD',`document.querySelector('canvas').dataset.artView !== ${JSON.stringify(artView)}`);
    await hold('w','KeyW','Number(document.querySelector("canvas").dataset.artView.split(",")[2]) > 1.03');
    await s.key('r','KeyR');
    for(let paintedScene=1;paintedScene<3;paintedScene++) {
      await s.click(`[data-scene="${paintedScene}"]`);
      await s.until(`document.querySelector('#app').dataset.artworkState === 'ready' && document.querySelector('#app').dataset.artScene === '${paintedScene}' && document.querySelector('canvas').dataset.artBlend === '1.00'`);
      await s.shot(`${name}-scene-${paintedScene+1}`);
      await s.click('#explore-toggle');for(let note=0;note<2;note++)await s.evaluate(`document.querySelectorAll('.journal-scene')[${paintedScene}].querySelectorAll('.note-choice')[${note}].click()`);await s.key('Escape');
    }
    await s.click('[data-scene="0"]');await s.until('document.querySelector("#app").dataset.artScene === "0"');
    await s.click('#world-action');await wait(400);await s.shot(name+'-action');
    await s.evaluate('document.querySelector("canvas").focus()');await s.key('c','KeyC');if(index===0)await s.shot('cinematic');await s.key('Escape');
    await s.click('#gallery-open');
    for(let portrait=0;portrait<2;portrait++){
      await s.click(`[data-character="${portrait}"]`);
      await s.until(`document.querySelector('#character-art-stage').dataset.loadedCharacter === '${models[portrait]}' && !document.querySelector('#character-art').hidden`);
      await wait(250);await s.shot(`portrait-${models[portrait]}`);
    }
    const portraitView=await s.evaluate('document.querySelector("#character-art-stage").dataset.view');
    await s.click('#model-zoom-in');assert.notEqual(await s.evaluate('document.querySelector("#character-art-stage").dataset.view'),portraitView);
    await s.key('ArrowLeft');await s.click('#model-reset');
    await s.click('.gallery-presentation [data-presentation="3d"]');
    await s.until('document.querySelector("canvas").dataset.modelState==="ready"',25000);
    await s.key('Escape');
    await s.until('Number(document.querySelector("canvas").dataset.triangles) > 15000');
    await s.shot('3d-'+name);
    const start = await position();
    await hold('w', 'KeyW', `Math.hypot(...document.querySelector('canvas').dataset.position.split(',').map(Number).map((v,i)=>v-${JSON.stringify(start)}[i])) > .3`);
    await s.key('r', 'KeyR');
    assert.deepEqual(await position(), start, 'R restores the scene spawn');
    const heading = await s.evaluate('document.querySelector("canvas").dataset.heading');
    await hold('ArrowLeft', 'ArrowLeft', `document.querySelector('canvas').dataset.heading !== ${JSON.stringify(heading)}`);
    await s.key('r', 'KeyR');
    const beforeDrag = await s.evaluate('document.querySelector("canvas").dataset.heading');
    await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 800, y: 500, button: 'left', clickCount: 1 });
    await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 900, y: 530, button: 'left', buttons: 1 });
    await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 900, y: 530, button: 'left', clickCount: 1 });
    await s.until(`document.querySelector('canvas').dataset.heading !== ${JSON.stringify(beforeDrag)}`); await s.key('r', 'KeyR');
    for (let scene = 1; scene < 3; scene++) {
      await s.click(`[data-scene="${scene}"]`); await s.until(`document.querySelector('#app').dataset.scene === '${scene}'`);
      await wait(250); await s.shot(`3d-${name}-scene-${scene + 1}`);
      assert.equal(await s.evaluate('document.querySelectorAll(".scene-choice[aria-pressed=true]").length'), 1);
    }
    if (index === 2) {
      const wall = await position(); assert.equal(wall[1], 10.7, 'wall lookout is actually elevated');
      await hold('w', 'KeyW', 'Number(document.querySelector("canvas").dataset.position.split(",")[1]) < 10.6');
    }
    await s.click('[data-scene="0"]');
    await s.key(' ', 'Space'); await s.until('document.querySelector("#world-action").disabled');
    await wait(400); await s.shot('3d-' + name + '-action');
    await s.click('#explore-toggle'); await s.until('document.querySelector("#explore-dialog").open');
    for (let i = 0; i < 6; i++) await s.evaluate(`document.querySelectorAll('.note-choice')[${i}].click()`);
    assert.match(await s.evaluate('document.querySelector("#explore-toggle").textContent'), /6\/6/);
    if (index === 1) await s.shot('field-notes');
    await s.key('Escape'); await s.until('!document.querySelector("#explore-dialog").open');
    assert.equal(await s.evaluate('document.querySelector("#app").dataset.world'), String(index));
    await s.evaluate('document.querySelector("canvas").focus()'); await s.key('c', 'KeyC');
    assert.equal(await s.evaluate('document.querySelector("#app").classList.contains("is-cinematic")'), true);
    if (index === 0) await s.shot('3d-cinematic'); await s.key('Escape');
    const saved = await position();
    await s.click('#gallery-open'); await s.until('document.querySelector("#app").classList.contains("is-gallery")');
    for (let model = 0; model < 2; model++) {
      await s.click(`[data-character="${model}"]`);
      await s.until(`document.querySelector('#app').dataset.character === '${models[model]}' && document.querySelector('canvas').dataset.modelAsset==='${models[model]}' && document.querySelector('canvas').dataset.modelState==='ready'`);
      await wait(250); await s.shot(`model-${models[model]}`);
    }
    await s.until('!!document.querySelector("canvas").dataset.modelView');
    const modelView = await s.evaluate('document.querySelector("canvas").dataset.modelView');
    await s.key('ArrowRight'); await s.until(`document.querySelector('canvas').dataset.modelView !== ${JSON.stringify(modelView)}`);
    const rotated = await s.evaluate('document.querySelector("canvas").dataset.modelView');
    await s.click('#model-zoom-in'); await s.until(`document.querySelector('canvas').dataset.modelView !== ${JSON.stringify(rotated)}`);
    await s.click('#model-reset'); await s.click('#model-spin');
    await s.until('Number(document.querySelector("canvas").dataset.modelRotation) > .01');
    await s.key('Escape'); await s.until('!document.querySelector("#app").classList.contains("is-gallery")');
    assert.deepEqual(await position(), saved, 'gallery returns to the same exploration position');
    assert.equal(await s.evaluate('document.activeElement.id'), 'gallery-open');
    await s.until('!document.querySelector("#world-action").disabled', 15000);
    await s.back();
    assert.equal(await s.evaluate('document.activeElement.dataset.world'), String(index));
    await s.until(`Number(document.querySelector('canvas').dataset.geometries) <= ${hubGeometry + 2}`, 15000);
    console.log(`PASS ${name}: anime default, 3 painted scenes, pan/zoom, 2 portraits, optional 3D scenes, walk/look/reset, elevation, effects, notes, cinematic, 2 volumetric models, orbit/zoom/spin, restore, disposal`);
  }
  await s.metrics(390, 844, true); await s.navigate(); await s.shot('mobile-hub');
  for (let world = 0; world < 3; world++) {
    await s.enter(world);
    assert.match(await s.evaluate('document.querySelector("#explore-toggle").textContent'), /6\/6/, 'progress survives reload');
    const fits = await s.evaluate(`['#world-toolbar','#scene-list','#gallery-open','.movement-pad'].every(q=>{const r=document.querySelector(q).getBoundingClientRect();return r.left>=0&&r.right<=390&&r.bottom<=844})`);
    assert.equal(fits, true, 'mobile controls fit viewport');
    if(world===1){
      await s.shot('mobile-demon-slayer');await s.click('#gallery-open');
      await s.until('document.querySelector("#character-art-stage").dataset.loadedCharacter === "tanjiro" && !document.querySelector("#character-art").hidden');
      await wait(250);await s.shot('mobile-gallery');
      await s.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:130,y:420,id:1}]});
      await s.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:130,y:420,id:1},{x:260,y:420,id:2}]});
      await s.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:110,y:420,id:1},{x:280,y:420,id:2}]});
      await s.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      assert.ok(await s.evaluate('Number(document.querySelector("#character-art-stage").dataset.view.split(",")[2])>1.15'),'portrait pinch zoom works');
      await s.click('#model-reset');await s.key('Escape');
    }
    // Check touch input in the default art mode before preserving the existing free-walk checks.
    const touchArt=await s.evaluate('document.querySelector("canvas").dataset.artView');
    await s.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:260,y:420}]});
    await s.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:300,y:420}]});
    await s.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await s.until(`document.querySelector('canvas').dataset.artView !== ${JSON.stringify(touchArt)}`);
    await s.click('#world-presentation [data-presentation="3d"]');
    const start = await position();
    const point = await s.evaluate('(()=>{const r=document.querySelector(".forward").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
    await s.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, id: 1 }] });
    await s.until(`document.querySelector('canvas').dataset.position !== ${JSON.stringify(start.map(v=>v.toFixed(3)).join(','))}`, 15000);
    // A second finger can look while the first holds the movement control.
    const heading = await s.evaluate('document.querySelector("canvas").dataset.heading');
    await s.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, id: 1 }, { x: 260, y: 380, id: 2 }] });
    await s.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, id: 1 }, { x: 310, y: 380, id: 2 }] });
    await s.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await s.until(`document.querySelector('canvas').dataset.heading !== ${JSON.stringify(heading)}`);
    await s.click('[data-scene="0"]');
    if (world === 1) await s.shot('3d-mobile-demon-slayer');
    await s.click('#gallery-open'); await s.until('document.querySelector("#app").classList.contains("is-gallery")');
    await s.until('document.querySelector("canvas").dataset.modelState==="ready"',25000);
    if (world === 1) await s.shot('3d-mobile-gallery');
    await s.click('[data-character="1"]'); await s.click('#model-zoom-out'); await s.click('#gallery-close'); await s.back();
  }
  await s.metrics(844, 390, true); await s.navigate(); await s.shot('landscape-hub'); await s.enter(2); await s.shot('landscape-world');
  await s.click('#gallery-open');await s.until('document.querySelector("#character-art-stage").dataset.loadedCharacter==="levi" && !document.querySelector("#character-art").hidden');await wait(250); await s.shot('landscape-gallery'); await s.key('Escape'); await s.back();
  await s.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }); await s.navigate();
  assert.equal(await s.evaluate('document.querySelector("canvas").width'), 585);
  await s.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await s.metrics(1440, 900); await s.navigate(); await s.enter(1);
  await s.click('#world-action'); await s.until('document.querySelector("#toast").textContent.includes("สายน้ำ")');
  await s.click('#gallery-open');await s.until('document.querySelector("#character-art-stage").dataset.loadedCharacter==="tanjiro"');
  const reducedPortrait=await s.evaluate('document.querySelector("#character-art").style.transform');await s.click('#model-spin');await wait(400);
  assert.equal(await s.evaluate('document.querySelector("#character-art").style.transform'),reducedPortrait,'reduced motion stops portrait floating');
  await s.click('.gallery-presentation [data-presentation="3d"]');await s.click('#model-spin');await wait(400);
  assert.equal(await s.evaluate('Number(document.querySelector("canvas").dataset.modelRotation)'), 0, 'reduced motion stops automatic model spin');
  await s.key('ArrowRight'); await s.key('Escape'); await s.back();
  assert.equal(s.errors.length, 0, JSON.stringify(s.errors)); assert.equal(failures.length, 0, JSON.stringify(failures)); assert.equal(warnings.length, 0, JSON.stringify(warnings));
  console.log('PASS mobile movement + simultaneous touch look, gallery, landscape, retina, reduced motion, no unexpected console/resource errors');
} finally { await s.close(); }

const b = await session();
try {
  await b.navigate(); await b.click('[data-world="0"]');
  await b.until('document.querySelector("#app").getAttribute("aria-busy") === "true"'); await b.key('Escape');
  await b.until('!document.querySelector("#app").dataset.world && document.querySelector("#app").getAttribute("aria-busy") === "false"');
  await wait(600); assert.equal(await b.evaluate('document.querySelector("#app").dataset.world'), undefined, 'cancelled transition cannot reopen');
  // World geometry is local: failed decorative artwork cannot block entry anymore.
  await b.send('Fetch.enable', { patterns: [{ urlPattern: '*/artwork/*', requestStage: 'Request' }] });
  b.listeners.set('Fetch.requestPaused', p => { void b.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'Failed' }); });
  await b.navigate(); await b.enter(0);await b.until('document.querySelector("#app").dataset.artworkState==="error"');await b.click('#world-presentation [data-presentation="3d"]');await b.until('Number(document.querySelector("canvas").dataset.triangles)>15000'); await b.back(); await b.enter(2);
  assert.equal(b.errors.length, 0, JSON.stringify(b.errors)); console.log('PASS cancel/retry, 3D worlds load even when decorative artwork fails');
} finally { await b.close(); }

const art = await session();
try {
  await art.navigate();await art.enter(0);
  const held=[];
  await art.send('Fetch.enable',{patterns:[{urlPattern:'*/artwork/scenes/one-piece-cove.webp',requestStage:'Request'}]});
  art.listeners.set('Fetch.requestPaused',p=>held.push(p.requestId));
  await art.click('[data-scene="2"]');await art.until('document.querySelector("#app").dataset.artworkState==="loading"');
  await art.click('[data-scene="1"]');await art.until('document.querySelector("#app").dataset.artScene==="1" && document.querySelector("#app").dataset.artworkState==="ready"');
  for(const requestId of held)await art.send('Fetch.continueRequest',{requestId});await art.send('Fetch.disable');await wait(500);
  assert.equal(await art.evaluate('document.querySelector("#app").dataset.artScene'),'1','late image cannot replace the selected scene');
  await art.send('Fetch.enable',{patterns:[{urlPattern:'*/artwork/characters/luffy.webp',requestStage:'Request'}]});
  art.listeners.set('Fetch.requestPaused',p=>{void art.send('Fetch.failRequest',{requestId:p.requestId,errorReason:'Failed'});});
  await art.click('#gallery-open');await art.until('document.querySelector("#portrait-status span").textContent.includes("ไม่สำเร็จ")');
  await art.send('Fetch.disable');
  const retryPoint=await art.evaluate('(()=>{const r=document.querySelector("#portrait-retry").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
  await art.send('Input.dispatchMouseEvent',{type:'mousePressed',...retryPoint,button:'left',clickCount:1});
  await art.send('Input.dispatchMouseEvent',{type:'mouseReleased',...retryPoint,button:'left',clickCount:1});
  await art.until('document.querySelector("#character-art-stage").dataset.loadedCharacter==="luffy" && !document.querySelector("#character-art").hidden');
  await art.key('Escape');await art.back();
  // A new world instance ensures this image is not already in the per-world texture cache.
  await art.enter(0);
  await art.send('Fetch.enable',{patterns:[{urlPattern:'*/artwork/scenes/one-piece-cove.webp',requestStage:'Request'}]});
  art.listeners.set('Fetch.requestPaused',()=>{});
  await art.click('[data-scene="2"]');await art.until('document.querySelector("#app").dataset.artworkState==="error"',12000);
  assert.equal(await art.evaluate('document.querySelector("#app").dataset.artScene'),'0','timeout retains the previous image');
  await art.send('Fetch.disable');await art.click('#anime-retry');await art.until('document.querySelector("#app").dataset.artScene==="2" && document.querySelector("#app").dataset.artworkState==="ready"');
  assert.equal(art.errors.length,0,JSON.stringify(art.errors));
  console.log('PASS image races, portrait failure/retry, scene timeout retains previous image, retry recovers');
} finally {await art.close();}

console.log('All anime and 3D browser checks passed.');
