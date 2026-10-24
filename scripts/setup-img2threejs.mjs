import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const lock=JSON.parse(fs.readFileSync(path.join(root,'tools/img2threejs.lock.json'),'utf8'));
const checkout=path.join(root,lock.checkout),link=path.join(root,lock.skillLink);
const checkOnly=process.argv.includes('--check');
const git=(args,cwd)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const exists=p=>{try{fs.lstatSync(p);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
try{
 // Never replace an unrelated skill or an edited checkout.
 if(exists(link)&&(!fs.lstatSync(link).isSymbolicLink()||path.resolve(path.dirname(link),fs.readlinkSync(link))!==checkout)){
  throw new Error(`Refusing to replace an unmanaged skill: ${link}`);
 }
 if(!exists(checkout)){
  if(checkOnly)throw new Error('Skill not installed. Run npm run skill:install.');
  fs.mkdirSync(path.dirname(checkout),{recursive:true});
  const staging=fs.mkdtempSync(path.join(path.dirname(checkout),'.img2threejs-'));
  try{
   git(['init','--quiet'],staging);git(['remote','add','origin',lock.repository],staging);
   git(['fetch','--quiet','--depth=1','origin',lock.revision],staging);
   git(['checkout','--quiet','--detach','FETCH_HEAD'],staging);
   if(git(['rev-parse','HEAD'],staging)!==lock.revision)throw new Error('Downloaded revision does not match the lock.');
   fs.renameSync(staging,checkout);
  }finally{if(exists(staging))fs.rmSync(staging,{recursive:true});}
 }
 if(git(['rev-parse','HEAD'],checkout)!==lock.revision)throw new Error('Existing checkout differs from the locked revision; it was left intact.');
 if(git(['status','--porcelain'],checkout))throw new Error('Skill checkout contains local edits; it was left intact.');
 const skill=fs.readFileSync(path.join(checkout,'SKILL.md'),'utf8');
 if(!skill.includes(`version: ${lock.skillVersion}`))throw new Error('SKILL.md version does not match the lock.');
 if(!exists(link)){
  if(checkOnly)throw new Error('The project skill link is missing. Run npm run skill:install.');
  fs.mkdirSync(path.dirname(link),{recursive:true});fs.symlinkSync(path.relative(path.dirname(link),checkout),link,'dir');
 }
 if(fs.realpathSync(link)!==fs.realpathSync(checkout))throw new Error('Skill link does not resolve to the shared checkout.');
 const help=execFileSync('python3',['forge/state.py','init','--help'],{cwd:checkout,encoding:'utf8'});
 if(!help.includes('character'))throw new Error('The built-in character profile is unavailable.');
 console.log(`img2threejs ${lock.skillVersion}: installed for this project`);
 console.log(`Revision: ${lock.revision}\nSkill: ${link}/SKILL.md\nProfile: character`);
}catch(e){console.error(e.message);process.exitCode=2;}
