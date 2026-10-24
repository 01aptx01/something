// Resumable intake for the five images supplied in chat. Never generates a model
// or marks missing reference evidence as accepted.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const skill=path.join(root,'.tools/img2threejs');
const request=JSON.parse(fs.readFileSync(path.join(root,'docs/model-reviews/img2threejs-cast/request.json'),'utf8'));
const action=process.argv[2]??'status';
if(!['init','status','admit'].includes(action))throw new Error('Usage: node scripts/img2threejs-cast.mjs [init|status|admit]');
const rel=p=>path.relative(skill,path.join(root,p));
const run=(script,args)=>{
 const p=spawnSync('python3',[script,...args],{cwd:skill,encoding:'utf8'});
 if(p.error)throw p.error;
 return {code:p.status,text:(p.stdout??'')+(p.stderr??'')};
};
const checked=(script,args)=>{const p=run(script,args);if(p.code!==0)throw new Error(p.text);return p.text;};
let blocked=false;
for(const target of request.targets){
 const state=path.join(root,target.state),dir=path.dirname(state);
 if(action==='init'&&!fs.existsSync(state)){
  checked('forge/state.py',['init','--state',rel(target.state),'--reference',rel(target.expectedReference),'--profile','character','--spec',path.join(rel(path.relative(root,dir)),'character-sculpt-spec.json')]);
 }
 if(!fs.existsSync(state))throw new Error('Run npm run skill:cast:init first.');
 // The upstream gate runs before every start/resume; a hard stop cannot be bypassed.
 const next=run('forge/next.py',['--state',rel(target.state)]);
 fs.writeFileSync(path.join(dir,'next-step.txt'),next.text);
 if(next.code!==0)throw new Error(next.text);
 if(action==='init'){
  for(const step of ['image-analysis','reference-suitability']){
   const current=JSON.parse(fs.readFileSync(state,'utf8'));
   if(current.currentStep!==step)continue;
   checked('forge/state.py',['mark',step,'--state',rel(target.state),'--evidence',rel(target.analysis)]);
  }
 }
 if(action==='admit'){
  const current=JSON.parse(fs.readFileSync(state,'utf8'));
  if(current.currentStep==='reference-admission'){
   const args=[current.artifacts.reference,'--out',path.join(rel(path.relative(root,dir)),'admission.json')];
   if(fs.existsSync(path.join(root,target.expectedReference)))args.push('--probe-out',path.join(rel(path.relative(root,dir)),'probe.json'));
   const admission=run('forge/stage1_intake/check_reference_admission.py',args);
   fs.writeFileSync(path.join(dir,'admission-command.txt'),admission.text);
   if(admission.code===0)checked('forge/state.py',['mark','reference-admission','--state',rel(target.state),'--evidence',path.join(rel(path.relative(root,dir)),'admission.json')]);
   else blocked=true;
  }
 }
 const finalNext=run('forge/next.py',['--state',rel(target.state)]);
 fs.writeFileSync(path.join(dir,'next-step.txt'),finalNext.text);
 if(finalNext.code!==0)throw new Error(finalNext.text);
 const current=JSON.parse(fs.readFileSync(state,'utf8'));
 const hasReference=fs.existsSync(path.join(root,target.expectedReference));
 if(!hasReference)blocked=true;
 console.log(`${target.id}: ${current.currentStep}; original reference ${hasReference?'present':'MISSING'}; ${target.expectedReference}`);
}
if(blocked){console.error('INPUT REQUIRED: attach the original image files (or a ZIP). No reference gate was bypassed and no new models were generated.');process.exitCode=2;}
