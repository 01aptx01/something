// Capture actual studio controls and rendering, without editing the screenshots.
// APP_URL=http://127.0.0.1:4174 SCREENSHOT_DIR=docs/screenshots node scripts/capture-cast-details.mjs
import assert from 'node:assert/strict';
import {session,wait} from './browser-session.mjs';

assert.ok(process.env.SCREENSHOT_DIR,'Set SCREENSHOT_DIR for the detail images');
const s=await session();
const ready=id=>s.until(`document.querySelector('canvas').dataset.modelState==='ready'&&document.querySelector('canvas').dataset.modelAsset==='${id}'`,30000);
try{
 await s.navigate();
 for(const [world,cast] of [[0,[['zoro',1]]],[1,[['tanjiro',0],['nezuko',1]]],[2,[['levi',0],['mikasa',1],['eren',2]]]]){
  if(process.env.CAST_CAPTURE_WORLD!==undefined&&world!==Number(process.env.CAST_CAPTURE_WORLD))continue;
  await s.enter(world);
  for(const [index,[id,choice]] of cast.entries()){
   if(index===0)await s.click(`[data-scene-character="${id}"]`);
   else await s.click(`#character-list [data-character="${choice}"]`);
   await ready(id);
   if(process.env.CAPTURE_MODEL_VIEWS==='1')for(const view of ['full','face','back']){
    await s.click(`[data-model-view="${view}"]`);await wait(180);
    await s.shot(view==='full'?`model-${id}`:`model-${view}-${id}`);
   }
   await s.click('[data-model-view="full"]');
   for(let i=0;i<3;i++)await s.click('#model-zoom-in');
   await wait(180);await s.shot(`model-gear-${id}`);
   if(id==='levi'){
    await s.click('[data-model-view="back"]');
    for(let i=0;i<4;i++)await s.click('#model-zoom-in');
    await wait(180);await s.shot('model-cape-levi');
   }
   console.log(`CAPTURED costume/equipment: ${id}`);
  }
  await s.click('#gallery-close');await s.back();
 }
 assert.equal(s.errors.length,0,JSON.stringify(s.errors));
}finally{await s.close();}
