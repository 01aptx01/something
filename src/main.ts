import * as THREE from 'three';
import './style.css';
import { buildWorld, WORLDS } from './worlds';

const canvas = document.querySelector<HTMLCanvasElement>('#world-canvas')!;
const intro = document.querySelector<HTMLElement>('#intro')!;
const picker = document.querySelector<HTMLElement>('#world-picker')!;
const worldPanel = document.querySelector<HTMLElement>('#world-panel')!;
const transitionScreen = document.querySelector<HTMLElement>('#transition-screen')!;
const toast = document.querySelector<HTMLElement>('#toast')!;
const fallback = document.querySelector<HTMLElement>('#webgl-fallback')!;
const cards = [...document.querySelectorAll<HTMLButtonElement>('.world-card')];

let renderer: THREE.WebGLRenderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
} catch {
  fallback.hidden = false;
  canvas.hidden = true;
  throw new Error('WebGL could not be initialized.');
}

renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.25;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

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
  compactDecor.forEach((object) => { object.visible = !compact; });
  portalGroups.forEach((group, index) => {
    const x = compact ? (index - 1) * 1.12 : window.innerWidth >= 1200 ? index * 2.58 : (index - 1) * 3.55;
    group.position.set(x, compact ? 1.15 : 0.35, -0.3 - Math.abs(index - 1) * 0.13);
    group.scale.setScalar(compact ? 0.38 : window.innerWidth >= 1200 ? 0.84 : 1);
  });
}

createHub();

function showToast(message: string) {
  toast.textContent = message;
  toast.classList.add('visible');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('visible'), 2700);
}

function playChime(index: number) {
  if (!audioEnabled || !audioContext) return;
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

async function enterWorld(index: number) {
  if (transitioning || index < 0 || index >= WORLDS.length || activeWorld === index) return;
  transitioning = true;
  activeWorld = index;
  playChime(index);
  transitionScreen.classList.add('active');
  await new Promise((resolve) => window.setTimeout(resolve, 420));
  clearWorld();
  const world = buildWorld(index);
  worldLayer.add(world);
  hub.visible = false;
  const info = WORLDS[index];
  scene.background = new THREE.Color(world.userData.sky as string);
  scene.fog = new THREE.FogExp2(world.userData.sky as string, 0.019);
  document.documentElement.style.setProperty('--world-accent', info.color);
  document.querySelector<HTMLElement>('#world-kicker')!.textContent = info.kicker;
  document.querySelector<HTMLElement>('#world-title')!.textContent = info.title;
  document.querySelector<HTMLElement>('#world-description')!.textContent = info.description;
  document.querySelector<HTMLElement>('#world-coordinates')!.textContent = info.coordinates;
  document.querySelector<HTMLElement>('#world-tip-text')!.textContent = info.tip;
  intro.classList.add('hidden');
  picker.classList.add('hidden');
  worldPanel.hidden = false;
  worldPanel.classList.add('visible');
  document.querySelector<HTMLElement>('#footerbar')!.classList.add('in-world');
  document.querySelector<HTMLElement>('#crosshair')!.classList.add('visible');
  camera.position.set(0, 2.25, 11.8);
  camera.lookAt(0, 0.3, -1.2);
  transitionScreen.classList.remove('active');
  transitioning = false;
}

async function returnToHub() {
  if (transitioning || activeWorld < 0) return;
  transitioning = true;
  transitionScreen.classList.add('active');
  await new Promise((resolve) => window.setTimeout(resolve, 360));
  activeWorld = -1;
  clearWorld();
  hub.visible = true;
  scene.background = new THREE.Color('#080912');
  scene.fog = new THREE.FogExp2('#080912', 0.027);
  worldPanel.classList.remove('visible');
  worldPanel.hidden = true;
  intro.classList.remove('hidden');
  picker.classList.remove('hidden');
  document.querySelector<HTMLElement>('#footerbar')!.classList.remove('in-world');
  document.querySelector<HTMLElement>('#crosshair')!.classList.remove('visible');
  camera.position.set(0, 2.2, 11.8);
  camera.lookAt(0, 0.1, 0);
  transitionScreen.classList.remove('active');
  transitioning = false;
}

function clearWorld() {
  worldLayer.traverse((object) => {
    const mesh = object as THREE.Mesh;
    mesh.geometry?.dispose();
    if (Array.isArray(mesh.material)) mesh.material.forEach((item) => item.dispose());
    else mesh.material?.dispose();
  });
  worldLayer.clear();
}

cards.forEach((card) => card.addEventListener('click', () => enterWorld(Number(card.dataset.world))));
document.querySelector<HTMLButtonElement>('#back-button')!.addEventListener('click', returnToHub);

document.querySelector<HTMLButtonElement>('#sound-toggle')!.addEventListener('click', async () => {
  audioEnabled = !audioEnabled;
  if (audioEnabled && !audioContext) audioContext = new AudioContext();
  if (audioEnabled && audioContext?.state === 'suspended') await audioContext.resume();
  document.querySelector<HTMLElement>('#sound-label')!.textContent = audioEnabled ? 'SOUND ON' : 'SOUND OFF';
  document.querySelector<HTMLButtonElement>('#sound-toggle')!.classList.toggle('is-on', audioEnabled);
  if (audioEnabled) playChime(Math.max(activeWorld, 0));
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && activeWorld >= 0) void returnToHub();
  if (activeWorld < 0 && ['1', '2', '3'].includes(event.key)) void enterWorld(Number(event.key) - 1);
});

canvas.addEventListener('pointerdown', (event) => {
  pointerDown = true;
  dragging = false;
  dragStartX = lastPointerX = event.clientX;
  dragStartY = event.clientY;
  canvas.setPointerCapture(event.pointerId);
});

canvas.addEventListener('pointermove', (event) => {
  const bounds = canvas.getBoundingClientRect();
  pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
  pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
  if (pointerDown) {
    const movement = event.clientX - lastPointerX;
    if (Math.abs(event.clientX - dragStartX) + Math.abs(event.clientY - dragStartY) > 5) dragging = true;
    if (activeWorld < 0 && dragging) targetRotation += movement * 0.004;
  }
  lastPointerX = event.clientX;
  raycaster.setFromCamera(pointer, camera);
  if (activeWorld < 0) {
    const intersects = raycaster.intersectObjects(portalMeshes, false);
    hoveredPortal = intersects.length ? Number(intersects[0].object.userData.portalIndex) : -1;
    canvas.style.cursor = hoveredPortal >= 0 ? 'pointer' : pointerDown ? 'grabbing' : 'grab';
  } else {
    const intersects = raycaster.intersectObjects(worldLayer.children, true);
    const landmark = intersects.find((hit) => hit.object.userData.landmark)?.object;
    canvas.style.cursor = landmark ? 'pointer' : 'grab';
  }
});

canvas.addEventListener('pointerup', (event) => {
  if (!pointerDown) return;
  pointerDown = false;
  canvas.releasePointerCapture(event.pointerId);
  if (dragging) return;
  const bounds = canvas.getBoundingClientRect();
  pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
  pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  if (activeWorld < 0) {
    const hit = raycaster.intersectObjects(portalMeshes, false)[0];
    if (hit) void enterWorld(Number(hit.object.userData.portalIndex));
  } else {
    const hit = raycaster.intersectObjects(worldLayer.children, true).find((item) => item.object.userData.landmark);
    if (hit) showToast(String(hit.object.userData.landmark));
  }
});

canvas.addEventListener('pointercancel', () => { pointerDown = false; dragging = false; });

window.addEventListener('resize', () => {
  layoutPortals();
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, window.innerWidth < 700 ? 1.4 : 1.75));
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
function animate() {
  requestAnimationFrame(animate);
  const delta = Math.min(clock.getDelta(), 0.045);
  const elapsed = clock.elapsedTime;
  hub.rotation.y += (targetRotation - hub.rotation.y) * Math.min(delta * 4, 1);
  hub.children.forEach((child) => {
    if (child.userData.baseY !== undefined && !reducedMotion) child.position.y = Number(child.userData.baseY) + Math.sin(elapsed * 0.8 + child.id) * 0.11;
  });
  portalRings.forEach((ring, index) => {
    ring.rotation.z = Math.sin(elapsed * 0.4 + index) * 0.045;
    ring.scale.setScalar(hoveredPortal === index ? 1.035 : 1);
    portalMaterials[index].uniforms.uTime.value = elapsed;
    portalMaterials[index].uniforms.uHover.value += ((hoveredPortal === index ? 1 : 0) - portalMaterials[index].uniforms.uHover.value) * delta * 4;
  });
  worldLayer.children.forEach((root) => {
    root.children.forEach((child) => {
      if (child.name === 'Falling wisteria petal' && !reducedMotion) {
        const seed = Number(child.userData.floatSeed ?? 0);
        child.position.y = Number(child.userData.baseY) + Math.sin(elapsed * 0.6 + seed) * 0.16;
        child.position.x = Number(child.userData.baseX) + Math.cos(elapsed * 0.45 + seed) * 0.13;
      }
      if (child.name === 'Wayfinder crystal' && !reducedMotion) child.rotation.y = elapsed * 0.28;
    });
  });
  renderer.render(scene, camera);
}
animate();
