import test from 'node:test';
import assert from 'node:assert/strict';
import {CHARACTER_REGIONS,characterAt} from '../src/immersive/character-regions.ts';

import {targets} from './fixtures/character-targets.mjs';
test('the 17 visible character targets across nine paintings select the correct character',()=>{
 for(let w=0;w<3;w++)for(let s=0;s<3;s++)for(const [id,u,v] of targets[w][s])assert.equal(characterAt(w,s,u,v),id,`${w}/${s} ${id}`);
});
test('background and out-of-image coordinates do not open a model',()=>{
 for(let w=0;w<3;w++)for(let s=0;s<3;s++)for(const [u,v] of [[.1,.1],[.1,.9],[-.2,.5],[1.2,.5]])assert.equal(characterAt(w,s,u,v),undefined);
});
test('only depicted characters have image regions, with normalized source-image coordinates',()=>{
 assert.deepEqual(CHARACTER_REGIONS[0][2].map(r=>r.id),['luffy']);
 for(const world of CHARACTER_REGIONS)for(const scene of world){assert.equal(new Set(scene.map(r=>r.id)).size,scene.length);for(const region of scene){assert.ok(region.polygon.length>=3);for(const [u,v] of region.polygon)assert.ok(u>=0&&u<=1&&v>=0&&v<=1);}}
});
