import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundedOffset, panAfterDrag, portraitLimit } from '../src/immersive/viewport.ts';
test('portrait mobile can reach both ends of a landscape painting without exposing empty borders',()=>{
 const crop=.24,span=1-crop;
 assert.ok(boundedOffset(span,.77,-1)<.005);assert.ok(boundedOffset(span,.77,1)+crop>.995);
 for(let pan=-3;pan<=3;pan+=.01){const offset=boundedOffset(span,.77,pan);assert.ok(offset>=0&&offset+crop<=1);}
});
test('pixel dragging tracks the finger in source-image coordinates',()=>{
 for(const [crop,focus,width] of [[.24,.77,390],[.84,.5,1440]]){
  const initial=boundedOffset(1-crop,focus,0),next=panAfterDrag(crop,focus,0,30,width);
  assert.ok(Math.abs(boundedOffset(1-crop,focus,next)-initial-30/width*crop)<.00001);
 }
});
test('large repeated drags stop at safe bounds',()=>{
 let pan=0;for(let i=0;i<20;i++)pan=panAfterDrag(.24,.77,pan,500,390);
 assert.ok(pan<=1&&pan>=-1);assert.ok(boundedOffset(.76,.77,pan)+.24<=1);
});
test('zoomed portraits can pan all the way from head to feet',()=>{
 const [x,y]=portraitLimit(366,370,2/3,2.8);
 assert.ok(y>=333);assert.ok(x>=158);
 const atFit=portraitLimit(366,370,2/3,1);assert.equal(atFit[1],16);
});
