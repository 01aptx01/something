import * as THREE from 'three';

export function disposeGroup(group: THREE.Group) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  group.traverse((object) => {
    if (object instanceof THREE.InstancedMesh) object.dispose();
    const mesh = object as THREE.Mesh;
    if (mesh.geometry) geometries.add(mesh.geometry);
    if (Array.isArray(mesh.material)) mesh.material.forEach((material) => materials.add(material));
    else if (mesh.material) materials.add(mesh.material);
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
  group.clear();
}

/** One short-lived effect at a time; every geometry is released on replay/navigation. */
export class WorldEffects {
  readonly root = new THREE.Group();
  private age = 0;
  private duration = 0;
  private world = 0;
  private velocities: number[] = [];
  private particles: THREE.Points | null = null;
  private readonly glow = (() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const context = canvas.getContext('2d')!;
    const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, '#fff');
    gradient.addColorStop(0.25, 'rgba(255,255,255,.8)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(canvas);
  })();

  trigger(world: number, reducedMotion: boolean) {
    this.clear();
    this.world = world;
    this.duration = reducedMotion ? 0.8 : world === 2 ? 3.4 : 2.6;
    if (reducedMotion) return this.duration;
    this.root.position.set(world === 2 ? 1.4 : 0.4, 0.6, 2);
    const color = ['#54dfcc', '#269cff', '#18ea64'][world];
    const material = () => new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, toneMapped: false, depthWrite: false });
    if (world === 0) {
      for (let i = 0; i < 4; i++) {
        const arc = new THREE.Mesh(new THREE.TorusGeometry(0.8 + i * 0.36, 0.018, 6, 96, Math.PI * 1.5), material());
        arc.rotation.z = i * 0.9;
        arc.scale.set(1.55, 0.6, 1);
        arc.userData.spin = 0.35 + i * 0.1;
        this.root.add(arc);
      }
    } else if (world === 1) {
      for (let ribbon = 0; ribbon < 3; ribbon++) {
        const points = Array.from({ length: 65 }, (_, i) => {
          const t = i / 64;
          return new THREE.Vector3(Math.sin(t * Math.PI * 2) * 2.6, (t - 0.5) * 2 + Math.cos(t * Math.PI * 3) * 0.7, Math.cos(t * Math.PI * 2) * 0.7 + ribbon * 0.08);
        });
        const trail = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 100, ribbon === 0 ? 0.045 : 0.015, 5, false), material());
        trail.rotation.z = ribbon * 0.13;
        trail.userData.spin = 0.12;
        this.root.add(trail);
      }
    } else {
      const flare = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 12), material());
      flare.name = 'signal-flare';
      this.root.add(flare);
      for (let i = 0; i < 5; i++) {
        const smoke = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.8), new THREE.MeshBasicMaterial({ color, map: this.glow, transparent: true, opacity: 0.22, toneMapped: false, depthWrite: false }));
        smoke.name = 'signal-smoke';
        smoke.userData.offset = i * 0.22;
        this.root.add(smoke);
      }
    }
    const count = window.innerWidth <= 650 ? 48 : 96;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 0.4 + Math.random() * 1.7;
      this.velocities.push(Math.cos(angle) * speed, world === 2 ? 1.2 + Math.random() * 1.2 : Math.sin(angle) * speed, (Math.random() - 0.5) * 0.6);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.particles = new THREE.Points(geometry, new THREE.PointsMaterial({ color, map: this.glow, size: world === 2 ? 0.11 : 0.075, transparent: true, opacity: 0.85, toneMapped: false, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.particles.frustumCulled = false;
    this.root.add(this.particles);
    return this.duration;
  }

  update(delta: number) {
    if (!this.duration) return;
    this.age += delta;
    if (this.age >= this.duration) { this.clear(); return; }
    const fade = Math.min(1, this.age * 5) * Math.max(0, 1 - this.age / this.duration);
    for (const child of this.root.children) {
      const mesh = child as THREE.Mesh<THREE.BufferGeometry, THREE.Material & { opacity: number }>;
      mesh.material.opacity = fade * (child.name === 'signal-smoke' ? 0.3 : child === this.particles ? 0.85 : 0.7);
      if (child.userData.spin) {
        child.rotation.z += Number(child.userData.spin) * delta;
        const size = 0.75 + this.age * 0.24;
        if (this.world === 0) child.scale.set(size * 1.55, size * 0.6, 1);
        else child.scale.setScalar(size);
      }
      if (child.name === 'signal-flare') child.position.y = -1.8 + Math.min(this.age, 2.2) * 2;
      if (child.name === 'signal-smoke') {
        const delay = Number(child.userData.offset);
        child.position.set(Math.sin(this.age + delay) * 0.18, -1.8 + Math.max(0, this.age - delay) * 1.7, 0);
        child.scale.setScalar(1 + this.age * 0.8);
      }
    }
    if (this.particles) {
      const position = this.particles.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < position.count; i++) {
        const vx = this.velocities[i * 3];
        const vy = this.velocities[i * 3 + 1];
        position.setXYZ(i, vx * this.age * (this.world === 2 ? 0.3 : 1), (this.world === 2 ? -1.8 : 0) + vy * this.age - (this.world === 0 ? 0.3 * this.age ** 2 : 0), this.velocities[i * 3 + 2] * this.age);
      }
      position.needsUpdate = true;
    }
  }

  clear() {
    disposeGroup(this.root);
    this.age = this.duration = 0;
    this.velocities = [];
    this.particles = null;
  }
}
