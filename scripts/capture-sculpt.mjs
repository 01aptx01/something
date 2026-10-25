import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {session,wait} from './browser-session.mjs';

const url=(process.env.APP_URL??'http://127.0.0.1:5173').replace(/\/$/,'');
const out=process.env.SCREENSHOT_DIR??'docs/model-reviews/img2threejs-cast/zoro-blockout';
const s=await session(697,1050);
try{
 await s.send('Page.navigate',{url:url+'/sculpt-lab.html?capture=1'});
 await s.until('window.__sculpt?.ready===true',30000);
 const metadata=await s.evaluate('window.__sculpt.metadata');
 assert.equal(metadata.source,'img2threejs-procedural');
 assert.equal(metadata.accepted,false);
 if(process.env.EXPECTED_SCULPT_PASS)assert.equal(metadata.stage,process.env.EXPECTED_SCULPT_PASS);
 assert.ok(metadata.parts>=80);
 await fs.mkdir(out,{recursive:true});
 for(const [name,view] of [['front',0],['positive',35],['negative',-35],['right',90],['rear-three-quarter',135],['rear',180],['left',270],['top','top'],['bottom','bottom'],['head','head'],['head-positive','head35']]){
  await s.evaluate(`window.__sculpt.view(${JSON.stringify(view)})`);await wait(350);
  const {data}=await s.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  await fs.writeFile(`${out}/${name}.png`,Buffer.from(data,'base64'));console.log(name);
 }
 await s.evaluate('window.__sculpt.view(0);window.__sculpt.stripped(true)');await wait(350);
 const unlit=await s.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
 await fs.writeFile(`${out}/map-stripped.png`,Buffer.from(unlit.data,'base64'));
 await s.evaluate('window.__sculpt.stripped(false)');
 assert.equal(s.errors.length,0,JSON.stringify(s.errors));
 const info=await s.evaluate('({triangles:window.__sculpt.renderer.info.render.triangles,drawCalls:window.__sculpt.renderer.info.render.calls,geometries:window.__sculpt.renderer.info.memory.geometries})');
 await fs.writeFile(`${out}/capture.json`,JSON.stringify({metadata,info,errors:s.errors,renderer:'Chromium WebGL / plain renderer; no bloom or depth of field',viewports:[697,1050],sourceUrl:url+'/sculpt-lab.html?capture=1'},null,2)+'\n');
 console.log(JSON.stringify(info));
}catch(error){console.error(JSON.stringify(s.errors));throw error;}finally{await s.close();}
