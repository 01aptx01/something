import { STORIES } from './immersive/catalog.ts';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
const key = 'anime-worlds-discoveries-v1';
export class Journal extends EventTarget {
  private found = new Set<string>();
  private storage?: StorageLike;
  constructor(storage?: StorageLike) {
    super();this.storage=storage;
    try { const saved: unknown = JSON.parse(storage?.getItem(key) ?? '[]'); if (Array.isArray(saved)) this.found = new Set(saved.filter((x): x is string => typeof x === 'string')); } catch { /* Session progress remains available when storage is denied. */ }
  }
  has(world: number, id: string) { return this.found.has(`${world}:${id}`); }
  discover(world: number, id: string) {
    if (this.has(world,id)) return;
    this.found.add(`${world}:${id}`);
    try { this.storage?.setItem(key,JSON.stringify([...this.found])); } catch { /* Storage is optional. */ }
    this.dispatchEvent(new Event('change'));
  }
  count(world: number, scene?: number) {
    const entries=scene===undefined?STORIES[world].flatMap(s=>s.landmarks):STORIES[world][scene].landmarks;
    return entries.filter(l=>this.has(world,l.id)).length;
  }
}
function storage() { try { return globalThis.localStorage; } catch { return undefined; } }
export const journal = new Journal(storage());
