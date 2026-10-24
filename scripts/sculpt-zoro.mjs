// Rebuild only when the official local state explicitly unlocks this blockout.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const skill=path.join(root,'.tools/img2threejs');
const state='../../.img2threejs/cast/zoro/state.json';
const spec='../../.img2threejs/cast/zoro/character-sculpt-spec.json';
const run=(command,args,cwd)=>{
 const result=spawnSync(command,args,{cwd,stdio:'inherit'});
 if(result.error)throw result.error;
 if(result.status!==0)process.exit(result.status??1);
};
run('node',['scripts/setup-img2threejs.mjs','--check'],root);
// Exit 3 is deliberately propagated. Never reset the state or raise its limits.
run('python3',['forge/next.py','--state',state,spec],skill);
const current=JSON.parse(fs.readFileSync(path.join(skill,state),'utf8'));
if(current.currentStep!=='build-current-pass'||current.currentPass!=='blockout'||current.iterationAction==='refine-code'){
 console.error('This command only emits an unlocked blockout. Follow the exact next command printed above.');process.exit(2);
}
run('python3',['scripts/author-zoro-spec.py'],root);
run('python3',['forge/stage2_spec/validate_sculpt_spec.py',spec,'--strict-quality'],skill);
const args=['forge/stage3_build/generate_threejs_factory.py',spec,'--out','../../src/sculpt/createZoroModel.ts','--pass-id','blockout'];
if(current.iterationAction==='refine-spec')args.push('--force');
run('python3',args,skill);
