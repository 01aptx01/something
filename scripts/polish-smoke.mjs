import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { session, wait } from './browser-session.mjs';

const s=await session();
const physicalClick=async selector=>{
  const point=await s.evaluate(`(()=>{const b=document.querySelector(${JSON.stringify(selector)}),r=b.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,target=document.elementFromPoint(x,y);return {x,y,visible:!!target&&(target===b||b.contains(target))}})()`);
  assert.ok(point.visible,`button can be clicked without another overlay: ${selector}`);
  await s.send('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',clickCount:1});
  await s.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x,y:point.y,button:'left',clickCount:1});
};
const settled=()=>s.until('document.querySelector("#app").dataset.artworkState==="ready" && document.querySelector("canvas").dataset.artBlend==="1.00"');
const downloads=await fs.mkdtemp('/tmp/anime-capture-');
try {
 await s.navigate();
 await s.evaluate('localStorage.removeItem("anime-worlds-discoveries-v1");localStorage.removeItem("anime-worlds-quality")');await s.navigate();
 await physicalClick('#controls-open');await s.until('document.querySelector("#controls-dialog").open');await s.shot('controls-guide');await s.key('Escape');
 assert.equal(await s.evaluate('document.activeElement.id'),'controls-open','help returns focus to its opener');
 for(let world=0;world<3;world++){
  await s.enter(world);await settled();assert.equal(await s.evaluate('document.querySelector("canvas").dataset.environmentBuilt'),'false');
  const lazyGeometry=Number(await s.evaluate('document.querySelector("canvas").dataset.geometries'));
  assert.ok(lazyGeometry<100,'painted mode keeps only hub plus screen layers on GPU');
  await physicalClick('#scene-next');await s.until('document.querySelector("#app").dataset.scene==="1"');await settled();
  await s.key(']','BracketRight');await s.until('document.querySelector("#app").dataset.scene==="2"');await settled();
  await physicalClick('#scene-prev');await s.until('document.querySelector("#app").dataset.scene==="1"');await settled();
  await physicalClick('#explore-toggle');
  assert.equal(await s.evaluate('document.querySelectorAll(".journal-scene").length'),3);
  assert.equal(await s.evaluate('new Set([...document.querySelectorAll("[data-discovery]")].map(b=>b.dataset.discovery)).size'),6);
  const previous=await s.evaluate('document.querySelector("#explore-toggle").textContent');
  await s.evaluate('document.querySelectorAll(".journal-scene")[1].querySelector(".note-choice").click()');
  assert.notEqual(await s.evaluate('document.querySelector("#explore-toggle").textContent'),previous);
  assert.equal(await s.evaluate('document.querySelectorAll(".scene-choice")[1].querySelector(".scene-progress").textContent'),'1/2');
  await s.evaluate('document.querySelectorAll(".journal-travel")[2].click()');await s.until('!document.querySelector("#explore-dialog").open && document.querySelector("#app").dataset.scene==="2"');await settled();
  await physicalClick('#gallery-open');await s.until('!document.querySelector("#character-art").hidden');
  const first=await s.evaluate('document.querySelector("#app").dataset.character');await physicalClick('#character-next');await s.until(`document.querySelector('#app').dataset.character!==${JSON.stringify(first)}&&!document.querySelector('#character-art').hidden`);
  await s.key('[','BracketLeft');await s.until(`document.querySelector('#app').dataset.character===${JSON.stringify(first)}&&!document.querySelector('#character-art').hidden`);
  assert.equal(await s.evaluate('document.querySelector("canvas").dataset.environmentBuilt'),'false','2D character gallery still avoids the 3D environment');
  await s.key('Escape');await s.back();
 }
 await s.enter(0);await settled();
 await s.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});
 await physicalClick('#save-view');await s.until('!document.querySelector("#save-view").disabled && document.querySelector("#toast").textContent.includes("บันทึก")');
 const filename=path.join(downloads,'anime-worlds-1-scene-1.png');
 let bytes;for(let i=0;i<30;i++){try{bytes=await fs.readFile(filename);break;}catch{await wait(100);}}
 assert.ok(bytes?.length>10000,'saved PNG contains a rendered scene');assert.equal(bytes.readUInt32BE(16),1440);assert.equal(bytes.readUInt32BE(20),900);
 await s.back();
 await s.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:true});await s.navigate();
 await physicalClick('#controls-open');await s.evaluate('const q=document.querySelector("#quality-select");q.value="smooth";q.dispatchEvent(new Event("change"))');
 assert.equal(await s.evaluate('document.querySelector("canvas").width'),390);
 await s.key('Escape');await s.navigate();assert.equal(await s.evaluate('document.querySelector("#quality-select").value'),'smooth');
 await physicalClick('#controls-open');await s.evaluate('const q=document.querySelector("#quality-select");q.value="auto";q.dispatchEvent(new Event("change"))');await s.key('Escape');
 assert.equal(await s.evaluate('document.querySelector("canvas").width'),585);
 await s.enter(1);await settled();
 const before=await s.evaluate('Number(document.querySelector("canvas").dataset.artView.split(",")[2])');
 await s.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:150,y:375,id:1}]});
 await s.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:150,y:375,id:1},{x:270,y:375,id:2}]});
 await s.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:125,y:375,id:1},{x:295,y:375,id:2}]});
 await s.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 await s.until(`Number(document.querySelector('canvas').dataset.artView.split(',')[2])>${before+0.15}`);
 await physicalClick('#view-reset');
 for(let swipe=0;swipe<4;swipe++){
  await s.send('Input.dispatchMouseEvent',{type:'mousePressed',x:50,y:400,button:'left',clickCount:1});
  await s.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:340,y:400,button:'left',buttons:1});
  await s.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:340,y:400,button:'left',clickCount:1});
 }
 await s.until('Number(document.querySelector("canvas").dataset.artView.split(",")[0])<-.95');
 await physicalClick('#view-reset');await s.shot('mobile-immersive');
 for(const [width,height] of [[320,740],[844,390]]){
  await s.metrics(width,height,true);await wait(200);
  assert.ok(await s.evaluate(`['#world-toolbar','.scene-rail','#gallery-open','#world-presentation','.view-tools'].every(q=>{const r=document.querySelector(q).getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})`),`all controls fit ${width}x${height}`);
  await physicalClick('#scene-next');await settled();
  await physicalClick('#gallery-open');await s.until('!document.querySelector("#character-art").hidden');await physicalClick('#character-next');await s.until('!document.querySelector("#character-art").hidden');
  if(width===844)await s.shot('landscape-character');await s.key('Escape');
 }
 assert.equal(s.errors.length,0,JSON.stringify(s.errors));
 console.log('PASS all scene stories/progress, real pointer navigation, lazy 3D, gallery cycling, PNG export, quality persistence, world pinch, 320px mobile and landscape');
}finally{await s.close();await fs.rm(downloads,{recursive:true,force:true});}
