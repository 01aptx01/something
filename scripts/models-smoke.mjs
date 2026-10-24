import assert from 'node:assert/strict';
import {session,wait} from './browser-session.mjs';

const s=await session();const modelRequests=[];
s.listeners.set('Network.requestWillBeSent',e=>{if(/\/models\/.*\.glb/.test(e.request.url))modelRequests.push(e.request.url);});
const ready=id=>s.until(`document.querySelector('canvas').dataset.modelState==='ready'&&document.querySelector('canvas').dataset.modelAsset==='${id}'`,25000);
const click=async selector=>{
 const p=await s.evaluate(`(()=>{const b=document.querySelector(${JSON.stringify(selector)}),r=b.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,t=document.elementFromPoint(x,y);return {x,y,visible:!!t&&(t===b||b.contains(t))}})()`);
 assert.ok(p.visible,`physical control is unobstructed: ${selector}`);
 await s.send('Input.dispatchMouseEvent',{type:'mousePressed',x:p.x,y:p.y,button:'left',clickCount:1});
 await s.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:p.x,y:p.y,button:'left',clickCount:1});
};
try{
 await s.navigate();
 const hub=await s.evaluate('({geometry:Number(document.querySelector("canvas").dataset.geometries),textures:Number(document.querySelector("canvas").dataset.textures)})');
 const cast=[['luffy','zoro'],['tanjiro','nezuko'],['levi','mikasa']];
 for(let w=0;w<3;w++){
  const before=modelRequests.length;await s.enter(w);await s.click('#gallery-open');
  await s.until('!document.querySelector("#character-art").hidden');assert.equal(modelRequests.length,before,'anime mode does not load GLBs');
  await click('.gallery-presentation [data-presentation="3d"]');
  for(let c=0;c<2;c++){
   if(c)await click(`#character-list [data-character="${c}"]`);
   await ready(cast[w][c]);await wait(200);await s.shot(`model-${cast[w][c]}`);
   const full=await s.evaluate('document.querySelector("canvas").dataset.modelView');
   await click('[data-model-view="face"]');await s.until(`document.querySelector('canvas').dataset.modelView!==${JSON.stringify(full)}`);await wait(150);await s.shot(`model-face-${cast[w][c]}`);
   await click('[data-model-view="back"]');await wait(150);await s.shot(`model-back-${cast[w][c]}`);
   await click('[data-model-view="full"]');console.log(`PASS model views: ${cast[w][c]}`);
  }
  await click('#studio-light');assert.match(await s.evaluate('document.querySelector("#studio-light").textContent'),/แสงจันทร์/);await s.shot(`studio-light-${w}`);
  await s.click('#gallery-close');await s.back();
  await s.until(`Number(document.querySelector('canvas').dataset.geometries)<=${hub.geometry+2}&&Number(document.querySelector('canvas').dataset.textures)<=${hub.textures+1}`,20000);
  console.log(`PASS sculpted ${cast[w].join('/')} full/face/back, studio lighting, lazy assets, GPU disposal`);
 }
 for(const [width,height] of [[390,844],[320,740],[844,390]]){
  await s.metrics(width,height,true);await s.enter(1);await s.click('#gallery-open');await s.click('.gallery-presentation [data-presentation="3d"]');await ready('tanjiro');
  await click('[data-model-view="face"]');await click('[data-model-view="back"]');await click('[data-model-view="full"]');await click('#studio-light');
  assert.ok(await s.evaluate(`['.sculpture-tools','.model-tools','#character-list'].every(q=>{const r=document.querySelector(q).getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})`));
  await s.shot(`sculpture-${width}x${height}`);await s.click('#gallery-close');await s.back();
 }
 // A failed model is recoverable and never silently presented as a finished exhibit.
 await s.metrics(1440,900);await s.enter(0);await s.click('#gallery-open');
 await s.send('Fetch.enable',{patterns:[{urlPattern:'*/models/*.glb'}]});
 s.listeners.set('Fetch.requestPaused',e=>{void s.send('Fetch.fulfillRequest',{requestId:e.requestId,responseCode:503,body:''});});
 await s.click('.gallery-presentation [data-presentation="3d"]');await s.until('document.querySelector("canvas").dataset.modelState==="error"');assert.equal(await s.evaluate('document.querySelector("#model-retry").hidden'),false);
 await s.send('Fetch.disable');s.listeners.delete('Fetch.requestPaused');await click('#model-retry');await ready('luffy');
 // Hold an older load, then select another sculpt; the older response must not win.
 let held;
 await s.send('Fetch.enable',{patterns:[{urlPattern:'*/models/luffy.glb'}]});
 s.listeners.set('Fetch.requestPaused',e=>{held=e.requestId;});
 await s.click('#character-list [data-character="0"]');
 for(let i=0;i<30&&!held;i++)await wait(100);assert.ok(held);
 await s.click('#character-list [data-character="1"]');await ready('zoro');
 try{await s.send('Fetch.continueRequest',{requestId:held});}catch{/* Aborted fetch may already be removed. */}
 await s.send('Fetch.disable');s.listeners.delete('Fetch.requestPaused');await wait(500);
 assert.equal(await s.evaluate('document.querySelector("canvas").dataset.modelAsset'),'zoro');
 await s.click('.gallery-presentation [data-presentation="anime"]');await s.until('!document.querySelector("#character-art").hidden');
 assert.equal(s.errors.length,0,JSON.stringify(s.errors));
 console.log('PASS 320px/mobile/landscape physical controls, load error/retry, rapid selection race, anime return, no runtime exceptions');
}finally{await s.close();}
