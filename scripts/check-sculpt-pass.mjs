// Prepare deterministic evidence for the currently unlocked pass. This command
// deliberately stops before AI review; it never invents scores or acceptance.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const root=process.cwd(),skill=path.join(root,'.tools/img2threejs');
const stateFile=path.join(root,'.img2threejs/cast/zoro/state.json');
const spec=path.join(root,'.img2threejs/cast/zoro/character-sculpt-spec.json');
const rel=p=>path.relative(skill,p);
const call=(cmd,args,cwd=skill,options={})=>{
 const p=spawnSync(cmd,args,{cwd,encoding:'utf8',maxBuffer:32*1024*1024,env:{...process.env,...options.env}});
 if(p.error)throw p.error;
 if(options.out)fs.writeFileSync(options.out,p.stdout??'');
 if(p.status!==0)throw new Error(`${cmd} ${args[0]} exited ${p.status}\n${(p.stderr??'').slice(-2000)}\n${(p.stdout??'').slice(-2000)}`);
 return p.stdout;
};
call('python3',['forge/next.py','--state',rel(stateFile),rel(spec)]);
const state=JSON.parse(fs.readFileSync(stateFile,'utf8')),pass=state.currentPass;
if(!['build-current-pass','render-capture','review-contract-read','tier1-diagnostics'].includes(state.currentStep))throw new Error(`Follow the current checklist step: ${state.currentStep}`);
const captures=path.resolve(process.argv[2]??`docs/model-reviews/img2threejs-cast/zoro-${pass}`);
const checks=path.join(root,'.img2threejs/cast/zoro/checks',path.basename(captures));fs.mkdirSync(checks,{recursive:true});
console.log(`Checking ${pass}: ${path.relative(root,captures)}`);
call('node',['--experimental-strip-types','scripts/inspect-sculpt-geometry.mjs'],root);
console.log('Geometry exported with actual vertex normals.');
const run=(script,args,name)=>call('python3',[script,...args],skill,{out:path.join(checks,name)});
const artifact=name=>rel(path.join(checks,name));
run('forge/stage4_review/scalp_exposure.py',['--rings',rel(path.join(root,'.img2threejs/cast/zoro/head-rings.json')),'--hair-points',rel(path.join(root,'.img2threejs/cast/zoro/hair-points.json')),'--v-low','.73','--v-high','1'],'scalp.json');
if(!fs.existsSync(path.join(captures,'capture.json'))){
 call('node',['scripts/capture-sculpt.mjs'],root,{env:{SCREENSHOT_DIR:captures,EXPECTED_SCULPT_PASS:pass}});
}
const capture=JSON.parse(fs.readFileSync(path.join(captures,'capture.json'),'utf8'));
if(capture.metadata.stage!==pass||!capture.metadata.cameraMode?.startsWith('fixed-review'))throw new Error('Capture does not identify this pass and fixed camera.');
const ref=rel(path.join(root,'docs/references/user-cast/zoro.png'));
const shot=name=>rel(path.join(captures,`${name}.png`));
run('forge/stage4_review/self_intersection.py',['/tmp/img2threejs-zoro-meshes.json','--json'],'self-intersection.json');
run('forge/stage4_review/attachment_anchor.py',[rel(spec),'--measured',rel(path.join(root,'.img2threejs/cast/zoro/measured-anchors.json')),'--json'],'attachment-anchors.json');
console.log('Scalp, sampled self-intersection and measured attachment gates passed.');
run('forge/stage4_review/diagnose_render.py',['--reference',ref,'--render',shot('front'),'--map-stripped-render',shot('map-stripped'),'--spec',rel(spec),'--pass-id',pass,'--in-place','--json'],'tier1.json');
run('forge/stage4_review/diagnose_render_multi_angle.py',['--reference',shot('front'),'--orbit',shot('positive'),'--orbit',shot('negative'),'--orbit',shot('right'),'--json'],'multi-angle.json');
run('forge/stage4_review/turntable_gate.py',['--capture',`0=${shot('front')}`,'--capture',`90=${shot('right')}`,'--capture',`180=${shot('rear')}`,'--capture',`270=${shot('left')}`,'--allow-holes','--json'],'turntable.json');
run('forge/stage4_review/interior_difference.py',[ref,shot('front'),'--json'],'interior-difference.json');
const marks=[['build-current-pass',rel(path.join(root,'src/sculpt/createZoroModel.ts'))],['render-capture',rel(path.join(captures,'capture.json'))],['review-contract-read',rel(path.join(root,'.img2threejs/cast/zoro/contracts-read.json'))],['tier1-diagnostics',artifact('tier1.json')],['multi-angle-review',artifact('multi-angle.json')]];
for(const [step,evidence] of marks){
 const current=JSON.parse(fs.readFileSync(stateFile,'utf8'));
 if(current.currentStep===step)call('python3',['forge/state.py','mark',step,'--state',rel(stateFile),'--evidence',evidence]);
}
run('forge/stage3_build/orchestrate_passes.py',['check',rel(spec),'--pass-id',pass],'pass-gate.txt');
call('python3',['forge/state.py','mark','pass-gate-check','--state',rel(stateFile),'--evidence',artifact('pass-gate.txt')]);
run('forge/stage4_review/make_comparison_sheet.py',['--reference',ref,'--render',shot('front'),'--out',rel(path.join(captures,'comparison.png')),'--panel-width','697','--panel-height','1050','--json'],'comparison.json');
const tier1=JSON.parse(fs.readFileSync(path.join(checks,'tier1.json'),'utf8'));
console.log(`READY FOR AGENT VISION ONLY: ${pass}, silhouette IoU ${tier1.checks.silhouetteIoU}; no AI review or production acceptance recorded.`);
console.log(path.relative(root,path.join(captures,'comparison.png')));
