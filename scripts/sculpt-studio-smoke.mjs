import assert from 'node:assert/strict';
import {session,wait} from './browser-session.mjs';

const base=(process.env.APP_URL??'http://127.0.0.1:5173').replace(/\/$/,'');
const s=await session(1440,1100);
try{
 await s.send('Page.navigate',{url:base+'/sculpt-lab.html'});
 await s.until('window.__sculpt?.ready===true',30000);
 await s.until('document.querySelector("#reference").naturalWidth>0');
 assert.equal(await s.evaluate('window.__sculpt.metadata.accepted'),false);
 await s.click('[data-view="90"]');
 assert.equal(await s.evaluate('document.querySelector("#view-label").textContent'),'90°');
 await s.click('[data-view="head"]');
 assert.equal(await s.evaluate('document.querySelector("#view-label").textContent'),'ใบหน้า');
 await s.click('#reset');
 await s.click('#wireframe');
 assert.equal(await s.evaluate('Object.values(window.__sculpt.model.userData.sculptRuntime.meshes).every(m=>(Array.isArray(m.material)?m.material:[m.material]).every(t=>t.wireframe))'),true);
 await s.click('#wireframe');
 await s.click('#explode');
 assert.equal(await s.evaluate('document.querySelector("#explode").getAttribute("aria-pressed")'),'true');
 await s.click('#reset');
 const rect=await s.evaluate('(()=>{const r=document.querySelector("#stage").getBoundingClientRect();return{x:r.left+r.width*.44,y:r.top+r.height*.43};})()');
 await s.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...rect});
 await s.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...rect});
 assert.notEqual(await s.evaluate('document.querySelector("#selected-part").textContent'),'ลากเพื่อหมุน · เลื่อนเพื่อซูม · แตะเพื่อเลือกชิ้นส่วน');
 await s.shot('sculpt-studio-desktop');
 for(const [width,height] of [[390,844],[320,740]]){
  await s.metrics(width,height,true);await wait(200);
  assert.equal(await s.evaluate('document.documentElement.scrollWidth<=innerWidth'),true,`horizontal overflow at ${width}`);
  await s.click('[data-view="35"]');await s.shot(`sculpt-studio-${width}`);
 }
 assert.equal(s.errors.length,0,JSON.stringify(s.errors));
 await s.evaluate('window.__sculpt.dispose()');
 console.log('Sculpt Studio: production assets, orbit/head views, picking, wireframe, explode/reset, 390/320 layouts and disposal passed.');
}finally{await s.close();}
