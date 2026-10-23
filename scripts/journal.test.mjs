import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Journal } from '../src/journal.ts';
import { STORIES } from '../src/immersive/catalog.ts';
const memory = initial => {let value=initial;return {getItem:()=>value,setItem:(_key,next)=>{value=next;}};};

test('old saved discoveries migrate without losing their first-scene progress',()=>{
  const journal=new Journal(memory('["0:sunny","0:grand-line","1:siblings"]'));
  assert.equal(journal.count(0),2);assert.equal(journal.count(0,0),2);assert.equal(journal.count(0,1),0);assert.equal(journal.count(1),1);
});
test('each scene has two unique discoveries and all six persist independently per world',()=>{
  const storage=memory('[]'),journal=new Journal(storage);
  STORIES.forEach((scenes,world)=>{
    assert.equal(new Set(scenes.flatMap(s=>s.landmarks.map(l=>l.id))).size,6);
    scenes.forEach((scene,index)=>{assert.equal(scene.landmarks.length,2);scene.landmarks.forEach(l=>journal.discover(world,l.id));assert.equal(journal.count(world,index),2);});
    assert.equal(journal.count(world),6);
  });
  const restored=new Journal(storage);for(let world=0;world<3;world++)assert.equal(restored.count(world),6);
});
test('denied storage retains session progress and does not duplicate change events',()=>{
  const journal=new Journal({getItem(){throw new Error('Denied');},setItem(){throw new Error('Denied');}});let changes=0;
  journal.addEventListener('change',()=>changes++);journal.discover(0,'sunny');journal.discover(0,'sunny');
  assert.equal(journal.count(0),1);assert.equal(changes,1);
});
test('malformed and unrelated saved values cannot inflate discovery counts',()=>{
  for(const saved of ['invalid','{}','null','[1,null,"2:unknown","0:sunny"]']){
    const journal=new Journal(memory(saved));assert.equal(journal.count(2),0);assert.ok(journal.count(0)<=1);
  }
});
