// Generated with img2threejs v2.0.0, Apache-2.0, revision 954cd5845e90efd045694bab725d68a9863c20e0.
// Upstream: https://github.com/img2threejs/img2threejs (see tools/licenses/img2threejs-APACHE-2.0.txt).
// Subject-specific Zoro blockout. Experimental and NOT accepted for production or visual likeness.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type ProceduralModelOptions = {
  wireframe?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  textureSize?: number;
  textureAnisotropy?: number;
  qualityPriority?: 'reference-fidelity' | 'balanced';
};

export type ProceduralModelRuntime = {
  nodes: Record<string, THREE.Object3D>;
  meshes: Record<string, THREE.Mesh>;
  sockets: Record<string, THREE.Object3D>;
  colliders: Record<string, unknown>;
  destructionGroups: Record<string, THREE.Object3D[]>;
};

type SculptMaterialSpec = Record<string, any>;

type ProudRingStack = { rings: [number, number, number, number][] };

// Signed distance to a stack of ellipse rings. Negative inside, positive outside.
//
// The sign is exact; the magnitude is the first-order estimate f / |grad f|, which UNDERSTATES how
// clear an outside point is and OVERSTATES how deep an inside point is. Both errors make the march
// below push slightly further than strictly necessary, which is the safe direction: the failure
// being prevented is a component sinking into the one beneath it and rendering as a bare patch.
function ringStackDistance(stack: ProudRingStack, x: number, y: number, z: number): number {
  const rings = stack.rings;
  const yMin = rings[0][0];
  const yMax = rings[rings.length - 1][0];
  let rx = rings[0][1];
  let rz = rings[0][2];
  let zc = rings[0][3];
  if (y >= yMax) {
    const last = rings[rings.length - 1];
    rx = last[1]; rz = last[2]; zc = last[3];
  } else if (y > yMin) {
    for (let i = 0; i + 1 < rings.length; i += 1) {
      const lo = rings[i];
      const hi = rings[i + 1];
      if (y >= lo[0] && y <= hi[0]) {
        const span = hi[0] - lo[0];
        const t = span > 1e-9 ? (y - lo[0]) / span : 0;
        rx = lo[1] + (hi[1] - lo[1]) * t;
        rz = lo[2] + (hi[2] - lo[2]) * t;
        zc = lo[3] + (hi[3] - lo[3]) * t;
        break;
      }
    }
  }
  const dx = x / rx;
  const dz = (z - zc) / rz;
  const f = dx * dx + dz * dz - 1;
  const gx = (2 * x) / (rx * rx);
  const gz = (2 * (z - zc)) / (rz * rz);
  const grad = Math.hypot(gx, gz);
  const radial = grad < 1e-12 ? -Math.min(rx, rz) : f / grad;
  const axial = Math.max(yMin - y, y - yMax);
  return Math.hypot(Math.max(radial, 0), Math.max(axial, 0)) + Math.min(Math.max(radial, axial), 0);
}

// Push every vertex outward until it stands `clearance` clear of the target's surface.
//
// WHY THE AUTHORED NUMBERS ARE ONLY A LOWER BOUND. A ring is an ELLIPSE, and the surface it has to
// clear generally is not. Any single ellipse that clears the widest point is loose at the narrowest
// and vice versa, so hand-widening moves the error rather than shrinking it -- measured on hair,
// where widening the side masses took closure from 42.2% to 40.9%, worse on all six views, with
// dark coverage DOWN because the widened mass had slid off the skull. Here the authored width is a
// floor and the real radius is MEASURED per vertex.
//
// Each vertex travels along its OWN radial spoke rather than along the field's gradient, so the
// ring keeps its vertex order and its seam positions and only its radius changes. `maxPush` is
// required, not a safeguard: an uncapped march walks inner vertices straight through the target and
// out the far side, closing the very gap the component exists to leave.
function applyStandProud(
  geometry: THREE.BufferGeometry,
  marcher: THREE.Object3D,
  target: THREE.Object3D,
  stack: ProudRingStack,
  clearance: number,
  maxPush: number,
): void {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  marcher.updateWorldMatrix(true, false);
  target.updateWorldMatrix(true, false);
  const toTarget = new THREE.Matrix4().copy(target.matrixWorld).invert().multiply(marcher.matrixWorld);
  const fromTarget = new THREE.Matrix4().copy(toTarget).invert();
  const p = new THREE.Vector3();
  // A vertex can exhaust `maxPush` and still be inside the target. That is the cap doing its job --
  // an uncapped march walks vertices out the far side -- but it means the clearance this function
  // promises was NOT achieved, and saying nothing there hides exactly the defect the caller asked
  // to be protected from. Measured on the shipped fixture: 2 of 8 sampled hair vertices sat 0.059
  // inside a skull against a 0.04 cap and could never have reached clear.
  let unresolved = 0;

  for (let i = 0; i < position.count; i += 1) {
    p.fromBufferAttribute(position, i).applyMatrix4(toTarget);
    // The spoke is the vertex's own radial direction in the target's frame; marching along it keeps
    // each ring a ring, since every vertex holds its own angle and only its radius changes.
    //
    // A vertex on the axis has no radial direction at all -- and that is precisely the crown, the
    // one place a bald patch is most visible. Skipping it leaves the exact failure this function
    // exists to prevent. So a degenerate spoke marches axially instead, out through whichever cap
    // it is nearer, which is the direction the field itself measures there.
    const spokeLength = Math.hypot(p.x, p.z);
    const onAxis = spokeLength < 1e-9;
    const midHeight = (stack.rings[0][0] + stack.rings[stack.rings.length - 1][0]) / 2;
    const sx = onAxis ? 0 : p.x / spokeLength;
    const sz = onAxis ? 0 : p.z / spokeLength;
    const sy = onAxis ? (p.y >= midHeight ? 1 : -1) : 0;

    let travelled = 0;
    for (let step = 0; step < 24; step += 1) {
      const gap = ringStackDistance(stack, p.x, p.y, p.z);
      if (gap >= clearance) break;
      const move = Math.min(Math.max(0.002, clearance - gap), maxPush - travelled);
      if (move <= 0) break;
      p.x += sx * move;
      p.y += sy * move;
      p.z += sz * move;
      travelled += move;
    }

    if (ringStackDistance(stack, p.x, p.y, p.z) < clearance) unresolved += 1;

    p.applyMatrix4(fromTarget);
    position.setXYZ(i, p.x, p.y, p.z);
  }

  position.needsUpdate = true;
  geometry.computeVertexNormals();

  geometry.userData.standProud = { clearance, maxPush, unresolved, total: position.count };
  if (unresolved > 0) {
    console.warn(
      `standProud: ${unresolved}/${position.count} vertices could not reach ${clearance} within ` +
      `maxPush ${maxPush}. They are still inside the target and will render as bare patches. ` +
      `Raise maxPush, or move the component out so it does not start that deep.`,
    );
  }
}

type SdfVector = readonly [number, number, number];
type SdfTransform = { position?: SdfVector; translation?: SdfVector; rotation?: SdfVector; scale?: SdfVector };
type SdfPrimitive = {
  readonly id: string;
  readonly type: 'sphere' | 'capsule' | 'box' | 'cone' | 'ellipsoid';
  readonly center?: SdfVector;
  readonly radius?: number | SdfVector;
  readonly height?: number;
  readonly size?: SdfVector;
  readonly dimensions?: SdfVector;
  readonly radii?: SdfVector;
  readonly transform?: SdfTransform;
};
type SdfOperation = {
  readonly id?: string;
  readonly output?: string;
  readonly type: 'smooth-union' | 'subtract' | 'intersect';
  readonly left: string;
  readonly right: string;
  readonly radius?: number;
};
type SdfDescriptor = {
  readonly primitives: readonly SdfPrimitive[];
  readonly operations?: readonly SdfOperation[];
  readonly resolution: number;
  readonly bounds?: { readonly min: SdfVector; readonly max: SdfVector };
};
type SdfFunction = (point: THREE.Vector3) => number;

function sdfSphere(point: THREE.Vector3, radius: number): number {
  return point.length() - radius;
}

function sdfCapsule(point: THREE.Vector3, radius: number, height: number): number {
  const halfHeight = height * 0.5;
  const y = Math.max(-halfHeight, Math.min(halfHeight, point.y));
  return point.distanceTo(new THREE.Vector3(0, y, 0)) - radius;
}

function sdfBox(point: THREE.Vector3, size: SdfVector): number {
  const q = new THREE.Vector3(Math.abs(point.x), Math.abs(point.y), Math.abs(point.z))
    .sub(new THREE.Vector3(size[0] * 0.5, size[1] * 0.5, size[2] * 0.5));
  return q.clone().max(new THREE.Vector3()).length() + Math.min(Math.max(q.x, q.y, q.z), 0);
}

function sdfCone(point: THREE.Vector3, radius: number, height: number): number {
  const halfHeight = height * 0.5;
  const taper = radius * (1 - (point.y + halfHeight) / height);
  return Math.max(Math.hypot(point.x, point.z) - Math.max(0, taper), Math.abs(point.y) - halfHeight);
}

function sdfEllipsoid(point: THREE.Vector3, radii: SdfVector): number {
  const scaled = new THREE.Vector3(point.x / radii[0], point.y / radii[1], point.z / radii[2]);
  return (scaled.length() - 1) * Math.min(radii[0], radii[1], radii[2]);
}

function sdfRadii(primitive: SdfPrimitive): SdfVector {
  const radius = primitive.radius;
  if (primitive.radii) return primitive.radii;
  if (typeof radius === 'number') return [radius, radius, radius];
  return radius ?? [0.5, 0.5, 0.5];
}

function smin(left: number, right: number, radius: number): number {
  const blend = Math.max(radius - Math.abs(left - right), 0) / radius;
  return Math.min(left, right) - blend * blend * radius * 0.25;
}

function sdfLocalPoint(point: THREE.Vector3, primitive: SdfPrimitive): { point: THREE.Vector3; scale: number } {
  const transform = primitive.transform;
  const translation = transform?.position ?? transform?.translation ?? primitive.center ?? [0, 0, 0];
  const rotation = transform?.rotation ?? [0, 0, 0];
  const scale = transform?.scale ?? [1, 1, 1];
  const local = point.clone().sub(new THREE.Vector3(translation[0], translation[1], translation[2]));
  const inverseRotation = new THREE.Quaternion()
    .setFromEuler(new THREE.Euler(rotation[0], rotation[1], rotation[2]))
    .invert();
  local.applyQuaternion(inverseRotation);
  local.set(local.x / scale[0], local.y / scale[1], local.z / scale[2]);
  return { point: local, scale: Math.min(scale[0], scale[1], scale[2]) };
}

function sdfPrimitive(point: THREE.Vector3, primitive: SdfPrimitive): number {
  const local = sdfLocalPoint(point, primitive);
  let distance: number;
  switch (primitive.type) {
    case 'sphere':
      distance = sdfSphere(local.point, typeof primitive.radius === 'number' ? primitive.radius : 0.5);
      break;
    case 'capsule':
      distance = sdfCapsule(local.point, typeof primitive.radius === 'number' ? primitive.radius : 0.25, primitive.height ?? 1);
      break;
    case 'box':
      distance = sdfBox(local.point, primitive.size ?? primitive.dimensions ?? [1, 1, 1]);
      break;
    case 'cone':
      distance = sdfCone(local.point, typeof primitive.radius === 'number' ? primitive.radius : 0.5, primitive.height ?? 1);
      break;
    case 'ellipsoid':
      distance = sdfEllipsoid(local.point, sdfRadii(primitive));
      break;
  }
  return distance * local.scale;
}

function sdfSample(descriptor: SdfDescriptor): SdfFunction {
  const nodes = new Map<string, SdfFunction>();
  for (const primitive of descriptor.primitives) nodes.set(primitive.id, (point) => sdfPrimitive(point, primitive));
  let result = descriptor.primitives.length > 0 ? nodes.get(descriptor.primitives[0].id) : undefined;
  for (let index = 0; index < (descriptor.operations?.length ?? 0); index += 1) {
    const operation = descriptor.operations?.[index];
    if (!operation) continue;
    const left = nodes.get(operation.left);
    const right = nodes.get(operation.right);
    if (!left || !right) continue;
    let combined: SdfFunction;
    switch (operation.type) {
      case 'smooth-union':
        combined = (point) => smin(left(point), right(point), operation.radius ?? 0.1);
        break;
      case 'subtract':
        combined = (point) => Math.max(left(point), -right(point));
        break;
      case 'intersect':
        combined = (point) => Math.max(left(point), right(point));
        break;
    }
    nodes.set(operation.id ?? operation.output ?? `operation-${index}`, combined);
    result = combined;
  }
  return result ?? (() => Infinity);
}

function polygonizeSdf(descriptor: SdfDescriptor): THREE.BufferGeometry {
  // SURFACE NETS, not a voxel shell.
  //
  // This used to emit one axis-aligned quad per exposed voxel face, which is a Minecraft surface:
  // every face is axis-aligned, every edge is a 90-degree step, and the result is stair-stepped at
  // exactly the scale of the sampling grid. For a subject whose whole identity is smooth blended
  // organic form -- which is the only kind of subject anyone reaches for an implicit surface to
  // build -- that is worse than the assembled primitives it was meant to replace.
  //
  // Naive surface nets places ONE vertex per sign-changing cell, at the average of the linearly
  // interpolated crossings on that cell's edges, and joins the four cells around each crossing
  // edge into a quad. It is compact, manifold, and smooth, and it is a natural fit for a field
  // that can be sampled anywhere rather than only at corners.
  //
  // Normals come from the field GRADIENT, not from face averaging: the gradient is the exact
  // surface normal of the implicit surface, so shading no longer carries the grid's imprint.
  const resolution = Math.max(4, Math.min(64, Math.floor(descriptor.resolution)));
  const defaultBounds: { readonly min: SdfVector; readonly max: SdfVector } = { min: [-2, -2, -2], max: [2, 2, 2] };
  const bounds = descriptor.bounds ?? defaultBounds;
  const min = new THREE.Vector3(bounds.min[0], bounds.min[1], bounds.min[2]);
  const step = new THREE.Vector3(
    (bounds.max[0] - bounds.min[0]) / resolution,
    (bounds.max[1] - bounds.min[1]) / resolution,
    (bounds.max[2] - bounds.min[2]) / resolution,
  );
  const sample = sdfSample(descriptor);
  const scratch = new THREE.Vector3();

  // Corner grid: one more corner than cells on each axis.
  const side = resolution + 1;
  const field = new Float32Array(side * side * side);
  const cornerAt = (x: number, y: number, z: number): number => (z * side + y) * side + x;
  for (let z = 0; z < side; z += 1) {
    for (let y = 0; y < side; y += 1) {
      for (let x = 0; x < side; x += 1) {
        scratch.set(min.x + x * step.x, min.y + y * step.y, min.z + z * step.z);
        field[cornerAt(x, y, z)] = sample(scratch);
      }
    }
  }

  // The 12 cell edges as corner-offset pairs.
  const CUBE_EDGES: readonly (readonly [number, number, number, number, number, number])[] = [
    [0, 0, 0, 1, 0, 0], [1, 0, 0, 1, 1, 0], [0, 1, 0, 1, 1, 0], [0, 0, 0, 0, 1, 0],
    [0, 0, 1, 1, 0, 1], [1, 0, 1, 1, 1, 1], [0, 1, 1, 1, 1, 1], [0, 0, 1, 0, 1, 1],
    [0, 0, 0, 0, 0, 1], [1, 0, 0, 1, 0, 1], [1, 1, 0, 1, 1, 1], [0, 1, 0, 0, 1, 1],
  ];

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const cellVertex = new Int32Array(resolution * resolution * resolution).fill(-1);
  const cellAt = (x: number, y: number, z: number): number => (z * resolution + y) * resolution + x;

  // Central-difference gradient, stepped at a fraction of a cell so it follows the field rather
  // than the grid.
  const epsilon = Math.min(step.x, step.y, step.z) * 0.25;
  const gradient = (point: THREE.Vector3): THREE.Vector3 => {
    const gx = sample(scratch.set(point.x + epsilon, point.y, point.z))
      - sample(scratch.set(point.x - epsilon, point.y, point.z));
    const gy = sample(scratch.set(point.x, point.y + epsilon, point.z))
      - sample(scratch.set(point.x, point.y - epsilon, point.z));
    const gz = sample(scratch.set(point.x, point.y, point.z + epsilon))
      - sample(scratch.set(point.x, point.y, point.z - epsilon));
    const normal = new THREE.Vector3(gx, gy, gz);
    // A point where the field is flat has no defined normal; +Y is arbitrary but finite, and
    // leaving a zero vector would poison every lighting calculation downstream.
    return normal.lengthSq() < 1e-20 ? new THREE.Vector3(0, 1, 0) : normal.normalize();
  };

  for (let z = 0; z < resolution; z += 1) {
    for (let y = 0; y < resolution; y += 1) {
      for (let x = 0; x < resolution; x += 1) {
        let crossings = 0;
        let sumX = 0;
        let sumY = 0;
        let sumZ = 0;
        for (const [ax, ay, az, bx, by, bz] of CUBE_EDGES) {
          const a = field[cornerAt(x + ax, y + ay, z + az)];
          const b = field[cornerAt(x + bx, y + by, z + bz)];
          if ((a <= 0) === (b <= 0)) continue;
          const t = a / (a - b);
          sumX += (ax + (bx - ax) * t);
          sumY += (ay + (by - ay) * t);
          sumZ += (az + (bz - az) * t);
          crossings += 1;
        }
        if (crossings === 0) continue;
        const px = min.x + (x + sumX / crossings) * step.x;
        const py = min.y + (y + sumY / crossings) * step.y;
        const pz = min.z + (z + sumZ / crossings) * step.z;
        cellVertex[cellAt(x, y, z)] = positions.length / 3;
        positions.push(px, py, pz);
        const normal = gradient(new THREE.Vector3(px, py, pz));
        normals.push(normal.x, normal.y, normal.z);
      }
    }
  }

  // One quad per sign-changing grid edge, joining the four cells that share it.
  //
  // Winding, worked out rather than guessed. For the +x edge from corner (x,y,z), the four cells
  // around it are (x, y-1, z-1), (x, y, z-1), (x, y, z), (x, y-1, z); in the (y,z) plane that
  // traversal is +y, +z, -y, whose cross product is +x. So when the corner is INSIDE and its
  // neighbour is outside, the unflipped order already faces out, and the flip belongs on the
  // opposite case. Getting this backwards is invisible in the normals -- those come from the
  // gradient and stay correct -- and shows only as back-face culling removing the front surface,
  // i.e. the model rendering as a hollow shell with its interior visible.
  const quad = (a: number, b: number, c: number, d: number, flip: boolean): void => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) indices.push(a, c, b, a, d, c);
    else indices.push(a, b, c, a, c, d);
  };
  // Each quad joins the FOUR cells sharing one grid edge, so every one of those cells must exist.
  // Bounding only the edge axis and the lower end of the other two let y/z reach `resolution`, which
  // is a corner index, not a cell index: `cellAt` then strides into an unrelated slot (with
  // resolution 8, `cellAt(3, 8, 1)` is 131 -- the slot for cell (3, 0, 2)) or past the end of the
  // array, where a typed-array read yields `undefined`. `undefined < 0` is false, so the guard in
  // `quad` passed it through to `setIndex`, which coerces it to 0. Measured on a sphere reaching its
  // own bounds at resolution 8: 60 out-of-range reads and 108 aliased reads. A surface that touches
  // the sampling box is therefore left OPEN at that face rather than closed with wrong triangles --
  // pad `bounds` past the surface to get a closed mesh.
  for (let z = 0; z < side; z += 1) {
    for (let y = 0; y < side; y += 1) {
      for (let x = 0; x < side; x += 1) {
        const here = field[cornerAt(x, y, z)] <= 0;
        if (x + 1 < side && y > 0 && z > 0 && y < side - 1 && z < side - 1
          && here !== (field[cornerAt(x + 1, y, z)] <= 0)) {
          quad(
            cellVertex[cellAt(x, y - 1, z - 1)], cellVertex[cellAt(x, y, z - 1)],
            cellVertex[cellAt(x, y, z)], cellVertex[cellAt(x, y - 1, z)], !here,
          );
        }
        if (y + 1 < side && x > 0 && z > 0 && x < side - 1 && z < side - 1
          && here !== (field[cornerAt(x, y + 1, z)] <= 0)) {
          quad(
            cellVertex[cellAt(x - 1, y, z - 1)], cellVertex[cellAt(x - 1, y, z)],
            cellVertex[cellAt(x, y, z)], cellVertex[cellAt(x, y, z - 1)], !here,
          );
        }
        if (z + 1 < side && x > 0 && y > 0 && x < side - 1 && y < side - 1
          && here !== (field[cornerAt(x, y, z + 1)] <= 0)) {
          quad(
            cellVertex[cellAt(x - 1, y - 1, z)], cellVertex[cellAt(x, y - 1, z)],
            cellVertex[cellAt(x, y, z)], cellVertex[cellAt(x - 1, y, z)], !here,
          );
        }
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

// bevelEnabled defaults to true on THREE.ExtrudeGeometry and rounds every
// corner — sharp/pointed profiles (blades, fork tines, spikes) need
// bevelEnabled: false plus lineTo()-only path segments near the tip, since a
// curve command cannot produce a true converging point.
function buildExtrudeShape(points: [number, number][], holes?: [number, number][][]): THREE.Shape {
  const shape = new THREE.Shape();
  if (points.length > 0) {
    shape.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i += 1) {
      shape.lineTo(points[i][0], points[i][1]);
    }
  }
  // Cutouts (e.g. an oval wire-cutter hole) as THREE.Path added to shape.holes —
  // dep-free boolean subtraction via the tessellator, no CSG library needed.
  for (const loop of holes ?? []) {
    if (loop.length < 3) continue;
    const path = new THREE.Path();
    path.moveTo(loop[0][0], loop[0][1]);
    for (let i = 1; i < loop.length; i += 1) path.lineTo(loop[i][0], loop[i][1]);
    path.closePath();
    shape.holes.push(path);
  }
  return shape;
}

// Build an N-gon oval loop (for hole authoring from a compact {cx,cy,rx,ry} descriptor).
function ovalLoop(cx: number, cy: number, rx: number, ry: number, seg = 24): [number, number][] {
  const loop: [number, number][] = [];
  for (let i = 0; i < seg; i += 1) {
    const a = (i / seg) * Math.PI * 2;
    loop.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return loop;
}

function buildExtrudeGeometry(profile: { points: [number, number][]; depth: number; holes?: [number, number][][]; ovalHoles?: { cx: number; cy: number; rx: number; ry: number }[] }): THREE.ExtrudeGeometry {
  const holes = [...(profile.holes ?? []), ...((profile.ovalHoles ?? []).map((o) => ovalLoop(o.cx, o.cy, o.rx, o.ry)))];
  const shape = buildExtrudeShape(profile.points, holes);
  return new THREE.ExtrudeGeometry(shape, {
    depth: profile.depth,
    bevelEnabled: false,
    steps: 1,
  });
}

function buildLatheGeometry(profile: { points: [number, number][]; segments?: number }): THREE.LatheGeometry {
  const points = profile.points.map(([x, y]) => new THREE.Vector2(Math.max(0.0001, x), y));
  return new THREE.LatheGeometry(points, profile.segments ?? 24);
}

type TaperedStation = { position: [number, number, number]; rx: number; rz: number; twist?: number };

// Frames come from PARALLEL TRANSPORT, not from a Frenet frame. A Frenet frame is defined by
// the curve's normal, which flips sign wherever the path has an inflection or straightens out,
// and every flip twists the surface 180 degrees within one segment. Carrying the previous frame
// forward and removing only its along-path component keeps the twist continuous. THREE's own
// extrudePath and TubeGeometry do not expose this, which is why this is hand-built.
function buildTaperedSweepGeometry(
  sweep: { stations: TaperedStation[]; radialSegments?: number; capEnds?: boolean },
): THREE.BufferGeometry {
  const stations = sweep.stations;
  if (stations.length < 2) throw new Error('tapered-sweep needs at least two stations');
  const radial = Math.max(3, sweep.radialSegments ?? 10);
  const centres = stations.map((s) => new THREE.Vector3(...s.position));

  const tangents = centres.map((_, i) => {
    const prev = centres[Math.max(0, i - 1)];
    const next = centres[Math.min(centres.length - 1, i + 1)];
    const t = next.clone().sub(prev);
    // Coincident neighbours would normalise to NaN and poison every downstream vertex.
    return t.lengthSq() < 1e-12 ? new THREE.Vector3(0, 1, 0) : t.normalize();
  });

  // Seed a reference axis that is not parallel to the first tangent, or the first cross
  // product is degenerate and the whole sweep collapses to a line.
  let ref = new THREE.Vector3(0, 0, 1);
  if (Math.abs(tangents[0].dot(ref)) > 0.9) ref = new THREE.Vector3(1, 0, 0);

  const normals: THREE.Vector3[] = [];
  const binormals: THREE.Vector3[] = [];
  let carried = ref.clone().sub(tangents[0].clone().multiplyScalar(ref.dot(tangents[0]))).normalize();
  for (let i = 0; i < tangents.length; i += 1) {
    const t = tangents[i];
    // Project the carried frame back onto the plane perpendicular to this tangent.
    const n = carried.clone().sub(t.clone().multiplyScalar(carried.dot(t)));
    if (n.lengthSq() < 1e-12) {
      const fallback = Math.abs(t.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
      n.copy(fallback.sub(t.clone().multiplyScalar(fallback.dot(t))));
    }
    n.normalize();
    normals.push(n);
    binormals.push(new THREE.Vector3().crossVectors(t, n).normalize());
    carried = n;
  }

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const ringStart: number[] = [];
  const isPoint: boolean[] = [];

  for (let i = 0; i < stations.length; i += 1) {
    const st = stations[i];
    const v = i / (stations.length - 1);
    ringStart.push(positions.length / 3);
    // A station whose section has collapsed emits ONE vertex, not a ring of radius zero.
    // A degenerate ring still carries `radial` coincident vertices and `radial` zero-area
    // triangles, so the lock ends in a blunt cap the width of the floating-point noise
    // rather than at a point -- and a hair lock, a horn or a blade tip has to reach a point.
    if (st.rx <= 1e-6 && st.rz <= 1e-6) {
      isPoint.push(true);
      positions.push(centres[i].x, centres[i].y, centres[i].z);
      uvs.push(0.5, v);
      continue;
    }
    isPoint.push(false);
    const twist = ((st.twist ?? 0) * Math.PI) / 180;
    for (let j = 0; j <= radial; j += 1) {
      const theta = (j / radial) * Math.PI * 2 + twist;
      const offset = normals[i].clone().multiplyScalar(Math.cos(theta) * st.rx)
        .add(binormals[i].clone().multiplyScalar(Math.sin(theta) * st.rz));
      const p = centres[i].clone().add(offset);
      positions.push(p.x, p.y, p.z);
      uvs.push(j / radial, v);
    }
  }

  for (let i = 0; i < stations.length - 1; i += 1) {
    const a0 = ringStart[i];
    const b0 = ringStart[i + 1];
    if (isPoint[i] && isPoint[i + 1]) continue;   // two collapsed stations bound nothing
    for (let j = 0; j < radial; j += 1) {
      // Wound so the face normal points radially OUTWARD.
      //
      // Ring vertices advance from `normal` toward `binormal`, and binormal is
      // tangent x normal, so increasing theta runs counter-clockwise seen from the
      // far end of the segment. Taking the ring-to-ring edge first therefore puts
      // the cross product on the inside. Measured as signed volume on the built
      // mesh: every tapered-sweep came out negative -- a torso at -0.0674 and a
      // tail at -0.0044 against a positive ellipsoid head -- so every sweep this
      // generator has ever emitted rendered its back faces, with normals pointing
      // into the solid and every lighting judgement made on the wrong surface.
      if (isPoint[i]) indices.push(a0, b0 + j + 1, b0 + j);
      else if (isPoint[i + 1]) indices.push(a0 + j, a0 + j + 1, b0);
      else indices.push(a0 + j, a0 + j + 1, b0 + j, a0 + j + 1, b0 + j + 1, b0 + j);
    }
  }

  if (sweep.capEnds ?? true) {
    for (const end of [0, stations.length - 1]) {
      if (isPoint[end]) continue;   // a point end is already closed
      const centreIndex = positions.length / 3;
      positions.push(centres[end].x, centres[end].y, centres[end].z);
      uvs.push(0.5, end === 0 ? 0 : 1);
      const base = ringStart[end];
      for (let j = 0; j < radial; j += 1) {
        if (end === 0) indices.push(centreIndex, base + j + 1, base + j);
        else indices.push(centreIndex, base + j, base + j + 1);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function readLayerNumber(value: unknown, keys: string[], fallback: number): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      if (typeof record[key] === 'number') return record[key] as number;
    }
  }
  return fallback;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = /^#[0-9a-f]{3}$/i.test(hex)
    ? '#' + hex.slice(1).split('').map((part) => part + part).join('')
    : hex;
  const value = /^#[0-9a-f]{6}$/i.test(normalized) ? Number.parseInt(normalized.slice(1), 16) : 0x8a7a5f;
  return [clampAlbedoChannel((value >> 16) & 255), clampAlbedoChannel((value >> 8) & 255), clampAlbedoChannel(value & 255)];
}

function materialPalette(spec: SculptMaterialSpec): string[] {
  const palette = spec.colorVariation?.palette;
  if (Array.isArray(palette) && palette.length > 0) return palette.filter((value) => typeof value === 'string');
  const secondary = spec.albedo?.secondary;
  const colors = [spec.baseColor ?? spec.color ?? spec.albedo?.dominant, ...(Array.isArray(secondary) ? secondary : [])];
  return colors.filter((value): value is string => typeof value === 'string' && value.startsWith('#'));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampAlbedoChannel(value: number): number {
  return Math.max(30, Math.min(240, Math.round(value)));
}

function clampPbrF0(value: number): number {
  return Math.max(0.02, Math.min(1, value));
}

function clampPbrIor(value: number): number {
  return Math.max(1, Math.min(2.5, value));
}

function clampPbrMetalness(value: number): number {
  return value >= 0.5 ? 1 : 0;
}

function clampedAlbedoColor(spec: SculptMaterialSpec): THREE.Color {
  const source = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  // setStyle with an explicit SRGBColorSpace, NOT the numeric constructor.
  //
  // `new THREE.Color(r, g, b)` treats its arguments as LINEAR working-space components,
  // while an authored `baseColor` hex is sRGB. Feeding one to the other skipped the
  // transfer function and lifted every dark albedo: #2e2a28, authored as a near-black
  // vinyl, rendered at roughly sRGB 0.46 — a mid grey. The error is largest exactly where
  // it matters most, because the transfer curve is steepest near black.
  return new THREE.Color().setStyle(source, THREE.SRGBColorSpace);
}

function smoothCurve(value: number): number {
  return value * value * (3 - 2 * value);
}

function periodicHash(x: number, y: number, seed: number, periodX: number, periodY: number): number {
  const wrappedX = ((x % periodX) + periodX) % periodX;
  const wrappedY = ((y % periodY) + periodY) % periodY;
  let value = Math.imul(wrappedX + seed * 17, 374761393) ^ Math.imul(wrappedY + seed * 31, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function periodicValueNoise(u: number, v: number, seed: number, periodX: number, periodY: number): number {
  const x = u * periodX;
  const y = v * periodY;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smoothCurve(x - x0);
  const ty = smoothCurve(y - y0);
  const a = periodicHash(x0, y0, seed, periodX, periodY);
  const b = periodicHash(x0 + 1, y0, seed, periodX, periodY);
  const c = periodicHash(x0, y0 + 1, seed, periodX, periodY);
  const d = periodicHash(x0 + 1, y0 + 1, seed, periodX, periodY);
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a, b, tx), THREE.MathUtils.lerp(c, d, tx), ty);
}

type SurfaceBand = {
  frequency: number;
  amplitude: number;
  stretchX: number;
  stretchY: number;
  ridge: boolean;
};

function surfaceBands(spec: SculptMaterialSpec): SurfaceBand[] {
  const source = Array.isArray(spec.surfaceFrequencyBands) ? spec.surfaceFrequencyBands : [];
  const parsed = source.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const band = item as Record<string, unknown>;
    const frequency = typeof band.frequency === 'number' ? band.frequency : 0;
    const amplitude = typeof band.amplitude === 'number' ? band.amplitude : 0;
    if (frequency <= 0 || amplitude <= 0) return [];
    const stretch = Array.isArray(band.stretch) ? band.stretch : [1, 1];
    const description = `${String(band.pattern ?? '')} ${String(band.role ?? '')}`.toLowerCase();
    return [{
      frequency,
      amplitude,
      stretchX: typeof stretch[0] === 'number' ? Math.max(0.1, stretch[0]) : 1,
      stretchY: typeof stretch[1] === 'number' ? Math.max(0.1, stretch[1]) : 1,
      ridge: /(ridge|groove|grain|fiber|striated|crack)/.test(description),
    }];
  });
  return parsed.length > 0 ? parsed : [
    { frequency: 2, amplitude: 0.42, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 12, amplitude: 0.22, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 56, amplitude: 0.08, stretchX: 1, stretchY: 1, ridge: false },
  ];
}

function sampleSurface(u: number, v: number, bands: SurfaceBand[], seed: number): number {
  let value = 0;
  let weight = 0;
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index];
    const periodX = Math.max(1, Math.round(band.frequency * band.stretchX));
    const periodY = Math.max(1, Math.round(band.frequency * band.stretchY));
    let sample = periodicValueNoise(u, v, seed + index * 1013, periodX, periodY);
    if (band.ridge) sample = 1 - Math.abs(sample * 2 - 1);
    value += sample * band.amplitude;
    weight += band.amplitude;
  }
  return weight > 0 ? clamp01(value / weight) : 0.5;
}

function mixPalette(colors: [number, number, number][], value: number): [number, number, number] {
  if (colors.length === 1) return colors[0];
  const scaled = clamp01(value) * (colors.length - 1);
  const index = Math.min(colors.length - 2, Math.floor(scaled));
  const mix = scaled - index;
  const a = colors[index];
  const b = colors[index + 1];
  return [
    Math.round(THREE.MathUtils.lerp(a[0], b[0], mix)),
    Math.round(THREE.MathUtils.lerp(a[1], b[1], mix)),
    Math.round(THREE.MathUtils.lerp(a[2], b[2], mix)),
  ];
}

type ColorGradientStop = { offset: number; color: string };
type ColorGradientSpec = {
  type: 'linear' | 'radial';
  axis: [number, number];
  stops: ColorGradientStop[];
};

function parseRgba(value: string): [number, number, number] {
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value);
  if (!match) return [138, 122, 95];
  return [clampAlbedoChannel(Number(match[1])), clampAlbedoChannel(Number(match[2])), clampAlbedoChannel(Number(match[3]))];
}

// Analytical per-pixel gradient sample. The extraction schema's colorGradient carries
// exact rgba(...) stop colors (see extract_part_color_recipe.py), so this samples the
// same trend directly in JS math rather than round-tripping through a Canvas 2D
// createLinearGradient/createRadialGradient object — same visual result, and it composes
// directly with the existing noise/height-correlated colorVariation blend below.
function sampleColorGradient(gradient: ColorGradientSpec, u: number, v: number): [number, number, number] {
  const stops = gradient.stops.length >= 2 ? gradient.stops : [{ offset: 0, color: 'rgba(138,122,95,1)' }, { offset: 1, color: 'rgba(138,122,95,1)' }];
  let t: number;
  if (gradient.type === 'radial') {
    const [cx, cy] = gradient.axis;
    const dx = u - cx;
    const dy = v - cy;
    const maxRadius = Math.max(0.001, Math.hypot(Math.max(cx, 1 - cx), Math.max(cy, 1 - cy)));
    t = clamp01(Math.hypot(dx, dy) / maxRadius);
  } else {
    const [ax, ay] = gradient.axis;
    const projection = (u - 0.5) * ax + (v - 0.5) * ay;
    const maxProjection = 0.5 * (Math.abs(ax) + Math.abs(ay)) || 0.5;
    t = clamp01(projection / maxProjection + 0.5);
  }
  const scaled = t * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.max(0, Math.floor(scaled)));
  const mix = scaled - index;
  const a = parseRgba(stops[index].color);
  const b = parseRgba(stops[index + 1].color);
  return [
    THREE.MathUtils.lerp(a[0], b[0], mix),
    THREE.MathUtils.lerp(a[1], b[1], mix),
    THREE.MathUtils.lerp(a[2], b[2], mix),
  ];
}

function writePixel(data: Uint8ClampedArray, offset: number, red: number, green: number, blue: number): void {
  data[offset] = Math.max(0, Math.min(255, Math.round(red)));
  data[offset + 1] = Math.max(0, Math.min(255, Math.round(green)));
  data[offset + 2] = Math.max(0, Math.min(255, Math.round(blue)));
  data[offset + 3] = 255;
}

function makeCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

function createMapTexture(
  canvas: HTMLCanvasElement,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [2, 2];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 2,
    typeof repeat[1] === 'number' ? repeat[1] : 2,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

type ProceduralTextureSet = {
  albedo: THREE.Texture;
  roughness: THREE.Texture;
  height: THREE.Texture;
  normal: THREE.Texture;
  ao: THREE.Texture;
  source: 'reference-pixel-extraction' | 'procedural';
};

function referenceMapUrl(spec: SculptMaterialSpec, channel: string): string | null {
  const reference = spec.referencePbr;
  if (!reference || typeof reference !== 'object') return null;
  if (reference.usable === false) return null;
  const confidence = typeof reference.confidence === 'number'
    ? reference.confidence
    : (typeof reference.estimatedFidelity === 'number' ? reference.estimatedFidelity : 0);
  const threshold = typeof reference.targetThreshold === 'number' ? reference.targetThreshold : 0.7;
  if (confidence < threshold) return null;
  const maps = reference.maps;
  if (!maps || typeof maps !== 'object') return null;
  const map = (maps as Record<string, unknown>)[channel];
  if (!map || typeof map !== 'object') return null;
  const record = map as Record<string, unknown>;
  const url = typeof record.url === 'string' && record.url.trim() ? record.url : record.path;
  return typeof url === 'string' && url.trim() ? url : null;
}

function createLoadedMapTexture(
  url: string,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.Texture {
  const texture = new THREE.TextureLoader().load(url);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [1, 1];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 1,
    typeof repeat[1] === 'number' ? repeat[1] : 1,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

function makeReferenceTextureSet(spec: SculptMaterialSpec, options: ProceduralModelOptions): ProceduralTextureSet | null {
  const albedo = referenceMapUrl(spec, 'albedo');
  const roughness = referenceMapUrl(spec, 'roughness');
  const height = referenceMapUrl(spec, 'height');
  const normal = referenceMapUrl(spec, 'normal');
  const ao = referenceMapUrl(spec, 'ao');
  if (!albedo || !roughness || !height || !normal || !ao) return null;
  return {
    albedo: createLoadedMapTexture(albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createLoadedMapTexture(roughness, THREE.NoColorSpace, spec, options),
    height: createLoadedMapTexture(height, THREE.NoColorSpace, spec, options),
    normal: createLoadedMapTexture(normal, THREE.NoColorSpace, spec, options),
    ao: createLoadedMapTexture(ao, THREE.NoColorSpace, spec, options),
    source: 'reference-pixel-extraction',
  };
}

function makeProceduralTextureSet(
  id: string,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): ProceduralTextureSet | null {
  if (typeof document === 'undefined') return null;
  const qualityFirst = (options.qualityPriority ?? 'reference-fidelity') === 'reference-fidelity';
  const requested = options.textureSize ?? spec.textureResolution;
  const requestedSize = typeof requested === 'number' && Number.isFinite(requested)
    ? requested
    : (qualityFirst ? 1024 : 512);
  const size = Math.max(256, Math.min(2048, 2 ** Math.round(Math.log2(requestedSize))));
  const canvases = {
    albedo: makeCanvas(size),
    roughness: makeCanvas(size),
    height: makeCanvas(size),
    normal: makeCanvas(size),
    ao: makeCanvas(size),
  };
  const contexts = {
    albedo: canvases.albedo.getContext('2d'),
    roughness: canvases.roughness.getContext('2d'),
    height: canvases.height.getContext('2d'),
    normal: canvases.normal.getContext('2d'),
    ao: canvases.ao.getContext('2d'),
  };
  if (!contexts.albedo || !contexts.roughness || !contexts.height || !contexts.normal || !contexts.ao) return null;
  const images = {
    albedo: contexts.albedo.createImageData(size, size),
    roughness: contexts.roughness.createImageData(size, size),
    height: contexts.height.createImageData(size, size),
    normal: contexts.normal.createImageData(size, size),
    ao: contexts.ao.createImageData(size, size),
  };
  const seed = hashString(id);
  const bands = surfaceBands(spec);
  const heightField = new Float32Array(size * size);
  const roughnessField = new Float32Array(size * size);
  const palette = materialPalette(spec);
  const fallback = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  const colors = (palette.length >= 2 ? palette : [fallback, '#6E614B', '#A08F70']).map(hexToRgb);
  const baseRoughness = clamp01(readLayerNumber(spec.roughness, ['base'], 0.76));
  const roughnessVariation = clamp01(readLayerNumber(spec.roughness, ['variation'], 0.18));
  const colorAmplitude = clamp01(readLayerNumber(spec.colorVariation, ['amplitude', 'variation'], 0.18));
  const heightCorrelation = clamp01(readLayerNumber(spec.colorVariation, ['heightCorrelation'], 0.3));
  const colorGradient: ColorGradientSpec | undefined = spec.colorGradient;
  for (let y = 0; y < size; y += 1) {
    const v = y / size;
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const index = y * size + x;
      const height = sampleSurface(u, v, bands, seed + 101);
      const roughNoise = sampleSurface(u, v, bands, seed + 7001);
      const colorNoise = sampleSurface(u, v, bands, seed + 15013);
      heightField[index] = height;
      roughnessField[index] = clamp01(baseRoughness + (roughNoise - 0.5) * roughnessVariation * 2);
      let color: [number, number, number];
      if (colorGradient) {
        // Evidence-derived spatial gradient (Plan 1.3 Workstream C) takes priority
        // over the noise-based palette blend below — it is a measured trend, not a guess.
        color = sampleColorGradient(colorGradient, u, v);
      } else {
        const paletteValue = clamp01(
          0.5 + (colorNoise - 0.5) * colorAmplitude * 2 + (height - 0.5) * heightCorrelation
        );
        color = mixPalette(colors, paletteValue);
      }
      writePixel(images.albedo.data, index * 4, color[0], color[1], color[2]);
    }
  }
  const normalStrength = Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35));
  const aoStrength = clamp01(readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35));
  for (let y = 0; y < size; y += 1) {
    const up = ((y - 1 + size) % size) * size;
    const down = ((y + 1) % size) * size;
    for (let x = 0; x < size; x += 1) {
      const left = (x - 1 + size) % size;
      const right = (x + 1) % size;
      const index = y * size + x;
      const center = heightField[index];
      const dx = (heightField[y * size + right] - heightField[y * size + left]) * normalStrength * 6;
      const dy = (heightField[down + x] - heightField[up + x]) * normalStrength * 6;
      const inverseLength = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const normalX = -dx * inverseLength;
      const normalY = -dy * inverseLength;
      const normalZ = inverseLength;
      const neighborAverage = (
        heightField[y * size + left] + heightField[y * size + right]
        + heightField[up + x] + heightField[down + x]
      ) * 0.25;
      const cavity = Math.max(0, neighborAverage - center);
      const ao = clamp01(1 - aoStrength * (cavity * 12 + (1 - center) * 0.16));
      const offset = index * 4;
      const heightByte = center * 255;
      const roughnessByte = roughnessField[index] * 255;
      writePixel(images.height.data, offset, heightByte, heightByte, heightByte);
      writePixel(images.roughness.data, offset, roughnessByte, roughnessByte, roughnessByte);
      writePixel(
        images.normal.data, offset,
        (normalX * 0.5 + 0.5) * 255,
        (normalY * 0.5 + 0.5) * 255,
        (normalZ * 0.5 + 0.5) * 255,
      );
      writePixel(images.ao.data, offset, ao * 255, ao * 255, ao * 255);
    }
  }
  contexts.albedo.putImageData(images.albedo, 0, 0);
  contexts.roughness.putImageData(images.roughness, 0, 0);
  contexts.height.putImageData(images.height, 0, 0);
  contexts.normal.putImageData(images.normal, 0, 0);
  contexts.ao.putImageData(images.ao, 0, 0);
  return {
    albedo: createMapTexture(canvases.albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createMapTexture(canvases.roughness, THREE.NoColorSpace, spec, options),
    height: createMapTexture(canvases.height, THREE.NoColorSpace, spec, options),
    normal: createMapTexture(canvases.normal, THREE.NoColorSpace, spec, options),
    ao: createMapTexture(canvases.ao, THREE.NoColorSpace, spec, options),
    source: 'procedural',
  };
}

function createSculptMaterial(id: string, spec: SculptMaterialSpec, options: ProceduralModelOptions, denseComponent = false): THREE.MeshPhysicalMaterial {
  // A material that declares -- with evidence -- that its subject carries no texture
  // detail gets NO texture set. Synthesising one anyway is not a harmless default: the
  // branch below then forces color to white and roughness to 1 and reads both from the
  // generated maps, so the authored albedo and the reference-derived roughness are both
  // discarded, and the model gains mottling the reference does not have. Measured on the
  // tuxedo cat, whose black fur rendered as speckled grey-and-white from a palette that
  // only ever described two flat regions.
  const textureless = (spec.textureless as { declared?: boolean } | undefined)?.declared === true;
  const textures = textureless
    ? null
    : makeReferenceTextureSet(spec, options) ?? makeProceduralTextureSet(id, spec, options);
  const material = new THREE.MeshPhysicalMaterial({
    color: textures ? 0xffffff : clampedAlbedoColor(spec),
    roughness: textures ? 1 : clamp01(readLayerNumber(spec.roughness, ['base'], 0.76)),
    metalness: clampPbrMetalness(readLayerNumber(spec.metalness, ['base'], 0.0)),
    clearcoat: clamp01(readLayerNumber(spec.clearcoat, ['base', 'amount'], 0)),
    clearcoatRoughness: clamp01(readLayerNumber(spec.clearcoatRoughness, ['base'], 0.25)),
    transmission: clamp01(readLayerNumber(spec.transmission, ['base', 'amount'], 0)),
    ior: clampPbrIor(readLayerNumber(spec.ior, ['base', 'value'], 1.5)),
    thickness: Math.max(0, readLayerNumber(spec.thickness, ['base', 'amount'], 0)),
    attenuationDistance: Math.max(0.001, readLayerNumber(spec.attenuationDistance, ['base', 'value'], Infinity)),
    attenuationColor: new THREE.Color(typeof spec.attenuationColor === 'string' ? spec.attenuationColor : '#ffffff'),
    sheen: clamp01(readLayerNumber(spec.sheen, ['base', 'amount'], 0)),
    sheenColor: new THREE.Color(typeof spec.sheenColor === 'string' ? spec.sheenColor : '#ffffff'),
    sheenRoughness: clamp01(readLayerNumber(spec.sheenRoughness, ['base'], 1.0)),
    iridescence: clamp01(readLayerNumber(spec.iridescence, ['base', 'amount'], 0)),
    iridescenceIOR: clampPbrIor(readLayerNumber(spec.iridescenceIOR, ['base', 'value'], 1.3)),
    anisotropy: clamp01(readLayerNumber(spec.anisotropy, ['base', 'amount'], 0)),
    anisotropyRotation: readLayerNumber(spec.anisotropy, ['rotation'], 0),
    specularIntensity: clampPbrF0(readLayerNumber(spec.specularF0 ?? spec.f0 ?? spec.specularIntensity, ['base', 'value'], 1.0)),
    specularColor: new THREE.Color(typeof spec.specularColor === 'string' ? spec.specularColor : '#ffffff'),
    emissive: new THREE.Color(typeof spec.emissive === 'string' ? spec.emissive : '#000000'),
    emissiveIntensity: Math.max(0, readLayerNumber(spec.emissiveIntensity, ['base'], 1.0)),
    opacity: clamp01(readLayerNumber(spec.opacity, ['base'], 1)),
    transparent: readLayerNumber(spec.transmission, ['base', 'amount'], 0) > 0 || readLayerNumber(spec.opacity, ['base'], 1) < 1,
    alphaTest: Math.max(0, readLayerNumber(spec.alpha, ['cutoff', 'alphaTest'], 0)),
    wireframe: options.wireframe ?? false,
    side: spec.doubleSided === true ? THREE.DoubleSide : THREE.FrontSide,
    flatShading: spec.flatShading === true,
  });
  if (textures) {
    material.map = textures.albedo;
    material.roughnessMap = textures.roughness;
    material.normalMap = textures.normal;
    material.normalScale.setScalar(Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35)));
    material.aoMap = textures.ao;
    material.aoMap.channel = 0;
    material.aoMapIntensity = readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35);
    const denseMesh = denseComponent || spec.denseMesh === true || spec.geometryDensity === 'dense' || spec.topologyClass === 'dense';
    const bumpScale = Math.max(0, readLayerNumber(spec.bump, ['amplitude', 'strength'], 0));
    const effectiveBumpScale = denseMesh ? Math.max(0.05, bumpScale) : bumpScale;
    if (effectiveBumpScale > 0) {
      material.bumpMap = textures.height;
      material.bumpScale = effectiveBumpScale;
    }
    const displacementScale = Math.max(0, readLayerNumber(spec.displacement, ['amplitude', 'strength'], 0));
    const effectiveDisplacementScale = denseMesh ? Math.max(0.005, displacementScale) : displacementScale;
    if (effectiveDisplacementScale > 0) {
      material.displacementMap = textures.height;
      material.displacementScale = effectiveDisplacementScale;
      material.displacementBias = -effectiveDisplacementScale * 0.5;
    }
  }
  material.envMapIntensity = readLayerNumber(spec, ['envMapIntensity'], 0.8);
  material.userData.sculptMaterial = spec;
  material.userData.proceduralMapsIndependent = true;
  material.userData.pbrConstraints = { albedoRange: [30, 240], binaryMetalness: true, f0Range: [0.02, 1], iorRange: [1, 2.5] };
  material.userData.pbrTextureSource = textures?.source ?? 'flat-fallback';
  material.userData.referencePbr = spec.referencePbr ?? null;
  material.userData.referenceMaterialId = spec.referenceMaterialId ?? spec.materialReference?.profileId ?? null;
  material.userData.materialEvidence = spec.materialEvidence ?? null;
  material.userData.validationViews = spec.materialReference?.validationViews ?? [];
  material.needsUpdate = true;
  return material;
}

type AttachmentEndpoint = {
  start: THREE.Vector3;
  midpoint: THREE.Vector3;
  quaternion: THREE.Quaternion;
  length: number;
  baseRadius: number;
  endRadius: number;
};

function readVector3(value: unknown, fallback: [number, number, number]): THREE.Vector3 {
  if (Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === 'number')) {
    return new THREE.Vector3(value[0], value[1], value[2]);
  }
  return new THREE.Vector3(fallback[0], fallback[1], fallback[2]);
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function makeAttachmentEndpoint(attachment: unknown): AttachmentEndpoint | null {
  if (!attachment || typeof attachment !== 'object') return null;
  const record = attachment as Record<string, unknown>;
  const start = readVector3(record.localStart, [0, 0, 0]);
  const end = readVector3(record.localEnd, [0, 1, 0]);
  const delta = end.clone().sub(start);
  const length = delta.length();
  if (length <= 0.0001) return null;
  const direction = delta.clone().normalize();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  const baseRadius = Math.max(0.005, readNumber(record.baseRadius, 0.06));
  const endRadius = Math.max(0.003, readNumber(record.endRadius, baseRadius * 0.55));
  return {
    start,
    midpoint: delta.multiplyScalar(0.5),
    quaternion,
    length,
    baseRadius,
    endRadius,
  };
}

// Generated from ObjectSculptSpec target: Roronoa Zoro
// Sculpt build pass: blockout
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createRoronoaZoroModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "Roronoa Zoro";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"solved": false, "fovDegrees": 40.0, "aspect": 0.6638095238095238, "orientation": {"yaw": 0.0, "pitch": 0.0, "roll": 0.0}, "positionHint": [0.0, 0.0, 3.0], "note": "Unsolved until rendered overlay; orthographic source art, no photographic focal length claim."}, "approximationNotes": []};
  root.userData.materialPipeline = {};
  root.userData.materialReferenceRegistry = null;

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["skin"] = createSculptMaterial(
    "skin",
    {"id": "skin", "name": "skin", "type": "physical", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#e8be8d", "color": "#e8be8d", "albedo": {"dominant": "#e8be8d", "secondary": ["#e8be8d"], "accents": []}, "colorVariation": {"palette": ["#e8be8d", "#e8be8d"], "pattern": "flat", "amplitude": 0, "heightCorrelation": 0}, "roughness": {"base": 0.62, "variation": 0.02, "map": "independent-micro-response"}, "metalness": {"base": 0, "variation": 0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "skin-fold-tone", "region": "reference-observed fold valleys", "roughness": 0.66, "evidenceRefs": ["full-object"], "notes": "Cloth folds are geometry; front shade boundary comes from de-lit projection."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Observed anime base colour. Physical roughness is inferred, not measured photometric evidence.", "textureless": {"declared": true, "evidence": ["docs/references/user-cast/zoro.png: flat cel-colour fills, bounded linework and painted shadow regions; no observable grain/pores.", ".img2threejs/cast/zoro/material-evidence.json: pixel crop and source-classification evidence."], "limitation": "No photometric PBR recovery is claimed. Geometry carries folds, fittings and wrap diamonds."}},
    options
  );
  materialMap["robe"] = createSculptMaterial(
    "robe",
    {"id": "robe", "name": "robe", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#426953", "color": "#426953", "albedo": {"dominant": "#426953", "secondary": ["#426953"], "accents": []}, "colorVariation": {"palette": ["#426953", "#426953"], "pattern": "flat", "amplitude": 0, "heightCorrelation": 0}, "roughness": {"base": 0.9, "variation": 0.02, "map": "independent-micro-response"}, "metalness": {"base": 0, "variation": 0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "robe-fold-tone", "region": "reference-observed fold valleys", "roughness": 0.9400000000000001, "evidenceRefs": ["full-object"], "notes": "Cloth folds are geometry; front shade boundary comes from de-lit projection."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Observed anime base colour. Physical roughness is inferred, not measured photometric evidence.", "textureless": {"declared": true, "evidence": ["docs/references/user-cast/zoro.png: flat cel-colour fills, bounded linework and painted shadow regions; no observable grain/pores.", ".img2threejs/cast/zoro/material-evidence.json: pixel crop and source-classification evidence."], "limitation": "No photometric PBR recovery is claimed. Geometry carries folds, fittings and wrap diamonds."}},
    options
  );
  materialMap["sash"] = createSculptMaterial(
    "sash",
    {"id": "sash", "name": "sash", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#7e2e50", "color": "#7e2e50", "albedo": {"dominant": "#7e2e50", "secondary": ["#7e2e50"], "accents": []}, "colorVariation": {"palette": ["#7e2e50", "#7e2e50"], "pattern": "flat", "amplitude": 0, "heightCorrelation": 0}, "roughness": {"base": 0.86, "variation": 0.02, "map": "independent-micro-response"}, "metalness": {"base": 0, "variation": 0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "sash-fold-tone", "region": "reference-observed fold valleys", "roughness": 0.9, "evidenceRefs": ["full-object"], "notes": "Cloth folds are geometry; front shade boundary comes from de-lit projection."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Observed anime base colour. Physical roughness is inferred, not measured photometric evidence.", "textureless": {"declared": true, "evidence": ["docs/references/user-cast/zoro.png: flat cel-colour fills, bounded linework and painted shadow regions; no observable grain/pores.", ".img2threejs/cast/zoro/material-evidence.json: pixel crop and source-classification evidence."], "limitation": "No photometric PBR recovery is claimed. Geometry carries folds, fittings and wrap diamonds."}},
    options
  );
  materialMap["haramaki"] = createSculptMaterial(
    "haramaki",
    {"id": "haramaki", "name": "haramaki", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#79a735", "color": "#79a735", "albedo": {"dominant": "#79a735", "secondary": ["#79a735"], "accents": []}, "colorVariation": {"palette": ["#79a735", "#79a735"], "pattern": "flat", "amplitude": 0, "heightCorrelation": 0}, "roughness": {"base": 0.92, "variation": 0.02, "map": "independent-micro-response"}, "metalness": {"base": 0, "variation": 0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "haramaki-fold-tone", "region": "reference-observed fold valleys", "roughness": 0.9600000000000001, "evidenceRefs": ["full-object"], "notes": "Cloth folds are geometry; front shade boundary comes from de-lit projection."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Observed anime base colour. Physical roughness is inferred, not measured photometric evidence.", "textureless": {"declared": true, "evidence": ["docs/references/user-cast/zoro.png: flat cel-colour fills, bounded linework and painted shadow regions; no observable grain/pores.", ".img2threejs/cast/zoro/material-evidence.json: pixel crop and source-classification evidence."], "limitation": "No photometric PBR recovery is claimed. Geometry carries folds, fittings and wrap diamonds."}},
    options
  );
  materialMap["hair"] = createSculptMaterial(
    "hair",
    {"id": "hair", "name": "hair", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#7bc28d", "color": "#7bc28d", "albedo": {"dominant": "#7bc28d", "secondary": ["#7bc28d"], "accents": []}, "colorVariation": {"palette": ["#7bc28d", "#7bc28d"], "pattern": "flat", "amplitude": 0, "heightCorrelation": 0}, "roughness": {"base": 0.67, "variation": 0.02, "map": "independent-micro-response"}, "metalness": {"base": 0, "variation": 0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "hair-fold-tone", "region": "reference-observed fold valleys", "roughness": 0.7100000000000001, "evidenceRefs": ["full-object"], "notes": "Cloth folds are geometry; front shade boundary comes from de-lit projection."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Observed anime base colour. Physical roughness is inferred, not measured photometric evidence.", "textureless": {"declared": true, "evidence": ["docs/references/user-cast/zoro.png: flat cel-colour fills, bounded linework and painted shadow regions; no observable grain/pores.", ".img2threejs/cast/zoro/material-evidence.json: pixel crop and source-classification evidence."], "limitation": "No photometric PBR recovery is claimed. Geometry carries folds, fittings and wrap diamonds."}},
    options
  );
  materialMap["boots"] = createSculptMaterial(
    "boots",
    {"id": "boots", "name": "boots", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#101614", "color": "#101614", "albedo": {"dominant": "#101614", "secondary": ["#101614"], "accents": []}, "colorVariation": {"palette": ["#101614", "#101614"], "pattern": "flat", "amplitude": 0, "heightCorrelation": 0}, "roughness": {"base": 0.64, "variation": 0.02, "map": "independent-micro-response"}, "metalness": {"base": 0, "variation": 0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "boots-fold-tone", "region": "reference-observed fold valleys", "roughness": 0.68, "evidenceRefs": ["full-object"], "notes": "Cloth folds are geometry; front shade boundary comes from de-lit projection."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Observed anime base colour. Physical roughness is inferred, not measured photometric evidence.", "textureless": {"declared": true, "evidence": ["docs/references/user-cast/zoro.png: flat cel-colour fills, bounded linework and painted shadow regions; no observable grain/pores.", ".img2threejs/cast/zoro/material-evidence.json: pixel crop and source-classification evidence."], "limitation": "No photometric PBR recovery is claimed. Geometry carries folds, fittings and wrap diamonds."}},
    options
  );
  materialMap["gold"] = createSculptMaterial(
    "gold",
    {"id": "gold", "name": "gold", "type": "physical", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#b3a05c", "color": "#b3a05c", "albedo": {"dominant": "#b3a05c", "secondary": ["#b3a05c"], "accents": []}, "colorVariation": {"palette": ["#b3a05c", "#b3a05c"], "pattern": "flat", "amplitude": 0, "heightCorrelation": 0}, "roughness": {"base": 0.28, "variation": 0.02, "map": "independent-micro-response"}, "metalness": {"base": 0.75, "variation": 0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "gold-fold-tone", "region": "reference-observed fold valleys", "roughness": 0.32, "evidenceRefs": ["full-object"], "notes": "Cloth folds are geometry; front shade boundary comes from de-lit projection."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Observed anime base colour. Physical roughness is inferred, not measured photometric evidence.", "textureless": {"declared": true, "evidence": ["docs/references/user-cast/zoro.png: flat cel-colour fills, bounded linework and painted shadow regions; no observable grain/pores.", ".img2threejs/cast/zoro/material-evidence.json: pixel crop and source-classification evidence."], "limitation": "No photometric PBR recovery is claimed. Geometry carries folds, fittings and wrap diamonds."}},
    options
  );
  materialMap["steel"] = createSculptMaterial(
    "steel",
    {"id": "steel", "name": "steel", "type": "physical", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#b4c0c7", "color": "#b4c0c7", "albedo": {"dominant": "#b4c0c7", "secondary": ["#b4c0c7"], "accents": []}, "colorVariation": {"palette": ["#b4c0c7", "#b4c0c7"], "pattern": "flat", "amplitude": 0, "heightCorrelation": 0}, "roughness": {"base": 0.23, "variation": 0.02, "map": "independent-micro-response"}, "metalness": {"base": 0.85, "variation": 0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "steel-fold-tone", "region": "reference-observed fold valleys", "roughness": 0.27, "evidenceRefs": ["full-object"], "notes": "Cloth folds are geometry; front shade boundary comes from de-lit projection."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Observed anime base colour. Physical roughness is inferred, not measured photometric evidence.", "textureless": {"declared": true, "evidence": ["docs/references/user-cast/zoro.png: flat cel-colour fills, bounded linework and painted shadow regions; no observable grain/pores.", ".img2threejs/cast/zoro/material-evidence.json: pixel crop and source-classification evidence."], "limitation": "No photometric PBR recovery is claimed. Geometry carries folds, fittings and wrap diamonds."}},
    options
  );
  materialMap["dark"] = createSculptMaterial(
    "dark",
    {"id": "dark", "name": "dark", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#20232c", "color": "#20232c", "albedo": {"dominant": "#20232c", "secondary": ["#20232c"], "accents": []}, "colorVariation": {"palette": ["#20232c", "#20232c"], "pattern": "flat", "amplitude": 0, "heightCorrelation": 0}, "roughness": {"base": 0.74, "variation": 0.02, "map": "independent-micro-response"}, "metalness": {"base": 0, "variation": 0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "dark-fold-tone", "region": "reference-observed fold valleys", "roughness": 0.78, "evidenceRefs": ["full-object"], "notes": "Cloth folds are geometry; front shade boundary comes from de-lit projection."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Observed anime base colour. Physical roughness is inferred, not measured photometric evidence.", "textureless": {"declared": true, "evidence": ["docs/references/user-cast/zoro.png: flat cel-colour fills, bounded linework and painted shadow regions; no observable grain/pores.", ".img2threejs/cast/zoro/material-evidence.json: pixel crop and source-classification evidence."], "limitation": "No photometric PBR recovery is claimed. Geometry carries folds, fittings and wrap diamonds."}},
    options
  );
  materialMap["white"] = createSculptMaterial(
    "white",
    {"id": "white", "name": "white", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#eeeade", "color": "#eeeade", "albedo": {"dominant": "#eeeade", "secondary": ["#eeeade"], "accents": []}, "colorVariation": {"palette": ["#eeeade", "#eeeade"], "pattern": "flat", "amplitude": 0, "heightCorrelation": 0}, "roughness": {"base": 0.48, "variation": 0.02, "map": "independent-micro-response"}, "metalness": {"base": 0, "variation": 0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "white-fold-tone", "region": "reference-observed fold valleys", "roughness": 0.52, "evidenceRefs": ["full-object"], "notes": "Cloth folds are geometry; front shade boundary comes from de-lit projection."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Observed anime base colour. Physical roughness is inferred, not measured photometric evidence.", "textureless": {"declared": true, "evidence": ["docs/references/user-cast/zoro.png: flat cel-colour fills, bounded linework and painted shadow regions; no observable grain/pores.", ".img2threejs/cast/zoro/material-evidence.json: pixel crop and source-classification evidence."], "limitation": "No photometric PBR recovery is claimed. Geometry carries folds, fittings and wrap diamonds."}},
    options
  );
  materialMap["scar"] = createSculptMaterial(
    "scar",
    {"id": "scar", "name": "scar", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#865541", "color": "#865541", "albedo": {"dominant": "#865541", "secondary": ["#865541"], "accents": []}, "colorVariation": {"palette": ["#865541", "#865541"], "pattern": "flat", "amplitude": 0, "heightCorrelation": 0}, "roughness": {"base": 0.7, "variation": 0.02, "map": "independent-micro-response"}, "metalness": {"base": 0, "variation": 0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "scar-fold-tone", "region": "reference-observed fold valleys", "roughness": 0.74, "evidenceRefs": ["full-object"], "notes": "Cloth folds are geometry; front shade boundary comes from de-lit projection."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Observed anime base colour. Physical roughness is inferred, not measured photometric evidence.", "textureless": {"declared": true, "evidence": ["docs/references/user-cast/zoro.png: flat cel-colour fills, bounded linework and painted shadow regions; no observable grain/pores.", ".img2threejs/cast/zoro/material-evidence.json: pixel crop and source-classification evidence."], "limitation": "No photometric PBR recovery is claimed. Geometry carries folds, fittings and wrap diamonds."}},
    options
  );
  materialMap["hidden"] = createSculptMaterial(
    "hidden",
    {"id": "hidden", "name": "hidden", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#000000", "color": "#000000", "albedo": {"dominant": "#000000", "secondary": ["#000000"], "accents": []}, "colorVariation": {"palette": ["#000000", "#000000"], "pattern": "flat", "amplitude": 0, "heightCorrelation": 0}, "roughness": {"base": 1, "variation": 0.02, "map": "independent-micro-response"}, "metalness": {"base": 0, "variation": 0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "hidden-fold-tone", "region": "reference-observed fold valleys", "roughness": 1, "evidenceRefs": ["full-object"], "notes": "Cloth folds are geometry; front shade boundary comes from de-lit projection."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Observed anime base colour. Physical roughness is inferred, not measured photometric evidence.", "textureless": {"declared": true, "evidence": ["docs/references/user-cast/zoro.png: flat cel-colour fills, bounded linework and painted shadow regions; no observable grain/pores.", ".img2threejs/cast/zoro/material-evidence.json: pixel crop and source-classification evidence."], "limitation": "No photometric PBR recovery is claimed. Geometry carries folds, fittings and wrap diamonds."}, "opacity": {"base": 0}},
    options
  );

  const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const endpoint_root_0 = makeAttachmentEndpoint(null);
  const node_root_0 = new THREE.Group();
  node_root_0.name = "Zoro reconstruction root__pivot";
  node_root_0.scale.set(1, 1, 1);
  if (endpoint_root_0) {
    node_root_0.position.copy(endpoint_root_0.start);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_root_0.position.set(0.0, 0.0, 0.0);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  }
  node_root_0.userData.sculptComponent = {"id": "root", "name": "Zoro reconstruction root", "level": "macro", "role": "body", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Zoro reconstruction root follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": null, "attachment": null, "dimensions": {"width": 0.001, "height": 0.001, "depth": 0.001, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.001, 0.001, 0.001]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hidden"}}, "material": "hidden", "materialLayers": ["hidden"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["root-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(0, 0, 0, 1)", "secondaryAlbedo": "rgba(0, 0, 0, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_root_0.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hidden"}};
  (nodes["root"] ?? root).add(node_root_0);
  nodes["root"] = node_root_0;
  const mesh_root_0Geometry = endpoint_root_0
    ? new THREE.CylinderGeometry(endpoint_root_0.endRadius, endpoint_root_0.baseRadius, endpoint_root_0.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_root_0) {
    mesh_root_0Geometry.scale(0.001, 0.001, 0.001);
  }
  const mesh_root_0 = new THREE.Mesh(
    mesh_root_0Geometry,
    materialMap["hidden"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_root_0.name = "Zoro reconstruction root";
  if (endpoint_root_0) {
    mesh_root_0.position.copy(endpoint_root_0.midpoint);
    mesh_root_0.quaternion.copy(endpoint_root_0.quaternion);
  }
  mesh_root_0.castShadow = options.castShadow ?? true;
  mesh_root_0.receiveShadow = options.receiveShadow ?? true;
  mesh_root_0.userData.sculptComponent = {"id": "root", "name": "Zoro reconstruction root", "level": "macro", "role": "body", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Zoro reconstruction root follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": null, "attachment": null, "dimensions": {"width": 0.001, "height": 0.001, "depth": 0.001, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [0.001, 0.001, 0.001]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hidden"}}, "material": "hidden", "materialLayers": ["hidden"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["root-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(0, 0, 0, 1)", "secondaryAlbedo": "rgba(0, 0, 0, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_root_0.add(mesh_root_0);
  meshes["root"] = mesh_root_0;
  colliders["root"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_root_0);

  const endpoint_robe_1 = makeAttachmentEndpoint(null);
  const node_robe_1 = new THREE.Group();
  node_robe_1.name = "Long flared robe__pivot";
  node_robe_1.scale.set(1, 1, 1);
  if (endpoint_robe_1) {
    node_robe_1.position.copy(endpoint_robe_1.start);
    node_robe_1.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_robe_1.position.set(-0.045, 0.0, 0.0);
    node_robe_1.rotation.set(0.0, 0.0, 0.0);
  }
  node_robe_1.userData.sculptComponent = {"id": "robe", "name": "Long flared robe", "level": "macro", "role": "garment", "importance": 0.9, "confidence": 0.8, "primitive": "lathe", "topologyClass": "conforming-shell", "topologyRationale": "Open-ended elliptical cloth shell; outer and inner profiles form a real thickness around the body.", "geometryDescriptor": {"latheProfile": {"points": [[0.3675, 0.4625], [0.385, 0.5375], [0.3575, 0.75], [0.315, 0.975], [0.275, 1.2], [0.2275, 1.4275], [0.2125, 1.4275], [0.26, 1.2], [0.3, 0.975], [0.3425, 0.75], [0.37, 0.5375], [0.3525, 0.4625], [0.3675, 0.4625]], "segments": 64}, "topologyIntent": "hollow elliptical garment wrap, six-pixel inferred thickness", "edgeTreatment": {"type": "none", "bevelRadius": 0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.045, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 0.52]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "robe", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "robe"}}, "material": "robe", "materialLayers": ["robe"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["robe-observed-contour", {"id": "robe-hem", "description": "Scalloped lower hem and long folded green skirt", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(66, 105, 83, 1)", "secondaryAlbedo": "rgba(59, 94, 75, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_robe_1.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "robe", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "robe"}};
  (nodes["root"] ?? root).add(node_robe_1);
  nodes["robe"] = node_robe_1;
  const mesh_robe_1Geometry = endpoint_robe_1
    ? new THREE.CylinderGeometry(endpoint_robe_1.endRadius, endpoint_robe_1.baseRadius, endpoint_robe_1.length, 32, 12)
    : buildLatheGeometry({"points": [[0.3675, 0.4625], [0.385, 0.5375], [0.3575, 0.75], [0.315, 0.975], [0.275, 1.2], [0.2275, 1.4275], [0.2125, 1.4275], [0.26, 1.2], [0.3, 0.975], [0.3425, 0.75], [0.37, 0.5375], [0.3525, 0.4625], [0.3675, 0.4625]], "segments": 64});
  if (!endpoint_robe_1) {
    mesh_robe_1Geometry.scale(1.0, 1.0, 0.52);
  }
  const mesh_robe_1 = new THREE.Mesh(
    mesh_robe_1Geometry,
    materialMap["robe"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_robe_1.name = "Long flared robe";
  if (endpoint_robe_1) {
    mesh_robe_1.position.copy(endpoint_robe_1.midpoint);
    mesh_robe_1.quaternion.copy(endpoint_robe_1.quaternion);
  }
  mesh_robe_1.castShadow = options.castShadow ?? true;
  mesh_robe_1.receiveShadow = options.receiveShadow ?? true;
  mesh_robe_1.userData.sculptComponent = {"id": "robe", "name": "Long flared robe", "level": "macro", "role": "garment", "importance": 0.9, "confidence": 0.8, "primitive": "lathe", "topologyClass": "conforming-shell", "topologyRationale": "Open-ended elliptical cloth shell; outer and inner profiles form a real thickness around the body.", "geometryDescriptor": {"latheProfile": {"points": [[0.3675, 0.4625], [0.385, 0.5375], [0.3575, 0.75], [0.315, 0.975], [0.275, 1.2], [0.2275, 1.4275], [0.2125, 1.4275], [0.26, 1.2], [0.3, 0.975], [0.3425, 0.75], [0.37, 0.5375], [0.3525, 0.4625], [0.3675, 0.4625]], "segments": 64}, "topologyIntent": "hollow elliptical garment wrap, six-pixel inferred thickness", "edgeTreatment": {"type": "none", "bevelRadius": 0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.045, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 0.52]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "robe", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "robe"}}, "material": "robe", "materialLayers": ["robe"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["robe-observed-contour", {"id": "robe-hem", "description": "Scalloped lower hem and long folded green skirt", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(66, 105, 83, 1)", "secondaryAlbedo": "rgba(59, 94, 75, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_robe_1.add(mesh_robe_1);
  meshes["robe"] = mesh_robe_1;
  colliders["robe"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["robe"] ??= [];
  destructionGroups["robe"].push(node_robe_1);

  const endpoint_chest_2 = makeAttachmentEndpoint(null);
  const node_chest_2 = new THREE.Group();
  node_chest_2.name = "Bare muscular chest__pivot";
  node_chest_2.scale.set(1, 1, 1);
  if (endpoint_chest_2) {
    node_chest_2.position.copy(endpoint_chest_2.start);
    node_chest_2.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_chest_2.position.set(0.0, 0.0, 0.0);
    node_chest_2.rotation.set(0.0, 0.0, 0.0);
  }
  node_chest_2.userData.sculptComponent = {"id": "chest", "name": "Bare muscular chest", "level": "macro", "role": "body", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "Bare muscular chest follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "Smooth-union body/garment blockout; garment shell offset and silhouette refinement remain later pass tasks.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "sdf": {"primitives": [{"id": "section-0", "type": "ellipsoid", "center": [-0.0125, 1.8875, 0.01], "radii": [0.1025, 0.0645174395028197, 0.075]}, {"id": "section-1", "type": "ellipsoid", "center": [-0.015, 1.995, 0.01], "radii": [0.1275, 0.132, 0.085]}, {"id": "section-2", "type": "ellipsoid", "center": [-0.0125, 2.1075, 0.01], "radii": [0.11, 0.102, 0.0775]}, {"id": "section-3", "type": "ellipsoid", "center": [-0.015, 2.165, 0.01], "radii": [0.0725, 0.034532593299664016, 0.0625]}], "operations": [{"id": "blend-1", "type": "smooth-union", "left": "section-0", "right": "section-1", "radius": 0.025}, {"id": "blend-2", "type": "smooth-union", "left": "blend-1", "right": "section-2", "radius": 0.025}, {"id": "blend-3", "type": "smooth-union", "left": "blend-2", "right": "section-3", "radius": 0.025}], "bounds": {"min": [-0.17250000000000001, 1.7929825604971803, -0.10500000000000001], "max": [0.14250000000000002, 2.2394999999999996, 0.125]}, "resolution": 42}, "observedStations": [[275, 285, 0.01, 41, 30], [274, 242, 0.01, 51, 34], [275, 197, 0.01, 44, 31], [274, 174, 0.01, 29, 25]]}, "parent": "root", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["chest-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L0", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_chest_2.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["root"] ?? root).add(node_chest_2);
  nodes["chest"] = node_chest_2;
  const mesh_chest_2Geometry = polygonizeSdf({"primitives": [{"id": "section-0", "type": "ellipsoid", "center": [-0.0125, 1.8875, 0.01], "radii": [0.1025, 0.0645174395028197, 0.075]}, {"id": "section-1", "type": "ellipsoid", "center": [-0.015, 1.995, 0.01], "radii": [0.1275, 0.132, 0.085]}, {"id": "section-2", "type": "ellipsoid", "center": [-0.0125, 2.1075, 0.01], "radii": [0.11, 0.102, 0.0775]}, {"id": "section-3", "type": "ellipsoid", "center": [-0.015, 2.165, 0.01], "radii": [0.0725, 0.034532593299664016, 0.0625]}], "operations": [{"id": "blend-1", "type": "smooth-union", "left": "section-0", "right": "section-1", "radius": 0.025}, {"id": "blend-2", "type": "smooth-union", "left": "blend-1", "right": "section-2", "radius": 0.025}, {"id": "blend-3", "type": "smooth-union", "left": "blend-2", "right": "section-3", "radius": 0.025}], "bounds": {"min": [-0.17250000000000001, 1.7929825604971803, -0.10500000000000001], "max": [0.14250000000000002, 2.2394999999999996, 0.125]}, "resolution": 42});
  if (!endpoint_chest_2) {
    mesh_chest_2Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_chest_2 = new THREE.Mesh(
    mesh_chest_2Geometry,
    createSculptMaterial("skin", {"id": "skin", "name": "skin", "type": "physical", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#e8be8d", "color": "#e8be8d", "albedo": {"dominant": "#e8be8d", "secondary": ["#e8be8d"], "accents": []}, "colorVariation": {"palette": ["#e8be8d", "#e8be8d"], "pattern": "flat", "amplitude": 0, "heightCorrelation": 0}, "roughness": {"base": 0.62, "variation": 0.02, "map": "independent-micro-response"}, "metalness": {"base": 0, "variation": 0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "skin-fold-tone", "region": "reference-observed fold valleys", "roughness": 0.66, "evidenceRefs": ["full-object"], "notes": "Cloth folds are geometry; front shade boundary comes from de-lit projection."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Observed anime base colour. Physical roughness is inferred, not measured photometric evidence.", "textureless": {"declared": true, "evidence": ["docs/references/user-cast/zoro.png: flat cel-colour fills, bounded linework and painted shadow regions; no observable grain/pores.", ".img2threejs/cast/zoro/material-evidence.json: pixel crop and source-classification evidence."], "limitation": "No photometric PBR recovery is claimed. Geometry carries folds, fittings and wrap diamonds."}}, options, true)
  );
  mesh_chest_2.name = "Bare muscular chest";
  if (endpoint_chest_2) {
    mesh_chest_2.position.copy(endpoint_chest_2.midpoint);
    mesh_chest_2.quaternion.copy(endpoint_chest_2.quaternion);
  }
  mesh_chest_2.castShadow = options.castShadow ?? true;
  mesh_chest_2.receiveShadow = options.receiveShadow ?? true;
  mesh_chest_2.userData.sculptComponent = {"id": "chest", "name": "Bare muscular chest", "level": "macro", "role": "body", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "Bare muscular chest follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "Smooth-union body/garment blockout; garment shell offset and silhouette refinement remain later pass tasks.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "sdf": {"primitives": [{"id": "section-0", "type": "ellipsoid", "center": [-0.0125, 1.8875, 0.01], "radii": [0.1025, 0.0645174395028197, 0.075]}, {"id": "section-1", "type": "ellipsoid", "center": [-0.015, 1.995, 0.01], "radii": [0.1275, 0.132, 0.085]}, {"id": "section-2", "type": "ellipsoid", "center": [-0.0125, 2.1075, 0.01], "radii": [0.11, 0.102, 0.0775]}, {"id": "section-3", "type": "ellipsoid", "center": [-0.015, 2.165, 0.01], "radii": [0.0725, 0.034532593299664016, 0.0625]}], "operations": [{"id": "blend-1", "type": "smooth-union", "left": "section-0", "right": "section-1", "radius": 0.025}, {"id": "blend-2", "type": "smooth-union", "left": "blend-1", "right": "section-2", "radius": 0.025}, {"id": "blend-3", "type": "smooth-union", "left": "blend-2", "right": "section-3", "radius": 0.025}], "bounds": {"min": [-0.17250000000000001, 1.7929825604971803, -0.10500000000000001], "max": [0.14250000000000002, 2.2394999999999996, 0.125]}, "resolution": 42}, "observedStations": [[275, 285, 0.01, 41, 30], [274, 242, 0.01, 51, 34], [275, 197, 0.01, 44, 31], [274, 174, 0.01, 29, 25]]}, "parent": "root", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["chest-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L0", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_chest_2.add(mesh_chest_2);
  meshes["chest"] = mesh_chest_2;
  colliders["chest"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["chest"] ??= [];
  destructionGroups["chest"].push(node_chest_2);

  const endpoint_neck_3 = makeAttachmentEndpoint(null);
  const node_neck_3 = new THREE.Group();
  node_neck_3.name = "Neck__pivot";
  node_neck_3.scale.set(1, 1, 1);
  if (endpoint_neck_3) {
    node_neck_3.position.copy(endpoint_neck_3.start);
    node_neck_3.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_neck_3.position.set(0.0, 0.0, 0.0);
    node_neck_3.rotation.set(0.0, 0.0, 0.0);
  }
  node_neck_3.userData.sculptComponent = {"id": "neck", "name": "Neck", "level": "meso", "role": "body", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "Neck follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "Smooth-union body/garment blockout; garment shell offset and silhouette refinement remain later pass tasks.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "sdf": {"primitives": [{"id": "section-0", "type": "ellipsoid", "center": [-0.015, 2.15, 0.005], "radii": [0.06, 0.048, 0.055]}, {"id": "section-1", "type": "ellipsoid", "center": [-0.015, 2.23, 0.005], "radii": [0.0475, 0.048, 0.05]}], "operations": [{"id": "blend-1", "type": "smooth-union", "left": "section-0", "right": "section-1", "radius": 0.025}], "bounds": {"min": [-0.105, 2.072, -0.08], "max": [0.075, 2.308, 0.09]}, "resolution": 42}, "observedStations": [[274, 180, 0.005, 24, 22], [274, 148, 0.005, 19, 20]]}, "parent": "root", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "neck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["neck-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L0", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_neck_3.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "neck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["root"] ?? root).add(node_neck_3);
  nodes["neck"] = node_neck_3;
  const mesh_neck_3Geometry = polygonizeSdf({"primitives": [{"id": "section-0", "type": "ellipsoid", "center": [-0.015, 2.15, 0.005], "radii": [0.06, 0.048, 0.055]}, {"id": "section-1", "type": "ellipsoid", "center": [-0.015, 2.23, 0.005], "radii": [0.0475, 0.048, 0.05]}], "operations": [{"id": "blend-1", "type": "smooth-union", "left": "section-0", "right": "section-1", "radius": 0.025}], "bounds": {"min": [-0.105, 2.072, -0.08], "max": [0.075, 2.308, 0.09]}, "resolution": 42});
  if (!endpoint_neck_3) {
    mesh_neck_3Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_neck_3 = new THREE.Mesh(
    mesh_neck_3Geometry,
    createSculptMaterial("skin", {"id": "skin", "name": "skin", "type": "physical", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#e8be8d", "color": "#e8be8d", "albedo": {"dominant": "#e8be8d", "secondary": ["#e8be8d"], "accents": []}, "colorVariation": {"palette": ["#e8be8d", "#e8be8d"], "pattern": "flat", "amplitude": 0, "heightCorrelation": 0}, "roughness": {"base": 0.62, "variation": 0.02, "map": "independent-micro-response"}, "metalness": {"base": 0, "variation": 0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "skin-fold-tone", "region": "reference-observed fold valleys", "roughness": 0.66, "evidenceRefs": ["full-object"], "notes": "Cloth folds are geometry; front shade boundary comes from de-lit projection."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Observed anime base colour. Physical roughness is inferred, not measured photometric evidence.", "textureless": {"declared": true, "evidence": ["docs/references/user-cast/zoro.png: flat cel-colour fills, bounded linework and painted shadow regions; no observable grain/pores.", ".img2threejs/cast/zoro/material-evidence.json: pixel crop and source-classification evidence."], "limitation": "No photometric PBR recovery is claimed. Geometry carries folds, fittings and wrap diamonds."}}, options, true)
  );
  mesh_neck_3.name = "Neck";
  if (endpoint_neck_3) {
    mesh_neck_3.position.copy(endpoint_neck_3.midpoint);
    mesh_neck_3.quaternion.copy(endpoint_neck_3.quaternion);
  }
  mesh_neck_3.castShadow = options.castShadow ?? true;
  mesh_neck_3.receiveShadow = options.receiveShadow ?? true;
  mesh_neck_3.userData.sculptComponent = {"id": "neck", "name": "Neck", "level": "meso", "role": "body", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "Neck follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "Smooth-union body/garment blockout; garment shell offset and silhouette refinement remain later pass tasks.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "sdf": {"primitives": [{"id": "section-0", "type": "ellipsoid", "center": [-0.015, 2.15, 0.005], "radii": [0.06, 0.048, 0.055]}, {"id": "section-1", "type": "ellipsoid", "center": [-0.015, 2.23, 0.005], "radii": [0.0475, 0.048, 0.05]}], "operations": [{"id": "blend-1", "type": "smooth-union", "left": "section-0", "right": "section-1", "radius": 0.025}], "bounds": {"min": [-0.105, 2.072, -0.08], "max": [0.075, 2.308, 0.09]}, "resolution": 42}, "observedStations": [[274, 180, 0.005, 24, 22], [274, 148, 0.005, 19, 20]]}, "parent": "root", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "neck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["neck-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L0", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_neck_3.add(mesh_neck_3);
  meshes["neck"] = mesh_neck_3;
  colliders["neck"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["neck"] ??= [];
  destructionGroups["neck"].push(node_neck_3);

  const endpoint_haramaki_4 = makeAttachmentEndpoint(null);
  const node_haramaki_4 = new THREE.Group();
  node_haramaki_4.name = "Green ribbed haramaki__pivot";
  node_haramaki_4.scale.set(1, 1, 1);
  if (endpoint_haramaki_4) {
    node_haramaki_4.position.copy(endpoint_haramaki_4.start);
    node_haramaki_4.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_haramaki_4.position.set(0.0, 0.0, 0.0);
    node_haramaki_4.rotation.set(0.0, 0.0, 0.0);
  }
  node_haramaki_4.userData.sculptComponent = {"id": "haramaki", "name": "Green ribbed haramaki", "level": "meso", "role": "garment", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "Green ribbed haramaki follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "Smooth-union body/garment blockout; garment shell offset and silhouette refinement remain later pass tasks.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "sdf": {"primitives": [{"id": "section-0", "type": "ellipsoid", "center": [-0.0125, 1.625, 0.015], "radii": [0.1525, 0.07501499850029993, 0.0975]}, {"id": "section-1", "type": "ellipsoid", "center": [-0.015, 1.75, 0.015], "radii": [0.1225, 0.16200694429560727, 0.08]}, {"id": "section-2", "type": "ellipsoid", "center": [-0.015, 1.895, 0.015], "radii": [0.1025, 0.087, 0.075]}], "operations": [{"id": "blend-1", "type": "smooth-union", "left": "section-0", "right": "section-1", "radius": 0.025}, {"id": "blend-2", "type": "smooth-union", "left": "blend-1", "right": "section-2", "radius": 0.025}], "bounds": {"min": [-0.195, 1.5199850014997, -0.1125], "max": [0.16999999999999998, 2.012, 0.14250000000000002]}, "resolution": 42}, "observedStations": [[275, 390, 0.015, 61, 39], [274, 340, 0.015, 49, 32], [274, 282, 0.015, 41, 30]]}, "parent": "root", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "haramaki", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "haramaki"}}, "material": "haramaki", "materialLayers": ["haramaki"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["haramaki-observed-contour", {"id": "haramaki-ribs", "description": "Vertical ribs in bright green waist wrap", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(121, 167, 53, 1)", "secondaryAlbedo": "rgba(109, 150, 48, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_haramaki_4.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "haramaki", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "haramaki"}};
  (nodes["root"] ?? root).add(node_haramaki_4);
  nodes["haramaki"] = node_haramaki_4;
  const mesh_haramaki_4Geometry = polygonizeSdf({"primitives": [{"id": "section-0", "type": "ellipsoid", "center": [-0.0125, 1.625, 0.015], "radii": [0.1525, 0.07501499850029993, 0.0975]}, {"id": "section-1", "type": "ellipsoid", "center": [-0.015, 1.75, 0.015], "radii": [0.1225, 0.16200694429560727, 0.08]}, {"id": "section-2", "type": "ellipsoid", "center": [-0.015, 1.895, 0.015], "radii": [0.1025, 0.087, 0.075]}], "operations": [{"id": "blend-1", "type": "smooth-union", "left": "section-0", "right": "section-1", "radius": 0.025}, {"id": "blend-2", "type": "smooth-union", "left": "blend-1", "right": "section-2", "radius": 0.025}], "bounds": {"min": [-0.195, 1.5199850014997, -0.1125], "max": [0.16999999999999998, 2.012, 0.14250000000000002]}, "resolution": 42});
  if (!endpoint_haramaki_4) {
    mesh_haramaki_4Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_haramaki_4 = new THREE.Mesh(
    mesh_haramaki_4Geometry,
    createSculptMaterial("haramaki", {"id": "haramaki", "name": "haramaki", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#79a735", "color": "#79a735", "albedo": {"dominant": "#79a735", "secondary": ["#79a735"], "accents": []}, "colorVariation": {"palette": ["#79a735", "#79a735"], "pattern": "flat", "amplitude": 0, "heightCorrelation": 0}, "roughness": {"base": 0.92, "variation": 0.02, "map": "independent-micro-response"}, "metalness": {"base": 0, "variation": 0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "haramaki-fold-tone", "region": "reference-observed fold valleys", "roughness": 0.9600000000000001, "evidenceRefs": ["full-object"], "notes": "Cloth folds are geometry; front shade boundary comes from de-lit projection."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Observed anime base colour. Physical roughness is inferred, not measured photometric evidence.", "textureless": {"declared": true, "evidence": ["docs/references/user-cast/zoro.png: flat cel-colour fills, bounded linework and painted shadow regions; no observable grain/pores.", ".img2threejs/cast/zoro/material-evidence.json: pixel crop and source-classification evidence."], "limitation": "No photometric PBR recovery is claimed. Geometry carries folds, fittings and wrap diamonds."}}, options, true)
  );
  mesh_haramaki_4.name = "Green ribbed haramaki";
  if (endpoint_haramaki_4) {
    mesh_haramaki_4.position.copy(endpoint_haramaki_4.midpoint);
    mesh_haramaki_4.quaternion.copy(endpoint_haramaki_4.quaternion);
  }
  mesh_haramaki_4.castShadow = options.castShadow ?? true;
  mesh_haramaki_4.receiveShadow = options.receiveShadow ?? true;
  mesh_haramaki_4.userData.sculptComponent = {"id": "haramaki", "name": "Green ribbed haramaki", "level": "meso", "role": "garment", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "Green ribbed haramaki follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "Smooth-union body/garment blockout; garment shell offset and silhouette refinement remain later pass tasks.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "sdf": {"primitives": [{"id": "section-0", "type": "ellipsoid", "center": [-0.0125, 1.625, 0.015], "radii": [0.1525, 0.07501499850029993, 0.0975]}, {"id": "section-1", "type": "ellipsoid", "center": [-0.015, 1.75, 0.015], "radii": [0.1225, 0.16200694429560727, 0.08]}, {"id": "section-2", "type": "ellipsoid", "center": [-0.015, 1.895, 0.015], "radii": [0.1025, 0.087, 0.075]}], "operations": [{"id": "blend-1", "type": "smooth-union", "left": "section-0", "right": "section-1", "radius": 0.025}, {"id": "blend-2", "type": "smooth-union", "left": "blend-1", "right": "section-2", "radius": 0.025}], "bounds": {"min": [-0.195, 1.5199850014997, -0.1125], "max": [0.16999999999999998, 2.012, 0.14250000000000002]}, "resolution": 42}, "observedStations": [[275, 390, 0.015, 61, 39], [274, 340, 0.015, 49, 32], [274, 282, 0.015, 41, 30]]}, "parent": "root", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "haramaki", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "haramaki"}}, "material": "haramaki", "materialLayers": ["haramaki"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["haramaki-observed-contour", {"id": "haramaki-ribs", "description": "Vertical ribs in bright green waist wrap", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(121, 167, 53, 1)", "secondaryAlbedo": "rgba(109, 150, 48, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_haramaki_4.add(mesh_haramaki_4);
  meshes["haramaki"] = mesh_haramaki_4;
  colliders["haramaki"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["haramaki"] ??= [];
  destructionGroups["haramaki"].push(node_haramaki_4);

  const endpoint_robe_left_5 = makeAttachmentEndpoint(null);
  const node_robe_left_5 = new THREE.Group();
  node_robe_left_5.name = "Left lapel and shoulder__pivot";
  node_robe_left_5.scale.set(1, 1, 1);
  if (endpoint_robe_left_5) {
    node_robe_left_5.position.copy(endpoint_robe_left_5.start);
    node_robe_left_5.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_robe_left_5.position.set(0.0, 0.0, 0.09);
    node_robe_left_5.rotation.set(0.0, 0.0, 0.0);
  }
  node_robe_left_5.userData.sculptComponent = {"id": "robe-left", "name": "Left lapel and shoulder", "level": "macro", "role": "garment", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "Thin fitted garment panel follows observed contour; thickness is physical fabric thickness, not a continuous body volume.", "geometryDescriptor": {"profile2D": {"points": [[0.07, 2.1675], [0.155, 2.135], [0.235, 2.025], [0.2275, 1.8225], [0.1725, 1.6425], [0.0275, 1.6175], [0.1075, 1.745], [0.1, 1.99]], "depth": 0.035}, "topologyIntent": "garment shell with observed hem and folds; depth inferred", "edgeTreatment": {"type": "none", "bevelRadius": 0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "crease-preserving vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.2075, "height": 0.55, "depth": 0.035, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0.09], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "robe-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "robe"}}, "material": "robe", "materialLayers": ["robe"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["robe-left-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(66, 105, 83, 1)", "secondaryAlbedo": "rgba(59, 94, 75, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_robe_left_5.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "robe-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "robe"}};
  (nodes["root"] ?? root).add(node_robe_left_5);
  nodes["robe-left"] = node_robe_left_5;
  const mesh_robe_left_5Geometry = endpoint_robe_left_5
    ? new THREE.CylinderGeometry(endpoint_robe_left_5.endRadius, endpoint_robe_left_5.baseRadius, endpoint_robe_left_5.length, 32, 12)
    : buildExtrudeGeometry({"points": [[0.07, 2.1675], [0.155, 2.135], [0.235, 2.025], [0.2275, 1.8225], [0.1725, 1.6425], [0.0275, 1.6175], [0.1075, 1.745], [0.1, 1.99]], "depth": 0.035});
  if (!endpoint_robe_left_5) {
    mesh_robe_left_5Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_robe_left_5 = new THREE.Mesh(
    mesh_robe_left_5Geometry,
    materialMap["robe"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_robe_left_5.name = "Left lapel and shoulder";
  if (endpoint_robe_left_5) {
    mesh_robe_left_5.position.copy(endpoint_robe_left_5.midpoint);
    mesh_robe_left_5.quaternion.copy(endpoint_robe_left_5.quaternion);
  }
  mesh_robe_left_5.castShadow = options.castShadow ?? true;
  mesh_robe_left_5.receiveShadow = options.receiveShadow ?? true;
  mesh_robe_left_5.userData.sculptComponent = {"id": "robe-left", "name": "Left lapel and shoulder", "level": "macro", "role": "garment", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "Thin fitted garment panel follows observed contour; thickness is physical fabric thickness, not a continuous body volume.", "geometryDescriptor": {"profile2D": {"points": [[0.07, 2.1675], [0.155, 2.135], [0.235, 2.025], [0.2275, 1.8225], [0.1725, 1.6425], [0.0275, 1.6175], [0.1075, 1.745], [0.1, 1.99]], "depth": 0.035}, "topologyIntent": "garment shell with observed hem and folds; depth inferred", "edgeTreatment": {"type": "none", "bevelRadius": 0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "crease-preserving vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.2075, "height": 0.55, "depth": 0.035, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0.09], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "robe-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "robe"}}, "material": "robe", "materialLayers": ["robe"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["robe-left-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(66, 105, 83, 1)", "secondaryAlbedo": "rgba(59, 94, 75, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_robe_left_5.add(mesh_robe_left_5);
  meshes["robe-left"] = mesh_robe_left_5;
  colliders["robe-left"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["robe-left"] ??= [];
  destructionGroups["robe-left"].push(node_robe_left_5);

  const endpoint_robe_right_6 = makeAttachmentEndpoint(null);
  const node_robe_right_6 = new THREE.Group();
  node_robe_right_6.name = "Right lapel and shoulder__pivot";
  node_robe_right_6.scale.set(1, 1, 1);
  if (endpoint_robe_right_6) {
    node_robe_right_6.position.copy(endpoint_robe_right_6.start);
    node_robe_right_6.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_robe_right_6.position.set(0.0, 0.0, 0.09);
    node_robe_right_6.rotation.set(0.0, 0.0, 0.0);
  }
  node_robe_right_6.userData.sculptComponent = {"id": "robe-right", "name": "Right lapel and shoulder", "level": "macro", "role": "garment", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "Thin fitted garment panel follows observed contour; thickness is physical fabric thickness, not a continuous body volume.", "geometryDescriptor": {"profile2D": {"points": [[-0.12, 2.165], [-0.1725, 2.1375], [-0.2575, 2.1375], [-0.27, 1.915], [-0.285, 1.73], [-0.2175, 1.6325], [-0.08, 1.615], [-0.1425, 1.725], [-0.1275, 1.9625]], "depth": 0.035}, "topologyIntent": "garment shell with observed hem and folds; depth inferred", "edgeTreatment": {"type": "none", "bevelRadius": 0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "crease-preserving vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.205, "height": 0.55, "depth": 0.035, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0.09], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "robe-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "robe"}}, "material": "robe", "materialLayers": ["robe"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["robe-right-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(66, 105, 83, 1)", "secondaryAlbedo": "rgba(59, 94, 75, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_robe_right_6.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "robe-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "robe"}};
  (nodes["root"] ?? root).add(node_robe_right_6);
  nodes["robe-right"] = node_robe_right_6;
  const mesh_robe_right_6Geometry = endpoint_robe_right_6
    ? new THREE.CylinderGeometry(endpoint_robe_right_6.endRadius, endpoint_robe_right_6.baseRadius, endpoint_robe_right_6.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.12, 2.165], [-0.1725, 2.1375], [-0.2575, 2.1375], [-0.27, 1.915], [-0.285, 1.73], [-0.2175, 1.6325], [-0.08, 1.615], [-0.1425, 1.725], [-0.1275, 1.9625]], "depth": 0.035});
  if (!endpoint_robe_right_6) {
    mesh_robe_right_6Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_robe_right_6 = new THREE.Mesh(
    mesh_robe_right_6Geometry,
    materialMap["robe"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_robe_right_6.name = "Right lapel and shoulder";
  if (endpoint_robe_right_6) {
    mesh_robe_right_6.position.copy(endpoint_robe_right_6.midpoint);
    mesh_robe_right_6.quaternion.copy(endpoint_robe_right_6.quaternion);
  }
  mesh_robe_right_6.castShadow = options.castShadow ?? true;
  mesh_robe_right_6.receiveShadow = options.receiveShadow ?? true;
  mesh_robe_right_6.userData.sculptComponent = {"id": "robe-right", "name": "Right lapel and shoulder", "level": "macro", "role": "garment", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "Thin fitted garment panel follows observed contour; thickness is physical fabric thickness, not a continuous body volume.", "geometryDescriptor": {"profile2D": {"points": [[-0.12, 2.165], [-0.1725, 2.1375], [-0.2575, 2.1375], [-0.27, 1.915], [-0.285, 1.73], [-0.2175, 1.6325], [-0.08, 1.615], [-0.1425, 1.725], [-0.1275, 1.9625]], "depth": 0.035}, "topologyIntent": "garment shell with observed hem and folds; depth inferred", "edgeTreatment": {"type": "none", "bevelRadius": 0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "crease-preserving vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.205, "height": 0.55, "depth": 0.035, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0.09], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "robe-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "robe"}}, "material": "robe", "materialLayers": ["robe"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["robe-right-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(66, 105, 83, 1)", "secondaryAlbedo": "rgba(59, 94, 75, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_robe_right_6.add(mesh_robe_right_6);
  meshes["robe-right"] = mesh_robe_right_6;
  colliders["robe-right"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["robe-right"] ??= [];
  destructionGroups["robe-right"].push(node_robe_right_6);

  const endpoint_sleeve_raised_7 = makeAttachmentEndpoint(null);
  const node_sleeve_raised_7 = new THREE.Group();
  node_sleeve_raised_7.name = "Raised right sleeve__pivot";
  node_sleeve_raised_7.scale.set(1, 1, 1);
  if (endpoint_sleeve_raised_7) {
    node_sleeve_raised_7.position.copy(endpoint_sleeve_raised_7.start);
    node_sleeve_raised_7.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_sleeve_raised_7.position.set(0.0, 0.0, 0.0);
    node_sleeve_raised_7.rotation.set(0.0, 0.0, 0.0);
  }
  node_sleeve_raised_7.userData.sculptComponent = {"id": "sleeve-raised", "name": "Raised right sleeve", "level": "meso", "role": "garment", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "Raised right sleeve follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "Continuous oriented capsules fitted to observed shoulder, elbow and cuff.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "sdf": {"primitives": [{"id": "bone-0", "type": "capsule", "radius": 0.0775, "height": 0.2737014797183238, "transform": {"position": [-0.38375000000000004, 2.04375, 0.0], "rotation": [0, 0, 1.8578786959820395], "scale": [1, 1, 0.9]}}, {"id": "bone-1", "type": "capsule", "radius": 0.0725, "height": 0.20713823886477375, "transform": {"position": [-0.46375, 2.0949999999999998, 0.0], "rotation": [0, 0, -0.5176491093767742], "scale": [1, 1, 0.9]}}], "operations": [{"id": "join-1", "type": "smooth-union", "left": "bone-0", "right": "bone-1", "radius": 0.02}], "bounds": {"min": [-0.6175, 1.9025, -0.10250000000000001], "max": [-0.15, 2.2824999999999998, 0.10250000000000001]}, "resolution": 42}, "observedStations": [[176, 204, 0, 36, 37], [128, 240, 0, 37, 34], [91, 247, 0, 36, 33], [86, 218, 0, 32, 29], [111, 180, 0, 28, 27], [126, 153, 0, 25, 25]]}, "parent": "root", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "sleeve-raised", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "robe"}}, "material": "robe", "materialLayers": ["robe"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["sleeve-raised-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(66, 105, 83, 1)", "secondaryAlbedo": "rgba(59, 94, 75, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_sleeve_raised_7.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "sleeve-raised", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "robe"}};
  (nodes["root"] ?? root).add(node_sleeve_raised_7);
  nodes["sleeve-raised"] = node_sleeve_raised_7;
  const mesh_sleeve_raised_7Geometry = polygonizeSdf({"primitives": [{"id": "bone-0", "type": "capsule", "radius": 0.0775, "height": 0.2737014797183238, "transform": {"position": [-0.38375000000000004, 2.04375, 0.0], "rotation": [0, 0, 1.8578786959820395], "scale": [1, 1, 0.9]}}, {"id": "bone-1", "type": "capsule", "radius": 0.0725, "height": 0.20713823886477375, "transform": {"position": [-0.46375, 2.0949999999999998, 0.0], "rotation": [0, 0, -0.5176491093767742], "scale": [1, 1, 0.9]}}], "operations": [{"id": "join-1", "type": "smooth-union", "left": "bone-0", "right": "bone-1", "radius": 0.02}], "bounds": {"min": [-0.6175, 1.9025, -0.10250000000000001], "max": [-0.15, 2.2824999999999998, 0.10250000000000001]}, "resolution": 42});
  if (!endpoint_sleeve_raised_7) {
    mesh_sleeve_raised_7Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_sleeve_raised_7 = new THREE.Mesh(
    mesh_sleeve_raised_7Geometry,
    createSculptMaterial("robe", {"id": "robe", "name": "robe", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#426953", "color": "#426953", "albedo": {"dominant": "#426953", "secondary": ["#426953"], "accents": []}, "colorVariation": {"palette": ["#426953", "#426953"], "pattern": "flat", "amplitude": 0, "heightCorrelation": 0}, "roughness": {"base": 0.9, "variation": 0.02, "map": "independent-micro-response"}, "metalness": {"base": 0, "variation": 0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "robe-fold-tone", "region": "reference-observed fold valleys", "roughness": 0.9400000000000001, "evidenceRefs": ["full-object"], "notes": "Cloth folds are geometry; front shade boundary comes from de-lit projection."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Observed anime base colour. Physical roughness is inferred, not measured photometric evidence.", "textureless": {"declared": true, "evidence": ["docs/references/user-cast/zoro.png: flat cel-colour fills, bounded linework and painted shadow regions; no observable grain/pores.", ".img2threejs/cast/zoro/material-evidence.json: pixel crop and source-classification evidence."], "limitation": "No photometric PBR recovery is claimed. Geometry carries folds, fittings and wrap diamonds."}}, options, true)
  );
  mesh_sleeve_raised_7.name = "Raised right sleeve";
  if (endpoint_sleeve_raised_7) {
    mesh_sleeve_raised_7.position.copy(endpoint_sleeve_raised_7.midpoint);
    mesh_sleeve_raised_7.quaternion.copy(endpoint_sleeve_raised_7.quaternion);
  }
  mesh_sleeve_raised_7.castShadow = options.castShadow ?? true;
  mesh_sleeve_raised_7.receiveShadow = options.receiveShadow ?? true;
  mesh_sleeve_raised_7.userData.sculptComponent = {"id": "sleeve-raised", "name": "Raised right sleeve", "level": "meso", "role": "garment", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "Raised right sleeve follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "Continuous oriented capsules fitted to observed shoulder, elbow and cuff.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "sdf": {"primitives": [{"id": "bone-0", "type": "capsule", "radius": 0.0775, "height": 0.2737014797183238, "transform": {"position": [-0.38375000000000004, 2.04375, 0.0], "rotation": [0, 0, 1.8578786959820395], "scale": [1, 1, 0.9]}}, {"id": "bone-1", "type": "capsule", "radius": 0.0725, "height": 0.20713823886477375, "transform": {"position": [-0.46375, 2.0949999999999998, 0.0], "rotation": [0, 0, -0.5176491093767742], "scale": [1, 1, 0.9]}}], "operations": [{"id": "join-1", "type": "smooth-union", "left": "bone-0", "right": "bone-1", "radius": 0.02}], "bounds": {"min": [-0.6175, 1.9025, -0.10250000000000001], "max": [-0.15, 2.2824999999999998, 0.10250000000000001]}, "resolution": 42}, "observedStations": [[176, 204, 0, 36, 37], [128, 240, 0, 37, 34], [91, 247, 0, 36, 33], [86, 218, 0, 32, 29], [111, 180, 0, 28, 27], [126, 153, 0, 25, 25]]}, "parent": "root", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "sleeve-raised", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "robe"}}, "material": "robe", "materialLayers": ["robe"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["sleeve-raised-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(66, 105, 83, 1)", "secondaryAlbedo": "rgba(59, 94, 75, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_sleeve_raised_7.add(mesh_sleeve_raised_7);
  meshes["sleeve-raised"] = mesh_sleeve_raised_7;
  colliders["sleeve-raised"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["sleeve-raised"] ??= [];
  destructionGroups["sleeve-raised"].push(node_sleeve_raised_7);

  const endpoint_forearm_raised_8 = makeAttachmentEndpoint(null);
  const node_forearm_raised_8 = new THREE.Group();
  node_forearm_raised_8.name = "Raised right forearm__pivot";
  node_forearm_raised_8.scale.set(1, 1, 1);
  if (endpoint_forearm_raised_8) {
    node_forearm_raised_8.position.copy(endpoint_forearm_raised_8.start);
    node_forearm_raised_8.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_forearm_raised_8.position.set(0.0, 0.0, 0.0);
    node_forearm_raised_8.rotation.set(0.0, 0.0, 0.0);
  }
  node_forearm_raised_8.userData.sculptComponent = {"id": "forearm-raised", "name": "Raised right forearm", "level": "meso", "role": "body", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "Raised right forearm follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "Continuous oriented capsules fitted to observed shoulder, elbow and cuff.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "sdf": {"primitives": [{"id": "bone-0", "type": "capsule", "radius": 0.0425, "height": 0.1261199825562945, "transform": {"position": [-0.345, 2.25625, 0.0], "rotation": [0, 0, -0.6871242101414385], "scale": [1, 1, 0.85]}}], "operations": [], "bounds": {"min": [-0.4525, 2.14, -0.0675], "max": [-0.23750000000000002, 2.3725, 0.0675]}, "resolution": 42}, "observedStations": [[126, 161, 0.005, 21, 20], [146, 135, 0.02, 19, 18], [160, 115, 0.04, 16, 16]]}, "parent": "root", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "forearm-raised", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["forearm-raised-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L0", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_forearm_raised_8.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "forearm-raised", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["root"] ?? root).add(node_forearm_raised_8);
  nodes["forearm-raised"] = node_forearm_raised_8;
  const mesh_forearm_raised_8Geometry = polygonizeSdf({"primitives": [{"id": "bone-0", "type": "capsule", "radius": 0.0425, "height": 0.1261199825562945, "transform": {"position": [-0.345, 2.25625, 0.0], "rotation": [0, 0, -0.6871242101414385], "scale": [1, 1, 0.85]}}], "operations": [], "bounds": {"min": [-0.4525, 2.14, -0.0675], "max": [-0.23750000000000002, 2.3725, 0.0675]}, "resolution": 42});
  if (!endpoint_forearm_raised_8) {
    mesh_forearm_raised_8Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_forearm_raised_8 = new THREE.Mesh(
    mesh_forearm_raised_8Geometry,
    createSculptMaterial("skin", {"id": "skin", "name": "skin", "type": "physical", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#e8be8d", "color": "#e8be8d", "albedo": {"dominant": "#e8be8d", "secondary": ["#e8be8d"], "accents": []}, "colorVariation": {"palette": ["#e8be8d", "#e8be8d"], "pattern": "flat", "amplitude": 0, "heightCorrelation": 0}, "roughness": {"base": 0.62, "variation": 0.02, "map": "independent-micro-response"}, "metalness": {"base": 0, "variation": 0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "skin-fold-tone", "region": "reference-observed fold valleys", "roughness": 0.66, "evidenceRefs": ["full-object"], "notes": "Cloth folds are geometry; front shade boundary comes from de-lit projection."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Observed anime base colour. Physical roughness is inferred, not measured photometric evidence.", "textureless": {"declared": true, "evidence": ["docs/references/user-cast/zoro.png: flat cel-colour fills, bounded linework and painted shadow regions; no observable grain/pores.", ".img2threejs/cast/zoro/material-evidence.json: pixel crop and source-classification evidence."], "limitation": "No photometric PBR recovery is claimed. Geometry carries folds, fittings and wrap diamonds."}}, options, true)
  );
  mesh_forearm_raised_8.name = "Raised right forearm";
  if (endpoint_forearm_raised_8) {
    mesh_forearm_raised_8.position.copy(endpoint_forearm_raised_8.midpoint);
    mesh_forearm_raised_8.quaternion.copy(endpoint_forearm_raised_8.quaternion);
  }
  mesh_forearm_raised_8.castShadow = options.castShadow ?? true;
  mesh_forearm_raised_8.receiveShadow = options.receiveShadow ?? true;
  mesh_forearm_raised_8.userData.sculptComponent = {"id": "forearm-raised", "name": "Raised right forearm", "level": "meso", "role": "body", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "Raised right forearm follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "Continuous oriented capsules fitted to observed shoulder, elbow and cuff.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "sdf": {"primitives": [{"id": "bone-0", "type": "capsule", "radius": 0.0425, "height": 0.1261199825562945, "transform": {"position": [-0.345, 2.25625, 0.0], "rotation": [0, 0, -0.6871242101414385], "scale": [1, 1, 0.85]}}], "operations": [], "bounds": {"min": [-0.4525, 2.14, -0.0675], "max": [-0.23750000000000002, 2.3725, 0.0675]}, "resolution": 42}, "observedStations": [[126, 161, 0.005, 21, 20], [146, 135, 0.02, 19, 18], [160, 115, 0.04, 16, 16]]}, "parent": "root", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "forearm-raised", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["forearm-raised-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L0", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_forearm_raised_8.add(mesh_forearm_raised_8);
  meshes["forearm-raised"] = mesh_forearm_raised_8;
  colliders["forearm-raised"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["forearm-raised"] ??= [];
  destructionGroups["forearm-raised"].push(node_forearm_raised_8);

  const endpoint_sleeve_down_9 = makeAttachmentEndpoint(null);
  const node_sleeve_down_9 = new THREE.Group();
  node_sleeve_down_9.name = "Low left sleeve__pivot";
  node_sleeve_down_9.scale.set(1, 1, 1);
  if (endpoint_sleeve_down_9) {
    node_sleeve_down_9.position.copy(endpoint_sleeve_down_9.start);
    node_sleeve_down_9.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_sleeve_down_9.position.set(0.0, 0.0, 0.0);
    node_sleeve_down_9.rotation.set(0.0, 0.0, 0.0);
  }
  node_sleeve_down_9.userData.sculptComponent = {"id": "sleeve-down", "name": "Low left sleeve", "level": "meso", "role": "garment", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "Low left sleeve follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "Continuous oriented capsules fitted to observed shoulder, elbow and cuff.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "sdf": {"primitives": [{"id": "bone-0", "type": "capsule", "radius": 0.075, "height": 0.32163644072150777, "transform": {"position": [0.215, 1.89, 0.0], "rotation": [0, 0, -2.9380996083322306], "scale": [1, 1, 0.9]}}, {"id": "bone-1", "type": "capsule", "radius": 0.065, "height": 0.255893044063335, "transform": {"position": [0.28, 1.6087500000000001, 0.0], "rotation": [0, 0, -2.8847662036199853], "scale": [1, 1, 0.9]}}], "operations": [{"id": "join-1", "type": "smooth-union", "left": "bone-0", "right": "bone-1", "radius": 0.02}], "bounds": {"min": [0.08249999999999999, 1.3950000000000002, -0.1], "max": [0.4025, 2.1475, 0.1]}, "resolution": 42}, "observedStations": [[353, 233, 0, 32, 32], [380, 334, 0, 30, 28], [393, 411, 0, 28, 27], [407, 468, 0, 25, 24]]}, "parent": "root", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "sleeve-down", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "robe"}}, "material": "robe", "materialLayers": ["robe"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["sleeve-down-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(66, 105, 83, 1)", "secondaryAlbedo": "rgba(59, 94, 75, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_sleeve_down_9.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "sleeve-down", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "robe"}};
  (nodes["root"] ?? root).add(node_sleeve_down_9);
  nodes["sleeve-down"] = node_sleeve_down_9;
  const mesh_sleeve_down_9Geometry = polygonizeSdf({"primitives": [{"id": "bone-0", "type": "capsule", "radius": 0.075, "height": 0.32163644072150777, "transform": {"position": [0.215, 1.89, 0.0], "rotation": [0, 0, -2.9380996083322306], "scale": [1, 1, 0.9]}}, {"id": "bone-1", "type": "capsule", "radius": 0.065, "height": 0.255893044063335, "transform": {"position": [0.28, 1.6087500000000001, 0.0], "rotation": [0, 0, -2.8847662036199853], "scale": [1, 1, 0.9]}}], "operations": [{"id": "join-1", "type": "smooth-union", "left": "bone-0", "right": "bone-1", "radius": 0.02}], "bounds": {"min": [0.08249999999999999, 1.3950000000000002, -0.1], "max": [0.4025, 2.1475, 0.1]}, "resolution": 42});
  if (!endpoint_sleeve_down_9) {
    mesh_sleeve_down_9Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_sleeve_down_9 = new THREE.Mesh(
    mesh_sleeve_down_9Geometry,
    createSculptMaterial("robe", {"id": "robe", "name": "robe", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#426953", "color": "#426953", "albedo": {"dominant": "#426953", "secondary": ["#426953"], "accents": []}, "colorVariation": {"palette": ["#426953", "#426953"], "pattern": "flat", "amplitude": 0, "heightCorrelation": 0}, "roughness": {"base": 0.9, "variation": 0.02, "map": "independent-micro-response"}, "metalness": {"base": 0, "variation": 0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "robe-fold-tone", "region": "reference-observed fold valleys", "roughness": 0.9400000000000001, "evidenceRefs": ["full-object"], "notes": "Cloth folds are geometry; front shade boundary comes from de-lit projection."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Observed anime base colour. Physical roughness is inferred, not measured photometric evidence.", "textureless": {"declared": true, "evidence": ["docs/references/user-cast/zoro.png: flat cel-colour fills, bounded linework and painted shadow regions; no observable grain/pores.", ".img2threejs/cast/zoro/material-evidence.json: pixel crop and source-classification evidence."], "limitation": "No photometric PBR recovery is claimed. Geometry carries folds, fittings and wrap diamonds."}}, options, true)
  );
  mesh_sleeve_down_9.name = "Low left sleeve";
  if (endpoint_sleeve_down_9) {
    mesh_sleeve_down_9.position.copy(endpoint_sleeve_down_9.midpoint);
    mesh_sleeve_down_9.quaternion.copy(endpoint_sleeve_down_9.quaternion);
  }
  mesh_sleeve_down_9.castShadow = options.castShadow ?? true;
  mesh_sleeve_down_9.receiveShadow = options.receiveShadow ?? true;
  mesh_sleeve_down_9.userData.sculptComponent = {"id": "sleeve-down", "name": "Low left sleeve", "level": "meso", "role": "garment", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "Low left sleeve follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "Continuous oriented capsules fitted to observed shoulder, elbow and cuff.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "sdf": {"primitives": [{"id": "bone-0", "type": "capsule", "radius": 0.075, "height": 0.32163644072150777, "transform": {"position": [0.215, 1.89, 0.0], "rotation": [0, 0, -2.9380996083322306], "scale": [1, 1, 0.9]}}, {"id": "bone-1", "type": "capsule", "radius": 0.065, "height": 0.255893044063335, "transform": {"position": [0.28, 1.6087500000000001, 0.0], "rotation": [0, 0, -2.8847662036199853], "scale": [1, 1, 0.9]}}], "operations": [{"id": "join-1", "type": "smooth-union", "left": "bone-0", "right": "bone-1", "radius": 0.02}], "bounds": {"min": [0.08249999999999999, 1.3950000000000002, -0.1], "max": [0.4025, 2.1475, 0.1]}, "resolution": 42}, "observedStations": [[353, 233, 0, 32, 32], [380, 334, 0, 30, 28], [393, 411, 0, 28, 27], [407, 468, 0, 25, 24]]}, "parent": "root", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "sleeve-down", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "robe"}}, "material": "robe", "materialLayers": ["robe"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["sleeve-down-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(66, 105, 83, 1)", "secondaryAlbedo": "rgba(59, 94, 75, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_sleeve_down_9.add(mesh_sleeve_down_9);
  meshes["sleeve-down"] = mesh_sleeve_down_9;
  colliders["sleeve-down"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["sleeve-down"] ??= [];
  destructionGroups["sleeve-down"].push(node_sleeve_down_9);

  const endpoint_forearm_down_10 = makeAttachmentEndpoint(null);
  const node_forearm_down_10 = new THREE.Group();
  node_forearm_down_10.name = "Low left forearm__pivot";
  node_forearm_down_10.scale.set(1, 1, 1);
  if (endpoint_forearm_down_10) {
    node_forearm_down_10.position.copy(endpoint_forearm_down_10.start);
    node_forearm_down_10.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_forearm_down_10.position.set(0.0, 0.0, 0.0);
    node_forearm_down_10.rotation.set(0.0, 0.0, 0.0);
  }
  node_forearm_down_10.userData.sculptComponent = {"id": "forearm-down", "name": "Low left forearm", "level": "meso", "role": "body", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "Low left forearm follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "Continuous oriented capsules fitted to observed shoulder, elbow and cuff.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "sdf": {"primitives": [{"id": "bone-0", "type": "capsule", "radius": 0.0325, "height": 0.13788582233137672, "transform": {"position": [0.35125, 1.36375, 0.0], "rotation": [0, 0, -2.750985609892106], "scale": [1, 1, 0.85]}}], "operations": [], "bounds": {"min": [0.26749999999999996, 1.2425000000000002, -0.0575], "max": [0.43500000000000005, 1.4849999999999999, 0.0575]}, "resolution": 42}, "observedStations": [[409, 464, 0.01, 18, 17], [424, 498, 0.035, 14, 14], [432, 523, 0.055, 12, 13]]}, "parent": "root", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "forearm-down", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["forearm-down-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L0", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_forearm_down_10.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "forearm-down", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["root"] ?? root).add(node_forearm_down_10);
  nodes["forearm-down"] = node_forearm_down_10;
  const mesh_forearm_down_10Geometry = polygonizeSdf({"primitives": [{"id": "bone-0", "type": "capsule", "radius": 0.0325, "height": 0.13788582233137672, "transform": {"position": [0.35125, 1.36375, 0.0], "rotation": [0, 0, -2.750985609892106], "scale": [1, 1, 0.85]}}], "operations": [], "bounds": {"min": [0.26749999999999996, 1.2425000000000002, -0.0575], "max": [0.43500000000000005, 1.4849999999999999, 0.0575]}, "resolution": 42});
  if (!endpoint_forearm_down_10) {
    mesh_forearm_down_10Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_forearm_down_10 = new THREE.Mesh(
    mesh_forearm_down_10Geometry,
    createSculptMaterial("skin", {"id": "skin", "name": "skin", "type": "physical", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#e8be8d", "color": "#e8be8d", "albedo": {"dominant": "#e8be8d", "secondary": ["#e8be8d"], "accents": []}, "colorVariation": {"palette": ["#e8be8d", "#e8be8d"], "pattern": "flat", "amplitude": 0, "heightCorrelation": 0}, "roughness": {"base": 0.62, "variation": 0.02, "map": "independent-micro-response"}, "metalness": {"base": 0, "variation": 0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "skin-fold-tone", "region": "reference-observed fold valleys", "roughness": 0.66, "evidenceRefs": ["full-object"], "notes": "Cloth folds are geometry; front shade boundary comes from de-lit projection."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Observed anime base colour. Physical roughness is inferred, not measured photometric evidence.", "textureless": {"declared": true, "evidence": ["docs/references/user-cast/zoro.png: flat cel-colour fills, bounded linework and painted shadow regions; no observable grain/pores.", ".img2threejs/cast/zoro/material-evidence.json: pixel crop and source-classification evidence."], "limitation": "No photometric PBR recovery is claimed. Geometry carries folds, fittings and wrap diamonds."}}, options, true)
  );
  mesh_forearm_down_10.name = "Low left forearm";
  if (endpoint_forearm_down_10) {
    mesh_forearm_down_10.position.copy(endpoint_forearm_down_10.midpoint);
    mesh_forearm_down_10.quaternion.copy(endpoint_forearm_down_10.quaternion);
  }
  mesh_forearm_down_10.castShadow = options.castShadow ?? true;
  mesh_forearm_down_10.receiveShadow = options.receiveShadow ?? true;
  mesh_forearm_down_10.userData.sculptComponent = {"id": "forearm-down", "name": "Low left forearm", "level": "meso", "role": "body", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "Low left forearm follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "Continuous oriented capsules fitted to observed shoulder, elbow and cuff.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "sdf": {"primitives": [{"id": "bone-0", "type": "capsule", "radius": 0.0325, "height": 0.13788582233137672, "transform": {"position": [0.35125, 1.36375, 0.0], "rotation": [0, 0, -2.750985609892106], "scale": [1, 1, 0.85]}}], "operations": [], "bounds": {"min": [0.26749999999999996, 1.2425000000000002, -0.0575], "max": [0.43500000000000005, 1.4849999999999999, 0.0575]}, "resolution": 42}, "observedStations": [[409, 464, 0.01, 18, 17], [424, 498, 0.035, 14, 14], [432, 523, 0.055, 12, 13]]}, "parent": "root", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "forearm-down", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["forearm-down-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L0", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_forearm_down_10.add(mesh_forearm_down_10);
  meshes["forearm-down"] = mesh_forearm_down_10;
  colliders["forearm-down"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["forearm-down"] ??= [];
  destructionGroups["forearm-down"].push(node_forearm_down_10);

  const endpoint_pants_left_11 = makeAttachmentEndpoint(null);
  const node_pants_left_11 = new THREE.Group();
  node_pants_left_11.name = "Left trouser cuff__pivot";
  node_pants_left_11.scale.set(1, 1, 1);
  if (endpoint_pants_left_11) {
    node_pants_left_11.position.copy(endpoint_pants_left_11.start);
    node_pants_left_11.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pants_left_11.position.set(0.0, 0.0, 0.0);
    node_pants_left_11.rotation.set(0.0, 0.0, 0.0);
  }
  node_pants_left_11.userData.sculptComponent = {"id": "pants-left", "name": "Left trouser cuff", "level": "meso", "role": "garment", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "Left trouser cuff follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "Smooth-union body/garment blockout; garment shell offset and silhouette refinement remain later pass tasks.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "sdf": {"primitives": [{"id": "section-0", "type": "ellipsoid", "center": [0.185, 0.5025, 0], "radii": [0.075, 0.07325469268244868, 0.075]}, {"id": "section-1", "type": "ellipsoid", "center": [0.2075, 0.3825, 0], "radii": [0.065, 0.10120276676059799, 0.0675]}, {"id": "section-2", "type": "ellipsoid", "center": [0.22, 0.3375, 0], "radii": [0.0475, 0.03, 0.0525]}], "operations": [{"id": "blend-1", "type": "smooth-union", "left": "section-0", "right": "section-1", "radius": 0.025}, {"id": "blend-2", "type": "smooth-union", "left": "blend-1", "right": "section-2", "radius": 0.025}], "bounds": {"min": [0.08, 0.251297233239402, -0.105], "max": [0.3025, 0.6057546926824486, 0.105]}, "resolution": 42}, "observedStations": [[354, 839, 0, 30, 30], [363, 887, 0, 26, 27], [368, 905, 0, 19, 21]]}, "parent": "root", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pants-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "boots"}}, "material": "boots", "materialLayers": ["boots"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["pants-left-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(16, 22, 20, 1)", "secondaryAlbedo": "rgba(14, 20, 18, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_pants_left_11.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pants-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "boots"}};
  (nodes["root"] ?? root).add(node_pants_left_11);
  nodes["pants-left"] = node_pants_left_11;
  const mesh_pants_left_11Geometry = polygonizeSdf({"primitives": [{"id": "section-0", "type": "ellipsoid", "center": [0.185, 0.5025, 0], "radii": [0.075, 0.07325469268244868, 0.075]}, {"id": "section-1", "type": "ellipsoid", "center": [0.2075, 0.3825, 0], "radii": [0.065, 0.10120276676059799, 0.0675]}, {"id": "section-2", "type": "ellipsoid", "center": [0.22, 0.3375, 0], "radii": [0.0475, 0.03, 0.0525]}], "operations": [{"id": "blend-1", "type": "smooth-union", "left": "section-0", "right": "section-1", "radius": 0.025}, {"id": "blend-2", "type": "smooth-union", "left": "blend-1", "right": "section-2", "radius": 0.025}], "bounds": {"min": [0.08, 0.251297233239402, -0.105], "max": [0.3025, 0.6057546926824486, 0.105]}, "resolution": 42});
  if (!endpoint_pants_left_11) {
    mesh_pants_left_11Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_pants_left_11 = new THREE.Mesh(
    mesh_pants_left_11Geometry,
    createSculptMaterial("boots", {"id": "boots", "name": "boots", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#101614", "color": "#101614", "albedo": {"dominant": "#101614", "secondary": ["#101614"], "accents": []}, "colorVariation": {"palette": ["#101614", "#101614"], "pattern": "flat", "amplitude": 0, "heightCorrelation": 0}, "roughness": {"base": 0.64, "variation": 0.02, "map": "independent-micro-response"}, "metalness": {"base": 0, "variation": 0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "boots-fold-tone", "region": "reference-observed fold valleys", "roughness": 0.68, "evidenceRefs": ["full-object"], "notes": "Cloth folds are geometry; front shade boundary comes from de-lit projection."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Observed anime base colour. Physical roughness is inferred, not measured photometric evidence.", "textureless": {"declared": true, "evidence": ["docs/references/user-cast/zoro.png: flat cel-colour fills, bounded linework and painted shadow regions; no observable grain/pores.", ".img2threejs/cast/zoro/material-evidence.json: pixel crop and source-classification evidence."], "limitation": "No photometric PBR recovery is claimed. Geometry carries folds, fittings and wrap diamonds."}}, options, true)
  );
  mesh_pants_left_11.name = "Left trouser cuff";
  if (endpoint_pants_left_11) {
    mesh_pants_left_11.position.copy(endpoint_pants_left_11.midpoint);
    mesh_pants_left_11.quaternion.copy(endpoint_pants_left_11.quaternion);
  }
  mesh_pants_left_11.castShadow = options.castShadow ?? true;
  mesh_pants_left_11.receiveShadow = options.receiveShadow ?? true;
  mesh_pants_left_11.userData.sculptComponent = {"id": "pants-left", "name": "Left trouser cuff", "level": "meso", "role": "garment", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "Left trouser cuff follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "Smooth-union body/garment blockout; garment shell offset and silhouette refinement remain later pass tasks.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "sdf": {"primitives": [{"id": "section-0", "type": "ellipsoid", "center": [0.185, 0.5025, 0], "radii": [0.075, 0.07325469268244868, 0.075]}, {"id": "section-1", "type": "ellipsoid", "center": [0.2075, 0.3825, 0], "radii": [0.065, 0.10120276676059799, 0.0675]}, {"id": "section-2", "type": "ellipsoid", "center": [0.22, 0.3375, 0], "radii": [0.0475, 0.03, 0.0525]}], "operations": [{"id": "blend-1", "type": "smooth-union", "left": "section-0", "right": "section-1", "radius": 0.025}, {"id": "blend-2", "type": "smooth-union", "left": "blend-1", "right": "section-2", "radius": 0.025}], "bounds": {"min": [0.08, 0.251297233239402, -0.105], "max": [0.3025, 0.6057546926824486, 0.105]}, "resolution": 42}, "observedStations": [[354, 839, 0, 30, 30], [363, 887, 0, 26, 27], [368, 905, 0, 19, 21]]}, "parent": "root", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pants-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "boots"}}, "material": "boots", "materialLayers": ["boots"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["pants-left-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(16, 22, 20, 1)", "secondaryAlbedo": "rgba(14, 20, 18, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_pants_left_11.add(mesh_pants_left_11);
  meshes["pants-left"] = mesh_pants_left_11;
  colliders["pants-left"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["pants-left"] ??= [];
  destructionGroups["pants-left"].push(node_pants_left_11);

  const endpoint_pants_right_12 = makeAttachmentEndpoint(null);
  const node_pants_right_12 = new THREE.Group();
  node_pants_right_12.name = "Right trouser cuff__pivot";
  node_pants_right_12.scale.set(1, 1, 1);
  if (endpoint_pants_right_12) {
    node_pants_right_12.position.copy(endpoint_pants_right_12.start);
    node_pants_right_12.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pants_right_12.position.set(0.0, 0.0, 0.0);
    node_pants_right_12.rotation.set(0.0, 0.0, 0.0);
  }
  node_pants_right_12.userData.sculptComponent = {"id": "pants-right", "name": "Right trouser cuff", "level": "meso", "role": "garment", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "Right trouser cuff follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "Smooth-union body/garment blockout; garment shell offset and silhouette refinement remain later pass tasks.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "sdf": {"primitives": [{"id": "section-0", "type": "ellipsoid", "center": [-0.26, 0.4975, 0], "radii": [0.0725, 0.06979434074479104, 0.075]}, {"id": "section-1", "type": "ellipsoid", "center": [-0.2775, 0.3825, 0], "radii": [0.0625, 0.09694457179233915, 0.0675]}, {"id": "section-2", "type": "ellipsoid", "center": [-0.2825, 0.3375, 0], "radii": [0.045, 0.03, 0.0525]}], "operations": [{"id": "blend-1", "type": "smooth-union", "left": "section-0", "right": "section-1", "radius": 0.025}, {"id": "blend-2", "type": "smooth-union", "left": "blend-1", "right": "section-2", "radius": 0.025}], "bounds": {"min": [-0.37, 0.25555542820766086, -0.105], "max": [-0.1575, 0.597294340744791, 0.105]}, "resolution": 42}, "observedStations": [[176, 841, 0, 29, 30], [169, 887, 0, 25, 27], [167, 905, 0, 18, 21]]}, "parent": "root", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pants-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "boots"}}, "material": "boots", "materialLayers": ["boots"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["pants-right-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(16, 22, 20, 1)", "secondaryAlbedo": "rgba(14, 20, 18, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_pants_right_12.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pants-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "boots"}};
  (nodes["root"] ?? root).add(node_pants_right_12);
  nodes["pants-right"] = node_pants_right_12;
  const mesh_pants_right_12Geometry = polygonizeSdf({"primitives": [{"id": "section-0", "type": "ellipsoid", "center": [-0.26, 0.4975, 0], "radii": [0.0725, 0.06979434074479104, 0.075]}, {"id": "section-1", "type": "ellipsoid", "center": [-0.2775, 0.3825, 0], "radii": [0.0625, 0.09694457179233915, 0.0675]}, {"id": "section-2", "type": "ellipsoid", "center": [-0.2825, 0.3375, 0], "radii": [0.045, 0.03, 0.0525]}], "operations": [{"id": "blend-1", "type": "smooth-union", "left": "section-0", "right": "section-1", "radius": 0.025}, {"id": "blend-2", "type": "smooth-union", "left": "blend-1", "right": "section-2", "radius": 0.025}], "bounds": {"min": [-0.37, 0.25555542820766086, -0.105], "max": [-0.1575, 0.597294340744791, 0.105]}, "resolution": 42});
  if (!endpoint_pants_right_12) {
    mesh_pants_right_12Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_pants_right_12 = new THREE.Mesh(
    mesh_pants_right_12Geometry,
    createSculptMaterial("boots", {"id": "boots", "name": "boots", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#101614", "color": "#101614", "albedo": {"dominant": "#101614", "secondary": ["#101614"], "accents": []}, "colorVariation": {"palette": ["#101614", "#101614"], "pattern": "flat", "amplitude": 0, "heightCorrelation": 0}, "roughness": {"base": 0.64, "variation": 0.02, "map": "independent-micro-response"}, "metalness": {"base": 0, "variation": 0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "boots-fold-tone", "region": "reference-observed fold valleys", "roughness": 0.68, "evidenceRefs": ["full-object"], "notes": "Cloth folds are geometry; front shade boundary comes from de-lit projection."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Observed anime base colour. Physical roughness is inferred, not measured photometric evidence.", "textureless": {"declared": true, "evidence": ["docs/references/user-cast/zoro.png: flat cel-colour fills, bounded linework and painted shadow regions; no observable grain/pores.", ".img2threejs/cast/zoro/material-evidence.json: pixel crop and source-classification evidence."], "limitation": "No photometric PBR recovery is claimed. Geometry carries folds, fittings and wrap diamonds."}}, options, true)
  );
  mesh_pants_right_12.name = "Right trouser cuff";
  if (endpoint_pants_right_12) {
    mesh_pants_right_12.position.copy(endpoint_pants_right_12.midpoint);
    mesh_pants_right_12.quaternion.copy(endpoint_pants_right_12.quaternion);
  }
  mesh_pants_right_12.castShadow = options.castShadow ?? true;
  mesh_pants_right_12.receiveShadow = options.receiveShadow ?? true;
  mesh_pants_right_12.userData.sculptComponent = {"id": "pants-right", "name": "Right trouser cuff", "level": "meso", "role": "garment", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "Right trouser cuff follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "Smooth-union body/garment blockout; garment shell offset and silhouette refinement remain later pass tasks.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "sdf": {"primitives": [{"id": "section-0", "type": "ellipsoid", "center": [-0.26, 0.4975, 0], "radii": [0.0725, 0.06979434074479104, 0.075]}, {"id": "section-1", "type": "ellipsoid", "center": [-0.2775, 0.3825, 0], "radii": [0.0625, 0.09694457179233915, 0.0675]}, {"id": "section-2", "type": "ellipsoid", "center": [-0.2825, 0.3375, 0], "radii": [0.045, 0.03, 0.0525]}], "operations": [{"id": "blend-1", "type": "smooth-union", "left": "section-0", "right": "section-1", "radius": 0.025}, {"id": "blend-2", "type": "smooth-union", "left": "blend-1", "right": "section-2", "radius": 0.025}], "bounds": {"min": [-0.37, 0.25555542820766086, -0.105], "max": [-0.1575, 0.597294340744791, 0.105]}, "resolution": 42}, "observedStations": [[176, 841, 0, 29, 30], [169, 887, 0, 25, 27], [167, 905, 0, 18, 21]]}, "parent": "root", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pants-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "boots"}}, "material": "boots", "materialLayers": ["boots"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["pants-right-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(16, 22, 20, 1)", "secondaryAlbedo": "rgba(14, 20, 18, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_pants_right_12.add(mesh_pants_right_12);
  meshes["pants-right"] = mesh_pants_right_12;
  colliders["pants-right"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["pants-right"] ??= [];
  destructionGroups["pants-right"].push(node_pants_right_12);

  const endpoint_boots_13 = makeAttachmentEndpoint(null);
  const node_boots_13 = new THREE.Group();
  node_boots_13.name = "Left boot__pivot";
  node_boots_13.scale.set(1, 1, 1);
  if (endpoint_boots_13) {
    node_boots_13.position.copy(endpoint_boots_13.start);
    node_boots_13.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_boots_13.position.set(0.0, 0.0, -0.04);
    node_boots_13.rotation.set(0.0, 0.0, 0.0);
  }
  node_boots_13.userData.sculptComponent = {"id": "boots", "name": "Left boot", "level": "macro", "role": "foot", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Closed leather boot volume with a pointed toe and a thick ankle shaft; source contour defines the stance.", "geometryDescriptor": {"profile2D": {"points": [[0.185, 0.3475], [0.275, 0.3525], [0.2925, 0.19], [0.33, 0.1275], [0.46, 0.0325], [0.48, 0.0025], [0.385, 0.0025], [0.2825, 0.0325], [0.2025, 0.0675], [0.1775, 0.1225]], "depth": 0.11}, "topologyIntent": "garment shell with observed hem and folds; depth inferred", "edgeTreatment": {"type": "none", "bevelRadius": 0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "crease-preserving vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.3025, "height": 0.35, "depth": 0.11, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, -0.04], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "boots", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "boots"}}, "material": "boots", "materialLayers": ["boots"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["boots-observed-contour", {"id": "boot-toes", "description": "Pointed dark boots angled outward from ankles", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(16, 22, 20, 1)", "secondaryAlbedo": "rgba(14, 20, 18, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_boots_13.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "boots", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "boots"}};
  (nodes["root"] ?? root).add(node_boots_13);
  nodes["boots"] = node_boots_13;
  const mesh_boots_13Geometry = endpoint_boots_13
    ? new THREE.CylinderGeometry(endpoint_boots_13.endRadius, endpoint_boots_13.baseRadius, endpoint_boots_13.length, 32, 12)
    : buildExtrudeGeometry({"points": [[0.185, 0.3475], [0.275, 0.3525], [0.2925, 0.19], [0.33, 0.1275], [0.46, 0.0325], [0.48, 0.0025], [0.385, 0.0025], [0.2825, 0.0325], [0.2025, 0.0675], [0.1775, 0.1225]], "depth": 0.11});
  if (!endpoint_boots_13) {
    mesh_boots_13Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_boots_13 = new THREE.Mesh(
    mesh_boots_13Geometry,
    materialMap["boots"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_boots_13.name = "Left boot";
  if (endpoint_boots_13) {
    mesh_boots_13.position.copy(endpoint_boots_13.midpoint);
    mesh_boots_13.quaternion.copy(endpoint_boots_13.quaternion);
  }
  mesh_boots_13.castShadow = options.castShadow ?? true;
  mesh_boots_13.receiveShadow = options.receiveShadow ?? true;
  mesh_boots_13.userData.sculptComponent = {"id": "boots", "name": "Left boot", "level": "macro", "role": "foot", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Closed leather boot volume with a pointed toe and a thick ankle shaft; source contour defines the stance.", "geometryDescriptor": {"profile2D": {"points": [[0.185, 0.3475], [0.275, 0.3525], [0.2925, 0.19], [0.33, 0.1275], [0.46, 0.0325], [0.48, 0.0025], [0.385, 0.0025], [0.2825, 0.0325], [0.2025, 0.0675], [0.1775, 0.1225]], "depth": 0.11}, "topologyIntent": "garment shell with observed hem and folds; depth inferred", "edgeTreatment": {"type": "none", "bevelRadius": 0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "crease-preserving vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.3025, "height": 0.35, "depth": 0.11, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, -0.04], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "boots", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "boots"}}, "material": "boots", "materialLayers": ["boots"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["boots-observed-contour", {"id": "boot-toes", "description": "Pointed dark boots angled outward from ankles", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(16, 22, 20, 1)", "secondaryAlbedo": "rgba(14, 20, 18, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_boots_13.add(mesh_boots_13);
  meshes["boots"] = mesh_boots_13;
  colliders["boots"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["boots"] ??= [];
  destructionGroups["boots"].push(node_boots_13);

  const endpoint_boot_right_14 = makeAttachmentEndpoint(null);
  const node_boot_right_14 = new THREE.Group();
  node_boot_right_14.name = "Right boot__pivot";
  node_boot_right_14.scale.set(1, 1, 1);
  if (endpoint_boot_right_14) {
    node_boot_right_14.position.copy(endpoint_boot_right_14.start);
    node_boot_right_14.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_boot_right_14.position.set(0.0, 0.0, -0.04);
    node_boot_right_14.rotation.set(0.0, 0.0, 0.0);
  }
  node_boot_right_14.userData.sculptComponent = {"id": "boot-right", "name": "Right boot", "level": "macro", "role": "foot", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Closed leather boot volume with a pointed toe and a thick ankle shaft; source contour defines the stance.", "geometryDescriptor": {"profile2D": {"points": [[-0.2825, 0.3525], [-0.2325, 0.35], [-0.2425, 0.1925], [-0.2525, 0.1125], [-0.285, 0.0725], [-0.4225, 0.015], [-0.5125, 0.0225], [-0.495, 0.05], [-0.4025, 0.1125], [-0.3425, 0.1875], [-0.3275, 0.3175]], "depth": 0.11}, "topologyIntent": "garment shell with observed hem and folds; depth inferred", "edgeTreatment": {"type": "none", "bevelRadius": 0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "crease-preserving vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.28, "height": 0.3375, "depth": 0.11, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, -0.04], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "boot-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "boots"}}, "material": "boots", "materialLayers": ["boots"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["boot-right-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(16, 22, 20, 1)", "secondaryAlbedo": "rgba(14, 20, 18, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_boot_right_14.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "boot-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "boots"}};
  (nodes["root"] ?? root).add(node_boot_right_14);
  nodes["boot-right"] = node_boot_right_14;
  const mesh_boot_right_14Geometry = endpoint_boot_right_14
    ? new THREE.CylinderGeometry(endpoint_boot_right_14.endRadius, endpoint_boot_right_14.baseRadius, endpoint_boot_right_14.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.2825, 0.3525], [-0.2325, 0.35], [-0.2425, 0.1925], [-0.2525, 0.1125], [-0.285, 0.0725], [-0.4225, 0.015], [-0.5125, 0.0225], [-0.495, 0.05], [-0.4025, 0.1125], [-0.3425, 0.1875], [-0.3275, 0.3175]], "depth": 0.11});
  if (!endpoint_boot_right_14) {
    mesh_boot_right_14Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_boot_right_14 = new THREE.Mesh(
    mesh_boot_right_14Geometry,
    materialMap["boots"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_boot_right_14.name = "Right boot";
  if (endpoint_boot_right_14) {
    mesh_boot_right_14.position.copy(endpoint_boot_right_14.midpoint);
    mesh_boot_right_14.quaternion.copy(endpoint_boot_right_14.quaternion);
  }
  mesh_boot_right_14.castShadow = options.castShadow ?? true;
  mesh_boot_right_14.receiveShadow = options.receiveShadow ?? true;
  mesh_boot_right_14.userData.sculptComponent = {"id": "boot-right", "name": "Right boot", "level": "macro", "role": "foot", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Closed leather boot volume with a pointed toe and a thick ankle shaft; source contour defines the stance.", "geometryDescriptor": {"profile2D": {"points": [[-0.2825, 0.3525], [-0.2325, 0.35], [-0.2425, 0.1925], [-0.2525, 0.1125], [-0.285, 0.0725], [-0.4225, 0.015], [-0.5125, 0.0225], [-0.495, 0.05], [-0.4025, 0.1125], [-0.3425, 0.1875], [-0.3275, 0.3175]], "depth": 0.11}, "topologyIntent": "garment shell with observed hem and folds; depth inferred", "edgeTreatment": {"type": "none", "bevelRadius": 0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "crease-preserving vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.28, "height": 0.3375, "depth": 0.11, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, -0.04], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "boot-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "boots"}}, "material": "boots", "materialLayers": ["boots"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["boot-right-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(16, 22, 20, 1)", "secondaryAlbedo": "rgba(14, 20, 18, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_boot_right_14.add(mesh_boot_right_14);
  meshes["boot-right"] = mesh_boot_right_14;
  colliders["boot-right"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["boot-right"] ??= [];
  destructionGroups["boot-right"].push(node_boot_right_14);

  const endpoint_sash_15 = makeAttachmentEndpoint(null);
  const node_sash_15 = new THREE.Group();
  node_sash_15.name = "Purple wrapped sash__pivot";
  node_sash_15.scale.set(1, 1, 1);
  if (endpoint_sash_15) {
    node_sash_15.position.copy(endpoint_sash_15.start);
    node_sash_15.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_sash_15.position.set(-0.0175, 0.0, 0.0);
    node_sash_15.rotation.set(0.0, 0.0, 0.0);
  }
  node_sash_15.userData.sculptComponent = {"id": "sash", "name": "Purple wrapped sash", "level": "meso", "role": "garment", "importance": 0.9, "confidence": 0.8, "primitive": "lathe", "topologyClass": "conforming-shell", "topologyRationale": "Open-ended elliptical cloth shell; outer and inner profiles form a real thickness around the body.", "geometryDescriptor": {"latheProfile": {"points": [[0.2225, 1.4025], [0.2575, 1.465], [0.275, 1.5575], [0.2625, 1.6225], [0.2475, 1.6225], [0.26, 1.5575], [0.2425, 1.465], [0.2075, 1.4025], [0.2225, 1.4025]], "segments": 64}, "topologyIntent": "hollow elliptical garment wrap, six-pixel inferred thickness", "edgeTreatment": {"type": "none", "bevelRadius": 0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.0175, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 0.58]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "sash", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "sash"}}, "material": "sash", "materialLayers": ["sash"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["sash-observed-contour", {"id": "sash-folds", "description": "Layered purple wrap with strong horizontal creases", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(126, 46, 80, 1)", "secondaryAlbedo": "rgba(113, 41, 72, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_sash_15.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "sash", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "sash"}};
  (nodes["root"] ?? root).add(node_sash_15);
  nodes["sash"] = node_sash_15;
  const mesh_sash_15Geometry = endpoint_sash_15
    ? new THREE.CylinderGeometry(endpoint_sash_15.endRadius, endpoint_sash_15.baseRadius, endpoint_sash_15.length, 32, 12)
    : buildLatheGeometry({"points": [[0.2225, 1.4025], [0.2575, 1.465], [0.275, 1.5575], [0.2625, 1.6225], [0.2475, 1.6225], [0.26, 1.5575], [0.2425, 1.465], [0.2075, 1.4025], [0.2225, 1.4025]], "segments": 64});
  if (!endpoint_sash_15) {
    mesh_sash_15Geometry.scale(1.0, 1.0, 0.58);
  }
  const mesh_sash_15 = new THREE.Mesh(
    mesh_sash_15Geometry,
    materialMap["sash"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_sash_15.name = "Purple wrapped sash";
  if (endpoint_sash_15) {
    mesh_sash_15.position.copy(endpoint_sash_15.midpoint);
    mesh_sash_15.quaternion.copy(endpoint_sash_15.quaternion);
  }
  mesh_sash_15.castShadow = options.castShadow ?? true;
  mesh_sash_15.receiveShadow = options.receiveShadow ?? true;
  mesh_sash_15.userData.sculptComponent = {"id": "sash", "name": "Purple wrapped sash", "level": "meso", "role": "garment", "importance": 0.9, "confidence": 0.8, "primitive": "lathe", "topologyClass": "conforming-shell", "topologyRationale": "Open-ended elliptical cloth shell; outer and inner profiles form a real thickness around the body.", "geometryDescriptor": {"latheProfile": {"points": [[0.2225, 1.4025], [0.2575, 1.465], [0.275, 1.5575], [0.2625, 1.6225], [0.2475, 1.6225], [0.26, 1.5575], [0.2425, 1.465], [0.2075, 1.4025], [0.2225, 1.4025]], "segments": 64}, "topologyIntent": "hollow elliptical garment wrap, six-pixel inferred thickness", "edgeTreatment": {"type": "none", "bevelRadius": 0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.0175, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 0.58]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "sash", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "sash"}}, "material": "sash", "materialLayers": ["sash"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["sash-observed-contour", {"id": "sash-folds", "description": "Layered purple wrap with strong horizontal creases", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(126, 46, 80, 1)", "secondaryAlbedo": "rgba(113, 41, 72, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_sash_15.add(mesh_sash_15);
  meshes["sash"] = mesh_sash_15;
  colliders["sash"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["sash"] ??= [];
  destructionGroups["sash"].push(node_sash_15);

  const endpoint_sash_tail_16 = makeAttachmentEndpoint(null);
  const node_sash_tail_16 = new THREE.Group();
  node_sash_tail_16.name = "Long purple sash tail__pivot";
  node_sash_tail_16.scale.set(1, 1, 1);
  if (endpoint_sash_tail_16) {
    node_sash_tail_16.position.copy(endpoint_sash_tail_16.start);
    node_sash_tail_16.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_sash_tail_16.position.set(0.0, 0.0, 0.18);
    node_sash_tail_16.rotation.set(0.0, 0.0, 0.0);
  }
  node_sash_tail_16.userData.sculptComponent = {"id": "sash-tail", "name": "Long purple sash tail", "level": "meso", "role": "garment", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "Thin fitted garment panel follows observed contour; thickness is physical fabric thickness, not a continuous body volume.", "geometryDescriptor": {"profile2D": {"points": [[0.1325, 1.6375], [0.1875, 1.65], [0.2175, 1.51], [0.29, 0.98], [0.245, 0.9375], [0.175, 0.97]], "depth": 0.012}, "topologyIntent": "garment shell with observed hem and folds; depth inferred", "edgeTreatment": {"type": "none", "bevelRadius": 0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "crease-preserving vertex normals"}, "parent": "root", "attachment": {"parentSocket": "sash-tail-root", "localStart": [0.1775, 1.64, 0.18], "localEnd": [0.1775, 1.64, 0.18], "contactType": "surface-overlap", "embedDepth": 0.025, "gapTolerance": 0.008, "evidenceRefs": ["full-object"], "notes": "Point anchor; field geometry supplies extent, not a linear attachment cylinder."}, "dimensions": {"width": 0.1575, "height": 0.7125, "depth": 0.012, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0.18], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "sash-tail", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "sash"}}, "material": "sash", "materialLayers": ["sash"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["sash-tail-observed-contour", {"id": "sash-tails", "description": "Two long purple fabric tails on left hip", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(126, 46, 80, 1)", "secondaryAlbedo": "rgba(113, 41, 72, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_sash_tail_16.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "sash-tail", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "sash"}};
  (nodes["root"] ?? root).add(node_sash_tail_16);
  nodes["sash-tail"] = node_sash_tail_16;
  const mesh_sash_tail_16Geometry = endpoint_sash_tail_16
    ? new THREE.CylinderGeometry(endpoint_sash_tail_16.endRadius, endpoint_sash_tail_16.baseRadius, endpoint_sash_tail_16.length, 32, 12)
    : buildExtrudeGeometry({"points": [[0.1325, 1.6375], [0.1875, 1.65], [0.2175, 1.51], [0.29, 0.98], [0.245, 0.9375], [0.175, 0.97]], "depth": 0.012});
  if (!endpoint_sash_tail_16) {
    mesh_sash_tail_16Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_sash_tail_16 = new THREE.Mesh(
    mesh_sash_tail_16Geometry,
    materialMap["sash"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_sash_tail_16.name = "Long purple sash tail";
  if (endpoint_sash_tail_16) {
    mesh_sash_tail_16.position.copy(endpoint_sash_tail_16.midpoint);
    mesh_sash_tail_16.quaternion.copy(endpoint_sash_tail_16.quaternion);
  }
  mesh_sash_tail_16.castShadow = options.castShadow ?? true;
  mesh_sash_tail_16.receiveShadow = options.receiveShadow ?? true;
  mesh_sash_tail_16.userData.sculptComponent = {"id": "sash-tail", "name": "Long purple sash tail", "level": "meso", "role": "garment", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "Thin fitted garment panel follows observed contour; thickness is physical fabric thickness, not a continuous body volume.", "geometryDescriptor": {"profile2D": {"points": [[0.1325, 1.6375], [0.1875, 1.65], [0.2175, 1.51], [0.29, 0.98], [0.245, 0.9375], [0.175, 0.97]], "depth": 0.012}, "topologyIntent": "garment shell with observed hem and folds; depth inferred", "edgeTreatment": {"type": "none", "bevelRadius": 0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "crease-preserving vertex normals"}, "parent": "root", "attachment": {"parentSocket": "sash-tail-root", "localStart": [0.1775, 1.64, 0.18], "localEnd": [0.1775, 1.64, 0.18], "contactType": "surface-overlap", "embedDepth": 0.025, "gapTolerance": 0.008, "evidenceRefs": ["full-object"], "notes": "Point anchor; field geometry supplies extent, not a linear attachment cylinder."}, "dimensions": {"width": 0.1575, "height": 0.7125, "depth": 0.012, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0.18], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "sash-tail", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "sash"}}, "material": "sash", "materialLayers": ["sash"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["sash-tail-observed-contour", {"id": "sash-tails", "description": "Two long purple fabric tails on left hip", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(126, 46, 80, 1)", "secondaryAlbedo": "rgba(113, 41, 72, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_sash_tail_16.add(mesh_sash_tail_16);
  meshes["sash-tail"] = mesh_sash_tail_16;
  colliders["sash-tail"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["sash-tail"] ??= [];
  destructionGroups["sash-tail"].push(node_sash_tail_16);

  const endpoint_sash_tail_back_17 = makeAttachmentEndpoint(null);
  const node_sash_tail_back_17 = new THREE.Group();
  node_sash_tail_back_17.name = "Rear purple sash tail__pivot";
  node_sash_tail_back_17.scale.set(1, 1, 1);
  if (endpoint_sash_tail_back_17) {
    node_sash_tail_back_17.position.copy(endpoint_sash_tail_back_17.start);
    node_sash_tail_back_17.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_sash_tail_back_17.position.set(0.0, 0.0, 0.13);
    node_sash_tail_back_17.rotation.set(0.0, 0.0, 0.0);
  }
  node_sash_tail_back_17.userData.sculptComponent = {"id": "sash-tail-back", "name": "Rear purple sash tail", "level": "meso", "role": "garment", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "Thin fitted garment panel follows observed contour; thickness is physical fabric thickness, not a continuous body volume.", "geometryDescriptor": {"profile2D": {"points": [[0.165, 1.63], [0.2125, 1.6325], [0.275, 1.33], [0.3525, 0.99], [0.2725, 0.975]], "depth": 0.012}, "topologyIntent": "garment shell with observed hem and folds; depth inferred", "edgeTreatment": {"type": "none", "bevelRadius": 0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "crease-preserving vertex normals"}, "parent": "root", "attachment": {"parentSocket": "sash-tail-back-root", "localStart": [0.2, 1.6275, 0.13], "localEnd": [0.2, 1.6275, 0.13], "contactType": "surface-overlap", "embedDepth": 0.025, "gapTolerance": 0.008, "evidenceRefs": ["full-object"], "notes": "Point anchor; field geometry supplies extent, not a linear attachment cylinder."}, "dimensions": {"width": 0.1875, "height": 0.6575, "depth": 0.012, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0.13], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "sash-tail-back", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "sash"}}, "material": "sash", "materialLayers": ["sash"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["sash-tail-back-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(126, 46, 80, 1)", "secondaryAlbedo": "rgba(113, 41, 72, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_sash_tail_back_17.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "sash-tail-back", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "sash"}};
  (nodes["root"] ?? root).add(node_sash_tail_back_17);
  nodes["sash-tail-back"] = node_sash_tail_back_17;
  const mesh_sash_tail_back_17Geometry = endpoint_sash_tail_back_17
    ? new THREE.CylinderGeometry(endpoint_sash_tail_back_17.endRadius, endpoint_sash_tail_back_17.baseRadius, endpoint_sash_tail_back_17.length, 32, 12)
    : buildExtrudeGeometry({"points": [[0.165, 1.63], [0.2125, 1.6325], [0.275, 1.33], [0.3525, 0.99], [0.2725, 0.975]], "depth": 0.012});
  if (!endpoint_sash_tail_back_17) {
    mesh_sash_tail_back_17Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_sash_tail_back_17 = new THREE.Mesh(
    mesh_sash_tail_back_17Geometry,
    materialMap["sash"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_sash_tail_back_17.name = "Rear purple sash tail";
  if (endpoint_sash_tail_back_17) {
    mesh_sash_tail_back_17.position.copy(endpoint_sash_tail_back_17.midpoint);
    mesh_sash_tail_back_17.quaternion.copy(endpoint_sash_tail_back_17.quaternion);
  }
  mesh_sash_tail_back_17.castShadow = options.castShadow ?? true;
  mesh_sash_tail_back_17.receiveShadow = options.receiveShadow ?? true;
  mesh_sash_tail_back_17.userData.sculptComponent = {"id": "sash-tail-back", "name": "Rear purple sash tail", "level": "meso", "role": "garment", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "Thin fitted garment panel follows observed contour; thickness is physical fabric thickness, not a continuous body volume.", "geometryDescriptor": {"profile2D": {"points": [[0.165, 1.63], [0.2125, 1.6325], [0.275, 1.33], [0.3525, 0.99], [0.2725, 0.975]], "depth": 0.012}, "topologyIntent": "garment shell with observed hem and folds; depth inferred", "edgeTreatment": {"type": "none", "bevelRadius": 0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "crease-preserving vertex normals"}, "parent": "root", "attachment": {"parentSocket": "sash-tail-back-root", "localStart": [0.2, 1.6275, 0.13], "localEnd": [0.2, 1.6275, 0.13], "contactType": "surface-overlap", "embedDepth": 0.025, "gapTolerance": 0.008, "evidenceRefs": ["full-object"], "notes": "Point anchor; field geometry supplies extent, not a linear attachment cylinder."}, "dimensions": {"width": 0.1875, "height": 0.6575, "depth": 0.012, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0.13], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "sash-tail-back", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "sash"}}, "material": "sash", "materialLayers": ["sash"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["sash-tail-back-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(126, 46, 80, 1)", "secondaryAlbedo": "rgba(113, 41, 72, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_sash_tail_back_17.add(mesh_sash_tail_back_17);
  meshes["sash-tail-back"] = mesh_sash_tail_back_17;
  colliders["sash-tail-back"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["sash-tail-back"] ??= [];
  destructionGroups["sash-tail-back"].push(node_sash_tail_back_17);

  const endpoint_armband_18 = makeAttachmentEndpoint(null);
  const node_armband_18 = new THREE.Group();
  node_armband_18.name = "Fitted upper-arm wrap__pivot";
  node_armband_18.scale.set(1, 1, 1);
  if (endpoint_armband_18) {
    node_armband_18.position.copy(endpoint_armband_18.start);
    node_armband_18.rotation.set(1.5707963267948966, 0.0, -0.15);
  } else {
    node_armband_18.position.set(0.2575, 1.84, 0.0);
    node_armband_18.rotation.set(1.5707963267948966, 0.0, -0.15);
  }
  node_armband_18.userData.sculptComponent = {"id": "armband", "name": "Fitted upper-arm wrap", "level": "meso", "role": "garment", "importance": 0.9, "confidence": 0.8, "primitive": "torus", "topologyClass": "conforming-shell", "topologyRationale": "A fitted textile band wraps the upper arm, with an elliptical opening and finite thickness.", "geometryDescriptor": {"torusTubeRatio": 0.18, "topologyIntent": "fitted upper arm band", "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": {"parentSocket": "left-upper-arm", "localStart": [0.2575, 1.84, 0], "localEnd": [0.2575, 1.84, 0], "contactType": "surface-overlap", "embedDepth": 0.02, "gapTolerance": 0.008, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.2575, 1.84, 0.0], "rotation": [1.5707963267948966, 0, -0.15], "scale": [0.17, 0.16, 0.05]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "armband", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "boots"}}, "material": "boots", "materialLayers": ["boots"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["armband-observed-contour", {"id": "armband", "description": "Black band tied on anatomical left upper arm", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(16, 22, 20, 1)", "secondaryAlbedo": "rgba(14, 20, 18, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_armband_18.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "armband", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "boots"}};
  (nodes["root"] ?? root).add(node_armband_18);
  nodes["armband"] = node_armband_18;
  const mesh_armband_18Geometry = endpoint_armband_18
    ? new THREE.CylinderGeometry(endpoint_armband_18.endRadius, endpoint_armband_18.baseRadius, endpoint_armband_18.length, 32, 12)
    : new THREE.TorusGeometry(0.45, 0.081, 24, 96);
  if (!endpoint_armband_18) {
    mesh_armband_18Geometry.scale(0.17, 0.16, 0.05);
  }
  const mesh_armband_18 = new THREE.Mesh(
    mesh_armband_18Geometry,
    materialMap["boots"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_armband_18.name = "Fitted upper-arm wrap";
  if (endpoint_armband_18) {
    mesh_armband_18.position.copy(endpoint_armband_18.midpoint);
    mesh_armband_18.quaternion.copy(endpoint_armband_18.quaternion);
  }
  mesh_armband_18.castShadow = options.castShadow ?? true;
  mesh_armband_18.receiveShadow = options.receiveShadow ?? true;
  mesh_armband_18.userData.sculptComponent = {"id": "armband", "name": "Fitted upper-arm wrap", "level": "meso", "role": "garment", "importance": 0.9, "confidence": 0.8, "primitive": "torus", "topologyClass": "conforming-shell", "topologyRationale": "A fitted textile band wraps the upper arm, with an elliptical opening and finite thickness.", "geometryDescriptor": {"torusTubeRatio": 0.18, "topologyIntent": "fitted upper arm band", "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": {"parentSocket": "left-upper-arm", "localStart": [0.2575, 1.84, 0], "localEnd": [0.2575, 1.84, 0], "contactType": "surface-overlap", "embedDepth": 0.02, "gapTolerance": 0.008, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.2575, 1.84, 0.0], "rotation": [1.5707963267948966, 0, -0.15], "scale": [0.17, 0.16, 0.05]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "armband", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "boots"}}, "material": "boots", "materialLayers": ["boots"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["armband-observed-contour", {"id": "armband", "description": "Black band tied on anatomical left upper arm", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(16, 22, 20, 1)", "secondaryAlbedo": "rgba(14, 20, 18, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_armband_18.add(mesh_armband_18);
  meshes["armband"] = mesh_armband_18;
  colliders["armband"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["armband"] ??= [];
  destructionGroups["armband"].push(node_armband_18);

  const endpoint_head_19 = makeAttachmentEndpoint(null);
  const node_head_19 = new THREE.Group();
  node_head_19.name = "Continuous head volume__pivot";
  node_head_19.scale.set(1, 1, 1);
  if (endpoint_head_19) {
    node_head_19.position.copy(endpoint_head_19.start);
    node_head_19.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_head_19.position.set(-0.015, 2.33, 0.0);
    node_head_19.rotation.set(0.0, 0.0, 0.0);
  }
  node_head_19.userData.sculptComponent = {"id": "head", "name": "Continuous head volume", "level": "macro", "role": "head", "importance": 0.9, "confidence": 0.8, "primitive": "sphere", "topologyClass": "implicit", "topologyRationale": "Continuous head volume follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "sdf": {"primitives": [{"id": "cranium", "type": "ellipsoid", "center": [0, 0.025, 0], "radii": [0.096, 0.12, 0.09]}, {"id": "jaw", "type": "ellipsoid", "center": [0, -0.068, 0.009], "radii": [0.073, 0.067, 0.071]}, {"id": "chin", "type": "ellipsoid", "center": [0, -0.113, 0.022], "radii": [0.046, 0.028, 0.048]}, {"id": "cheek-r", "type": "ellipsoid", "center": [-0.055, -0.035, 0.039], "radii": [0.038, 0.052, 0.054]}, {"id": "cheek-l", "type": "ellipsoid", "center": [0.055, -0.035, 0.039], "radii": [0.038, 0.052, 0.054]}, {"id": "nose", "type": "ellipsoid", "center": [0, -0.042, 0.091], "radii": [0.013, 0.033, 0.022]}, {"id": "eye-carve", "type": "ellipsoid", "center": [-0.046, 0.001, 0.089], "radii": [0.033, 0.018, 0.022]}], "operations": [{"id": "join1", "type": "smooth-union", "left": "cranium", "right": "jaw", "radius": 0.025}, {"id": "join2", "type": "smooth-union", "left": "join1", "right": "chin", "radius": 0.018}, {"id": "join3", "type": "smooth-union", "left": "join2", "right": "cheek-r", "radius": 0.02}, {"id": "join4", "type": "smooth-union", "left": "join3", "right": "cheek-l", "radius": 0.02}, {"id": "join5", "type": "smooth-union", "left": "join4", "right": "nose", "radius": 0.01}, {"id": "face", "type": "subtract", "left": "join5", "right": "eye-carve"}], "bounds": {"min": [-0.13, -0.15, -0.115], "max": [0.13, 0.16, 0.125]}, "resolution": 42}, "ringStack": {"rings": [[-0.142571138048172, 0.004055454301137958, 0.004409333873655389, 0.018513035693796188], [-0.13359452709928155, 0.036139295664601695, 0.0379593956158101, 0.0173390790127941], [-0.1246179161503911, 0.047957831524763544, 0.05001886070279669, 0.01632614788246644], [-0.11564130520150068, 0.05545989803581714, 0.057127962792264314, 0.014581875007853757], [-0.10666469425261021, 0.06106630809316257, 0.061817626667726805, 0.012422077298670994], [-0.09768808330371975, 0.06671779619966606, 0.06546943498849106, 0.010271715845787198], [-0.08871147235482932, 0.07281198746376828, 0.06876657502793695, 0.008846480836889308], [-0.07973486140593888, 0.07881704895821892, 0.07257230847747806, 0.008921600558563239], [-0.07075825045704842, 0.08402580419193607, 0.08234098063245904, 0.015664397995288563], [-0.061781639508157966, 0.08810472524764089, 0.08879240322226689, 0.019393098792963324], [-0.052805028559267525, 0.0908933178725883, 0.09106929679920758, 0.019009384018945343], [-0.043828417610377084, 0.09272310737822818, 0.09315089142202451, 0.018249377129087953], [-0.03485180666148663, 0.09345012902162558, 0.09445898051809404, 0.016402953317279957], [-0.025875195712596173, 0.0934984418880333, 0.095123070004385, 0.013750160243346861], [-0.016898584763705732, 0.09337571447789941, 0.09387859574813084, 0.009750843243680599], [-0.007921973814815297, 0.0935922691027162, 0.08944625029987, 0.0030307552971284013], [0.0010546371340751648, 0.0942509292609486, 0.08879494554674258, 0.0007523180206619393], [0.010031248082965627, 0.09513703484216929, 0.08930793294259994, 0.00017561341088857818], [0.01900785903185606, 0.09571509367159375, 0.08972824220870201, 1.838386827598265e-05], [0.027984469980746503, 0.09580578317926644, 0.08979517132563172, 3.666458592288535e-08], [0.03696108092963696, 0.09537321496910953, 0.08938952354135571, 5.953485616300158e-08], [0.04593769187852741, 0.0943947093388799, 0.08847031529542823, -1.0467581573053719e-07], [0.054914302827417855, 0.09285667271879315, 0.08699311614165939, -2.101223242345629e-05], [0.06389091377630829, 0.0906266255775428, 0.08502149809903072, 7.149269885765863e-05], [0.07286752472519875, 0.08787735285571535, 0.08232570234895736, -1.1081651846323037e-05], [0.08184413567408921, 0.08437587833965889, 0.07909221482110687, 9.316396540844096e-06], [0.09082074662297965, 0.08011878596323432, 0.07507450270729032, -8.988916432868532e-06], [0.09979735757187008, 0.0749766801956124, 0.07017735349238663, -2.1727398313978186e-05], [0.10877396852076054, 0.06860401679251937, 0.06424618047197614, -2.566661756252947e-05], [0.117750579469651, 0.0606793448722921, 0.056860106787717496, 6.710777537610735e-06], [0.1267271904185414, 0.05058701960162121, 0.047399256821313976, 1.5603330448310526e-05], [0.13570380136743188, 0.03659234443737833, 0.03425934636538543, 1.0741790325140277e-05], [0.14468041231632234, 0.004328900494599768, 0.0037336843414683472, -0.000247877763485099]], "source": "Triangle-plane intersections from inspect-sculpt-geometry.mjs; geometry-derived approximation for standProud."}}, "parent": "root", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.015, 2.33, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "head", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["head-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L0", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_head_19.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "head", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["root"] ?? root).add(node_head_19);
  nodes["head"] = node_head_19;
  const mesh_head_19Geometry = polygonizeSdf({"primitives": [{"id": "cranium", "type": "ellipsoid", "center": [0, 0.025, 0], "radii": [0.096, 0.12, 0.09]}, {"id": "jaw", "type": "ellipsoid", "center": [0, -0.068, 0.009], "radii": [0.073, 0.067, 0.071]}, {"id": "chin", "type": "ellipsoid", "center": [0, -0.113, 0.022], "radii": [0.046, 0.028, 0.048]}, {"id": "cheek-r", "type": "ellipsoid", "center": [-0.055, -0.035, 0.039], "radii": [0.038, 0.052, 0.054]}, {"id": "cheek-l", "type": "ellipsoid", "center": [0.055, -0.035, 0.039], "radii": [0.038, 0.052, 0.054]}, {"id": "nose", "type": "ellipsoid", "center": [0, -0.042, 0.091], "radii": [0.013, 0.033, 0.022]}, {"id": "eye-carve", "type": "ellipsoid", "center": [-0.046, 0.001, 0.089], "radii": [0.033, 0.018, 0.022]}], "operations": [{"id": "join1", "type": "smooth-union", "left": "cranium", "right": "jaw", "radius": 0.025}, {"id": "join2", "type": "smooth-union", "left": "join1", "right": "chin", "radius": 0.018}, {"id": "join3", "type": "smooth-union", "left": "join2", "right": "cheek-r", "radius": 0.02}, {"id": "join4", "type": "smooth-union", "left": "join3", "right": "cheek-l", "radius": 0.02}, {"id": "join5", "type": "smooth-union", "left": "join4", "right": "nose", "radius": 0.01}, {"id": "face", "type": "subtract", "left": "join5", "right": "eye-carve"}], "bounds": {"min": [-0.13, -0.15, -0.115], "max": [0.13, 0.16, 0.125]}, "resolution": 42});
  if (!endpoint_head_19) {
    mesh_head_19Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_head_19 = new THREE.Mesh(
    mesh_head_19Geometry,
    createSculptMaterial("skin", {"id": "skin", "name": "skin", "type": "physical", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#e8be8d", "color": "#e8be8d", "albedo": {"dominant": "#e8be8d", "secondary": ["#e8be8d"], "accents": []}, "colorVariation": {"palette": ["#e8be8d", "#e8be8d"], "pattern": "flat", "amplitude": 0, "heightCorrelation": 0}, "roughness": {"base": 0.62, "variation": 0.02, "map": "independent-micro-response"}, "metalness": {"base": 0, "variation": 0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "skin-fold-tone", "region": "reference-observed fold valleys", "roughness": 0.66, "evidenceRefs": ["full-object"], "notes": "Cloth folds are geometry; front shade boundary comes from de-lit projection."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Observed anime base colour. Physical roughness is inferred, not measured photometric evidence.", "textureless": {"declared": true, "evidence": ["docs/references/user-cast/zoro.png: flat cel-colour fills, bounded linework and painted shadow regions; no observable grain/pores.", ".img2threejs/cast/zoro/material-evidence.json: pixel crop and source-classification evidence."], "limitation": "No photometric PBR recovery is claimed. Geometry carries folds, fittings and wrap diamonds."}}, options, true)
  );
  mesh_head_19.name = "Continuous head volume";
  if (endpoint_head_19) {
    mesh_head_19.position.copy(endpoint_head_19.midpoint);
    mesh_head_19.quaternion.copy(endpoint_head_19.quaternion);
  }
  mesh_head_19.castShadow = options.castShadow ?? true;
  mesh_head_19.receiveShadow = options.receiveShadow ?? true;
  mesh_head_19.userData.sculptComponent = {"id": "head", "name": "Continuous head volume", "level": "macro", "role": "head", "importance": 0.9, "confidence": 0.8, "primitive": "sphere", "topologyClass": "implicit", "topologyRationale": "Continuous head volume follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "sdf": {"primitives": [{"id": "cranium", "type": "ellipsoid", "center": [0, 0.025, 0], "radii": [0.096, 0.12, 0.09]}, {"id": "jaw", "type": "ellipsoid", "center": [0, -0.068, 0.009], "radii": [0.073, 0.067, 0.071]}, {"id": "chin", "type": "ellipsoid", "center": [0, -0.113, 0.022], "radii": [0.046, 0.028, 0.048]}, {"id": "cheek-r", "type": "ellipsoid", "center": [-0.055, -0.035, 0.039], "radii": [0.038, 0.052, 0.054]}, {"id": "cheek-l", "type": "ellipsoid", "center": [0.055, -0.035, 0.039], "radii": [0.038, 0.052, 0.054]}, {"id": "nose", "type": "ellipsoid", "center": [0, -0.042, 0.091], "radii": [0.013, 0.033, 0.022]}, {"id": "eye-carve", "type": "ellipsoid", "center": [-0.046, 0.001, 0.089], "radii": [0.033, 0.018, 0.022]}], "operations": [{"id": "join1", "type": "smooth-union", "left": "cranium", "right": "jaw", "radius": 0.025}, {"id": "join2", "type": "smooth-union", "left": "join1", "right": "chin", "radius": 0.018}, {"id": "join3", "type": "smooth-union", "left": "join2", "right": "cheek-r", "radius": 0.02}, {"id": "join4", "type": "smooth-union", "left": "join3", "right": "cheek-l", "radius": 0.02}, {"id": "join5", "type": "smooth-union", "left": "join4", "right": "nose", "radius": 0.01}, {"id": "face", "type": "subtract", "left": "join5", "right": "eye-carve"}], "bounds": {"min": [-0.13, -0.15, -0.115], "max": [0.13, 0.16, 0.125]}, "resolution": 42}, "ringStack": {"rings": [[-0.142571138048172, 0.004055454301137958, 0.004409333873655389, 0.018513035693796188], [-0.13359452709928155, 0.036139295664601695, 0.0379593956158101, 0.0173390790127941], [-0.1246179161503911, 0.047957831524763544, 0.05001886070279669, 0.01632614788246644], [-0.11564130520150068, 0.05545989803581714, 0.057127962792264314, 0.014581875007853757], [-0.10666469425261021, 0.06106630809316257, 0.061817626667726805, 0.012422077298670994], [-0.09768808330371975, 0.06671779619966606, 0.06546943498849106, 0.010271715845787198], [-0.08871147235482932, 0.07281198746376828, 0.06876657502793695, 0.008846480836889308], [-0.07973486140593888, 0.07881704895821892, 0.07257230847747806, 0.008921600558563239], [-0.07075825045704842, 0.08402580419193607, 0.08234098063245904, 0.015664397995288563], [-0.061781639508157966, 0.08810472524764089, 0.08879240322226689, 0.019393098792963324], [-0.052805028559267525, 0.0908933178725883, 0.09106929679920758, 0.019009384018945343], [-0.043828417610377084, 0.09272310737822818, 0.09315089142202451, 0.018249377129087953], [-0.03485180666148663, 0.09345012902162558, 0.09445898051809404, 0.016402953317279957], [-0.025875195712596173, 0.0934984418880333, 0.095123070004385, 0.013750160243346861], [-0.016898584763705732, 0.09337571447789941, 0.09387859574813084, 0.009750843243680599], [-0.007921973814815297, 0.0935922691027162, 0.08944625029987, 0.0030307552971284013], [0.0010546371340751648, 0.0942509292609486, 0.08879494554674258, 0.0007523180206619393], [0.010031248082965627, 0.09513703484216929, 0.08930793294259994, 0.00017561341088857818], [0.01900785903185606, 0.09571509367159375, 0.08972824220870201, 1.838386827598265e-05], [0.027984469980746503, 0.09580578317926644, 0.08979517132563172, 3.666458592288535e-08], [0.03696108092963696, 0.09537321496910953, 0.08938952354135571, 5.953485616300158e-08], [0.04593769187852741, 0.0943947093388799, 0.08847031529542823, -1.0467581573053719e-07], [0.054914302827417855, 0.09285667271879315, 0.08699311614165939, -2.101223242345629e-05], [0.06389091377630829, 0.0906266255775428, 0.08502149809903072, 7.149269885765863e-05], [0.07286752472519875, 0.08787735285571535, 0.08232570234895736, -1.1081651846323037e-05], [0.08184413567408921, 0.08437587833965889, 0.07909221482110687, 9.316396540844096e-06], [0.09082074662297965, 0.08011878596323432, 0.07507450270729032, -8.988916432868532e-06], [0.09979735757187008, 0.0749766801956124, 0.07017735349238663, -2.1727398313978186e-05], [0.10877396852076054, 0.06860401679251937, 0.06424618047197614, -2.566661756252947e-05], [0.117750579469651, 0.0606793448722921, 0.056860106787717496, 6.710777537610735e-06], [0.1267271904185414, 0.05058701960162121, 0.047399256821313976, 1.5603330448310526e-05], [0.13570380136743188, 0.03659234443737833, 0.03425934636538543, 1.0741790325140277e-05], [0.14468041231632234, 0.004328900494599768, 0.0037336843414683472, -0.000247877763485099]], "source": "Triangle-plane intersections from inspect-sculpt-geometry.mjs; geometry-derived approximation for standProud."}}, "parent": "root", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.015, 2.33, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "head", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["head-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L0", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_head_19.add(mesh_head_19);
  meshes["head"] = mesh_head_19;
  colliders["head"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["head"] ??= [];
  destructionGroups["head"].push(node_head_19);

  const endpoint_hair_20 = makeAttachmentEndpoint(null);
  const node_hair_20 = new THREE.Group();
  node_hair_20.name = "Short green scalp crown__pivot";
  node_hair_20.scale.set(1, 1, 1);
  if (endpoint_hair_20) {
    node_hair_20.position.copy(endpoint_hair_20.start);
    node_hair_20.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hair_20.position.set(0.0, 0.0, 0.0);
    node_hair_20.rotation.set(0.0, 0.0, 0.0);
  }
  node_hair_20.userData.sculptComponent = {"id": "hair", "name": "Short green scalp crown", "level": "meso", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "Finite scalp shell is cut from an outer crown by subtracting a slightly expanded cranium; roots overlap the shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "sdf": {"primitives": [{"id": "outer", "type": "ellipsoid", "center": [0, 0.074, -0.006], "radii": [0.1175, 0.083, 0.109]}, {"id": "inner", "type": "ellipsoid", "center": [0, 0.025, 0], "radii": [0.099, 0.123, 0.093]}, {"id": "crown-crop", "type": "box", "center": [0, 0.15, 0], "size": [0.3, 0.18, 0.3]}], "operations": [{"id": "shell", "type": "subtract", "left": "outer", "right": "inner"}, {"id": "crop", "type": "intersect", "left": "shell", "right": "crown-crop"}], "bounds": {"min": [-0.13, 0.055, -0.13], "max": [0.13, 0.165, 0.13]}, "resolution": 50}}, "parent": "head", "attachment": null, "dimensions": {"width": 0.235, "height": 0.153, "depth": 0.218, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-observed-contour", {"id": "hair-tips", "description": "Irregular short green triangular crown tips", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.004, "maxPush": 0.015}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.5, "v": 0.3}}};
  node_hair_20.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}};
  (nodes["head"] ?? root).add(node_hair_20);
  nodes["hair"] = node_hair_20;
  const mesh_hair_20Geometry = polygonizeSdf({"primitives": [{"id": "outer", "type": "ellipsoid", "center": [0, 0.074, -0.006], "radii": [0.1175, 0.083, 0.109]}, {"id": "inner", "type": "ellipsoid", "center": [0, 0.025, 0], "radii": [0.099, 0.123, 0.093]}, {"id": "crown-crop", "type": "box", "center": [0, 0.15, 0], "size": [0.3, 0.18, 0.3]}], "operations": [{"id": "shell", "type": "subtract", "left": "outer", "right": "inner"}, {"id": "crop", "type": "intersect", "left": "shell", "right": "crown-crop"}], "bounds": {"min": [-0.13, 0.055, -0.13], "max": [0.13, 0.165, 0.13]}, "resolution": 50});
  if (!endpoint_hair_20) {
    mesh_hair_20Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hair_20 = new THREE.Mesh(
    mesh_hair_20Geometry,
    createSculptMaterial("hair", {"id": "hair", "name": "hair", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#7bc28d", "color": "#7bc28d", "albedo": {"dominant": "#7bc28d", "secondary": ["#7bc28d"], "accents": []}, "colorVariation": {"palette": ["#7bc28d", "#7bc28d"], "pattern": "flat", "amplitude": 0, "heightCorrelation": 0}, "roughness": {"base": 0.67, "variation": 0.02, "map": "independent-micro-response"}, "metalness": {"base": 0, "variation": 0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "hair-fold-tone", "region": "reference-observed fold valleys", "roughness": 0.7100000000000001, "evidenceRefs": ["full-object"], "notes": "Cloth folds are geometry; front shade boundary comes from de-lit projection."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Observed anime base colour. Physical roughness is inferred, not measured photometric evidence.", "textureless": {"declared": true, "evidence": ["docs/references/user-cast/zoro.png: flat cel-colour fills, bounded linework and painted shadow regions; no observable grain/pores.", ".img2threejs/cast/zoro/material-evidence.json: pixel crop and source-classification evidence."], "limitation": "No photometric PBR recovery is claimed. Geometry carries folds, fittings and wrap diamonds."}}, options, true)
  );
  mesh_hair_20.name = "Short green scalp crown";
  if (endpoint_hair_20) {
    mesh_hair_20.position.copy(endpoint_hair_20.midpoint);
    mesh_hair_20.quaternion.copy(endpoint_hair_20.quaternion);
  }
  mesh_hair_20.castShadow = options.castShadow ?? true;
  mesh_hair_20.receiveShadow = options.receiveShadow ?? true;
  mesh_hair_20.userData.sculptComponent = {"id": "hair", "name": "Short green scalp crown", "level": "meso", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "Finite scalp shell is cut from an outer crown by subtracting a slightly expanded cranium; roots overlap the shell.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "sdf": {"primitives": [{"id": "outer", "type": "ellipsoid", "center": [0, 0.074, -0.006], "radii": [0.1175, 0.083, 0.109]}, {"id": "inner", "type": "ellipsoid", "center": [0, 0.025, 0], "radii": [0.099, 0.123, 0.093]}, {"id": "crown-crop", "type": "box", "center": [0, 0.15, 0], "size": [0.3, 0.18, 0.3]}], "operations": [{"id": "shell", "type": "subtract", "left": "outer", "right": "inner"}, {"id": "crop", "type": "intersect", "left": "shell", "right": "crown-crop"}], "bounds": {"min": [-0.13, 0.055, -0.13], "max": [0.13, 0.165, 0.13]}, "resolution": 50}}, "parent": "head", "attachment": null, "dimensions": {"width": 0.235, "height": 0.153, "depth": 0.218, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-observed-contour", {"id": "hair-tips", "description": "Irregular short green triangular crown tips", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.004, "maxPush": 0.015}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.5, "v": 0.3}}};
  node_hair_20.add(mesh_hair_20);
  meshes["hair"] = mesh_hair_20;
  colliders["hair"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hair"] ??= [];
  destructionGroups["hair"].push(node_hair_20);

  const endpoint_hair_tip_0_21 = makeAttachmentEndpoint(null);
  const node_hair_tip_0_21 = new THREE.Group();
  node_hair_tip_0_21.name = "Scalp-attached tapered crown lock__pivot";
  node_hair_tip_0_21.scale.set(1, 1, 1);
  if (endpoint_hair_tip_0_21) {
    node_hair_tip_0_21.position.copy(endpoint_hair_tip_0_21.start);
    node_hair_tip_0_21.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hair_tip_0_21.position.set(0.0, 0.0, 0.0);
    node_hair_tip_0_21.rotation.set(0.0, 0.0, 0.0);
  }
  node_hair_tip_0_21.userData.sculptComponent = {"id": "hair-tip-0", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.08, 0.072, 0.0], "rx": 0.022, "rz": 0.015}, {"position": [0.106, 0.108, 0.0], "rx": 0.016, "rz": 0.011}, {"position": [0.122, 0.13, 0.0], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-0", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-0-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.0, "v": 0.35}}};
  node_hair_tip_0_21.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-0", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}};
  (nodes["head"] ?? root).add(node_hair_tip_0_21);
  nodes["hair-tip-0"] = node_hair_tip_0_21;
  const mesh_hair_tip_0_21Geometry = endpoint_hair_tip_0_21
    ? new THREE.CylinderGeometry(endpoint_hair_tip_0_21.endRadius, endpoint_hair_tip_0_21.baseRadius, endpoint_hair_tip_0_21.length, 32, 12)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.08, 0.072, 0.0], "rx": 0.022, "rz": 0.015}, {"position": [0.106, 0.108, 0.0], "rx": 0.016, "rz": 0.011}, {"position": [0.122, 0.13, 0.0], "rx": 0, "rz": 0}], "radialSegments": 6});
  if (!endpoint_hair_tip_0_21) {
    mesh_hair_tip_0_21Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hair_tip_0_21 = new THREE.Mesh(
    mesh_hair_tip_0_21Geometry,
    materialMap["hair"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hair_tip_0_21.name = "Scalp-attached tapered crown lock";
  if (endpoint_hair_tip_0_21) {
    mesh_hair_tip_0_21.position.copy(endpoint_hair_tip_0_21.midpoint);
    mesh_hair_tip_0_21.quaternion.copy(endpoint_hair_tip_0_21.quaternion);
  }
  mesh_hair_tip_0_21.castShadow = options.castShadow ?? true;
  mesh_hair_tip_0_21.receiveShadow = options.receiveShadow ?? true;
  mesh_hair_tip_0_21.userData.sculptComponent = {"id": "hair-tip-0", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.08, 0.072, 0.0], "rx": 0.022, "rz": 0.015}, {"position": [0.106, 0.108, 0.0], "rx": 0.016, "rz": 0.011}, {"position": [0.122, 0.13, 0.0], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-0", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-0-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.0, "v": 0.35}}};
  node_hair_tip_0_21.add(mesh_hair_tip_0_21);
  meshes["hair-tip-0"] = mesh_hair_tip_0_21;
  colliders["hair-tip-0"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hair-tip-0"] ??= [];
  destructionGroups["hair-tip-0"].push(node_hair_tip_0_21);

  const endpoint_hair_tip_1_22 = makeAttachmentEndpoint(null);
  const node_hair_tip_1_22 = new THREE.Group();
  node_hair_tip_1_22.name = "Scalp-attached tapered crown lock__pivot";
  node_hair_tip_1_22.scale.set(1, 1, 1);
  if (endpoint_hair_tip_1_22) {
    node_hair_tip_1_22.position.copy(endpoint_hair_tip_1_22.start);
    node_hair_tip_1_22.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hair_tip_1_22.position.set(0.0, 0.0, 0.0);
    node_hair_tip_1_22.rotation.set(0.0, 0.0, 0.0);
  }
  node_hair_tip_1_22.userData.sculptComponent = {"id": "hair-tip-1", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.07517540966287267, 0.072, 0.022915349602819806], "rx": 0.022, "rz": 0.015}, {"position": [0.09960741780330629, 0.11599999999999999, 0.029755752469333176], "rx": 0.016, "rz": 0.011}, {"position": [0.11464249973588082, 0.139, 0.03454403447589254], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-1-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.05555555555555555, "v": 0.35}}};
  node_hair_tip_1_22.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}};
  (nodes["head"] ?? root).add(node_hair_tip_1_22);
  nodes["hair-tip-1"] = node_hair_tip_1_22;
  const mesh_hair_tip_1_22Geometry = endpoint_hair_tip_1_22
    ? new THREE.CylinderGeometry(endpoint_hair_tip_1_22.endRadius, endpoint_hair_tip_1_22.baseRadius, endpoint_hair_tip_1_22.length, 32, 12)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.07517540966287267, 0.072, 0.022915349602819806], "rx": 0.022, "rz": 0.015}, {"position": [0.09960741780330629, 0.11599999999999999, 0.029755752469333176], "rx": 0.016, "rz": 0.011}, {"position": [0.11464249973588082, 0.139, 0.03454403447589254], "rx": 0, "rz": 0}], "radialSegments": 6});
  if (!endpoint_hair_tip_1_22) {
    mesh_hair_tip_1_22Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hair_tip_1_22 = new THREE.Mesh(
    mesh_hair_tip_1_22Geometry,
    materialMap["hair"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hair_tip_1_22.name = "Scalp-attached tapered crown lock";
  if (endpoint_hair_tip_1_22) {
    mesh_hair_tip_1_22.position.copy(endpoint_hair_tip_1_22.midpoint);
    mesh_hair_tip_1_22.quaternion.copy(endpoint_hair_tip_1_22.quaternion);
  }
  mesh_hair_tip_1_22.castShadow = options.castShadow ?? true;
  mesh_hair_tip_1_22.receiveShadow = options.receiveShadow ?? true;
  mesh_hair_tip_1_22.userData.sculptComponent = {"id": "hair-tip-1", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.07517540966287267, 0.072, 0.022915349602819806], "rx": 0.022, "rz": 0.015}, {"position": [0.09960741780330629, 0.11599999999999999, 0.029755752469333176], "rx": 0.016, "rz": 0.011}, {"position": [0.11464249973588082, 0.139, 0.03454403447589254], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-1-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.05555555555555555, "v": 0.35}}};
  node_hair_tip_1_22.add(mesh_hair_tip_1_22);
  meshes["hair-tip-1"] = mesh_hair_tip_1_22;
  colliders["hair-tip-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hair-tip-1"] ??= [];
  destructionGroups["hair-tip-1"].push(node_hair_tip_1_22);

  const endpoint_hair_tip_2_23 = makeAttachmentEndpoint(null);
  const node_hair_tip_2_23 = new THREE.Group();
  node_hair_tip_2_23.name = "Scalp-attached tapered crown lock__pivot";
  node_hair_tip_2_23.scale.set(1, 1, 1);
  if (endpoint_hair_tip_2_23) {
    node_hair_tip_2_23.position.copy(endpoint_hair_tip_2_23.start);
    node_hair_tip_2_23.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hair_tip_2_23.position.set(0.0, 0.0, 0.0);
    node_hair_tip_2_23.rotation.set(0.0, 0.0, 0.0);
  }
  node_hair_tip_2_23.userData.sculptComponent = {"id": "hair-tip-2", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.061283555449518246, 0.072, 0.043066769848998133], "rx": 0.022, "rz": 0.015}, {"position": [0.08120071097061167, 0.124, 0.05592252204272891], "rx": 0.016, "rz": 0.011}, {"position": [0.09345742206051531, 0.148, 0.06492154857834047], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-2-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.1111111111111111, "v": 0.35}}};
  node_hair_tip_2_23.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}};
  (nodes["head"] ?? root).add(node_hair_tip_2_23);
  nodes["hair-tip-2"] = node_hair_tip_2_23;
  const mesh_hair_tip_2_23Geometry = endpoint_hair_tip_2_23
    ? new THREE.CylinderGeometry(endpoint_hair_tip_2_23.endRadius, endpoint_hair_tip_2_23.baseRadius, endpoint_hair_tip_2_23.length, 32, 12)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.061283555449518246, 0.072, 0.043066769848998133], "rx": 0.022, "rz": 0.015}, {"position": [0.08120071097061167, 0.124, 0.05592252204272891], "rx": 0.016, "rz": 0.011}, {"position": [0.09345742206051531, 0.148, 0.06492154857834047], "rx": 0, "rz": 0}], "radialSegments": 6});
  if (!endpoint_hair_tip_2_23) {
    mesh_hair_tip_2_23Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hair_tip_2_23 = new THREE.Mesh(
    mesh_hair_tip_2_23Geometry,
    materialMap["hair"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hair_tip_2_23.name = "Scalp-attached tapered crown lock";
  if (endpoint_hair_tip_2_23) {
    mesh_hair_tip_2_23.position.copy(endpoint_hair_tip_2_23.midpoint);
    mesh_hair_tip_2_23.quaternion.copy(endpoint_hair_tip_2_23.quaternion);
  }
  mesh_hair_tip_2_23.castShadow = options.castShadow ?? true;
  mesh_hair_tip_2_23.receiveShadow = options.receiveShadow ?? true;
  mesh_hair_tip_2_23.userData.sculptComponent = {"id": "hair-tip-2", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.061283555449518246, 0.072, 0.043066769848998133], "rx": 0.022, "rz": 0.015}, {"position": [0.08120071097061167, 0.124, 0.05592252204272891], "rx": 0.016, "rz": 0.011}, {"position": [0.09345742206051531, 0.148, 0.06492154857834047], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-2-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.1111111111111111, "v": 0.35}}};
  node_hair_tip_2_23.add(mesh_hair_tip_2_23);
  meshes["hair-tip-2"] = mesh_hair_tip_2_23;
  colliders["hair-tip-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hair-tip-2"] ??= [];
  destructionGroups["hair-tip-2"].push(node_hair_tip_2_23);

  const endpoint_hair_tip_3_24 = makeAttachmentEndpoint(null);
  const node_hair_tip_3_24 = new THREE.Group();
  node_hair_tip_3_24.name = "Scalp-attached tapered crown lock__pivot";
  node_hair_tip_3_24.scale.set(1, 1, 1);
  if (endpoint_hair_tip_3_24) {
    node_hair_tip_3_24.position.copy(endpoint_hair_tip_3_24.start);
    node_hair_tip_3_24.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hair_tip_3_24.position.set(0.0, 0.0, 0.0);
    node_hair_tip_3_24.rotation.set(0.0, 0.0, 0.0);
  }
  node_hair_tip_3_24.userData.sculptComponent = {"id": "hair-tip-3", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.04000000000000001, 0.072, 0.05802370205355739], "rx": 0.022, "rz": 0.015}, {"position": [0.05300000000000001, 0.108, 0.07534421012924615], "rx": 0.016, "rz": 0.011}, {"position": [0.06100000000000001, 0.13, 0.08746856578222831], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-3-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.16666666666666666, "v": 0.35}}};
  node_hair_tip_3_24.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}};
  (nodes["head"] ?? root).add(node_hair_tip_3_24);
  nodes["hair-tip-3"] = node_hair_tip_3_24;
  const mesh_hair_tip_3_24Geometry = endpoint_hair_tip_3_24
    ? new THREE.CylinderGeometry(endpoint_hair_tip_3_24.endRadius, endpoint_hair_tip_3_24.baseRadius, endpoint_hair_tip_3_24.length, 32, 12)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.04000000000000001, 0.072, 0.05802370205355739], "rx": 0.022, "rz": 0.015}, {"position": [0.05300000000000001, 0.108, 0.07534421012924615], "rx": 0.016, "rz": 0.011}, {"position": [0.06100000000000001, 0.13, 0.08746856578222831], "rx": 0, "rz": 0}], "radialSegments": 6});
  if (!endpoint_hair_tip_3_24) {
    mesh_hair_tip_3_24Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hair_tip_3_24 = new THREE.Mesh(
    mesh_hair_tip_3_24Geometry,
    materialMap["hair"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hair_tip_3_24.name = "Scalp-attached tapered crown lock";
  if (endpoint_hair_tip_3_24) {
    mesh_hair_tip_3_24.position.copy(endpoint_hair_tip_3_24.midpoint);
    mesh_hair_tip_3_24.quaternion.copy(endpoint_hair_tip_3_24.quaternion);
  }
  mesh_hair_tip_3_24.castShadow = options.castShadow ?? true;
  mesh_hair_tip_3_24.receiveShadow = options.receiveShadow ?? true;
  mesh_hair_tip_3_24.userData.sculptComponent = {"id": "hair-tip-3", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.04000000000000001, 0.072, 0.05802370205355739], "rx": 0.022, "rz": 0.015}, {"position": [0.05300000000000001, 0.108, 0.07534421012924615], "rx": 0.016, "rz": 0.011}, {"position": [0.06100000000000001, 0.13, 0.08746856578222831], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-3-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.16666666666666666, "v": 0.35}}};
  node_hair_tip_3_24.add(mesh_hair_tip_3_24);
  meshes["hair-tip-3"] = mesh_hair_tip_3_24;
  colliders["hair-tip-3"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hair-tip-3"] ??= [];
  destructionGroups["hair-tip-3"].push(node_hair_tip_3_24);

  const endpoint_hair_tip_4_25 = makeAttachmentEndpoint(null);
  const node_hair_tip_4_25 = new THREE.Group();
  node_hair_tip_4_25.name = "Scalp-attached tapered crown lock__pivot";
  node_hair_tip_4_25.scale.set(1, 1, 1);
  if (endpoint_hair_tip_4_25) {
    node_hair_tip_4_25.position.copy(endpoint_hair_tip_4_25.start);
    node_hair_tip_4_25.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hair_tip_4_25.position.set(0.0, 0.0, 0.0);
    node_hair_tip_4_25.rotation.set(0.0, 0.0, 0.0);
  }
  node_hair_tip_4_25.userData.sculptComponent = {"id": "hair-tip-4", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.013891854213354433, 0.072, 0.06598211945181794], "rx": 0.022, "rz": 0.015}, {"position": [0.018406706832694623, 0.11599999999999999, 0.08567827451206209], "rx": 0.016, "rz": 0.011}, {"position": [0.02118507767536551, 0.139, 0.09946558305423302], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-4-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.2222222222222222, "v": 0.35}}};
  node_hair_tip_4_25.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}};
  (nodes["head"] ?? root).add(node_hair_tip_4_25);
  nodes["hair-tip-4"] = node_hair_tip_4_25;
  const mesh_hair_tip_4_25Geometry = endpoint_hair_tip_4_25
    ? new THREE.CylinderGeometry(endpoint_hair_tip_4_25.endRadius, endpoint_hair_tip_4_25.baseRadius, endpoint_hair_tip_4_25.length, 32, 12)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.013891854213354433, 0.072, 0.06598211945181794], "rx": 0.022, "rz": 0.015}, {"position": [0.018406706832694623, 0.11599999999999999, 0.08567827451206209], "rx": 0.016, "rz": 0.011}, {"position": [0.02118507767536551, 0.139, 0.09946558305423302], "rx": 0, "rz": 0}], "radialSegments": 6});
  if (!endpoint_hair_tip_4_25) {
    mesh_hair_tip_4_25Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hair_tip_4_25 = new THREE.Mesh(
    mesh_hair_tip_4_25Geometry,
    materialMap["hair"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hair_tip_4_25.name = "Scalp-attached tapered crown lock";
  if (endpoint_hair_tip_4_25) {
    mesh_hair_tip_4_25.position.copy(endpoint_hair_tip_4_25.midpoint);
    mesh_hair_tip_4_25.quaternion.copy(endpoint_hair_tip_4_25.quaternion);
  }
  mesh_hair_tip_4_25.castShadow = options.castShadow ?? true;
  mesh_hair_tip_4_25.receiveShadow = options.receiveShadow ?? true;
  mesh_hair_tip_4_25.userData.sculptComponent = {"id": "hair-tip-4", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.013891854213354433, 0.072, 0.06598211945181794], "rx": 0.022, "rz": 0.015}, {"position": [0.018406706832694623, 0.11599999999999999, 0.08567827451206209], "rx": 0.016, "rz": 0.011}, {"position": [0.02118507767536551, 0.139, 0.09946558305423302], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-4-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.2222222222222222, "v": 0.35}}};
  node_hair_tip_4_25.add(mesh_hair_tip_4_25);
  meshes["hair-tip-4"] = mesh_hair_tip_4_25;
  colliders["hair-tip-4"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hair-tip-4"] ??= [];
  destructionGroups["hair-tip-4"].push(node_hair_tip_4_25);

  const endpoint_hair_tip_5_26 = makeAttachmentEndpoint(null);
  const node_hair_tip_5_26 = new THREE.Group();
  node_hair_tip_5_26.name = "Scalp-attached tapered crown lock__pivot";
  node_hair_tip_5_26.scale.set(1, 1, 1);
  if (endpoint_hair_tip_5_26) {
    node_hair_tip_5_26.position.copy(endpoint_hair_tip_5_26.start);
    node_hair_tip_5_26.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hair_tip_5_26.position.set(0.0, 0.0, 0.0);
    node_hair_tip_5_26.rotation.set(0.0, 0.0, 0.0);
  }
  node_hair_tip_5_26.userData.sculptComponent = {"id": "hair-tip-5", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.013891854213354425, 0.072, 0.06598211945181794], "rx": 0.022, "rz": 0.015}, {"position": [-0.018406706832694613, 0.124, 0.08567827451206209], "rx": 0.016, "rz": 0.011}, {"position": [-0.021185077675365496, 0.148, 0.09946558305423302], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-5-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.2777777777777778, "v": 0.35}}};
  node_hair_tip_5_26.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}};
  (nodes["head"] ?? root).add(node_hair_tip_5_26);
  nodes["hair-tip-5"] = node_hair_tip_5_26;
  const mesh_hair_tip_5_26Geometry = endpoint_hair_tip_5_26
    ? new THREE.CylinderGeometry(endpoint_hair_tip_5_26.endRadius, endpoint_hair_tip_5_26.baseRadius, endpoint_hair_tip_5_26.length, 32, 12)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.013891854213354425, 0.072, 0.06598211945181794], "rx": 0.022, "rz": 0.015}, {"position": [-0.018406706832694613, 0.124, 0.08567827451206209], "rx": 0.016, "rz": 0.011}, {"position": [-0.021185077675365496, 0.148, 0.09946558305423302], "rx": 0, "rz": 0}], "radialSegments": 6});
  if (!endpoint_hair_tip_5_26) {
    mesh_hair_tip_5_26Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hair_tip_5_26 = new THREE.Mesh(
    mesh_hair_tip_5_26Geometry,
    materialMap["hair"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hair_tip_5_26.name = "Scalp-attached tapered crown lock";
  if (endpoint_hair_tip_5_26) {
    mesh_hair_tip_5_26.position.copy(endpoint_hair_tip_5_26.midpoint);
    mesh_hair_tip_5_26.quaternion.copy(endpoint_hair_tip_5_26.quaternion);
  }
  mesh_hair_tip_5_26.castShadow = options.castShadow ?? true;
  mesh_hair_tip_5_26.receiveShadow = options.receiveShadow ?? true;
  mesh_hair_tip_5_26.userData.sculptComponent = {"id": "hair-tip-5", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.013891854213354425, 0.072, 0.06598211945181794], "rx": 0.022, "rz": 0.015}, {"position": [-0.018406706832694613, 0.124, 0.08567827451206209], "rx": 0.016, "rz": 0.011}, {"position": [-0.021185077675365496, 0.148, 0.09946558305423302], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-5-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.2777777777777778, "v": 0.35}}};
  node_hair_tip_5_26.add(mesh_hair_tip_5_26);
  meshes["hair-tip-5"] = mesh_hair_tip_5_26;
  colliders["hair-tip-5"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hair-tip-5"] ??= [];
  destructionGroups["hair-tip-5"].push(node_hair_tip_5_26);

  const endpoint_hair_tip_6_27 = makeAttachmentEndpoint(null);
  const node_hair_tip_6_27 = new THREE.Group();
  node_hair_tip_6_27.name = "Scalp-attached tapered crown lock__pivot";
  node_hair_tip_6_27.scale.set(1, 1, 1);
  if (endpoint_hair_tip_6_27) {
    node_hair_tip_6_27.position.copy(endpoint_hair_tip_6_27.start);
    node_hair_tip_6_27.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hair_tip_6_27.position.set(0.0, 0.0, 0.0);
    node_hair_tip_6_27.rotation.set(0.0, 0.0, 0.0);
  }
  node_hair_tip_6_27.userData.sculptComponent = {"id": "hair-tip-6", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.03999999999999998, 0.072, 0.0580237020535574], "rx": 0.022, "rz": 0.015}, {"position": [-0.05299999999999998, 0.108, 0.07534421012924616], "rx": 0.016, "rz": 0.011}, {"position": [-0.06099999999999997, 0.13, 0.08746856578222832], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-6", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-6-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.3333333333333333, "v": 0.35}}};
  node_hair_tip_6_27.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-6", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}};
  (nodes["head"] ?? root).add(node_hair_tip_6_27);
  nodes["hair-tip-6"] = node_hair_tip_6_27;
  const mesh_hair_tip_6_27Geometry = endpoint_hair_tip_6_27
    ? new THREE.CylinderGeometry(endpoint_hair_tip_6_27.endRadius, endpoint_hair_tip_6_27.baseRadius, endpoint_hair_tip_6_27.length, 32, 12)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.03999999999999998, 0.072, 0.0580237020535574], "rx": 0.022, "rz": 0.015}, {"position": [-0.05299999999999998, 0.108, 0.07534421012924616], "rx": 0.016, "rz": 0.011}, {"position": [-0.06099999999999997, 0.13, 0.08746856578222832], "rx": 0, "rz": 0}], "radialSegments": 6});
  if (!endpoint_hair_tip_6_27) {
    mesh_hair_tip_6_27Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hair_tip_6_27 = new THREE.Mesh(
    mesh_hair_tip_6_27Geometry,
    materialMap["hair"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hair_tip_6_27.name = "Scalp-attached tapered crown lock";
  if (endpoint_hair_tip_6_27) {
    mesh_hair_tip_6_27.position.copy(endpoint_hair_tip_6_27.midpoint);
    mesh_hair_tip_6_27.quaternion.copy(endpoint_hair_tip_6_27.quaternion);
  }
  mesh_hair_tip_6_27.castShadow = options.castShadow ?? true;
  mesh_hair_tip_6_27.receiveShadow = options.receiveShadow ?? true;
  mesh_hair_tip_6_27.userData.sculptComponent = {"id": "hair-tip-6", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.03999999999999998, 0.072, 0.0580237020535574], "rx": 0.022, "rz": 0.015}, {"position": [-0.05299999999999998, 0.108, 0.07534421012924616], "rx": 0.016, "rz": 0.011}, {"position": [-0.06099999999999997, 0.13, 0.08746856578222832], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-6", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-6-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.3333333333333333, "v": 0.35}}};
  node_hair_tip_6_27.add(mesh_hair_tip_6_27);
  meshes["hair-tip-6"] = mesh_hair_tip_6_27;
  colliders["hair-tip-6"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hair-tip-6"] ??= [];
  destructionGroups["hair-tip-6"].push(node_hair_tip_6_27);

  const endpoint_hair_tip_7_28 = makeAttachmentEndpoint(null);
  const node_hair_tip_7_28 = new THREE.Group();
  node_hair_tip_7_28.name = "Scalp-attached tapered crown lock__pivot";
  node_hair_tip_7_28.scale.set(1, 1, 1);
  if (endpoint_hair_tip_7_28) {
    node_hair_tip_7_28.position.copy(endpoint_hair_tip_7_28.start);
    node_hair_tip_7_28.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hair_tip_7_28.position.set(0.0, 0.0, 0.0);
    node_hair_tip_7_28.rotation.set(0.0, 0.0, 0.0);
  }
  node_hair_tip_7_28.userData.sculptComponent = {"id": "hair-tip-7", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.06128355544951823, 0.072, 0.04306676984899815], "rx": 0.022, "rz": 0.015}, {"position": [-0.08120071097061166, 0.11599999999999999, 0.055922522042728934], "rx": 0.016, "rz": 0.011}, {"position": [-0.0934574220605153, 0.139, 0.0649215485783405], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-7", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-7-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.3888888888888889, "v": 0.35}}};
  node_hair_tip_7_28.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-7", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}};
  (nodes["head"] ?? root).add(node_hair_tip_7_28);
  nodes["hair-tip-7"] = node_hair_tip_7_28;
  const mesh_hair_tip_7_28Geometry = endpoint_hair_tip_7_28
    ? new THREE.CylinderGeometry(endpoint_hair_tip_7_28.endRadius, endpoint_hair_tip_7_28.baseRadius, endpoint_hair_tip_7_28.length, 32, 12)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.06128355544951823, 0.072, 0.04306676984899815], "rx": 0.022, "rz": 0.015}, {"position": [-0.08120071097061166, 0.11599999999999999, 0.055922522042728934], "rx": 0.016, "rz": 0.011}, {"position": [-0.0934574220605153, 0.139, 0.0649215485783405], "rx": 0, "rz": 0}], "radialSegments": 6});
  if (!endpoint_hair_tip_7_28) {
    mesh_hair_tip_7_28Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hair_tip_7_28 = new THREE.Mesh(
    mesh_hair_tip_7_28Geometry,
    materialMap["hair"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hair_tip_7_28.name = "Scalp-attached tapered crown lock";
  if (endpoint_hair_tip_7_28) {
    mesh_hair_tip_7_28.position.copy(endpoint_hair_tip_7_28.midpoint);
    mesh_hair_tip_7_28.quaternion.copy(endpoint_hair_tip_7_28.quaternion);
  }
  mesh_hair_tip_7_28.castShadow = options.castShadow ?? true;
  mesh_hair_tip_7_28.receiveShadow = options.receiveShadow ?? true;
  mesh_hair_tip_7_28.userData.sculptComponent = {"id": "hair-tip-7", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.06128355544951823, 0.072, 0.04306676984899815], "rx": 0.022, "rz": 0.015}, {"position": [-0.08120071097061166, 0.11599999999999999, 0.055922522042728934], "rx": 0.016, "rz": 0.011}, {"position": [-0.0934574220605153, 0.139, 0.0649215485783405], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-7", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-7-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.3888888888888889, "v": 0.35}}};
  node_hair_tip_7_28.add(mesh_hair_tip_7_28);
  meshes["hair-tip-7"] = mesh_hair_tip_7_28;
  colliders["hair-tip-7"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hair-tip-7"] ??= [];
  destructionGroups["hair-tip-7"].push(node_hair_tip_7_28);

  const endpoint_hair_tip_8_29 = makeAttachmentEndpoint(null);
  const node_hair_tip_8_29 = new THREE.Group();
  node_hair_tip_8_29.name = "Scalp-attached tapered crown lock__pivot";
  node_hair_tip_8_29.scale.set(1, 1, 1);
  if (endpoint_hair_tip_8_29) {
    node_hair_tip_8_29.position.copy(endpoint_hair_tip_8_29.start);
    node_hair_tip_8_29.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hair_tip_8_29.position.set(0.0, 0.0, 0.0);
    node_hair_tip_8_29.rotation.set(0.0, 0.0, 0.0);
  }
  node_hair_tip_8_29.userData.sculptComponent = {"id": "hair-tip-8", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.07517540966287267, 0.072, 0.022915349602819816], "rx": 0.022, "rz": 0.015}, {"position": [-0.09960741780330627, 0.124, 0.02975575246933319], "rx": 0.016, "rz": 0.011}, {"position": [-0.11464249973588081, 0.148, 0.034544034475892556], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-8", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-8-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.4444444444444444, "v": 0.35}}};
  node_hair_tip_8_29.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-8", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}};
  (nodes["head"] ?? root).add(node_hair_tip_8_29);
  nodes["hair-tip-8"] = node_hair_tip_8_29;
  const mesh_hair_tip_8_29Geometry = endpoint_hair_tip_8_29
    ? new THREE.CylinderGeometry(endpoint_hair_tip_8_29.endRadius, endpoint_hair_tip_8_29.baseRadius, endpoint_hair_tip_8_29.length, 32, 12)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.07517540966287267, 0.072, 0.022915349602819816], "rx": 0.022, "rz": 0.015}, {"position": [-0.09960741780330627, 0.124, 0.02975575246933319], "rx": 0.016, "rz": 0.011}, {"position": [-0.11464249973588081, 0.148, 0.034544034475892556], "rx": 0, "rz": 0}], "radialSegments": 6});
  if (!endpoint_hair_tip_8_29) {
    mesh_hair_tip_8_29Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hair_tip_8_29 = new THREE.Mesh(
    mesh_hair_tip_8_29Geometry,
    materialMap["hair"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hair_tip_8_29.name = "Scalp-attached tapered crown lock";
  if (endpoint_hair_tip_8_29) {
    mesh_hair_tip_8_29.position.copy(endpoint_hair_tip_8_29.midpoint);
    mesh_hair_tip_8_29.quaternion.copy(endpoint_hair_tip_8_29.quaternion);
  }
  mesh_hair_tip_8_29.castShadow = options.castShadow ?? true;
  mesh_hair_tip_8_29.receiveShadow = options.receiveShadow ?? true;
  mesh_hair_tip_8_29.userData.sculptComponent = {"id": "hair-tip-8", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.07517540966287267, 0.072, 0.022915349602819816], "rx": 0.022, "rz": 0.015}, {"position": [-0.09960741780330627, 0.124, 0.02975575246933319], "rx": 0.016, "rz": 0.011}, {"position": [-0.11464249973588081, 0.148, 0.034544034475892556], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-8", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-8-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.4444444444444444, "v": 0.35}}};
  node_hair_tip_8_29.add(mesh_hair_tip_8_29);
  meshes["hair-tip-8"] = mesh_hair_tip_8_29;
  colliders["hair-tip-8"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hair-tip-8"] ??= [];
  destructionGroups["hair-tip-8"].push(node_hair_tip_8_29);

  const endpoint_hair_tip_9_30 = makeAttachmentEndpoint(null);
  const node_hair_tip_9_30 = new THREE.Group();
  node_hair_tip_9_30.name = "Scalp-attached tapered crown lock__pivot";
  node_hair_tip_9_30.scale.set(1, 1, 1);
  if (endpoint_hair_tip_9_30) {
    node_hair_tip_9_30.position.copy(endpoint_hair_tip_9_30.start);
    node_hair_tip_9_30.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hair_tip_9_30.position.set(0.0, 0.0, 0.0);
    node_hair_tip_9_30.rotation.set(0.0, 0.0, 0.0);
  }
  node_hair_tip_9_30.userData.sculptComponent = {"id": "hair-tip-9", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.08, 0.072, 8.205133554287267e-18], "rx": 0.022, "rz": 0.015}, {"position": [-0.106, 0.108, 1.0654427152581972e-17], "rx": 0.016, "rz": 0.011}, {"position": [-0.122, 0.13, 1.2368932671388268e-17], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-9", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-9-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.5, "v": 0.35}}};
  node_hair_tip_9_30.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-9", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}};
  (nodes["head"] ?? root).add(node_hair_tip_9_30);
  nodes["hair-tip-9"] = node_hair_tip_9_30;
  const mesh_hair_tip_9_30Geometry = endpoint_hair_tip_9_30
    ? new THREE.CylinderGeometry(endpoint_hair_tip_9_30.endRadius, endpoint_hair_tip_9_30.baseRadius, endpoint_hair_tip_9_30.length, 32, 12)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.08, 0.072, 8.205133554287267e-18], "rx": 0.022, "rz": 0.015}, {"position": [-0.106, 0.108, 1.0654427152581972e-17], "rx": 0.016, "rz": 0.011}, {"position": [-0.122, 0.13, 1.2368932671388268e-17], "rx": 0, "rz": 0}], "radialSegments": 6});
  if (!endpoint_hair_tip_9_30) {
    mesh_hair_tip_9_30Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hair_tip_9_30 = new THREE.Mesh(
    mesh_hair_tip_9_30Geometry,
    materialMap["hair"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hair_tip_9_30.name = "Scalp-attached tapered crown lock";
  if (endpoint_hair_tip_9_30) {
    mesh_hair_tip_9_30.position.copy(endpoint_hair_tip_9_30.midpoint);
    mesh_hair_tip_9_30.quaternion.copy(endpoint_hair_tip_9_30.quaternion);
  }
  mesh_hair_tip_9_30.castShadow = options.castShadow ?? true;
  mesh_hair_tip_9_30.receiveShadow = options.receiveShadow ?? true;
  mesh_hair_tip_9_30.userData.sculptComponent = {"id": "hair-tip-9", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.08, 0.072, 8.205133554287267e-18], "rx": 0.022, "rz": 0.015}, {"position": [-0.106, 0.108, 1.0654427152581972e-17], "rx": 0.016, "rz": 0.011}, {"position": [-0.122, 0.13, 1.2368932671388268e-17], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-9", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-9-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.5, "v": 0.35}}};
  node_hair_tip_9_30.add(mesh_hair_tip_9_30);
  meshes["hair-tip-9"] = mesh_hair_tip_9_30;
  colliders["hair-tip-9"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hair-tip-9"] ??= [];
  destructionGroups["hair-tip-9"].push(node_hair_tip_9_30);

  const endpoint_hair_tip_10_31 = makeAttachmentEndpoint(null);
  const node_hair_tip_10_31 = new THREE.Group();
  node_hair_tip_10_31.name = "Scalp-attached tapered crown lock__pivot";
  node_hair_tip_10_31.scale.set(1, 1, 1);
  if (endpoint_hair_tip_10_31) {
    node_hair_tip_10_31.position.copy(endpoint_hair_tip_10_31.start);
    node_hair_tip_10_31.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hair_tip_10_31.position.set(0.0, 0.0, 0.0);
    node_hair_tip_10_31.rotation.set(0.0, 0.0, 0.0);
  }
  node_hair_tip_10_31.userData.sculptComponent = {"id": "hair-tip-10", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.07517540966287267, 0.072, -0.022915349602819803], "rx": 0.022, "rz": 0.015}, {"position": [-0.09960741780330629, 0.11599999999999999, -0.02975575246933317], "rx": 0.016, "rz": 0.011}, {"position": [-0.11464249973588082, 0.139, -0.034544034475892535], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-10", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-10-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.5555555555555556, "v": 0.35}}};
  node_hair_tip_10_31.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-10", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}};
  (nodes["head"] ?? root).add(node_hair_tip_10_31);
  nodes["hair-tip-10"] = node_hair_tip_10_31;
  const mesh_hair_tip_10_31Geometry = endpoint_hair_tip_10_31
    ? new THREE.CylinderGeometry(endpoint_hair_tip_10_31.endRadius, endpoint_hair_tip_10_31.baseRadius, endpoint_hair_tip_10_31.length, 32, 12)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.07517540966287267, 0.072, -0.022915349602819803], "rx": 0.022, "rz": 0.015}, {"position": [-0.09960741780330629, 0.11599999999999999, -0.02975575246933317], "rx": 0.016, "rz": 0.011}, {"position": [-0.11464249973588082, 0.139, -0.034544034475892535], "rx": 0, "rz": 0}], "radialSegments": 6});
  if (!endpoint_hair_tip_10_31) {
    mesh_hair_tip_10_31Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hair_tip_10_31 = new THREE.Mesh(
    mesh_hair_tip_10_31Geometry,
    materialMap["hair"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hair_tip_10_31.name = "Scalp-attached tapered crown lock";
  if (endpoint_hair_tip_10_31) {
    mesh_hair_tip_10_31.position.copy(endpoint_hair_tip_10_31.midpoint);
    mesh_hair_tip_10_31.quaternion.copy(endpoint_hair_tip_10_31.quaternion);
  }
  mesh_hair_tip_10_31.castShadow = options.castShadow ?? true;
  mesh_hair_tip_10_31.receiveShadow = options.receiveShadow ?? true;
  mesh_hair_tip_10_31.userData.sculptComponent = {"id": "hair-tip-10", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.07517540966287267, 0.072, -0.022915349602819803], "rx": 0.022, "rz": 0.015}, {"position": [-0.09960741780330629, 0.11599999999999999, -0.02975575246933317], "rx": 0.016, "rz": 0.011}, {"position": [-0.11464249973588082, 0.139, -0.034544034475892535], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-10", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-10-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.5555555555555556, "v": 0.35}}};
  node_hair_tip_10_31.add(mesh_hair_tip_10_31);
  meshes["hair-tip-10"] = mesh_hair_tip_10_31;
  colliders["hair-tip-10"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hair-tip-10"] ??= [];
  destructionGroups["hair-tip-10"].push(node_hair_tip_10_31);

  const endpoint_hair_tip_11_32 = makeAttachmentEndpoint(null);
  const node_hair_tip_11_32 = new THREE.Group();
  node_hair_tip_11_32.name = "Scalp-attached tapered crown lock__pivot";
  node_hair_tip_11_32.scale.set(1, 1, 1);
  if (endpoint_hair_tip_11_32) {
    node_hair_tip_11_32.position.copy(endpoint_hair_tip_11_32.start);
    node_hair_tip_11_32.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hair_tip_11_32.position.set(0.0, 0.0, 0.0);
    node_hair_tip_11_32.rotation.set(0.0, 0.0, 0.0);
  }
  node_hair_tip_11_32.userData.sculptComponent = {"id": "hair-tip-11", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.061283555449518266, 0.072, -0.04306676984899811], "rx": 0.022, "rz": 0.015}, {"position": [-0.0812007109706117, 0.124, -0.055922522042728885], "rx": 0.016, "rz": 0.011}, {"position": [-0.09345742206051535, 0.148, -0.06492154857834044], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-11", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-11-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.6111111111111112, "v": 0.35}}};
  node_hair_tip_11_32.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-11", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}};
  (nodes["head"] ?? root).add(node_hair_tip_11_32);
  nodes["hair-tip-11"] = node_hair_tip_11_32;
  const mesh_hair_tip_11_32Geometry = endpoint_hair_tip_11_32
    ? new THREE.CylinderGeometry(endpoint_hair_tip_11_32.endRadius, endpoint_hair_tip_11_32.baseRadius, endpoint_hair_tip_11_32.length, 32, 12)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.061283555449518266, 0.072, -0.04306676984899811], "rx": 0.022, "rz": 0.015}, {"position": [-0.0812007109706117, 0.124, -0.055922522042728885], "rx": 0.016, "rz": 0.011}, {"position": [-0.09345742206051535, 0.148, -0.06492154857834044], "rx": 0, "rz": 0}], "radialSegments": 6});
  if (!endpoint_hair_tip_11_32) {
    mesh_hair_tip_11_32Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hair_tip_11_32 = new THREE.Mesh(
    mesh_hair_tip_11_32Geometry,
    materialMap["hair"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hair_tip_11_32.name = "Scalp-attached tapered crown lock";
  if (endpoint_hair_tip_11_32) {
    mesh_hair_tip_11_32.position.copy(endpoint_hair_tip_11_32.midpoint);
    mesh_hair_tip_11_32.quaternion.copy(endpoint_hair_tip_11_32.quaternion);
  }
  mesh_hair_tip_11_32.castShadow = options.castShadow ?? true;
  mesh_hair_tip_11_32.receiveShadow = options.receiveShadow ?? true;
  mesh_hair_tip_11_32.userData.sculptComponent = {"id": "hair-tip-11", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.061283555449518266, 0.072, -0.04306676984899811], "rx": 0.022, "rz": 0.015}, {"position": [-0.0812007109706117, 0.124, -0.055922522042728885], "rx": 0.016, "rz": 0.011}, {"position": [-0.09345742206051535, 0.148, -0.06492154857834044], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-11", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-11-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.6111111111111112, "v": 0.35}}};
  node_hair_tip_11_32.add(mesh_hair_tip_11_32);
  meshes["hair-tip-11"] = mesh_hair_tip_11_32;
  colliders["hair-tip-11"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hair-tip-11"] ??= [];
  destructionGroups["hair-tip-11"].push(node_hair_tip_11_32);

  const endpoint_hair_tip_12_33 = makeAttachmentEndpoint(null);
  const node_hair_tip_12_33 = new THREE.Group();
  node_hair_tip_12_33.name = "Scalp-attached tapered crown lock__pivot";
  node_hair_tip_12_33.scale.set(1, 1, 1);
  if (endpoint_hair_tip_12_33) {
    node_hair_tip_12_33.position.copy(endpoint_hair_tip_12_33.start);
    node_hair_tip_12_33.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hair_tip_12_33.position.set(0.0, 0.0, 0.0);
    node_hair_tip_12_33.rotation.set(0.0, 0.0, 0.0);
  }
  node_hair_tip_12_33.userData.sculptComponent = {"id": "hair-tip-12", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.040000000000000036, 0.072, -0.05802370205355738], "rx": 0.022, "rz": 0.015}, {"position": [-0.05300000000000005, 0.108, -0.07534421012924614], "rx": 0.016, "rz": 0.011}, {"position": [-0.061000000000000054, 0.13, -0.08746856578222828], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-12", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-12-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.6666666666666666, "v": 0.35}}};
  node_hair_tip_12_33.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-12", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}};
  (nodes["head"] ?? root).add(node_hair_tip_12_33);
  nodes["hair-tip-12"] = node_hair_tip_12_33;
  const mesh_hair_tip_12_33Geometry = endpoint_hair_tip_12_33
    ? new THREE.CylinderGeometry(endpoint_hair_tip_12_33.endRadius, endpoint_hair_tip_12_33.baseRadius, endpoint_hair_tip_12_33.length, 32, 12)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.040000000000000036, 0.072, -0.05802370205355738], "rx": 0.022, "rz": 0.015}, {"position": [-0.05300000000000005, 0.108, -0.07534421012924614], "rx": 0.016, "rz": 0.011}, {"position": [-0.061000000000000054, 0.13, -0.08746856578222828], "rx": 0, "rz": 0}], "radialSegments": 6});
  if (!endpoint_hair_tip_12_33) {
    mesh_hair_tip_12_33Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hair_tip_12_33 = new THREE.Mesh(
    mesh_hair_tip_12_33Geometry,
    materialMap["hair"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hair_tip_12_33.name = "Scalp-attached tapered crown lock";
  if (endpoint_hair_tip_12_33) {
    mesh_hair_tip_12_33.position.copy(endpoint_hair_tip_12_33.midpoint);
    mesh_hair_tip_12_33.quaternion.copy(endpoint_hair_tip_12_33.quaternion);
  }
  mesh_hair_tip_12_33.castShadow = options.castShadow ?? true;
  mesh_hair_tip_12_33.receiveShadow = options.receiveShadow ?? true;
  mesh_hair_tip_12_33.userData.sculptComponent = {"id": "hair-tip-12", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.040000000000000036, 0.072, -0.05802370205355738], "rx": 0.022, "rz": 0.015}, {"position": [-0.05300000000000005, 0.108, -0.07534421012924614], "rx": 0.016, "rz": 0.011}, {"position": [-0.061000000000000054, 0.13, -0.08746856578222828], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-12", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-12-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.6666666666666666, "v": 0.35}}};
  node_hair_tip_12_33.add(mesh_hair_tip_12_33);
  meshes["hair-tip-12"] = mesh_hair_tip_12_33;
  colliders["hair-tip-12"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hair-tip-12"] ??= [];
  destructionGroups["hair-tip-12"].push(node_hair_tip_12_33);

  const endpoint_hair_tip_13_34 = makeAttachmentEndpoint(null);
  const node_hair_tip_13_34 = new THREE.Group();
  node_hair_tip_13_34.name = "Scalp-attached tapered crown lock__pivot";
  node_hair_tip_13_34.scale.set(1, 1, 1);
  if (endpoint_hair_tip_13_34) {
    node_hair_tip_13_34.position.copy(endpoint_hair_tip_13_34.start);
    node_hair_tip_13_34.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hair_tip_13_34.position.set(0.0, 0.0, 0.0);
    node_hair_tip_13_34.rotation.set(0.0, 0.0, 0.0);
  }
  node_hair_tip_13_34.userData.sculptComponent = {"id": "hair-tip-13", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.013891854213354426, 0.072, -0.06598211945181794], "rx": 0.022, "rz": 0.015}, {"position": [-0.018406706832694613, 0.11599999999999999, -0.08567827451206209], "rx": 0.016, "rz": 0.011}, {"position": [-0.0211850776753655, 0.139, -0.09946558305423302], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-13", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-13-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.7222222222222222, "v": 0.35}}};
  node_hair_tip_13_34.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-13", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}};
  (nodes["head"] ?? root).add(node_hair_tip_13_34);
  nodes["hair-tip-13"] = node_hair_tip_13_34;
  const mesh_hair_tip_13_34Geometry = endpoint_hair_tip_13_34
    ? new THREE.CylinderGeometry(endpoint_hair_tip_13_34.endRadius, endpoint_hair_tip_13_34.baseRadius, endpoint_hair_tip_13_34.length, 32, 12)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.013891854213354426, 0.072, -0.06598211945181794], "rx": 0.022, "rz": 0.015}, {"position": [-0.018406706832694613, 0.11599999999999999, -0.08567827451206209], "rx": 0.016, "rz": 0.011}, {"position": [-0.0211850776753655, 0.139, -0.09946558305423302], "rx": 0, "rz": 0}], "radialSegments": 6});
  if (!endpoint_hair_tip_13_34) {
    mesh_hair_tip_13_34Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hair_tip_13_34 = new THREE.Mesh(
    mesh_hair_tip_13_34Geometry,
    materialMap["hair"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hair_tip_13_34.name = "Scalp-attached tapered crown lock";
  if (endpoint_hair_tip_13_34) {
    mesh_hair_tip_13_34.position.copy(endpoint_hair_tip_13_34.midpoint);
    mesh_hair_tip_13_34.quaternion.copy(endpoint_hair_tip_13_34.quaternion);
  }
  mesh_hair_tip_13_34.castShadow = options.castShadow ?? true;
  mesh_hair_tip_13_34.receiveShadow = options.receiveShadow ?? true;
  mesh_hair_tip_13_34.userData.sculptComponent = {"id": "hair-tip-13", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.013891854213354426, 0.072, -0.06598211945181794], "rx": 0.022, "rz": 0.015}, {"position": [-0.018406706832694613, 0.11599999999999999, -0.08567827451206209], "rx": 0.016, "rz": 0.011}, {"position": [-0.0211850776753655, 0.139, -0.09946558305423302], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-13", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-13-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.7222222222222222, "v": 0.35}}};
  node_hair_tip_13_34.add(mesh_hair_tip_13_34);
  meshes["hair-tip-13"] = mesh_hair_tip_13_34;
  colliders["hair-tip-13"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hair-tip-13"] ??= [];
  destructionGroups["hair-tip-13"].push(node_hair_tip_13_34);

  const endpoint_hair_tip_14_35 = makeAttachmentEndpoint(null);
  const node_hair_tip_14_35 = new THREE.Group();
  node_hair_tip_14_35.name = "Scalp-attached tapered crown lock__pivot";
  node_hair_tip_14_35.scale.set(1, 1, 1);
  if (endpoint_hair_tip_14_35) {
    node_hair_tip_14_35.position.copy(endpoint_hair_tip_14_35.start);
    node_hair_tip_14_35.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hair_tip_14_35.position.set(0.0, 0.0, 0.0);
    node_hair_tip_14_35.rotation.set(0.0, 0.0, 0.0);
  }
  node_hair_tip_14_35.userData.sculptComponent = {"id": "hair-tip-14", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.013891854213354399, 0.072, -0.06598211945181795], "rx": 0.022, "rz": 0.015}, {"position": [0.018406706832694575, 0.124, -0.0856782745120621], "rx": 0.016, "rz": 0.011}, {"position": [0.021185077675365455, 0.148, -0.09946558305423303], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-14", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-14-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.7777777777777778, "v": 0.35}}};
  node_hair_tip_14_35.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-14", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}};
  (nodes["head"] ?? root).add(node_hair_tip_14_35);
  nodes["hair-tip-14"] = node_hair_tip_14_35;
  const mesh_hair_tip_14_35Geometry = endpoint_hair_tip_14_35
    ? new THREE.CylinderGeometry(endpoint_hair_tip_14_35.endRadius, endpoint_hair_tip_14_35.baseRadius, endpoint_hair_tip_14_35.length, 32, 12)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.013891854213354399, 0.072, -0.06598211945181795], "rx": 0.022, "rz": 0.015}, {"position": [0.018406706832694575, 0.124, -0.0856782745120621], "rx": 0.016, "rz": 0.011}, {"position": [0.021185077675365455, 0.148, -0.09946558305423303], "rx": 0, "rz": 0}], "radialSegments": 6});
  if (!endpoint_hair_tip_14_35) {
    mesh_hair_tip_14_35Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hair_tip_14_35 = new THREE.Mesh(
    mesh_hair_tip_14_35Geometry,
    materialMap["hair"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hair_tip_14_35.name = "Scalp-attached tapered crown lock";
  if (endpoint_hair_tip_14_35) {
    mesh_hair_tip_14_35.position.copy(endpoint_hair_tip_14_35.midpoint);
    mesh_hair_tip_14_35.quaternion.copy(endpoint_hair_tip_14_35.quaternion);
  }
  mesh_hair_tip_14_35.castShadow = options.castShadow ?? true;
  mesh_hair_tip_14_35.receiveShadow = options.receiveShadow ?? true;
  mesh_hair_tip_14_35.userData.sculptComponent = {"id": "hair-tip-14", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.013891854213354399, 0.072, -0.06598211945181795], "rx": 0.022, "rz": 0.015}, {"position": [0.018406706832694575, 0.124, -0.0856782745120621], "rx": 0.016, "rz": 0.011}, {"position": [0.021185077675365455, 0.148, -0.09946558305423303], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-14", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-14-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.7777777777777778, "v": 0.35}}};
  node_hair_tip_14_35.add(mesh_hair_tip_14_35);
  meshes["hair-tip-14"] = mesh_hair_tip_14_35;
  colliders["hair-tip-14"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hair-tip-14"] ??= [];
  destructionGroups["hair-tip-14"].push(node_hair_tip_14_35);

  const endpoint_hair_tip_15_36 = makeAttachmentEndpoint(null);
  const node_hair_tip_15_36 = new THREE.Group();
  node_hair_tip_15_36.name = "Scalp-attached tapered crown lock__pivot";
  node_hair_tip_15_36.scale.set(1, 1, 1);
  if (endpoint_hair_tip_15_36) {
    node_hair_tip_15_36.position.copy(endpoint_hair_tip_15_36.start);
    node_hair_tip_15_36.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hair_tip_15_36.position.set(0.0, 0.0, 0.0);
    node_hair_tip_15_36.rotation.set(0.0, 0.0, 0.0);
  }
  node_hair_tip_15_36.userData.sculptComponent = {"id": "hair-tip-15", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.039999999999999945, 0.072, -0.05802370205355742], "rx": 0.022, "rz": 0.015}, {"position": [0.05299999999999993, 0.108, -0.07534421012924619], "rx": 0.016, "rz": 0.011}, {"position": [0.060999999999999915, 0.13, -0.08746856578222835], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-15", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-15-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.8333333333333334, "v": 0.35}}};
  node_hair_tip_15_36.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-15", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}};
  (nodes["head"] ?? root).add(node_hair_tip_15_36);
  nodes["hair-tip-15"] = node_hair_tip_15_36;
  const mesh_hair_tip_15_36Geometry = endpoint_hair_tip_15_36
    ? new THREE.CylinderGeometry(endpoint_hair_tip_15_36.endRadius, endpoint_hair_tip_15_36.baseRadius, endpoint_hair_tip_15_36.length, 32, 12)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.039999999999999945, 0.072, -0.05802370205355742], "rx": 0.022, "rz": 0.015}, {"position": [0.05299999999999993, 0.108, -0.07534421012924619], "rx": 0.016, "rz": 0.011}, {"position": [0.060999999999999915, 0.13, -0.08746856578222835], "rx": 0, "rz": 0}], "radialSegments": 6});
  if (!endpoint_hair_tip_15_36) {
    mesh_hair_tip_15_36Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hair_tip_15_36 = new THREE.Mesh(
    mesh_hair_tip_15_36Geometry,
    materialMap["hair"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hair_tip_15_36.name = "Scalp-attached tapered crown lock";
  if (endpoint_hair_tip_15_36) {
    mesh_hair_tip_15_36.position.copy(endpoint_hair_tip_15_36.midpoint);
    mesh_hair_tip_15_36.quaternion.copy(endpoint_hair_tip_15_36.quaternion);
  }
  mesh_hair_tip_15_36.castShadow = options.castShadow ?? true;
  mesh_hair_tip_15_36.receiveShadow = options.receiveShadow ?? true;
  mesh_hair_tip_15_36.userData.sculptComponent = {"id": "hair-tip-15", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.039999999999999945, 0.072, -0.05802370205355742], "rx": 0.022, "rz": 0.015}, {"position": [0.05299999999999993, 0.108, -0.07534421012924619], "rx": 0.016, "rz": 0.011}, {"position": [0.060999999999999915, 0.13, -0.08746856578222835], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-15", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-15-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.8333333333333334, "v": 0.35}}};
  node_hair_tip_15_36.add(mesh_hair_tip_15_36);
  meshes["hair-tip-15"] = mesh_hair_tip_15_36;
  colliders["hair-tip-15"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hair-tip-15"] ??= [];
  destructionGroups["hair-tip-15"].push(node_hair_tip_15_36);

  const endpoint_hair_tip_16_37 = makeAttachmentEndpoint(null);
  const node_hair_tip_16_37 = new THREE.Group();
  node_hair_tip_16_37.name = "Scalp-attached tapered crown lock__pivot";
  node_hair_tip_16_37.scale.set(1, 1, 1);
  if (endpoint_hair_tip_16_37) {
    node_hair_tip_16_37.position.copy(endpoint_hair_tip_16_37.start);
    node_hair_tip_16_37.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hair_tip_16_37.position.set(0.0, 0.0, 0.0);
    node_hair_tip_16_37.rotation.set(0.0, 0.0, 0.0);
  }
  node_hair_tip_16_37.userData.sculptComponent = {"id": "hair-tip-16", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.061283555449518225, 0.072, -0.043066769848998154], "rx": 0.022, "rz": 0.015}, {"position": [0.08120071097061164, 0.11599999999999999, -0.05592252204272894], "rx": 0.016, "rz": 0.011}, {"position": [0.09345742206051529, 0.139, -0.0649215485783405], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-16", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-16-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.8888888888888888, "v": 0.35}}};
  node_hair_tip_16_37.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-16", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}};
  (nodes["head"] ?? root).add(node_hair_tip_16_37);
  nodes["hair-tip-16"] = node_hair_tip_16_37;
  const mesh_hair_tip_16_37Geometry = endpoint_hair_tip_16_37
    ? new THREE.CylinderGeometry(endpoint_hair_tip_16_37.endRadius, endpoint_hair_tip_16_37.baseRadius, endpoint_hair_tip_16_37.length, 32, 12)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.061283555449518225, 0.072, -0.043066769848998154], "rx": 0.022, "rz": 0.015}, {"position": [0.08120071097061164, 0.11599999999999999, -0.05592252204272894], "rx": 0.016, "rz": 0.011}, {"position": [0.09345742206051529, 0.139, -0.0649215485783405], "rx": 0, "rz": 0}], "radialSegments": 6});
  if (!endpoint_hair_tip_16_37) {
    mesh_hair_tip_16_37Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hair_tip_16_37 = new THREE.Mesh(
    mesh_hair_tip_16_37Geometry,
    materialMap["hair"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hair_tip_16_37.name = "Scalp-attached tapered crown lock";
  if (endpoint_hair_tip_16_37) {
    mesh_hair_tip_16_37.position.copy(endpoint_hair_tip_16_37.midpoint);
    mesh_hair_tip_16_37.quaternion.copy(endpoint_hair_tip_16_37.quaternion);
  }
  mesh_hair_tip_16_37.castShadow = options.castShadow ?? true;
  mesh_hair_tip_16_37.receiveShadow = options.receiveShadow ?? true;
  mesh_hair_tip_16_37.userData.sculptComponent = {"id": "hair-tip-16", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.061283555449518225, 0.072, -0.043066769848998154], "rx": 0.022, "rz": 0.015}, {"position": [0.08120071097061164, 0.11599999999999999, -0.05592252204272894], "rx": 0.016, "rz": 0.011}, {"position": [0.09345742206051529, 0.139, -0.0649215485783405], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-16", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-16-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.8888888888888888, "v": 0.35}}};
  node_hair_tip_16_37.add(mesh_hair_tip_16_37);
  meshes["hair-tip-16"] = mesh_hair_tip_16_37;
  colliders["hair-tip-16"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hair-tip-16"] ??= [];
  destructionGroups["hair-tip-16"].push(node_hair_tip_16_37);

  const endpoint_hair_tip_17_38 = makeAttachmentEndpoint(null);
  const node_hair_tip_17_38 = new THREE.Group();
  node_hair_tip_17_38.name = "Scalp-attached tapered crown lock__pivot";
  node_hair_tip_17_38.scale.set(1, 1, 1);
  if (endpoint_hair_tip_17_38) {
    node_hair_tip_17_38.position.copy(endpoint_hair_tip_17_38.start);
    node_hair_tip_17_38.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hair_tip_17_38.position.set(0.0, 0.0, 0.0);
    node_hair_tip_17_38.rotation.set(0.0, 0.0, 0.0);
  }
  node_hair_tip_17_38.userData.sculptComponent = {"id": "hair-tip-17", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.07517540966287267, 0.072, -0.0229153496028198], "rx": 0.022, "rz": 0.015}, {"position": [0.09960741780330629, 0.124, -0.029755752469333166], "rx": 0.016, "rz": 0.011}, {"position": [0.11464249973588082, 0.148, -0.03454403447589253], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-17", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-17-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.9444444444444444, "v": 0.35}}};
  node_hair_tip_17_38.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-17", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}};
  (nodes["head"] ?? root).add(node_hair_tip_17_38);
  nodes["hair-tip-17"] = node_hair_tip_17_38;
  const mesh_hair_tip_17_38Geometry = endpoint_hair_tip_17_38
    ? new THREE.CylinderGeometry(endpoint_hair_tip_17_38.endRadius, endpoint_hair_tip_17_38.baseRadius, endpoint_hair_tip_17_38.length, 32, 12)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.07517540966287267, 0.072, -0.0229153496028198], "rx": 0.022, "rz": 0.015}, {"position": [0.09960741780330629, 0.124, -0.029755752469333166], "rx": 0.016, "rz": 0.011}, {"position": [0.11464249973588082, 0.148, -0.03454403447589253], "rx": 0, "rz": 0}], "radialSegments": 6});
  if (!endpoint_hair_tip_17_38) {
    mesh_hair_tip_17_38Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hair_tip_17_38 = new THREE.Mesh(
    mesh_hair_tip_17_38Geometry,
    materialMap["hair"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hair_tip_17_38.name = "Scalp-attached tapered crown lock";
  if (endpoint_hair_tip_17_38) {
    mesh_hair_tip_17_38.position.copy(endpoint_hair_tip_17_38.midpoint);
    mesh_hair_tip_17_38.quaternion.copy(endpoint_hair_tip_17_38.quaternion);
  }
  mesh_hair_tip_17_38.castShadow = options.castShadow ?? true;
  mesh_hair_tip_17_38.receiveShadow = options.receiveShadow ?? true;
  mesh_hair_tip_17_38.userData.sculptComponent = {"id": "hair-tip-17", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.07517540966287267, 0.072, -0.0229153496028198], "rx": 0.022, "rz": 0.015}, {"position": [0.09960741780330629, 0.124, -0.029755752469333166], "rx": 0.016, "rz": 0.011}, {"position": [0.11464249973588082, 0.148, -0.03454403447589253], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-17", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-17-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.9444444444444444, "v": 0.35}}};
  node_hair_tip_17_38.add(mesh_hair_tip_17_38);
  meshes["hair-tip-17"] = mesh_hair_tip_17_38;
  colliders["hair-tip-17"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hair-tip-17"] ??= [];
  destructionGroups["hair-tip-17"].push(node_hair_tip_17_38);

  const endpoint_eye_r_39 = makeAttachmentEndpoint(null);
  const node_eye_r_39 = new THREE.Group();
  node_eye_r_39.name = "Open right eye__pivot";
  node_eye_r_39.scale.set(1, 1, 1);
  if (endpoint_eye_r_39) {
    node_eye_r_39.position.copy(endpoint_eye_r_39.start);
    node_eye_r_39.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_eye_r_39.position.set(-0.047, 0.001, 0.084);
    node_eye_r_39.rotation.set(0.0, 0.0, 0.0);
  }
  node_eye_r_39.userData.sculptComponent = {"id": "eye-r", "name": "Open right eye", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Open right eye follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.056, "height": 0.025, "depth": 0.026, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.047, 0.001, 0.084], "rotation": [0, 0, 0], "scale": [0.056, 0.025, 0.026]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}}, "material": "white", "materialLayers": ["white"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["eye-r-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 234, 222, 1)", "secondaryAlbedo": "rgba(214, 211, 200, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_eye_r_39.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}};
  (nodes["head"] ?? root).add(node_eye_r_39);
  nodes["eye-r"] = node_eye_r_39;
  const mesh_eye_r_39Geometry = endpoint_eye_r_39
    ? new THREE.CylinderGeometry(endpoint_eye_r_39.endRadius, endpoint_eye_r_39.baseRadius, endpoint_eye_r_39.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_eye_r_39) {
    mesh_eye_r_39Geometry.scale(0.056, 0.025, 0.026);
  }
  const mesh_eye_r_39 = new THREE.Mesh(
    mesh_eye_r_39Geometry,
    materialMap["white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_eye_r_39.name = "Open right eye";
  if (endpoint_eye_r_39) {
    mesh_eye_r_39.position.copy(endpoint_eye_r_39.midpoint);
    mesh_eye_r_39.quaternion.copy(endpoint_eye_r_39.quaternion);
  }
  mesh_eye_r_39.castShadow = options.castShadow ?? true;
  mesh_eye_r_39.receiveShadow = options.receiveShadow ?? true;
  mesh_eye_r_39.userData.sculptComponent = {"id": "eye-r", "name": "Open right eye", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Open right eye follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.056, "height": 0.025, "depth": 0.026, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.047, 0.001, 0.084], "rotation": [0, 0, 0], "scale": [0.056, 0.025, 0.026]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}}, "material": "white", "materialLayers": ["white"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["eye-r-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 234, 222, 1)", "secondaryAlbedo": "rgba(214, 211, 200, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_eye_r_39.add(mesh_eye_r_39);
  meshes["eye-r"] = mesh_eye_r_39;
  colliders["eye-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["eye-r"] ??= [];
  destructionGroups["eye-r"].push(node_eye_r_39);

  const endpoint_iris_r_40 = makeAttachmentEndpoint(null);
  const node_iris_r_40 = new THREE.Group();
  node_iris_r_40.name = "Right iris__pivot";
  node_iris_r_40.scale.set(1, 1, 1);
  if (endpoint_iris_r_40) {
    node_iris_r_40.position.copy(endpoint_iris_r_40.start);
    node_iris_r_40.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_iris_r_40.position.set(-0.045, -0.001, 0.1);
    node_iris_r_40.rotation.set(0.0, 0.0, 0.0);
  }
  node_iris_r_40.userData.sculptComponent = {"id": "iris-r", "name": "Right iris", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Right iris follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.014, "height": 0.016, "depth": 0.006, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.045, -0.001, 0.1], "rotation": [0, 0, 0], "scale": [0.014, 0.016, 0.006]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "iris-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark"}}, "material": "dark", "materialLayers": ["dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["iris-r-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(32, 35, 44, 1)", "secondaryAlbedo": "rgba(29, 32, 40, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_iris_r_40.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "iris-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark"}};
  (nodes["head"] ?? root).add(node_iris_r_40);
  nodes["iris-r"] = node_iris_r_40;
  const mesh_iris_r_40Geometry = endpoint_iris_r_40
    ? new THREE.CylinderGeometry(endpoint_iris_r_40.endRadius, endpoint_iris_r_40.baseRadius, endpoint_iris_r_40.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_iris_r_40) {
    mesh_iris_r_40Geometry.scale(0.014, 0.016, 0.006);
  }
  const mesh_iris_r_40 = new THREE.Mesh(
    mesh_iris_r_40Geometry,
    materialMap["dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_iris_r_40.name = "Right iris";
  if (endpoint_iris_r_40) {
    mesh_iris_r_40.position.copy(endpoint_iris_r_40.midpoint);
    mesh_iris_r_40.quaternion.copy(endpoint_iris_r_40.quaternion);
  }
  mesh_iris_r_40.castShadow = options.castShadow ?? true;
  mesh_iris_r_40.receiveShadow = options.receiveShadow ?? true;
  mesh_iris_r_40.userData.sculptComponent = {"id": "iris-r", "name": "Right iris", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Right iris follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.014, "height": 0.016, "depth": 0.006, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.045, -0.001, 0.1], "rotation": [0, 0, 0], "scale": [0.014, 0.016, 0.006]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "iris-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark"}}, "material": "dark", "materialLayers": ["dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["iris-r-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(32, 35, 44, 1)", "secondaryAlbedo": "rgba(29, 32, 40, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_iris_r_40.add(mesh_iris_r_40);
  meshes["iris-r"] = mesh_iris_r_40;
  colliders["iris-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["iris-r"] ??= [];
  destructionGroups["iris-r"].push(node_iris_r_40);

  const endpoint_teeth_41 = makeAttachmentEndpoint(null);
  const node_teeth_41 = new THREE.Group();
  node_teeth_41.name = "Clenched grin__pivot";
  node_teeth_41.scale.set(1, 1, 1);
  if (endpoint_teeth_41) {
    node_teeth_41.position.copy(endpoint_teeth_41.start);
    node_teeth_41.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_teeth_41.position.set(0.0, -0.077, 0.082);
    node_teeth_41.rotation.set(0.0, 0.0, 0.0);
  }
  node_teeth_41.userData.sculptComponent = {"id": "teeth", "name": "Clenched grin", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Clenched grin follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.119, "height": 0.032, "depth": 0.018, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, -0.077, 0.082], "rotation": [0, 0, 0], "scale": [0.119, 0.032, 0.018]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "teeth", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}}, "material": "white", "materialLayers": ["white"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["teeth-observed-contour", {"id": "grin", "description": "Broad clenched white teeth with curved lower lip", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 234, 222, 1)", "secondaryAlbedo": "rgba(214, 211, 200, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_teeth_41.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "teeth", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}};
  (nodes["head"] ?? root).add(node_teeth_41);
  nodes["teeth"] = node_teeth_41;
  const mesh_teeth_41Geometry = endpoint_teeth_41
    ? new THREE.CylinderGeometry(endpoint_teeth_41.endRadius, endpoint_teeth_41.baseRadius, endpoint_teeth_41.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_teeth_41) {
    mesh_teeth_41Geometry.scale(0.119, 0.032, 0.018);
  }
  const mesh_teeth_41 = new THREE.Mesh(
    mesh_teeth_41Geometry,
    materialMap["white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_teeth_41.name = "Clenched grin";
  if (endpoint_teeth_41) {
    mesh_teeth_41.position.copy(endpoint_teeth_41.midpoint);
    mesh_teeth_41.quaternion.copy(endpoint_teeth_41.quaternion);
  }
  mesh_teeth_41.castShadow = options.castShadow ?? true;
  mesh_teeth_41.receiveShadow = options.receiveShadow ?? true;
  mesh_teeth_41.userData.sculptComponent = {"id": "teeth", "name": "Clenched grin", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Clenched grin follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.119, "height": 0.032, "depth": 0.018, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, -0.077, 0.082], "rotation": [0, 0, 0], "scale": [0.119, 0.032, 0.018]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "teeth", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}}, "material": "white", "materialLayers": ["white"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["teeth-observed-contour", {"id": "grin", "description": "Broad clenched white teeth with curved lower lip", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 234, 222, 1)", "secondaryAlbedo": "rgba(214, 211, 200, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_teeth_41.add(mesh_teeth_41);
  meshes["teeth"] = mesh_teeth_41;
  colliders["teeth"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["teeth"] ??= [];
  destructionGroups["teeth"].push(node_teeth_41);

  const endpoint_scar_42 = makeAttachmentEndpoint(null);
  const node_scar_42 = new THREE.Group();
  node_scar_42.name = "Closed left eye scar__pivot";
  node_scar_42.scale.set(1, 1, 1);
  if (endpoint_scar_42) {
    node_scar_42.position.copy(endpoint_scar_42.start);
    node_scar_42.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_scar_42.position.set(0.042, 0.007, 0.09);
    node_scar_42.rotation.set(0.0, 0.0, 0.0);
  }
  node_scar_42.userData.sculptComponent = {"id": "scar", "name": "Closed left eye scar", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "Closed left eye scar follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.003, "height": 0.097, "depth": 0.003, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.042, 0.007, 0.09], "rotation": [0, 0, 0], "scale": [0.003, 0.097, 0.003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "scar", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scar"}}, "material": "scar", "materialLayers": ["scar"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["scar-observed-contour", {"id": "left-eye-scar", "description": "Closed left eye crossed by a vertical scar", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(134, 85, 65, 1)", "secondaryAlbedo": "rgba(121, 76, 58, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_scar_42.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "scar", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scar"}};
  (nodes["head"] ?? root).add(node_scar_42);
  nodes["scar"] = node_scar_42;
  const mesh_scar_42Geometry = endpoint_scar_42
    ? new THREE.CylinderGeometry(endpoint_scar_42.endRadius, endpoint_scar_42.baseRadius, endpoint_scar_42.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_scar_42) {
    mesh_scar_42Geometry.scale(0.003, 0.097, 0.003);
  }
  const mesh_scar_42 = new THREE.Mesh(
    mesh_scar_42Geometry,
    materialMap["scar"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_scar_42.name = "Closed left eye scar";
  if (endpoint_scar_42) {
    mesh_scar_42.position.copy(endpoint_scar_42.midpoint);
    mesh_scar_42.quaternion.copy(endpoint_scar_42.quaternion);
  }
  mesh_scar_42.castShadow = options.castShadow ?? true;
  mesh_scar_42.receiveShadow = options.receiveShadow ?? true;
  mesh_scar_42.userData.sculptComponent = {"id": "scar", "name": "Closed left eye scar", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "Closed left eye scar follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.003, "height": 0.097, "depth": 0.003, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.042, 0.007, 0.09], "rotation": [0, 0, 0], "scale": [0.003, 0.097, 0.003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "scar", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scar"}}, "material": "scar", "materialLayers": ["scar"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["scar-observed-contour", {"id": "left-eye-scar", "description": "Closed left eye crossed by a vertical scar", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(134, 85, 65, 1)", "secondaryAlbedo": "rgba(121, 76, 58, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_scar_42.add(mesh_scar_42);
  meshes["scar"] = mesh_scar_42;
  colliders["scar"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["scar"] ??= [];
  destructionGroups["scar"].push(node_scar_42);

  const endpoint_brow__1_43 = makeAttachmentEndpoint(null);
  const node_brow__1_43 = new THREE.Group();
  node_brow__1_43.name = "Angled brow__pivot";
  node_brow__1_43.scale.set(1, 1, 1);
  if (endpoint_brow__1_43) {
    node_brow__1_43.position.copy(endpoint_brow__1_43.start);
    node_brow__1_43.rotation.set(0.0, 0.0, 0.16);
  } else {
    node_brow__1_43.position.set(-0.047, 0.026, 0.086);
    node_brow__1_43.rotation.set(0.0, 0.0, 0.16);
  }
  node_brow__1_43.userData.sculptComponent = {"id": "brow--1", "name": "Angled brow", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "Angled brow follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.061, "height": 0.006, "depth": 0.006, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.047, 0.026, 0.086], "rotation": [0, 0, 0.16], "scale": [0.061, 0.006, 0.006]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "brow--1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark"}}, "material": "dark", "materialLayers": ["dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["brow--1-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(32, 35, 44, 1)", "secondaryAlbedo": "rgba(29, 32, 40, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_brow__1_43.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "brow--1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark"}};
  (nodes["head"] ?? root).add(node_brow__1_43);
  nodes["brow--1"] = node_brow__1_43;
  const mesh_brow__1_43Geometry = endpoint_brow__1_43
    ? new THREE.CylinderGeometry(endpoint_brow__1_43.endRadius, endpoint_brow__1_43.baseRadius, endpoint_brow__1_43.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_brow__1_43) {
    mesh_brow__1_43Geometry.scale(0.061, 0.006, 0.006);
  }
  const mesh_brow__1_43 = new THREE.Mesh(
    mesh_brow__1_43Geometry,
    materialMap["dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_brow__1_43.name = "Angled brow";
  if (endpoint_brow__1_43) {
    mesh_brow__1_43.position.copy(endpoint_brow__1_43.midpoint);
    mesh_brow__1_43.quaternion.copy(endpoint_brow__1_43.quaternion);
  }
  mesh_brow__1_43.castShadow = options.castShadow ?? true;
  mesh_brow__1_43.receiveShadow = options.receiveShadow ?? true;
  mesh_brow__1_43.userData.sculptComponent = {"id": "brow--1", "name": "Angled brow", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "Angled brow follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.061, "height": 0.006, "depth": 0.006, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.047, 0.026, 0.086], "rotation": [0, 0, 0.16], "scale": [0.061, 0.006, 0.006]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "brow--1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark"}}, "material": "dark", "materialLayers": ["dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["brow--1-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(32, 35, 44, 1)", "secondaryAlbedo": "rgba(29, 32, 40, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_brow__1_43.add(mesh_brow__1_43);
  meshes["brow--1"] = mesh_brow__1_43;
  colliders["brow--1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["brow--1"] ??= [];
  destructionGroups["brow--1"].push(node_brow__1_43);

  const endpoint_ear__1_44 = makeAttachmentEndpoint(null);
  const node_ear__1_44 = new THREE.Group();
  node_ear__1_44.name = "Ear__pivot";
  node_ear__1_44.scale.set(1, 1, 1);
  if (endpoint_ear__1_44) {
    node_ear__1_44.position.copy(endpoint_ear__1_44.start);
    node_ear__1_44.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ear__1_44.position.set(-0.099, -0.01, -0.001);
    node_ear__1_44.rotation.set(0.0, 0.0, 0.0);
  }
  node_ear__1_44.userData.sculptComponent = {"id": "ear--1", "name": "Ear", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Ear follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.031, "height": 0.061, "depth": 0.036, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.099, -0.01, -0.001], "rotation": [0, 0, 0], "scale": [0.031, 0.061, 0.036]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ear--1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["ear--1-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_ear__1_44.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ear--1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["head"] ?? root).add(node_ear__1_44);
  nodes["ear--1"] = node_ear__1_44;
  const mesh_ear__1_44Geometry = endpoint_ear__1_44
    ? new THREE.CylinderGeometry(endpoint_ear__1_44.endRadius, endpoint_ear__1_44.baseRadius, endpoint_ear__1_44.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_ear__1_44) {
    mesh_ear__1_44Geometry.scale(0.031, 0.061, 0.036);
  }
  const mesh_ear__1_44 = new THREE.Mesh(
    mesh_ear__1_44Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ear__1_44.name = "Ear";
  if (endpoint_ear__1_44) {
    mesh_ear__1_44.position.copy(endpoint_ear__1_44.midpoint);
    mesh_ear__1_44.quaternion.copy(endpoint_ear__1_44.quaternion);
  }
  mesh_ear__1_44.castShadow = options.castShadow ?? true;
  mesh_ear__1_44.receiveShadow = options.receiveShadow ?? true;
  mesh_ear__1_44.userData.sculptComponent = {"id": "ear--1", "name": "Ear", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Ear follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.031, "height": 0.061, "depth": 0.036, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.099, -0.01, -0.001], "rotation": [0, 0, 0], "scale": [0.031, 0.061, 0.036]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ear--1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["ear--1-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_ear__1_44.add(mesh_ear__1_44);
  meshes["ear--1"] = mesh_ear__1_44;
  colliders["ear--1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["ear--1"] ??= [];
  destructionGroups["ear--1"].push(node_ear__1_44);

  const endpoint_brow_1_45 = makeAttachmentEndpoint(null);
  const node_brow_1_45 = new THREE.Group();
  node_brow_1_45.name = "Angled brow__pivot";
  node_brow_1_45.scale.set(1, 1, 1);
  if (endpoint_brow_1_45) {
    node_brow_1_45.position.copy(endpoint_brow_1_45.start);
    node_brow_1_45.rotation.set(0.0, 0.0, -0.16);
  } else {
    node_brow_1_45.position.set(0.047, 0.026, 0.086);
    node_brow_1_45.rotation.set(0.0, 0.0, -0.16);
  }
  node_brow_1_45.userData.sculptComponent = {"id": "brow-1", "name": "Angled brow", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "Angled brow follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.061, "height": 0.006, "depth": 0.006, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.047, 0.026, 0.086], "rotation": [0, 0, -0.16], "scale": [0.061, 0.006, 0.006]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "brow-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark"}}, "material": "dark", "materialLayers": ["dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["brow-1-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(32, 35, 44, 1)", "secondaryAlbedo": "rgba(29, 32, 40, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_brow_1_45.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "brow-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark"}};
  (nodes["head"] ?? root).add(node_brow_1_45);
  nodes["brow-1"] = node_brow_1_45;
  const mesh_brow_1_45Geometry = endpoint_brow_1_45
    ? new THREE.CylinderGeometry(endpoint_brow_1_45.endRadius, endpoint_brow_1_45.baseRadius, endpoint_brow_1_45.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_brow_1_45) {
    mesh_brow_1_45Geometry.scale(0.061, 0.006, 0.006);
  }
  const mesh_brow_1_45 = new THREE.Mesh(
    mesh_brow_1_45Geometry,
    materialMap["dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_brow_1_45.name = "Angled brow";
  if (endpoint_brow_1_45) {
    mesh_brow_1_45.position.copy(endpoint_brow_1_45.midpoint);
    mesh_brow_1_45.quaternion.copy(endpoint_brow_1_45.quaternion);
  }
  mesh_brow_1_45.castShadow = options.castShadow ?? true;
  mesh_brow_1_45.receiveShadow = options.receiveShadow ?? true;
  mesh_brow_1_45.userData.sculptComponent = {"id": "brow-1", "name": "Angled brow", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "Angled brow follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.061, "height": 0.006, "depth": 0.006, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.047, 0.026, 0.086], "rotation": [0, 0, -0.16], "scale": [0.061, 0.006, 0.006]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "brow-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark"}}, "material": "dark", "materialLayers": ["dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["brow-1-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(32, 35, 44, 1)", "secondaryAlbedo": "rgba(29, 32, 40, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_brow_1_45.add(mesh_brow_1_45);
  meshes["brow-1"] = mesh_brow_1_45;
  colliders["brow-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["brow-1"] ??= [];
  destructionGroups["brow-1"].push(node_brow_1_45);

  const endpoint_ear_1_46 = makeAttachmentEndpoint(null);
  const node_ear_1_46 = new THREE.Group();
  node_ear_1_46.name = "Ear__pivot";
  node_ear_1_46.scale.set(1, 1, 1);
  if (endpoint_ear_1_46) {
    node_ear_1_46.position.copy(endpoint_ear_1_46.start);
    node_ear_1_46.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ear_1_46.position.set(0.099, -0.01, -0.001);
    node_ear_1_46.rotation.set(0.0, 0.0, 0.0);
  }
  node_ear_1_46.userData.sculptComponent = {"id": "ear-1", "name": "Ear", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Ear follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.031, "height": 0.061, "depth": 0.036, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.099, -0.01, -0.001], "rotation": [0, 0, 0], "scale": [0.031, 0.061, 0.036]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ear-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["ear-1-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_ear_1_46.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ear-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["head"] ?? root).add(node_ear_1_46);
  nodes["ear-1"] = node_ear_1_46;
  const mesh_ear_1_46Geometry = endpoint_ear_1_46
    ? new THREE.CylinderGeometry(endpoint_ear_1_46.endRadius, endpoint_ear_1_46.baseRadius, endpoint_ear_1_46.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_ear_1_46) {
    mesh_ear_1_46Geometry.scale(0.031, 0.061, 0.036);
  }
  const mesh_ear_1_46 = new THREE.Mesh(
    mesh_ear_1_46Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ear_1_46.name = "Ear";
  if (endpoint_ear_1_46) {
    mesh_ear_1_46.position.copy(endpoint_ear_1_46.midpoint);
    mesh_ear_1_46.quaternion.copy(endpoint_ear_1_46.quaternion);
  }
  mesh_ear_1_46.castShadow = options.castShadow ?? true;
  mesh_ear_1_46.receiveShadow = options.receiveShadow ?? true;
  mesh_ear_1_46.userData.sculptComponent = {"id": "ear-1", "name": "Ear", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Ear follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.031, "height": 0.061, "depth": 0.036, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.099, -0.01, -0.001], "rotation": [0, 0, 0], "scale": [0.031, 0.061, 0.036]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ear-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["ear-1-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_ear_1_46.add(mesh_ear_1_46);
  meshes["ear-1"] = mesh_ear_1_46;
  colliders["ear-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["ear-1"] ??= [];
  destructionGroups["ear-1"].push(node_ear_1_46);

  const endpoint_earrings_47 = makeAttachmentEndpoint(null);
  const node_earrings_47 = new THREE.Group();
  node_earrings_47.name = "Gold left ear drop__pivot";
  node_earrings_47.scale.set(1, 1, 1);
  if (endpoint_earrings_47) {
    node_earrings_47.position.copy(endpoint_earrings_47.start);
    node_earrings_47.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_earrings_47.position.set(0.102, -0.055, 0.004);
    node_earrings_47.rotation.set(0.0, 0.0, 0.0);
  }
  node_earrings_47.userData.sculptComponent = {"id": "earrings", "name": "Gold left ear drop", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Gold left ear drop follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.005, "height": 0.044, "depth": 0.008, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.102, -0.055, 0.004], "rotation": [0, 0, 0], "scale": [0.005, 0.044, 0.008]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "earrings", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}}, "material": "gold", "materialLayers": ["gold"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["earrings-observed-contour", {"id": "earrings", "description": "Three parallel gold drops on left ear", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(179, 160, 92, 1)", "secondaryAlbedo": "rgba(161, 144, 83, 1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_earrings_47.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "earrings", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}};
  (nodes["head"] ?? root).add(node_earrings_47);
  nodes["earrings"] = node_earrings_47;
  const mesh_earrings_47Geometry = endpoint_earrings_47
    ? new THREE.CylinderGeometry(endpoint_earrings_47.endRadius, endpoint_earrings_47.baseRadius, endpoint_earrings_47.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_earrings_47) {
    mesh_earrings_47Geometry.scale(0.005, 0.044, 0.008);
  }
  const mesh_earrings_47 = new THREE.Mesh(
    mesh_earrings_47Geometry,
    materialMap["gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_earrings_47.name = "Gold left ear drop";
  if (endpoint_earrings_47) {
    mesh_earrings_47.position.copy(endpoint_earrings_47.midpoint);
    mesh_earrings_47.quaternion.copy(endpoint_earrings_47.quaternion);
  }
  mesh_earrings_47.castShadow = options.castShadow ?? true;
  mesh_earrings_47.receiveShadow = options.receiveShadow ?? true;
  mesh_earrings_47.userData.sculptComponent = {"id": "earrings", "name": "Gold left ear drop", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Gold left ear drop follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.005, "height": 0.044, "depth": 0.008, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.102, -0.055, 0.004], "rotation": [0, 0, 0], "scale": [0.005, 0.044, 0.008]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "earrings", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}}, "material": "gold", "materialLayers": ["gold"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["earrings-observed-contour", {"id": "earrings", "description": "Three parallel gold drops on left ear", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(179, 160, 92, 1)", "secondaryAlbedo": "rgba(161, 144, 83, 1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_earrings_47.add(mesh_earrings_47);
  meshes["earrings"] = mesh_earrings_47;
  colliders["earrings"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["earrings"] ??= [];
  destructionGroups["earrings"].push(node_earrings_47);

  const endpoint_earring_1_48 = makeAttachmentEndpoint(null);
  const node_earring_1_48 = new THREE.Group();
  node_earring_1_48.name = "Gold left ear drop__pivot";
  node_earring_1_48.scale.set(1, 1, 1);
  if (endpoint_earring_1_48) {
    node_earring_1_48.position.copy(endpoint_earring_1_48.start);
    node_earring_1_48.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_earring_1_48.position.set(0.10999999999999999, -0.055, 0.004);
    node_earring_1_48.rotation.set(0.0, 0.0, 0.0);
  }
  node_earring_1_48.userData.sculptComponent = {"id": "earring-1", "name": "Gold left ear drop", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Gold left ear drop follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.005, "height": 0.044, "depth": 0.008, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.10999999999999999, -0.055, 0.004], "rotation": [0, 0, 0], "scale": [0.005, 0.044, 0.008]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "earring-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}}, "material": "gold", "materialLayers": ["gold"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["earring-1-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(179, 160, 92, 1)", "secondaryAlbedo": "rgba(161, 144, 83, 1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_earring_1_48.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "earring-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}};
  (nodes["head"] ?? root).add(node_earring_1_48);
  nodes["earring-1"] = node_earring_1_48;
  const mesh_earring_1_48Geometry = endpoint_earring_1_48
    ? new THREE.CylinderGeometry(endpoint_earring_1_48.endRadius, endpoint_earring_1_48.baseRadius, endpoint_earring_1_48.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_earring_1_48) {
    mesh_earring_1_48Geometry.scale(0.005, 0.044, 0.008);
  }
  const mesh_earring_1_48 = new THREE.Mesh(
    mesh_earring_1_48Geometry,
    materialMap["gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_earring_1_48.name = "Gold left ear drop";
  if (endpoint_earring_1_48) {
    mesh_earring_1_48.position.copy(endpoint_earring_1_48.midpoint);
    mesh_earring_1_48.quaternion.copy(endpoint_earring_1_48.quaternion);
  }
  mesh_earring_1_48.castShadow = options.castShadow ?? true;
  mesh_earring_1_48.receiveShadow = options.receiveShadow ?? true;
  mesh_earring_1_48.userData.sculptComponent = {"id": "earring-1", "name": "Gold left ear drop", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Gold left ear drop follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.005, "height": 0.044, "depth": 0.008, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.10999999999999999, -0.055, 0.004], "rotation": [0, 0, 0], "scale": [0.005, 0.044, 0.008]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "earring-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}}, "material": "gold", "materialLayers": ["gold"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["earring-1-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(179, 160, 92, 1)", "secondaryAlbedo": "rgba(161, 144, 83, 1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_earring_1_48.add(mesh_earring_1_48);
  meshes["earring-1"] = mesh_earring_1_48;
  colliders["earring-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["earring-1"] ??= [];
  destructionGroups["earring-1"].push(node_earring_1_48);

  const endpoint_earring_2_49 = makeAttachmentEndpoint(null);
  const node_earring_2_49 = new THREE.Group();
  node_earring_2_49.name = "Gold left ear drop__pivot";
  node_earring_2_49.scale.set(1, 1, 1);
  if (endpoint_earring_2_49) {
    node_earring_2_49.position.copy(endpoint_earring_2_49.start);
    node_earring_2_49.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_earring_2_49.position.set(0.118, -0.055, 0.004);
    node_earring_2_49.rotation.set(0.0, 0.0, 0.0);
  }
  node_earring_2_49.userData.sculptComponent = {"id": "earring-2", "name": "Gold left ear drop", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Gold left ear drop follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.005, "height": 0.044, "depth": 0.008, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.118, -0.055, 0.004], "rotation": [0, 0, 0], "scale": [0.005, 0.044, 0.008]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "earring-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}}, "material": "gold", "materialLayers": ["gold"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["earring-2-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(179, 160, 92, 1)", "secondaryAlbedo": "rgba(161, 144, 83, 1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_earring_2_49.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "earring-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}};
  (nodes["head"] ?? root).add(node_earring_2_49);
  nodes["earring-2"] = node_earring_2_49;
  const mesh_earring_2_49Geometry = endpoint_earring_2_49
    ? new THREE.CylinderGeometry(endpoint_earring_2_49.endRadius, endpoint_earring_2_49.baseRadius, endpoint_earring_2_49.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_earring_2_49) {
    mesh_earring_2_49Geometry.scale(0.005, 0.044, 0.008);
  }
  const mesh_earring_2_49 = new THREE.Mesh(
    mesh_earring_2_49Geometry,
    materialMap["gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_earring_2_49.name = "Gold left ear drop";
  if (endpoint_earring_2_49) {
    mesh_earring_2_49.position.copy(endpoint_earring_2_49.midpoint);
    mesh_earring_2_49.quaternion.copy(endpoint_earring_2_49.quaternion);
  }
  mesh_earring_2_49.castShadow = options.castShadow ?? true;
  mesh_earring_2_49.receiveShadow = options.receiveShadow ?? true;
  mesh_earring_2_49.userData.sculptComponent = {"id": "earring-2", "name": "Gold left ear drop", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Gold left ear drop follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.005, "height": 0.044, "depth": 0.008, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.118, -0.055, 0.004], "rotation": [0, 0, 0], "scale": [0.005, 0.044, 0.008]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "earring-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}}, "material": "gold", "materialLayers": ["gold"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["earring-2-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(179, 160, 92, 1)", "secondaryAlbedo": "rgba(161, 144, 83, 1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_earring_2_49.add(mesh_earring_2_49);
  meshes["earring-2"] = mesh_earring_2_49;
  colliders["earring-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["earring-2"] ??= [];
  destructionGroups["earring-2"].push(node_earring_2_49);

  const endpoint_hand_raised_50 = makeAttachmentEndpoint(null);
  const node_hand_raised_50 = new THREE.Group();
  node_hand_raised_50.name = "Gripping hand__pivot";
  node_hand_raised_50.scale.set(1, 1, 1);
  if (endpoint_hand_raised_50) {
    node_hand_raised_50.position.copy(endpoint_hand_raised_50.start);
    node_hand_raised_50.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hand_raised_50.position.set(-0.2775, 2.3225, 0.0);
    node_hand_raised_50.rotation.set(0.0, 0.0, 0.0);
  }
  node_hand_raised_50.userData.sculptComponent = {"id": "hand-raised", "name": "Gripping hand", "level": "meso", "role": "hand", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Gripping hand follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.085, "height": 0.108, "depth": 0.065, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.2775, 2.3225, 0], "rotation": [0, 0, 0], "scale": [0.085, 0.108, 0.065]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-raised", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hand-raised-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_hand_raised_50.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-raised", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["root"] ?? root).add(node_hand_raised_50);
  nodes["hand-raised"] = node_hand_raised_50;
  const mesh_hand_raised_50Geometry = endpoint_hand_raised_50
    ? new THREE.CylinderGeometry(endpoint_hand_raised_50.endRadius, endpoint_hand_raised_50.baseRadius, endpoint_hand_raised_50.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_hand_raised_50) {
    mesh_hand_raised_50Geometry.scale(0.085, 0.108, 0.065);
  }
  const mesh_hand_raised_50 = new THREE.Mesh(
    mesh_hand_raised_50Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hand_raised_50.name = "Gripping hand";
  if (endpoint_hand_raised_50) {
    mesh_hand_raised_50.position.copy(endpoint_hand_raised_50.midpoint);
    mesh_hand_raised_50.quaternion.copy(endpoint_hand_raised_50.quaternion);
  }
  mesh_hand_raised_50.castShadow = options.castShadow ?? true;
  mesh_hand_raised_50.receiveShadow = options.receiveShadow ?? true;
  mesh_hand_raised_50.userData.sculptComponent = {"id": "hand-raised", "name": "Gripping hand", "level": "meso", "role": "hand", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Gripping hand follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.085, "height": 0.108, "depth": 0.065, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.2775, 2.3225, 0], "rotation": [0, 0, 0], "scale": [0.085, 0.108, 0.065]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-raised", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hand-raised-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_hand_raised_50.add(mesh_hand_raised_50);
  meshes["hand-raised"] = mesh_hand_raised_50;
  colliders["hand-raised"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hand-raised"] ??= [];
  destructionGroups["hand-raised"].push(node_hand_raised_50);

  const endpoint_hand_down_51 = makeAttachmentEndpoint(null);
  const node_hand_down_51 = new THREE.Group();
  node_hand_down_51.name = "Gripping hand__pivot";
  node_hand_down_51.scale.set(1, 1, 1);
  if (endpoint_hand_down_51) {
    node_hand_down_51.position.copy(endpoint_hand_down_51.start);
    node_hand_down_51.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hand_down_51.position.set(0.385, 1.28, 0.0);
    node_hand_down_51.rotation.set(0.0, 0.0, 0.0);
  }
  node_hand_down_51.userData.sculptComponent = {"id": "hand-down", "name": "Gripping hand", "level": "meso", "role": "hand", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Gripping hand follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.075, "height": 0.12, "depth": 0.065, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.385, 1.28, 0], "rotation": [0, 0, 0], "scale": [0.075, 0.12, 0.065]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-down", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hand-down-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_hand_down_51.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-down", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["root"] ?? root).add(node_hand_down_51);
  nodes["hand-down"] = node_hand_down_51;
  const mesh_hand_down_51Geometry = endpoint_hand_down_51
    ? new THREE.CylinderGeometry(endpoint_hand_down_51.endRadius, endpoint_hand_down_51.baseRadius, endpoint_hand_down_51.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_hand_down_51) {
    mesh_hand_down_51Geometry.scale(0.075, 0.12, 0.065);
  }
  const mesh_hand_down_51 = new THREE.Mesh(
    mesh_hand_down_51Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hand_down_51.name = "Gripping hand";
  if (endpoint_hand_down_51) {
    mesh_hand_down_51.position.copy(endpoint_hand_down_51.midpoint);
    mesh_hand_down_51.quaternion.copy(endpoint_hand_down_51.quaternion);
  }
  mesh_hand_down_51.castShadow = options.castShadow ?? true;
  mesh_hand_down_51.receiveShadow = options.receiveShadow ?? true;
  mesh_hand_down_51.userData.sculptComponent = {"id": "hand-down", "name": "Gripping hand", "level": "meso", "role": "hand", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Gripping hand follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.075, "height": 0.12, "depth": 0.065, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.385, 1.28, 0], "rotation": [0, 0, 0], "scale": [0.075, 0.12, 0.065]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-down", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hand-down-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_hand_down_51.add(mesh_hand_down_51);
  meshes["hand-down"] = mesh_hand_down_51;
  colliders["hand-down"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hand-down"] ??= [];
  destructionGroups["hand-down"].push(node_hand_down_51);

  const endpoint_raised_grip_52 = makeAttachmentEndpoint(null);
  const node_raised_grip_52 = new THREE.Group();
  node_raised_grip_52.name = "raised grip__pivot";
  node_raised_grip_52.scale.set(1, 1, 1);
  if (endpoint_raised_grip_52) {
    node_raised_grip_52.position.copy(endpoint_raised_grip_52.start);
    node_raised_grip_52.rotation.set(0.0, 0.0, -2.3518655129052854);
  } else {
    node_raised_grip_52.position.set(-0.185, 0.1775000000000002, 0.0);
    node_raised_grip_52.rotation.set(0.0, 0.0, -2.3518655129052854);
  }
  node_raised_grip_52.userData.sculptComponent = {"id": "raised-grip", "name": "raised grip", "level": "meso", "role": "accessory", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "raised grip follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "profile2D": {"points": [[-0.0235, 0], [0.0235, 0], [0.01645, 0.37568935305648476], [0, 0.4083579924527008], [-0.01645, 0.36752219320743074]], "depth": 0.035}}, "parent": "hand-raised", "attachment": {"anchor": "hand-raised", "maxOffset": 0.13, "contactType": "held-grip", "evidenceRefs": ["full-object"], "notes": "Proximity uses measured geometry centroids, not zero pivots of implicit fields."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.185, 0.1775000000000002, 0], "rotation": [0, 0, -2.3518655129052854], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "raised-grip", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark"}}, "material": "dark", "materialLayers": ["dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["raised-grip-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(32, 35, 44, 1)", "secondaryAlbedo": "rgba(29, 32, 40, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_raised_grip_52.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "raised-grip", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark"}};
  (nodes["hand-raised"] ?? root).add(node_raised_grip_52);
  nodes["raised-grip"] = node_raised_grip_52;
  const mesh_raised_grip_52Geometry = endpoint_raised_grip_52
    ? new THREE.CylinderGeometry(endpoint_raised_grip_52.endRadius, endpoint_raised_grip_52.baseRadius, endpoint_raised_grip_52.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.0235, 0], [0.0235, 0], [0.01645, 0.37568935305648476], [0, 0.4083579924527008], [-0.01645, 0.36752219320743074]], "depth": 0.035});
  if (!endpoint_raised_grip_52) {
    mesh_raised_grip_52Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_raised_grip_52 = new THREE.Mesh(
    mesh_raised_grip_52Geometry,
    materialMap["dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_raised_grip_52.name = "raised grip";
  if (endpoint_raised_grip_52) {
    mesh_raised_grip_52.position.copy(endpoint_raised_grip_52.midpoint);
    mesh_raised_grip_52.quaternion.copy(endpoint_raised_grip_52.quaternion);
  }
  mesh_raised_grip_52.castShadow = options.castShadow ?? true;
  mesh_raised_grip_52.receiveShadow = options.receiveShadow ?? true;
  mesh_raised_grip_52.userData.sculptComponent = {"id": "raised-grip", "name": "raised grip", "level": "meso", "role": "accessory", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "raised grip follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "profile2D": {"points": [[-0.0235, 0], [0.0235, 0], [0.01645, 0.37568935305648476], [0, 0.4083579924527008], [-0.01645, 0.36752219320743074]], "depth": 0.035}}, "parent": "hand-raised", "attachment": {"anchor": "hand-raised", "maxOffset": 0.13, "contactType": "held-grip", "evidenceRefs": ["full-object"], "notes": "Proximity uses measured geometry centroids, not zero pivots of implicit fields."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.185, 0.1775000000000002, 0], "rotation": [0, 0, -2.3518655129052854], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "raised-grip", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark"}}, "material": "dark", "materialLayers": ["dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["raised-grip-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(32, 35, 44, 1)", "secondaryAlbedo": "rgba(29, 32, 40, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_raised_grip_52.add(mesh_raised_grip_52);
  meshes["raised-grip"] = mesh_raised_grip_52;
  colliders["raised-grip"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["raised-grip"] ??= [];
  destructionGroups["raised-grip"].push(node_raised_grip_52);

  const endpoint_raised_sheath_53 = makeAttachmentEndpoint(null);
  const node_raised_sheath_53 = new THREE.Group();
  node_raised_sheath_53.name = "raised sheath__pivot";
  node_raised_sheath_53.scale.set(1, 1, 1);
  if (endpoint_raised_sheath_53) {
    node_raised_sheath_53.position.copy(endpoint_raised_sheath_53.start);
    node_raised_sheath_53.rotation.set(0.0, 0.0, -2.4416997838705483);
  } else {
    node_raised_sheath_53.position.set(0.11000000000000001, -0.10999999999999988, 0.0);
    node_raised_sheath_53.rotation.set(0.0, 0.0, -2.4416997838705483);
  }
  node_raised_sheath_53.userData.sculptComponent = {"id": "raised-sheath", "name": "raised sheath", "level": "meso", "role": "accessory", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "raised sheath follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "profile2D": {"points": [[-0.022, 0], [0.022, 0], [0.015399999999999999, 0.11426162960504267], [0, 0.12419742348374203], [-0.015399999999999999, 0.11177768113536783]], "depth": 0.032}}, "parent": "hand-raised", "attachment": {"anchor": "hand-raised", "maxOffset": 0.28, "contactType": "held-grip", "evidenceRefs": ["full-object"], "notes": "Proximity uses measured geometry centroids, not zero pivots of implicit fields."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.11000000000000001, -0.10999999999999988, 0], "rotation": [0, 0, -2.4416997838705483], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "raised-sheath", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark"}}, "material": "dark", "materialLayers": ["dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["raised-sheath-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(32, 35, 44, 1)", "secondaryAlbedo": "rgba(29, 32, 40, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_raised_sheath_53.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "raised-sheath", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark"}};
  (nodes["hand-raised"] ?? root).add(node_raised_sheath_53);
  nodes["raised-sheath"] = node_raised_sheath_53;
  const mesh_raised_sheath_53Geometry = endpoint_raised_sheath_53
    ? new THREE.CylinderGeometry(endpoint_raised_sheath_53.endRadius, endpoint_raised_sheath_53.baseRadius, endpoint_raised_sheath_53.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.022, 0], [0.022, 0], [0.015399999999999999, 0.11426162960504267], [0, 0.12419742348374203], [-0.015399999999999999, 0.11177768113536783]], "depth": 0.032});
  if (!endpoint_raised_sheath_53) {
    mesh_raised_sheath_53Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_raised_sheath_53 = new THREE.Mesh(
    mesh_raised_sheath_53Geometry,
    materialMap["dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_raised_sheath_53.name = "raised sheath";
  if (endpoint_raised_sheath_53) {
    mesh_raised_sheath_53.position.copy(endpoint_raised_sheath_53.midpoint);
    mesh_raised_sheath_53.quaternion.copy(endpoint_raised_sheath_53.quaternion);
  }
  mesh_raised_sheath_53.castShadow = options.castShadow ?? true;
  mesh_raised_sheath_53.receiveShadow = options.receiveShadow ?? true;
  mesh_raised_sheath_53.userData.sculptComponent = {"id": "raised-sheath", "name": "raised sheath", "level": "meso", "role": "accessory", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "raised sheath follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "profile2D": {"points": [[-0.022, 0], [0.022, 0], [0.015399999999999999, 0.11426162960504267], [0, 0.12419742348374203], [-0.015399999999999999, 0.11177768113536783]], "depth": 0.032}}, "parent": "hand-raised", "attachment": {"anchor": "hand-raised", "maxOffset": 0.28, "contactType": "held-grip", "evidenceRefs": ["full-object"], "notes": "Proximity uses measured geometry centroids, not zero pivots of implicit fields."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.11000000000000001, -0.10999999999999988, 0], "rotation": [0, 0, -2.4416997838705483], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "raised-sheath", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark"}}, "material": "dark", "materialLayers": ["dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["raised-sheath-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(32, 35, 44, 1)", "secondaryAlbedo": "rgba(29, 32, 40, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_raised_sheath_53.add(mesh_raised_sheath_53);
  meshes["raised-sheath"] = mesh_raised_sheath_53;
  colliders["raised-sheath"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["raised-sheath"] ??= [];
  destructionGroups["raised-sheath"].push(node_raised_sheath_53);

  const endpoint_hip_grip_54 = makeAttachmentEndpoint(null);
  const node_hip_grip_54 = new THREE.Group();
  node_hip_grip_54.name = "hip grip__pivot";
  node_hip_grip_54.scale.set(1, 1, 1);
  if (endpoint_hip_grip_54) {
    node_hip_grip_54.position.copy(endpoint_hip_grip_54.start);
    node_hip_grip_54.rotation.set(0.0, 0.0, -2.3868597211192935);
  } else {
    node_hip_grip_54.position.set(-0.48, 1.8975, 0.0);
    node_hip_grip_54.rotation.set(0.0, 0.0, -2.3868597211192935);
  }
  node_hip_grip_54.userData.sculptComponent = {"id": "hip-grip", "name": "hip grip", "level": "meso", "role": "accessory", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "hip grip follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "profile2D": {"points": [[-0.024, 0], [0.024, 0], [0.0168, 0.26521902269633674], [0, 0.2882815464090617], [-0.0168, 0.2594533917681555]], "depth": 0.034}}, "parent": "haramaki", "attachment": {"anchor": "haramaki", "maxOffset": 0.45, "contactType": "waist-mounted", "evidenceRefs": ["full-object"], "notes": "Proximity uses measured geometry centroids, not zero pivots of implicit fields."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.48, 1.8975, 0], "rotation": [0, 0, -2.3868597211192935], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hip-grip", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}}, "material": "white", "materialLayers": ["white"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hip-grip-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 234, 222, 1)", "secondaryAlbedo": "rgba(214, 211, 200, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_hip_grip_54.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hip-grip", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}};
  (nodes["haramaki"] ?? root).add(node_hip_grip_54);
  nodes["hip-grip"] = node_hip_grip_54;
  const mesh_hip_grip_54Geometry = endpoint_hip_grip_54
    ? new THREE.CylinderGeometry(endpoint_hip_grip_54.endRadius, endpoint_hip_grip_54.baseRadius, endpoint_hip_grip_54.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.024, 0], [0.024, 0], [0.0168, 0.26521902269633674], [0, 0.2882815464090617], [-0.0168, 0.2594533917681555]], "depth": 0.034});
  if (!endpoint_hip_grip_54) {
    mesh_hip_grip_54Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hip_grip_54 = new THREE.Mesh(
    mesh_hip_grip_54Geometry,
    materialMap["white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hip_grip_54.name = "hip grip";
  if (endpoint_hip_grip_54) {
    mesh_hip_grip_54.position.copy(endpoint_hip_grip_54.midpoint);
    mesh_hip_grip_54.quaternion.copy(endpoint_hip_grip_54.quaternion);
  }
  mesh_hip_grip_54.castShadow = options.castShadow ?? true;
  mesh_hip_grip_54.receiveShadow = options.receiveShadow ?? true;
  mesh_hip_grip_54.userData.sculptComponent = {"id": "hip-grip", "name": "hip grip", "level": "meso", "role": "accessory", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "hip grip follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "profile2D": {"points": [[-0.024, 0], [0.024, 0], [0.0168, 0.26521902269633674], [0, 0.2882815464090617], [-0.0168, 0.2594533917681555]], "depth": 0.034}}, "parent": "haramaki", "attachment": {"anchor": "haramaki", "maxOffset": 0.45, "contactType": "waist-mounted", "evidenceRefs": ["full-object"], "notes": "Proximity uses measured geometry centroids, not zero pivots of implicit fields."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.48, 1.8975, 0], "rotation": [0, 0, -2.3868597211192935], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hip-grip", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}}, "material": "white", "materialLayers": ["white"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hip-grip-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 234, 222, 1)", "secondaryAlbedo": "rgba(214, 211, 200, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_hip_grip_54.add(mesh_hip_grip_54);
  meshes["hip-grip"] = mesh_hip_grip_54;
  colliders["hip-grip"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hip-grip"] ??= [];
  destructionGroups["hip-grip"].push(node_hip_grip_54);

  const endpoint_hip_sheath_55 = makeAttachmentEndpoint(null);
  const node_hip_sheath_55 = new THREE.Group();
  node_hip_sheath_55.name = "hip sheath__pivot";
  node_hip_sheath_55.scale.set(1, 1, 1);
  if (endpoint_hip_sheath_55) {
    node_hip_sheath_55.position.copy(endpoint_hip_sheath_55.start);
    node_hip_sheath_55.rotation.set(0.0, 0.0, -2.5323166640181642);
  } else {
    node_hip_sheath_55.position.set(-0.265, 1.6675, 0.0);
    node_hip_sheath_55.rotation.set(0.0, 0.0, -2.5323166640181642);
  }
  node_hip_sheath_55.userData.sculptComponent = {"id": "hip-sheath", "name": "hip sheath", "level": "meso", "role": "accessory", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "hip sheath follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "profile2D": {"points": [[-0.0245, 0], [0.0245, 0], [0.01715, 1.1695449114933552], [0, 1.2712444690145164], [-0.01715, 1.1441200221130647]], "depth": 0.039}}, "parent": "haramaki", "attachment": {"anchor": "haramaki", "maxOffset": 0.75, "contactType": "waist-mounted", "evidenceRefs": ["full-object"], "notes": "Proximity uses measured geometry centroids, not zero pivots of implicit fields."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.265, 1.6675, 0], "rotation": [0, 0, -2.5323166640181642], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hip-sheath", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark"}}, "material": "dark", "materialLayers": ["dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hip-sheath-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(32, 35, 44, 1)", "secondaryAlbedo": "rgba(29, 32, 40, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_hip_sheath_55.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hip-sheath", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark"}};
  (nodes["haramaki"] ?? root).add(node_hip_sheath_55);
  nodes["hip-sheath"] = node_hip_sheath_55;
  const mesh_hip_sheath_55Geometry = endpoint_hip_sheath_55
    ? new THREE.CylinderGeometry(endpoint_hip_sheath_55.endRadius, endpoint_hip_sheath_55.baseRadius, endpoint_hip_sheath_55.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.0245, 0], [0.0245, 0], [0.01715, 1.1695449114933552], [0, 1.2712444690145164], [-0.01715, 1.1441200221130647]], "depth": 0.039});
  if (!endpoint_hip_sheath_55) {
    mesh_hip_sheath_55Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hip_sheath_55 = new THREE.Mesh(
    mesh_hip_sheath_55Geometry,
    materialMap["dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hip_sheath_55.name = "hip sheath";
  if (endpoint_hip_sheath_55) {
    mesh_hip_sheath_55.position.copy(endpoint_hip_sheath_55.midpoint);
    mesh_hip_sheath_55.quaternion.copy(endpoint_hip_sheath_55.quaternion);
  }
  mesh_hip_sheath_55.castShadow = options.castShadow ?? true;
  mesh_hip_sheath_55.receiveShadow = options.receiveShadow ?? true;
  mesh_hip_sheath_55.userData.sculptComponent = {"id": "hip-sheath", "name": "hip sheath", "level": "meso", "role": "accessory", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "hip sheath follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "profile2D": {"points": [[-0.0245, 0], [0.0245, 0], [0.01715, 1.1695449114933552], [0, 1.2712444690145164], [-0.01715, 1.1441200221130647]], "depth": 0.039}}, "parent": "haramaki", "attachment": {"anchor": "haramaki", "maxOffset": 0.75, "contactType": "waist-mounted", "evidenceRefs": ["full-object"], "notes": "Proximity uses measured geometry centroids, not zero pivots of implicit fields."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.265, 1.6675, 0], "rotation": [0, 0, -2.5323166640181642], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hip-sheath", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark"}}, "material": "dark", "materialLayers": ["dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hip-sheath-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(32, 35, 44, 1)", "secondaryAlbedo": "rgba(29, 32, 40, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_hip_sheath_55.add(mesh_hip_sheath_55);
  meshes["hip-sheath"] = mesh_hip_sheath_55;
  colliders["hip-sheath"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hip-sheath"] ??= [];
  destructionGroups["hip-sheath"].push(node_hip_sheath_55);

  const endpoint_low_grip_56 = makeAttachmentEndpoint(null);
  const node_low_grip_56 = new THREE.Group();
  node_low_grip_56.name = "low grip__pivot";
  node_low_grip_56.scale.set(1, 1, 1);
  if (endpoint_low_grip_56) {
    node_low_grip_56.position.copy(endpoint_low_grip_56.start);
    node_low_grip_56.rotation.set(0.0, 0.0, -2.773611717444809);
  } else {
    node_low_grip_56.position.set(-0.05249999999999999, 0.11499999999999999, 0.0);
    node_low_grip_56.rotation.set(0.0, 0.0, -2.773611717444809);
  }
  node_low_grip_56.userData.sculptComponent = {"id": "low-grip", "name": "low grip", "level": "meso", "role": "accessory", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "low grip follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "profile2D": {"points": [[-0.0225, 0], [0.0225, 0], [0.01575, 0.204596603099856], [0, 0.22238761206506086], [-0.01575, 0.20014885085855477]], "depth": 0.032}}, "parent": "hand-down", "attachment": {"anchor": "hand-down", "maxOffset": 0.14, "contactType": "held-grip", "evidenceRefs": ["full-object"], "notes": "Proximity uses measured geometry centroids, not zero pivots of implicit fields."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.05249999999999999, 0.11499999999999999, 0], "rotation": [0, 0, -2.773611717444809], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "low-grip", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark"}}, "material": "dark", "materialLayers": ["dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["low-grip-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(32, 35, 44, 1)", "secondaryAlbedo": "rgba(29, 32, 40, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_low_grip_56.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "low-grip", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark"}};
  (nodes["hand-down"] ?? root).add(node_low_grip_56);
  nodes["low-grip"] = node_low_grip_56;
  const mesh_low_grip_56Geometry = endpoint_low_grip_56
    ? new THREE.CylinderGeometry(endpoint_low_grip_56.endRadius, endpoint_low_grip_56.baseRadius, endpoint_low_grip_56.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.0225, 0], [0.0225, 0], [0.01575, 0.204596603099856], [0, 0.22238761206506086], [-0.01575, 0.20014885085855477]], "depth": 0.032});
  if (!endpoint_low_grip_56) {
    mesh_low_grip_56Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_low_grip_56 = new THREE.Mesh(
    mesh_low_grip_56Geometry,
    materialMap["dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_low_grip_56.name = "low grip";
  if (endpoint_low_grip_56) {
    mesh_low_grip_56.position.copy(endpoint_low_grip_56.midpoint);
    mesh_low_grip_56.quaternion.copy(endpoint_low_grip_56.quaternion);
  }
  mesh_low_grip_56.castShadow = options.castShadow ?? true;
  mesh_low_grip_56.receiveShadow = options.receiveShadow ?? true;
  mesh_low_grip_56.userData.sculptComponent = {"id": "low-grip", "name": "low grip", "level": "meso", "role": "accessory", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "low grip follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "profile2D": {"points": [[-0.0225, 0], [0.0225, 0], [0.01575, 0.204596603099856], [0, 0.22238761206506086], [-0.01575, 0.20014885085855477]], "depth": 0.032}}, "parent": "hand-down", "attachment": {"anchor": "hand-down", "maxOffset": 0.14, "contactType": "held-grip", "evidenceRefs": ["full-object"], "notes": "Proximity uses measured geometry centroids, not zero pivots of implicit fields."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.05249999999999999, 0.11499999999999999, 0], "rotation": [0, 0, -2.773611717444809], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "low-grip", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark"}}, "material": "dark", "materialLayers": ["dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["low-grip-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(32, 35, 44, 1)", "secondaryAlbedo": "rgba(29, 32, 40, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_low_grip_56.add(mesh_low_grip_56);
  meshes["low-grip"] = mesh_low_grip_56;
  colliders["low-grip"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["low-grip"] ??= [];
  destructionGroups["low-grip"].push(node_low_grip_56);

  const endpoint_blade_57 = makeAttachmentEndpoint(null);
  const node_blade_57 = new THREE.Group();
  node_blade_57.name = "blade__pivot";
  node_blade_57.scale.set(1, 1, 1);
  if (endpoint_blade_57) {
    node_blade_57.position.copy(endpoint_blade_57.start);
    node_blade_57.rotation.set(0.0, 0.0, -2.642768944414276);
  } else {
    node_blade_57.position.set(0.04749999999999999, -0.13749999999999996, 0.0);
    node_blade_57.rotation.set(0.0, 0.0, -2.642768944414276);
  }
  node_blade_57.userData.sculptComponent = {"id": "blade", "name": "blade", "level": "meso", "role": "accessory", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "blade follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "profile2D": {"points": [[-0.0235, 0], [0.0235, 0], [0.01645, 1.0529002089466981], [0, 1.1444567488551065], [-0.01645, 1.0300110739695958]], "depth": 0.011}}, "parent": "hand-down", "attachment": {"anchor": "hand-down", "maxOffset": 0.8, "contactType": "held-grip", "evidenceRefs": ["full-object"], "notes": "Proximity uses measured geometry centroids, not zero pivots of implicit fields."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.04749999999999999, -0.13749999999999996, 0], "rotation": [0, 0, -2.642768944414276], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "blade", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "steel"}}, "material": "steel", "materialLayers": ["steel"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["blade-observed-contour", {"id": "blade-edge", "description": "Curved steel blade with thin pale cutting edge", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(180, 192, 199, 1)", "secondaryAlbedo": "rgba(162, 173, 179, 1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_blade_57.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "blade", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "steel"}};
  (nodes["hand-down"] ?? root).add(node_blade_57);
  nodes["blade"] = node_blade_57;
  const mesh_blade_57Geometry = endpoint_blade_57
    ? new THREE.CylinderGeometry(endpoint_blade_57.endRadius, endpoint_blade_57.baseRadius, endpoint_blade_57.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.0235, 0], [0.0235, 0], [0.01645, 1.0529002089466981], [0, 1.1444567488551065], [-0.01645, 1.0300110739695958]], "depth": 0.011});
  if (!endpoint_blade_57) {
    mesh_blade_57Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_blade_57 = new THREE.Mesh(
    mesh_blade_57Geometry,
    materialMap["steel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_blade_57.name = "blade";
  if (endpoint_blade_57) {
    mesh_blade_57.position.copy(endpoint_blade_57.midpoint);
    mesh_blade_57.quaternion.copy(endpoint_blade_57.quaternion);
  }
  mesh_blade_57.castShadow = options.castShadow ?? true;
  mesh_blade_57.receiveShadow = options.receiveShadow ?? true;
  mesh_blade_57.userData.sculptComponent = {"id": "blade", "name": "blade", "level": "meso", "role": "accessory", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "blade follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "profile2D": {"points": [[-0.0235, 0], [0.0235, 0], [0.01645, 1.0529002089466981], [0, 1.1444567488551065], [-0.01645, 1.0300110739695958]], "depth": 0.011}}, "parent": "hand-down", "attachment": {"anchor": "hand-down", "maxOffset": 0.8, "contactType": "held-grip", "evidenceRefs": ["full-object"], "notes": "Proximity uses measured geometry centroids, not zero pivots of implicit fields."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.04749999999999999, -0.13749999999999996, 0], "rotation": [0, 0, -2.642768944414276], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "blade", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "steel"}}, "material": "steel", "materialLayers": ["steel"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["blade-observed-contour", {"id": "blade-edge", "description": "Curved steel blade with thin pale cutting edge", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(180, 192, 199, 1)", "secondaryAlbedo": "rgba(162, 173, 179, 1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_blade_57.add(mesh_blade_57);
  meshes["blade"] = mesh_blade_57;
  colliders["blade"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["blade"] ??= [];
  destructionGroups["blade"].push(node_blade_57);

  const endpoint_sword_guards_58 = makeAttachmentEndpoint(null);
  const node_sword_guards_58 = new THREE.Group();
  node_sword_guards_58.name = "Gold katana guard__pivot";
  node_sword_guards_58.scale.set(1, 1, 1);
  if (endpoint_sword_guards_58) {
    node_sword_guards_58.position.copy(endpoint_sword_guards_58.start);
    node_sword_guards_58.rotation.set(0.0, 0.0, -0.55);
  } else {
    node_sword_guards_58.position.set(0.07750000000000001, -0.08499999999999996, 0.0);
    node_sword_guards_58.rotation.set(0.0, 0.0, -0.55);
  }
  node_sword_guards_58.userData.sculptComponent = {"id": "sword-guards", "name": "Gold katana guard", "level": "meso", "role": "accessory", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Gold katana guard follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-raised", "attachment": {"anchor": "hand-raised", "maxOffset": 0.18, "contactType": "held-grip", "evidenceRefs": ["full-object"], "notes": "Proximity uses measured geometry centroids, not zero pivots of implicit fields."}, "dimensions": {"width": 0.12, "height": 0.048, "depth": 0.09, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.07750000000000001, -0.08499999999999996, 0], "rotation": [0, 0, -0.55], "scale": [0.12, 0.048, 0.09]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "sword-guards", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}}, "material": "gold", "materialLayers": ["gold"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["sword-guards-observed-contour", {"id": "sword-guards", "description": "Gold multi-lobed guards at three hilts", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(179, 160, 92, 1)", "secondaryAlbedo": "rgba(161, 144, 83, 1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_sword_guards_58.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "sword-guards", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}};
  (nodes["hand-raised"] ?? root).add(node_sword_guards_58);
  nodes["sword-guards"] = node_sword_guards_58;
  const mesh_sword_guards_58Geometry = endpoint_sword_guards_58
    ? new THREE.CylinderGeometry(endpoint_sword_guards_58.endRadius, endpoint_sword_guards_58.baseRadius, endpoint_sword_guards_58.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_sword_guards_58) {
    mesh_sword_guards_58Geometry.scale(0.12, 0.048, 0.09);
  }
  const mesh_sword_guards_58 = new THREE.Mesh(
    mesh_sword_guards_58Geometry,
    materialMap["gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_sword_guards_58.name = "Gold katana guard";
  if (endpoint_sword_guards_58) {
    mesh_sword_guards_58.position.copy(endpoint_sword_guards_58.midpoint);
    mesh_sword_guards_58.quaternion.copy(endpoint_sword_guards_58.quaternion);
  }
  mesh_sword_guards_58.castShadow = options.castShadow ?? true;
  mesh_sword_guards_58.receiveShadow = options.receiveShadow ?? true;
  mesh_sword_guards_58.userData.sculptComponent = {"id": "sword-guards", "name": "Gold katana guard", "level": "meso", "role": "accessory", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Gold katana guard follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-raised", "attachment": {"anchor": "hand-raised", "maxOffset": 0.18, "contactType": "held-grip", "evidenceRefs": ["full-object"], "notes": "Proximity uses measured geometry centroids, not zero pivots of implicit fields."}, "dimensions": {"width": 0.12, "height": 0.048, "depth": 0.09, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.07750000000000001, -0.08499999999999996, 0], "rotation": [0, 0, -0.55], "scale": [0.12, 0.048, 0.09]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "sword-guards", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}}, "material": "gold", "materialLayers": ["gold"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["sword-guards-observed-contour", {"id": "sword-guards", "description": "Gold multi-lobed guards at three hilts", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(179, 160, 92, 1)", "secondaryAlbedo": "rgba(161, 144, 83, 1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_sword_guards_58.add(mesh_sword_guards_58);
  meshes["sword-guards"] = mesh_sword_guards_58;
  colliders["sword-guards"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["sword-guards"] ??= [];
  destructionGroups["sword-guards"].push(node_sword_guards_58);

  const endpoint_guard_1_59 = makeAttachmentEndpoint(null);
  const node_guard_1_59 = new THREE.Group();
  node_guard_1_59.name = "Gold katana guard__pivot";
  node_guard_1_59.scale.set(1, 1, 1);
  if (endpoint_guard_1_59) {
    node_guard_1_59.position.copy(endpoint_guard_1_59.start);
    node_guard_1_59.rotation.set(0.0, 0.0, -0.55);
  } else {
    node_guard_1_59.position.set(-0.285, 1.685, 0.0);
    node_guard_1_59.rotation.set(0.0, 0.0, -0.55);
  }
  node_guard_1_59.userData.sculptComponent = {"id": "guard-1", "name": "Gold katana guard", "level": "meso", "role": "accessory", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Gold katana guard follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "haramaki", "attachment": {"anchor": "haramaki", "maxOffset": 0.36, "contactType": "waist-mounted", "evidenceRefs": ["full-object"], "notes": "Proximity uses measured geometry centroids, not zero pivots of implicit fields."}, "dimensions": {"width": 0.12, "height": 0.048, "depth": 0.09, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.285, 1.685, 0], "rotation": [0, 0, -0.55], "scale": [0.12, 0.048, 0.09]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "guard-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}}, "material": "gold", "materialLayers": ["gold"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["guard-1-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(179, 160, 92, 1)", "secondaryAlbedo": "rgba(161, 144, 83, 1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_guard_1_59.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "guard-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}};
  (nodes["haramaki"] ?? root).add(node_guard_1_59);
  nodes["guard-1"] = node_guard_1_59;
  const mesh_guard_1_59Geometry = endpoint_guard_1_59
    ? new THREE.CylinderGeometry(endpoint_guard_1_59.endRadius, endpoint_guard_1_59.baseRadius, endpoint_guard_1_59.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_guard_1_59) {
    mesh_guard_1_59Geometry.scale(0.12, 0.048, 0.09);
  }
  const mesh_guard_1_59 = new THREE.Mesh(
    mesh_guard_1_59Geometry,
    materialMap["gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_guard_1_59.name = "Gold katana guard";
  if (endpoint_guard_1_59) {
    mesh_guard_1_59.position.copy(endpoint_guard_1_59.midpoint);
    mesh_guard_1_59.quaternion.copy(endpoint_guard_1_59.quaternion);
  }
  mesh_guard_1_59.castShadow = options.castShadow ?? true;
  mesh_guard_1_59.receiveShadow = options.receiveShadow ?? true;
  mesh_guard_1_59.userData.sculptComponent = {"id": "guard-1", "name": "Gold katana guard", "level": "meso", "role": "accessory", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Gold katana guard follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "haramaki", "attachment": {"anchor": "haramaki", "maxOffset": 0.36, "contactType": "waist-mounted", "evidenceRefs": ["full-object"], "notes": "Proximity uses measured geometry centroids, not zero pivots of implicit fields."}, "dimensions": {"width": 0.12, "height": 0.048, "depth": 0.09, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.285, 1.685, 0], "rotation": [0, 0, -0.55], "scale": [0.12, 0.048, 0.09]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "guard-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}}, "material": "gold", "materialLayers": ["gold"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["guard-1-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(179, 160, 92, 1)", "secondaryAlbedo": "rgba(161, 144, 83, 1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_guard_1_59.add(mesh_guard_1_59);
  meshes["guard-1"] = mesh_guard_1_59;
  colliders["guard-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["guard-1"] ??= [];
  destructionGroups["guard-1"].push(node_guard_1_59);

  const endpoint_guard_2_60 = makeAttachmentEndpoint(null);
  const node_guard_2_60 = new THREE.Group();
  node_guard_2_60.name = "Gold katana guard__pivot";
  node_guard_2_60.scale.set(1, 1, 1);
  if (endpoint_guard_2_60) {
    node_guard_2_60.position.copy(endpoint_guard_2_60.start);
    node_guard_2_60.rotation.set(0.0, 0.0, -0.55);
  } else {
    node_guard_2_60.position.set(0.02999999999999997, -0.11749999999999994, 0.0);
    node_guard_2_60.rotation.set(0.0, 0.0, -0.55);
  }
  node_guard_2_60.userData.sculptComponent = {"id": "guard-2", "name": "Gold katana guard", "level": "meso", "role": "accessory", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Gold katana guard follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-down", "attachment": {"anchor": "hand-down", "maxOffset": 0.2, "contactType": "held-grip", "evidenceRefs": ["full-object"], "notes": "Proximity uses measured geometry centroids, not zero pivots of implicit fields."}, "dimensions": {"width": 0.12, "height": 0.048, "depth": 0.09, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.02999999999999997, -0.11749999999999994, 0], "rotation": [0, 0, -0.55], "scale": [0.12, 0.048, 0.09]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "guard-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}}, "material": "gold", "materialLayers": ["gold"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["guard-2-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(179, 160, 92, 1)", "secondaryAlbedo": "rgba(161, 144, 83, 1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_guard_2_60.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "guard-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}};
  (nodes["hand-down"] ?? root).add(node_guard_2_60);
  nodes["guard-2"] = node_guard_2_60;
  const mesh_guard_2_60Geometry = endpoint_guard_2_60
    ? new THREE.CylinderGeometry(endpoint_guard_2_60.endRadius, endpoint_guard_2_60.baseRadius, endpoint_guard_2_60.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_guard_2_60) {
    mesh_guard_2_60Geometry.scale(0.12, 0.048, 0.09);
  }
  const mesh_guard_2_60 = new THREE.Mesh(
    mesh_guard_2_60Geometry,
    materialMap["gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_guard_2_60.name = "Gold katana guard";
  if (endpoint_guard_2_60) {
    mesh_guard_2_60.position.copy(endpoint_guard_2_60.midpoint);
    mesh_guard_2_60.quaternion.copy(endpoint_guard_2_60.quaternion);
  }
  mesh_guard_2_60.castShadow = options.castShadow ?? true;
  mesh_guard_2_60.receiveShadow = options.receiveShadow ?? true;
  mesh_guard_2_60.userData.sculptComponent = {"id": "guard-2", "name": "Gold katana guard", "level": "meso", "role": "accessory", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Gold katana guard follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-down", "attachment": {"anchor": "hand-down", "maxOffset": 0.2, "contactType": "held-grip", "evidenceRefs": ["full-object"], "notes": "Proximity uses measured geometry centroids, not zero pivots of implicit fields."}, "dimensions": {"width": 0.12, "height": 0.048, "depth": 0.09, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.02999999999999997, -0.11749999999999994, 0], "rotation": [0, 0, -0.55], "scale": [0.12, 0.048, 0.09]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "guard-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}}, "material": "gold", "materialLayers": ["gold"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["guard-2-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(179, 160, 92, 1)", "secondaryAlbedo": "rgba(161, 144, 83, 1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_guard_2_60.add(mesh_guard_2_60);
  meshes["guard-2"] = mesh_guard_2_60;
  colliders["guard-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["guard-2"] ??= [];
  destructionGroups["guard-2"].push(node_guard_2_60);

  const endpoint_robe_toggles_61 = makeAttachmentEndpoint(null);
  const node_robe_toggles_61 = new THREE.Group();
  node_robe_toggles_61.name = "Robe front toggle__pivot";
  node_robe_toggles_61.scale.set(1, 1, 1);
  if (endpoint_robe_toggles_61) {
    node_robe_toggles_61.position.copy(endpoint_robe_toggles_61.start);
    node_robe_toggles_61.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_robe_toggles_61.position.set(-0.155, 1.2775, 0.19);
    node_robe_toggles_61.rotation.set(0.0, 0.0, 0.0);
  }
  node_robe_toggles_61.userData.sculptComponent = {"id": "robe-toggles", "name": "Robe front toggle", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Robe front toggle follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.055, "height": 0.014, "depth": 0.018, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.155, 1.2775, 0.19], "rotation": [0, 0, 0], "scale": [0.055, 0.014, 0.018]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "robe-toggles", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}}, "material": "gold", "materialLayers": ["gold"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["robe-toggles-observed-contour", {"id": "robe-toggles", "description": "Four tan double-lobed toggles down robe front", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(179, 160, 92, 1)", "secondaryAlbedo": "rgba(161, 144, 83, 1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_robe_toggles_61.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "robe-toggles", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}};
  (nodes["root"] ?? root).add(node_robe_toggles_61);
  nodes["robe-toggles"] = node_robe_toggles_61;
  const mesh_robe_toggles_61Geometry = endpoint_robe_toggles_61
    ? new THREE.CylinderGeometry(endpoint_robe_toggles_61.endRadius, endpoint_robe_toggles_61.baseRadius, endpoint_robe_toggles_61.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_robe_toggles_61) {
    mesh_robe_toggles_61Geometry.scale(0.055, 0.014, 0.018);
  }
  const mesh_robe_toggles_61 = new THREE.Mesh(
    mesh_robe_toggles_61Geometry,
    materialMap["gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_robe_toggles_61.name = "Robe front toggle";
  if (endpoint_robe_toggles_61) {
    mesh_robe_toggles_61.position.copy(endpoint_robe_toggles_61.midpoint);
    mesh_robe_toggles_61.quaternion.copy(endpoint_robe_toggles_61.quaternion);
  }
  mesh_robe_toggles_61.castShadow = options.castShadow ?? true;
  mesh_robe_toggles_61.receiveShadow = options.receiveShadow ?? true;
  mesh_robe_toggles_61.userData.sculptComponent = {"id": "robe-toggles", "name": "Robe front toggle", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Robe front toggle follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.055, "height": 0.014, "depth": 0.018, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.155, 1.2775, 0.19], "rotation": [0, 0, 0], "scale": [0.055, 0.014, 0.018]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "robe-toggles", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}}, "material": "gold", "materialLayers": ["gold"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["robe-toggles-observed-contour", {"id": "robe-toggles", "description": "Four tan double-lobed toggles down robe front", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(179, 160, 92, 1)", "secondaryAlbedo": "rgba(161, 144, 83, 1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_robe_toggles_61.add(mesh_robe_toggles_61);
  meshes["robe-toggles"] = mesh_robe_toggles_61;
  colliders["robe-toggles"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["robe-toggles"] ??= [];
  destructionGroups["robe-toggles"].push(node_robe_toggles_61);

  const endpoint_toggle_1_62 = makeAttachmentEndpoint(null);
  const node_toggle_1_62 = new THREE.Group();
  node_toggle_1_62.name = "Robe front toggle__pivot";
  node_toggle_1_62.scale.set(1, 1, 1);
  if (endpoint_toggle_1_62) {
    node_toggle_1_62.position.copy(endpoint_toggle_1_62.start);
    node_toggle_1_62.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_toggle_1_62.position.set(-0.1725, 1.1275, 0.19);
    node_toggle_1_62.rotation.set(0.0, 0.0, 0.0);
  }
  node_toggle_1_62.userData.sculptComponent = {"id": "toggle-1", "name": "Robe front toggle", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Robe front toggle follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.055, "height": 0.014, "depth": 0.018, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.1725, 1.1275, 0.19], "rotation": [0, 0, 0], "scale": [0.055, 0.014, 0.018]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "toggle-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}}, "material": "gold", "materialLayers": ["gold"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["toggle-1-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(179, 160, 92, 1)", "secondaryAlbedo": "rgba(161, 144, 83, 1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_toggle_1_62.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "toggle-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}};
  (nodes["root"] ?? root).add(node_toggle_1_62);
  nodes["toggle-1"] = node_toggle_1_62;
  const mesh_toggle_1_62Geometry = endpoint_toggle_1_62
    ? new THREE.CylinderGeometry(endpoint_toggle_1_62.endRadius, endpoint_toggle_1_62.baseRadius, endpoint_toggle_1_62.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_toggle_1_62) {
    mesh_toggle_1_62Geometry.scale(0.055, 0.014, 0.018);
  }
  const mesh_toggle_1_62 = new THREE.Mesh(
    mesh_toggle_1_62Geometry,
    materialMap["gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_toggle_1_62.name = "Robe front toggle";
  if (endpoint_toggle_1_62) {
    mesh_toggle_1_62.position.copy(endpoint_toggle_1_62.midpoint);
    mesh_toggle_1_62.quaternion.copy(endpoint_toggle_1_62.quaternion);
  }
  mesh_toggle_1_62.castShadow = options.castShadow ?? true;
  mesh_toggle_1_62.receiveShadow = options.receiveShadow ?? true;
  mesh_toggle_1_62.userData.sculptComponent = {"id": "toggle-1", "name": "Robe front toggle", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Robe front toggle follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.055, "height": 0.014, "depth": 0.018, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.1725, 1.1275, 0.19], "rotation": [0, 0, 0], "scale": [0.055, 0.014, 0.018]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "toggle-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}}, "material": "gold", "materialLayers": ["gold"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["toggle-1-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(179, 160, 92, 1)", "secondaryAlbedo": "rgba(161, 144, 83, 1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_toggle_1_62.add(mesh_toggle_1_62);
  meshes["toggle-1"] = mesh_toggle_1_62;
  colliders["toggle-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["toggle-1"] ??= [];
  destructionGroups["toggle-1"].push(node_toggle_1_62);

  const endpoint_toggle_2_63 = makeAttachmentEndpoint(null);
  const node_toggle_2_63 = new THREE.Group();
  node_toggle_2_63.name = "Robe front toggle__pivot";
  node_toggle_2_63.scale.set(1, 1, 1);
  if (endpoint_toggle_2_63) {
    node_toggle_2_63.position.copy(endpoint_toggle_2_63.start);
    node_toggle_2_63.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_toggle_2_63.position.set(-0.1975, 0.975, 0.19);
    node_toggle_2_63.rotation.set(0.0, 0.0, 0.0);
  }
  node_toggle_2_63.userData.sculptComponent = {"id": "toggle-2", "name": "Robe front toggle", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Robe front toggle follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.055, "height": 0.014, "depth": 0.018, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.1975, 0.975, 0.19], "rotation": [0, 0, 0], "scale": [0.055, 0.014, 0.018]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "toggle-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}}, "material": "gold", "materialLayers": ["gold"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["toggle-2-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(179, 160, 92, 1)", "secondaryAlbedo": "rgba(161, 144, 83, 1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_toggle_2_63.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "toggle-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}};
  (nodes["root"] ?? root).add(node_toggle_2_63);
  nodes["toggle-2"] = node_toggle_2_63;
  const mesh_toggle_2_63Geometry = endpoint_toggle_2_63
    ? new THREE.CylinderGeometry(endpoint_toggle_2_63.endRadius, endpoint_toggle_2_63.baseRadius, endpoint_toggle_2_63.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_toggle_2_63) {
    mesh_toggle_2_63Geometry.scale(0.055, 0.014, 0.018);
  }
  const mesh_toggle_2_63 = new THREE.Mesh(
    mesh_toggle_2_63Geometry,
    materialMap["gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_toggle_2_63.name = "Robe front toggle";
  if (endpoint_toggle_2_63) {
    mesh_toggle_2_63.position.copy(endpoint_toggle_2_63.midpoint);
    mesh_toggle_2_63.quaternion.copy(endpoint_toggle_2_63.quaternion);
  }
  mesh_toggle_2_63.castShadow = options.castShadow ?? true;
  mesh_toggle_2_63.receiveShadow = options.receiveShadow ?? true;
  mesh_toggle_2_63.userData.sculptComponent = {"id": "toggle-2", "name": "Robe front toggle", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Robe front toggle follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.055, "height": 0.014, "depth": 0.018, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.1975, 0.975, 0.19], "rotation": [0, 0, 0], "scale": [0.055, 0.014, 0.018]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "toggle-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}}, "material": "gold", "materialLayers": ["gold"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["toggle-2-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(179, 160, 92, 1)", "secondaryAlbedo": "rgba(161, 144, 83, 1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_toggle_2_63.add(mesh_toggle_2_63);
  meshes["toggle-2"] = mesh_toggle_2_63;
  colliders["toggle-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["toggle-2"] ??= [];
  destructionGroups["toggle-2"].push(node_toggle_2_63);

  const endpoint_toggle_3_64 = makeAttachmentEndpoint(null);
  const node_toggle_3_64 = new THREE.Group();
  node_toggle_3_64.name = "Robe front toggle__pivot";
  node_toggle_3_64.scale.set(1, 1, 1);
  if (endpoint_toggle_3_64) {
    node_toggle_3_64.position.copy(endpoint_toggle_3_64.start);
    node_toggle_3_64.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_toggle_3_64.position.set(-0.2275, 0.8275, 0.19);
    node_toggle_3_64.rotation.set(0.0, 0.0, 0.0);
  }
  node_toggle_3_64.userData.sculptComponent = {"id": "toggle-3", "name": "Robe front toggle", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Robe front toggle follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.055, "height": 0.014, "depth": 0.018, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.2275, 0.8275, 0.19], "rotation": [0, 0, 0], "scale": [0.055, 0.014, 0.018]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "toggle-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}}, "material": "gold", "materialLayers": ["gold"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["toggle-3-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(179, 160, 92, 1)", "secondaryAlbedo": "rgba(161, 144, 83, 1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_toggle_3_64.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "toggle-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}};
  (nodes["root"] ?? root).add(node_toggle_3_64);
  nodes["toggle-3"] = node_toggle_3_64;
  const mesh_toggle_3_64Geometry = endpoint_toggle_3_64
    ? new THREE.CylinderGeometry(endpoint_toggle_3_64.endRadius, endpoint_toggle_3_64.baseRadius, endpoint_toggle_3_64.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_toggle_3_64) {
    mesh_toggle_3_64Geometry.scale(0.055, 0.014, 0.018);
  }
  const mesh_toggle_3_64 = new THREE.Mesh(
    mesh_toggle_3_64Geometry,
    materialMap["gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_toggle_3_64.name = "Robe front toggle";
  if (endpoint_toggle_3_64) {
    mesh_toggle_3_64.position.copy(endpoint_toggle_3_64.midpoint);
    mesh_toggle_3_64.quaternion.copy(endpoint_toggle_3_64.quaternion);
  }
  mesh_toggle_3_64.castShadow = options.castShadow ?? true;
  mesh_toggle_3_64.receiveShadow = options.receiveShadow ?? true;
  mesh_toggle_3_64.userData.sculptComponent = {"id": "toggle-3", "name": "Robe front toggle", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Robe front toggle follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.055, "height": 0.014, "depth": 0.018, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.2275, 0.8275, 0.19], "rotation": [0, 0, 0], "scale": [0.055, 0.014, 0.018]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "toggle-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}}, "material": "gold", "materialLayers": ["gold"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["toggle-3-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(179, 160, 92, 1)", "secondaryAlbedo": "rgba(161, 144, 83, 1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_toggle_3_64.add(mesh_toggle_3_64);
  meshes["toggle-3"] = mesh_toggle_3_64;
  colliders["toggle-3"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["toggle-3"] ??= [];
  destructionGroups["toggle-3"].push(node_toggle_3_64);

  const endpoint_sword_wrap_65 = makeAttachmentEndpoint(null);
  const node_sword_wrap_65 = new THREE.Group();
  node_sword_wrap_65.name = "Raised grip diamond__pivot";
  node_sword_wrap_65.scale.set(1, 1, 1);
  if (endpoint_sword_wrap_65) {
    node_sword_wrap_65.position.copy(endpoint_sword_wrap_65.start);
    node_sword_wrap_65.rotation.set(0.0, 0.0, 0.78);
  } else {
    node_sword_wrap_65.position.set(-0.43, 2.4625, 0.027);
    node_sword_wrap_65.rotation.set(0.0, 0.0, 0.78);
  }
  node_sword_wrap_65.userData.sculptComponent = {"id": "sword-wrap", "name": "Raised grip diamond", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Raised grip diamond follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.018, "height": 0.012, "depth": 0.004, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.43, 2.4625, 0.027], "rotation": [0, 0, 0.78], "scale": [0.018, 0.012, 0.004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "sword-wrap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}}, "material": "white", "materialLayers": ["white"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["sword-wrap-observed-contour", {"id": "sword-wrap", "description": "Alternating diamonds on dark and white sword grips", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 234, 222, 1)", "secondaryAlbedo": "rgba(214, 211, 200, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_sword_wrap_65.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "sword-wrap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}};
  (nodes["root"] ?? root).add(node_sword_wrap_65);
  nodes["sword-wrap"] = node_sword_wrap_65;
  const mesh_sword_wrap_65Geometry = endpoint_sword_wrap_65
    ? new THREE.CylinderGeometry(endpoint_sword_wrap_65.endRadius, endpoint_sword_wrap_65.baseRadius, endpoint_sword_wrap_65.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_sword_wrap_65) {
    mesh_sword_wrap_65Geometry.scale(0.018, 0.012, 0.004);
  }
  const mesh_sword_wrap_65 = new THREE.Mesh(
    mesh_sword_wrap_65Geometry,
    materialMap["white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_sword_wrap_65.name = "Raised grip diamond";
  if (endpoint_sword_wrap_65) {
    mesh_sword_wrap_65.position.copy(endpoint_sword_wrap_65.midpoint);
    mesh_sword_wrap_65.quaternion.copy(endpoint_sword_wrap_65.quaternion);
  }
  mesh_sword_wrap_65.castShadow = options.castShadow ?? true;
  mesh_sword_wrap_65.receiveShadow = options.receiveShadow ?? true;
  mesh_sword_wrap_65.userData.sculptComponent = {"id": "sword-wrap", "name": "Raised grip diamond", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Raised grip diamond follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.018, "height": 0.012, "depth": 0.004, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.43, 2.4625, 0.027], "rotation": [0, 0, 0.78], "scale": [0.018, 0.012, 0.004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "sword-wrap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}}, "material": "white", "materialLayers": ["white"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["sword-wrap-observed-contour", {"id": "sword-wrap", "description": "Alternating diamonds on dark and white sword grips", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 234, 222, 1)", "secondaryAlbedo": "rgba(214, 211, 200, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_sword_wrap_65.add(mesh_sword_wrap_65);
  meshes["sword-wrap"] = mesh_sword_wrap_65;
  colliders["sword-wrap"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["sword-wrap"] ??= [];
  destructionGroups["sword-wrap"].push(node_sword_wrap_65);

  const endpoint_grip_diamond_1_66 = makeAttachmentEndpoint(null);
  const node_grip_diamond_1_66 = new THREE.Group();
  node_grip_diamond_1_66.name = "Raised grip diamond__pivot";
  node_grip_diamond_1_66.scale.set(1, 1, 1);
  if (endpoint_grip_diamond_1_66) {
    node_grip_diamond_1_66.position.copy(endpoint_grip_diamond_1_66.start);
    node_grip_diamond_1_66.rotation.set(0.0, 0.0, 0.78);
  } else {
    node_grip_diamond_1_66.position.set(-0.405, 2.4375, 0.027);
    node_grip_diamond_1_66.rotation.set(0.0, 0.0, 0.78);
  }
  node_grip_diamond_1_66.userData.sculptComponent = {"id": "grip-diamond-1", "name": "Raised grip diamond", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Raised grip diamond follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.018, "height": 0.012, "depth": 0.004, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.405, 2.4375, 0.027], "rotation": [0, 0, 0.78], "scale": [0.018, 0.012, 0.004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grip-diamond-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}}, "material": "white", "materialLayers": ["white"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["grip-diamond-1-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 234, 222, 1)", "secondaryAlbedo": "rgba(214, 211, 200, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_grip_diamond_1_66.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grip-diamond-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}};
  (nodes["root"] ?? root).add(node_grip_diamond_1_66);
  nodes["grip-diamond-1"] = node_grip_diamond_1_66;
  const mesh_grip_diamond_1_66Geometry = endpoint_grip_diamond_1_66
    ? new THREE.CylinderGeometry(endpoint_grip_diamond_1_66.endRadius, endpoint_grip_diamond_1_66.baseRadius, endpoint_grip_diamond_1_66.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_grip_diamond_1_66) {
    mesh_grip_diamond_1_66Geometry.scale(0.018, 0.012, 0.004);
  }
  const mesh_grip_diamond_1_66 = new THREE.Mesh(
    mesh_grip_diamond_1_66Geometry,
    materialMap["white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_grip_diamond_1_66.name = "Raised grip diamond";
  if (endpoint_grip_diamond_1_66) {
    mesh_grip_diamond_1_66.position.copy(endpoint_grip_diamond_1_66.midpoint);
    mesh_grip_diamond_1_66.quaternion.copy(endpoint_grip_diamond_1_66.quaternion);
  }
  mesh_grip_diamond_1_66.castShadow = options.castShadow ?? true;
  mesh_grip_diamond_1_66.receiveShadow = options.receiveShadow ?? true;
  mesh_grip_diamond_1_66.userData.sculptComponent = {"id": "grip-diamond-1", "name": "Raised grip diamond", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Raised grip diamond follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.018, "height": 0.012, "depth": 0.004, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.405, 2.4375, 0.027], "rotation": [0, 0, 0.78], "scale": [0.018, 0.012, 0.004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grip-diamond-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}}, "material": "white", "materialLayers": ["white"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["grip-diamond-1-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 234, 222, 1)", "secondaryAlbedo": "rgba(214, 211, 200, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_grip_diamond_1_66.add(mesh_grip_diamond_1_66);
  meshes["grip-diamond-1"] = mesh_grip_diamond_1_66;
  colliders["grip-diamond-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["grip-diamond-1"] ??= [];
  destructionGroups["grip-diamond-1"].push(node_grip_diamond_1_66);

  const endpoint_grip_diamond_2_67 = makeAttachmentEndpoint(null);
  const node_grip_diamond_2_67 = new THREE.Group();
  node_grip_diamond_2_67.name = "Raised grip diamond__pivot";
  node_grip_diamond_2_67.scale.set(1, 1, 1);
  if (endpoint_grip_diamond_2_67) {
    node_grip_diamond_2_67.position.copy(endpoint_grip_diamond_2_67.start);
    node_grip_diamond_2_67.rotation.set(0.0, 0.0, 0.78);
  } else {
    node_grip_diamond_2_67.position.set(-0.38, 2.4125, 0.027);
    node_grip_diamond_2_67.rotation.set(0.0, 0.0, 0.78);
  }
  node_grip_diamond_2_67.userData.sculptComponent = {"id": "grip-diamond-2", "name": "Raised grip diamond", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Raised grip diamond follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.018, "height": 0.012, "depth": 0.004, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.38, 2.4125, 0.027], "rotation": [0, 0, 0.78], "scale": [0.018, 0.012, 0.004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grip-diamond-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}}, "material": "white", "materialLayers": ["white"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["grip-diamond-2-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 234, 222, 1)", "secondaryAlbedo": "rgba(214, 211, 200, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_grip_diamond_2_67.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grip-diamond-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}};
  (nodes["root"] ?? root).add(node_grip_diamond_2_67);
  nodes["grip-diamond-2"] = node_grip_diamond_2_67;
  const mesh_grip_diamond_2_67Geometry = endpoint_grip_diamond_2_67
    ? new THREE.CylinderGeometry(endpoint_grip_diamond_2_67.endRadius, endpoint_grip_diamond_2_67.baseRadius, endpoint_grip_diamond_2_67.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_grip_diamond_2_67) {
    mesh_grip_diamond_2_67Geometry.scale(0.018, 0.012, 0.004);
  }
  const mesh_grip_diamond_2_67 = new THREE.Mesh(
    mesh_grip_diamond_2_67Geometry,
    materialMap["white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_grip_diamond_2_67.name = "Raised grip diamond";
  if (endpoint_grip_diamond_2_67) {
    mesh_grip_diamond_2_67.position.copy(endpoint_grip_diamond_2_67.midpoint);
    mesh_grip_diamond_2_67.quaternion.copy(endpoint_grip_diamond_2_67.quaternion);
  }
  mesh_grip_diamond_2_67.castShadow = options.castShadow ?? true;
  mesh_grip_diamond_2_67.receiveShadow = options.receiveShadow ?? true;
  mesh_grip_diamond_2_67.userData.sculptComponent = {"id": "grip-diamond-2", "name": "Raised grip diamond", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Raised grip diamond follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.018, "height": 0.012, "depth": 0.004, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.38, 2.4125, 0.027], "rotation": [0, 0, 0.78], "scale": [0.018, 0.012, 0.004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grip-diamond-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}}, "material": "white", "materialLayers": ["white"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["grip-diamond-2-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 234, 222, 1)", "secondaryAlbedo": "rgba(214, 211, 200, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_grip_diamond_2_67.add(mesh_grip_diamond_2_67);
  meshes["grip-diamond-2"] = mesh_grip_diamond_2_67;
  colliders["grip-diamond-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["grip-diamond-2"] ??= [];
  destructionGroups["grip-diamond-2"].push(node_grip_diamond_2_67);

  const endpoint_grip_diamond_3_68 = makeAttachmentEndpoint(null);
  const node_grip_diamond_3_68 = new THREE.Group();
  node_grip_diamond_3_68.name = "Raised grip diamond__pivot";
  node_grip_diamond_3_68.scale.set(1, 1, 1);
  if (endpoint_grip_diamond_3_68) {
    node_grip_diamond_3_68.position.copy(endpoint_grip_diamond_3_68.start);
    node_grip_diamond_3_68.rotation.set(0.0, 0.0, 0.78);
  } else {
    node_grip_diamond_3_68.position.set(-0.355, 2.3875, 0.027);
    node_grip_diamond_3_68.rotation.set(0.0, 0.0, 0.78);
  }
  node_grip_diamond_3_68.userData.sculptComponent = {"id": "grip-diamond-3", "name": "Raised grip diamond", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Raised grip diamond follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.018, "height": 0.012, "depth": 0.004, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.355, 2.3875, 0.027], "rotation": [0, 0, 0.78], "scale": [0.018, 0.012, 0.004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grip-diamond-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}}, "material": "white", "materialLayers": ["white"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["grip-diamond-3-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 234, 222, 1)", "secondaryAlbedo": "rgba(214, 211, 200, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_grip_diamond_3_68.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grip-diamond-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}};
  (nodes["root"] ?? root).add(node_grip_diamond_3_68);
  nodes["grip-diamond-3"] = node_grip_diamond_3_68;
  const mesh_grip_diamond_3_68Geometry = endpoint_grip_diamond_3_68
    ? new THREE.CylinderGeometry(endpoint_grip_diamond_3_68.endRadius, endpoint_grip_diamond_3_68.baseRadius, endpoint_grip_diamond_3_68.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_grip_diamond_3_68) {
    mesh_grip_diamond_3_68Geometry.scale(0.018, 0.012, 0.004);
  }
  const mesh_grip_diamond_3_68 = new THREE.Mesh(
    mesh_grip_diamond_3_68Geometry,
    materialMap["white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_grip_diamond_3_68.name = "Raised grip diamond";
  if (endpoint_grip_diamond_3_68) {
    mesh_grip_diamond_3_68.position.copy(endpoint_grip_diamond_3_68.midpoint);
    mesh_grip_diamond_3_68.quaternion.copy(endpoint_grip_diamond_3_68.quaternion);
  }
  mesh_grip_diamond_3_68.castShadow = options.castShadow ?? true;
  mesh_grip_diamond_3_68.receiveShadow = options.receiveShadow ?? true;
  mesh_grip_diamond_3_68.userData.sculptComponent = {"id": "grip-diamond-3", "name": "Raised grip diamond", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Raised grip diamond follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.018, "height": 0.012, "depth": 0.004, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.355, 2.3875, 0.027], "rotation": [0, 0, 0.78], "scale": [0.018, 0.012, 0.004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grip-diamond-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}}, "material": "white", "materialLayers": ["white"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["grip-diamond-3-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 234, 222, 1)", "secondaryAlbedo": "rgba(214, 211, 200, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_grip_diamond_3_68.add(mesh_grip_diamond_3_68);
  meshes["grip-diamond-3"] = mesh_grip_diamond_3_68;
  colliders["grip-diamond-3"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["grip-diamond-3"] ??= [];
  destructionGroups["grip-diamond-3"].push(node_grip_diamond_3_68);

  const endpoint_grip_diamond_4_69 = makeAttachmentEndpoint(null);
  const node_grip_diamond_4_69 = new THREE.Group();
  node_grip_diamond_4_69.name = "Raised grip diamond__pivot";
  node_grip_diamond_4_69.scale.set(1, 1, 1);
  if (endpoint_grip_diamond_4_69) {
    node_grip_diamond_4_69.position.copy(endpoint_grip_diamond_4_69.start);
    node_grip_diamond_4_69.rotation.set(0.0, 0.0, 0.78);
  } else {
    node_grip_diamond_4_69.position.set(-0.33, 2.3625, 0.027);
    node_grip_diamond_4_69.rotation.set(0.0, 0.0, 0.78);
  }
  node_grip_diamond_4_69.userData.sculptComponent = {"id": "grip-diamond-4", "name": "Raised grip diamond", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Raised grip diamond follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.018, "height": 0.012, "depth": 0.004, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.33, 2.3625, 0.027], "rotation": [0, 0, 0.78], "scale": [0.018, 0.012, 0.004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grip-diamond-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}}, "material": "white", "materialLayers": ["white"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["grip-diamond-4-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 234, 222, 1)", "secondaryAlbedo": "rgba(214, 211, 200, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_grip_diamond_4_69.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grip-diamond-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}};
  (nodes["root"] ?? root).add(node_grip_diamond_4_69);
  nodes["grip-diamond-4"] = node_grip_diamond_4_69;
  const mesh_grip_diamond_4_69Geometry = endpoint_grip_diamond_4_69
    ? new THREE.CylinderGeometry(endpoint_grip_diamond_4_69.endRadius, endpoint_grip_diamond_4_69.baseRadius, endpoint_grip_diamond_4_69.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_grip_diamond_4_69) {
    mesh_grip_diamond_4_69Geometry.scale(0.018, 0.012, 0.004);
  }
  const mesh_grip_diamond_4_69 = new THREE.Mesh(
    mesh_grip_diamond_4_69Geometry,
    materialMap["white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_grip_diamond_4_69.name = "Raised grip diamond";
  if (endpoint_grip_diamond_4_69) {
    mesh_grip_diamond_4_69.position.copy(endpoint_grip_diamond_4_69.midpoint);
    mesh_grip_diamond_4_69.quaternion.copy(endpoint_grip_diamond_4_69.quaternion);
  }
  mesh_grip_diamond_4_69.castShadow = options.castShadow ?? true;
  mesh_grip_diamond_4_69.receiveShadow = options.receiveShadow ?? true;
  mesh_grip_diamond_4_69.userData.sculptComponent = {"id": "grip-diamond-4", "name": "Raised grip diamond", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Raised grip diamond follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.018, "height": 0.012, "depth": 0.004, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.33, 2.3625, 0.027], "rotation": [0, 0, 0.78], "scale": [0.018, 0.012, 0.004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grip-diamond-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}}, "material": "white", "materialLayers": ["white"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["grip-diamond-4-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 234, 222, 1)", "secondaryAlbedo": "rgba(214, 211, 200, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_grip_diamond_4_69.add(mesh_grip_diamond_4_69);
  meshes["grip-diamond-4"] = mesh_grip_diamond_4_69;
  colliders["grip-diamond-4"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["grip-diamond-4"] ??= [];
  destructionGroups["grip-diamond-4"].push(node_grip_diamond_4_69);

  const endpoint_grip_diamond_5_70 = makeAttachmentEndpoint(null);
  const node_grip_diamond_5_70 = new THREE.Group();
  node_grip_diamond_5_70.name = "Raised grip diamond__pivot";
  node_grip_diamond_5_70.scale.set(1, 1, 1);
  if (endpoint_grip_diamond_5_70) {
    node_grip_diamond_5_70.position.copy(endpoint_grip_diamond_5_70.start);
    node_grip_diamond_5_70.rotation.set(0.0, 0.0, 0.78);
  } else {
    node_grip_diamond_5_70.position.set(-0.305, 2.3375, 0.027);
    node_grip_diamond_5_70.rotation.set(0.0, 0.0, 0.78);
  }
  node_grip_diamond_5_70.userData.sculptComponent = {"id": "grip-diamond-5", "name": "Raised grip diamond", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Raised grip diamond follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.018, "height": 0.012, "depth": 0.004, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.305, 2.3375, 0.027], "rotation": [0, 0, 0.78], "scale": [0.018, 0.012, 0.004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grip-diamond-5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}}, "material": "white", "materialLayers": ["white"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["grip-diamond-5-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 234, 222, 1)", "secondaryAlbedo": "rgba(214, 211, 200, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_grip_diamond_5_70.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grip-diamond-5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}};
  (nodes["root"] ?? root).add(node_grip_diamond_5_70);
  nodes["grip-diamond-5"] = node_grip_diamond_5_70;
  const mesh_grip_diamond_5_70Geometry = endpoint_grip_diamond_5_70
    ? new THREE.CylinderGeometry(endpoint_grip_diamond_5_70.endRadius, endpoint_grip_diamond_5_70.baseRadius, endpoint_grip_diamond_5_70.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_grip_diamond_5_70) {
    mesh_grip_diamond_5_70Geometry.scale(0.018, 0.012, 0.004);
  }
  const mesh_grip_diamond_5_70 = new THREE.Mesh(
    mesh_grip_diamond_5_70Geometry,
    materialMap["white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_grip_diamond_5_70.name = "Raised grip diamond";
  if (endpoint_grip_diamond_5_70) {
    mesh_grip_diamond_5_70.position.copy(endpoint_grip_diamond_5_70.midpoint);
    mesh_grip_diamond_5_70.quaternion.copy(endpoint_grip_diamond_5_70.quaternion);
  }
  mesh_grip_diamond_5_70.castShadow = options.castShadow ?? true;
  mesh_grip_diamond_5_70.receiveShadow = options.receiveShadow ?? true;
  mesh_grip_diamond_5_70.userData.sculptComponent = {"id": "grip-diamond-5", "name": "Raised grip diamond", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Raised grip diamond follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.018, "height": 0.012, "depth": 0.004, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.305, 2.3375, 0.027], "rotation": [0, 0, 0.78], "scale": [0.018, 0.012, 0.004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grip-diamond-5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}}, "material": "white", "materialLayers": ["white"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["grip-diamond-5-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 234, 222, 1)", "secondaryAlbedo": "rgba(214, 211, 200, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_grip_diamond_5_70.add(mesh_grip_diamond_5_70);
  meshes["grip-diamond-5"] = mesh_grip_diamond_5_70;
  colliders["grip-diamond-5"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["grip-diamond-5"] ??= [];
  destructionGroups["grip-diamond-5"].push(node_grip_diamond_5_70);

  const endpoint_grip_diamond_6_71 = makeAttachmentEndpoint(null);
  const node_grip_diamond_6_71 = new THREE.Group();
  node_grip_diamond_6_71.name = "Raised grip diamond__pivot";
  node_grip_diamond_6_71.scale.set(1, 1, 1);
  if (endpoint_grip_diamond_6_71) {
    node_grip_diamond_6_71.position.copy(endpoint_grip_diamond_6_71.start);
    node_grip_diamond_6_71.rotation.set(0.0, 0.0, 0.78);
  } else {
    node_grip_diamond_6_71.position.set(-0.28, 2.3125, 0.027);
    node_grip_diamond_6_71.rotation.set(0.0, 0.0, 0.78);
  }
  node_grip_diamond_6_71.userData.sculptComponent = {"id": "grip-diamond-6", "name": "Raised grip diamond", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Raised grip diamond follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.018, "height": 0.012, "depth": 0.004, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.28, 2.3125, 0.027], "rotation": [0, 0, 0.78], "scale": [0.018, 0.012, 0.004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grip-diamond-6", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}}, "material": "white", "materialLayers": ["white"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["grip-diamond-6-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 234, 222, 1)", "secondaryAlbedo": "rgba(214, 211, 200, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_grip_diamond_6_71.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grip-diamond-6", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}};
  (nodes["root"] ?? root).add(node_grip_diamond_6_71);
  nodes["grip-diamond-6"] = node_grip_diamond_6_71;
  const mesh_grip_diamond_6_71Geometry = endpoint_grip_diamond_6_71
    ? new THREE.CylinderGeometry(endpoint_grip_diamond_6_71.endRadius, endpoint_grip_diamond_6_71.baseRadius, endpoint_grip_diamond_6_71.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_grip_diamond_6_71) {
    mesh_grip_diamond_6_71Geometry.scale(0.018, 0.012, 0.004);
  }
  const mesh_grip_diamond_6_71 = new THREE.Mesh(
    mesh_grip_diamond_6_71Geometry,
    materialMap["white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_grip_diamond_6_71.name = "Raised grip diamond";
  if (endpoint_grip_diamond_6_71) {
    mesh_grip_diamond_6_71.position.copy(endpoint_grip_diamond_6_71.midpoint);
    mesh_grip_diamond_6_71.quaternion.copy(endpoint_grip_diamond_6_71.quaternion);
  }
  mesh_grip_diamond_6_71.castShadow = options.castShadow ?? true;
  mesh_grip_diamond_6_71.receiveShadow = options.receiveShadow ?? true;
  mesh_grip_diamond_6_71.userData.sculptComponent = {"id": "grip-diamond-6", "name": "Raised grip diamond", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Raised grip diamond follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.018, "height": 0.012, "depth": 0.004, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.28, 2.3125, 0.027], "rotation": [0, 0, 0.78], "scale": [0.018, 0.012, 0.004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grip-diamond-6", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}}, "material": "white", "materialLayers": ["white"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["grip-diamond-6-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 234, 222, 1)", "secondaryAlbedo": "rgba(214, 211, 200, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_grip_diamond_6_71.add(mesh_grip_diamond_6_71);
  meshes["grip-diamond-6"] = mesh_grip_diamond_6_71;
  colliders["grip-diamond-6"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["grip-diamond-6"] ??= [];
  destructionGroups["grip-diamond-6"].push(node_grip_diamond_6_71);

  const endpoint_grip_diamond_7_72 = makeAttachmentEndpoint(null);
  const node_grip_diamond_7_72 = new THREE.Group();
  node_grip_diamond_7_72.name = "Raised grip diamond__pivot";
  node_grip_diamond_7_72.scale.set(1, 1, 1);
  if (endpoint_grip_diamond_7_72) {
    node_grip_diamond_7_72.position.copy(endpoint_grip_diamond_7_72.start);
    node_grip_diamond_7_72.rotation.set(0.0, 0.0, 0.78);
  } else {
    node_grip_diamond_7_72.position.set(-0.255, 2.2875, 0.027);
    node_grip_diamond_7_72.rotation.set(0.0, 0.0, 0.78);
  }
  node_grip_diamond_7_72.userData.sculptComponent = {"id": "grip-diamond-7", "name": "Raised grip diamond", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Raised grip diamond follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.018, "height": 0.012, "depth": 0.004, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.255, 2.2875, 0.027], "rotation": [0, 0, 0.78], "scale": [0.018, 0.012, 0.004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grip-diamond-7", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}}, "material": "white", "materialLayers": ["white"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["grip-diamond-7-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 234, 222, 1)", "secondaryAlbedo": "rgba(214, 211, 200, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_grip_diamond_7_72.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grip-diamond-7", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}};
  (nodes["root"] ?? root).add(node_grip_diamond_7_72);
  nodes["grip-diamond-7"] = node_grip_diamond_7_72;
  const mesh_grip_diamond_7_72Geometry = endpoint_grip_diamond_7_72
    ? new THREE.CylinderGeometry(endpoint_grip_diamond_7_72.endRadius, endpoint_grip_diamond_7_72.baseRadius, endpoint_grip_diamond_7_72.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_grip_diamond_7_72) {
    mesh_grip_diamond_7_72Geometry.scale(0.018, 0.012, 0.004);
  }
  const mesh_grip_diamond_7_72 = new THREE.Mesh(
    mesh_grip_diamond_7_72Geometry,
    materialMap["white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_grip_diamond_7_72.name = "Raised grip diamond";
  if (endpoint_grip_diamond_7_72) {
    mesh_grip_diamond_7_72.position.copy(endpoint_grip_diamond_7_72.midpoint);
    mesh_grip_diamond_7_72.quaternion.copy(endpoint_grip_diamond_7_72.quaternion);
  }
  mesh_grip_diamond_7_72.castShadow = options.castShadow ?? true;
  mesh_grip_diamond_7_72.receiveShadow = options.receiveShadow ?? true;
  mesh_grip_diamond_7_72.userData.sculptComponent = {"id": "grip-diamond-7", "name": "Raised grip diamond", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Raised grip diamond follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.018, "height": 0.012, "depth": 0.004, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.255, 2.2875, 0.027], "rotation": [0, 0, 0.78], "scale": [0.018, 0.012, 0.004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grip-diamond-7", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}}, "material": "white", "materialLayers": ["white"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["grip-diamond-7-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 234, 222, 1)", "secondaryAlbedo": "rgba(214, 211, 200, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_grip_diamond_7_72.add(mesh_grip_diamond_7_72);
  meshes["grip-diamond-7"] = mesh_grip_diamond_7_72;
  colliders["grip-diamond-7"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["grip-diamond-7"] ??= [];
  destructionGroups["grip-diamond-7"].push(node_grip_diamond_7_72);

  const endpoint_chest_scar_73 = makeAttachmentEndpoint(null);
  const node_chest_scar_73 = new THREE.Group();
  node_chest_scar_73.name = "Chest scar dash__pivot";
  node_chest_scar_73.scale.set(1, 1, 1);
  if (endpoint_chest_scar_73) {
    node_chest_scar_73.position.copy(endpoint_chest_scar_73.start);
    node_chest_scar_73.rotation.set(0.0, 0.0, -0.65);
  } else {
    node_chest_scar_73.position.set(-0.075, 1.92, 0.098);
    node_chest_scar_73.rotation.set(0.0, 0.0, -0.65);
  }
  node_chest_scar_73.userData.sculptComponent = {"id": "chest-scar", "name": "Chest scar dash", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "Chest scar dash follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.017, "height": 0.003, "depth": 0.003, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.075, 1.92, 0.098], "rotation": [0, 0, -0.65], "scale": [0.017, 0.003, 0.003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-scar", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scar"}}, "material": "scar", "materialLayers": ["scar"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["chest-scar-observed-contour", {"id": "chest-scar", "description": "Diagonal healed scar across bare upper chest", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(134, 85, 65, 1)", "secondaryAlbedo": "rgba(121, 76, 58, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_chest_scar_73.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-scar", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scar"}};
  (nodes["root"] ?? root).add(node_chest_scar_73);
  nodes["chest-scar"] = node_chest_scar_73;
  const mesh_chest_scar_73Geometry = endpoint_chest_scar_73
    ? new THREE.CylinderGeometry(endpoint_chest_scar_73.endRadius, endpoint_chest_scar_73.baseRadius, endpoint_chest_scar_73.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_chest_scar_73) {
    mesh_chest_scar_73Geometry.scale(0.017, 0.003, 0.003);
  }
  const mesh_chest_scar_73 = new THREE.Mesh(
    mesh_chest_scar_73Geometry,
    materialMap["scar"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chest_scar_73.name = "Chest scar dash";
  if (endpoint_chest_scar_73) {
    mesh_chest_scar_73.position.copy(endpoint_chest_scar_73.midpoint);
    mesh_chest_scar_73.quaternion.copy(endpoint_chest_scar_73.quaternion);
  }
  mesh_chest_scar_73.castShadow = options.castShadow ?? true;
  mesh_chest_scar_73.receiveShadow = options.receiveShadow ?? true;
  mesh_chest_scar_73.userData.sculptComponent = {"id": "chest-scar", "name": "Chest scar dash", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "Chest scar dash follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.017, "height": 0.003, "depth": 0.003, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.075, 1.92, 0.098], "rotation": [0, 0, -0.65], "scale": [0.017, 0.003, 0.003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-scar", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scar"}}, "material": "scar", "materialLayers": ["scar"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["chest-scar-observed-contour", {"id": "chest-scar", "description": "Diagonal healed scar across bare upper chest", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(134, 85, 65, 1)", "secondaryAlbedo": "rgba(121, 76, 58, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_chest_scar_73.add(mesh_chest_scar_73);
  meshes["chest-scar"] = mesh_chest_scar_73;
  colliders["chest-scar"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["chest-scar"] ??= [];
  destructionGroups["chest-scar"].push(node_chest_scar_73);

  const endpoint_chest_stitch_1_74 = makeAttachmentEndpoint(null);
  const node_chest_stitch_1_74 = new THREE.Group();
  node_chest_stitch_1_74.name = "Chest scar dash__pivot";
  node_chest_stitch_1_74.scale.set(1, 1, 1);
  if (endpoint_chest_stitch_1_74) {
    node_chest_stitch_1_74.position.copy(endpoint_chest_stitch_1_74.start);
    node_chest_stitch_1_74.rotation.set(0.0, 0.0, -0.65);
  } else {
    node_chest_stitch_1_74.position.set(-0.0525, 1.94, 0.098);
    node_chest_stitch_1_74.rotation.set(0.0, 0.0, -0.65);
  }
  node_chest_stitch_1_74.userData.sculptComponent = {"id": "chest-stitch-1", "name": "Chest scar dash", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "Chest scar dash follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.017, "height": 0.003, "depth": 0.003, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.0525, 1.94, 0.098], "rotation": [0, 0, -0.65], "scale": [0.017, 0.003, 0.003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-stitch-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scar"}}, "material": "scar", "materialLayers": ["scar"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["chest-stitch-1-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(134, 85, 65, 1)", "secondaryAlbedo": "rgba(121, 76, 58, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_chest_stitch_1_74.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-stitch-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scar"}};
  (nodes["root"] ?? root).add(node_chest_stitch_1_74);
  nodes["chest-stitch-1"] = node_chest_stitch_1_74;
  const mesh_chest_stitch_1_74Geometry = endpoint_chest_stitch_1_74
    ? new THREE.CylinderGeometry(endpoint_chest_stitch_1_74.endRadius, endpoint_chest_stitch_1_74.baseRadius, endpoint_chest_stitch_1_74.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_chest_stitch_1_74) {
    mesh_chest_stitch_1_74Geometry.scale(0.017, 0.003, 0.003);
  }
  const mesh_chest_stitch_1_74 = new THREE.Mesh(
    mesh_chest_stitch_1_74Geometry,
    materialMap["scar"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chest_stitch_1_74.name = "Chest scar dash";
  if (endpoint_chest_stitch_1_74) {
    mesh_chest_stitch_1_74.position.copy(endpoint_chest_stitch_1_74.midpoint);
    mesh_chest_stitch_1_74.quaternion.copy(endpoint_chest_stitch_1_74.quaternion);
  }
  mesh_chest_stitch_1_74.castShadow = options.castShadow ?? true;
  mesh_chest_stitch_1_74.receiveShadow = options.receiveShadow ?? true;
  mesh_chest_stitch_1_74.userData.sculptComponent = {"id": "chest-stitch-1", "name": "Chest scar dash", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "Chest scar dash follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.017, "height": 0.003, "depth": 0.003, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.0525, 1.94, 0.098], "rotation": [0, 0, -0.65], "scale": [0.017, 0.003, 0.003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-stitch-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scar"}}, "material": "scar", "materialLayers": ["scar"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["chest-stitch-1-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(134, 85, 65, 1)", "secondaryAlbedo": "rgba(121, 76, 58, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_chest_stitch_1_74.add(mesh_chest_stitch_1_74);
  meshes["chest-stitch-1"] = mesh_chest_stitch_1_74;
  colliders["chest-stitch-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["chest-stitch-1"] ??= [];
  destructionGroups["chest-stitch-1"].push(node_chest_stitch_1_74);

  const endpoint_chest_stitch_2_75 = makeAttachmentEndpoint(null);
  const node_chest_stitch_2_75 = new THREE.Group();
  node_chest_stitch_2_75.name = "Chest scar dash__pivot";
  node_chest_stitch_2_75.scale.set(1, 1, 1);
  if (endpoint_chest_stitch_2_75) {
    node_chest_stitch_2_75.position.copy(endpoint_chest_stitch_2_75.start);
    node_chest_stitch_2_75.rotation.set(0.0, 0.0, -0.65);
  } else {
    node_chest_stitch_2_75.position.set(-0.03, 1.96, 0.098);
    node_chest_stitch_2_75.rotation.set(0.0, 0.0, -0.65);
  }
  node_chest_stitch_2_75.userData.sculptComponent = {"id": "chest-stitch-2", "name": "Chest scar dash", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "Chest scar dash follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.017, "height": 0.003, "depth": 0.003, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.03, 1.96, 0.098], "rotation": [0, 0, -0.65], "scale": [0.017, 0.003, 0.003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-stitch-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scar"}}, "material": "scar", "materialLayers": ["scar"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["chest-stitch-2-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(134, 85, 65, 1)", "secondaryAlbedo": "rgba(121, 76, 58, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_chest_stitch_2_75.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-stitch-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scar"}};
  (nodes["root"] ?? root).add(node_chest_stitch_2_75);
  nodes["chest-stitch-2"] = node_chest_stitch_2_75;
  const mesh_chest_stitch_2_75Geometry = endpoint_chest_stitch_2_75
    ? new THREE.CylinderGeometry(endpoint_chest_stitch_2_75.endRadius, endpoint_chest_stitch_2_75.baseRadius, endpoint_chest_stitch_2_75.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_chest_stitch_2_75) {
    mesh_chest_stitch_2_75Geometry.scale(0.017, 0.003, 0.003);
  }
  const mesh_chest_stitch_2_75 = new THREE.Mesh(
    mesh_chest_stitch_2_75Geometry,
    materialMap["scar"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chest_stitch_2_75.name = "Chest scar dash";
  if (endpoint_chest_stitch_2_75) {
    mesh_chest_stitch_2_75.position.copy(endpoint_chest_stitch_2_75.midpoint);
    mesh_chest_stitch_2_75.quaternion.copy(endpoint_chest_stitch_2_75.quaternion);
  }
  mesh_chest_stitch_2_75.castShadow = options.castShadow ?? true;
  mesh_chest_stitch_2_75.receiveShadow = options.receiveShadow ?? true;
  mesh_chest_stitch_2_75.userData.sculptComponent = {"id": "chest-stitch-2", "name": "Chest scar dash", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "Chest scar dash follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.017, "height": 0.003, "depth": 0.003, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.03, 1.96, 0.098], "rotation": [0, 0, -0.65], "scale": [0.017, 0.003, 0.003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-stitch-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scar"}}, "material": "scar", "materialLayers": ["scar"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["chest-stitch-2-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(134, 85, 65, 1)", "secondaryAlbedo": "rgba(121, 76, 58, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_chest_stitch_2_75.add(mesh_chest_stitch_2_75);
  meshes["chest-stitch-2"] = mesh_chest_stitch_2_75;
  colliders["chest-stitch-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["chest-stitch-2"] ??= [];
  destructionGroups["chest-stitch-2"].push(node_chest_stitch_2_75);

  const endpoint_chest_stitch_3_76 = makeAttachmentEndpoint(null);
  const node_chest_stitch_3_76 = new THREE.Group();
  node_chest_stitch_3_76.name = "Chest scar dash__pivot";
  node_chest_stitch_3_76.scale.set(1, 1, 1);
  if (endpoint_chest_stitch_3_76) {
    node_chest_stitch_3_76.position.copy(endpoint_chest_stitch_3_76.start);
    node_chest_stitch_3_76.rotation.set(0.0, 0.0, -0.65);
  } else {
    node_chest_stitch_3_76.position.set(-0.0075, 1.98, 0.098);
    node_chest_stitch_3_76.rotation.set(0.0, 0.0, -0.65);
  }
  node_chest_stitch_3_76.userData.sculptComponent = {"id": "chest-stitch-3", "name": "Chest scar dash", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "Chest scar dash follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.017, "height": 0.003, "depth": 0.003, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.0075, 1.98, 0.098], "rotation": [0, 0, -0.65], "scale": [0.017, 0.003, 0.003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-stitch-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scar"}}, "material": "scar", "materialLayers": ["scar"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["chest-stitch-3-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(134, 85, 65, 1)", "secondaryAlbedo": "rgba(121, 76, 58, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_chest_stitch_3_76.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-stitch-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scar"}};
  (nodes["root"] ?? root).add(node_chest_stitch_3_76);
  nodes["chest-stitch-3"] = node_chest_stitch_3_76;
  const mesh_chest_stitch_3_76Geometry = endpoint_chest_stitch_3_76
    ? new THREE.CylinderGeometry(endpoint_chest_stitch_3_76.endRadius, endpoint_chest_stitch_3_76.baseRadius, endpoint_chest_stitch_3_76.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_chest_stitch_3_76) {
    mesh_chest_stitch_3_76Geometry.scale(0.017, 0.003, 0.003);
  }
  const mesh_chest_stitch_3_76 = new THREE.Mesh(
    mesh_chest_stitch_3_76Geometry,
    materialMap["scar"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chest_stitch_3_76.name = "Chest scar dash";
  if (endpoint_chest_stitch_3_76) {
    mesh_chest_stitch_3_76.position.copy(endpoint_chest_stitch_3_76.midpoint);
    mesh_chest_stitch_3_76.quaternion.copy(endpoint_chest_stitch_3_76.quaternion);
  }
  mesh_chest_stitch_3_76.castShadow = options.castShadow ?? true;
  mesh_chest_stitch_3_76.receiveShadow = options.receiveShadow ?? true;
  mesh_chest_stitch_3_76.userData.sculptComponent = {"id": "chest-stitch-3", "name": "Chest scar dash", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "Chest scar dash follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.017, "height": 0.003, "depth": 0.003, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.0075, 1.98, 0.098], "rotation": [0, 0, -0.65], "scale": [0.017, 0.003, 0.003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-stitch-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scar"}}, "material": "scar", "materialLayers": ["scar"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["chest-stitch-3-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(134, 85, 65, 1)", "secondaryAlbedo": "rgba(121, 76, 58, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_chest_stitch_3_76.add(mesh_chest_stitch_3_76);
  meshes["chest-stitch-3"] = mesh_chest_stitch_3_76;
  colliders["chest-stitch-3"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["chest-stitch-3"] ??= [];
  destructionGroups["chest-stitch-3"].push(node_chest_stitch_3_76);

  const endpoint_chest_stitch_4_77 = makeAttachmentEndpoint(null);
  const node_chest_stitch_4_77 = new THREE.Group();
  node_chest_stitch_4_77.name = "Chest scar dash__pivot";
  node_chest_stitch_4_77.scale.set(1, 1, 1);
  if (endpoint_chest_stitch_4_77) {
    node_chest_stitch_4_77.position.copy(endpoint_chest_stitch_4_77.start);
    node_chest_stitch_4_77.rotation.set(0.0, 0.0, -0.65);
  } else {
    node_chest_stitch_4_77.position.set(0.015, 2.0, 0.098);
    node_chest_stitch_4_77.rotation.set(0.0, 0.0, -0.65);
  }
  node_chest_stitch_4_77.userData.sculptComponent = {"id": "chest-stitch-4", "name": "Chest scar dash", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "Chest scar dash follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.017, "height": 0.003, "depth": 0.003, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.015, 2.0, 0.098], "rotation": [0, 0, -0.65], "scale": [0.017, 0.003, 0.003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-stitch-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scar"}}, "material": "scar", "materialLayers": ["scar"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["chest-stitch-4-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(134, 85, 65, 1)", "secondaryAlbedo": "rgba(121, 76, 58, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_chest_stitch_4_77.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-stitch-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scar"}};
  (nodes["root"] ?? root).add(node_chest_stitch_4_77);
  nodes["chest-stitch-4"] = node_chest_stitch_4_77;
  const mesh_chest_stitch_4_77Geometry = endpoint_chest_stitch_4_77
    ? new THREE.CylinderGeometry(endpoint_chest_stitch_4_77.endRadius, endpoint_chest_stitch_4_77.baseRadius, endpoint_chest_stitch_4_77.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_chest_stitch_4_77) {
    mesh_chest_stitch_4_77Geometry.scale(0.017, 0.003, 0.003);
  }
  const mesh_chest_stitch_4_77 = new THREE.Mesh(
    mesh_chest_stitch_4_77Geometry,
    materialMap["scar"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chest_stitch_4_77.name = "Chest scar dash";
  if (endpoint_chest_stitch_4_77) {
    mesh_chest_stitch_4_77.position.copy(endpoint_chest_stitch_4_77.midpoint);
    mesh_chest_stitch_4_77.quaternion.copy(endpoint_chest_stitch_4_77.quaternion);
  }
  mesh_chest_stitch_4_77.castShadow = options.castShadow ?? true;
  mesh_chest_stitch_4_77.receiveShadow = options.receiveShadow ?? true;
  mesh_chest_stitch_4_77.userData.sculptComponent = {"id": "chest-stitch-4", "name": "Chest scar dash", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "Chest scar dash follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.017, "height": 0.003, "depth": 0.003, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.015, 2.0, 0.098], "rotation": [0, 0, -0.65], "scale": [0.017, 0.003, 0.003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-stitch-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scar"}}, "material": "scar", "materialLayers": ["scar"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["chest-stitch-4-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(134, 85, 65, 1)", "secondaryAlbedo": "rgba(121, 76, 58, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_chest_stitch_4_77.add(mesh_chest_stitch_4_77);
  meshes["chest-stitch-4"] = mesh_chest_stitch_4_77;
  colliders["chest-stitch-4"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["chest-stitch-4"] ??= [];
  destructionGroups["chest-stitch-4"].push(node_chest_stitch_4_77);

  const endpoint_chest_stitch_5_78 = makeAttachmentEndpoint(null);
  const node_chest_stitch_5_78 = new THREE.Group();
  node_chest_stitch_5_78.name = "Chest scar dash__pivot";
  node_chest_stitch_5_78.scale.set(1, 1, 1);
  if (endpoint_chest_stitch_5_78) {
    node_chest_stitch_5_78.position.copy(endpoint_chest_stitch_5_78.start);
    node_chest_stitch_5_78.rotation.set(0.0, 0.0, -0.65);
  } else {
    node_chest_stitch_5_78.position.set(0.0375, 2.02, 0.098);
    node_chest_stitch_5_78.rotation.set(0.0, 0.0, -0.65);
  }
  node_chest_stitch_5_78.userData.sculptComponent = {"id": "chest-stitch-5", "name": "Chest scar dash", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "Chest scar dash follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.017, "height": 0.003, "depth": 0.003, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0375, 2.02, 0.098], "rotation": [0, 0, -0.65], "scale": [0.017, 0.003, 0.003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-stitch-5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scar"}}, "material": "scar", "materialLayers": ["scar"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["chest-stitch-5-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(134, 85, 65, 1)", "secondaryAlbedo": "rgba(121, 76, 58, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_chest_stitch_5_78.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-stitch-5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scar"}};
  (nodes["root"] ?? root).add(node_chest_stitch_5_78);
  nodes["chest-stitch-5"] = node_chest_stitch_5_78;
  const mesh_chest_stitch_5_78Geometry = endpoint_chest_stitch_5_78
    ? new THREE.CylinderGeometry(endpoint_chest_stitch_5_78.endRadius, endpoint_chest_stitch_5_78.baseRadius, endpoint_chest_stitch_5_78.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_chest_stitch_5_78) {
    mesh_chest_stitch_5_78Geometry.scale(0.017, 0.003, 0.003);
  }
  const mesh_chest_stitch_5_78 = new THREE.Mesh(
    mesh_chest_stitch_5_78Geometry,
    materialMap["scar"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chest_stitch_5_78.name = "Chest scar dash";
  if (endpoint_chest_stitch_5_78) {
    mesh_chest_stitch_5_78.position.copy(endpoint_chest_stitch_5_78.midpoint);
    mesh_chest_stitch_5_78.quaternion.copy(endpoint_chest_stitch_5_78.quaternion);
  }
  mesh_chest_stitch_5_78.castShadow = options.castShadow ?? true;
  mesh_chest_stitch_5_78.receiveShadow = options.receiveShadow ?? true;
  mesh_chest_stitch_5_78.userData.sculptComponent = {"id": "chest-stitch-5", "name": "Chest scar dash", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "Chest scar dash follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.017, "height": 0.003, "depth": 0.003, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0375, 2.02, 0.098], "rotation": [0, 0, -0.65], "scale": [0.017, 0.003, 0.003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-stitch-5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scar"}}, "material": "scar", "materialLayers": ["scar"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["chest-stitch-5-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(134, 85, 65, 1)", "secondaryAlbedo": "rgba(121, 76, 58, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_chest_stitch_5_78.add(mesh_chest_stitch_5_78);
  meshes["chest-stitch-5"] = mesh_chest_stitch_5_78;
  colliders["chest-stitch-5"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["chest-stitch-5"] ??= [];
  destructionGroups["chest-stitch-5"].push(node_chest_stitch_5_78);

  const endpoint_chest_stitch_6_79 = makeAttachmentEndpoint(null);
  const node_chest_stitch_6_79 = new THREE.Group();
  node_chest_stitch_6_79.name = "Chest scar dash__pivot";
  node_chest_stitch_6_79.scale.set(1, 1, 1);
  if (endpoint_chest_stitch_6_79) {
    node_chest_stitch_6_79.position.copy(endpoint_chest_stitch_6_79.start);
    node_chest_stitch_6_79.rotation.set(0.0, 0.0, -0.65);
  } else {
    node_chest_stitch_6_79.position.set(0.06, 2.04, 0.098);
    node_chest_stitch_6_79.rotation.set(0.0, 0.0, -0.65);
  }
  node_chest_stitch_6_79.userData.sculptComponent = {"id": "chest-stitch-6", "name": "Chest scar dash", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "Chest scar dash follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.017, "height": 0.003, "depth": 0.003, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.06, 2.04, 0.098], "rotation": [0, 0, -0.65], "scale": [0.017, 0.003, 0.003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-stitch-6", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scar"}}, "material": "scar", "materialLayers": ["scar"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["chest-stitch-6-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(134, 85, 65, 1)", "secondaryAlbedo": "rgba(121, 76, 58, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_chest_stitch_6_79.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-stitch-6", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scar"}};
  (nodes["root"] ?? root).add(node_chest_stitch_6_79);
  nodes["chest-stitch-6"] = node_chest_stitch_6_79;
  const mesh_chest_stitch_6_79Geometry = endpoint_chest_stitch_6_79
    ? new THREE.CylinderGeometry(endpoint_chest_stitch_6_79.endRadius, endpoint_chest_stitch_6_79.baseRadius, endpoint_chest_stitch_6_79.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_chest_stitch_6_79) {
    mesh_chest_stitch_6_79Geometry.scale(0.017, 0.003, 0.003);
  }
  const mesh_chest_stitch_6_79 = new THREE.Mesh(
    mesh_chest_stitch_6_79Geometry,
    materialMap["scar"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chest_stitch_6_79.name = "Chest scar dash";
  if (endpoint_chest_stitch_6_79) {
    mesh_chest_stitch_6_79.position.copy(endpoint_chest_stitch_6_79.midpoint);
    mesh_chest_stitch_6_79.quaternion.copy(endpoint_chest_stitch_6_79.quaternion);
  }
  mesh_chest_stitch_6_79.castShadow = options.castShadow ?? true;
  mesh_chest_stitch_6_79.receiveShadow = options.receiveShadow ?? true;
  mesh_chest_stitch_6_79.userData.sculptComponent = {"id": "chest-stitch-6", "name": "Chest scar dash", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "Chest scar dash follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.017, "height": 0.003, "depth": 0.003, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.06, 2.04, 0.098], "rotation": [0, 0, -0.65], "scale": [0.017, 0.003, 0.003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-stitch-6", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scar"}}, "material": "scar", "materialLayers": ["scar"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["chest-stitch-6-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(134, 85, 65, 1)", "secondaryAlbedo": "rgba(121, 76, 58, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_chest_stitch_6_79.add(mesh_chest_stitch_6_79);
  meshes["chest-stitch-6"] = mesh_chest_stitch_6_79;
  colliders["chest-stitch-6"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["chest-stitch-6"] ??= [];
  destructionGroups["chest-stitch-6"].push(node_chest_stitch_6_79);

  // standProud: hold these components outside the surfaces they cover.
  if (meshes["hair"] && nodes["head"]) {
    applyStandProud(
      meshes["hair"].geometry,
      meshes["hair"],
      nodes["head"],
      {"rings": [[-0.142571138048172, 0.004055454301137958, 0.004409333873655389, 0.018513035693796188], [-0.13359452709928155, 0.036139295664601695, 0.0379593956158101, 0.0173390790127941], [-0.1246179161503911, 0.047957831524763544, 0.05001886070279669, 0.01632614788246644], [-0.11564130520150068, 0.05545989803581714, 0.057127962792264314, 0.014581875007853757], [-0.10666469425261021, 0.06106630809316257, 0.061817626667726805, 0.012422077298670994], [-0.09768808330371975, 0.06671779619966606, 0.06546943498849106, 0.010271715845787198], [-0.08871147235482932, 0.07281198746376828, 0.06876657502793695, 0.008846480836889308], [-0.07973486140593888, 0.07881704895821892, 0.07257230847747806, 0.008921600558563239], [-0.07075825045704842, 0.08402580419193607, 0.08234098063245904, 0.015664397995288563], [-0.061781639508157966, 0.08810472524764089, 0.08879240322226689, 0.019393098792963324], [-0.052805028559267525, 0.0908933178725883, 0.09106929679920758, 0.019009384018945343], [-0.043828417610377084, 0.09272310737822818, 0.09315089142202451, 0.018249377129087953], [-0.03485180666148663, 0.09345012902162558, 0.09445898051809404, 0.016402953317279957], [-0.025875195712596173, 0.0934984418880333, 0.095123070004385, 0.013750160243346861], [-0.016898584763705732, 0.09337571447789941, 0.09387859574813084, 0.009750843243680599], [-0.007921973814815297, 0.0935922691027162, 0.08944625029987, 0.0030307552971284013], [0.0010546371340751648, 0.0942509292609486, 0.08879494554674258, 0.0007523180206619393], [0.010031248082965627, 0.09513703484216929, 0.08930793294259994, 0.00017561341088857818], [0.01900785903185606, 0.09571509367159375, 0.08972824220870201, 1.838386827598265e-05], [0.027984469980746503, 0.09580578317926644, 0.08979517132563172, 3.666458592288535e-08], [0.03696108092963696, 0.09537321496910953, 0.08938952354135571, 5.953485616300158e-08], [0.04593769187852741, 0.0943947093388799, 0.08847031529542823, -1.0467581573053719e-07], [0.054914302827417855, 0.09285667271879315, 0.08699311614165939, -2.101223242345629e-05], [0.06389091377630829, 0.0906266255775428, 0.08502149809903072, 7.149269885765863e-05], [0.07286752472519875, 0.08787735285571535, 0.08232570234895736, -1.1081651846323037e-05], [0.08184413567408921, 0.08437587833965889, 0.07909221482110687, 9.316396540844096e-06], [0.09082074662297965, 0.08011878596323432, 0.07507450270729032, -8.988916432868532e-06], [0.09979735757187008, 0.0749766801956124, 0.07017735349238663, -2.1727398313978186e-05], [0.10877396852076054, 0.06860401679251937, 0.06424618047197614, -2.566661756252947e-05], [0.117750579469651, 0.0606793448722921, 0.056860106787717496, 6.710777537610735e-06], [0.1267271904185414, 0.05058701960162121, 0.047399256821313976, 1.5603330448310526e-05], [0.13570380136743188, 0.03659234443737833, 0.03425934636538543, 1.0741790325140277e-05], [0.14468041231632234, 0.004328900494599768, 0.0037336843414683472, -0.000247877763485099]]},
      0.004,
      0.015,
    );
  }
  if (meshes["hair-tip-0"] && nodes["head"]) {
    applyStandProud(
      meshes["hair-tip-0"].geometry,
      meshes["hair-tip-0"],
      nodes["head"],
      {"rings": [[-0.142571138048172, 0.004055454301137958, 0.004409333873655389, 0.018513035693796188], [-0.13359452709928155, 0.036139295664601695, 0.0379593956158101, 0.0173390790127941], [-0.1246179161503911, 0.047957831524763544, 0.05001886070279669, 0.01632614788246644], [-0.11564130520150068, 0.05545989803581714, 0.057127962792264314, 0.014581875007853757], [-0.10666469425261021, 0.06106630809316257, 0.061817626667726805, 0.012422077298670994], [-0.09768808330371975, 0.06671779619966606, 0.06546943498849106, 0.010271715845787198], [-0.08871147235482932, 0.07281198746376828, 0.06876657502793695, 0.008846480836889308], [-0.07973486140593888, 0.07881704895821892, 0.07257230847747806, 0.008921600558563239], [-0.07075825045704842, 0.08402580419193607, 0.08234098063245904, 0.015664397995288563], [-0.061781639508157966, 0.08810472524764089, 0.08879240322226689, 0.019393098792963324], [-0.052805028559267525, 0.0908933178725883, 0.09106929679920758, 0.019009384018945343], [-0.043828417610377084, 0.09272310737822818, 0.09315089142202451, 0.018249377129087953], [-0.03485180666148663, 0.09345012902162558, 0.09445898051809404, 0.016402953317279957], [-0.025875195712596173, 0.0934984418880333, 0.095123070004385, 0.013750160243346861], [-0.016898584763705732, 0.09337571447789941, 0.09387859574813084, 0.009750843243680599], [-0.007921973814815297, 0.0935922691027162, 0.08944625029987, 0.0030307552971284013], [0.0010546371340751648, 0.0942509292609486, 0.08879494554674258, 0.0007523180206619393], [0.010031248082965627, 0.09513703484216929, 0.08930793294259994, 0.00017561341088857818], [0.01900785903185606, 0.09571509367159375, 0.08972824220870201, 1.838386827598265e-05], [0.027984469980746503, 0.09580578317926644, 0.08979517132563172, 3.666458592288535e-08], [0.03696108092963696, 0.09537321496910953, 0.08938952354135571, 5.953485616300158e-08], [0.04593769187852741, 0.0943947093388799, 0.08847031529542823, -1.0467581573053719e-07], [0.054914302827417855, 0.09285667271879315, 0.08699311614165939, -2.101223242345629e-05], [0.06389091377630829, 0.0906266255775428, 0.08502149809903072, 7.149269885765863e-05], [0.07286752472519875, 0.08787735285571535, 0.08232570234895736, -1.1081651846323037e-05], [0.08184413567408921, 0.08437587833965889, 0.07909221482110687, 9.316396540844096e-06], [0.09082074662297965, 0.08011878596323432, 0.07507450270729032, -8.988916432868532e-06], [0.09979735757187008, 0.0749766801956124, 0.07017735349238663, -2.1727398313978186e-05], [0.10877396852076054, 0.06860401679251937, 0.06424618047197614, -2.566661756252947e-05], [0.117750579469651, 0.0606793448722921, 0.056860106787717496, 6.710777537610735e-06], [0.1267271904185414, 0.05058701960162121, 0.047399256821313976, 1.5603330448310526e-05], [0.13570380136743188, 0.03659234443737833, 0.03425934636538543, 1.0741790325140277e-05], [0.14468041231632234, 0.004328900494599768, 0.0037336843414683472, -0.000247877763485099]]},
      0.003,
      0.012,
    );
  }
  if (meshes["hair-tip-1"] && nodes["head"]) {
    applyStandProud(
      meshes["hair-tip-1"].geometry,
      meshes["hair-tip-1"],
      nodes["head"],
      {"rings": [[-0.142571138048172, 0.004055454301137958, 0.004409333873655389, 0.018513035693796188], [-0.13359452709928155, 0.036139295664601695, 0.0379593956158101, 0.0173390790127941], [-0.1246179161503911, 0.047957831524763544, 0.05001886070279669, 0.01632614788246644], [-0.11564130520150068, 0.05545989803581714, 0.057127962792264314, 0.014581875007853757], [-0.10666469425261021, 0.06106630809316257, 0.061817626667726805, 0.012422077298670994], [-0.09768808330371975, 0.06671779619966606, 0.06546943498849106, 0.010271715845787198], [-0.08871147235482932, 0.07281198746376828, 0.06876657502793695, 0.008846480836889308], [-0.07973486140593888, 0.07881704895821892, 0.07257230847747806, 0.008921600558563239], [-0.07075825045704842, 0.08402580419193607, 0.08234098063245904, 0.015664397995288563], [-0.061781639508157966, 0.08810472524764089, 0.08879240322226689, 0.019393098792963324], [-0.052805028559267525, 0.0908933178725883, 0.09106929679920758, 0.019009384018945343], [-0.043828417610377084, 0.09272310737822818, 0.09315089142202451, 0.018249377129087953], [-0.03485180666148663, 0.09345012902162558, 0.09445898051809404, 0.016402953317279957], [-0.025875195712596173, 0.0934984418880333, 0.095123070004385, 0.013750160243346861], [-0.016898584763705732, 0.09337571447789941, 0.09387859574813084, 0.009750843243680599], [-0.007921973814815297, 0.0935922691027162, 0.08944625029987, 0.0030307552971284013], [0.0010546371340751648, 0.0942509292609486, 0.08879494554674258, 0.0007523180206619393], [0.010031248082965627, 0.09513703484216929, 0.08930793294259994, 0.00017561341088857818], [0.01900785903185606, 0.09571509367159375, 0.08972824220870201, 1.838386827598265e-05], [0.027984469980746503, 0.09580578317926644, 0.08979517132563172, 3.666458592288535e-08], [0.03696108092963696, 0.09537321496910953, 0.08938952354135571, 5.953485616300158e-08], [0.04593769187852741, 0.0943947093388799, 0.08847031529542823, -1.0467581573053719e-07], [0.054914302827417855, 0.09285667271879315, 0.08699311614165939, -2.101223242345629e-05], [0.06389091377630829, 0.0906266255775428, 0.08502149809903072, 7.149269885765863e-05], [0.07286752472519875, 0.08787735285571535, 0.08232570234895736, -1.1081651846323037e-05], [0.08184413567408921, 0.08437587833965889, 0.07909221482110687, 9.316396540844096e-06], [0.09082074662297965, 0.08011878596323432, 0.07507450270729032, -8.988916432868532e-06], [0.09979735757187008, 0.0749766801956124, 0.07017735349238663, -2.1727398313978186e-05], [0.10877396852076054, 0.06860401679251937, 0.06424618047197614, -2.566661756252947e-05], [0.117750579469651, 0.0606793448722921, 0.056860106787717496, 6.710777537610735e-06], [0.1267271904185414, 0.05058701960162121, 0.047399256821313976, 1.5603330448310526e-05], [0.13570380136743188, 0.03659234443737833, 0.03425934636538543, 1.0741790325140277e-05], [0.14468041231632234, 0.004328900494599768, 0.0037336843414683472, -0.000247877763485099]]},
      0.003,
      0.012,
    );
  }
  if (meshes["hair-tip-2"] && nodes["head"]) {
    applyStandProud(
      meshes["hair-tip-2"].geometry,
      meshes["hair-tip-2"],
      nodes["head"],
      {"rings": [[-0.142571138048172, 0.004055454301137958, 0.004409333873655389, 0.018513035693796188], [-0.13359452709928155, 0.036139295664601695, 0.0379593956158101, 0.0173390790127941], [-0.1246179161503911, 0.047957831524763544, 0.05001886070279669, 0.01632614788246644], [-0.11564130520150068, 0.05545989803581714, 0.057127962792264314, 0.014581875007853757], [-0.10666469425261021, 0.06106630809316257, 0.061817626667726805, 0.012422077298670994], [-0.09768808330371975, 0.06671779619966606, 0.06546943498849106, 0.010271715845787198], [-0.08871147235482932, 0.07281198746376828, 0.06876657502793695, 0.008846480836889308], [-0.07973486140593888, 0.07881704895821892, 0.07257230847747806, 0.008921600558563239], [-0.07075825045704842, 0.08402580419193607, 0.08234098063245904, 0.015664397995288563], [-0.061781639508157966, 0.08810472524764089, 0.08879240322226689, 0.019393098792963324], [-0.052805028559267525, 0.0908933178725883, 0.09106929679920758, 0.019009384018945343], [-0.043828417610377084, 0.09272310737822818, 0.09315089142202451, 0.018249377129087953], [-0.03485180666148663, 0.09345012902162558, 0.09445898051809404, 0.016402953317279957], [-0.025875195712596173, 0.0934984418880333, 0.095123070004385, 0.013750160243346861], [-0.016898584763705732, 0.09337571447789941, 0.09387859574813084, 0.009750843243680599], [-0.007921973814815297, 0.0935922691027162, 0.08944625029987, 0.0030307552971284013], [0.0010546371340751648, 0.0942509292609486, 0.08879494554674258, 0.0007523180206619393], [0.010031248082965627, 0.09513703484216929, 0.08930793294259994, 0.00017561341088857818], [0.01900785903185606, 0.09571509367159375, 0.08972824220870201, 1.838386827598265e-05], [0.027984469980746503, 0.09580578317926644, 0.08979517132563172, 3.666458592288535e-08], [0.03696108092963696, 0.09537321496910953, 0.08938952354135571, 5.953485616300158e-08], [0.04593769187852741, 0.0943947093388799, 0.08847031529542823, -1.0467581573053719e-07], [0.054914302827417855, 0.09285667271879315, 0.08699311614165939, -2.101223242345629e-05], [0.06389091377630829, 0.0906266255775428, 0.08502149809903072, 7.149269885765863e-05], [0.07286752472519875, 0.08787735285571535, 0.08232570234895736, -1.1081651846323037e-05], [0.08184413567408921, 0.08437587833965889, 0.07909221482110687, 9.316396540844096e-06], [0.09082074662297965, 0.08011878596323432, 0.07507450270729032, -8.988916432868532e-06], [0.09979735757187008, 0.0749766801956124, 0.07017735349238663, -2.1727398313978186e-05], [0.10877396852076054, 0.06860401679251937, 0.06424618047197614, -2.566661756252947e-05], [0.117750579469651, 0.0606793448722921, 0.056860106787717496, 6.710777537610735e-06], [0.1267271904185414, 0.05058701960162121, 0.047399256821313976, 1.5603330448310526e-05], [0.13570380136743188, 0.03659234443737833, 0.03425934636538543, 1.0741790325140277e-05], [0.14468041231632234, 0.004328900494599768, 0.0037336843414683472, -0.000247877763485099]]},
      0.003,
      0.012,
    );
  }
  if (meshes["hair-tip-3"] && nodes["head"]) {
    applyStandProud(
      meshes["hair-tip-3"].geometry,
      meshes["hair-tip-3"],
      nodes["head"],
      {"rings": [[-0.142571138048172, 0.004055454301137958, 0.004409333873655389, 0.018513035693796188], [-0.13359452709928155, 0.036139295664601695, 0.0379593956158101, 0.0173390790127941], [-0.1246179161503911, 0.047957831524763544, 0.05001886070279669, 0.01632614788246644], [-0.11564130520150068, 0.05545989803581714, 0.057127962792264314, 0.014581875007853757], [-0.10666469425261021, 0.06106630809316257, 0.061817626667726805, 0.012422077298670994], [-0.09768808330371975, 0.06671779619966606, 0.06546943498849106, 0.010271715845787198], [-0.08871147235482932, 0.07281198746376828, 0.06876657502793695, 0.008846480836889308], [-0.07973486140593888, 0.07881704895821892, 0.07257230847747806, 0.008921600558563239], [-0.07075825045704842, 0.08402580419193607, 0.08234098063245904, 0.015664397995288563], [-0.061781639508157966, 0.08810472524764089, 0.08879240322226689, 0.019393098792963324], [-0.052805028559267525, 0.0908933178725883, 0.09106929679920758, 0.019009384018945343], [-0.043828417610377084, 0.09272310737822818, 0.09315089142202451, 0.018249377129087953], [-0.03485180666148663, 0.09345012902162558, 0.09445898051809404, 0.016402953317279957], [-0.025875195712596173, 0.0934984418880333, 0.095123070004385, 0.013750160243346861], [-0.016898584763705732, 0.09337571447789941, 0.09387859574813084, 0.009750843243680599], [-0.007921973814815297, 0.0935922691027162, 0.08944625029987, 0.0030307552971284013], [0.0010546371340751648, 0.0942509292609486, 0.08879494554674258, 0.0007523180206619393], [0.010031248082965627, 0.09513703484216929, 0.08930793294259994, 0.00017561341088857818], [0.01900785903185606, 0.09571509367159375, 0.08972824220870201, 1.838386827598265e-05], [0.027984469980746503, 0.09580578317926644, 0.08979517132563172, 3.666458592288535e-08], [0.03696108092963696, 0.09537321496910953, 0.08938952354135571, 5.953485616300158e-08], [0.04593769187852741, 0.0943947093388799, 0.08847031529542823, -1.0467581573053719e-07], [0.054914302827417855, 0.09285667271879315, 0.08699311614165939, -2.101223242345629e-05], [0.06389091377630829, 0.0906266255775428, 0.08502149809903072, 7.149269885765863e-05], [0.07286752472519875, 0.08787735285571535, 0.08232570234895736, -1.1081651846323037e-05], [0.08184413567408921, 0.08437587833965889, 0.07909221482110687, 9.316396540844096e-06], [0.09082074662297965, 0.08011878596323432, 0.07507450270729032, -8.988916432868532e-06], [0.09979735757187008, 0.0749766801956124, 0.07017735349238663, -2.1727398313978186e-05], [0.10877396852076054, 0.06860401679251937, 0.06424618047197614, -2.566661756252947e-05], [0.117750579469651, 0.0606793448722921, 0.056860106787717496, 6.710777537610735e-06], [0.1267271904185414, 0.05058701960162121, 0.047399256821313976, 1.5603330448310526e-05], [0.13570380136743188, 0.03659234443737833, 0.03425934636538543, 1.0741790325140277e-05], [0.14468041231632234, 0.004328900494599768, 0.0037336843414683472, -0.000247877763485099]]},
      0.003,
      0.012,
    );
  }
  if (meshes["hair-tip-4"] && nodes["head"]) {
    applyStandProud(
      meshes["hair-tip-4"].geometry,
      meshes["hair-tip-4"],
      nodes["head"],
      {"rings": [[-0.142571138048172, 0.004055454301137958, 0.004409333873655389, 0.018513035693796188], [-0.13359452709928155, 0.036139295664601695, 0.0379593956158101, 0.0173390790127941], [-0.1246179161503911, 0.047957831524763544, 0.05001886070279669, 0.01632614788246644], [-0.11564130520150068, 0.05545989803581714, 0.057127962792264314, 0.014581875007853757], [-0.10666469425261021, 0.06106630809316257, 0.061817626667726805, 0.012422077298670994], [-0.09768808330371975, 0.06671779619966606, 0.06546943498849106, 0.010271715845787198], [-0.08871147235482932, 0.07281198746376828, 0.06876657502793695, 0.008846480836889308], [-0.07973486140593888, 0.07881704895821892, 0.07257230847747806, 0.008921600558563239], [-0.07075825045704842, 0.08402580419193607, 0.08234098063245904, 0.015664397995288563], [-0.061781639508157966, 0.08810472524764089, 0.08879240322226689, 0.019393098792963324], [-0.052805028559267525, 0.0908933178725883, 0.09106929679920758, 0.019009384018945343], [-0.043828417610377084, 0.09272310737822818, 0.09315089142202451, 0.018249377129087953], [-0.03485180666148663, 0.09345012902162558, 0.09445898051809404, 0.016402953317279957], [-0.025875195712596173, 0.0934984418880333, 0.095123070004385, 0.013750160243346861], [-0.016898584763705732, 0.09337571447789941, 0.09387859574813084, 0.009750843243680599], [-0.007921973814815297, 0.0935922691027162, 0.08944625029987, 0.0030307552971284013], [0.0010546371340751648, 0.0942509292609486, 0.08879494554674258, 0.0007523180206619393], [0.010031248082965627, 0.09513703484216929, 0.08930793294259994, 0.00017561341088857818], [0.01900785903185606, 0.09571509367159375, 0.08972824220870201, 1.838386827598265e-05], [0.027984469980746503, 0.09580578317926644, 0.08979517132563172, 3.666458592288535e-08], [0.03696108092963696, 0.09537321496910953, 0.08938952354135571, 5.953485616300158e-08], [0.04593769187852741, 0.0943947093388799, 0.08847031529542823, -1.0467581573053719e-07], [0.054914302827417855, 0.09285667271879315, 0.08699311614165939, -2.101223242345629e-05], [0.06389091377630829, 0.0906266255775428, 0.08502149809903072, 7.149269885765863e-05], [0.07286752472519875, 0.08787735285571535, 0.08232570234895736, -1.1081651846323037e-05], [0.08184413567408921, 0.08437587833965889, 0.07909221482110687, 9.316396540844096e-06], [0.09082074662297965, 0.08011878596323432, 0.07507450270729032, -8.988916432868532e-06], [0.09979735757187008, 0.0749766801956124, 0.07017735349238663, -2.1727398313978186e-05], [0.10877396852076054, 0.06860401679251937, 0.06424618047197614, -2.566661756252947e-05], [0.117750579469651, 0.0606793448722921, 0.056860106787717496, 6.710777537610735e-06], [0.1267271904185414, 0.05058701960162121, 0.047399256821313976, 1.5603330448310526e-05], [0.13570380136743188, 0.03659234443737833, 0.03425934636538543, 1.0741790325140277e-05], [0.14468041231632234, 0.004328900494599768, 0.0037336843414683472, -0.000247877763485099]]},
      0.003,
      0.012,
    );
  }
  if (meshes["hair-tip-5"] && nodes["head"]) {
    applyStandProud(
      meshes["hair-tip-5"].geometry,
      meshes["hair-tip-5"],
      nodes["head"],
      {"rings": [[-0.142571138048172, 0.004055454301137958, 0.004409333873655389, 0.018513035693796188], [-0.13359452709928155, 0.036139295664601695, 0.0379593956158101, 0.0173390790127941], [-0.1246179161503911, 0.047957831524763544, 0.05001886070279669, 0.01632614788246644], [-0.11564130520150068, 0.05545989803581714, 0.057127962792264314, 0.014581875007853757], [-0.10666469425261021, 0.06106630809316257, 0.061817626667726805, 0.012422077298670994], [-0.09768808330371975, 0.06671779619966606, 0.06546943498849106, 0.010271715845787198], [-0.08871147235482932, 0.07281198746376828, 0.06876657502793695, 0.008846480836889308], [-0.07973486140593888, 0.07881704895821892, 0.07257230847747806, 0.008921600558563239], [-0.07075825045704842, 0.08402580419193607, 0.08234098063245904, 0.015664397995288563], [-0.061781639508157966, 0.08810472524764089, 0.08879240322226689, 0.019393098792963324], [-0.052805028559267525, 0.0908933178725883, 0.09106929679920758, 0.019009384018945343], [-0.043828417610377084, 0.09272310737822818, 0.09315089142202451, 0.018249377129087953], [-0.03485180666148663, 0.09345012902162558, 0.09445898051809404, 0.016402953317279957], [-0.025875195712596173, 0.0934984418880333, 0.095123070004385, 0.013750160243346861], [-0.016898584763705732, 0.09337571447789941, 0.09387859574813084, 0.009750843243680599], [-0.007921973814815297, 0.0935922691027162, 0.08944625029987, 0.0030307552971284013], [0.0010546371340751648, 0.0942509292609486, 0.08879494554674258, 0.0007523180206619393], [0.010031248082965627, 0.09513703484216929, 0.08930793294259994, 0.00017561341088857818], [0.01900785903185606, 0.09571509367159375, 0.08972824220870201, 1.838386827598265e-05], [0.027984469980746503, 0.09580578317926644, 0.08979517132563172, 3.666458592288535e-08], [0.03696108092963696, 0.09537321496910953, 0.08938952354135571, 5.953485616300158e-08], [0.04593769187852741, 0.0943947093388799, 0.08847031529542823, -1.0467581573053719e-07], [0.054914302827417855, 0.09285667271879315, 0.08699311614165939, -2.101223242345629e-05], [0.06389091377630829, 0.0906266255775428, 0.08502149809903072, 7.149269885765863e-05], [0.07286752472519875, 0.08787735285571535, 0.08232570234895736, -1.1081651846323037e-05], [0.08184413567408921, 0.08437587833965889, 0.07909221482110687, 9.316396540844096e-06], [0.09082074662297965, 0.08011878596323432, 0.07507450270729032, -8.988916432868532e-06], [0.09979735757187008, 0.0749766801956124, 0.07017735349238663, -2.1727398313978186e-05], [0.10877396852076054, 0.06860401679251937, 0.06424618047197614, -2.566661756252947e-05], [0.117750579469651, 0.0606793448722921, 0.056860106787717496, 6.710777537610735e-06], [0.1267271904185414, 0.05058701960162121, 0.047399256821313976, 1.5603330448310526e-05], [0.13570380136743188, 0.03659234443737833, 0.03425934636538543, 1.0741790325140277e-05], [0.14468041231632234, 0.004328900494599768, 0.0037336843414683472, -0.000247877763485099]]},
      0.003,
      0.012,
    );
  }
  if (meshes["hair-tip-6"] && nodes["head"]) {
    applyStandProud(
      meshes["hair-tip-6"].geometry,
      meshes["hair-tip-6"],
      nodes["head"],
      {"rings": [[-0.142571138048172, 0.004055454301137958, 0.004409333873655389, 0.018513035693796188], [-0.13359452709928155, 0.036139295664601695, 0.0379593956158101, 0.0173390790127941], [-0.1246179161503911, 0.047957831524763544, 0.05001886070279669, 0.01632614788246644], [-0.11564130520150068, 0.05545989803581714, 0.057127962792264314, 0.014581875007853757], [-0.10666469425261021, 0.06106630809316257, 0.061817626667726805, 0.012422077298670994], [-0.09768808330371975, 0.06671779619966606, 0.06546943498849106, 0.010271715845787198], [-0.08871147235482932, 0.07281198746376828, 0.06876657502793695, 0.008846480836889308], [-0.07973486140593888, 0.07881704895821892, 0.07257230847747806, 0.008921600558563239], [-0.07075825045704842, 0.08402580419193607, 0.08234098063245904, 0.015664397995288563], [-0.061781639508157966, 0.08810472524764089, 0.08879240322226689, 0.019393098792963324], [-0.052805028559267525, 0.0908933178725883, 0.09106929679920758, 0.019009384018945343], [-0.043828417610377084, 0.09272310737822818, 0.09315089142202451, 0.018249377129087953], [-0.03485180666148663, 0.09345012902162558, 0.09445898051809404, 0.016402953317279957], [-0.025875195712596173, 0.0934984418880333, 0.095123070004385, 0.013750160243346861], [-0.016898584763705732, 0.09337571447789941, 0.09387859574813084, 0.009750843243680599], [-0.007921973814815297, 0.0935922691027162, 0.08944625029987, 0.0030307552971284013], [0.0010546371340751648, 0.0942509292609486, 0.08879494554674258, 0.0007523180206619393], [0.010031248082965627, 0.09513703484216929, 0.08930793294259994, 0.00017561341088857818], [0.01900785903185606, 0.09571509367159375, 0.08972824220870201, 1.838386827598265e-05], [0.027984469980746503, 0.09580578317926644, 0.08979517132563172, 3.666458592288535e-08], [0.03696108092963696, 0.09537321496910953, 0.08938952354135571, 5.953485616300158e-08], [0.04593769187852741, 0.0943947093388799, 0.08847031529542823, -1.0467581573053719e-07], [0.054914302827417855, 0.09285667271879315, 0.08699311614165939, -2.101223242345629e-05], [0.06389091377630829, 0.0906266255775428, 0.08502149809903072, 7.149269885765863e-05], [0.07286752472519875, 0.08787735285571535, 0.08232570234895736, -1.1081651846323037e-05], [0.08184413567408921, 0.08437587833965889, 0.07909221482110687, 9.316396540844096e-06], [0.09082074662297965, 0.08011878596323432, 0.07507450270729032, -8.988916432868532e-06], [0.09979735757187008, 0.0749766801956124, 0.07017735349238663, -2.1727398313978186e-05], [0.10877396852076054, 0.06860401679251937, 0.06424618047197614, -2.566661756252947e-05], [0.117750579469651, 0.0606793448722921, 0.056860106787717496, 6.710777537610735e-06], [0.1267271904185414, 0.05058701960162121, 0.047399256821313976, 1.5603330448310526e-05], [0.13570380136743188, 0.03659234443737833, 0.03425934636538543, 1.0741790325140277e-05], [0.14468041231632234, 0.004328900494599768, 0.0037336843414683472, -0.000247877763485099]]},
      0.003,
      0.012,
    );
  }
  if (meshes["hair-tip-7"] && nodes["head"]) {
    applyStandProud(
      meshes["hair-tip-7"].geometry,
      meshes["hair-tip-7"],
      nodes["head"],
      {"rings": [[-0.142571138048172, 0.004055454301137958, 0.004409333873655389, 0.018513035693796188], [-0.13359452709928155, 0.036139295664601695, 0.0379593956158101, 0.0173390790127941], [-0.1246179161503911, 0.047957831524763544, 0.05001886070279669, 0.01632614788246644], [-0.11564130520150068, 0.05545989803581714, 0.057127962792264314, 0.014581875007853757], [-0.10666469425261021, 0.06106630809316257, 0.061817626667726805, 0.012422077298670994], [-0.09768808330371975, 0.06671779619966606, 0.06546943498849106, 0.010271715845787198], [-0.08871147235482932, 0.07281198746376828, 0.06876657502793695, 0.008846480836889308], [-0.07973486140593888, 0.07881704895821892, 0.07257230847747806, 0.008921600558563239], [-0.07075825045704842, 0.08402580419193607, 0.08234098063245904, 0.015664397995288563], [-0.061781639508157966, 0.08810472524764089, 0.08879240322226689, 0.019393098792963324], [-0.052805028559267525, 0.0908933178725883, 0.09106929679920758, 0.019009384018945343], [-0.043828417610377084, 0.09272310737822818, 0.09315089142202451, 0.018249377129087953], [-0.03485180666148663, 0.09345012902162558, 0.09445898051809404, 0.016402953317279957], [-0.025875195712596173, 0.0934984418880333, 0.095123070004385, 0.013750160243346861], [-0.016898584763705732, 0.09337571447789941, 0.09387859574813084, 0.009750843243680599], [-0.007921973814815297, 0.0935922691027162, 0.08944625029987, 0.0030307552971284013], [0.0010546371340751648, 0.0942509292609486, 0.08879494554674258, 0.0007523180206619393], [0.010031248082965627, 0.09513703484216929, 0.08930793294259994, 0.00017561341088857818], [0.01900785903185606, 0.09571509367159375, 0.08972824220870201, 1.838386827598265e-05], [0.027984469980746503, 0.09580578317926644, 0.08979517132563172, 3.666458592288535e-08], [0.03696108092963696, 0.09537321496910953, 0.08938952354135571, 5.953485616300158e-08], [0.04593769187852741, 0.0943947093388799, 0.08847031529542823, -1.0467581573053719e-07], [0.054914302827417855, 0.09285667271879315, 0.08699311614165939, -2.101223242345629e-05], [0.06389091377630829, 0.0906266255775428, 0.08502149809903072, 7.149269885765863e-05], [0.07286752472519875, 0.08787735285571535, 0.08232570234895736, -1.1081651846323037e-05], [0.08184413567408921, 0.08437587833965889, 0.07909221482110687, 9.316396540844096e-06], [0.09082074662297965, 0.08011878596323432, 0.07507450270729032, -8.988916432868532e-06], [0.09979735757187008, 0.0749766801956124, 0.07017735349238663, -2.1727398313978186e-05], [0.10877396852076054, 0.06860401679251937, 0.06424618047197614, -2.566661756252947e-05], [0.117750579469651, 0.0606793448722921, 0.056860106787717496, 6.710777537610735e-06], [0.1267271904185414, 0.05058701960162121, 0.047399256821313976, 1.5603330448310526e-05], [0.13570380136743188, 0.03659234443737833, 0.03425934636538543, 1.0741790325140277e-05], [0.14468041231632234, 0.004328900494599768, 0.0037336843414683472, -0.000247877763485099]]},
      0.003,
      0.012,
    );
  }
  if (meshes["hair-tip-8"] && nodes["head"]) {
    applyStandProud(
      meshes["hair-tip-8"].geometry,
      meshes["hair-tip-8"],
      nodes["head"],
      {"rings": [[-0.142571138048172, 0.004055454301137958, 0.004409333873655389, 0.018513035693796188], [-0.13359452709928155, 0.036139295664601695, 0.0379593956158101, 0.0173390790127941], [-0.1246179161503911, 0.047957831524763544, 0.05001886070279669, 0.01632614788246644], [-0.11564130520150068, 0.05545989803581714, 0.057127962792264314, 0.014581875007853757], [-0.10666469425261021, 0.06106630809316257, 0.061817626667726805, 0.012422077298670994], [-0.09768808330371975, 0.06671779619966606, 0.06546943498849106, 0.010271715845787198], [-0.08871147235482932, 0.07281198746376828, 0.06876657502793695, 0.008846480836889308], [-0.07973486140593888, 0.07881704895821892, 0.07257230847747806, 0.008921600558563239], [-0.07075825045704842, 0.08402580419193607, 0.08234098063245904, 0.015664397995288563], [-0.061781639508157966, 0.08810472524764089, 0.08879240322226689, 0.019393098792963324], [-0.052805028559267525, 0.0908933178725883, 0.09106929679920758, 0.019009384018945343], [-0.043828417610377084, 0.09272310737822818, 0.09315089142202451, 0.018249377129087953], [-0.03485180666148663, 0.09345012902162558, 0.09445898051809404, 0.016402953317279957], [-0.025875195712596173, 0.0934984418880333, 0.095123070004385, 0.013750160243346861], [-0.016898584763705732, 0.09337571447789941, 0.09387859574813084, 0.009750843243680599], [-0.007921973814815297, 0.0935922691027162, 0.08944625029987, 0.0030307552971284013], [0.0010546371340751648, 0.0942509292609486, 0.08879494554674258, 0.0007523180206619393], [0.010031248082965627, 0.09513703484216929, 0.08930793294259994, 0.00017561341088857818], [0.01900785903185606, 0.09571509367159375, 0.08972824220870201, 1.838386827598265e-05], [0.027984469980746503, 0.09580578317926644, 0.08979517132563172, 3.666458592288535e-08], [0.03696108092963696, 0.09537321496910953, 0.08938952354135571, 5.953485616300158e-08], [0.04593769187852741, 0.0943947093388799, 0.08847031529542823, -1.0467581573053719e-07], [0.054914302827417855, 0.09285667271879315, 0.08699311614165939, -2.101223242345629e-05], [0.06389091377630829, 0.0906266255775428, 0.08502149809903072, 7.149269885765863e-05], [0.07286752472519875, 0.08787735285571535, 0.08232570234895736, -1.1081651846323037e-05], [0.08184413567408921, 0.08437587833965889, 0.07909221482110687, 9.316396540844096e-06], [0.09082074662297965, 0.08011878596323432, 0.07507450270729032, -8.988916432868532e-06], [0.09979735757187008, 0.0749766801956124, 0.07017735349238663, -2.1727398313978186e-05], [0.10877396852076054, 0.06860401679251937, 0.06424618047197614, -2.566661756252947e-05], [0.117750579469651, 0.0606793448722921, 0.056860106787717496, 6.710777537610735e-06], [0.1267271904185414, 0.05058701960162121, 0.047399256821313976, 1.5603330448310526e-05], [0.13570380136743188, 0.03659234443737833, 0.03425934636538543, 1.0741790325140277e-05], [0.14468041231632234, 0.004328900494599768, 0.0037336843414683472, -0.000247877763485099]]},
      0.003,
      0.012,
    );
  }
  if (meshes["hair-tip-9"] && nodes["head"]) {
    applyStandProud(
      meshes["hair-tip-9"].geometry,
      meshes["hair-tip-9"],
      nodes["head"],
      {"rings": [[-0.142571138048172, 0.004055454301137958, 0.004409333873655389, 0.018513035693796188], [-0.13359452709928155, 0.036139295664601695, 0.0379593956158101, 0.0173390790127941], [-0.1246179161503911, 0.047957831524763544, 0.05001886070279669, 0.01632614788246644], [-0.11564130520150068, 0.05545989803581714, 0.057127962792264314, 0.014581875007853757], [-0.10666469425261021, 0.06106630809316257, 0.061817626667726805, 0.012422077298670994], [-0.09768808330371975, 0.06671779619966606, 0.06546943498849106, 0.010271715845787198], [-0.08871147235482932, 0.07281198746376828, 0.06876657502793695, 0.008846480836889308], [-0.07973486140593888, 0.07881704895821892, 0.07257230847747806, 0.008921600558563239], [-0.07075825045704842, 0.08402580419193607, 0.08234098063245904, 0.015664397995288563], [-0.061781639508157966, 0.08810472524764089, 0.08879240322226689, 0.019393098792963324], [-0.052805028559267525, 0.0908933178725883, 0.09106929679920758, 0.019009384018945343], [-0.043828417610377084, 0.09272310737822818, 0.09315089142202451, 0.018249377129087953], [-0.03485180666148663, 0.09345012902162558, 0.09445898051809404, 0.016402953317279957], [-0.025875195712596173, 0.0934984418880333, 0.095123070004385, 0.013750160243346861], [-0.016898584763705732, 0.09337571447789941, 0.09387859574813084, 0.009750843243680599], [-0.007921973814815297, 0.0935922691027162, 0.08944625029987, 0.0030307552971284013], [0.0010546371340751648, 0.0942509292609486, 0.08879494554674258, 0.0007523180206619393], [0.010031248082965627, 0.09513703484216929, 0.08930793294259994, 0.00017561341088857818], [0.01900785903185606, 0.09571509367159375, 0.08972824220870201, 1.838386827598265e-05], [0.027984469980746503, 0.09580578317926644, 0.08979517132563172, 3.666458592288535e-08], [0.03696108092963696, 0.09537321496910953, 0.08938952354135571, 5.953485616300158e-08], [0.04593769187852741, 0.0943947093388799, 0.08847031529542823, -1.0467581573053719e-07], [0.054914302827417855, 0.09285667271879315, 0.08699311614165939, -2.101223242345629e-05], [0.06389091377630829, 0.0906266255775428, 0.08502149809903072, 7.149269885765863e-05], [0.07286752472519875, 0.08787735285571535, 0.08232570234895736, -1.1081651846323037e-05], [0.08184413567408921, 0.08437587833965889, 0.07909221482110687, 9.316396540844096e-06], [0.09082074662297965, 0.08011878596323432, 0.07507450270729032, -8.988916432868532e-06], [0.09979735757187008, 0.0749766801956124, 0.07017735349238663, -2.1727398313978186e-05], [0.10877396852076054, 0.06860401679251937, 0.06424618047197614, -2.566661756252947e-05], [0.117750579469651, 0.0606793448722921, 0.056860106787717496, 6.710777537610735e-06], [0.1267271904185414, 0.05058701960162121, 0.047399256821313976, 1.5603330448310526e-05], [0.13570380136743188, 0.03659234443737833, 0.03425934636538543, 1.0741790325140277e-05], [0.14468041231632234, 0.004328900494599768, 0.0037336843414683472, -0.000247877763485099]]},
      0.003,
      0.012,
    );
  }
  if (meshes["hair-tip-10"] && nodes["head"]) {
    applyStandProud(
      meshes["hair-tip-10"].geometry,
      meshes["hair-tip-10"],
      nodes["head"],
      {"rings": [[-0.142571138048172, 0.004055454301137958, 0.004409333873655389, 0.018513035693796188], [-0.13359452709928155, 0.036139295664601695, 0.0379593956158101, 0.0173390790127941], [-0.1246179161503911, 0.047957831524763544, 0.05001886070279669, 0.01632614788246644], [-0.11564130520150068, 0.05545989803581714, 0.057127962792264314, 0.014581875007853757], [-0.10666469425261021, 0.06106630809316257, 0.061817626667726805, 0.012422077298670994], [-0.09768808330371975, 0.06671779619966606, 0.06546943498849106, 0.010271715845787198], [-0.08871147235482932, 0.07281198746376828, 0.06876657502793695, 0.008846480836889308], [-0.07973486140593888, 0.07881704895821892, 0.07257230847747806, 0.008921600558563239], [-0.07075825045704842, 0.08402580419193607, 0.08234098063245904, 0.015664397995288563], [-0.061781639508157966, 0.08810472524764089, 0.08879240322226689, 0.019393098792963324], [-0.052805028559267525, 0.0908933178725883, 0.09106929679920758, 0.019009384018945343], [-0.043828417610377084, 0.09272310737822818, 0.09315089142202451, 0.018249377129087953], [-0.03485180666148663, 0.09345012902162558, 0.09445898051809404, 0.016402953317279957], [-0.025875195712596173, 0.0934984418880333, 0.095123070004385, 0.013750160243346861], [-0.016898584763705732, 0.09337571447789941, 0.09387859574813084, 0.009750843243680599], [-0.007921973814815297, 0.0935922691027162, 0.08944625029987, 0.0030307552971284013], [0.0010546371340751648, 0.0942509292609486, 0.08879494554674258, 0.0007523180206619393], [0.010031248082965627, 0.09513703484216929, 0.08930793294259994, 0.00017561341088857818], [0.01900785903185606, 0.09571509367159375, 0.08972824220870201, 1.838386827598265e-05], [0.027984469980746503, 0.09580578317926644, 0.08979517132563172, 3.666458592288535e-08], [0.03696108092963696, 0.09537321496910953, 0.08938952354135571, 5.953485616300158e-08], [0.04593769187852741, 0.0943947093388799, 0.08847031529542823, -1.0467581573053719e-07], [0.054914302827417855, 0.09285667271879315, 0.08699311614165939, -2.101223242345629e-05], [0.06389091377630829, 0.0906266255775428, 0.08502149809903072, 7.149269885765863e-05], [0.07286752472519875, 0.08787735285571535, 0.08232570234895736, -1.1081651846323037e-05], [0.08184413567408921, 0.08437587833965889, 0.07909221482110687, 9.316396540844096e-06], [0.09082074662297965, 0.08011878596323432, 0.07507450270729032, -8.988916432868532e-06], [0.09979735757187008, 0.0749766801956124, 0.07017735349238663, -2.1727398313978186e-05], [0.10877396852076054, 0.06860401679251937, 0.06424618047197614, -2.566661756252947e-05], [0.117750579469651, 0.0606793448722921, 0.056860106787717496, 6.710777537610735e-06], [0.1267271904185414, 0.05058701960162121, 0.047399256821313976, 1.5603330448310526e-05], [0.13570380136743188, 0.03659234443737833, 0.03425934636538543, 1.0741790325140277e-05], [0.14468041231632234, 0.004328900494599768, 0.0037336843414683472, -0.000247877763485099]]},
      0.003,
      0.012,
    );
  }
  if (meshes["hair-tip-11"] && nodes["head"]) {
    applyStandProud(
      meshes["hair-tip-11"].geometry,
      meshes["hair-tip-11"],
      nodes["head"],
      {"rings": [[-0.142571138048172, 0.004055454301137958, 0.004409333873655389, 0.018513035693796188], [-0.13359452709928155, 0.036139295664601695, 0.0379593956158101, 0.0173390790127941], [-0.1246179161503911, 0.047957831524763544, 0.05001886070279669, 0.01632614788246644], [-0.11564130520150068, 0.05545989803581714, 0.057127962792264314, 0.014581875007853757], [-0.10666469425261021, 0.06106630809316257, 0.061817626667726805, 0.012422077298670994], [-0.09768808330371975, 0.06671779619966606, 0.06546943498849106, 0.010271715845787198], [-0.08871147235482932, 0.07281198746376828, 0.06876657502793695, 0.008846480836889308], [-0.07973486140593888, 0.07881704895821892, 0.07257230847747806, 0.008921600558563239], [-0.07075825045704842, 0.08402580419193607, 0.08234098063245904, 0.015664397995288563], [-0.061781639508157966, 0.08810472524764089, 0.08879240322226689, 0.019393098792963324], [-0.052805028559267525, 0.0908933178725883, 0.09106929679920758, 0.019009384018945343], [-0.043828417610377084, 0.09272310737822818, 0.09315089142202451, 0.018249377129087953], [-0.03485180666148663, 0.09345012902162558, 0.09445898051809404, 0.016402953317279957], [-0.025875195712596173, 0.0934984418880333, 0.095123070004385, 0.013750160243346861], [-0.016898584763705732, 0.09337571447789941, 0.09387859574813084, 0.009750843243680599], [-0.007921973814815297, 0.0935922691027162, 0.08944625029987, 0.0030307552971284013], [0.0010546371340751648, 0.0942509292609486, 0.08879494554674258, 0.0007523180206619393], [0.010031248082965627, 0.09513703484216929, 0.08930793294259994, 0.00017561341088857818], [0.01900785903185606, 0.09571509367159375, 0.08972824220870201, 1.838386827598265e-05], [0.027984469980746503, 0.09580578317926644, 0.08979517132563172, 3.666458592288535e-08], [0.03696108092963696, 0.09537321496910953, 0.08938952354135571, 5.953485616300158e-08], [0.04593769187852741, 0.0943947093388799, 0.08847031529542823, -1.0467581573053719e-07], [0.054914302827417855, 0.09285667271879315, 0.08699311614165939, -2.101223242345629e-05], [0.06389091377630829, 0.0906266255775428, 0.08502149809903072, 7.149269885765863e-05], [0.07286752472519875, 0.08787735285571535, 0.08232570234895736, -1.1081651846323037e-05], [0.08184413567408921, 0.08437587833965889, 0.07909221482110687, 9.316396540844096e-06], [0.09082074662297965, 0.08011878596323432, 0.07507450270729032, -8.988916432868532e-06], [0.09979735757187008, 0.0749766801956124, 0.07017735349238663, -2.1727398313978186e-05], [0.10877396852076054, 0.06860401679251937, 0.06424618047197614, -2.566661756252947e-05], [0.117750579469651, 0.0606793448722921, 0.056860106787717496, 6.710777537610735e-06], [0.1267271904185414, 0.05058701960162121, 0.047399256821313976, 1.5603330448310526e-05], [0.13570380136743188, 0.03659234443737833, 0.03425934636538543, 1.0741790325140277e-05], [0.14468041231632234, 0.004328900494599768, 0.0037336843414683472, -0.000247877763485099]]},
      0.003,
      0.012,
    );
  }
  if (meshes["hair-tip-12"] && nodes["head"]) {
    applyStandProud(
      meshes["hair-tip-12"].geometry,
      meshes["hair-tip-12"],
      nodes["head"],
      {"rings": [[-0.142571138048172, 0.004055454301137958, 0.004409333873655389, 0.018513035693796188], [-0.13359452709928155, 0.036139295664601695, 0.0379593956158101, 0.0173390790127941], [-0.1246179161503911, 0.047957831524763544, 0.05001886070279669, 0.01632614788246644], [-0.11564130520150068, 0.05545989803581714, 0.057127962792264314, 0.014581875007853757], [-0.10666469425261021, 0.06106630809316257, 0.061817626667726805, 0.012422077298670994], [-0.09768808330371975, 0.06671779619966606, 0.06546943498849106, 0.010271715845787198], [-0.08871147235482932, 0.07281198746376828, 0.06876657502793695, 0.008846480836889308], [-0.07973486140593888, 0.07881704895821892, 0.07257230847747806, 0.008921600558563239], [-0.07075825045704842, 0.08402580419193607, 0.08234098063245904, 0.015664397995288563], [-0.061781639508157966, 0.08810472524764089, 0.08879240322226689, 0.019393098792963324], [-0.052805028559267525, 0.0908933178725883, 0.09106929679920758, 0.019009384018945343], [-0.043828417610377084, 0.09272310737822818, 0.09315089142202451, 0.018249377129087953], [-0.03485180666148663, 0.09345012902162558, 0.09445898051809404, 0.016402953317279957], [-0.025875195712596173, 0.0934984418880333, 0.095123070004385, 0.013750160243346861], [-0.016898584763705732, 0.09337571447789941, 0.09387859574813084, 0.009750843243680599], [-0.007921973814815297, 0.0935922691027162, 0.08944625029987, 0.0030307552971284013], [0.0010546371340751648, 0.0942509292609486, 0.08879494554674258, 0.0007523180206619393], [0.010031248082965627, 0.09513703484216929, 0.08930793294259994, 0.00017561341088857818], [0.01900785903185606, 0.09571509367159375, 0.08972824220870201, 1.838386827598265e-05], [0.027984469980746503, 0.09580578317926644, 0.08979517132563172, 3.666458592288535e-08], [0.03696108092963696, 0.09537321496910953, 0.08938952354135571, 5.953485616300158e-08], [0.04593769187852741, 0.0943947093388799, 0.08847031529542823, -1.0467581573053719e-07], [0.054914302827417855, 0.09285667271879315, 0.08699311614165939, -2.101223242345629e-05], [0.06389091377630829, 0.0906266255775428, 0.08502149809903072, 7.149269885765863e-05], [0.07286752472519875, 0.08787735285571535, 0.08232570234895736, -1.1081651846323037e-05], [0.08184413567408921, 0.08437587833965889, 0.07909221482110687, 9.316396540844096e-06], [0.09082074662297965, 0.08011878596323432, 0.07507450270729032, -8.988916432868532e-06], [0.09979735757187008, 0.0749766801956124, 0.07017735349238663, -2.1727398313978186e-05], [0.10877396852076054, 0.06860401679251937, 0.06424618047197614, -2.566661756252947e-05], [0.117750579469651, 0.0606793448722921, 0.056860106787717496, 6.710777537610735e-06], [0.1267271904185414, 0.05058701960162121, 0.047399256821313976, 1.5603330448310526e-05], [0.13570380136743188, 0.03659234443737833, 0.03425934636538543, 1.0741790325140277e-05], [0.14468041231632234, 0.004328900494599768, 0.0037336843414683472, -0.000247877763485099]]},
      0.003,
      0.012,
    );
  }
  if (meshes["hair-tip-13"] && nodes["head"]) {
    applyStandProud(
      meshes["hair-tip-13"].geometry,
      meshes["hair-tip-13"],
      nodes["head"],
      {"rings": [[-0.142571138048172, 0.004055454301137958, 0.004409333873655389, 0.018513035693796188], [-0.13359452709928155, 0.036139295664601695, 0.0379593956158101, 0.0173390790127941], [-0.1246179161503911, 0.047957831524763544, 0.05001886070279669, 0.01632614788246644], [-0.11564130520150068, 0.05545989803581714, 0.057127962792264314, 0.014581875007853757], [-0.10666469425261021, 0.06106630809316257, 0.061817626667726805, 0.012422077298670994], [-0.09768808330371975, 0.06671779619966606, 0.06546943498849106, 0.010271715845787198], [-0.08871147235482932, 0.07281198746376828, 0.06876657502793695, 0.008846480836889308], [-0.07973486140593888, 0.07881704895821892, 0.07257230847747806, 0.008921600558563239], [-0.07075825045704842, 0.08402580419193607, 0.08234098063245904, 0.015664397995288563], [-0.061781639508157966, 0.08810472524764089, 0.08879240322226689, 0.019393098792963324], [-0.052805028559267525, 0.0908933178725883, 0.09106929679920758, 0.019009384018945343], [-0.043828417610377084, 0.09272310737822818, 0.09315089142202451, 0.018249377129087953], [-0.03485180666148663, 0.09345012902162558, 0.09445898051809404, 0.016402953317279957], [-0.025875195712596173, 0.0934984418880333, 0.095123070004385, 0.013750160243346861], [-0.016898584763705732, 0.09337571447789941, 0.09387859574813084, 0.009750843243680599], [-0.007921973814815297, 0.0935922691027162, 0.08944625029987, 0.0030307552971284013], [0.0010546371340751648, 0.0942509292609486, 0.08879494554674258, 0.0007523180206619393], [0.010031248082965627, 0.09513703484216929, 0.08930793294259994, 0.00017561341088857818], [0.01900785903185606, 0.09571509367159375, 0.08972824220870201, 1.838386827598265e-05], [0.027984469980746503, 0.09580578317926644, 0.08979517132563172, 3.666458592288535e-08], [0.03696108092963696, 0.09537321496910953, 0.08938952354135571, 5.953485616300158e-08], [0.04593769187852741, 0.0943947093388799, 0.08847031529542823, -1.0467581573053719e-07], [0.054914302827417855, 0.09285667271879315, 0.08699311614165939, -2.101223242345629e-05], [0.06389091377630829, 0.0906266255775428, 0.08502149809903072, 7.149269885765863e-05], [0.07286752472519875, 0.08787735285571535, 0.08232570234895736, -1.1081651846323037e-05], [0.08184413567408921, 0.08437587833965889, 0.07909221482110687, 9.316396540844096e-06], [0.09082074662297965, 0.08011878596323432, 0.07507450270729032, -8.988916432868532e-06], [0.09979735757187008, 0.0749766801956124, 0.07017735349238663, -2.1727398313978186e-05], [0.10877396852076054, 0.06860401679251937, 0.06424618047197614, -2.566661756252947e-05], [0.117750579469651, 0.0606793448722921, 0.056860106787717496, 6.710777537610735e-06], [0.1267271904185414, 0.05058701960162121, 0.047399256821313976, 1.5603330448310526e-05], [0.13570380136743188, 0.03659234443737833, 0.03425934636538543, 1.0741790325140277e-05], [0.14468041231632234, 0.004328900494599768, 0.0037336843414683472, -0.000247877763485099]]},
      0.003,
      0.012,
    );
  }
  if (meshes["hair-tip-14"] && nodes["head"]) {
    applyStandProud(
      meshes["hair-tip-14"].geometry,
      meshes["hair-tip-14"],
      nodes["head"],
      {"rings": [[-0.142571138048172, 0.004055454301137958, 0.004409333873655389, 0.018513035693796188], [-0.13359452709928155, 0.036139295664601695, 0.0379593956158101, 0.0173390790127941], [-0.1246179161503911, 0.047957831524763544, 0.05001886070279669, 0.01632614788246644], [-0.11564130520150068, 0.05545989803581714, 0.057127962792264314, 0.014581875007853757], [-0.10666469425261021, 0.06106630809316257, 0.061817626667726805, 0.012422077298670994], [-0.09768808330371975, 0.06671779619966606, 0.06546943498849106, 0.010271715845787198], [-0.08871147235482932, 0.07281198746376828, 0.06876657502793695, 0.008846480836889308], [-0.07973486140593888, 0.07881704895821892, 0.07257230847747806, 0.008921600558563239], [-0.07075825045704842, 0.08402580419193607, 0.08234098063245904, 0.015664397995288563], [-0.061781639508157966, 0.08810472524764089, 0.08879240322226689, 0.019393098792963324], [-0.052805028559267525, 0.0908933178725883, 0.09106929679920758, 0.019009384018945343], [-0.043828417610377084, 0.09272310737822818, 0.09315089142202451, 0.018249377129087953], [-0.03485180666148663, 0.09345012902162558, 0.09445898051809404, 0.016402953317279957], [-0.025875195712596173, 0.0934984418880333, 0.095123070004385, 0.013750160243346861], [-0.016898584763705732, 0.09337571447789941, 0.09387859574813084, 0.009750843243680599], [-0.007921973814815297, 0.0935922691027162, 0.08944625029987, 0.0030307552971284013], [0.0010546371340751648, 0.0942509292609486, 0.08879494554674258, 0.0007523180206619393], [0.010031248082965627, 0.09513703484216929, 0.08930793294259994, 0.00017561341088857818], [0.01900785903185606, 0.09571509367159375, 0.08972824220870201, 1.838386827598265e-05], [0.027984469980746503, 0.09580578317926644, 0.08979517132563172, 3.666458592288535e-08], [0.03696108092963696, 0.09537321496910953, 0.08938952354135571, 5.953485616300158e-08], [0.04593769187852741, 0.0943947093388799, 0.08847031529542823, -1.0467581573053719e-07], [0.054914302827417855, 0.09285667271879315, 0.08699311614165939, -2.101223242345629e-05], [0.06389091377630829, 0.0906266255775428, 0.08502149809903072, 7.149269885765863e-05], [0.07286752472519875, 0.08787735285571535, 0.08232570234895736, -1.1081651846323037e-05], [0.08184413567408921, 0.08437587833965889, 0.07909221482110687, 9.316396540844096e-06], [0.09082074662297965, 0.08011878596323432, 0.07507450270729032, -8.988916432868532e-06], [0.09979735757187008, 0.0749766801956124, 0.07017735349238663, -2.1727398313978186e-05], [0.10877396852076054, 0.06860401679251937, 0.06424618047197614, -2.566661756252947e-05], [0.117750579469651, 0.0606793448722921, 0.056860106787717496, 6.710777537610735e-06], [0.1267271904185414, 0.05058701960162121, 0.047399256821313976, 1.5603330448310526e-05], [0.13570380136743188, 0.03659234443737833, 0.03425934636538543, 1.0741790325140277e-05], [0.14468041231632234, 0.004328900494599768, 0.0037336843414683472, -0.000247877763485099]]},
      0.003,
      0.012,
    );
  }
  if (meshes["hair-tip-15"] && nodes["head"]) {
    applyStandProud(
      meshes["hair-tip-15"].geometry,
      meshes["hair-tip-15"],
      nodes["head"],
      {"rings": [[-0.142571138048172, 0.004055454301137958, 0.004409333873655389, 0.018513035693796188], [-0.13359452709928155, 0.036139295664601695, 0.0379593956158101, 0.0173390790127941], [-0.1246179161503911, 0.047957831524763544, 0.05001886070279669, 0.01632614788246644], [-0.11564130520150068, 0.05545989803581714, 0.057127962792264314, 0.014581875007853757], [-0.10666469425261021, 0.06106630809316257, 0.061817626667726805, 0.012422077298670994], [-0.09768808330371975, 0.06671779619966606, 0.06546943498849106, 0.010271715845787198], [-0.08871147235482932, 0.07281198746376828, 0.06876657502793695, 0.008846480836889308], [-0.07973486140593888, 0.07881704895821892, 0.07257230847747806, 0.008921600558563239], [-0.07075825045704842, 0.08402580419193607, 0.08234098063245904, 0.015664397995288563], [-0.061781639508157966, 0.08810472524764089, 0.08879240322226689, 0.019393098792963324], [-0.052805028559267525, 0.0908933178725883, 0.09106929679920758, 0.019009384018945343], [-0.043828417610377084, 0.09272310737822818, 0.09315089142202451, 0.018249377129087953], [-0.03485180666148663, 0.09345012902162558, 0.09445898051809404, 0.016402953317279957], [-0.025875195712596173, 0.0934984418880333, 0.095123070004385, 0.013750160243346861], [-0.016898584763705732, 0.09337571447789941, 0.09387859574813084, 0.009750843243680599], [-0.007921973814815297, 0.0935922691027162, 0.08944625029987, 0.0030307552971284013], [0.0010546371340751648, 0.0942509292609486, 0.08879494554674258, 0.0007523180206619393], [0.010031248082965627, 0.09513703484216929, 0.08930793294259994, 0.00017561341088857818], [0.01900785903185606, 0.09571509367159375, 0.08972824220870201, 1.838386827598265e-05], [0.027984469980746503, 0.09580578317926644, 0.08979517132563172, 3.666458592288535e-08], [0.03696108092963696, 0.09537321496910953, 0.08938952354135571, 5.953485616300158e-08], [0.04593769187852741, 0.0943947093388799, 0.08847031529542823, -1.0467581573053719e-07], [0.054914302827417855, 0.09285667271879315, 0.08699311614165939, -2.101223242345629e-05], [0.06389091377630829, 0.0906266255775428, 0.08502149809903072, 7.149269885765863e-05], [0.07286752472519875, 0.08787735285571535, 0.08232570234895736, -1.1081651846323037e-05], [0.08184413567408921, 0.08437587833965889, 0.07909221482110687, 9.316396540844096e-06], [0.09082074662297965, 0.08011878596323432, 0.07507450270729032, -8.988916432868532e-06], [0.09979735757187008, 0.0749766801956124, 0.07017735349238663, -2.1727398313978186e-05], [0.10877396852076054, 0.06860401679251937, 0.06424618047197614, -2.566661756252947e-05], [0.117750579469651, 0.0606793448722921, 0.056860106787717496, 6.710777537610735e-06], [0.1267271904185414, 0.05058701960162121, 0.047399256821313976, 1.5603330448310526e-05], [0.13570380136743188, 0.03659234443737833, 0.03425934636538543, 1.0741790325140277e-05], [0.14468041231632234, 0.004328900494599768, 0.0037336843414683472, -0.000247877763485099]]},
      0.003,
      0.012,
    );
  }
  if (meshes["hair-tip-16"] && nodes["head"]) {
    applyStandProud(
      meshes["hair-tip-16"].geometry,
      meshes["hair-tip-16"],
      nodes["head"],
      {"rings": [[-0.142571138048172, 0.004055454301137958, 0.004409333873655389, 0.018513035693796188], [-0.13359452709928155, 0.036139295664601695, 0.0379593956158101, 0.0173390790127941], [-0.1246179161503911, 0.047957831524763544, 0.05001886070279669, 0.01632614788246644], [-0.11564130520150068, 0.05545989803581714, 0.057127962792264314, 0.014581875007853757], [-0.10666469425261021, 0.06106630809316257, 0.061817626667726805, 0.012422077298670994], [-0.09768808330371975, 0.06671779619966606, 0.06546943498849106, 0.010271715845787198], [-0.08871147235482932, 0.07281198746376828, 0.06876657502793695, 0.008846480836889308], [-0.07973486140593888, 0.07881704895821892, 0.07257230847747806, 0.008921600558563239], [-0.07075825045704842, 0.08402580419193607, 0.08234098063245904, 0.015664397995288563], [-0.061781639508157966, 0.08810472524764089, 0.08879240322226689, 0.019393098792963324], [-0.052805028559267525, 0.0908933178725883, 0.09106929679920758, 0.019009384018945343], [-0.043828417610377084, 0.09272310737822818, 0.09315089142202451, 0.018249377129087953], [-0.03485180666148663, 0.09345012902162558, 0.09445898051809404, 0.016402953317279957], [-0.025875195712596173, 0.0934984418880333, 0.095123070004385, 0.013750160243346861], [-0.016898584763705732, 0.09337571447789941, 0.09387859574813084, 0.009750843243680599], [-0.007921973814815297, 0.0935922691027162, 0.08944625029987, 0.0030307552971284013], [0.0010546371340751648, 0.0942509292609486, 0.08879494554674258, 0.0007523180206619393], [0.010031248082965627, 0.09513703484216929, 0.08930793294259994, 0.00017561341088857818], [0.01900785903185606, 0.09571509367159375, 0.08972824220870201, 1.838386827598265e-05], [0.027984469980746503, 0.09580578317926644, 0.08979517132563172, 3.666458592288535e-08], [0.03696108092963696, 0.09537321496910953, 0.08938952354135571, 5.953485616300158e-08], [0.04593769187852741, 0.0943947093388799, 0.08847031529542823, -1.0467581573053719e-07], [0.054914302827417855, 0.09285667271879315, 0.08699311614165939, -2.101223242345629e-05], [0.06389091377630829, 0.0906266255775428, 0.08502149809903072, 7.149269885765863e-05], [0.07286752472519875, 0.08787735285571535, 0.08232570234895736, -1.1081651846323037e-05], [0.08184413567408921, 0.08437587833965889, 0.07909221482110687, 9.316396540844096e-06], [0.09082074662297965, 0.08011878596323432, 0.07507450270729032, -8.988916432868532e-06], [0.09979735757187008, 0.0749766801956124, 0.07017735349238663, -2.1727398313978186e-05], [0.10877396852076054, 0.06860401679251937, 0.06424618047197614, -2.566661756252947e-05], [0.117750579469651, 0.0606793448722921, 0.056860106787717496, 6.710777537610735e-06], [0.1267271904185414, 0.05058701960162121, 0.047399256821313976, 1.5603330448310526e-05], [0.13570380136743188, 0.03659234443737833, 0.03425934636538543, 1.0741790325140277e-05], [0.14468041231632234, 0.004328900494599768, 0.0037336843414683472, -0.000247877763485099]]},
      0.003,
      0.012,
    );
  }
  if (meshes["hair-tip-17"] && nodes["head"]) {
    applyStandProud(
      meshes["hair-tip-17"].geometry,
      meshes["hair-tip-17"],
      nodes["head"],
      {"rings": [[-0.142571138048172, 0.004055454301137958, 0.004409333873655389, 0.018513035693796188], [-0.13359452709928155, 0.036139295664601695, 0.0379593956158101, 0.0173390790127941], [-0.1246179161503911, 0.047957831524763544, 0.05001886070279669, 0.01632614788246644], [-0.11564130520150068, 0.05545989803581714, 0.057127962792264314, 0.014581875007853757], [-0.10666469425261021, 0.06106630809316257, 0.061817626667726805, 0.012422077298670994], [-0.09768808330371975, 0.06671779619966606, 0.06546943498849106, 0.010271715845787198], [-0.08871147235482932, 0.07281198746376828, 0.06876657502793695, 0.008846480836889308], [-0.07973486140593888, 0.07881704895821892, 0.07257230847747806, 0.008921600558563239], [-0.07075825045704842, 0.08402580419193607, 0.08234098063245904, 0.015664397995288563], [-0.061781639508157966, 0.08810472524764089, 0.08879240322226689, 0.019393098792963324], [-0.052805028559267525, 0.0908933178725883, 0.09106929679920758, 0.019009384018945343], [-0.043828417610377084, 0.09272310737822818, 0.09315089142202451, 0.018249377129087953], [-0.03485180666148663, 0.09345012902162558, 0.09445898051809404, 0.016402953317279957], [-0.025875195712596173, 0.0934984418880333, 0.095123070004385, 0.013750160243346861], [-0.016898584763705732, 0.09337571447789941, 0.09387859574813084, 0.009750843243680599], [-0.007921973814815297, 0.0935922691027162, 0.08944625029987, 0.0030307552971284013], [0.0010546371340751648, 0.0942509292609486, 0.08879494554674258, 0.0007523180206619393], [0.010031248082965627, 0.09513703484216929, 0.08930793294259994, 0.00017561341088857818], [0.01900785903185606, 0.09571509367159375, 0.08972824220870201, 1.838386827598265e-05], [0.027984469980746503, 0.09580578317926644, 0.08979517132563172, 3.666458592288535e-08], [0.03696108092963696, 0.09537321496910953, 0.08938952354135571, 5.953485616300158e-08], [0.04593769187852741, 0.0943947093388799, 0.08847031529542823, -1.0467581573053719e-07], [0.054914302827417855, 0.09285667271879315, 0.08699311614165939, -2.101223242345629e-05], [0.06389091377630829, 0.0906266255775428, 0.08502149809903072, 7.149269885765863e-05], [0.07286752472519875, 0.08787735285571535, 0.08232570234895736, -1.1081651846323037e-05], [0.08184413567408921, 0.08437587833965889, 0.07909221482110687, 9.316396540844096e-06], [0.09082074662297965, 0.08011878596323432, 0.07507450270729032, -8.988916432868532e-06], [0.09979735757187008, 0.0749766801956124, 0.07017735349238663, -2.1727398313978186e-05], [0.10877396852076054, 0.06860401679251937, 0.06424618047197614, -2.566661756252947e-05], [0.117750579469651, 0.0606793448722921, 0.056860106787717496, 6.710777537610735e-06], [0.1267271904185414, 0.05058701960162121, 0.047399256821313976, 1.5603330448310526e-05], [0.13570380136743188, 0.03659234443737833, 0.03425934636538543, 1.0741790325140277e-05], [0.14468041231632234, 0.004328900494599768, 0.0037336843414683472, -0.000247877763485099]]},
      0.003,
      0.012,
    );
  }

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createRoronoaZoroLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "Roronoa Zoro look-dev lights";
  const hemi = new THREE.HemisphereLight(
    mode === 'reference' ? 0xfff0d6 : 0xf2f4ff,
    0x363b42,
    mode === 'grazing' ? 0.28 : mode === 'reference' ? 0.72 : 0.85,
  );
  lights.add(hemi);
  const key = new THREE.DirectionalLight(
    mode === 'reference' ? 0xffcf8a : 0xfff4e8,
    mode === 'grazing' ? 4.2 : mode === 'reference' ? 2.6 : 2.15,
  );
  if (mode === 'grazing') key.position.set(7.5, 1.1, 4.0);
  else if (mode === 'reference') key.position.set(-4.5, 7.5, 5.0);
  else key.position.set(-4.0, 6.0, 5.5);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  key.shadow.bias = -0.00025;
  key.shadow.normalBias = 0.018;
  key.shadow.radius = 7;
  key.shadow.blurSamples = 24;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 30;
  key.shadow.camera.left = -2.6;
  key.shadow.camera.right = 2.6;
  key.shadow.camera.top = 2.6;
  key.shadow.camera.bottom = -2.6;
  key.shadow.camera.updateProjectionMatrix();
  lights.add(key);
  const fill = new THREE.DirectionalLight(0xa8c4ff, mode === 'grazing' ? 0.12 : 0.42);
  fill.position.set(4.0, 3.0, 3.5);
  lights.add(fill);
  const rim = new THREE.DirectionalLight(0xfff1c4, mode === 'grazing' ? 0.28 : 0.85);
  rim.position.set(0.5, 4.5, -6.0);
  lights.add(rim);
  lights.userData.reviewMode = mode;
  lights.userData.lightingFromPhoto = [{"type": "directional", "role": "key", "position": [-3, 5, 5], "color": "#fff3df", "intensity": 2.2, "shadowSoftness": 2}, {"type": "directional", "role": "fill", "position": [3, 2, 3], "color": "#dceaff", "intensity": 0.8}, {"type": "directional", "role": "rim", "position": [2, 4, -3], "color": "#d9edff", "intensity": 1.4}, {"type": "hemisphere", "role": "ambient", "color": "#e8f3ff", "groundColor": "#65605a", "intensity": 1}, {"type": "render-settings", "exposure": 1, "toneMapping": "ACESFilmicToneMapping", "background": "#f4f5f2", "contact shadow": "soft ground shadow at the soles, opacity 0.16; no painted shadow texture"}];
  lights.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  return lights;
}

// PBR materials (clearcoat/iridescence/transmission/anisotropy) need an environment
// map to visually behave as intended — call this once per renderer and assign the
// result to scene.environment before rendering. No external HDR asset required.
export function createRoronoaZoroEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  return texture;
}

// Plan 1.3 §3.2 — auto-framing by bounding box. The Divine Eye can only compare a
// render to the reference if the object is FRAMED consistently (an object framed
// differently scores as wrong even when its shape is right). This positions the camera
// deterministically from the object's bounding box so it fills the frame at a stable
// margin, and sets near/far to the object scale. Call after adding the model to the
// scene, and again on resize (after updating camera.aspect).
export function frameRoronoaZoroCamera(
  camera: THREE.PerspectiveCamera,
  object: THREE.Object3D,
  options: { margin?: number; azimuthDeg?: number; elevationDeg?: number } = {},
): void {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const margin = options.margin ?? 1.15;
  const maxDim = Math.max(size.x, size.y, size.z) * margin;
  const fov = (camera.fov * Math.PI) / 180;
  // distance so the largest object dimension fits vertically in the frame
  const distance = (maxDim / 2) / Math.tan(fov / 2);
  const az = ((options.azimuthDeg ?? 0) * Math.PI) / 180;
  const el = ((options.elevationDeg ?? 0) * Math.PI) / 180;
  const dir = new THREE.Vector3(
    Math.sin(az) * Math.cos(el),
    Math.sin(el),
    Math.cos(az) * Math.cos(el),
  );
  camera.position.copy(center).addScaledVector(dir, distance);
  camera.near = Math.max(0.01, distance - maxDim);
  camera.far = distance + maxDim * 2;
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}

// Plan 1.3 §3.2c — PRESENTATION composer (DOF + bloom). CRITICAL (R-POSTFX): this is
// for the showcase/hero render ONLY. The Divine Eye's EVALUATION render MUST use a
// plain renderer with NO composer — bloom blows highlights and DOF blurs edges, which
// would corrupt the deterministic IoU/DCD/edge/blowout signals. Enable dof/bloom ONLY
// when the reference photo actually exhibits them (detect_reference_effects.py authorizes).
export function createRoronoaZoroPresentationComposer(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  options: { dof?: boolean; bloom?: boolean; bloomStrength?: number; dofFocus?: number; dofAperture?: number } = {},
): EffectComposer {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (options.dof) {
    composer.addPass(new BokehPass(scene, camera, {
      focus: options.dofFocus ?? 10.0,
      aperture: options.dofAperture ?? 0.0002,
      maxblur: 0.01,
    }));
  }
  if (options.bloom) {
    const size = new THREE.Vector2();
    renderer.getSize(size);
    composer.addPass(new UnrealBloomPass(size, options.bloomStrength ?? 0.4, 0.4, 0.85));
  }
  return composer;
}

export function configureRoronoaZoroRenderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createRoronoaZoroInspectControls(
  camera: THREE.Camera,
  domElement: HTMLElement,
): OrbitControls {
  // View-dependent finishes only read correctly once the user orbits — their color
  // comes from the environment reflection, not albedo, so free rotation matters here.
  const controls = new OrbitControls(camera, domElement);
  controls.enableDamping = true;
  controls.minDistance = 1.0;
  controls.maxDistance = 8.0;
  controls.autoRotate = false;
  return controls;
}
