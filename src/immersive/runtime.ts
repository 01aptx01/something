import * as T from 'three';
import { journal } from '../journal';
import { STORIES } from './catalog';
import { AnimeScene, AnimePortrait, type Presentation } from './anime';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { disposeGroup } from '../effects';
import { buildEnvironment, DESTINATIONS, type Environment } from './environments';
import { walkable } from './navigation';
import { CAST, loadCharacter, disposeCharacter, disposeTextures, updateCharacter, disposeRigResources, UPLOADED_LUFFY_CREDIT } from './characters';
import { characterAt } from './character-regions';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { material, mesh } from './kit';

const $ = <E extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<E>(selector)!;

export class ImmersiveWorld {
  private environment: Environment | null = null;
  private galleryBuilt = false;
  private disposed = false;
  private lookPointers = new Map<number,{x:number;y:number}>();
  private pinchDistance = 0;
  private anime: AnimeScene;
  private portrait: AnimePortrait;
  private worldPresentation: Presentation = 'anime';
  private galleryPresentation: Presentation = 'anime';
  get presentation():Presentation {return this.galleryOpen?this.galleryPresentation:this.worldPresentation;}
  private returnFocus:HTMLElement|null=null;
  private tap:{id:number;x:number;y:number;scene:number}|null=null;
  private hoverPointer:{x:number;y:number}|null=null;
  private frameView:'full'|'face'|'back'='full';
  readonly ready: Promise<boolean>;
  private gallery = new T.Group();
  private sculpture = new T.Group();
  private orbit: OrbitControls;
  private keys = new Set<string>();
  private yaw = 0;
  private pitch = 0;
  private ground = 0;
  private destination = 0;
  private savedPosition = new T.Vector3();
  private savedQuaternion = new T.Quaternion();
  private previousFog: T.FogExp2;
  private castIndex = 0;
  private modelToken = 0;
  private modelAbort?: AbortController;
  private modelTimer?: ReturnType<typeof setTimeout>;
  private studioMap?: T.WebGLRenderTarget;
  private studioKey?: T.SpotLight;
  private studioFill?: T.DirectionalLight;
  private lightIndex = 0;
  private rotating = false;
  private drag: { id: number; x: number; y: number } | null = null;
  private abort = new AbortController();
  private map = $<HTMLCanvasElement>('#mini-map');
  private projection = new T.Vector3();
  private markerPositions: T.Vector3[];
  readonly root = new T.Group();
  galleryOpen = false;

  constructor(readonly world: number, private scene: T.Scene, private camera: T.PerspectiveCamera, private canvas: HTMLCanvasElement, private reducedMotion: () => boolean, private invalidateShadows: () => void, private onSceneChange: (scene:number)=>void, private renderer:T.WebGLRenderer) {
    this.anime = new AnimeScene(world); this.portrait = new AnimePortrait();
    this.root.add(this.gallery, this.anime.root);
    this.canvas.dataset.environmentBuilt='false';
    this.gallery.visible = false;
    this.previousFog = new T.FogExp2(['#bddee0','#26263d','#d8b9a0'][world],[.008,.017,.009][world]);
    scene.background = new T.Color(this.previousFog.color); scene.fog = this.previousFog;
    camera.fov = 65; camera.updateProjectionMatrix();
    this.markerPositions = [new T.Vector3(...DESTINATIONS[world][0].marker), new T.Vector3(...DESTINATIONS[world][1].marker)];
    this.orbit = new OrbitControls(camera, canvas); this.orbit.enabled = false; this.orbit.enablePan = false; this.orbit.enableDamping = false;
    this.orbit.minDistance = .65; this.orbit.maxDistance = 18; this.orbit.minPolarAngle = .2; this.orbit.maxPolarAngle = Math.PI * .87;
    this.orbit.target.set(0, 1.18, 0);
    this.bind();
    $('#immersive-hud').hidden = false;
    $('#scene-list').replaceChildren(...DESTINATIONS[world].map((d, index) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'scene-choice'; b.dataset.scene = String(index);
      b.innerHTML = `<img src="/artwork/thumbs/${world}-${index}.webp" alt="" width="320" height="180" loading="lazy" /><span class="scene-info"><span class="scene-number">SCENE 0${index+1}</span><strong></strong></span><small class="scene-progress"></small>`;b.querySelector('strong')!.textContent=d.name;
      b.setAttribute('aria-pressed', String(index === 0)); b.addEventListener('click', () => { this.jump(index); this.canvas.focus({ preventScroll: true }); }); return b;
    }));
    this.jump(0, false);
    this.ready = this.anime.load(0);
    this.setPresentationUI();
    $('#character-list').replaceChildren(...CAST[world].map((c, index) => {
      const b = document.createElement('button'); b.type = 'button'; b.dataset.character = String(index); b.textContent = c.thai;
      const thumb=document.createElement('img');thumb.src=`/artwork/thumbs/${c.id}.webp`;thumb.alt='';thumb.width=40;thumb.height=60;thumb.loading='lazy';b.prepend(thumb);
      b.addEventListener('click', () => this.selectCharacter(index)); return b;
    }));
    $('#scene-cast').replaceChildren(...CAST[world].map((c,i)=>{
      const button=document.createElement('button');button.type='button';button.dataset.sceneCharacter=c.id;button.textContent=c.thai;button.setAttribute('aria-label',`ดูโมเดล 3D ${c.thai}`);button.addEventListener('click',()=>this.openGallery(i,'3d',button),{signal:this.abort.signal});return button;
    }));
    this.updateSceneProgress();
  }

  private bind() {
    const signal = this.abort.signal;
    window.addEventListener('keydown', event => {
      if (document.querySelector('dialog[open]') || document.hidden || $('#app').getAttribute('aria-busy') === 'true') return;
      if ((event.target as HTMLElement).closest('input,select,textarea') || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key==='[' || event.key===']') {event.preventDefault();if(this.galleryOpen)this.selectCharacter((this.castIndex+(event.key===']'?1:CAST[this.world].length-1))%CAST[this.world].length);else this.jump((this.destination+(event.key===']'?1:2))%3);return;}
      if (this.galleryOpen) {
        if (this.presentation === 'anime') {
          if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','=','-','Home'].includes(event.key)) {
            event.preventDefault();
            if (event.key === 'Home') this.portrait.reset();
            else if (['+','=','-'].includes(event.key)) this.portrait.zoomBy(event.key === '-' ? .9 : 1.1);
            else this.portrait.move(event.key==='ArrowLeft'?-16:event.key==='ArrowRight'?16:0,event.key==='ArrowUp'?-16:event.key==='ArrowDown'?16:0);
          }
          return;
        }
        if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-', 'Home'].includes(event.key)) {
          event.preventDefault();
          if (event.key === 'Home') this.resetModel();
          else if (['+', '=', '-'].includes(event.key)) this.zoomModel(event.key === '-' ? 1.15 : .87);
          else {
            const offset = this.camera.position.clone().sub(this.orbit.target);
            const spherical = new T.Spherical().setFromVector3(offset);
            spherical.theta += event.key === 'ArrowLeft' ? -.12 : event.key === 'ArrowRight' ? .12 : 0;
            spherical.phi = T.MathUtils.clamp(spherical.phi + (event.key === 'ArrowUp' ? -.1 : event.key === 'ArrowDown' ? .1 : 0), .2, Math.PI * .87);
            this.camera.position.copy(this.orbit.target).add(new T.Vector3().setFromSpherical(spherical)); this.orbit.update();
          }
        }
        return;
      }
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'ShiftRight', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.code)) {
        if (event.target === this.canvas || event.target === document.body) { event.preventDefault(); this.keys.add(event.code); }
      }
      if (event.key.toLowerCase() === 'g' && !event.repeat) this.openGallery();
      if (event.key.toLowerCase() === 'r' && !event.repeat) this.jump(this.destination);
    }, { signal });
    window.addEventListener('keyup', e => this.keys.delete(e.code), { signal });
    const stop = () => { this.keys.clear(); this.drag = null;this.lookPointers.clear();this.pinchDistance=0;this.tap=null;this.hideCharacterHover(); document.querySelectorAll('.move-key').forEach(b => b.classList.remove('held')); };
    window.addEventListener('blur', stop, { signal }); document.addEventListener('visibilitychange', stop, { signal });
    $('#explore-dialog').addEventListener('toggle', stop, { signal });
    this.canvas.addEventListener('pointerdown', e => {
      if (this.galleryOpen || e.button !== 0 || (!e.isPrimary && e.pointerType !== 'touch')) return;
      this.canvas.setPointerCapture(e.pointerId);this.hideCharacterHover();
      this.tap=this.lookPointers.size===0?{id:e.pointerId,x:e.clientX,y:e.clientY,scene:this.destination}:null;
      if(e.pointerType==='touch'&&this.presentation==='anime'){this.lookPointers.set(e.pointerId,{x:e.clientX,y:e.clientY});this.pinchDistance=this.touchDistance();if(this.lookPointers.size===2){this.tap=null;this.drag=null;return;}}
      this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY }; this.canvas.focus({ preventScroll: true });
    }, { signal });
    this.canvas.addEventListener('pointermove', e => {
      if(this.galleryOpen)return;
      if(this.tap&&Math.hypot(e.clientX-this.tap.x,e.clientY-this.tap.y)>7)this.tap=null;
      if(!this.drag&&this.presentation==='anime'){this.hoverPointer={x:e.clientX,y:e.clientY};this.hoverCharacter(e.clientX,e.clientY);}
      if(this.lookPointers.has(e.pointerId)){this.lookPointers.set(e.pointerId,{x:e.clientX,y:e.clientY});if(this.lookPointers.size===2){const distance=this.touchDistance();if(this.pinchDistance>0)this.anime.zoomBy(distance/this.pinchDistance);this.pinchDistance=distance;return;}}
      if (!this.drag || e.pointerId !== this.drag.id) return;
      if (this.presentation === 'anime') this.anime.panByPixels(e.clientX-this.drag.x,e.clientY-this.drag.y);
      else { this.yaw -= (e.clientX - this.drag.x) * .004; this.pitch = T.MathUtils.clamp(this.pitch - (e.clientY - this.drag.y) * .003, -1.25, 1.25); }
      this.drag.x = e.clientX; this.drag.y = e.clientY; this.look();
    }, { signal });
    this.canvas.addEventListener('pointerup', e => {
      const tap=this.tap;this.tap=null;
      if(tap&&tap.id===e.pointerId&&tap.scene===this.destination&&Math.hypot(e.clientX-tap.x,e.clientY-tap.y)<=7&&this.lookPointers.size<=1){
        const id=this.characterAtScreen(e.clientX,e.clientY);if(id){const index=CAST[this.world].findIndex(c=>c.id===id);if(index>=0)this.openGallery(index,'3d',this.canvas);}
      }
      this.lookPointers.delete(e.pointerId);this.pinchDistance=this.touchDistance();const remaining=[...this.lookPointers.entries()][0];this.drag=remaining?{id:remaining[0],...remaining[1]}:null;}, { signal });
    this.canvas.addEventListener('pointercancel', stop, { signal });
    this.canvas.addEventListener('pointerleave',()=>this.hideCharacterHover(),{signal});
    document.querySelectorAll<HTMLButtonElement>('.move-key').forEach(button => {
      button.addEventListener('pointerdown', e => { e.preventDefault(); button.setPointerCapture(e.pointerId); this.keys.add(button.dataset.key!); button.classList.add('held'); }, { signal });
      const release = () => { this.keys.delete(button.dataset.key!); button.classList.remove('held'); };
      button.addEventListener('pointerup', release, { signal }); button.addEventListener('pointercancel', release, { signal }); button.addEventListener('lostpointercapture', release, { signal });
    });
    this.canvas.addEventListener('wheel',e=>{if(this.presentation==='anime'&&!this.galleryOpen){e.preventDefault();this.anime.zoomBy(e.deltaY>0?.94:1.06);}},{signal,passive:false});
    window.addEventListener('resize',()=>{this.anime.fit();if(this.galleryOpen&&this.presentation==='3d')this.frameModel(this.frameView);},{signal});
    this.canvas.addEventListener('dblclick',()=>{if(!this.galleryOpen&&this.presentation==='anime')this.anime.toggleZoom();},{signal});
    $('#view-reset').addEventListener('click',()=>{if(this.presentation==='anime')this.anime.reset();else this.jump(this.destination);this.canvas.focus({preventScroll:true});},{signal});
    $('#view-zoom-in').addEventListener('click',()=>this.anime.zoomBy(1.15),{signal});$('#view-zoom-out').addEventListener('click',()=>this.anime.zoomBy(1/1.15),{signal});
    $('#scene-prev').addEventListener('click',()=>this.jump((this.destination+2)%3),{signal});$('#scene-next').addEventListener('click',()=>this.jump((this.destination+1)%3),{signal});
    $('#character-prev').addEventListener('click',()=>this.selectCharacter((this.castIndex+CAST[this.world].length-1)%CAST[this.world].length),{signal});
    $('#character-next').addEventListener('click',()=>this.selectCharacter((this.castIndex+1)%CAST[this.world].length),{signal});
    journal.addEventListener('change',()=>this.updateSceneProgress(),{signal});
    document.querySelectorAll<HTMLButtonElement>('button[data-presentation]').forEach(b=>b.addEventListener('click',()=>{this.setPresentation(b.dataset.presentation as Presentation);if(!this.galleryOpen)this.canvas.focus({preventScroll:true});},{signal}));
    $('#gallery-open').addEventListener('click', () => this.openGallery(), { signal });
    $('#gallery-close').addEventListener('click', () => this.closeGallery(), { signal });
    $('#model-reset').addEventListener('click', () => this.resetModel(), { signal });
    $('#model-zoom-in').addEventListener('click', () => this.zoomModel(.85), { signal });
    $('#model-zoom-out').addEventListener('click', () => this.zoomModel(1.18), { signal });
    $('#model-spin').addEventListener('click', () => { this.rotating = !this.rotating; $('#model-spin').setAttribute('aria-pressed', String(this.rotating)); }, { signal });
    $('#model-retry').addEventListener('click',()=>this.selectCharacter(this.castIndex),{signal});
    document.querySelectorAll<HTMLButtonElement>('[data-model-view]').forEach(b=>b.addEventListener('click',()=>this.frameModel(b.dataset.modelView as 'full'|'face'|'back'),{signal}));
    $('#studio-light').addEventListener('click',()=>{this.lightIndex=(this.lightIndex+1)%3;this.setStudioLight();},{signal});
  }
  private look() { this.camera.quaternion.setFromEuler(new T.Euler(this.pitch, this.yaw, 0, 'YXZ')); }
  jump(index: number, load = true) {
    if (this.galleryOpen) this.closeGallery();
    this.destination = index;this.hideCharacterHover();this.tap=null; this.keys.clear(); this.anime.reset();this.onSceneChange(index);
    this.markerPositions=STORIES[this.world][index].landmarks.map(l=>new T.Vector3(...l.position));
    $('#scene-description').textContent=STORIES[this.world][index].description;$('#scene-mood').textContent=STORIES[this.world][index].mood;
    $('#scene-current').textContent=`0${index+1} / 03`;$('#scene-prev').setAttribute('aria-label',`ไปยัง ${DESTINATIONS[this.world][(index+2)%3].name}`);$('#scene-next').setAttribute('aria-label',`ไปยัง ${DESTINATIONS[this.world][(index+1)%3].name}`);
    if (load && this.presentation === 'anime') void this.anime.load(index);
    const d = DESTINATIONS[this.world][index]; this.camera.position.set(...d.position); this.ground = d.position[1] - 1.7;
    this.camera.lookAt(new T.Vector3(...d.look));
    const e = new T.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ'); this.yaw = e.y; this.pitch = e.x;
    $('#location-name').textContent = d.name; $('#location-index').textContent = d.english;
    document.querySelectorAll<HTMLElement>('.scene-choice').forEach((b, i) => b.setAttribute('aria-pressed', String(i === index)));
    $('#app').dataset.scene = String(index); this.reportPosition();if(!document.querySelector('dialog[open]'))this.canvas.focus({preventScroll:true});
  }
  private touchDistance(){const p=[...this.lookPointers.values()];return p.length===2?Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y):0;}
  private ensureEnvironment() {
    if(!this.environment){this.environment=buildEnvironment(this.world);this.environment.root.userData.onAsset=this.invalidateShadows;this.root.add(this.environment.root);this.canvas.dataset.environmentBuilt='true';this.invalidateShadows();}
    return this.environment;
  }
  private updateSceneProgress(){
    document.querySelectorAll<HTMLElement>('.scene-choice').forEach((b,i)=>{const count=journal.count(this.world,i);b.querySelector('.scene-progress')!.textContent=`${count}/2`;b.classList.toggle('is-complete',count===2);});
    $('#journey-progress').textContent=`ค้นพบ ${journal.count(this.world)}/6`;
  }
  private setPresentation(mode: Presentation) {
    if (mode === this.presentation) return;
    this.keys.clear(); this.drag=null; this.rotating=false; $('#model-spin').setAttribute('aria-pressed','false');
    if(this.galleryOpen)this.galleryPresentation=mode;else this.worldPresentation=mode;
    if (this.galleryOpen) {
      if(mode==='3d')this.buildGallery();
      this.gallery.visible=mode==='3d'; this.orbit.enabled=mode==='3d'; this.portrait.show(mode==='anime'); this.selectCharacter(this.castIndex);
      this.scene.environment=mode==='3d'?this.studioMap!.texture:null;
    } else {
      if(mode==='3d')this.ensureEnvironment();
      if(this.environment)this.environment.root.visible=mode==='3d'; this.anime.root.visible=mode==='anime';
      if(mode==='anime') void this.anime.load(this.destination);
      this.camera.fov=65;this.camera.updateProjectionMatrix();
    }
    this.setPresentationUI();this.reportPosition();this.invalidateShadows();
  }
  private setPresentationUI() {
    const anime=this.presentation==='anime'; $('#app').dataset.presentation=this.presentation;$('#app').dataset.worldPresentation=this.worldPresentation;
    document.querySelectorAll<HTMLButtonElement>('button[data-presentation]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.presentation===this.presentation)));
    $('#gallery-eyebrow').textContent=anime?'CHARACTER ARCHIVE / ANIME ART':'SCULPTURE STUDIO / VOLUMETRIC 3D';
    $('#model-spin').textContent=anime?'เคลื่อนไหวเบา ๆ':'หมุนอัตโนมัติ';
    $('#gallery-help').textContent=anime?'ลากเลื่อน · เลื่อน / จีบเพื่อซูม · + − ซูม · Home คืนมุม · Esc กลับ':'ลากเพื่อหมุน · เลื่อน / จีบเพื่อซูม · ปุ่มลูกศรหมุน · + − ซูม · Home คืนมุม · Esc กลับ';
    this.updateModelCredit();
    const worldAnime=this.worldPresentation==='anime';
    $('#world-tip-text').textContent=worldAnime?'ลากสำรวจภาพ · W/S ซูม · เลือกสถานที่เพื่อเดินทาง':'WASD เดิน · ลากมองรอบตัว · G ชมตัวละคร';
    $('.look-hint').textContent=worldAnime?'แตะตัวละครดูโมเดล · ลากเลื่อน · จีบจอเพื่อซูม':'ลากจอเพื่อมองรอบตัว · กดลูกศรค้างเพื่อเดิน';
    $('.footer-controls').innerHTML=worldAnime?'<kbd>W/S</kbd> ZOOM · <kbd>A/D</kbd> PAN · <kbd>G</kbd> CAST':'<kbd>WASD</kbd> WALK · DRAG LOOK · <kbd>G</kbd> CAST';
    this.reportPosition();
  }
  private updateModelCredit(){
    const credit=$('#model-credit');credit.replaceChildren();
    if(this.presentation==='anime'){credit.textContent='ภาพตัวละครแฟนอาร์ตที่สร้างสำหรับโปรเจกต์นี้';return;}
    const id=CAST[this.world][this.castIndex].id;
    if(id==='luffy'){
      credit.append(document.createTextNode(`${UPLOADED_LUFFY_CREDIT} · `));const link=document.createElement('a');link.href='https://sketchfab.com/3d-models/luffy-338ea5a381a34210b13d89cfe049c410';link.target='_blank';link.rel='noopener noreferrer';link.textContent='ที่มา';credit.append(link);
    }else credit.textContent='แฟนโมเดลเดิมของโปรเจกต์ · ฐานสัดส่วน MakeHuman CC0';
  }
  private characterAtScreen(x:number,y:number){
    if(this.galleryOpen||this.presentation!=='anime'||!this.anime.settled||this.anime.scene!==this.destination||document.querySelector('dialog[open]')||$('#app').classList.contains('is-cinematic')||$('#app').getAttribute('aria-busy')==='true')return;
    const [u,v]=this.anime.imagePoint(x,y);return characterAt(this.world,this.destination,u,v);
  }
  private hideCharacterHover(){this.hoverPointer=null; $('#character-hover').hidden=true;delete this.canvas.dataset.characterHover; }
  private hoverCharacter(x:number,y:number){
    const id=this.characterAtScreen(x,y),hint=$('#character-hover');
    if(!id){$('#character-hover').hidden=true;delete this.canvas.dataset.characterHover;this.canvas.style.cursor='grab';return;}
    this.canvas.style.cursor='pointer';this.canvas.dataset.characterHover=id;hint.textContent=`${CAST[this.world].find(c=>c.id===id)!.thai} · ดูโมเดล 3D`;hint.style.left=`${Math.max(110,Math.min(innerWidth-110,x))}px`;hint.style.top=`${Math.max(90,y-36)}px`;hint.hidden=false;
  }
  private projectAnimeMarkers() {
    const points=STORIES[this.world][this.destination].landmarks.map(l=>l.point);
    document.querySelectorAll<HTMLButtonElement>('.landmark-marker').forEach((marker,i)=>{
      const [x,y]=this.anime.project(points[i][0],points[i][1]);
      const panel=$('#world-panel').getBoundingClientRect(),info=$('#scene-caption').getBoundingClientRect();
      const overlap=(r:DOMRect)=>x>r.left-24&&x<r.right+24&&y>r.top-24&&y<r.bottom+24;
      marker.hidden=!!characterAt(this.world,this.destination,points[i][0],points[i][1])||!this.anime.settled||this.anime.scene!==this.destination||overlap(panel)||overlap(info)||x<25||x>innerWidth-25||y<100||y>innerHeight-(innerWidth<=650?200:230);
      marker.style.left=`${x}px`;marker.style.top=`${y}px`;
    });
  }
  private buildGallery() {
    if(this.galleryBuilt)return;this.galleryBuilt=true;
    const generator=new T.PMREMGenerator(this.renderer),room=new RoomEnvironment();
    this.studioMap=generator.fromScene(room,.04);room.dispose();generator.dispose();
    this.gallery.add(new T.HemisphereLight('#d8e9ff','#272234',.5));
    this.studioKey=new T.SpotLight('#fff1dc',65,15,Math.PI/5,.7,2);this.studioKey.position.set(-3,5,4);this.studioKey.target.position.set(0,1.3,0);this.studioKey.castShadow=true;this.studioKey.shadow.mapSize.set(1024,1024);this.studioKey.shadow.normalBias=.015;this.studioKey.shadow.bias=-.00015;this.gallery.add(this.studioKey,this.studioKey.target);
    this.studioFill=new T.DirectionalLight('#aacfff',.7);this.studioFill.position.set(3,2,3);this.gallery.add(this.studioFill);
    const rim=new T.DirectionalLight(['#5be5d0','#c895ff','#ffc18a'][this.world],1.7);rim.position.set(1,3,-3);this.gallery.add(rim);
    const floor = mesh(this.gallery,new T.CircleGeometry(30,96),material('#080d18',.82,.05),0,-.055,0);floor.rotation.x=-Math.PI/2;
    mesh(this.gallery,new T.CylinderGeometry(.68,.74,.08,96),material('#263044',.32,.5),0,-.012,0);
    const ring=mesh(this.gallery,new T.TorusGeometry(.69,.005,8,96),new T.MeshBasicMaterial({color:['#70e5d6','#ce9aff','#ffb88d'][this.world]}),0,.031,0);ring.rotation.x=-Math.PI/2;
    // A small radial contact shadow anchors fine boot and sandal silhouettes.
    const c=document.createElement('canvas');c.width=c.height=128;const ctx=c.getContext('2d')!,g=ctx.createRadialGradient(64,64,3,64,64,64);g.addColorStop(0,'#000b');g.addColorStop(1,'#0000');ctx.fillStyle=g;ctx.fillRect(0,0,128,128);
    const shadow=mesh(this.gallery,new T.PlaneGeometry(1.1,.8),new T.MeshBasicMaterial({map:new T.CanvasTexture(c),transparent:true,depthWrite:false}),0,.031,0);shadow.rotation.x=-Math.PI/2;shadow.castShadow=false;
    this.gallery.add(this.sculpture);this.setStudioLight();
  }
  private setStudioLight(){
    if(!this.studioKey||!this.studioFill)return;
    this.studioKey.color.set(['#fff1dc','#d2e5ff','#ffe0bb'][this.lightIndex]);this.studioKey.intensity=[38,32,44][this.lightIndex];
    this.studioFill.color.set(['#aacfff','#cdaeff','#fff3e2'][this.lightIndex]);this.studioFill.intensity=[.7,.5,.9][this.lightIndex];
    $('#studio-light').textContent=`แสง: ${['สตูดิโอ','แสงจันทร์','อบอุ่น'][this.lightIndex]}`;this.invalidateShadows();
  }
  openGallery(index=this.castIndex,mode:Presentation=this.worldPresentation,focus:HTMLElement=$('#gallery-open')) {
    if (this.galleryOpen || $('#app').classList.contains('is-cinematic')) return;
    this.keys.clear();this.drag=null;this.tap=null;this.lookPointers.clear();this.pinchDistance=0;this.hideCharacterHover();this.returnFocus=focus;this.anime.holdView();this.galleryPresentation=mode;this.galleryOpen=true;
    this.savedPosition.copy(this.camera.position); this.savedQuaternion.copy(this.camera.quaternion);
    if(this.presentation==='3d')this.buildGallery();
    if(this.environment)this.environment.root.visible = false; this.gallery.visible = this.presentation === '3d'; this.anime.root.visible = false; this.portrait.show(this.presentation === 'anime');
    this.scene.background = new T.Color('#0d1220'); this.scene.fog = new T.FogExp2('#0d1220', .05);
    this.scene.environment=this.presentation==='3d'?this.studioMap!.texture:null;
    this.camera.fov = 38; this.camera.updateProjectionMatrix(); this.orbit.enabled = this.presentation === '3d';
    $('#app').classList.add('is-gallery'); $('#character-gallery').hidden = false;
    $('#world-panel').inert = $('#immersive-hud').inert = $('#world-toolbar').inert = true;
    this.invalidateShadows();
    this.setPresentationUI();
    this.selectCharacter(index); $('#gallery-close').focus({ preventScroll: true });
  }
  closeGallery() {
    if (!this.galleryOpen) return;
    this.invalidateShadows();
    this.galleryOpen = false; this.rotating = false; $('#model-spin').setAttribute('aria-pressed', 'false'); this.orbit.enabled = false;
    if(this.presentation==='3d'&&!this.disposed)this.ensureEnvironment();
    if(this.environment)this.environment.root.visible = this.presentation === '3d'; this.gallery.visible = false; this.anime.root.visible = this.presentation === 'anime'; this.portrait.show(false);
    this.scene.background = new T.Color(this.previousFog.color); this.scene.fog = this.previousFog;
    this.scene.environment=null;this.camera.clearViewOffset();this.cancelModel();disposeCharacter(this.sculpture);$('#model-status').hidden=true;
    this.camera.fov = 65; this.camera.updateProjectionMatrix(); this.camera.position.copy(this.savedPosition); this.camera.quaternion.copy(this.savedQuaternion);
    const e = new T.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ'); this.yaw = e.y; this.pitch = e.x;
    $('#app').classList.remove('is-gallery'); $('#character-gallery').hidden = true;
    $('#world-panel').inert = $('#immersive-hud').inert = $('#world-toolbar').inert = false;
    this.setPresentationUI();
    if(!this.disposed)(this.returnFocus?.isConnected?this.returnFocus:$('#gallery-open')).focus({preventScroll:true});
  }
  private selectCharacter(index: number) {
    this.invalidateShadows();
    this.castIndex = index; this.cancelModel();disposeCharacter(this.sculpture);
    const info = CAST[this.world][index];
    if (this.presentation === '3d') void this.loadModel(info.id);
    else void this.portrait.load(info.id);
    this.sculpture.rotation.y = 0;
    $('#character-counter').textContent=`0${index+1} / 0${CAST[this.world].length}`;
    $('#character-name').textContent = info.name; $('#character-thai').textContent = info.thai; $('#character-detail').textContent = info.detail;
    $('#app').dataset.character = info.id;
    document.querySelectorAll<HTMLElement>('#character-list [data-character]').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.character) === index)));
    this.updateModelCredit();this.resetModel();
  }
  private resetModel() {
    if (this.presentation === 'anime') { this.portrait.reset(); return; }
    this.frameModel('full'); }
  private cancelModel(){this.modelToken++;this.modelAbort?.abort();clearTimeout(this.modelTimer);$('#model-status').hidden=true;delete this.canvas.dataset.modelState;delete this.canvas.dataset.modelAsset;delete this.canvas.dataset.modelKind;delete this.canvas.dataset.modelAnimated;delete this.canvas.dataset.modelBlink;delete this.canvas.dataset.modelBlinkCount;}
  private async loadModel(id:string){
    const token=++this.modelToken,request=new AbortController();this.modelAbort=request;
    $('#model-status').hidden=false;$('#model-status span').textContent='กำลังโหลดโมเดล 3D…';$('#model-retry').hidden=true;this.canvas.dataset.modelState='loading';
    this.modelTimer=setTimeout(()=>request.abort(),15000);
    try{
      const model=await loadCharacter(id,request.signal);
      if(token!==this.modelToken||!this.galleryOpen||this.presentation!=='3d'){disposeCharacter(model);return;}
      this.sculpture.add(model);this.sculpture.updateMatrixWorld(true);this.canvas.dataset.modelState='ready';this.canvas.dataset.modelAsset=id;this.canvas.dataset.modelKind=model.userData.assetKind;this.frameModel(this.frameView);$('#model-status').hidden=true;this.invalidateShadows();
    }catch{if(token===this.modelToken){this.canvas.dataset.modelState='error';$('#model-status span').textContent='โหลดโมเดลไม่สำเร็จ กรุณาลองอีกครั้ง';$('#model-retry').hidden=false;}}
    finally{if(token===this.modelToken)clearTimeout(this.modelTimer);}
  }
  private frameModel(view:'full'|'face'|'back'){
    this.frameView=view;
    const narrow=innerWidth<=650,landscape=innerHeight<=580&&!narrow;
    const area={left:narrow?12:innerWidth*(landscape?.32:.37),right:narrow?12:innerWidth*(landscape?.24:.08),top:narrow?236:landscape?77:120,bottom:narrow?222:landscape?58:155};
    const h=Math.max(120,innerHeight-area.top-area.bottom),cx=(area.left+innerWidth-area.right)/2,cy=(area.top+innerHeight-area.bottom)/2;
    this.camera.fov=32;this.camera.setViewOffset(innerWidth,innerHeight,innerWidth/2-cx,innerHeight/2-cy,innerWidth,innerHeight);
    const profile=this.sculpture.children[0]?.userData.frame as {height:number;width:number;depth:number;head:number}|undefined;
    const height=view==='face'?.58:profile?.height??2.4,width=view==='face'?.48:profile?.width??.9;
    const fitH=height/(2*Math.tan(T.MathUtils.degToRad(16)))*innerHeight/h;
    const fitW=width/(2*Math.tan(T.MathUtils.degToRad(16))*(innerWidth/innerHeight))*innerWidth/Math.max(100,innerWidth-area.left-area.right);
    const distance=Math.max(fitH,fitW)*1.12+(view==='face'?.1:(profile?.depth??.4)/2);
    this.orbit.target.set(0,view==='face'?profile?.head??2.16:(profile?.height??2.4)/2,0);this.sculpture.rotation.y=0;
    this.camera.position.copy(this.orbit.target).add(new T.Vector3(view==='back'?0:distance*.17,distance*.035,(view==='back'?-1:1)*distance));this.orbit.update();this.invalidateShadows();
    document.querySelectorAll<HTMLElement>('[data-model-view]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.modelView===view)));
  }
  private zoomModel(scale: number) {
    if (this.presentation === 'anime') { this.portrait.zoomBy(1/scale); return; }
    const offset = this.camera.position.clone().sub(this.orbit.target); offset.setLength(T.MathUtils.clamp(offset.length() * scale, this.orbit.minDistance, this.orbit.maxDistance));
    this.camera.position.copy(this.orbit.target).add(offset); this.orbit.update();
  }
  private reportPosition() {
    const position = this.camera.position;
    $('#position-readout').textContent = this.presentation === 'anime' ? 'ลากเลื่อนมุมมอง · W/S ซูม · A/D เลื่อน' : `${position.x.toFixed(1)} / ${this.ground.toFixed(1)} / ${position.z.toFixed(1)} M`;
    this.canvas.dataset.position = [position.x, position.y, position.z].map(v => v.toFixed(3)).join(',');
    this.canvas.dataset.heading = this.yaw.toFixed(3);
  }
  private drawMap() {
    const ctx = this.map.getContext('2d')!, size = 128, scale = 1.65;
    ctx.clearRect(0, 0, size, size); ctx.strokeStyle = '#ffffff10'; ctx.lineWidth = 1;
    for (let i = 0; i < size; i += 16) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, size); ctx.moveTo(0, i); ctx.lineTo(size, i); ctx.stroke(); }
    ctx.strokeStyle = '#d7e7e84d'; ctx.fillStyle = '#d7e7e816';
    if (this.world === 0) { ctx.fillRect(58, 50, 12, 28); ctx.strokeRect(58, 50, 12, 28); ctx.fillRect(69, 63, 20, 4); ctx.fillRect(86, 26, 32, 72); }
    else if (this.world === 1) { ctx.fillRect(61, 22, 6, 84); ctx.fillRect(64, 61, 33, 6); ctx.fillRect(92, 16, 5, 96); }
    else { ctx.fillRect(14, 21, 100, 6); for (const x of [50, 74]) for (let z = 40; z <= 92; z += 12) ctx.fillRect(x, z, 7, 8); }
    DESTINATIONS[this.world].forEach((d, i) => { ctx.fillStyle = i === this.destination ? '#e8e5ff' : '#8f96ae'; ctx.beginPath(); ctx.arc(64 + d.position[0] * scale, 64 + d.position[2] * scale, 2.5, 0, Math.PI * 2); ctx.fill(); });
    ctx.save(); ctx.translate(64 + this.camera.position.x * scale, 64 + this.camera.position.z * scale); ctx.rotate(-this.yaw);
    ctx.fillStyle = ['#71e9d1', '#ddaaff', '#ffb590'][this.world]; ctx.beginPath(); ctx.moveTo(0, -6); ctx.lineTo(-4, 5); ctx.lineTo(0, 3); ctx.lineTo(4, 5); ctx.closePath(); ctx.fill(); ctx.restore();
  }
  update(delta: number, elapsed: number, paused: boolean) {
    if (paused || document.querySelector('dialog[open]')) { this.keys.clear(); this.drag = null; return; }
    if (this.galleryOpen) {
      if (this.presentation === 'anime') { this.portrait.update(elapsed,this.rotating&&!this.reducedMotion()); return; }
      for(const model of this.sculpture.children)if(updateCharacter(model,elapsed,this.reducedMotion()))this.invalidateShadows();
      this.canvas.dataset.modelAnimated=String(this.sculpture.children.some(m=>m.animations.length>0));this.canvas.dataset.modelBlink=String(this.sculpture.children[0]?.userData.blinkTime??0);this.canvas.dataset.modelBlinkCount=String(this.sculpture.children[0]?.userData.blinkCount??0);
      if (this.rotating && !this.reducedMotion()) { this.sculpture.rotation.y += delta * .4; this.invalidateShadows(); }
      this.orbit.update();
      this.canvas.dataset.modelView = this.camera.position.toArray().map(v => v.toFixed(3)).join(',');
      this.canvas.dataset.modelRotation = this.sculpture.rotation.y.toFixed(3);
      return;
    }
    if (this.presentation === 'anime') {
      const horizontal = Number(this.keys.has('KeyD'))-Number(this.keys.has('KeyA'))+Number(this.keys.has('ArrowRight'))-Number(this.keys.has('ArrowLeft'));
      const vertical = Number(this.keys.has('ArrowUp'))-Number(this.keys.has('ArrowDown'));
      const zoom = Number(this.keys.has('KeyW'))-Number(this.keys.has('KeyS'));
      this.anime.move(horizontal*delta*.8,vertical*delta*.8);
      if (zoom) this.anime.zoomBy(Math.exp(zoom*delta*.5));
      this.anime.update(delta,this.reducedMotion());if(this.hoverPointer&&!this.drag)this.hoverCharacter(this.hoverPointer.x,this.hoverPointer.y); this.drawMap(); this.projectAnimeMarkers(); return;
    }
    const environment=this.ensureEnvironment();
    if (!this.reducedMotion()) {
      if (environment.water) environment.water.uniforms.time.value = elapsed;
      if (environment.particles) environment.particles.position.y = Math.sin(elapsed * .2) * .3;
    }
    const forward = Number(this.keys.has('KeyW')) - Number(this.keys.has('KeyS'));
    const sideways = Number(this.keys.has('KeyD')) - Number(this.keys.has('KeyA'));
    this.yaw += (Number(this.keys.has('ArrowLeft')) - Number(this.keys.has('ArrowRight'))) * delta * 1.25;
    const pitchInput = Number(this.keys.has('ArrowUp')) - Number(this.keys.has('ArrowDown'));
    this.pitch = T.MathUtils.clamp(this.pitch + pitchInput * delta * 1.25, -1.25, 1.25);
    this.look();
    if (forward || sideways) {
      const speed = delta * (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 7 : 3.5) / Math.max(1, Math.hypot(forward, sideways));
      const dx = (-Math.sin(this.yaw) * forward + Math.cos(this.yaw) * sideways) * speed;
      const dz = (-Math.cos(this.yaw) * forward - Math.sin(this.yaw) * sideways) * speed;
      // Resolve axes separately to slide along building walls rather than getting stuck.
      for (const axis of ['x', 'z'] as const) {
        const x = this.camera.position.x + (axis === 'x' ? dx : 0), z = this.camera.position.z + (axis === 'z' ? dz : 0);
        const height = walkable(this.world, x, z, environment.obstacles, this.ground);
        if (height !== null) { this.camera.position.set(x, height + 1.7, z); this.ground = height; }
      }
      this.reportPosition();
    }
    this.canvas.dataset.heading = this.yaw.toFixed(3); this.drawMap();
    document.querySelectorAll<HTMLButtonElement>('.landmark-marker').forEach((marker, i) => {
      const position = this.markerPositions[i]; this.projection.copy(position).project(this.camera);
      const x = (this.projection.x * .5 + .5) * innerWidth, y = (-this.projection.y * .5 + .5) * innerHeight;
      marker.hidden = this.projection.z > 1 || this.projection.z < -1 || x < 35 || x > innerWidth - 35 || y < 160 || y > innerHeight - 150 || this.camera.position.distanceTo(position) > 33;
      marker.style.left = `${x}px`; marker.style.top = `${y}px`;
    });
  }
  dispose() {
    this.disposed=true;this.closeGallery();this.cancelModel();this.environment?.root.userData.abortAssets?.(); this.anime.dispose(); this.portrait.dispose(); this.abort.abort(); this.orbit.dispose(); this.keys.clear();this.studioMap?.dispose();this.scene.environment=null;this.camera.clearViewOffset();
    $('#immersive-hud').hidden = true; $('#character-gallery').hidden = true;
    delete $('#app').dataset.scene; delete $('#app').dataset.character; delete $('#app').dataset.presentation; delete this.canvas.dataset.position; delete this.canvas.dataset.heading; delete this.canvas.dataset.modelView; delete this.canvas.dataset.modelRotation;delete this.canvas.dataset.environmentBuilt;
    disposeRigResources(this.root);
    const textures = new Set<T.Texture>(); const shadows: T.LightShadow[] = [];
    this.root.traverse(o => {
      if (o instanceof T.Mesh) for (const mat of Array.isArray(o.material) ? o.material : [o.material]) for (const v of Object.values(mat)) if (v instanceof T.Texture) textures.add(v);
      if (o instanceof T.DirectionalLight || o instanceof T.PointLight || o instanceof T.SpotLight) if (o.shadow) shadows.push(o.shadow);
    });
    disposeTextures(textures); shadows.forEach(s => s.dispose()); disposeGroup(this.root); this.root.removeFromParent();
    $('#scene-cast').replaceChildren();this.hideCharacterHover();delete $('#app').dataset.worldPresentation;delete this.canvas.dataset.modelKind;delete this.canvas.dataset.modelAnimated;delete this.canvas.dataset.modelBlink;delete this.canvas.dataset.modelBlinkCount;
    this.camera.fov = 42; this.camera.updateProjectionMatrix();
  }
}
