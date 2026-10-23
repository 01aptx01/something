import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walkable } from '../src/immersive/navigation.ts';

const ground = (world, x, z, height = 0, obstacles = []) => walkable(world, x, z, obstacles, height);

test('deck, jetty and island have a continuous route without stepping onto water', () => {
  for (let x = 0; x <= 25; x += .1) assert.equal(ground(0, x, 1), 0);
  assert.equal(ground(0, 14.5, 5), 0, 'harbor arrival stands on the island');
  assert.equal(ground(0, 20, -14), 0);
  assert.equal(ground(0, 5, 6), null, 'ocean beside the jetty blocks walking');
  assert.equal(ground(0, 0, -9), null, 'bow edge blocks falling');
  assert.equal(ground(0, 33, 0), null, 'far coast blocks falling');
});
test('wisteria path connects to shrine and the stream crossing stays on the bridge', () => {
  for (let z = 13; z >= -21; z -= .1) assert.equal(ground(1, 0, z), 0);
  for (let x = 0; x <= 25; x += .1) assert.equal(ground(1, x, -1), 0);
  assert.equal(ground(1, 20, -7), null, 'stream cannot be crossed away from bridge');
  assert.equal(ground(1, -27, 0), null);
});
test('city ramp reaches the wall continuously and wall edges block walking off', () => {
  let height = 0;
  for (let z = 13; z >= -21; z -= .1) {
    const next = ground(2, 12, z, height);
    assert.notEqual(next, null); assert.ok(Math.abs(next - height) < .03); height = next;
  }
  assert.ok(height > 8.9);
  assert.equal(ground(2, 20, -21.2, 9), 9, 'wall walk extends sideways');
  assert.equal(ground(2, 20, -20, 9), null, 'inner edge blocks falling');
  assert.equal(ground(2, 20, -26, 9), null, 'outer edge blocks falling');
  assert.equal(ground(2, 0, -23, 0), null, 'ground route stops at gate boundary');
});
test('building and tree footprints include a camera clearance', () => {
  const obstacle = [{ x: 0, z: 0, w: 2, d: 2 }];
  assert.equal(ground(1, 0, 0, 0, obstacle), null);
  assert.equal(ground(1, 1.15, 0, 0, obstacle), null);
  assert.equal(ground(1, 1.3, 0, 0, obstacle), 0);
});
