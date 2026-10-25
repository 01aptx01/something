// Persist the hand refinement after the official strict-gated emitter.
import fs from 'node:fs';
const path='src/sculpt/createZoroModel.ts';let source=fs.readFileSync(path,'utf8');
const pass=JSON.parse(fs.readFileSync('.img2threejs/cast/zoro/character-sculpt-spec.json','utf8')).sculptPipeline.currentPass;
if(source.includes("from './refineZoroGeometry"))throw new Error('Factory already finalized; do not apply twice.');
const marker='  if (meshes["hair"] && nodes["head"]) {';
if(!source.includes(marker))throw new Error('Pinned emitter standProud insertion point changed.');
source="// img2threejs v2.0.0 / Apache-2.0; see tools/licenses/img2threejs-APACHE-2.0.txt.\nimport {refineZoroGeometry} from './refineZoroGeometry.ts';\n"+source;
source=source.replace(marker,`  root.userData.sculptBuildPass = ${JSON.stringify(pass)};\n  refineZoroGeometry(meshes);\n`+marker);
fs.writeFileSync(path,source);
