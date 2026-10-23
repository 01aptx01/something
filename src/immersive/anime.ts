import * as T from 'three';
import { boundedOffset, panAfterDrag, portraitLimit } from './viewport';
import { atmosphere } from './atmosphere';
import { WORLDS } from '../worlds';

export type Presentation = 'anime' | '3d';
const SCENES = [['harbor', 'cove'], ['shrine', 'training'], ['gate', 'watch']];
const SERIES = ['one-piece', 'demon-slayer', 'attack-on-titan'];
export function sceneArtwork(world: number, scene: number) {
  return scene === 0 ? WORLDS[world].artwork : `/artwork/scenes/${SERIES[world]}-${SCENES[world][scene - 1]}.webp`;
}

/** A painted scene with deliberately bounded camera movement. Full free walking lives in the 3D mode. */
export class AnimeScene {
  readonly root = new T.Group();
  private material: T.ShaderMaterial;
  private ambience: ReturnType<typeof atmosphere>;
  private textures = new Map<number, T.Texture>();
  private pending = new Map<number, Promise<T.Texture>>();
  private disposed = false;
  private token = 0;
  private current = -1;
  private selected = 0;
  private pan = new T.Vector2();
  private targetPan = new T.Vector2();
  private zoom = 1;
  private time = 0;
  private signal = new AbortController();
  private timers = new Set<number>();
  private requests = new Set<AbortController>();
  private status = document.querySelector<HTMLElement>('#anime-status')!;
  private message = document.querySelector<HTMLElement>('#anime-status-message')!;
  private retry = document.querySelector<HTMLButtonElement>('#anime-retry')!;
  constructor(private world: number) {
    this.material = new T.ShaderMaterial({
      uniforms: { previous: { value: null }, blend: { value: 1 }, oldCrop: { value:new T.Vector2(1,1) }, oldOffset: {value:new T.Vector2()}, map: { value: null }, crop: { value: new T.Vector2(1,1) }, offset: { value: new T.Vector2() }, pan: { value: new T.Vector2() }, time: { value: 0 }, theme: { value: world } },
      depthTest: false, depthWrite: false, toneMapped: false,
      vertexShader: `varying vec2 vUv; void main(){vUv=uv;gl_Position=vec4(position.xy, .999, 1.);}`,
      fragmentShader: `
        uniform sampler2D map; uniform sampler2D previous; uniform float blend; uniform vec2 oldCrop; uniform vec2 oldOffset; uniform vec2 crop; uniform vec2 offset; uniform vec2 pan; uniform float time; uniform float theme; varying vec2 vUv;
        void main(){
          vec2 uv = vUv * crop + offset;
          // Small depth differences give the painted foreground a gentle parallax without reshaping faces.
          float foreground = smoothstep(.52,.85,uv.x) * (1.-smoothstep(.75,1.,uv.y));
          uv += pan * (.002 + foreground*.002);
          // Water shimmer only in the open left foreground, kept below half a source pixel.
          float water = (1.-smoothstep(.48,.62,uv.x))*(1.-smoothstep(.25,.47,uv.y));
          uv.x += water * sin(uv.y*130.+time*.55)*.00016*(1.-step(1.5,theme));
          vec3 color = texture2D(map,clamp(uv,vec2(.001),vec2(.999))).rgb;
          color=mix(texture2D(previous,clamp(vUv*oldCrop+oldOffset,vec2(.001),vec2(.999))).rgb,color,blend);
          gl_FragColor=vec4(color,1.);
          #include <colorspace_fragment>
        }`,
    });
    const quad = new T.Mesh(new T.PlaneGeometry(2,2), this.material); quad.frustumCulled = false; quad.renderOrder = -1000; this.root.add(quad);
    this.ambience=atmosphere(world);this.root.add(this.ambience.points);
    this.retry.addEventListener('click', () => { void this.load(this.selected); }, { signal: this.signal.signal });
  }
  get scene() { return this.current; }
  get settled() { return this.current>=0 && Number(this.material.uniforms.blend.value)>=1; }
  async load(index: number): Promise<boolean> {
    const token = ++this.token; this.selected = index;
    this.status.hidden = false; this.retry.hidden = true; this.message.textContent = 'กำลังโหลดฉากอนิเมะ…';
    document.querySelector<HTMLElement>('#app')!.dataset.artworkState = 'loading';
    try {
      let texture = this.textures.get(index);
      if (!texture) {
        let request = this.pending.get(index);
        if (!request) {
          const controller=new AbortController(); this.requests.add(controller);
          const timer=window.setTimeout(()=>controller.abort(),8000); this.timers.add(timer);
          request=(async()=>{
            const response=await fetch(sceneArtwork(this.world,index),{signal:controller.signal});
            if(!response.ok)throw new Error('Artwork request failed');
            const blob=await response.blob(),url=URL.createObjectURL(blob),image=new Image();
            try { image.src=url; await image.decode(); } finally { URL.revokeObjectURL(url); }
            if(this.disposed||controller.signal.aborted)throw new Error('Artwork request cancelled');
            const result=new T.Texture(image);result.needsUpdate=true;result.colorSpace=T.SRGBColorSpace;result.generateMipmaps=false;result.minFilter=T.LinearFilter;
            const existing=this.textures.get(index);if(existing){result.dispose();return existing;}
            this.textures.set(index,result);return result;
          })().finally(()=>{clearTimeout(timer);this.timers.delete(timer);this.requests.delete(controller);this.pending.delete(index);});
          this.pending.set(index, request);
        }
        texture = await request;
      }
      if (this.disposed || token !== this.token) return false;
      const old=this.material.uniforms.map.value as T.Texture|null;
      this.material.uniforms.previous.value=old??texture;
      (this.material.uniforms.oldCrop.value as T.Vector2).copy(this.material.uniforms.crop.value);
      (this.material.uniforms.oldOffset.value as T.Vector2).copy(this.material.uniforms.offset.value);
      this.material.uniforms.blend.value=old&&this.current!==index?0:1;
      this.material.uniforms.map.value = texture; this.current = index; this.reset(); this.fit(); this.status.hidden = true;
      const app = document.querySelector<HTMLElement>('#app')!; app.dataset.artworkState = 'ready'; app.dataset.artScene = String(index);
      return true;
    } catch {
      if (this.disposed || token !== this.token) return false;
      this.message.textContent = this.current >= 0 ? 'โหลดซีนใหม่ไม่สำเร็จ ภาพก่อนหน้ายังแสดงอยู่' : 'โหลดภาพไม่สำเร็จ ลองอีกครั้งหรือสลับไปเดิน 3D';
      this.retry.hidden = false; document.querySelector<HTMLElement>('#app')!.dataset.artworkState = 'error'; return false;
    }
  }
  toggleZoom() { if(this.zoom>1.05)this.reset();else this.zoomBy(1.45); }
  reset() { this.pan.set(0,0); this.targetPan.set(0,0); this.zoom=1; this.fit(); }
  move(x: number, y: number) { this.targetPan.x = T.MathUtils.clamp(this.targetPan.x+x,-1,1); this.targetPan.y=T.MathUtils.clamp(this.targetPan.y+y,-1,1); }
  private focus() { return this.current===0?(innerWidth<=650?.73:.5):(innerWidth<=650?.77:.5); }
  panByPixels(x:number,y:number) {
    const crop=this.material.uniforms.crop.value as T.Vector2;
    this.targetPan.set(panAfterDrag(crop.x,this.focus(),this.targetPan.x,-x,innerWidth),panAfterDrag(crop.y,.5,this.targetPan.y,y,innerHeight));
  }
  zoomBy(scale: number) { this.zoom=T.MathUtils.clamp(this.zoom*scale,1,1.8); this.fit(); }
  fit() {
    if (this.current < 0) return;
    const image = this.textures.get(this.current)!.image as HTMLImageElement;
    const aspect = image.width/image.height, viewport = innerWidth/innerHeight;
    const crop = this.material.uniforms.crop.value as T.Vector2;
    crop.set(Math.min(1,viewport/aspect)/this.zoom/1.07,Math.min(1,aspect/viewport)/this.zoom/1.07);
    (this.material.uniforms.offset.value as T.Vector2).set(boundedOffset(1-crop.x,this.focus(),this.pan.x),boundedOffset(1-crop.y,.5,this.pan.y));
  }
  project(u:number,v:number):[number,number] {
    const crop=this.material.uniforms.crop.value as T.Vector2,offset=this.material.uniforms.offset.value as T.Vector2;
    return [(u-offset.x)/crop.x*innerWidth,(1-(1-v-offset.y)/crop.y)*innerHeight];
  }
  update(delta: number, reducedMotion: boolean) {
    this.pan.lerp(this.targetPan, reducedMotion ? 1 : 1-Math.exp(-delta*10)); this.fit();
    if (!reducedMotion) this.time+=delta;
    this.material.uniforms.blend.value=reducedMotion?1:Math.min(1,Number(this.material.uniforms.blend.value)+delta*3.5);
    this.ambience.points.visible=!reducedMotion;this.ambience.material.uniforms.time.value=this.time;
    this.material.uniforms.time.value=this.time; (this.material.uniforms.pan.value as T.Vector2).copy(this.pan);
    const readout=document.querySelector('#zoom-readout')!;const label=`${Math.round(this.zoom*100)}%`;if(readout.textContent!==label)readout.textContent=label;
    const canvas = document.querySelector<HTMLElement>('#world-canvas')!; canvas.dataset.artBlend=Number(this.material.uniforms.blend.value).toFixed(2); canvas.dataset.artView = `${this.pan.x.toFixed(3)},${this.pan.y.toFixed(3)},${this.zoom.toFixed(3)}`;
  }
  dispose() {
    this.disposed=true; this.token++; this.signal.abort(); this.textures.forEach(texture=>texture.dispose()); this.textures.clear();
    this.requests.forEach(request=>request.abort());this.requests.clear();
    this.timers.forEach(timer=>clearTimeout(timer)); this.timers.clear();
    this.ambience.points.geometry.dispose();this.ambience.material.dispose();
    this.root.traverse(o=>{if(o instanceof T.Mesh)o.geometry.dispose();}); this.material.dispose(); this.root.removeFromParent(); this.root.clear(); this.status.hidden=true;
    const app=document.querySelector<HTMLElement>('#app')!; delete app.dataset.artScene; delete app.dataset.artworkState; delete document.querySelector<HTMLElement>('#world-canvas')!.dataset.artView;delete document.querySelector<HTMLElement>('#world-canvas')!.dataset.artBlend;
  }
}

export class AnimePortrait {
  private stage = document.querySelector<HTMLElement>('#character-art-stage')!;
  private image = document.querySelector<HTMLImageElement>('#character-art')!;
  private status = document.querySelector<HTMLElement>('#portrait-status')!;
  private pan = new T.Vector2();
  private zoom=1;
  private pointers = new Map<number,{x:number;y:number}>();
  private pinchDistance=0;
  private abort = new AbortController();
  private token=0;
  private current='';
  private objectURL: string|null=null;
  private request: AbortController|null=null;
  private requestTimer=0;
  private loading=false;
  constructor() {
    const signal=this.abort.signal;
    this.stage.addEventListener('pointerdown',e=>{if(e.button!==0||(e.target as HTMLElement).closest('button'))return;e.preventDefault();this.stage.setPointerCapture(e.pointerId);this.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});this.pinchDistance=this.distance();},{signal});
    this.stage.addEventListener('pointermove',e=>{
      const p=this.pointers.get(e.pointerId);if(!p)return;
      const dx=e.clientX-p.x,dy=e.clientY-p.y;this.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
      if(this.pointers.size===2){const distance=this.distance();if(this.pinchDistance>0)this.zoomBy(distance/this.pinchDistance);this.pinchDistance=distance;}
      else this.move(dx,dy);
    },{signal});
    const release=(e:PointerEvent)=>{this.pointers.delete(e.pointerId);this.pinchDistance=this.distance();};
    this.stage.addEventListener('pointerup',release,{signal});this.stage.addEventListener('pointercancel',release,{signal});
    this.stage.addEventListener('wheel',e=>{e.preventDefault();this.zoomBy(e.deltaY>0?.92:1.08);},{signal,passive:false});
    document.querySelector('#portrait-retry')!.addEventListener('click',()=>{void this.load(this.current);},{signal});
  }
  private distance(){const points=[...this.pointers.values()];return points.length===2?Math.hypot(points[0].x-points[1].x,points[0].y-points[1].y):0;}
  async load(id:string) {
    if(this.current===id && (this.loading || (this.stage.dataset.loadedCharacter===id && !this.image.hidden))) { this.reset(); return; }
    this.loading=true;
    const token=++this.token;this.current=id;this.request?.abort();this.request=new AbortController();clearTimeout(this.requestTimer);
    this.image.hidden=true;this.status.hidden=false;this.status.querySelector('span')!.textContent='กำลังโหลดภาพตัวละคร…';document.querySelector<HTMLButtonElement>('#portrait-retry')!.hidden=true;
    this.requestTimer=window.setTimeout(()=>this.request?.abort(),8000);
    try{
      const response=await fetch(`/artwork/characters/${id}.webp`,{signal:this.request.signal});if(!response.ok)throw new Error('Portrait request failed');
      const blob=await response.blob();if(token!==this.token)return;
      const url=URL.createObjectURL(blob);if(this.objectURL)URL.revokeObjectURL(this.objectURL);this.objectURL=url;this.image.src=url;await this.image.decode();
      if(token!==this.token)return;this.image.alt=`ภาพอนิเมะ ${id}`;this.image.hidden=false;this.status.hidden=true;this.reset();
      this.stage.dataset.loadedCharacter=id;
    }catch{if(token!==this.token)return;this.status.querySelector('span')!.textContent='โหลดภาพตัวละครไม่สำเร็จ';document.querySelector<HTMLButtonElement>('#portrait-retry')!.hidden=false;}
    finally{if(token===this.token){clearTimeout(this.requestTimer);this.loading=false;}}
  }
  move(x:number,y:number){const r=this.stage.getBoundingClientRect(),[mx,my]=portraitLimit(r.width,r.height,this.image.naturalWidth/Math.max(1,this.image.naturalHeight),this.zoom);this.pan.x=T.MathUtils.clamp(this.pan.x+x,-mx,mx);this.pan.y=T.MathUtils.clamp(this.pan.y+y,-my,my);this.render();}
  zoomBy(scale:number){this.zoom=T.MathUtils.clamp(this.zoom*scale,.8,2.8);this.move(0,0);}
  reset(){this.pan.set(0,0);this.zoom=1;this.render();}
  update(elapsed:number,motion:boolean){this.render(motion?Math.sin(elapsed*.5)*3:0);}
  private render(float=0){this.image.style.transform=`translate(${this.pan.x}px,${this.pan.y+float}px) scale(${this.zoom})`;this.stage.dataset.view=`${this.pan.x},${this.pan.y},${this.zoom.toFixed(3)}`;}
  show(visible:boolean){this.stage.hidden=!visible;if(!visible){this.pointers.clear();}}
  dispose(){this.token++;this.request?.abort();clearTimeout(this.requestTimer);this.abort.abort();if(this.objectURL)URL.revokeObjectURL(this.objectURL);this.image.removeAttribute('src');this.image.hidden=true;this.stage.hidden=true;delete this.stage.dataset.loadedCharacter;}
}
