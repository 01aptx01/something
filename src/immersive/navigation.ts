import type { Obstacle } from './kit';

export function walkable(world: number, x: number, z: number, obstacles: Obstacle[], height: number): number | null {
  if (world === 0) {
    const deck = Math.abs(x) < 3.42 && z > -8 && z < 8.35;
    const pier = x >= 3.3 && x <= 14 && z > .10 && z < 2.05;
    const island = x > 13.25 && x < 32.3 && z > -22 && z < 20.5;
    if (!deck && !pier && !island) return null;
  } else if (world === 1) {
    if (x < -26 || x > 27 || z < -29 || z > 25) return null;
    if (x > 17.4 && x < 22.6 && (z < -2.1 || z > .1)) return null;
  } else {
    if (x < -28 || x > 28 || z < -25.8 || z > 27) return null;
    if (x > 10.15 && x < 13.85 && z >= -21 && z <= 13.8) return Math.max(0, (13 - z) / 34 * 9);
    if (z < -20.8 && height > 7) return 9;
    if (height > 1) return null; // Top of the wall cannot be walked off.
    if (z < -22) return null;
  }
  if (obstacles.some(o => Math.abs(x - o.x) < o.w / 2 + .24 && Math.abs(z - o.z) < o.d / 2 + .24)) return null;
  return 0;
}
