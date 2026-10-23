import * as THREE from 'three';
import './style.css';
import { WORLDS } from './worlds';
import { ImmersiveWorld } from './immersive/runtime';
import { disposeGroup, WorldEffects } from './effects';
import { ExplorationUI } from './exploration';

const canvas = document.querySelector<HTMLCanvasElement>('#world-canvas')!;
const appRoot = document.querySelector<HTMLElement>('#app')!;
const intro = document.querySelector<HTMLElement>('#intro')!;
const picker = document.querySelector<HTMLElement>('#world-picker')!;
const worldPanel = document.querySelector<HTMLElement>('#world-panel')!;
const transitionScreen = document.querySelector<HTMLElement>('#transition-screen')!;
const toast = document.querySelector<HTMLElement>('#toast')!;
const fallback = document.querySelector<HTMLElement>('#webgl-fallback')!;
const cards = [...document.querySelectorAll<HTMLButtonElement>('.world-card')];
const main = document.querySelector<HTMLElement>('main')!;
const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
let reducedMotion = motionQuery.matches;
const pixelRatio = () => Math.min(window.devicePixelRatio, window.innerWidth <= 650 ? 1.5 : 2);
document.querySelector('#reload-scene')!.addEventListener('click', () => window.location.reload());

let renderer: THREE.WebGLRenderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
} catch {
  fallback.hidden = false;
  canvas.hidden = true;
  throw new Error('WebGL could not be initialized.');
}

renderer.setPixelRatio(pixelRatio());
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.25;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;
renderer.shadowMap.needsUpdate = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#080912');
scene.fog = new THREE.FogExp2('#080912', 0.027);
const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 120);
camera.position.set(0, 2.2, 11.8);
camera.lookAt(0, 0.1, 0);

const clock = new THREE.Clock();
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const hub = new THREE.Group();
const worldLayer = new THREE.Group();
scene.add(hub, worldLayer);
let activeWorld = -1;
let hoveredPortal = -1;
let targetRotation = 0;
let pointerDown = false;
let dragStartX = 0;
let dragStartY = 0;
let dragging = false;
let lastPointerX = 0;
let toastTimer = 0;
let audioContext: AudioContext | null = null;
let audioEnabled = false;
let transitioning = false;
let immersive: ImmersiveWorld | null = null;
let navigationToken = 0;
let pendingWorld = -1;
let cinematic = false;
let actionRemaining = 0;
let contextLost = false;
const effects = new WorldEffects();
const exploration = new ExplorationUI(triggerWorldAction, toggleCinematic);
scene.add(effects.root);

function textTexture(text: string) {
  const textureCanvas = document.createElement('canvas');
  textureCanvas.width = 512;
  textureCanvas.height = 128;
  const context = textureCanvas.getContext('2d')!;
  context.clearRect(0, 0, 512, 128);
  context.font = '600 30px Arial, sans-serif';
  context.textAlign = 'center';
  context.fillStyle = '#d9d9f1';
  context.shadowColor = '#a78bfa';
  context.shadowBlur = 16;
  context.fillText(text, 256, 70);
  const texture = new THREE.CanvasTexture(textureCanvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

const portalMeshes: THREE.Mesh[] = [];
const portalMaterials: THREE.ShaderMaterial[] = [];
const portalRings: THREE.Mesh[] = [];
const portalGroups: THREE.Group[] = [];
const compactDecor: THREE.Object3D[] = [];

function makePortal(index: number) {
  const info = WORLDS[index];
  const group = new THREE.Group();
  group.position.set((index - 1) * 3.55, 0.35, -0.3 - Math.abs(index - 1) * 0.13);
  portalGroups.push(group);
  group.userData.baseY = group.position.y;

  const aura = new THREE.Mesh(
    new THREE.TorusGeometry(1.35, 0.115, 14, 96),
    new THREE.MeshBasicMaterial({ color: info.accent, transparent: true, opacity: 0.16, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }),
  );
  aura.position.z = -0.07;
  group.add(aura);

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(1.31, 0.035, 14, 96),
    new THREE.MeshStandardMaterial({ color: info.accent, emissive: info.accent, emissiveIntensity: 2.4, metalness: 0.62, roughness: 0.23 }),
  );
  ring.name = `Portal ring ${index}`;
  group.add(ring);
  portalRings.push(ring);

  const material = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(info.accent) }, uColor2: { value: new THREE.Color(info.accent2) }, uHover: { value: 0 } },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform float uTime; uniform vec3 uColor; uniform vec3 uColor2; uniform float uHover; varying vec2 vUv;
      void main(){
        vec2 p = vUv - 0.5; float r = length(p); float a = atan(p.y,p.x);
        float wave = sin(a * 5.0 + r * 28.0 - uTime * 0.65) * 0.5 + 0.5;
        float bands = sin(r * 42.0 - uTime * 1.4 + a * 2.0) * 0.5 + 0.5;
        vec3 color = mix(uColor, uColor2, smoothstep(0.1,0.9,wave));
        float vignette = 1.0 - smoothstep(0.08,0.72,r);
        float alpha = (0.20 + wave * 0.22 + bands * 0.12 + uHover * 0.12) * vignette;
        gl_FragColor = vec4(color, alpha);
      }
    `,
  });
  portalMaterials.push(material);
  const surface = new THREE.Mesh(new THREE.CircleGeometry(1.27, 72), material);
  surface.name = `Portal ${index}`;
  surface.userData.portalIndex = index;
  group.add(surface);
  portalMeshes.push(surface);

  const orbit = new THREE.Mesh(new THREE.TorusGeometry(1.47, 0.009, 4, 80), new THREE.MeshBasicMaterial({ color: info.accent, transparent: true, opacity: 0.5 }));
  orbit.rotation.z = Math.PI / 7;
  group.add(orbit);

  const label = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.65), new THREE.MeshBasicMaterial({ map: textTexture(info.title), transparent: true, depthWrite: false, side: THREE.DoubleSide }));
  label.position.set(0, -1.95, 0.06);
  group.add(label);

  for (let i = 0; i < 5; i += 1) {
    const point = new THREE.Mesh(new THREE.SphereGeometry(0.023 + (i % 2) * 0.012, 8, 8), new THREE.MeshBasicMaterial({ color: info.accent, transparent: true, opacity: 0.7 }));
    const angle = (i / 5) * Math.PI * 2;
    point.position.set(Math.cos(angle) * 1.54, Math.sin(angle) * 1.54, 0.04);
    group.add(point);
  }
  hub.add(group);
}

function createHub() {
  const ambient = new THREE.HemisphereLight('#c7c8ff', '#241a34', 2.1);
  hub.add(ambient);
  const key = new THREE.DirectionalLight('#fff4dc', 3.6);
  key.position.set(-4, 7, 8);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  hub.add(key);
  const rim = new THREE.PointLight('#ab85ff', 55, 22, 2);
  rim.position.set(0, 1.5, -2);
  hub.add(rim);

  // A dark reflective floor gives the portals somewhere to glow.
  const floor = new THREE.Mesh(new THREE.CircleGeometry(15, 80), new THREE.MeshStandardMaterial({ color: '#11121e', metalness: 0.62, roughness: 0.36, emissive: '#070813', emissiveIntensity: 0.7 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -1.72;
  floor.receiveShadow = true;
  hub.add(floor);

  for (let i = 0; i < 5; i += 1) {
    const platform = new THREE.Mesh(new THREE.TorusGeometry(2.1 + i * 0.82, 0.012, 5, 128), new THREE.MeshBasicMaterial({ color: i % 2 ? '#566080' : '#9d84e8', transparent: true, opacity: 0.19 - i * 0.018 }));
    platform.rotation.x = Math.PI / 2;
    platform.position.set(0, -1.68 + i * 0.003, 0.5);
    hub.add(platform);
    compactDecor.push(platform);
  }

  const center = new THREE.Mesh(new THREE.OctahedronGeometry(0.68, 1), new THREE.MeshStandardMaterial({ color: '#d6c7ff', emissive: '#8468ff', emissiveIntensity: 1.4, roughness: 0.2, metalness: 0.75, flatShading: true }));
  center.name = 'Wayfinder crystal';
  center.position.set(0, 3.55, -0.9);
  center.userData.baseY = center.position.y;
  center.userData.landmark = 'ผลึกนำทาง — ประตูทั้งสามกำลังรออยู่';
  hub.add(center);
  compactDecor.push(center);
  const crystalRing = new THREE.Mesh(new THREE.TorusGeometry(0.95, 0.012, 6, 80), new THREE.MeshBasicMaterial({ color: '#c3adff', transparent: true, opacity: 0.66 }));
  crystalRing.position.copy(center.position);
  crystalRing.rotation.x = 1.1;
  hub.add(crystalRing);
  compactDecor.push(crystalRing);

  for (let i = 0; i < WORLDS.length; i += 1) makePortal(i);
  layoutPortals();

  // Tiny constellations drift around the gateway.
  const starCount = 580;
  const positions = new Float32Array(starCount * 3);
  const colors = new Float32Array(starCount * 3);
  const colorA = new THREE.Color('#91a5ff');
  const colorB = new THREE.Color('#f1d6ff');
  for (let i = 0; i < starCount; i += 1) {
    const radius = 4 + Math.random() * 31;
    const angle = Math.random() * Math.PI * 2;
    positions[i * 3] = Math.cos(angle) * radius;
    positions[i * 3 + 1] = (Math.random() - 0.45) * 20;
    positions[i * 3 + 2] = -12 + (Math.random() - 0.5) * 28;
    const color = Math.random() > 0.65 ? colorB : colorA;
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  const starGeometry = new THREE.BufferGeometry();
  starGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  starGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const stars = new THREE.Points(starGeometry, new THREE.PointsMaterial({ size: 0.035, vertexColors: true, transparent: true, opacity: 0.82, sizeAttenuation: true }));
  stars.name = 'Starfield';
  hub.add(stars);
}

function layoutPortals() {
  const compact = window.innerWidth <= 650;
  const landscape = window.innerHeight <= 580 && !compact;
  compactDecor.forEach((object) => { object.visible = !compact && !landscape; });
  portalGroups.forEach((group, index) => {
    const x = landscape ? index * 2.35 + 0.75 : compact ? (index - 1) * 1.12 : window.innerWidth >= 1200 ? index * 2.58 : (index - 1) * 3.55;
    group.position.set(x, landscape ? 1.5 : compact ? 1.15 : 0.35, -0.3 - Math.abs(index - 1) * 0.13);
    group.scale.setScalar(landscape ? 0.52 : compact ? 0.38 : window.innerWidth >= 1200 ? 0.84 : 1);
  });
}

createHub();

function showToast(message: string, duration = 4000) {
  toast.textContent = message;
  toast.classList.add('visible');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(hideToast, duration);
}

function hideToast() {
  window.clearTimeout(toastTimer);
  toast.classList.remove('visible');
  toast.textContent = '';
}

function playChime(index: number) {
  if (!audioEnabled || !audioContext || audioContext.state !== 'running') return;
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.value = [392, 523.25, 659.25][index] ?? 440;
  gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.045, audioContext.currentTime + 0.035);
  gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.9);
  oscillator.connect(gain);
  gain.connect(audioContext.destination);
  oscillator.start();
  oscillator.stop(audioContext.currentTime + 0.95);
}

function beginTransition(label: string) {
  transitioning = true;
  hideToast();
  effects.clear();
  actionRemaining = 0;
  cinematic = false;
  exploration.setCinematic(false);
  exploration.leave();
  appRoot.classList.remove('is-cinematic');
  appRoot.setAttribute('aria-busy', 'true');
  main.inert = true;
  pointerDown = dragging = false;
  canvas.style.cursor = 'wait';
  hoveredPortal = -1;
  document.querySelector('#transition-label')!.textContent = label;
  transitionScreen.setAttribute('aria-hidden', 'false');
  transitionScreen.classList.add('active');
}

function finishTransition() {
  transitioning = false;
  pendingWorld = -1;
  appRoot.setAttribute('aria-busy', 'false');
  main.inert = false;
  transitionScreen.classList.remove('active');
  transitionScreen.setAttribute('aria-hidden', 'true');
  canvas.style.cursor = 'grab';
}

function resetHub() {
  activeWorld = -1;
  clearWorld();
  hub.visible = true;
  renderer.shadowMap.needsUpdate = true;
  scene.background = new THREE.Color('#080912');
  scene.fog = new THREE.FogExp2('#080912', 0.027);
  worldPanel.classList.remove('visible');
  worldPanel.hidden = worldPanel.inert = true;
  intro.classList.remove('hidden');
  intro.inert = false;
  picker.classList.remove('hidden');
  picker.inert = false;
  document.querySelector('#footerbar')!.classList.remove('in-world');
  document.querySelector('.footer-controls')!.innerHTML = '<kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> SELECT <span class="control-sep">·</span> <kbd>ESC</kbd> BACK';
  document.querySelector('#crosshair')!.classList.remove('visible');
  appRoot.classList.remove('is-exploring');
  delete appRoot.dataset.world;
  canvas.setAttribute('aria-label', 'ฉากโลกอนิเมะสามมิติ');
  camera.position.set(0, 2.2, 11.8);
  camera.lookAt(0, 0.1, 0);
}

async function enterWorld(index: number) {
  if (transitioning || index < 0 || index >= WORLDS.length || activeWorld >= 0) return;
  const request = ++navigationToken;
  pendingWorld = index;
  beginTransition(`ENTERING ${WORLDS[index].title}`);
  try {
    await new Promise(resolve => window.setTimeout(resolve, reducedMotion ? 0 : 420));
    if (request !== navigationToken) return;
    clearWorld();
    immersive = new ImmersiveWorld(index, scene, camera, canvas, () => reducedMotion, () => { renderer.shadowMap.needsUpdate = true; });
    worldLayer.add(immersive.root);
    renderer.shadowMap.needsUpdate = true;
    activeWorld = index;
    hub.visible = false;
    const info = WORLDS[index];
    document.documentElement.style.setProperty('--world-accent', info.color);
    document.querySelector('#world-kicker')!.textContent = info.kicker;
    document.querySelector('#world-title')!.textContent = info.title;
    document.querySelector('#world-description')!.textContent = info.description;
    document.querySelector('#world-coordinates')!.textContent = info.coordinates;
    document.querySelector('#world-tip-text')!.textContent = 'WASD เดิน · ลากเพื่อมองรอบตัว · G ชมตัวละคร';
    intro.classList.add('hidden');
    intro.inert = true;
    picker.classList.add('hidden');
    picker.inert = true;
    worldPanel.hidden = worldPanel.inert = false;
    worldPanel.classList.add('visible');
    document.querySelector('#footerbar')!.classList.add('in-world');
    document.querySelector('.footer-controls')!.innerHTML = '<kbd>WASD</kbd> WALK · DRAG LOOK · <kbd>G</kbd> CAST · <kbd>R</kbd> RESET';
    document.querySelector('#crosshair')!.classList.add('visible');
    appRoot.classList.add('is-exploring');
    appRoot.dataset.world = String(index);
    exploration.enter(index);
    finishTransition();
    playChime(index);
    canvas.setAttribute('aria-label', `${info.title} · WASD เดิน · ลากหรือปุ่มลูกศรมองรอบตัว · G ชมตัวละคร · R กลับจุดเริ่ม · Escape กลับ`);
    canvas.focus({ preventScroll: true });
  } catch {
    if (request !== navigationToken) return;
    resetHub();
    finishTransition();
    showToast('สร้างฉาก 3 มิติไม่สำเร็จ กรุณาลองเลือกโลกอีกครั้ง', 6000);
    cards[index].focus({ preventScroll: true });
  }
}

async function returnToHub() {
  const previous = activeWorld >= 0 ? activeWorld : pendingWorld;
  if (previous < 0 && !transitioning) return;
  const request = ++navigationToken;
  pendingWorld = -1;
  beginTransition('RETURNING TO PORTALS');
  await new Promise((resolve) => window.setTimeout(resolve, reducedMotion ? 0 : 260));
  if (request !== navigationToken) return;
  resetHub();
  finishTransition();
  cards[Math.max(previous, 0)].focus({ preventScroll: true });
}

function clearWorld() {
  immersive?.dispose();
  immersive = null;
  effects.clear();
  disposeGroup(worldLayer);
}

function triggerWorldAction() {
  if (activeWorld < 0 || transitioning || actionRemaining > 0 || exploration.dialogOpen || immersive?.galleryOpen) return;
  actionRemaining = effects.trigger(activeWorld, reducedMotion);
  const direction = camera.getWorldDirection(new THREE.Vector3());
  effects.root.position.copy(camera.position).addScaledVector(direction, 4);
  effects.root.position.y -= .5;
  effects.root.rotation.y = Math.atan2(direction.x, direction.z);
  exploration.setActionBusy(true);
  playChime(activeWorld);
  if (reducedMotion) showToast(['ลมทะเลพัดผ่านดาดฟ้า', 'สายน้ำโอบล้อมกลีบวิสทีเรีย', 'พลุสีเขียวส่งสัญญาณถึงหน่วยสำรวจ'][activeWorld]);
}

function toggleCinematic() {
  if (activeWorld < 0 || transitioning || immersive?.galleryOpen) return;
  cinematic = !cinematic;
  appRoot.classList.toggle('is-cinematic', cinematic);
  exploration.setCinematic(cinematic);
  worldPanel.inert = cinematic;
}

cards.forEach((card) => card.addEventListener('click', () => enterWorld(Number(card.dataset.world))));
document.querySelector<HTMLButtonElement>('#back-button')!.addEventListener('click', returnToHub);

document.querySelector('.brand')!.addEventListener('click', (event) => { event.preventDefault(); void returnToHub(); });
document.querySelector<HTMLButtonElement>('#sound-toggle')!.addEventListener('click', async () => {
  try {
    audioEnabled = !audioEnabled;
    if (audioEnabled && !audioContext) audioContext = new AudioContext();
    if (audioEnabled && audioContext?.state === 'suspended') await audioContext.resume();
  } catch {
    audioEnabled = false;
    showToast('อุปกรณ์ยังไม่พร้อมเล่นเสียง ลองเปิดเสียงอีกครั้ง');
  }
  document.querySelector<HTMLElement>('#sound-label')!.textContent = audioEnabled ? 'SOUND ON' : 'SOUND OFF';
  document.querySelector<HTMLButtonElement>('#sound-toggle')!.classList.toggle('is-on', audioEnabled);
  document.querySelector('#sound-toggle')!.setAttribute('aria-pressed', String(audioEnabled));
  if (audioEnabled) playChime(Math.max(activeWorld, 0));
});

window.addEventListener('keydown', (event) => {
  if (event.repeat || event.ctrlKey || event.altKey || event.metaKey || exploration.dialogOpen) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    if (immersive?.galleryOpen) immersive.closeGallery();
    else if (cinematic) toggleCinematic();
    else if (activeWorld >= 0 || transitioning) void returnToHub();
    return;
  }
  if (transitioning) return;
  if (event.key.toLowerCase() === 'c' && activeWorld >= 0) { event.preventDefault(); toggleCinematic(); }
  if (event.code === 'Space' && !(event.target instanceof HTMLElement && event.target.closest('button, a, input, select, textarea'))) {
    if (activeWorld >= 0) { event.preventDefault(); triggerWorldAction(); }
  }
  if (activeWorld < 0 && ['1', '2', '3'].includes(event.key)) void enterWorld(Number(event.key) - 1);
});

canvas.addEventListener('pointerdown', (event) => {
  if (transitioning || contextLost || event.button !== 0 || !event.isPrimary) return;
  pointerDown = true;
  dragging = false;
  dragStartX = lastPointerX = event.clientX;
  dragStartY = event.clientY;
  canvas.setPointerCapture(event.pointerId);
});

canvas.addEventListener('pointermove', (event) => {
  if (transitioning || !event.isPrimary) return;
  const bounds = canvas.getBoundingClientRect();
  pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
  pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
  if (pointerDown) {
    const movement = event.clientX - lastPointerX;
    if (Math.abs(event.clientX - dragStartX) + Math.abs(event.clientY - dragStartY) > 5) dragging = true;
    if (activeWorld < 0 && dragging) targetRotation = THREE.MathUtils.clamp(targetRotation + movement * 0.004, -0.28, 0.28);
  }
  lastPointerX = event.clientX;
  raycaster.setFromCamera(pointer, camera);
  if (activeWorld < 0) {
    const intersects = raycaster.intersectObjects(portalMeshes, false);
    hoveredPortal = intersects.length ? Number(intersects[0].object.userData.portalIndex) : -1;
    canvas.style.cursor = hoveredPortal >= 0 ? 'pointer' : pointerDown ? 'grabbing' : 'grab';
  } else {
    canvas.style.cursor = pointerDown ? 'grabbing' : 'grab';
  }
});

canvas.addEventListener('pointerup', (event) => {
  if (!pointerDown) return;
  pointerDown = false;
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  if (dragging) return;
  const bounds = canvas.getBoundingClientRect();
  pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
  pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  if (activeWorld < 0) {
    const hit = raycaster.intersectObjects(portalMeshes, false)[0];
    if (hit) void enterWorld(Number(hit.object.userData.portalIndex));
  }
});

canvas.addEventListener('pointercancel', () => { pointerDown = false; dragging = false; });

window.addEventListener('resize', () => {
  layoutPortals();
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(pixelRatio());
  renderer.setSize(window.innerWidth, window.innerHeight);
});

motionQuery.addEventListener('change', (event) => {
  reducedMotion = event.matches;
  effects.clear();
  actionRemaining = 0;
  exploration.setActionBusy(false);
});
canvas.addEventListener('webglcontextlost', (event) => {
  event.preventDefault();
  contextLost = true;
  document.querySelector('#webgl-fallback h2')!.textContent = 'การแสดงผล 3 มิติหยุดชั่วคราว';
  document.querySelector('#webgl-fallback p')!.textContent = 'ลองโหลดหน้าใหม่เพื่อกลับสู่พอร์ทัล';
  fallback.hidden = false;
  document.querySelector<HTMLButtonElement>('#reload-scene')!.focus({ preventScroll: true });
});
function animate() {
  requestAnimationFrame(animate);
  const frameDelta = clock.getDelta();
  const delta = Math.min(frameDelta, 0.045);
  if (document.hidden || contextLost) return;
  const elapsed = clock.elapsedTime;
  hub.rotation.y += (targetRotation - hub.rotation.y) * Math.min(delta * 4, 1);
  hub.children.forEach((child) => {
    if (child.userData.baseY !== undefined && !reducedMotion) child.position.y = Number(child.userData.baseY) + Math.sin(elapsed * 0.8 + child.id) * 0.11;
    if (child.name === 'Wayfinder crystal' && !reducedMotion) child.rotation.y = elapsed * 0.28;
  });
  portalRings.forEach((ring, index) => {
    ring.rotation.z = reducedMotion ? 0 : Math.sin(elapsed * 0.4 + index) * 0.045;
    ring.scale.setScalar(hoveredPortal === index ? 1.035 : 1);
    portalMaterials[index].uniforms.uTime.value = reducedMotion ? 0 : elapsed;
    portalMaterials[index].uniforms.uHover.value += ((hoveredPortal === index ? 1 : 0) - portalMaterials[index].uniforms.uHover.value) * delta * 4;
  });
  immersive?.update(delta, elapsed, transitioning);
  effects.root.visible = !immersive?.galleryOpen;
  effects.update(Math.min(frameDelta, .3));
  if (actionRemaining > 0) {
    actionRemaining = Math.max(0, actionRemaining - frameDelta);
    if (actionRemaining === 0) exploration.setActionBusy(false);
  }
  renderer.render(scene, camera);
  canvas.dataset.triangles = String(renderer.info.render.triangles);
  canvas.dataset.draws = String(renderer.info.render.calls);
  canvas.dataset.geometries = String(renderer.info.memory.geometries);
}
animate();
