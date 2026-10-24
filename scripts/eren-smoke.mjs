import assert from 'node:assert/strict';
import {session,wait} from './browser-session.mjs';

const s=await session(),requests=[];
s.listeners.set('Network.requestWillBeSent',p=>requests.push(p.request.url));
const ready=id=>s.until(`document.querySelector('canvas').dataset.modelState==='ready'&&document.querySelector('canvas').dataset.modelAsset==='${id}'`,30000);
const physical=async selector=>{
 const p=await s.evaluate(`(()=>{const b=document.querySelector(${JSON.stringify(selector)}),r=b.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,t=document.elementFromPoint(x,y);return {x,y,ok:!!t&&(t===b||b.contains(t))}})()`);
 assert.ok(p.ok,`Reachable control: ${selector}`);
 for(const type of ['mousePressed','mouseReleased'])await s.send('Input.dispatchMouseEvent',{type,x:p.x,y:p.y,button:'left',clickCount:1});
};
try{
 await s.navigate();
 const baseline=await s.evaluate('({g:Number(document.querySelector("canvas").dataset.geometries),t:Number(document.querySelector("canvas").dataset.textures)})');
 await s.enter(2);assert.equal(await s.evaluate('document.querySelectorAll("#scene-cast button").length'),3);
 await physical('[data-scene-character="eren"]');await ready('eren');
 assert.equal(await s.evaluate('document.querySelector("#character-counter").textContent'),'03 / 03');
 assert.equal(await s.evaluate('document.querySelector(".gallery-presentation [data-presentation=anime]").disabled'),true);
 for(const view of ['full','face','back']){await physical(`[data-model-view="${view}"]`);await wait(180);await s.shot(view==='full'?'model-eren':`model-${view}-eren`);}
 await s.until('Number(document.querySelector("canvas").dataset.modelBlinkCount)>0',12000);
 await s.click('[data-model-view="full"]');for(let i=0;i<3;i++)await s.click('#model-zoom-in');await s.shot('model-gear-eren');
 await s.click('#character-next');await ready('levi');
 await s.click('.gallery-presentation [data-presentation="anime"]');await s.until('!document.querySelector("#character-art").hidden');
 await s.click('#character-prev');await ready('eren');assert.equal(await s.evaluate('document.querySelector("#app").dataset.presentation'),'3d');
 await s.click('#character-list [data-character="1"]');await ready('mikasa');await s.click('#gallery-close');
 assert.equal(await s.evaluate('document.querySelector("#app").dataset.presentation'),'anime');
 await s.back();await s.until(`Number(document.querySelector('canvas').dataset.geometries)<=${baseline.g+2}&&Number(document.querySelector('canvas').dataset.textures)<=${baseline.t+1}`,20000);
 console.log('PASS Eren full/face/back/gear, blink, direct entry, 3-character navigation, portrait transitions, world restoration and disposal');
 for(const [width,height] of [[390,844],[320,740],[844,390]]){
  await s.metrics(width,height,true);await s.enter(2);await physical('[data-scene-character="eren"]');await ready('eren');
  for(let c=0;c<3;c++)await physical(`#character-list [data-character="${c}"]`);await ready('eren');
  assert.ok(await s.evaluate(`['#character-list','.sculpture-tools','.model-tools'].every(sel=>{const r=document.querySelector(sel).getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})`));
  await s.shot(`eren-${width}x${height}`);await s.click('#gallery-close');await s.back();
 }
 await s.metrics(1440,900);await s.enter(2);const start=requests.length;
 await s.click('#world-presentation [data-presentation="3d"]');
 await s.until('Number(document.querySelector("canvas").dataset.triangles)>15000');
 for(let i=0;i<100&&!requests.slice(start).some(url=>url.endsWith('/models/eren.glb'));i++)await wait(100);
 assert.ok(requests.slice(start).some(url=>url.endsWith('/models/eren.glb')),'free-walk world loads Eren alongside Levi and Mikasa');
 await s.until('Number(document.querySelector("canvas").dataset.triangles)>350000',30000);
 await s.shot('eren-in-world');await s.back();
 await s.until(`Number(document.querySelector('canvas').dataset.geometries)<=${baseline.g+2}&&Number(document.querySelector('canvas').dataset.textures)<=${baseline.t+1}`,20000);
 assert.equal(requests.some(url=>/eren\.(webp|png)/.test(url)),false,'no nonexistent portrait or thumbnail requests');
 assert.equal(s.errors.length,0,JSON.stringify(s.errors));
 console.log('PASS Eren 320px/mobile/landscape, all three controls, world cast loading, disposal, no missing-art requests or runtime exceptions');
}finally{await s.close();}
