import assert from 'node:assert/strict';
import {session,wait} from './browser-session.mjs';
import {targets} from './fixtures/character-targets.mjs';
const s=await session();
const app='document.querySelector("#app")',canvas='document.querySelector("canvas")';
const settled=()=>s.until(`${app}.dataset.artworkState==='ready'&&${canvas}.dataset.artBlend==='1.00'`);
const ready=id=>s.until(`${canvas}.dataset.modelState==='ready'&&${canvas}.dataset.modelAsset==='${id}'`,30000);
const imagePoint=async(u,v)=>s.evaluate(`(()=>{const t=JSON.parse(${canvas}.dataset.artTransform),pan=${canvas}.dataset.artView.split(',').map(Number);let u=${u},v=${v};const smooth=(x,a,b)=>{const t=Math.max(0,Math.min(1,(x-a)/(b-a)));return t*t*(3-2*t)};for(let i=0;i<3;i++){const f=smooth(u,.52,.85)*(1-smooth(1-v,.75,1)),m=.002+f*.002;u=${u}-pan[0]*m;v=${v}+pan[1]*m;}return {x:(u-t.offset[0])/t.crop[0]*innerWidth,y:(1-(1-v-t.offset[1])/t.crop[1])*innerHeight}})()`);
const mouse=async(type,p,buttons=0)=>s.send('Input.dispatchMouseEvent',{type,...p,button:type==='mouseMoved'&&buttons===0?'none':'left',buttons,clickCount:1});
const physical=async p=>{
 assert.equal(await s.evaluate(`document.elementFromPoint(${p.x},${p.y})===document.querySelector('canvas')`),true,'painted character is actually reachable on the canvas');
 await mouse('mouseMoved',p);await mouse('mousePressed',p,1);await mouse('mouseReleased',p);
};
const back=async(view,scene)=>{await s.key('Escape');await s.until(`!${app}.classList.contains('is-gallery')`);assert.equal(await s.evaluate(`${app}.dataset.presentation`),'anime');assert.equal(await s.evaluate(`${app}.dataset.scene`),String(scene));assert.equal(await s.evaluate(`${canvas}.dataset.artView`),view);assert.equal(await s.evaluate(`${canvas}.dataset.environmentBuilt`),'false');};
try{
 await s.navigate();const baseline=await s.evaluate(`({g:Number(${canvas}.dataset.geometries),t:Number(${canvas}.dataset.textures)})`);
 if(process.env.CHARACTER_TEST_PHASE!=='interactions')for(let w=0;w<3;w++){
  await s.enter(w);await settled();
  for(let scene=0;scene<3;scene++){
   await s.click(`#scene-list [data-scene="${scene}"]`);await settled();
   for(const [id,u,v] of targets[w][scene]){
    const view=await s.evaluate(`${canvas}.dataset.artView`),point=await imagePoint(u,v);
    assert.equal(await s.evaluate(`document.elementFromPoint(${point.x},${point.y})===document.querySelector('canvas')`),true,`visible image target ${w}/${scene}: ${id}`);
    await mouse('mouseMoved',point);await s.until(`${canvas}.dataset.characterHover==='${id}'`);
    if(scene===0)await s.shot(`click-character-world-${w}-${id}`);
    await physical(point);await ready(id);
    assert.equal(await s.evaluate(`${app}.dataset.worldPresentation`),'anime');
    if(id==='luffy'&&scene===0){
     assert.equal(await s.evaluate(`${canvas}.dataset.modelKind`),'uploaded');await s.until(`${canvas}.dataset.modelAnimated==='true'`);
     await s.shot('luffy-uploaded');await s.click('[data-model-view="face"]');await s.shot('luffy-uploaded-face');await s.click('[data-model-view="back"]');await s.shot('luffy-uploaded-back');
     await s.until(`Number(${canvas}.dataset.modelBlinkCount)>0`,15000);
     await s.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await wait(100);const count=await s.evaluate(`${canvas}.dataset.modelBlinkCount`);await wait(1000);assert.equal(await s.evaluate(`${canvas}.dataset.modelBlinkCount`),count);assert.equal(await s.evaluate(`Number(${canvas}.dataset.modelBlink)`),0);await s.send('Emulation.setEmulatedMedia',{features:[]});
    }
    await back(view,scene);console.log(`PASS image target ${w}/${scene}: ${id}`);
   }
  }
  await s.back();await s.until(`Number(${canvas}.dataset.geometries)<=${baseline.g+2}&&Number(${canvas}.dataset.textures)<=${baseline.t+1}`,20000);
  console.log(`PASS world ${w}: actual image clicks, all scene characters, exact restoration, lazy environment, disposal`);
 }
 await s.enter(0);await settled();
 let point=await imagePoint(.75,.42);await mouse('mousePressed',point,1);await mouse('mouseMoved',{x:point.x-50,y:point.y+20},1);await mouse('mouseReleased',{x:point.x-50,y:point.y+20});await wait(200);assert.equal(await s.evaluate(`${app}.classList.contains('is-gallery')`),false,'dragging over a character does not open it');
 await s.click('#view-zoom-in');await wait(350);point=await imagePoint(.75,.42);await physical(point);await ready('luffy');const zoomView=await s.evaluate(`${canvas}.dataset.artView`);await back(zoomView,0);await s.shot('image-restored-after-model');await s.back();
 // Keyboard-accessible direct entry, without requiring a visible image hit region.
 await s.enter(0);await settled();await s.evaluate('document.querySelector("[data-scene-character=zoro]").focus()');await s.key('Enter');await ready('zoro');await s.key('Escape');assert.equal(await s.evaluate('document.activeElement.dataset.sceneCharacter'),'zoro');await s.back();
 for(const [width,height] of [[390,844],[320,740],[844,390]]){
  await s.metrics(width,height,true);await s.enter(1);await settled();
  const before=await s.evaluate(`Number(${canvas}.dataset.artView.split(',')[2])`);
  await s.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:width*.45,y:height*.5,id:1},{x:width*.65,y:height*.5,id:2}]});
  await s.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:width*.4,y:height*.5,id:1},{x:width*.7,y:height*.5,id:2}]});await s.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await s.until(`Number(${canvas}.dataset.artView.split(',')[2])>${before+.1}`);assert.equal(await s.evaluate(`${app}.classList.contains('is-gallery')`),false,'pinch never activates a character');
  await s.click('#view-reset');await wait(200);point=await imagePoint(.73,.57);
  if(width===390){await s.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...point,id:1}]});await s.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}else await s.click('[data-scene-character="tanjiro"]');
  await ready('tanjiro');await s.shot(`direct-model-${width}x${height}`);await s.key('Escape');assert.equal(await s.evaluate(`${app}.dataset.presentation`),'anime');await s.back();
 }
 await s.metrics(1440,900);await s.enter(0);await settled();
 await s.send('Fetch.enable',{patterns:[{urlPattern:'*/models/luffy.glb'}]});s.listeners.set('Fetch.requestPaused',e=>{void s.send('Fetch.fulfillRequest',{requestId:e.requestId,responseCode:503,body:''});});
 await s.click('[data-scene-character="luffy"]');await s.until(`${canvas}.dataset.modelState==='error'`);await s.send('Fetch.disable');s.listeners.delete('Fetch.requestPaused');await s.click('#model-retry');await ready('luffy');await s.key('Escape');
 assert.equal(await s.evaluate(`${app}.dataset.presentation`),'anime');assert.equal(s.errors.length,0,JSON.stringify(s.errors));
 console.log('PASS uploaded GLB, source-image pan/zoom hit testing, drag/pinch suppression, keyboard focus, blink/reduced motion, mobile/landscape, error/retry, no runtime exceptions');
}finally{await s.close();}
