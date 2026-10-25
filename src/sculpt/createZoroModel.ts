// img2threejs v2.0.0 / Apache-2.0; see tools/licenses/img2threejs-APACHE-2.0.txt.
import {refineZoroGeometry} from './refineZoroGeometry.ts';
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

function buildTubeGeometry(
  path: { points: [number, number, number][]; radius?: number; radialSegments?: number; closed?: boolean },
): THREE.TubeGeometry {
  const vectors = path.points.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const curve = new THREE.CatmullRomCurve3(vectors, path.closed ?? false);
  const tubularSegments = Math.max(8, path.points.length * 6);
  return new THREE.TubeGeometry(curve, tubularSegments, path.radius ?? 0.05, path.radialSegments ?? 8, path.closed ?? false);
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
// Sculpt build pass: structural-pass
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
  materialMap["scabbardRed"] = createSculptMaterial(
    "scabbardRed",
    {"id": "scabbardRed", "name": "scabbardRed", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#8b3b34", "color": "#8b3b34", "albedo": {"dominant": "#8b3b34", "secondary": ["#8b3b34"], "accents": []}, "colorVariation": {"palette": ["#8b3b34", "#8b3b34"], "pattern": "flat", "amplitude": 0, "heightCorrelation": 0}, "roughness": {"base": 0.7, "variation": 0.02, "map": "independent-micro-response"}, "metalness": {"base": 0, "variation": 0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "scabbardRed-fold-tone", "region": "reference-observed fold valleys", "roughness": 0.74, "evidenceRefs": ["full-object"], "notes": "Cloth folds are geometry; front shade boundary comes from de-lit projection."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Observed anime base colour. Physical roughness is inferred, not measured photometric evidence.", "textureless": {"declared": true, "evidence": ["docs/references/user-cast/zoro.png: flat cel-colour fills, bounded linework and painted shadow regions; no observable grain/pores.", ".img2threejs/cast/zoro/material-evidence.json: pixel crop and source-classification evidence."], "limitation": "No photometric PBR recovery is claimed. Geometry carries folds, fittings and wrap diamonds."}},
    options
  );
  materialMap["scabbardIvory"] = createSculptMaterial(
    "scabbardIvory",
    {"id": "scabbardIvory", "name": "scabbardIvory", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#bdc2a9", "color": "#bdc2a9", "albedo": {"dominant": "#bdc2a9", "secondary": ["#bdc2a9"], "accents": []}, "colorVariation": {"palette": ["#bdc2a9", "#bdc2a9"], "pattern": "flat", "amplitude": 0, "heightCorrelation": 0}, "roughness": {"base": 0.63, "variation": 0.02, "map": "independent-micro-response"}, "metalness": {"base": 0, "variation": 0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "scabbardIvory-fold-tone", "region": "reference-observed fold valleys", "roughness": 0.67, "evidenceRefs": ["full-object"], "notes": "Cloth folds are geometry; front shade boundary comes from de-lit projection."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Observed anime base colour. Physical roughness is inferred, not measured photometric evidence.", "textureless": {"declared": true, "evidence": ["docs/references/user-cast/zoro.png: flat cel-colour fills, bounded linework and painted shadow regions; no observable grain/pores.", ".img2threejs/cast/zoro/material-evidence.json: pixel crop and source-classification evidence."], "limitation": "No photometric PBR recovery is claimed. Geometry carries folds, fittings and wrap diamonds."}},
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
    node_robe_1.position.set(0.0, 0.0, 0.0);
    node_robe_1.rotation.set(0.0, 0.0, 0.0);
  }
  node_robe_1.userData.sculptComponent = {"id": "robe", "name": "Long flared robe", "level": "macro", "role": "garment", "importance": 0.9, "confidence": 0.8, "primitive": "lathe", "topologyClass": "conforming-shell", "topologyRationale": "Continuous parameterized cross-sections fit the observed frontal outline; depth and hidden sides remain inferred.", "geometryDescriptor": {"latheProfile": {"points": [[0.34, 0.45], [0.382, 0.485], [0.397, 0.6], [0.365, 0.85], [0.317, 1.1], [0.277, 1.3], [0.255, 1.435]], "segments": 64}, "topologyIntent": "Monotone cubic section loft, closed volume or rounded cloth shell; see refineZoroGeometry.ts.", "edgeTreatment": {"type": "none", "bevelRadius": 0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "parametricLoft": {"sections": [[0.45, -0.045, 0.34, 0.19, 0], [0.485, -0.045, 0.382, 0.205, 0], [0.6, -0.045, 0.397, 0.21, 0], [0.85, -0.022, 0.365, 0.2, 0], [1.1, -0.0175, 0.317, 0.18, 0], [1.3, -0.015, 0.277, 0.16, 0], [1.435, -0.015, 0.255, 0.15, 0]], "radialSegments": 72, "verticalSegments": 64, "thickness": 0.012}}, "parent": "root", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "robe", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "robe"}}, "material": "robe", "materialLayers": ["robe"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["robe-observed-contour", {"id": "robe-hem", "description": "Scalloped lower hem and long folded green skirt", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(66, 105, 83, 1)", "secondaryAlbedo": "rgba(59, 94, 75, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_robe_1.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "robe", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "robe"}};
  (nodes["root"] ?? root).add(node_robe_1);
  nodes["robe"] = node_robe_1;
  const mesh_robe_1Geometry = endpoint_robe_1
    ? new THREE.CylinderGeometry(endpoint_robe_1.endRadius, endpoint_robe_1.baseRadius, endpoint_robe_1.length, 32, 12)
    : buildLatheGeometry({"points": [[0.34, 0.45], [0.382, 0.485], [0.397, 0.6], [0.365, 0.85], [0.317, 1.1], [0.277, 1.3], [0.255, 1.435]], "segments": 64});
  if (!endpoint_robe_1) {
    mesh_robe_1Geometry.scale(1.0, 1.0, 1.0);
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
  mesh_robe_1.userData.sculptComponent = {"id": "robe", "name": "Long flared robe", "level": "macro", "role": "garment", "importance": 0.9, "confidence": 0.8, "primitive": "lathe", "topologyClass": "conforming-shell", "topologyRationale": "Continuous parameterized cross-sections fit the observed frontal outline; depth and hidden sides remain inferred.", "geometryDescriptor": {"latheProfile": {"points": [[0.34, 0.45], [0.382, 0.485], [0.397, 0.6], [0.365, 0.85], [0.317, 1.1], [0.277, 1.3], [0.255, 1.435]], "segments": 64}, "topologyIntent": "Monotone cubic section loft, closed volume or rounded cloth shell; see refineZoroGeometry.ts.", "edgeTreatment": {"type": "none", "bevelRadius": 0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "parametricLoft": {"sections": [[0.45, -0.045, 0.34, 0.19, 0], [0.485, -0.045, 0.382, 0.205, 0], [0.6, -0.045, 0.397, 0.21, 0], [0.85, -0.022, 0.365, 0.2, 0], [1.1, -0.0175, 0.317, 0.18, 0], [1.3, -0.015, 0.277, 0.16, 0], [1.435, -0.015, 0.255, 0.15, 0]], "radialSegments": 72, "verticalSegments": 64, "thickness": 0.012}}, "parent": "root", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "robe", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "robe"}}, "material": "robe", "materialLayers": ["robe"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["robe-observed-contour", {"id": "robe-hem", "description": "Scalloped lower hem and long folded green skirt", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(66, 105, 83, 1)", "secondaryAlbedo": "rgba(59, 94, 75, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
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
  node_chest_2.userData.sculptComponent = {"id": "chest", "name": "Bare muscular chest", "level": "macro", "role": "body", "importance": 0.9, "confidence": 0.8, "primitive": "lathe", "topologyClass": "continuous-sculpt", "topologyRationale": "Continuous parameterized cross-sections fit the observed frontal outline; depth and hidden sides remain inferred.", "geometryDescriptor": {"topologyIntent": "Monotone cubic section loft, closed volume or rounded cloth shell; see refineZoroGeometry.ts.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "observedStations": [[275, 285, 0.01, 41, 30], [274, 242, 0.01, 51, 34], [275, 197, 0.01, 44, 31], [274, 174, 0.01, 29, 25]], "parametricLoft": {"sections": [[1.78, -0.014, 0.09, 0.072, 0.0], [1.88, -0.014, 0.123, 0.085, 0], [2.02, -0.015, 0.13, 0.09, 0], [2.14, -0.02, 0.095, 0.074, -0.01], [2.2, -0.02, 0.055, 0.051, -0.018]], "radialSegments": 72, "verticalSegments": 64}, "latheProfile": {"points": [[0.09, 1.78], [0.123, 1.88], [0.13, 2.02], [0.095, 2.14], [0.055, 2.2]], "segments": 64}}, "parent": "root", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["chest-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L0", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_chest_2.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["root"] ?? root).add(node_chest_2);
  nodes["chest"] = node_chest_2;
  const mesh_chest_2Geometry = endpoint_chest_2
    ? new THREE.CylinderGeometry(endpoint_chest_2.endRadius, endpoint_chest_2.baseRadius, endpoint_chest_2.length, 32, 12)
    : buildLatheGeometry({"points": [[0.09, 1.78], [0.123, 1.88], [0.13, 2.02], [0.095, 2.14], [0.055, 2.2]], "segments": 64});
  if (!endpoint_chest_2) {
    mesh_chest_2Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_chest_2 = new THREE.Mesh(
    mesh_chest_2Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chest_2.name = "Bare muscular chest";
  if (endpoint_chest_2) {
    mesh_chest_2.position.copy(endpoint_chest_2.midpoint);
    mesh_chest_2.quaternion.copy(endpoint_chest_2.quaternion);
  }
  mesh_chest_2.castShadow = options.castShadow ?? true;
  mesh_chest_2.receiveShadow = options.receiveShadow ?? true;
  mesh_chest_2.userData.sculptComponent = {"id": "chest", "name": "Bare muscular chest", "level": "macro", "role": "body", "importance": 0.9, "confidence": 0.8, "primitive": "lathe", "topologyClass": "continuous-sculpt", "topologyRationale": "Continuous parameterized cross-sections fit the observed frontal outline; depth and hidden sides remain inferred.", "geometryDescriptor": {"topologyIntent": "Monotone cubic section loft, closed volume or rounded cloth shell; see refineZoroGeometry.ts.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "observedStations": [[275, 285, 0.01, 41, 30], [274, 242, 0.01, 51, 34], [275, 197, 0.01, 44, 31], [274, 174, 0.01, 29, 25]], "parametricLoft": {"sections": [[1.78, -0.014, 0.09, 0.072, 0.0], [1.88, -0.014, 0.123, 0.085, 0], [2.02, -0.015, 0.13, 0.09, 0], [2.14, -0.02, 0.095, 0.074, -0.01], [2.2, -0.02, 0.055, 0.051, -0.018]], "radialSegments": 72, "verticalSegments": 64}, "latheProfile": {"points": [[0.09, 1.78], [0.123, 1.88], [0.13, 2.02], [0.095, 2.14], [0.055, 2.2]], "segments": 64}}, "parent": "root", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["chest-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L0", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
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
  node_neck_3.userData.sculptComponent = {"id": "neck", "name": "Neck", "level": "meso", "role": "body", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "Neck follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "Continuous oriented capsules fitted to observed shoulder, elbow and cuff.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "sdf": {"primitives": [{"id": "bone-0", "type": "capsule", "radius": 0.05, "height": 0.08253787009609591, "transform": {"position": [-0.018750000000000003, 2.18375, -0.018], "rotation": [0, 0, 0.03029375991877508], "scale": [1, 1, 0.9]}}], "operations": [], "bounds": {"min": [-0.095, 2.0675000000000003, -0.093], "max": [0.0575, 2.3, 0.057]}, "resolution": 42}, "observedStations": [[274, 180, 0.005, 24, 22], [274, 148, 0.005, 19, 20]]}, "parent": "chest", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "neck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["neck-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L0", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_neck_3.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "neck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["chest"] ?? root).add(node_neck_3);
  nodes["neck"] = node_neck_3;
  const mesh_neck_3Geometry = polygonizeSdf({"primitives": [{"id": "bone-0", "type": "capsule", "radius": 0.05, "height": 0.08253787009609591, "transform": {"position": [-0.018750000000000003, 2.18375, -0.018], "rotation": [0, 0, 0.03029375991877508], "scale": [1, 1, 0.9]}}], "operations": [], "bounds": {"min": [-0.095, 2.0675000000000003, -0.093], "max": [0.0575, 2.3, 0.057]}, "resolution": 42});
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
  mesh_neck_3.userData.sculptComponent = {"id": "neck", "name": "Neck", "level": "meso", "role": "body", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "Neck follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "Continuous oriented capsules fitted to observed shoulder, elbow and cuff.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "sdf": {"primitives": [{"id": "bone-0", "type": "capsule", "radius": 0.05, "height": 0.08253787009609591, "transform": {"position": [-0.018750000000000003, 2.18375, -0.018], "rotation": [0, 0, 0.03029375991877508], "scale": [1, 1, 0.9]}}], "operations": [], "bounds": {"min": [-0.095, 2.0675000000000003, -0.093], "max": [0.0575, 2.3, 0.057]}, "resolution": 42}, "observedStations": [[274, 180, 0.005, 24, 22], [274, 148, 0.005, 19, 20]]}, "parent": "chest", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "neck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["neck-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L0", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
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

  const endpoint_coat_back_5 = makeAttachmentEndpoint(null);
  const node_coat_back_5 = new THREE.Group();
  node_coat_back_5.name = "Continuous open-front jacket back__pivot";
  node_coat_back_5.scale.set(1, 1, 1);
  if (endpoint_coat_back_5) {
    node_coat_back_5.position.copy(endpoint_coat_back_5.start);
    node_coat_back_5.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_coat_back_5.position.set(0.0, 0.0, 0.0);
    node_coat_back_5.rotation.set(0.0, 0.0, 0.0);
  }
  node_coat_back_5.userData.sculptComponent = {"id": "coat-back", "name": "Continuous open-front jacket back", "level": "macro", "role": "garment", "importance": 0.9, "confidence": 0.8, "primitive": "lathe", "topologyClass": "conforming-shell", "topologyRationale": "Continuous parameterized cross-sections fit the observed frontal outline; depth and hidden sides remain inferred.", "geometryDescriptor": {"topologyIntent": "Back half of a rounded cloth shell, with triangulated closed cut edges; hidden depth inferred at confidence 0.4.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "parametricLoft": {"sections": [[1.6, -0.025, 0.265, 0.15, 0], [1.72, -0.025, 0.247, 0.155, 0], [1.9, -0.02, 0.235, 0.16, 0], [2.1, -0.03, 0.25, 0.15, 0], [2.16, -0.03, 0.19, 0.12, 0]], "radialSegments": 72, "verticalSegments": 64, "thickness": 0.015, "angularRange": [3.141592653589793, 6.283185307179586]}, "latheProfile": {"points": [[0.265, 1.6], [0.247, 1.72], [0.235, 1.9], [0.25, 2.1], [0.19, 2.16]], "segments": 64}}, "parent": "chest", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "coat-back", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "robe"}}, "material": "robe", "materialLayers": ["robe"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["coat-back-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(66, 105, 83, 1)", "secondaryAlbedo": "rgba(59, 94, 75, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_coat_back_5.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "coat-back", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "robe"}};
  (nodes["chest"] ?? root).add(node_coat_back_5);
  nodes["coat-back"] = node_coat_back_5;
  const mesh_coat_back_5Geometry = endpoint_coat_back_5
    ? new THREE.CylinderGeometry(endpoint_coat_back_5.endRadius, endpoint_coat_back_5.baseRadius, endpoint_coat_back_5.length, 32, 12)
    : buildLatheGeometry({"points": [[0.265, 1.6], [0.247, 1.72], [0.235, 1.9], [0.25, 2.1], [0.19, 2.16]], "segments": 64});
  if (!endpoint_coat_back_5) {
    mesh_coat_back_5Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_coat_back_5 = new THREE.Mesh(
    mesh_coat_back_5Geometry,
    materialMap["robe"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_coat_back_5.name = "Continuous open-front jacket back";
  if (endpoint_coat_back_5) {
    mesh_coat_back_5.position.copy(endpoint_coat_back_5.midpoint);
    mesh_coat_back_5.quaternion.copy(endpoint_coat_back_5.quaternion);
  }
  mesh_coat_back_5.castShadow = options.castShadow ?? true;
  mesh_coat_back_5.receiveShadow = options.receiveShadow ?? true;
  mesh_coat_back_5.userData.sculptComponent = {"id": "coat-back", "name": "Continuous open-front jacket back", "level": "macro", "role": "garment", "importance": 0.9, "confidence": 0.8, "primitive": "lathe", "topologyClass": "conforming-shell", "topologyRationale": "Continuous parameterized cross-sections fit the observed frontal outline; depth and hidden sides remain inferred.", "geometryDescriptor": {"topologyIntent": "Back half of a rounded cloth shell, with triangulated closed cut edges; hidden depth inferred at confidence 0.4.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "parametricLoft": {"sections": [[1.6, -0.025, 0.265, 0.15, 0], [1.72, -0.025, 0.247, 0.155, 0], [1.9, -0.02, 0.235, 0.16, 0], [2.1, -0.03, 0.25, 0.15, 0], [2.16, -0.03, 0.19, 0.12, 0]], "radialSegments": 72, "verticalSegments": 64, "thickness": 0.015, "angularRange": [3.141592653589793, 6.283185307179586]}, "latheProfile": {"points": [[0.265, 1.6], [0.247, 1.72], [0.235, 1.9], [0.25, 2.1], [0.19, 2.16]], "segments": 64}}, "parent": "chest", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "coat-back", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "robe"}}, "material": "robe", "materialLayers": ["robe"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["coat-back-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(66, 105, 83, 1)", "secondaryAlbedo": "rgba(59, 94, 75, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_coat_back_5.add(mesh_coat_back_5);
  meshes["coat-back"] = mesh_coat_back_5;
  colliders["coat-back"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["coat-back"] ??= [];
  destructionGroups["coat-back"].push(node_coat_back_5);

  const endpoint_robe_left_6 = makeAttachmentEndpoint(null);
  const node_robe_left_6 = new THREE.Group();
  node_robe_left_6.name = "Left lapel and shoulder__pivot";
  node_robe_left_6.scale.set(1, 1, 1);
  if (endpoint_robe_left_6) {
    node_robe_left_6.position.copy(endpoint_robe_left_6.start);
    node_robe_left_6.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_robe_left_6.position.set(0.0, 0.0, 0.0);
    node_robe_left_6.rotation.set(0.0, 0.0, 0.0);
  }
  node_robe_left_6.userData.sculptComponent = {"id": "robe-left", "name": "Left lapel and shoulder", "level": "macro", "role": "garment", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "Subdivided finite-thickness lapel bends around the torso ellipse, joining the open jacket back; not a flat card.", "geometryDescriptor": {"profile2D": {"points": [[0.07, 2.1675], [0.155, 2.135], [0.235, 2.025], [0.2275, 1.8225], [0.1725, 1.6425], [0.0275, 1.6175], [0.1075, 1.745], [0.1, 1.99]], "depth": 0.035}, "topologyIntent": "garment shell with observed hem and folds; depth inferred", "edgeTreatment": {"type": "none", "bevelRadius": 0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "crease-preserving vertex normals", "fittedPanel": {"points": [[0.07, 2.1675], [0.155, 2.135], [0.235, 2.025], [0.2275, 1.8225], [0.1725, 1.6425], [0.0275, 1.6175], [0.1075, 1.745], [0.1, 1.99]], "depth": 0.018, "centreX": -0.025, "radiusX": 0.285, "radiusZ": 0.16, "standOff": 0.014, "subdivisions": 3}}, "parent": "coat-back", "attachment": null, "dimensions": {"width": 0.2075, "height": 0.55, "depth": 0.035, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "robe-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "robe"}}, "material": "robe", "materialLayers": ["robe"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["robe-left-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(66, 105, 83, 1)", "secondaryAlbedo": "rgba(59, 94, 75, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_robe_left_6.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "robe-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "robe"}};
  (nodes["coat-back"] ?? root).add(node_robe_left_6);
  nodes["robe-left"] = node_robe_left_6;
  const mesh_robe_left_6Geometry = endpoint_robe_left_6
    ? new THREE.CylinderGeometry(endpoint_robe_left_6.endRadius, endpoint_robe_left_6.baseRadius, endpoint_robe_left_6.length, 32, 12)
    : buildExtrudeGeometry({"points": [[0.07, 2.1675], [0.155, 2.135], [0.235, 2.025], [0.2275, 1.8225], [0.1725, 1.6425], [0.0275, 1.6175], [0.1075, 1.745], [0.1, 1.99]], "depth": 0.035});
  if (!endpoint_robe_left_6) {
    mesh_robe_left_6Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_robe_left_6 = new THREE.Mesh(
    mesh_robe_left_6Geometry,
    materialMap["robe"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_robe_left_6.name = "Left lapel and shoulder";
  if (endpoint_robe_left_6) {
    mesh_robe_left_6.position.copy(endpoint_robe_left_6.midpoint);
    mesh_robe_left_6.quaternion.copy(endpoint_robe_left_6.quaternion);
  }
  mesh_robe_left_6.castShadow = options.castShadow ?? true;
  mesh_robe_left_6.receiveShadow = options.receiveShadow ?? true;
  mesh_robe_left_6.userData.sculptComponent = {"id": "robe-left", "name": "Left lapel and shoulder", "level": "macro", "role": "garment", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "Subdivided finite-thickness lapel bends around the torso ellipse, joining the open jacket back; not a flat card.", "geometryDescriptor": {"profile2D": {"points": [[0.07, 2.1675], [0.155, 2.135], [0.235, 2.025], [0.2275, 1.8225], [0.1725, 1.6425], [0.0275, 1.6175], [0.1075, 1.745], [0.1, 1.99]], "depth": 0.035}, "topologyIntent": "garment shell with observed hem and folds; depth inferred", "edgeTreatment": {"type": "none", "bevelRadius": 0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "crease-preserving vertex normals", "fittedPanel": {"points": [[0.07, 2.1675], [0.155, 2.135], [0.235, 2.025], [0.2275, 1.8225], [0.1725, 1.6425], [0.0275, 1.6175], [0.1075, 1.745], [0.1, 1.99]], "depth": 0.018, "centreX": -0.025, "radiusX": 0.285, "radiusZ": 0.16, "standOff": 0.014, "subdivisions": 3}}, "parent": "coat-back", "attachment": null, "dimensions": {"width": 0.2075, "height": 0.55, "depth": 0.035, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "robe-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "robe"}}, "material": "robe", "materialLayers": ["robe"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["robe-left-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(66, 105, 83, 1)", "secondaryAlbedo": "rgba(59, 94, 75, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_robe_left_6.add(mesh_robe_left_6);
  meshes["robe-left"] = mesh_robe_left_6;
  colliders["robe-left"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["robe-left"] ??= [];
  destructionGroups["robe-left"].push(node_robe_left_6);

  const endpoint_robe_right_7 = makeAttachmentEndpoint(null);
  const node_robe_right_7 = new THREE.Group();
  node_robe_right_7.name = "Right lapel and shoulder__pivot";
  node_robe_right_7.scale.set(1, 1, 1);
  if (endpoint_robe_right_7) {
    node_robe_right_7.position.copy(endpoint_robe_right_7.start);
    node_robe_right_7.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_robe_right_7.position.set(0.0, 0.0, 0.0);
    node_robe_right_7.rotation.set(0.0, 0.0, 0.0);
  }
  node_robe_right_7.userData.sculptComponent = {"id": "robe-right", "name": "Right lapel and shoulder", "level": "macro", "role": "garment", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "Subdivided finite-thickness lapel bends around the torso ellipse, joining the open jacket back; not a flat card.", "geometryDescriptor": {"profile2D": {"points": [[-0.12, 2.165], [-0.1725, 2.1375], [-0.2575, 2.1375], [-0.27, 1.915], [-0.285, 1.73], [-0.2175, 1.6325], [-0.08, 1.615], [-0.1425, 1.725], [-0.1275, 1.9625]], "depth": 0.035}, "topologyIntent": "garment shell with observed hem and folds; depth inferred", "edgeTreatment": {"type": "none", "bevelRadius": 0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "crease-preserving vertex normals", "fittedPanel": {"points": [[-0.12, 2.165], [-0.1725, 2.1375], [-0.2575, 2.1375], [-0.27, 1.915], [-0.285, 1.73], [-0.2175, 1.6325], [-0.08, 1.615], [-0.1425, 1.725], [-0.1275, 1.9625]], "depth": 0.018, "centreX": -0.025, "radiusX": 0.285, "radiusZ": 0.16, "standOff": 0.014, "subdivisions": 3}}, "parent": "coat-back", "attachment": null, "dimensions": {"width": 0.205, "height": 0.55, "depth": 0.035, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "robe-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "robe"}}, "material": "robe", "materialLayers": ["robe"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["robe-right-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(66, 105, 83, 1)", "secondaryAlbedo": "rgba(59, 94, 75, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_robe_right_7.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "robe-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "robe"}};
  (nodes["coat-back"] ?? root).add(node_robe_right_7);
  nodes["robe-right"] = node_robe_right_7;
  const mesh_robe_right_7Geometry = endpoint_robe_right_7
    ? new THREE.CylinderGeometry(endpoint_robe_right_7.endRadius, endpoint_robe_right_7.baseRadius, endpoint_robe_right_7.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.12, 2.165], [-0.1725, 2.1375], [-0.2575, 2.1375], [-0.27, 1.915], [-0.285, 1.73], [-0.2175, 1.6325], [-0.08, 1.615], [-0.1425, 1.725], [-0.1275, 1.9625]], "depth": 0.035});
  if (!endpoint_robe_right_7) {
    mesh_robe_right_7Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_robe_right_7 = new THREE.Mesh(
    mesh_robe_right_7Geometry,
    materialMap["robe"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_robe_right_7.name = "Right lapel and shoulder";
  if (endpoint_robe_right_7) {
    mesh_robe_right_7.position.copy(endpoint_robe_right_7.midpoint);
    mesh_robe_right_7.quaternion.copy(endpoint_robe_right_7.quaternion);
  }
  mesh_robe_right_7.castShadow = options.castShadow ?? true;
  mesh_robe_right_7.receiveShadow = options.receiveShadow ?? true;
  mesh_robe_right_7.userData.sculptComponent = {"id": "robe-right", "name": "Right lapel and shoulder", "level": "macro", "role": "garment", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "Subdivided finite-thickness lapel bends around the torso ellipse, joining the open jacket back; not a flat card.", "geometryDescriptor": {"profile2D": {"points": [[-0.12, 2.165], [-0.1725, 2.1375], [-0.2575, 2.1375], [-0.27, 1.915], [-0.285, 1.73], [-0.2175, 1.6325], [-0.08, 1.615], [-0.1425, 1.725], [-0.1275, 1.9625]], "depth": 0.035}, "topologyIntent": "garment shell with observed hem and folds; depth inferred", "edgeTreatment": {"type": "none", "bevelRadius": 0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "crease-preserving vertex normals", "fittedPanel": {"points": [[-0.12, 2.165], [-0.1725, 2.1375], [-0.2575, 2.1375], [-0.27, 1.915], [-0.285, 1.73], [-0.2175, 1.6325], [-0.08, 1.615], [-0.1425, 1.725], [-0.1275, 1.9625]], "depth": 0.018, "centreX": -0.025, "radiusX": 0.285, "radiusZ": 0.16, "standOff": 0.014, "subdivisions": 3}}, "parent": "coat-back", "attachment": null, "dimensions": {"width": 0.205, "height": 0.55, "depth": 0.035, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "robe-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "robe"}}, "material": "robe", "materialLayers": ["robe"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["robe-right-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(66, 105, 83, 1)", "secondaryAlbedo": "rgba(59, 94, 75, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_robe_right_7.add(mesh_robe_right_7);
  meshes["robe-right"] = mesh_robe_right_7;
  colliders["robe-right"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["robe-right"] ??= [];
  destructionGroups["robe-right"].push(node_robe_right_7);

  const endpoint_sleeve_raised_8 = makeAttachmentEndpoint(null);
  const node_sleeve_raised_8 = new THREE.Group();
  node_sleeve_raised_8.name = "Raised right sleeve__pivot";
  node_sleeve_raised_8.scale.set(1, 1, 1);
  if (endpoint_sleeve_raised_8) {
    node_sleeve_raised_8.position.copy(endpoint_sleeve_raised_8.start);
    node_sleeve_raised_8.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_sleeve_raised_8.position.set(0.0, 0.0, 0.0);
    node_sleeve_raised_8.rotation.set(0.0, 0.0, 0.0);
  }
  node_sleeve_raised_8.userData.sculptComponent = {"id": "sleeve-raised", "name": "Raised right sleeve", "level": "meso", "role": "garment", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "Raised right sleeve follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "Continuous oriented capsules fitted to observed shoulder, elbow and cuff.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "sdf": {"primitives": [{"id": "bone-0", "type": "capsule", "radius": 0.0725, "height": 0.28359301824974464, "transform": {"position": [-0.39, 2.02, 0.0], "rotation": [0, 0, 1.7301479676988132], "scale": [1, 1, 0.9]}}, {"id": "bone-1", "type": "capsule", "radius": 0.0775, "height": 0.20032785627565614, "transform": {"position": [-0.48125, 2.085, 0.0], "rotation": [0, 0, -0.5083106250108278], "scale": [1, 1, 0.9]}}], "operations": [{"id": "join-1", "type": "smooth-union", "left": "bone-0", "right": "bone-1", "radius": 0.02}], "bounds": {"min": [-0.6325000000000001, 1.8950000000000002, -0.10250000000000001], "max": [-0.1525, 2.275, 0.10250000000000001]}, "resolution": 42}, "observedStations": [[176, 204, 0, 36, 37], [128, 240, 0, 37, 34], [91, 247, 0, 36, 33], [86, 218, 0, 32, 29], [111, 180, 0, 28, 27], [126, 153, 0, 25, 25]]}, "parent": "root", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "sleeve-raised", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "robe"}}, "material": "robe", "materialLayers": ["robe"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["sleeve-raised-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(66, 105, 83, 1)", "secondaryAlbedo": "rgba(59, 94, 75, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_sleeve_raised_8.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "sleeve-raised", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "robe"}};
  (nodes["root"] ?? root).add(node_sleeve_raised_8);
  nodes["sleeve-raised"] = node_sleeve_raised_8;
  const mesh_sleeve_raised_8Geometry = polygonizeSdf({"primitives": [{"id": "bone-0", "type": "capsule", "radius": 0.0725, "height": 0.28359301824974464, "transform": {"position": [-0.39, 2.02, 0.0], "rotation": [0, 0, 1.7301479676988132], "scale": [1, 1, 0.9]}}, {"id": "bone-1", "type": "capsule", "radius": 0.0775, "height": 0.20032785627565614, "transform": {"position": [-0.48125, 2.085, 0.0], "rotation": [0, 0, -0.5083106250108278], "scale": [1, 1, 0.9]}}], "operations": [{"id": "join-1", "type": "smooth-union", "left": "bone-0", "right": "bone-1", "radius": 0.02}], "bounds": {"min": [-0.6325000000000001, 1.8950000000000002, -0.10250000000000001], "max": [-0.1525, 2.275, 0.10250000000000001]}, "resolution": 42});
  if (!endpoint_sleeve_raised_8) {
    mesh_sleeve_raised_8Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_sleeve_raised_8 = new THREE.Mesh(
    mesh_sleeve_raised_8Geometry,
    createSculptMaterial("robe", {"id": "robe", "name": "robe", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#426953", "color": "#426953", "albedo": {"dominant": "#426953", "secondary": ["#426953"], "accents": []}, "colorVariation": {"palette": ["#426953", "#426953"], "pattern": "flat", "amplitude": 0, "heightCorrelation": 0}, "roughness": {"base": 0.9, "variation": 0.02, "map": "independent-micro-response"}, "metalness": {"base": 0, "variation": 0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "robe-fold-tone", "region": "reference-observed fold valleys", "roughness": 0.9400000000000001, "evidenceRefs": ["full-object"], "notes": "Cloth folds are geometry; front shade boundary comes from de-lit projection."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Observed anime base colour. Physical roughness is inferred, not measured photometric evidence.", "textureless": {"declared": true, "evidence": ["docs/references/user-cast/zoro.png: flat cel-colour fills, bounded linework and painted shadow regions; no observable grain/pores.", ".img2threejs/cast/zoro/material-evidence.json: pixel crop and source-classification evidence."], "limitation": "No photometric PBR recovery is claimed. Geometry carries folds, fittings and wrap diamonds."}}, options, true)
  );
  mesh_sleeve_raised_8.name = "Raised right sleeve";
  if (endpoint_sleeve_raised_8) {
    mesh_sleeve_raised_8.position.copy(endpoint_sleeve_raised_8.midpoint);
    mesh_sleeve_raised_8.quaternion.copy(endpoint_sleeve_raised_8.quaternion);
  }
  mesh_sleeve_raised_8.castShadow = options.castShadow ?? true;
  mesh_sleeve_raised_8.receiveShadow = options.receiveShadow ?? true;
  mesh_sleeve_raised_8.userData.sculptComponent = {"id": "sleeve-raised", "name": "Raised right sleeve", "level": "meso", "role": "garment", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "Raised right sleeve follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "Continuous oriented capsules fitted to observed shoulder, elbow and cuff.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "sdf": {"primitives": [{"id": "bone-0", "type": "capsule", "radius": 0.0725, "height": 0.28359301824974464, "transform": {"position": [-0.39, 2.02, 0.0], "rotation": [0, 0, 1.7301479676988132], "scale": [1, 1, 0.9]}}, {"id": "bone-1", "type": "capsule", "radius": 0.0775, "height": 0.20032785627565614, "transform": {"position": [-0.48125, 2.085, 0.0], "rotation": [0, 0, -0.5083106250108278], "scale": [1, 1, 0.9]}}], "operations": [{"id": "join-1", "type": "smooth-union", "left": "bone-0", "right": "bone-1", "radius": 0.02}], "bounds": {"min": [-0.6325000000000001, 1.8950000000000002, -0.10250000000000001], "max": [-0.1525, 2.275, 0.10250000000000001]}, "resolution": 42}, "observedStations": [[176, 204, 0, 36, 37], [128, 240, 0, 37, 34], [91, 247, 0, 36, 33], [86, 218, 0, 32, 29], [111, 180, 0, 28, 27], [126, 153, 0, 25, 25]]}, "parent": "root", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "sleeve-raised", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "robe"}}, "material": "robe", "materialLayers": ["robe"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["sleeve-raised-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(66, 105, 83, 1)", "secondaryAlbedo": "rgba(59, 94, 75, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_sleeve_raised_8.add(mesh_sleeve_raised_8);
  meshes["sleeve-raised"] = mesh_sleeve_raised_8;
  colliders["sleeve-raised"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["sleeve-raised"] ??= [];
  destructionGroups["sleeve-raised"].push(node_sleeve_raised_8);

  const endpoint_forearm_raised_9 = makeAttachmentEndpoint(null);
  const node_forearm_raised_9 = new THREE.Group();
  node_forearm_raised_9.name = "Raised right forearm__pivot";
  node_forearm_raised_9.scale.set(1, 1, 1);
  if (endpoint_forearm_raised_9) {
    node_forearm_raised_9.position.copy(endpoint_forearm_raised_9.start);
    node_forearm_raised_9.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_forearm_raised_9.position.set(0.0, 0.0, 0.0);
    node_forearm_raised_9.rotation.set(0.0, 0.0, 0.0);
  }
  node_forearm_raised_9.userData.sculptComponent = {"id": "forearm-raised", "name": "Raised right forearm", "level": "meso", "role": "body", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "Raised right forearm follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "Continuous oriented capsules fitted to observed shoulder, elbow and cuff.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "sdf": {"primitives": [{"id": "bone-0", "type": "capsule", "radius": 0.0425, "height": 0.1261199825562945, "transform": {"position": [-0.345, 2.25625, 0.0], "rotation": [0, 0, -0.6871242101414385], "scale": [1, 1, 0.85]}}], "operations": [], "bounds": {"min": [-0.4525, 2.14, -0.0675], "max": [-0.23750000000000002, 2.3725, 0.0675]}, "resolution": 42}, "observedStations": [[126, 161, 0.005, 21, 20], [146, 135, 0.02, 19, 18], [160, 115, 0.04, 16, 16]]}, "parent": "root", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "forearm-raised", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["forearm-raised-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L0", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_forearm_raised_9.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "forearm-raised", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["root"] ?? root).add(node_forearm_raised_9);
  nodes["forearm-raised"] = node_forearm_raised_9;
  const mesh_forearm_raised_9Geometry = polygonizeSdf({"primitives": [{"id": "bone-0", "type": "capsule", "radius": 0.0425, "height": 0.1261199825562945, "transform": {"position": [-0.345, 2.25625, 0.0], "rotation": [0, 0, -0.6871242101414385], "scale": [1, 1, 0.85]}}], "operations": [], "bounds": {"min": [-0.4525, 2.14, -0.0675], "max": [-0.23750000000000002, 2.3725, 0.0675]}, "resolution": 42});
  if (!endpoint_forearm_raised_9) {
    mesh_forearm_raised_9Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_forearm_raised_9 = new THREE.Mesh(
    mesh_forearm_raised_9Geometry,
    createSculptMaterial("skin", {"id": "skin", "name": "skin", "type": "physical", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#e8be8d", "color": "#e8be8d", "albedo": {"dominant": "#e8be8d", "secondary": ["#e8be8d"], "accents": []}, "colorVariation": {"palette": ["#e8be8d", "#e8be8d"], "pattern": "flat", "amplitude": 0, "heightCorrelation": 0}, "roughness": {"base": 0.62, "variation": 0.02, "map": "independent-micro-response"}, "metalness": {"base": 0, "variation": 0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "skin-fold-tone", "region": "reference-observed fold valleys", "roughness": 0.66, "evidenceRefs": ["full-object"], "notes": "Cloth folds are geometry; front shade boundary comes from de-lit projection."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Observed anime base colour. Physical roughness is inferred, not measured photometric evidence.", "textureless": {"declared": true, "evidence": ["docs/references/user-cast/zoro.png: flat cel-colour fills, bounded linework and painted shadow regions; no observable grain/pores.", ".img2threejs/cast/zoro/material-evidence.json: pixel crop and source-classification evidence."], "limitation": "No photometric PBR recovery is claimed. Geometry carries folds, fittings and wrap diamonds."}}, options, true)
  );
  mesh_forearm_raised_9.name = "Raised right forearm";
  if (endpoint_forearm_raised_9) {
    mesh_forearm_raised_9.position.copy(endpoint_forearm_raised_9.midpoint);
    mesh_forearm_raised_9.quaternion.copy(endpoint_forearm_raised_9.quaternion);
  }
  mesh_forearm_raised_9.castShadow = options.castShadow ?? true;
  mesh_forearm_raised_9.receiveShadow = options.receiveShadow ?? true;
  mesh_forearm_raised_9.userData.sculptComponent = {"id": "forearm-raised", "name": "Raised right forearm", "level": "meso", "role": "body", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "Raised right forearm follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "Continuous oriented capsules fitted to observed shoulder, elbow and cuff.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "sdf": {"primitives": [{"id": "bone-0", "type": "capsule", "radius": 0.0425, "height": 0.1261199825562945, "transform": {"position": [-0.345, 2.25625, 0.0], "rotation": [0, 0, -0.6871242101414385], "scale": [1, 1, 0.85]}}], "operations": [], "bounds": {"min": [-0.4525, 2.14, -0.0675], "max": [-0.23750000000000002, 2.3725, 0.0675]}, "resolution": 42}, "observedStations": [[126, 161, 0.005, 21, 20], [146, 135, 0.02, 19, 18], [160, 115, 0.04, 16, 16]]}, "parent": "root", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "forearm-raised", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["forearm-raised-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L0", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_forearm_raised_9.add(mesh_forearm_raised_9);
  meshes["forearm-raised"] = mesh_forearm_raised_9;
  colliders["forearm-raised"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["forearm-raised"] ??= [];
  destructionGroups["forearm-raised"].push(node_forearm_raised_9);

  const endpoint_sleeve_down_10 = makeAttachmentEndpoint(null);
  const node_sleeve_down_10 = new THREE.Group();
  node_sleeve_down_10.name = "Low left sleeve__pivot";
  node_sleeve_down_10.scale.set(1, 1, 1);
  if (endpoint_sleeve_down_10) {
    node_sleeve_down_10.position.copy(endpoint_sleeve_down_10.start);
    node_sleeve_down_10.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_sleeve_down_10.position.set(0.0, 0.0, 0.0);
    node_sleeve_down_10.rotation.set(0.0, 0.0, 0.0);
  }
  node_sleeve_down_10.userData.sculptComponent = {"id": "sleeve-down", "name": "Low left sleeve", "level": "meso", "role": "garment", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "Low left sleeve follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "Continuous oriented capsules fitted to observed shoulder, elbow and cuff.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "sdf": {"primitives": [{"id": "bone-0", "type": "capsule", "radius": 0.075, "height": 0.32163644072150777, "transform": {"position": [0.215, 1.89, 0.0], "rotation": [0, 0, -2.9380996083322306], "scale": [1, 1, 0.9]}}, {"id": "bone-1", "type": "capsule", "radius": 0.065, "height": 0.255893044063335, "transform": {"position": [0.28, 1.6087500000000001, 0.0], "rotation": [0, 0, -2.8847662036199853], "scale": [1, 1, 0.9]}}], "operations": [{"id": "join-1", "type": "smooth-union", "left": "bone-0", "right": "bone-1", "radius": 0.02}], "bounds": {"min": [0.08249999999999999, 1.3950000000000002, -0.1], "max": [0.4025, 2.1475, 0.1]}, "resolution": 42}, "observedStations": [[353, 233, 0, 32, 32], [380, 334, 0, 30, 28], [393, 411, 0, 28, 27], [407, 468, 0, 25, 24]]}, "parent": "root", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "sleeve-down", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "robe"}}, "material": "robe", "materialLayers": ["robe"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["sleeve-down-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(66, 105, 83, 1)", "secondaryAlbedo": "rgba(59, 94, 75, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_sleeve_down_10.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "sleeve-down", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "robe"}};
  (nodes["root"] ?? root).add(node_sleeve_down_10);
  nodes["sleeve-down"] = node_sleeve_down_10;
  const mesh_sleeve_down_10Geometry = polygonizeSdf({"primitives": [{"id": "bone-0", "type": "capsule", "radius": 0.075, "height": 0.32163644072150777, "transform": {"position": [0.215, 1.89, 0.0], "rotation": [0, 0, -2.9380996083322306], "scale": [1, 1, 0.9]}}, {"id": "bone-1", "type": "capsule", "radius": 0.065, "height": 0.255893044063335, "transform": {"position": [0.28, 1.6087500000000001, 0.0], "rotation": [0, 0, -2.8847662036199853], "scale": [1, 1, 0.9]}}], "operations": [{"id": "join-1", "type": "smooth-union", "left": "bone-0", "right": "bone-1", "radius": 0.02}], "bounds": {"min": [0.08249999999999999, 1.3950000000000002, -0.1], "max": [0.4025, 2.1475, 0.1]}, "resolution": 42});
  if (!endpoint_sleeve_down_10) {
    mesh_sleeve_down_10Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_sleeve_down_10 = new THREE.Mesh(
    mesh_sleeve_down_10Geometry,
    createSculptMaterial("robe", {"id": "robe", "name": "robe", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#426953", "color": "#426953", "albedo": {"dominant": "#426953", "secondary": ["#426953"], "accents": []}, "colorVariation": {"palette": ["#426953", "#426953"], "pattern": "flat", "amplitude": 0, "heightCorrelation": 0}, "roughness": {"base": 0.9, "variation": 0.02, "map": "independent-micro-response"}, "metalness": {"base": 0, "variation": 0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "robe-fold-tone", "region": "reference-observed fold valleys", "roughness": 0.9400000000000001, "evidenceRefs": ["full-object"], "notes": "Cloth folds are geometry; front shade boundary comes from de-lit projection."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Observed anime base colour. Physical roughness is inferred, not measured photometric evidence.", "textureless": {"declared": true, "evidence": ["docs/references/user-cast/zoro.png: flat cel-colour fills, bounded linework and painted shadow regions; no observable grain/pores.", ".img2threejs/cast/zoro/material-evidence.json: pixel crop and source-classification evidence."], "limitation": "No photometric PBR recovery is claimed. Geometry carries folds, fittings and wrap diamonds."}}, options, true)
  );
  mesh_sleeve_down_10.name = "Low left sleeve";
  if (endpoint_sleeve_down_10) {
    mesh_sleeve_down_10.position.copy(endpoint_sleeve_down_10.midpoint);
    mesh_sleeve_down_10.quaternion.copy(endpoint_sleeve_down_10.quaternion);
  }
  mesh_sleeve_down_10.castShadow = options.castShadow ?? true;
  mesh_sleeve_down_10.receiveShadow = options.receiveShadow ?? true;
  mesh_sleeve_down_10.userData.sculptComponent = {"id": "sleeve-down", "name": "Low left sleeve", "level": "meso", "role": "garment", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "Low left sleeve follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "Continuous oriented capsules fitted to observed shoulder, elbow and cuff.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "sdf": {"primitives": [{"id": "bone-0", "type": "capsule", "radius": 0.075, "height": 0.32163644072150777, "transform": {"position": [0.215, 1.89, 0.0], "rotation": [0, 0, -2.9380996083322306], "scale": [1, 1, 0.9]}}, {"id": "bone-1", "type": "capsule", "radius": 0.065, "height": 0.255893044063335, "transform": {"position": [0.28, 1.6087500000000001, 0.0], "rotation": [0, 0, -2.8847662036199853], "scale": [1, 1, 0.9]}}], "operations": [{"id": "join-1", "type": "smooth-union", "left": "bone-0", "right": "bone-1", "radius": 0.02}], "bounds": {"min": [0.08249999999999999, 1.3950000000000002, -0.1], "max": [0.4025, 2.1475, 0.1]}, "resolution": 42}, "observedStations": [[353, 233, 0, 32, 32], [380, 334, 0, 30, 28], [393, 411, 0, 28, 27], [407, 468, 0, 25, 24]]}, "parent": "root", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "sleeve-down", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "robe"}}, "material": "robe", "materialLayers": ["robe"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["sleeve-down-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(66, 105, 83, 1)", "secondaryAlbedo": "rgba(59, 94, 75, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_sleeve_down_10.add(mesh_sleeve_down_10);
  meshes["sleeve-down"] = mesh_sleeve_down_10;
  colliders["sleeve-down"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["sleeve-down"] ??= [];
  destructionGroups["sleeve-down"].push(node_sleeve_down_10);

  const endpoint_forearm_down_11 = makeAttachmentEndpoint(null);
  const node_forearm_down_11 = new THREE.Group();
  node_forearm_down_11.name = "Low left forearm__pivot";
  node_forearm_down_11.scale.set(1, 1, 1);
  if (endpoint_forearm_down_11) {
    node_forearm_down_11.position.copy(endpoint_forearm_down_11.start);
    node_forearm_down_11.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_forearm_down_11.position.set(0.0, 0.0, 0.0);
    node_forearm_down_11.rotation.set(0.0, 0.0, 0.0);
  }
  node_forearm_down_11.userData.sculptComponent = {"id": "forearm-down", "name": "Low left forearm", "level": "meso", "role": "body", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "Low left forearm follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "Continuous oriented capsules fitted to observed shoulder, elbow and cuff.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "sdf": {"primitives": [{"id": "bone-0", "type": "capsule", "radius": 0.0325, "height": 0.13788582233137672, "transform": {"position": [0.35125, 1.36375, 0.0], "rotation": [0, 0, -2.750985609892106], "scale": [1, 1, 0.85]}}], "operations": [], "bounds": {"min": [0.26749999999999996, 1.2425000000000002, -0.0575], "max": [0.43500000000000005, 1.4849999999999999, 0.0575]}, "resolution": 42}, "observedStations": [[409, 464, 0.01, 18, 17], [424, 498, 0.035, 14, 14], [432, 523, 0.055, 12, 13]]}, "parent": "root", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "forearm-down", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["forearm-down-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L0", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_forearm_down_11.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "forearm-down", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["root"] ?? root).add(node_forearm_down_11);
  nodes["forearm-down"] = node_forearm_down_11;
  const mesh_forearm_down_11Geometry = polygonizeSdf({"primitives": [{"id": "bone-0", "type": "capsule", "radius": 0.0325, "height": 0.13788582233137672, "transform": {"position": [0.35125, 1.36375, 0.0], "rotation": [0, 0, -2.750985609892106], "scale": [1, 1, 0.85]}}], "operations": [], "bounds": {"min": [0.26749999999999996, 1.2425000000000002, -0.0575], "max": [0.43500000000000005, 1.4849999999999999, 0.0575]}, "resolution": 42});
  if (!endpoint_forearm_down_11) {
    mesh_forearm_down_11Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_forearm_down_11 = new THREE.Mesh(
    mesh_forearm_down_11Geometry,
    createSculptMaterial("skin", {"id": "skin", "name": "skin", "type": "physical", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#e8be8d", "color": "#e8be8d", "albedo": {"dominant": "#e8be8d", "secondary": ["#e8be8d"], "accents": []}, "colorVariation": {"palette": ["#e8be8d", "#e8be8d"], "pattern": "flat", "amplitude": 0, "heightCorrelation": 0}, "roughness": {"base": 0.62, "variation": 0.02, "map": "independent-micro-response"}, "metalness": {"base": 0, "variation": 0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "skin-fold-tone", "region": "reference-observed fold valleys", "roughness": 0.66, "evidenceRefs": ["full-object"], "notes": "Cloth folds are geometry; front shade boundary comes from de-lit projection."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Observed anime base colour. Physical roughness is inferred, not measured photometric evidence.", "textureless": {"declared": true, "evidence": ["docs/references/user-cast/zoro.png: flat cel-colour fills, bounded linework and painted shadow regions; no observable grain/pores.", ".img2threejs/cast/zoro/material-evidence.json: pixel crop and source-classification evidence."], "limitation": "No photometric PBR recovery is claimed. Geometry carries folds, fittings and wrap diamonds."}}, options, true)
  );
  mesh_forearm_down_11.name = "Low left forearm";
  if (endpoint_forearm_down_11) {
    mesh_forearm_down_11.position.copy(endpoint_forearm_down_11.midpoint);
    mesh_forearm_down_11.quaternion.copy(endpoint_forearm_down_11.quaternion);
  }
  mesh_forearm_down_11.castShadow = options.castShadow ?? true;
  mesh_forearm_down_11.receiveShadow = options.receiveShadow ?? true;
  mesh_forearm_down_11.userData.sculptComponent = {"id": "forearm-down", "name": "Low left forearm", "level": "meso", "role": "body", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "Low left forearm follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "Continuous oriented capsules fitted to observed shoulder, elbow and cuff.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "sdf": {"primitives": [{"id": "bone-0", "type": "capsule", "radius": 0.0325, "height": 0.13788582233137672, "transform": {"position": [0.35125, 1.36375, 0.0], "rotation": [0, 0, -2.750985609892106], "scale": [1, 1, 0.85]}}], "operations": [], "bounds": {"min": [0.26749999999999996, 1.2425000000000002, -0.0575], "max": [0.43500000000000005, 1.4849999999999999, 0.0575]}, "resolution": 42}, "observedStations": [[409, 464, 0.01, 18, 17], [424, 498, 0.035, 14, 14], [432, 523, 0.055, 12, 13]]}, "parent": "root", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "forearm-down", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["forearm-down-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L0", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_forearm_down_11.add(mesh_forearm_down_11);
  meshes["forearm-down"] = mesh_forearm_down_11;
  colliders["forearm-down"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["forearm-down"] ??= [];
  destructionGroups["forearm-down"].push(node_forearm_down_11);

  const endpoint_pants_left_12 = makeAttachmentEndpoint(null);
  const node_pants_left_12 = new THREE.Group();
  node_pants_left_12.name = "Left trouser cuff__pivot";
  node_pants_left_12.scale.set(1, 1, 1);
  if (endpoint_pants_left_12) {
    node_pants_left_12.position.copy(endpoint_pants_left_12.start);
    node_pants_left_12.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pants_left_12.position.set(0.0, 0.0, 0.0);
    node_pants_left_12.rotation.set(0.0, 0.0, 0.0);
  }
  node_pants_left_12.userData.sculptComponent = {"id": "pants-left", "name": "Left trouser cuff", "level": "meso", "role": "garment", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "Left trouser cuff follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "Smooth-union body/garment blockout; garment shell offset and silhouette refinement remain later pass tasks.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "sdf": {"primitives": [{"id": "section-0", "type": "ellipsoid", "center": [0.20299999999999999, 0.5025, 0], "radii": [0.09, 0.07325469268244868, 0.075]}, {"id": "section-1", "type": "ellipsoid", "center": [0.22549999999999998, 0.3825, 0], "radii": [0.08, 0.10120276676059799, 0.0675]}, {"id": "section-2", "type": "ellipsoid", "center": [0.238, 0.3375, 0], "radii": [0.0625, 0.03, 0.0525]}], "operations": [{"id": "blend-1", "type": "smooth-union", "left": "section-0", "right": "section-1", "radius": 0.025}, {"id": "blend-2", "type": "smooth-union", "left": "blend-1", "right": "section-2", "radius": 0.025}], "bounds": {"min": [0.08, 0.251297233239402, -0.105], "max": [0.3025, 0.6057546926824486, 0.105]}, "resolution": 42}, "observedStations": [[354, 839, 0, 30, 30], [363, 887, 0, 26, 27], [368, 905, 0, 19, 21]]}, "parent": "root", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pants-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "boots"}}, "material": "boots", "materialLayers": ["boots"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["pants-left-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(16, 22, 20, 1)", "secondaryAlbedo": "rgba(14, 20, 18, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_pants_left_12.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pants-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "boots"}};
  (nodes["root"] ?? root).add(node_pants_left_12);
  nodes["pants-left"] = node_pants_left_12;
  const mesh_pants_left_12Geometry = polygonizeSdf({"primitives": [{"id": "section-0", "type": "ellipsoid", "center": [0.20299999999999999, 0.5025, 0], "radii": [0.09, 0.07325469268244868, 0.075]}, {"id": "section-1", "type": "ellipsoid", "center": [0.22549999999999998, 0.3825, 0], "radii": [0.08, 0.10120276676059799, 0.0675]}, {"id": "section-2", "type": "ellipsoid", "center": [0.238, 0.3375, 0], "radii": [0.0625, 0.03, 0.0525]}], "operations": [{"id": "blend-1", "type": "smooth-union", "left": "section-0", "right": "section-1", "radius": 0.025}, {"id": "blend-2", "type": "smooth-union", "left": "blend-1", "right": "section-2", "radius": 0.025}], "bounds": {"min": [0.08, 0.251297233239402, -0.105], "max": [0.3025, 0.6057546926824486, 0.105]}, "resolution": 42});
  if (!endpoint_pants_left_12) {
    mesh_pants_left_12Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_pants_left_12 = new THREE.Mesh(
    mesh_pants_left_12Geometry,
    createSculptMaterial("boots", {"id": "boots", "name": "boots", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#101614", "color": "#101614", "albedo": {"dominant": "#101614", "secondary": ["#101614"], "accents": []}, "colorVariation": {"palette": ["#101614", "#101614"], "pattern": "flat", "amplitude": 0, "heightCorrelation": 0}, "roughness": {"base": 0.64, "variation": 0.02, "map": "independent-micro-response"}, "metalness": {"base": 0, "variation": 0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "boots-fold-tone", "region": "reference-observed fold valleys", "roughness": 0.68, "evidenceRefs": ["full-object"], "notes": "Cloth folds are geometry; front shade boundary comes from de-lit projection."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Observed anime base colour. Physical roughness is inferred, not measured photometric evidence.", "textureless": {"declared": true, "evidence": ["docs/references/user-cast/zoro.png: flat cel-colour fills, bounded linework and painted shadow regions; no observable grain/pores.", ".img2threejs/cast/zoro/material-evidence.json: pixel crop and source-classification evidence."], "limitation": "No photometric PBR recovery is claimed. Geometry carries folds, fittings and wrap diamonds."}}, options, true)
  );
  mesh_pants_left_12.name = "Left trouser cuff";
  if (endpoint_pants_left_12) {
    mesh_pants_left_12.position.copy(endpoint_pants_left_12.midpoint);
    mesh_pants_left_12.quaternion.copy(endpoint_pants_left_12.quaternion);
  }
  mesh_pants_left_12.castShadow = options.castShadow ?? true;
  mesh_pants_left_12.receiveShadow = options.receiveShadow ?? true;
  mesh_pants_left_12.userData.sculptComponent = {"id": "pants-left", "name": "Left trouser cuff", "level": "meso", "role": "garment", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "Left trouser cuff follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "Smooth-union body/garment blockout; garment shell offset and silhouette refinement remain later pass tasks.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "sdf": {"primitives": [{"id": "section-0", "type": "ellipsoid", "center": [0.20299999999999999, 0.5025, 0], "radii": [0.09, 0.07325469268244868, 0.075]}, {"id": "section-1", "type": "ellipsoid", "center": [0.22549999999999998, 0.3825, 0], "radii": [0.08, 0.10120276676059799, 0.0675]}, {"id": "section-2", "type": "ellipsoid", "center": [0.238, 0.3375, 0], "radii": [0.0625, 0.03, 0.0525]}], "operations": [{"id": "blend-1", "type": "smooth-union", "left": "section-0", "right": "section-1", "radius": 0.025}, {"id": "blend-2", "type": "smooth-union", "left": "blend-1", "right": "section-2", "radius": 0.025}], "bounds": {"min": [0.08, 0.251297233239402, -0.105], "max": [0.3025, 0.6057546926824486, 0.105]}, "resolution": 42}, "observedStations": [[354, 839, 0, 30, 30], [363, 887, 0, 26, 27], [368, 905, 0, 19, 21]]}, "parent": "root", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pants-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "boots"}}, "material": "boots", "materialLayers": ["boots"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["pants-left-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(16, 22, 20, 1)", "secondaryAlbedo": "rgba(14, 20, 18, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_pants_left_12.add(mesh_pants_left_12);
  meshes["pants-left"] = mesh_pants_left_12;
  colliders["pants-left"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["pants-left"] ??= [];
  destructionGroups["pants-left"].push(node_pants_left_12);

  const endpoint_pants_right_13 = makeAttachmentEndpoint(null);
  const node_pants_right_13 = new THREE.Group();
  node_pants_right_13.name = "Right trouser cuff__pivot";
  node_pants_right_13.scale.set(1, 1, 1);
  if (endpoint_pants_right_13) {
    node_pants_right_13.position.copy(endpoint_pants_right_13.start);
    node_pants_right_13.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pants_right_13.position.set(0.0, 0.0, 0.0);
    node_pants_right_13.rotation.set(0.0, 0.0, 0.0);
  }
  node_pants_right_13.userData.sculptComponent = {"id": "pants-right", "name": "Right trouser cuff", "level": "meso", "role": "garment", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "Right trouser cuff follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "Smooth-union body/garment blockout; garment shell offset and silhouette refinement remain later pass tasks.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "sdf": {"primitives": [{"id": "section-0", "type": "ellipsoid", "center": [-0.26, 0.4975, 0], "radii": [0.0875, 0.06979434074479104, 0.075]}, {"id": "section-1", "type": "ellipsoid", "center": [-0.2775, 0.3825, 0], "radii": [0.0775, 0.09694457179233915, 0.0675]}, {"id": "section-2", "type": "ellipsoid", "center": [-0.2825, 0.3375, 0], "radii": [0.06, 0.03, 0.0525]}], "operations": [{"id": "blend-1", "type": "smooth-union", "left": "section-0", "right": "section-1", "radius": 0.025}, {"id": "blend-2", "type": "smooth-union", "left": "blend-1", "right": "section-2", "radius": 0.025}], "bounds": {"min": [-0.37, 0.25555542820766086, -0.105], "max": [-0.1575, 0.597294340744791, 0.105]}, "resolution": 42}, "observedStations": [[176, 841, 0, 29, 30], [169, 887, 0, 25, 27], [167, 905, 0, 18, 21]]}, "parent": "root", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pants-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "boots"}}, "material": "boots", "materialLayers": ["boots"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["pants-right-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(16, 22, 20, 1)", "secondaryAlbedo": "rgba(14, 20, 18, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_pants_right_13.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pants-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "boots"}};
  (nodes["root"] ?? root).add(node_pants_right_13);
  nodes["pants-right"] = node_pants_right_13;
  const mesh_pants_right_13Geometry = polygonizeSdf({"primitives": [{"id": "section-0", "type": "ellipsoid", "center": [-0.26, 0.4975, 0], "radii": [0.0875, 0.06979434074479104, 0.075]}, {"id": "section-1", "type": "ellipsoid", "center": [-0.2775, 0.3825, 0], "radii": [0.0775, 0.09694457179233915, 0.0675]}, {"id": "section-2", "type": "ellipsoid", "center": [-0.2825, 0.3375, 0], "radii": [0.06, 0.03, 0.0525]}], "operations": [{"id": "blend-1", "type": "smooth-union", "left": "section-0", "right": "section-1", "radius": 0.025}, {"id": "blend-2", "type": "smooth-union", "left": "blend-1", "right": "section-2", "radius": 0.025}], "bounds": {"min": [-0.37, 0.25555542820766086, -0.105], "max": [-0.1575, 0.597294340744791, 0.105]}, "resolution": 42});
  if (!endpoint_pants_right_13) {
    mesh_pants_right_13Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_pants_right_13 = new THREE.Mesh(
    mesh_pants_right_13Geometry,
    createSculptMaterial("boots", {"id": "boots", "name": "boots", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#101614", "color": "#101614", "albedo": {"dominant": "#101614", "secondary": ["#101614"], "accents": []}, "colorVariation": {"palette": ["#101614", "#101614"], "pattern": "flat", "amplitude": 0, "heightCorrelation": 0}, "roughness": {"base": 0.64, "variation": 0.02, "map": "independent-micro-response"}, "metalness": {"base": 0, "variation": 0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "boots-fold-tone", "region": "reference-observed fold valleys", "roughness": 0.68, "evidenceRefs": ["full-object"], "notes": "Cloth folds are geometry; front shade boundary comes from de-lit projection."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Observed anime base colour. Physical roughness is inferred, not measured photometric evidence.", "textureless": {"declared": true, "evidence": ["docs/references/user-cast/zoro.png: flat cel-colour fills, bounded linework and painted shadow regions; no observable grain/pores.", ".img2threejs/cast/zoro/material-evidence.json: pixel crop and source-classification evidence."], "limitation": "No photometric PBR recovery is claimed. Geometry carries folds, fittings and wrap diamonds."}}, options, true)
  );
  mesh_pants_right_13.name = "Right trouser cuff";
  if (endpoint_pants_right_13) {
    mesh_pants_right_13.position.copy(endpoint_pants_right_13.midpoint);
    mesh_pants_right_13.quaternion.copy(endpoint_pants_right_13.quaternion);
  }
  mesh_pants_right_13.castShadow = options.castShadow ?? true;
  mesh_pants_right_13.receiveShadow = options.receiveShadow ?? true;
  mesh_pants_right_13.userData.sculptComponent = {"id": "pants-right", "name": "Right trouser cuff", "level": "meso", "role": "garment", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "Right trouser cuff follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "Smooth-union body/garment blockout; garment shell offset and silhouette refinement remain later pass tasks.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "sdf": {"primitives": [{"id": "section-0", "type": "ellipsoid", "center": [-0.26, 0.4975, 0], "radii": [0.0875, 0.06979434074479104, 0.075]}, {"id": "section-1", "type": "ellipsoid", "center": [-0.2775, 0.3825, 0], "radii": [0.0775, 0.09694457179233915, 0.0675]}, {"id": "section-2", "type": "ellipsoid", "center": [-0.2825, 0.3375, 0], "radii": [0.06, 0.03, 0.0525]}], "operations": [{"id": "blend-1", "type": "smooth-union", "left": "section-0", "right": "section-1", "radius": 0.025}, {"id": "blend-2", "type": "smooth-union", "left": "blend-1", "right": "section-2", "radius": 0.025}], "bounds": {"min": [-0.37, 0.25555542820766086, -0.105], "max": [-0.1575, 0.597294340744791, 0.105]}, "resolution": 42}, "observedStations": [[176, 841, 0, 29, 30], [169, 887, 0, 25, 27], [167, 905, 0, 18, 21]]}, "parent": "root", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pants-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "boots"}}, "material": "boots", "materialLayers": ["boots"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["pants-right-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(16, 22, 20, 1)", "secondaryAlbedo": "rgba(14, 20, 18, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_pants_right_13.add(mesh_pants_right_13);
  meshes["pants-right"] = mesh_pants_right_13;
  colliders["pants-right"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["pants-right"] ??= [];
  destructionGroups["pants-right"].push(node_pants_right_13);

  const endpoint_boots_14 = makeAttachmentEndpoint(null);
  const node_boots_14 = new THREE.Group();
  node_boots_14.name = "Left boot__pivot";
  node_boots_14.scale.set(1, 1, 1);
  if (endpoint_boots_14) {
    node_boots_14.position.copy(endpoint_boots_14.start);
    node_boots_14.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_boots_14.position.set(0.0, 0.0, 0.0);
    node_boots_14.rotation.set(0.0, 0.0, 0.0);
  }
  node_boots_14.userData.sculptComponent = {"id": "boots", "name": "Left boot", "level": "macro", "role": "foot", "importance": 0.9, "confidence": 0.8, "primitive": "lathe", "topologyClass": "continuous-sculpt", "topologyRationale": "Closed curved boot volume fitted to isolated source alpha contours, with separately inferred ankle and toe depth.", "geometryDescriptor": {"profile2D": {"points": [[0.185, 0.3475], [0.275, 0.3525], [0.2925, 0.19], [0.33, 0.1275], [0.46, 0.0325], [0.48, 0.0025], [0.385, 0.0025], [0.2825, 0.0325], [0.2025, 0.0675], [0.1775, 0.1225]], "depth": 0.11}, "topologyIntent": "Monotone cubic section loft, closed volume or rounded cloth shell; see refineZoroGeometry.ts.", "edgeTreatment": {"type": "none", "bevelRadius": 0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "crease-preserving vertex normals", "parametricLoft": {"sections": [[0.003, 0.39, 0.001, 0.001, 0], [0.005, 0.39, 0.03, 0.092, 0], [0.0175, 0.39625, 0.08125, 0.092, 0], [0.03, 0.385, 0.095, 0.092, 0], [0.045, 0.3725, 0.1, 0.0896, 0], [0.07, 0.3325, 0.1, 0.0816, 0], [0.1, 0.29, 0.095, 0.072, 0], [0.1375, 0.27, 0.08, 0.06, 0], [0.175, 0.2525, 0.06, 0.048, 0], [0.2125, 0.2375, 0.045, 0.036000000000000004, 0], [0.25, 0.2375, 0.04, 0.032, 0], [0.3, 0.23625, 0.03875, 0.032, 0], [0.3375, 0.23, 0.05, 0.032, 0], [0.3625, 0.21875, 0.06125, 0.032, 0], [0.3665, 0.21875, 0.058187499999999996, 0.032, 0]], "radialSegments": 72, "verticalSegments": 64}, "latheProfile": {"points": [[0.001, 0.003], [0.03, 0.005], [0.08125, 0.0175], [0.095, 0.03], [0.1, 0.045], [0.1, 0.07], [0.095, 0.1], [0.08, 0.1375], [0.06, 0.175], [0.045, 0.2125], [0.04, 0.25], [0.03875, 0.3], [0.05, 0.3375], [0.06125, 0.3625], [0.058187499999999996, 0.3665]], "segments": 64}}, "parent": "root", "attachment": null, "dimensions": {"width": 0.3025, "height": 0.35, "depth": 0.11, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "boots", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "boots"}}, "material": "boots", "materialLayers": ["boots"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["boots-observed-contour", {"id": "boot-toes", "description": "Pointed dark boots angled outward from ankles", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(16, 22, 20, 1)", "secondaryAlbedo": "rgba(14, 20, 18, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_boots_14.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "boots", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "boots"}};
  (nodes["root"] ?? root).add(node_boots_14);
  nodes["boots"] = node_boots_14;
  const mesh_boots_14Geometry = endpoint_boots_14
    ? new THREE.CylinderGeometry(endpoint_boots_14.endRadius, endpoint_boots_14.baseRadius, endpoint_boots_14.length, 32, 12)
    : buildLatheGeometry({"points": [[0.001, 0.003], [0.03, 0.005], [0.08125, 0.0175], [0.095, 0.03], [0.1, 0.045], [0.1, 0.07], [0.095, 0.1], [0.08, 0.1375], [0.06, 0.175], [0.045, 0.2125], [0.04, 0.25], [0.03875, 0.3], [0.05, 0.3375], [0.06125, 0.3625], [0.058187499999999996, 0.3665]], "segments": 64});
  if (!endpoint_boots_14) {
    mesh_boots_14Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_boots_14 = new THREE.Mesh(
    mesh_boots_14Geometry,
    materialMap["boots"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_boots_14.name = "Left boot";
  if (endpoint_boots_14) {
    mesh_boots_14.position.copy(endpoint_boots_14.midpoint);
    mesh_boots_14.quaternion.copy(endpoint_boots_14.quaternion);
  }
  mesh_boots_14.castShadow = options.castShadow ?? true;
  mesh_boots_14.receiveShadow = options.receiveShadow ?? true;
  mesh_boots_14.userData.sculptComponent = {"id": "boots", "name": "Left boot", "level": "macro", "role": "foot", "importance": 0.9, "confidence": 0.8, "primitive": "lathe", "topologyClass": "continuous-sculpt", "topologyRationale": "Closed curved boot volume fitted to isolated source alpha contours, with separately inferred ankle and toe depth.", "geometryDescriptor": {"profile2D": {"points": [[0.185, 0.3475], [0.275, 0.3525], [0.2925, 0.19], [0.33, 0.1275], [0.46, 0.0325], [0.48, 0.0025], [0.385, 0.0025], [0.2825, 0.0325], [0.2025, 0.0675], [0.1775, 0.1225]], "depth": 0.11}, "topologyIntent": "Monotone cubic section loft, closed volume or rounded cloth shell; see refineZoroGeometry.ts.", "edgeTreatment": {"type": "none", "bevelRadius": 0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "crease-preserving vertex normals", "parametricLoft": {"sections": [[0.003, 0.39, 0.001, 0.001, 0], [0.005, 0.39, 0.03, 0.092, 0], [0.0175, 0.39625, 0.08125, 0.092, 0], [0.03, 0.385, 0.095, 0.092, 0], [0.045, 0.3725, 0.1, 0.0896, 0], [0.07, 0.3325, 0.1, 0.0816, 0], [0.1, 0.29, 0.095, 0.072, 0], [0.1375, 0.27, 0.08, 0.06, 0], [0.175, 0.2525, 0.06, 0.048, 0], [0.2125, 0.2375, 0.045, 0.036000000000000004, 0], [0.25, 0.2375, 0.04, 0.032, 0], [0.3, 0.23625, 0.03875, 0.032, 0], [0.3375, 0.23, 0.05, 0.032, 0], [0.3625, 0.21875, 0.06125, 0.032, 0], [0.3665, 0.21875, 0.058187499999999996, 0.032, 0]], "radialSegments": 72, "verticalSegments": 64}, "latheProfile": {"points": [[0.001, 0.003], [0.03, 0.005], [0.08125, 0.0175], [0.095, 0.03], [0.1, 0.045], [0.1, 0.07], [0.095, 0.1], [0.08, 0.1375], [0.06, 0.175], [0.045, 0.2125], [0.04, 0.25], [0.03875, 0.3], [0.05, 0.3375], [0.06125, 0.3625], [0.058187499999999996, 0.3665]], "segments": 64}}, "parent": "root", "attachment": null, "dimensions": {"width": 0.3025, "height": 0.35, "depth": 0.11, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "boots", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "boots"}}, "material": "boots", "materialLayers": ["boots"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["boots-observed-contour", {"id": "boot-toes", "description": "Pointed dark boots angled outward from ankles", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(16, 22, 20, 1)", "secondaryAlbedo": "rgba(14, 20, 18, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_boots_14.add(mesh_boots_14);
  meshes["boots"] = mesh_boots_14;
  colliders["boots"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["boots"] ??= [];
  destructionGroups["boots"].push(node_boots_14);

  const endpoint_boot_right_15 = makeAttachmentEndpoint(null);
  const node_boot_right_15 = new THREE.Group();
  node_boot_right_15.name = "Right boot__pivot";
  node_boot_right_15.scale.set(1, 1, 1);
  if (endpoint_boot_right_15) {
    node_boot_right_15.position.copy(endpoint_boot_right_15.start);
    node_boot_right_15.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_boot_right_15.position.set(0.0, 0.0, 0.0);
    node_boot_right_15.rotation.set(0.0, 0.0, 0.0);
  }
  node_boot_right_15.userData.sculptComponent = {"id": "boot-right", "name": "Right boot", "level": "macro", "role": "foot", "importance": 0.9, "confidence": 0.8, "primitive": "lathe", "topologyClass": "continuous-sculpt", "topologyRationale": "Closed curved boot volume fitted to isolated source alpha contours, with separately inferred ankle and toe depth.", "geometryDescriptor": {"profile2D": {"points": [[-0.2825, 0.3525], [-0.2325, 0.35], [-0.2425, 0.1925], [-0.2525, 0.1125], [-0.285, 0.0725], [-0.4225, 0.015], [-0.5125, 0.0225], [-0.495, 0.05], [-0.4025, 0.1125], [-0.3425, 0.1875], [-0.3275, 0.3175]], "depth": 0.11}, "topologyIntent": "Monotone cubic section loft, closed volume or rounded cloth shell; see refineZoroGeometry.ts.", "edgeTreatment": {"type": "none", "bevelRadius": 0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "crease-preserving vertex normals", "parametricLoft": {"sections": [[0.015500000000000002, -0.4475, 0.001, 0.001, 0], [0.0175, -0.4475, 0.0575, 0.092, 0], [0.03, -0.43875, 0.08125, 0.092, 0], [0.045, -0.42625, 0.09375, 0.0896, 0], [0.07, -0.38875, 0.09125, 0.0816, 0], [0.1, -0.34875, 0.08875, 0.072, 0], [0.1375, -0.33, 0.0725, 0.06, 0], [0.175, -0.31375, 0.05625, 0.048, 0], [0.2125, -0.29375, 0.04125, 0.036000000000000004, 0], [0.25, -0.28875, 0.03875, 0.032, 0], [0.3, -0.27875, 0.04125, 0.032, 0], [0.3375, -0.275, 0.05, 0.032, 0], [0.3625, -0.27375, 0.07125, 0.032, 0], [0.3665, -0.27375, 0.0676875, 0.032, 0]], "radialSegments": 72, "verticalSegments": 64}, "latheProfile": {"points": [[0.001, 0.015500000000000002], [0.0575, 0.0175], [0.08125, 0.03], [0.09375, 0.045], [0.09125, 0.07], [0.08875, 0.1], [0.0725, 0.1375], [0.05625, 0.175], [0.04125, 0.2125], [0.03875, 0.25], [0.04125, 0.3], [0.05, 0.3375], [0.07125, 0.3625], [0.0676875, 0.3665]], "segments": 64}}, "parent": "root", "attachment": null, "dimensions": {"width": 0.28, "height": 0.3375, "depth": 0.11, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "boot-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "boots"}}, "material": "boots", "materialLayers": ["boots"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["boot-right-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(16, 22, 20, 1)", "secondaryAlbedo": "rgba(14, 20, 18, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_boot_right_15.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "boot-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "boots"}};
  (nodes["root"] ?? root).add(node_boot_right_15);
  nodes["boot-right"] = node_boot_right_15;
  const mesh_boot_right_15Geometry = endpoint_boot_right_15
    ? new THREE.CylinderGeometry(endpoint_boot_right_15.endRadius, endpoint_boot_right_15.baseRadius, endpoint_boot_right_15.length, 32, 12)
    : buildLatheGeometry({"points": [[0.001, 0.015500000000000002], [0.0575, 0.0175], [0.08125, 0.03], [0.09375, 0.045], [0.09125, 0.07], [0.08875, 0.1], [0.0725, 0.1375], [0.05625, 0.175], [0.04125, 0.2125], [0.03875, 0.25], [0.04125, 0.3], [0.05, 0.3375], [0.07125, 0.3625], [0.0676875, 0.3665]], "segments": 64});
  if (!endpoint_boot_right_15) {
    mesh_boot_right_15Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_boot_right_15 = new THREE.Mesh(
    mesh_boot_right_15Geometry,
    materialMap["boots"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_boot_right_15.name = "Right boot";
  if (endpoint_boot_right_15) {
    mesh_boot_right_15.position.copy(endpoint_boot_right_15.midpoint);
    mesh_boot_right_15.quaternion.copy(endpoint_boot_right_15.quaternion);
  }
  mesh_boot_right_15.castShadow = options.castShadow ?? true;
  mesh_boot_right_15.receiveShadow = options.receiveShadow ?? true;
  mesh_boot_right_15.userData.sculptComponent = {"id": "boot-right", "name": "Right boot", "level": "macro", "role": "foot", "importance": 0.9, "confidence": 0.8, "primitive": "lathe", "topologyClass": "continuous-sculpt", "topologyRationale": "Closed curved boot volume fitted to isolated source alpha contours, with separately inferred ankle and toe depth.", "geometryDescriptor": {"profile2D": {"points": [[-0.2825, 0.3525], [-0.2325, 0.35], [-0.2425, 0.1925], [-0.2525, 0.1125], [-0.285, 0.0725], [-0.4225, 0.015], [-0.5125, 0.0225], [-0.495, 0.05], [-0.4025, 0.1125], [-0.3425, 0.1875], [-0.3275, 0.3175]], "depth": 0.11}, "topologyIntent": "Monotone cubic section loft, closed volume or rounded cloth shell; see refineZoroGeometry.ts.", "edgeTreatment": {"type": "none", "bevelRadius": 0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "crease-preserving vertex normals", "parametricLoft": {"sections": [[0.015500000000000002, -0.4475, 0.001, 0.001, 0], [0.0175, -0.4475, 0.0575, 0.092, 0], [0.03, -0.43875, 0.08125, 0.092, 0], [0.045, -0.42625, 0.09375, 0.0896, 0], [0.07, -0.38875, 0.09125, 0.0816, 0], [0.1, -0.34875, 0.08875, 0.072, 0], [0.1375, -0.33, 0.0725, 0.06, 0], [0.175, -0.31375, 0.05625, 0.048, 0], [0.2125, -0.29375, 0.04125, 0.036000000000000004, 0], [0.25, -0.28875, 0.03875, 0.032, 0], [0.3, -0.27875, 0.04125, 0.032, 0], [0.3375, -0.275, 0.05, 0.032, 0], [0.3625, -0.27375, 0.07125, 0.032, 0], [0.3665, -0.27375, 0.0676875, 0.032, 0]], "radialSegments": 72, "verticalSegments": 64}, "latheProfile": {"points": [[0.001, 0.015500000000000002], [0.0575, 0.0175], [0.08125, 0.03], [0.09375, 0.045], [0.09125, 0.07], [0.08875, 0.1], [0.0725, 0.1375], [0.05625, 0.175], [0.04125, 0.2125], [0.03875, 0.25], [0.04125, 0.3], [0.05, 0.3375], [0.07125, 0.3625], [0.0676875, 0.3665]], "segments": 64}}, "parent": "root", "attachment": null, "dimensions": {"width": 0.28, "height": 0.3375, "depth": 0.11, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "boot-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "boots"}}, "material": "boots", "materialLayers": ["boots"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["boot-right-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(16, 22, 20, 1)", "secondaryAlbedo": "rgba(14, 20, 18, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_boot_right_15.add(mesh_boot_right_15);
  meshes["boot-right"] = mesh_boot_right_15;
  colliders["boot-right"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["boot-right"] ??= [];
  destructionGroups["boot-right"].push(node_boot_right_15);

  const endpoint_sash_16 = makeAttachmentEndpoint(null);
  const node_sash_16 = new THREE.Group();
  node_sash_16.name = "Purple wrapped sash__pivot";
  node_sash_16.scale.set(1, 1, 1);
  if (endpoint_sash_16) {
    node_sash_16.position.copy(endpoint_sash_16.start);
    node_sash_16.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_sash_16.position.set(0.0, 0.0, 0.0);
    node_sash_16.rotation.set(0.0, 0.0, 0.0);
  }
  node_sash_16.userData.sculptComponent = {"id": "sash", "name": "Purple wrapped sash", "level": "meso", "role": "garment", "importance": 0.9, "confidence": 0.8, "primitive": "lathe", "topologyClass": "conforming-shell", "topologyRationale": "Continuous parameterized cross-sections fit the observed frontal outline; depth and hidden sides remain inferred.", "geometryDescriptor": {"latheProfile": {"points": [[0.245, 1.405], [0.27, 1.48], [0.278, 1.56], [0.273, 1.62]], "segments": 64}, "topologyIntent": "Monotone cubic section loft, closed volume or rounded cloth shell; see refineZoroGeometry.ts.", "edgeTreatment": {"type": "none", "bevelRadius": 0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "parametricLoft": {"sections": [[1.405, -0.005, 0.245, 0.15, 0.015], [1.48, -0.02, 0.27, 0.16, 0.015], [1.56, -0.04, 0.278, 0.163, 0.015], [1.62, -0.04, 0.273, 0.16, 0.015]], "radialSegments": 72, "verticalSegments": 64, "thickness": 0.01}}, "parent": "root", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "sash", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "sash"}}, "material": "sash", "materialLayers": ["sash"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["sash-observed-contour", {"id": "sash-folds", "description": "Layered purple wrap with strong horizontal creases", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(126, 46, 80, 1)", "secondaryAlbedo": "rgba(113, 41, 72, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_sash_16.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "sash", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "sash"}};
  (nodes["root"] ?? root).add(node_sash_16);
  nodes["sash"] = node_sash_16;
  const mesh_sash_16Geometry = endpoint_sash_16
    ? new THREE.CylinderGeometry(endpoint_sash_16.endRadius, endpoint_sash_16.baseRadius, endpoint_sash_16.length, 32, 12)
    : buildLatheGeometry({"points": [[0.245, 1.405], [0.27, 1.48], [0.278, 1.56], [0.273, 1.62]], "segments": 64});
  if (!endpoint_sash_16) {
    mesh_sash_16Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_sash_16 = new THREE.Mesh(
    mesh_sash_16Geometry,
    materialMap["sash"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_sash_16.name = "Purple wrapped sash";
  if (endpoint_sash_16) {
    mesh_sash_16.position.copy(endpoint_sash_16.midpoint);
    mesh_sash_16.quaternion.copy(endpoint_sash_16.quaternion);
  }
  mesh_sash_16.castShadow = options.castShadow ?? true;
  mesh_sash_16.receiveShadow = options.receiveShadow ?? true;
  mesh_sash_16.userData.sculptComponent = {"id": "sash", "name": "Purple wrapped sash", "level": "meso", "role": "garment", "importance": 0.9, "confidence": 0.8, "primitive": "lathe", "topologyClass": "conforming-shell", "topologyRationale": "Continuous parameterized cross-sections fit the observed frontal outline; depth and hidden sides remain inferred.", "geometryDescriptor": {"latheProfile": {"points": [[0.245, 1.405], [0.27, 1.48], [0.278, 1.56], [0.273, 1.62]], "segments": 64}, "topologyIntent": "Monotone cubic section loft, closed volume or rounded cloth shell; see refineZoroGeometry.ts.", "edgeTreatment": {"type": "none", "bevelRadius": 0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "parametricLoft": {"sections": [[1.405, -0.005, 0.245, 0.15, 0.015], [1.48, -0.02, 0.27, 0.16, 0.015], [1.56, -0.04, 0.278, 0.163, 0.015], [1.62, -0.04, 0.273, 0.16, 0.015]], "radialSegments": 72, "verticalSegments": 64, "thickness": 0.01}}, "parent": "root", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "sash", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "sash"}}, "material": "sash", "materialLayers": ["sash"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["sash-observed-contour", {"id": "sash-folds", "description": "Layered purple wrap with strong horizontal creases", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(126, 46, 80, 1)", "secondaryAlbedo": "rgba(113, 41, 72, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_sash_16.add(mesh_sash_16);
  meshes["sash"] = mesh_sash_16;
  colliders["sash"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["sash"] ??= [];
  destructionGroups["sash"].push(node_sash_16);

  const endpoint_sash_tail_17 = makeAttachmentEndpoint(null);
  const node_sash_tail_17 = new THREE.Group();
  node_sash_tail_17.name = "Long purple sash tail__pivot";
  node_sash_tail_17.scale.set(1, 1, 1);
  if (endpoint_sash_tail_17) {
    node_sash_tail_17.position.copy(endpoint_sash_tail_17.start);
    node_sash_tail_17.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_sash_tail_17.position.set(0.0, 0.0, 0.18);
    node_sash_tail_17.rotation.set(0.0, 0.0, 0.0);
  }
  node_sash_tail_17.userData.sculptComponent = {"id": "sash-tail", "name": "Long purple sash tail", "level": "meso", "role": "garment", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "Thin fitted garment panel follows observed contour; thickness is physical fabric thickness, not a continuous body volume.", "geometryDescriptor": {"profile2D": {"points": [[0.1325, 1.6375], [0.1875, 1.65], [0.2175, 1.51], [0.29, 0.98], [0.245, 0.9375], [0.175, 0.97]], "depth": 0.012}, "topologyIntent": "garment shell with observed hem and folds; depth inferred", "edgeTreatment": {"type": "none", "bevelRadius": 0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "crease-preserving vertex normals"}, "parent": "root", "attachment": {"parentSocket": "sash-tail-root", "localStart": [0.1775, 1.64, 0.18], "localEnd": [0.1775, 1.64, 0.18], "contactType": "surface-overlap", "embedDepth": 0.025, "gapTolerance": 0.008, "evidenceRefs": ["full-object"], "notes": "Point anchor; field geometry supplies extent, not a linear attachment cylinder."}, "dimensions": {"width": 0.1575, "height": 0.7125, "depth": 0.012, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0.18], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "sash-tail", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "sash"}}, "material": "sash", "materialLayers": ["sash"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["sash-tail-observed-contour", {"id": "sash-tails", "description": "Two long purple fabric tails on left hip", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(126, 46, 80, 1)", "secondaryAlbedo": "rgba(113, 41, 72, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_sash_tail_17.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "sash-tail", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "sash"}};
  (nodes["root"] ?? root).add(node_sash_tail_17);
  nodes["sash-tail"] = node_sash_tail_17;
  const mesh_sash_tail_17Geometry = endpoint_sash_tail_17
    ? new THREE.CylinderGeometry(endpoint_sash_tail_17.endRadius, endpoint_sash_tail_17.baseRadius, endpoint_sash_tail_17.length, 32, 12)
    : buildExtrudeGeometry({"points": [[0.1325, 1.6375], [0.1875, 1.65], [0.2175, 1.51], [0.29, 0.98], [0.245, 0.9375], [0.175, 0.97]], "depth": 0.012});
  if (!endpoint_sash_tail_17) {
    mesh_sash_tail_17Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_sash_tail_17 = new THREE.Mesh(
    mesh_sash_tail_17Geometry,
    materialMap["sash"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_sash_tail_17.name = "Long purple sash tail";
  if (endpoint_sash_tail_17) {
    mesh_sash_tail_17.position.copy(endpoint_sash_tail_17.midpoint);
    mesh_sash_tail_17.quaternion.copy(endpoint_sash_tail_17.quaternion);
  }
  mesh_sash_tail_17.castShadow = options.castShadow ?? true;
  mesh_sash_tail_17.receiveShadow = options.receiveShadow ?? true;
  mesh_sash_tail_17.userData.sculptComponent = {"id": "sash-tail", "name": "Long purple sash tail", "level": "meso", "role": "garment", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "Thin fitted garment panel follows observed contour; thickness is physical fabric thickness, not a continuous body volume.", "geometryDescriptor": {"profile2D": {"points": [[0.1325, 1.6375], [0.1875, 1.65], [0.2175, 1.51], [0.29, 0.98], [0.245, 0.9375], [0.175, 0.97]], "depth": 0.012}, "topologyIntent": "garment shell with observed hem and folds; depth inferred", "edgeTreatment": {"type": "none", "bevelRadius": 0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "crease-preserving vertex normals"}, "parent": "root", "attachment": {"parentSocket": "sash-tail-root", "localStart": [0.1775, 1.64, 0.18], "localEnd": [0.1775, 1.64, 0.18], "contactType": "surface-overlap", "embedDepth": 0.025, "gapTolerance": 0.008, "evidenceRefs": ["full-object"], "notes": "Point anchor; field geometry supplies extent, not a linear attachment cylinder."}, "dimensions": {"width": 0.1575, "height": 0.7125, "depth": 0.012, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0.18], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "sash-tail", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "sash"}}, "material": "sash", "materialLayers": ["sash"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["sash-tail-observed-contour", {"id": "sash-tails", "description": "Two long purple fabric tails on left hip", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(126, 46, 80, 1)", "secondaryAlbedo": "rgba(113, 41, 72, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_sash_tail_17.add(mesh_sash_tail_17);
  meshes["sash-tail"] = mesh_sash_tail_17;
  colliders["sash-tail"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["sash-tail"] ??= [];
  destructionGroups["sash-tail"].push(node_sash_tail_17);

  const endpoint_sash_tail_back_18 = makeAttachmentEndpoint(null);
  const node_sash_tail_back_18 = new THREE.Group();
  node_sash_tail_back_18.name = "Rear purple sash tail__pivot";
  node_sash_tail_back_18.scale.set(1, 1, 1);
  if (endpoint_sash_tail_back_18) {
    node_sash_tail_back_18.position.copy(endpoint_sash_tail_back_18.start);
    node_sash_tail_back_18.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_sash_tail_back_18.position.set(0.0, 0.0, 0.13);
    node_sash_tail_back_18.rotation.set(0.0, 0.0, 0.0);
  }
  node_sash_tail_back_18.userData.sculptComponent = {"id": "sash-tail-back", "name": "Rear purple sash tail", "level": "meso", "role": "garment", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "Thin fitted garment panel follows observed contour; thickness is physical fabric thickness, not a continuous body volume.", "geometryDescriptor": {"profile2D": {"points": [[0.165, 1.63], [0.2125, 1.6325], [0.275, 1.33], [0.3525, 0.99], [0.2725, 0.975]], "depth": 0.012}, "topologyIntent": "garment shell with observed hem and folds; depth inferred", "edgeTreatment": {"type": "none", "bevelRadius": 0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "crease-preserving vertex normals"}, "parent": "root", "attachment": {"parentSocket": "sash-tail-back-root", "localStart": [0.2, 1.6275, 0.13], "localEnd": [0.2, 1.6275, 0.13], "contactType": "surface-overlap", "embedDepth": 0.025, "gapTolerance": 0.008, "evidenceRefs": ["full-object"], "notes": "Point anchor; field geometry supplies extent, not a linear attachment cylinder."}, "dimensions": {"width": 0.1875, "height": 0.6575, "depth": 0.012, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0.13], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "sash-tail-back", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "sash"}}, "material": "sash", "materialLayers": ["sash"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["sash-tail-back-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(126, 46, 80, 1)", "secondaryAlbedo": "rgba(113, 41, 72, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_sash_tail_back_18.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "sash-tail-back", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "sash"}};
  (nodes["root"] ?? root).add(node_sash_tail_back_18);
  nodes["sash-tail-back"] = node_sash_tail_back_18;
  const mesh_sash_tail_back_18Geometry = endpoint_sash_tail_back_18
    ? new THREE.CylinderGeometry(endpoint_sash_tail_back_18.endRadius, endpoint_sash_tail_back_18.baseRadius, endpoint_sash_tail_back_18.length, 32, 12)
    : buildExtrudeGeometry({"points": [[0.165, 1.63], [0.2125, 1.6325], [0.275, 1.33], [0.3525, 0.99], [0.2725, 0.975]], "depth": 0.012});
  if (!endpoint_sash_tail_back_18) {
    mesh_sash_tail_back_18Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_sash_tail_back_18 = new THREE.Mesh(
    mesh_sash_tail_back_18Geometry,
    materialMap["sash"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_sash_tail_back_18.name = "Rear purple sash tail";
  if (endpoint_sash_tail_back_18) {
    mesh_sash_tail_back_18.position.copy(endpoint_sash_tail_back_18.midpoint);
    mesh_sash_tail_back_18.quaternion.copy(endpoint_sash_tail_back_18.quaternion);
  }
  mesh_sash_tail_back_18.castShadow = options.castShadow ?? true;
  mesh_sash_tail_back_18.receiveShadow = options.receiveShadow ?? true;
  mesh_sash_tail_back_18.userData.sculptComponent = {"id": "sash-tail-back", "name": "Rear purple sash tail", "level": "meso", "role": "garment", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "Thin fitted garment panel follows observed contour; thickness is physical fabric thickness, not a continuous body volume.", "geometryDescriptor": {"profile2D": {"points": [[0.165, 1.63], [0.2125, 1.6325], [0.275, 1.33], [0.3525, 0.99], [0.2725, 0.975]], "depth": 0.012}, "topologyIntent": "garment shell with observed hem and folds; depth inferred", "edgeTreatment": {"type": "none", "bevelRadius": 0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "crease-preserving vertex normals"}, "parent": "root", "attachment": {"parentSocket": "sash-tail-back-root", "localStart": [0.2, 1.6275, 0.13], "localEnd": [0.2, 1.6275, 0.13], "contactType": "surface-overlap", "embedDepth": 0.025, "gapTolerance": 0.008, "evidenceRefs": ["full-object"], "notes": "Point anchor; field geometry supplies extent, not a linear attachment cylinder."}, "dimensions": {"width": 0.1875, "height": 0.6575, "depth": 0.012, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0.13], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "sash-tail-back", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "sash"}}, "material": "sash", "materialLayers": ["sash"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["sash-tail-back-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(126, 46, 80, 1)", "secondaryAlbedo": "rgba(113, 41, 72, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_sash_tail_back_18.add(mesh_sash_tail_back_18);
  meshes["sash-tail-back"] = mesh_sash_tail_back_18;
  colliders["sash-tail-back"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["sash-tail-back"] ??= [];
  destructionGroups["sash-tail-back"].push(node_sash_tail_back_18);

  const endpoint_armband_19 = makeAttachmentEndpoint(null);
  const node_armband_19 = new THREE.Group();
  node_armband_19.name = "Fitted upper-arm wrap__pivot";
  node_armband_19.scale.set(1, 1, 1);
  if (endpoint_armband_19) {
    node_armband_19.position.copy(endpoint_armband_19.start);
    node_armband_19.rotation.set(1.5707963267948966, 0.0, -0.15);
  } else {
    node_armband_19.position.set(0.2575, 1.84, 0.0);
    node_armband_19.rotation.set(1.5707963267948966, 0.0, -0.15);
  }
  node_armband_19.userData.sculptComponent = {"id": "armband", "name": "Fitted upper-arm wrap", "level": "meso", "role": "garment", "importance": 0.9, "confidence": 0.8, "primitive": "torus", "topologyClass": "conforming-shell", "topologyRationale": "A fitted textile band wraps the upper arm, with an elliptical opening and finite thickness.", "geometryDescriptor": {"torusTubeRatio": 0.18, "topologyIntent": "fitted upper arm band", "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": {"parentSocket": "left-upper-arm", "localStart": [0.2575, 1.84, 0], "localEnd": [0.2575, 1.84, 0], "contactType": "surface-overlap", "embedDepth": 0.02, "gapTolerance": 0.008, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.2575, 1.84, 0.0], "rotation": [1.5707963267948966, 0, -0.15], "scale": [0.17, 0.16, 0.05]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "armband", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "boots"}}, "material": "boots", "materialLayers": ["boots"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["armband-observed-contour", {"id": "armband", "description": "Black band tied on anatomical left upper arm", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(16, 22, 20, 1)", "secondaryAlbedo": "rgba(14, 20, 18, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_armband_19.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "armband", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "boots"}};
  (nodes["root"] ?? root).add(node_armband_19);
  nodes["armband"] = node_armband_19;
  const mesh_armband_19Geometry = endpoint_armband_19
    ? new THREE.CylinderGeometry(endpoint_armband_19.endRadius, endpoint_armband_19.baseRadius, endpoint_armband_19.length, 32, 12)
    : new THREE.TorusGeometry(0.45, 0.081, 24, 96);
  if (!endpoint_armband_19) {
    mesh_armband_19Geometry.scale(0.17, 0.16, 0.05);
  }
  const mesh_armband_19 = new THREE.Mesh(
    mesh_armband_19Geometry,
    materialMap["boots"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_armband_19.name = "Fitted upper-arm wrap";
  if (endpoint_armband_19) {
    mesh_armband_19.position.copy(endpoint_armband_19.midpoint);
    mesh_armband_19.quaternion.copy(endpoint_armband_19.quaternion);
  }
  mesh_armband_19.castShadow = options.castShadow ?? true;
  mesh_armband_19.receiveShadow = options.receiveShadow ?? true;
  mesh_armband_19.userData.sculptComponent = {"id": "armband", "name": "Fitted upper-arm wrap", "level": "meso", "role": "garment", "importance": 0.9, "confidence": 0.8, "primitive": "torus", "topologyClass": "conforming-shell", "topologyRationale": "A fitted textile band wraps the upper arm, with an elliptical opening and finite thickness.", "geometryDescriptor": {"torusTubeRatio": 0.18, "topologyIntent": "fitted upper arm band", "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": {"parentSocket": "left-upper-arm", "localStart": [0.2575, 1.84, 0], "localEnd": [0.2575, 1.84, 0], "contactType": "surface-overlap", "embedDepth": 0.02, "gapTolerance": 0.008, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.2575, 1.84, 0.0], "rotation": [1.5707963267948966, 0, -0.15], "scale": [0.17, 0.16, 0.05]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "armband", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "boots"}}, "material": "boots", "materialLayers": ["boots"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["armband-observed-contour", {"id": "armband", "description": "Black band tied on anatomical left upper arm", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L4", "colorMaterialRecipe": {"dominantAlbedo": "rgba(16, 22, 20, 1)", "secondaryAlbedo": "rgba(14, 20, 18, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_armband_19.add(mesh_armband_19);
  meshes["armband"] = mesh_armband_19;
  colliders["armband"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["armband"] ??= [];
  destructionGroups["armband"].push(node_armband_19);

  const endpoint_head_20 = makeAttachmentEndpoint(null);
  const node_head_20 = new THREE.Group();
  node_head_20.name = "Continuous head volume__pivot";
  node_head_20.scale.set(1, 1, 1);
  if (endpoint_head_20) {
    node_head_20.position.copy(endpoint_head_20.start);
    node_head_20.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_head_20.position.set(-0.045, 2.33, 0.0);
    node_head_20.rotation.set(0.0, 0.0, 0.0);
  }
  node_head_20.userData.sculptComponent = {"id": "head", "name": "Continuous head volume", "level": "macro", "role": "head", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Continuous parameterized cross-sections fit the observed frontal outline; depth and hidden sides remain inferred.", "geometryDescriptor": {"topologyIntent": "Monotone cubic section loft, closed volume or rounded cloth shell; see refineZoroGeometry.ts.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "ringStack": {"rings": [[-0.1375, 0.030000000000000002, 0.0025, 0], [-0.1275, 0.05500000000000001, 0.0225, 0], [-0.1025, 0.09, 0.05, 0], [-0.07, 0.11, 0.0675, 0], [-0.015, 0.1125, 0.0775, 0], [0.04, 0.10250000000000001, 0.08, 0], [0.0875, 0.085, 0.075, 0], [0.12, 0.06, 0.0575, 0], [0.135, 0.0025, 0.0025, 0]], "source": "Observed loft sections; conservative lateral bound for the shifted head axis."}, "parametricLoft": {"sections": [[-0.1375, 0.027500000000000004, 0.0025, 0.0025, 0], [-0.1275, 0.027500000000000004, 0.0275, 0.0225, 0], [-0.1025, 0.027500000000000004, 0.0625, 0.05, 0], [-0.07, 0.02, 0.09, 0.0675, 0], [-0.015, 0.0125, 0.1, 0.0775, 0], [0.04, 0.0025000000000000022, 0.1, 0.08, 0], [0.0875, 0.0, 0.085, 0.075, 0], [0.12, 0.0, 0.06, 0.0575, 0], [0.135, 0.0, 0.0025, 0.0025, 0]], "radialSegments": 72, "verticalSegments": 64, "frontFeatures": [{"x": -0.0295, "y": -0.002, "width": 0.027, "height": 0.018, "depth": -0.013}, {"x": 0.0615, "y": 0.002, "width": 0.027, "height": 0.018, "depth": -0.009}, {"x": 0.0175, "y": -0.04, "width": 0.013, "height": 0.038, "depth": 0.025}]}}, "parent": "neck", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.045, 2.33, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "head", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["head-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L0", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_head_20.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "head", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["neck"] ?? root).add(node_head_20);
  nodes["head"] = node_head_20;
  const mesh_head_20Geometry = endpoint_head_20
    ? new THREE.CylinderGeometry(endpoint_head_20.endRadius, endpoint_head_20.baseRadius, endpoint_head_20.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_head_20) {
    mesh_head_20Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_head_20 = new THREE.Mesh(
    mesh_head_20Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_head_20.name = "Continuous head volume";
  if (endpoint_head_20) {
    mesh_head_20.position.copy(endpoint_head_20.midpoint);
    mesh_head_20.quaternion.copy(endpoint_head_20.quaternion);
  }
  mesh_head_20.castShadow = options.castShadow ?? true;
  mesh_head_20.receiveShadow = options.receiveShadow ?? true;
  mesh_head_20.userData.sculptComponent = {"id": "head", "name": "Continuous head volume", "level": "macro", "role": "head", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Continuous parameterized cross-sections fit the observed frontal outline; depth and hidden sides remain inferred.", "geometryDescriptor": {"topologyIntent": "Monotone cubic section loft, closed volume or rounded cloth shell; see refineZoroGeometry.ts.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "ringStack": {"rings": [[-0.1375, 0.030000000000000002, 0.0025, 0], [-0.1275, 0.05500000000000001, 0.0225, 0], [-0.1025, 0.09, 0.05, 0], [-0.07, 0.11, 0.0675, 0], [-0.015, 0.1125, 0.0775, 0], [0.04, 0.10250000000000001, 0.08, 0], [0.0875, 0.085, 0.075, 0], [0.12, 0.06, 0.0575, 0], [0.135, 0.0025, 0.0025, 0]], "source": "Observed loft sections; conservative lateral bound for the shifted head axis."}, "parametricLoft": {"sections": [[-0.1375, 0.027500000000000004, 0.0025, 0.0025, 0], [-0.1275, 0.027500000000000004, 0.0275, 0.0225, 0], [-0.1025, 0.027500000000000004, 0.0625, 0.05, 0], [-0.07, 0.02, 0.09, 0.0675, 0], [-0.015, 0.0125, 0.1, 0.0775, 0], [0.04, 0.0025000000000000022, 0.1, 0.08, 0], [0.0875, 0.0, 0.085, 0.075, 0], [0.12, 0.0, 0.06, 0.0575, 0], [0.135, 0.0, 0.0025, 0.0025, 0]], "radialSegments": 72, "verticalSegments": 64, "frontFeatures": [{"x": -0.0295, "y": -0.002, "width": 0.027, "height": 0.018, "depth": -0.013}, {"x": 0.0615, "y": 0.002, "width": 0.027, "height": 0.018, "depth": -0.009}, {"x": 0.0175, "y": -0.04, "width": 0.013, "height": 0.038, "depth": 0.025}]}}, "parent": "neck", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.045, 2.33, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "head", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["head-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L0", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_head_20.add(mesh_head_20);
  meshes["head"] = mesh_head_20;
  colliders["head"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["head"] ??= [];
  destructionGroups["head"].push(node_head_20);

  const endpoint_hair_21 = makeAttachmentEndpoint(null);
  const node_hair_21 = new THREE.Group();
  node_hair_21.name = "Short green scalp crown__pivot";
  node_hair_21.scale.set(1, 1, 1);
  if (endpoint_hair_21) {
    node_hair_21.position.copy(endpoint_hair_21.start);
    node_hair_21.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hair_21.position.set(0.0175, 0.0, 0.0);
    node_hair_21.rotation.set(0.0, 0.0, 0.0);
  }
  node_hair_21.userData.sculptComponent = {"id": "hair", "name": "Short green scalp crown", "level": "meso", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "lathe", "topologyClass": "conforming-shell", "topologyRationale": "Continuous parameterized cross-sections fit the observed frontal outline; depth and hidden sides remain inferred.", "geometryDescriptor": {"topologyIntent": "Monotone cubic section loft, closed volume or rounded cloth shell; see refineZoroGeometry.ts.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "parametricLoft": {"sections": [[0.055, -0.014, 0.116, 0.094, 0], [0.075, -0.017, 0.11, 0.087, 0], [0.1, -0.017, 0.092, 0.076, 0], [0.125, -0.017, 0.06, 0.05, 0], [0.142, -0.017, 0.032, 0.027, 0], [0.15, -0.017, 0.01, 0.01, 0]], "radialSegments": 72, "verticalSegments": 64, "thickness": 0.008, "hemWarp": {"frontLift": 0.02, "backDrop": 0.04, "decay": 0.04}, "scalpOffset": {"component": "head", "clearance": 0.012, "evidence": "Offset the inner/outer shell coherently around the fitted scalp; keep positive wall thickness before standProud."}}, "latheProfile": {"points": [[0.116, 0.055], [0.11, 0.075], [0.092, 0.1], [0.06, 0.125], [0.032, 0.142], [0.01, 0.15]], "segments": 64}}, "parent": "head", "attachment": null, "dimensions": {"width": 0.235, "height": 0.153, "depth": 0.218, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0175, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-observed-contour", {"id": "hair-tips", "description": "Irregular short green triangular crown tips", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.004, "maxPush": 0.015}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.5, "v": 0.3}}};
  node_hair_21.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}};
  (nodes["head"] ?? root).add(node_hair_21);
  nodes["hair"] = node_hair_21;
  const mesh_hair_21Geometry = endpoint_hair_21
    ? new THREE.CylinderGeometry(endpoint_hair_21.endRadius, endpoint_hair_21.baseRadius, endpoint_hair_21.length, 32, 12)
    : buildLatheGeometry({"points": [[0.116, 0.055], [0.11, 0.075], [0.092, 0.1], [0.06, 0.125], [0.032, 0.142], [0.01, 0.15]], "segments": 64});
  if (!endpoint_hair_21) {
    mesh_hair_21Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hair_21 = new THREE.Mesh(
    mesh_hair_21Geometry,
    materialMap["hair"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hair_21.name = "Short green scalp crown";
  if (endpoint_hair_21) {
    mesh_hair_21.position.copy(endpoint_hair_21.midpoint);
    mesh_hair_21.quaternion.copy(endpoint_hair_21.quaternion);
  }
  mesh_hair_21.castShadow = options.castShadow ?? true;
  mesh_hair_21.receiveShadow = options.receiveShadow ?? true;
  mesh_hair_21.userData.sculptComponent = {"id": "hair", "name": "Short green scalp crown", "level": "meso", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "lathe", "topologyClass": "conforming-shell", "topologyRationale": "Continuous parameterized cross-sections fit the observed frontal outline; depth and hidden sides remain inferred.", "geometryDescriptor": {"topologyIntent": "Monotone cubic section loft, closed volume or rounded cloth shell; see refineZoroGeometry.ts.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "parametricLoft": {"sections": [[0.055, -0.014, 0.116, 0.094, 0], [0.075, -0.017, 0.11, 0.087, 0], [0.1, -0.017, 0.092, 0.076, 0], [0.125, -0.017, 0.06, 0.05, 0], [0.142, -0.017, 0.032, 0.027, 0], [0.15, -0.017, 0.01, 0.01, 0]], "radialSegments": 72, "verticalSegments": 64, "thickness": 0.008, "hemWarp": {"frontLift": 0.02, "backDrop": 0.04, "decay": 0.04}, "scalpOffset": {"component": "head", "clearance": 0.012, "evidence": "Offset the inner/outer shell coherently around the fitted scalp; keep positive wall thickness before standProud."}}, "latheProfile": {"points": [[0.116, 0.055], [0.11, 0.075], [0.092, 0.1], [0.06, 0.125], [0.032, 0.142], [0.01, 0.15]], "segments": 64}}, "parent": "head", "attachment": null, "dimensions": {"width": 0.235, "height": 0.153, "depth": 0.218, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0175, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-observed-contour", {"id": "hair-tips", "description": "Irregular short green triangular crown tips", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.004, "maxPush": 0.015}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.5, "v": 0.3}}};
  node_hair_21.add(mesh_hair_21);
  meshes["hair"] = mesh_hair_21;
  colliders["hair"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hair"] ??= [];
  destructionGroups["hair"].push(node_hair_21);

  const endpoint_hair_tip_0_22 = makeAttachmentEndpoint(null);
  const node_hair_tip_0_22 = new THREE.Group();
  node_hair_tip_0_22.name = "Scalp-attached tapered crown lock__pivot";
  node_hair_tip_0_22.scale.set(1, 1, 1);
  if (endpoint_hair_tip_0_22) {
    node_hair_tip_0_22.position.copy(endpoint_hair_tip_0_22.start);
    node_hair_tip_0_22.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hair_tip_0_22.position.set(0.0175, 0.0, 0.0);
    node_hair_tip_0_22.rotation.set(0.0, 0.0, 0.0);
  }
  node_hair_tip_0_22.userData.sculptComponent = {"id": "hair-tip-0", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.095, 0.07, 0.0], "rx": 0.011, "rz": 0.007}, {"position": [0.105, 0.112, 0.0], "rx": 0.008, "rz": 0.005}, {"position": [0.116, 0.143, 0.0], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0175, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-0", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-0-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.0, "v": 0.35}}};
  node_hair_tip_0_22.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-0", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}};
  (nodes["head"] ?? root).add(node_hair_tip_0_22);
  nodes["hair-tip-0"] = node_hair_tip_0_22;
  const mesh_hair_tip_0_22Geometry = endpoint_hair_tip_0_22
    ? new THREE.CylinderGeometry(endpoint_hair_tip_0_22.endRadius, endpoint_hair_tip_0_22.baseRadius, endpoint_hair_tip_0_22.length, 32, 12)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.095, 0.07, 0.0], "rx": 0.011, "rz": 0.007}, {"position": [0.105, 0.112, 0.0], "rx": 0.008, "rz": 0.005}, {"position": [0.116, 0.143, 0.0], "rx": 0, "rz": 0}], "radialSegments": 6});
  if (!endpoint_hair_tip_0_22) {
    mesh_hair_tip_0_22Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hair_tip_0_22 = new THREE.Mesh(
    mesh_hair_tip_0_22Geometry,
    materialMap["hair"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hair_tip_0_22.name = "Scalp-attached tapered crown lock";
  if (endpoint_hair_tip_0_22) {
    mesh_hair_tip_0_22.position.copy(endpoint_hair_tip_0_22.midpoint);
    mesh_hair_tip_0_22.quaternion.copy(endpoint_hair_tip_0_22.quaternion);
  }
  mesh_hair_tip_0_22.castShadow = options.castShadow ?? true;
  mesh_hair_tip_0_22.receiveShadow = options.receiveShadow ?? true;
  mesh_hair_tip_0_22.userData.sculptComponent = {"id": "hair-tip-0", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.095, 0.07, 0.0], "rx": 0.011, "rz": 0.007}, {"position": [0.105, 0.112, 0.0], "rx": 0.008, "rz": 0.005}, {"position": [0.116, 0.143, 0.0], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0175, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-0", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-0-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.0, "v": 0.35}}};
  node_hair_tip_0_22.add(mesh_hair_tip_0_22);
  meshes["hair-tip-0"] = mesh_hair_tip_0_22;
  colliders["hair-tip-0"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hair-tip-0"] ??= [];
  destructionGroups["hair-tip-0"].push(node_hair_tip_0_22);

  const endpoint_hair_tip_1_23 = makeAttachmentEndpoint(null);
  const node_hair_tip_1_23 = new THREE.Group();
  node_hair_tip_1_23.name = "Scalp-attached tapered crown lock__pivot";
  node_hair_tip_1_23.scale.set(1, 1, 1);
  if (endpoint_hair_tip_1_23) {
    node_hair_tip_1_23.position.copy(endpoint_hair_tip_1_23.start);
    node_hair_tip_1_23.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hair_tip_1_23.position.set(0.0175, 0.0, 0.0);
    node_hair_tip_1_23.rotation.set(0.0, 0.0, 0.0);
  }
  node_hair_tip_1_23.userData.sculptComponent = {"id": "hair-tip-1", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.08824557352802175, 0.07, 0.03214989347261286], "rx": 0.011, "rz": 0.007}, {"position": [0.09764249973588082, 0.117, 0.034886054619218204], "rx": 0.008, "rz": 0.005}, {"position": [0.10797911856452583, 0.149, 0.038306256052474896], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0175, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-1-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.05555555555555555, "v": 0.35}}};
  node_hair_tip_1_23.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}};
  (nodes["head"] ?? root).add(node_hair_tip_1_23);
  nodes["hair-tip-1"] = node_hair_tip_1_23;
  const mesh_hair_tip_1_23Geometry = endpoint_hair_tip_1_23
    ? new THREE.CylinderGeometry(endpoint_hair_tip_1_23.endRadius, endpoint_hair_tip_1_23.baseRadius, endpoint_hair_tip_1_23.length, 32, 12)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.08824557352802175, 0.07, 0.03214989347261286], "rx": 0.011, "rz": 0.007}, {"position": [0.09764249973588082, 0.117, 0.034886054619218204], "rx": 0.008, "rz": 0.005}, {"position": [0.10797911856452583, 0.149, 0.038306256052474896], "rx": 0, "rz": 0}], "radialSegments": 6});
  if (!endpoint_hair_tip_1_23) {
    mesh_hair_tip_1_23Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hair_tip_1_23 = new THREE.Mesh(
    mesh_hair_tip_1_23Geometry,
    materialMap["hair"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hair_tip_1_23.name = "Scalp-attached tapered crown lock";
  if (endpoint_hair_tip_1_23) {
    mesh_hair_tip_1_23.position.copy(endpoint_hair_tip_1_23.midpoint);
    mesh_hair_tip_1_23.quaternion.copy(endpoint_hair_tip_1_23.quaternion);
  }
  mesh_hair_tip_1_23.castShadow = options.castShadow ?? true;
  mesh_hair_tip_1_23.receiveShadow = options.receiveShadow ?? true;
  mesh_hair_tip_1_23.userData.sculptComponent = {"id": "hair-tip-1", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.08824557352802175, 0.07, 0.03214989347261286], "rx": 0.011, "rz": 0.007}, {"position": [0.09764249973588082, 0.117, 0.034886054619218204], "rx": 0.008, "rz": 0.005}, {"position": [0.10797911856452583, 0.149, 0.038306256052474896], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0175, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-1-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.05555555555555555, "v": 0.35}}};
  node_hair_tip_1_23.add(mesh_hair_tip_1_23);
  meshes["hair-tip-1"] = mesh_hair_tip_1_23;
  colliders["hair-tip-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hair-tip-1"] ??= [];
  destructionGroups["hair-tip-1"].push(node_hair_tip_1_23);

  const endpoint_hair_tip_2_24 = makeAttachmentEndpoint(null);
  const node_hair_tip_2_24 = new THREE.Group();
  node_hair_tip_2_24.name = "Scalp-attached tapered crown lock__pivot";
  node_hair_tip_2_24.scale.set(1, 1, 1);
  if (endpoint_hair_tip_2_24) {
    node_hair_tip_2_24.position.copy(endpoint_hair_tip_2_24.start);
    node_hair_tip_2_24.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hair_tip_2_24.position.set(0.0175, 0.0, 0.0);
    node_hair_tip_2_24.rotation.set(0.0, 0.0, 0.0);
  }
  node_hair_tip_2_24.userData.sculptComponent = {"id": "hair-tip-2", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.06879697762932553, 0.07, 0.06042203531053469], "rx": 0.011, "rz": 0.007}, {"position": [0.07645742206051531, 0.122, 0.065564336188027], "rx": 0.008, "rz": 0.005}, {"position": [0.08488391093482409, 0.155, 0.0719922122848924], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0175, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-2-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.1111111111111111, "v": 0.35}}};
  node_hair_tip_2_24.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}};
  (nodes["head"] ?? root).add(node_hair_tip_2_24);
  nodes["hair-tip-2"] = node_hair_tip_2_24;
  const mesh_hair_tip_2_24Geometry = endpoint_hair_tip_2_24
    ? new THREE.CylinderGeometry(endpoint_hair_tip_2_24.endRadius, endpoint_hair_tip_2_24.baseRadius, endpoint_hair_tip_2_24.length, 32, 12)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.06879697762932553, 0.07, 0.06042203531053469], "rx": 0.011, "rz": 0.007}, {"position": [0.07645742206051531, 0.122, 0.065564336188027], "rx": 0.008, "rz": 0.005}, {"position": [0.08488391093482409, 0.155, 0.0719922122848924], "rx": 0, "rz": 0}], "radialSegments": 6});
  if (!endpoint_hair_tip_2_24) {
    mesh_hair_tip_2_24Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hair_tip_2_24 = new THREE.Mesh(
    mesh_hair_tip_2_24Geometry,
    materialMap["hair"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hair_tip_2_24.name = "Scalp-attached tapered crown lock";
  if (endpoint_hair_tip_2_24) {
    mesh_hair_tip_2_24.position.copy(endpoint_hair_tip_2_24.midpoint);
    mesh_hair_tip_2_24.quaternion.copy(endpoint_hair_tip_2_24.quaternion);
  }
  mesh_hair_tip_2_24.castShadow = options.castShadow ?? true;
  mesh_hair_tip_2_24.receiveShadow = options.receiveShadow ?? true;
  mesh_hair_tip_2_24.userData.sculptComponent = {"id": "hair-tip-2", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.06879697762932553, 0.07, 0.06042203531053469], "rx": 0.011, "rz": 0.007}, {"position": [0.07645742206051531, 0.122, 0.065564336188027], "rx": 0.008, "rz": 0.005}, {"position": [0.08488391093482409, 0.155, 0.0719922122848924], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0175, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-2-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.1111111111111111, "v": 0.35}}};
  node_hair_tip_2_24.add(mesh_hair_tip_2_24);
  meshes["hair-tip-2"] = mesh_hair_tip_2_24;
  colliders["hair-tip-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hair-tip-2"] ??= [];
  destructionGroups["hair-tip-2"].push(node_hair_tip_2_24);

  const endpoint_hair_tip_3_25 = makeAttachmentEndpoint(null);
  const node_hair_tip_3_25 = new THREE.Group();
  node_hair_tip_3_25.name = "Scalp-attached tapered crown lock__pivot";
  node_hair_tip_3_25.scale.set(1, 1, 1);
  if (endpoint_hair_tip_3_25) {
    node_hair_tip_3_25.position.copy(endpoint_hair_tip_3_25.start);
    node_hair_tip_3_25.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hair_tip_3_25.position.set(0.0175, 0.0, 0.0);
    node_hair_tip_3_25.rotation.set(0.0, 0.0, 0.0);
  }
  node_hair_tip_3_25.userData.sculptComponent = {"id": "hair-tip-3", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.039000000000000014, 0.07, 0.08140638795573722], "rx": 0.011, "rz": 0.007}, {"position": [0.04400000000000001, 0.112, 0.08833459118601274], "rx": 0.008, "rz": 0.005}, {"position": [0.049500000000000016, 0.143, 0.09699484522385712], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0175, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-3-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.16666666666666666, "v": 0.35}}};
  node_hair_tip_3_25.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}};
  (nodes["head"] ?? root).add(node_hair_tip_3_25);
  nodes["hair-tip-3"] = node_hair_tip_3_25;
  const mesh_hair_tip_3_25Geometry = endpoint_hair_tip_3_25
    ? new THREE.CylinderGeometry(endpoint_hair_tip_3_25.endRadius, endpoint_hair_tip_3_25.baseRadius, endpoint_hair_tip_3_25.length, 32, 12)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.039000000000000014, 0.07, 0.08140638795573722], "rx": 0.011, "rz": 0.007}, {"position": [0.04400000000000001, 0.112, 0.08833459118601274], "rx": 0.008, "rz": 0.005}, {"position": [0.049500000000000016, 0.143, 0.09699484522385712], "rx": 0, "rz": 0}], "radialSegments": 6});
  if (!endpoint_hair_tip_3_25) {
    mesh_hair_tip_3_25Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hair_tip_3_25 = new THREE.Mesh(
    mesh_hair_tip_3_25Geometry,
    materialMap["hair"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hair_tip_3_25.name = "Scalp-attached tapered crown lock";
  if (endpoint_hair_tip_3_25) {
    mesh_hair_tip_3_25.position.copy(endpoint_hair_tip_3_25.midpoint);
    mesh_hair_tip_3_25.quaternion.copy(endpoint_hair_tip_3_25.quaternion);
  }
  mesh_hair_tip_3_25.castShadow = options.castShadow ?? true;
  mesh_hair_tip_3_25.receiveShadow = options.receiveShadow ?? true;
  mesh_hair_tip_3_25.userData.sculptComponent = {"id": "hair-tip-3", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.039000000000000014, 0.07, 0.08140638795573722], "rx": 0.011, "rz": 0.007}, {"position": [0.04400000000000001, 0.112, 0.08833459118601274], "rx": 0.008, "rz": 0.005}, {"position": [0.049500000000000016, 0.143, 0.09699484522385712], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0175, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-3-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.16666666666666666, "v": 0.35}}};
  node_hair_tip_3_25.add(mesh_hair_tip_3_25);
  meshes["hair-tip-3"] = mesh_hair_tip_3_25;
  colliders["hair-tip-3"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hair-tip-3"] ??= [];
  destructionGroups["hair-tip-3"].push(node_hair_tip_3_25);

  const endpoint_hair_tip_4_26 = makeAttachmentEndpoint(null);
  const node_hair_tip_4_26 = new THREE.Group();
  node_hair_tip_4_26.name = "Scalp-attached tapered crown lock__pivot";
  node_hair_tip_4_26.scale.set(1, 1, 1);
  if (endpoint_hair_tip_4_26) {
    node_hair_tip_4_26.position.copy(endpoint_hair_tip_4_26.start);
    node_hair_tip_4_26.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hair_tip_4_26.position.set(0.0175, 0.0, 0.0);
    node_hair_tip_4_26.rotation.set(0.0, 0.0, 0.0);
  }
  node_hair_tip_4_26.userData.sculptComponent = {"id": "hair-tip-4", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.0024485958986962056, 0.07, 0.09257192878314756], "rx": 0.011, "rz": 0.007}, {"position": [0.004185077675365509, 0.117, 0.10045039080724522], "rx": 0.008, "rz": 0.005}, {"position": [0.006095207629701744, 0.149, 0.1102984683373673], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0175, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-4-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.2222222222222222, "v": 0.35}}};
  node_hair_tip_4_26.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}};
  (nodes["head"] ?? root).add(node_hair_tip_4_26);
  nodes["hair-tip-4"] = node_hair_tip_4_26;
  const mesh_hair_tip_4_26Geometry = endpoint_hair_tip_4_26
    ? new THREE.CylinderGeometry(endpoint_hair_tip_4_26.endRadius, endpoint_hair_tip_4_26.baseRadius, endpoint_hair_tip_4_26.length, 32, 12)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0024485958986962056, 0.07, 0.09257192878314756], "rx": 0.011, "rz": 0.007}, {"position": [0.004185077675365509, 0.117, 0.10045039080724522], "rx": 0.008, "rz": 0.005}, {"position": [0.006095207629701744, 0.149, 0.1102984683373673], "rx": 0, "rz": 0}], "radialSegments": 6});
  if (!endpoint_hair_tip_4_26) {
    mesh_hair_tip_4_26Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hair_tip_4_26 = new THREE.Mesh(
    mesh_hair_tip_4_26Geometry,
    materialMap["hair"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hair_tip_4_26.name = "Scalp-attached tapered crown lock";
  if (endpoint_hair_tip_4_26) {
    mesh_hair_tip_4_26.position.copy(endpoint_hair_tip_4_26.midpoint);
    mesh_hair_tip_4_26.quaternion.copy(endpoint_hair_tip_4_26.quaternion);
  }
  mesh_hair_tip_4_26.castShadow = options.castShadow ?? true;
  mesh_hair_tip_4_26.receiveShadow = options.receiveShadow ?? true;
  mesh_hair_tip_4_26.userData.sculptComponent = {"id": "hair-tip-4", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.0024485958986962056, 0.07, 0.09257192878314756], "rx": 0.011, "rz": 0.007}, {"position": [0.004185077675365509, 0.117, 0.10045039080724522], "rx": 0.008, "rz": 0.005}, {"position": [0.006095207629701744, 0.149, 0.1102984683373673], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0175, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-4-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.2222222222222222, "v": 0.35}}};
  node_hair_tip_4_26.add(mesh_hair_tip_4_26);
  meshes["hair-tip-4"] = mesh_hair_tip_4_26;
  colliders["hair-tip-4"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hair-tip-4"] ??= [];
  destructionGroups["hair-tip-4"].push(node_hair_tip_4_26);

  const endpoint_hair_tip_5_27 = makeAttachmentEndpoint(null);
  const node_hair_tip_5_27 = new THREE.Group();
  node_hair_tip_5_27.name = "Scalp-attached tapered crown lock__pivot";
  node_hair_tip_5_27.scale.set(1, 1, 1);
  if (endpoint_hair_tip_5_27) {
    node_hair_tip_5_27.position.copy(endpoint_hair_tip_5_27.start);
    node_hair_tip_5_27.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hair_tip_5_27.position.set(0.0175, 0.0, 0.0);
    node_hair_tip_5_27.rotation.set(0.0, 0.0, 0.0);
  }
  node_hair_tip_5_27.userData.sculptComponent = {"id": "hair-tip-5", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.036448595898696194, 0.07, 0.09257192878314756], "rx": 0.011, "rz": 0.007}, {"position": [-0.0381850776753655, 0.122, 0.10045039080724522], "rx": 0.008, "rz": 0.005}, {"position": [-0.04009520762970173, 0.155, 0.1102984683373673], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0175, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-5-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.2777777777777778, "v": 0.35}}};
  node_hair_tip_5_27.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}};
  (nodes["head"] ?? root).add(node_hair_tip_5_27);
  nodes["hair-tip-5"] = node_hair_tip_5_27;
  const mesh_hair_tip_5_27Geometry = endpoint_hair_tip_5_27
    ? new THREE.CylinderGeometry(endpoint_hair_tip_5_27.endRadius, endpoint_hair_tip_5_27.baseRadius, endpoint_hair_tip_5_27.length, 32, 12)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.036448595898696194, 0.07, 0.09257192878314756], "rx": 0.011, "rz": 0.007}, {"position": [-0.0381850776753655, 0.122, 0.10045039080724522], "rx": 0.008, "rz": 0.005}, {"position": [-0.04009520762970173, 0.155, 0.1102984683373673], "rx": 0, "rz": 0}], "radialSegments": 6});
  if (!endpoint_hair_tip_5_27) {
    mesh_hair_tip_5_27Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hair_tip_5_27 = new THREE.Mesh(
    mesh_hair_tip_5_27Geometry,
    materialMap["hair"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hair_tip_5_27.name = "Scalp-attached tapered crown lock";
  if (endpoint_hair_tip_5_27) {
    mesh_hair_tip_5_27.position.copy(endpoint_hair_tip_5_27.midpoint);
    mesh_hair_tip_5_27.quaternion.copy(endpoint_hair_tip_5_27.quaternion);
  }
  mesh_hair_tip_5_27.castShadow = options.castShadow ?? true;
  mesh_hair_tip_5_27.receiveShadow = options.receiveShadow ?? true;
  mesh_hair_tip_5_27.userData.sculptComponent = {"id": "hair-tip-5", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.036448595898696194, 0.07, 0.09257192878314756], "rx": 0.011, "rz": 0.007}, {"position": [-0.0381850776753655, 0.122, 0.10045039080724522], "rx": 0.008, "rz": 0.005}, {"position": [-0.04009520762970173, 0.155, 0.1102984683373673], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0175, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-5-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.2777777777777778, "v": 0.35}}};
  node_hair_tip_5_27.add(mesh_hair_tip_5_27);
  meshes["hair-tip-5"] = mesh_hair_tip_5_27;
  colliders["hair-tip-5"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hair-tip-5"] ??= [];
  destructionGroups["hair-tip-5"].push(node_hair_tip_5_27);

  const endpoint_hair_tip_6_28 = makeAttachmentEndpoint(null);
  const node_hair_tip_6_28 = new THREE.Group();
  node_hair_tip_6_28.name = "Scalp-attached tapered crown lock__pivot";
  node_hair_tip_6_28.scale.set(1, 1, 1);
  if (endpoint_hair_tip_6_28) {
    node_hair_tip_6_28.position.copy(endpoint_hair_tip_6_28.start);
    node_hair_tip_6_28.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hair_tip_6_28.position.set(0.0175, 0.0, 0.0);
    node_hair_tip_6_28.rotation.set(0.0, 0.0, 0.0);
  }
  node_hair_tip_6_28.userData.sculptComponent = {"id": "hair-tip-6", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.07299999999999998, 0.07, 0.08140638795573724], "rx": 0.011, "rz": 0.007}, {"position": [-0.07799999999999997, 0.112, 0.08833459118601274], "rx": 0.008, "rz": 0.005}, {"position": [-0.08349999999999998, 0.143, 0.09699484522385714], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0175, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-6", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-6-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.3333333333333333, "v": 0.35}}};
  node_hair_tip_6_28.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-6", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}};
  (nodes["head"] ?? root).add(node_hair_tip_6_28);
  nodes["hair-tip-6"] = node_hair_tip_6_28;
  const mesh_hair_tip_6_28Geometry = endpoint_hair_tip_6_28
    ? new THREE.CylinderGeometry(endpoint_hair_tip_6_28.endRadius, endpoint_hair_tip_6_28.baseRadius, endpoint_hair_tip_6_28.length, 32, 12)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.07299999999999998, 0.07, 0.08140638795573724], "rx": 0.011, "rz": 0.007}, {"position": [-0.07799999999999997, 0.112, 0.08833459118601274], "rx": 0.008, "rz": 0.005}, {"position": [-0.08349999999999998, 0.143, 0.09699484522385714], "rx": 0, "rz": 0}], "radialSegments": 6});
  if (!endpoint_hair_tip_6_28) {
    mesh_hair_tip_6_28Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hair_tip_6_28 = new THREE.Mesh(
    mesh_hair_tip_6_28Geometry,
    materialMap["hair"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hair_tip_6_28.name = "Scalp-attached tapered crown lock";
  if (endpoint_hair_tip_6_28) {
    mesh_hair_tip_6_28.position.copy(endpoint_hair_tip_6_28.midpoint);
    mesh_hair_tip_6_28.quaternion.copy(endpoint_hair_tip_6_28.quaternion);
  }
  mesh_hair_tip_6_28.castShadow = options.castShadow ?? true;
  mesh_hair_tip_6_28.receiveShadow = options.receiveShadow ?? true;
  mesh_hair_tip_6_28.userData.sculptComponent = {"id": "hair-tip-6", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.07299999999999998, 0.07, 0.08140638795573724], "rx": 0.011, "rz": 0.007}, {"position": [-0.07799999999999997, 0.112, 0.08833459118601274], "rx": 0.008, "rz": 0.005}, {"position": [-0.08349999999999998, 0.143, 0.09699484522385714], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0175, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-6", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-6-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.3333333333333333, "v": 0.35}}};
  node_hair_tip_6_28.add(mesh_hair_tip_6_28);
  meshes["hair-tip-6"] = mesh_hair_tip_6_28;
  colliders["hair-tip-6"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hair-tip-6"] ??= [];
  destructionGroups["hair-tip-6"].push(node_hair_tip_6_28);

  const endpoint_hair_tip_7_29 = makeAttachmentEndpoint(null);
  const node_hair_tip_7_29 = new THREE.Group();
  node_hair_tip_7_29.name = "Scalp-attached tapered crown lock__pivot";
  node_hair_tip_7_29.scale.set(1, 1, 1);
  if (endpoint_hair_tip_7_29) {
    node_hair_tip_7_29.position.copy(endpoint_hair_tip_7_29.start);
    node_hair_tip_7_29.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hair_tip_7_29.position.set(0.0175, 0.0, 0.0);
    node_hair_tip_7_29.rotation.set(0.0, 0.0, 0.0);
  }
  node_hair_tip_7_29.userData.sculptComponent = {"id": "hair-tip-7", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.10279697762932553, 0.07, 0.06042203531053471], "rx": 0.011, "rz": 0.007}, {"position": [-0.1104574220605153, 0.117, 0.06556433618802703], "rx": 0.008, "rz": 0.005}, {"position": [-0.11888391093482406, 0.149, 0.07199221228489243], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0175, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-7", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-7-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.3888888888888889, "v": 0.35}}};
  node_hair_tip_7_29.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-7", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}};
  (nodes["head"] ?? root).add(node_hair_tip_7_29);
  nodes["hair-tip-7"] = node_hair_tip_7_29;
  const mesh_hair_tip_7_29Geometry = endpoint_hair_tip_7_29
    ? new THREE.CylinderGeometry(endpoint_hair_tip_7_29.endRadius, endpoint_hair_tip_7_29.baseRadius, endpoint_hair_tip_7_29.length, 32, 12)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.10279697762932553, 0.07, 0.06042203531053471], "rx": 0.011, "rz": 0.007}, {"position": [-0.1104574220605153, 0.117, 0.06556433618802703], "rx": 0.008, "rz": 0.005}, {"position": [-0.11888391093482406, 0.149, 0.07199221228489243], "rx": 0, "rz": 0}], "radialSegments": 6});
  if (!endpoint_hair_tip_7_29) {
    mesh_hair_tip_7_29Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hair_tip_7_29 = new THREE.Mesh(
    mesh_hair_tip_7_29Geometry,
    materialMap["hair"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hair_tip_7_29.name = "Scalp-attached tapered crown lock";
  if (endpoint_hair_tip_7_29) {
    mesh_hair_tip_7_29.position.copy(endpoint_hair_tip_7_29.midpoint);
    mesh_hair_tip_7_29.quaternion.copy(endpoint_hair_tip_7_29.quaternion);
  }
  mesh_hair_tip_7_29.castShadow = options.castShadow ?? true;
  mesh_hair_tip_7_29.receiveShadow = options.receiveShadow ?? true;
  mesh_hair_tip_7_29.userData.sculptComponent = {"id": "hair-tip-7", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.10279697762932553, 0.07, 0.06042203531053471], "rx": 0.011, "rz": 0.007}, {"position": [-0.1104574220605153, 0.117, 0.06556433618802703], "rx": 0.008, "rz": 0.005}, {"position": [-0.11888391093482406, 0.149, 0.07199221228489243], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0175, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-7", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-7-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.3888888888888889, "v": 0.35}}};
  node_hair_tip_7_29.add(mesh_hair_tip_7_29);
  meshes["hair-tip-7"] = mesh_hair_tip_7_29;
  colliders["hair-tip-7"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hair-tip-7"] ??= [];
  destructionGroups["hair-tip-7"].push(node_hair_tip_7_29);

  const endpoint_hair_tip_8_30 = makeAttachmentEndpoint(null);
  const node_hair_tip_8_30 = new THREE.Group();
  node_hair_tip_8_30.name = "Scalp-attached tapered crown lock__pivot";
  node_hair_tip_8_30.scale.set(1, 1, 1);
  if (endpoint_hair_tip_8_30) {
    node_hair_tip_8_30.position.copy(endpoint_hair_tip_8_30.start);
    node_hair_tip_8_30.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hair_tip_8_30.position.set(0.0175, 0.0, 0.0);
    node_hair_tip_8_30.rotation.set(0.0, 0.0, 0.0);
  }
  node_hair_tip_8_30.userData.sculptComponent = {"id": "hair-tip-8", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.12224557352802173, 0.07, 0.03214989347261287], "rx": 0.011, "rz": 0.007}, {"position": [-0.13164249973588082, 0.122, 0.034886054619218225], "rx": 0.008, "rz": 0.005}, {"position": [-0.14197911856452583, 0.155, 0.03830625605247492], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0175, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-8", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-8-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.4444444444444444, "v": 0.35}}};
  node_hair_tip_8_30.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-8", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}};
  (nodes["head"] ?? root).add(node_hair_tip_8_30);
  nodes["hair-tip-8"] = node_hair_tip_8_30;
  const mesh_hair_tip_8_30Geometry = endpoint_hair_tip_8_30
    ? new THREE.CylinderGeometry(endpoint_hair_tip_8_30.endRadius, endpoint_hair_tip_8_30.baseRadius, endpoint_hair_tip_8_30.length, 32, 12)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.12224557352802173, 0.07, 0.03214989347261287], "rx": 0.011, "rz": 0.007}, {"position": [-0.13164249973588082, 0.122, 0.034886054619218225], "rx": 0.008, "rz": 0.005}, {"position": [-0.14197911856452583, 0.155, 0.03830625605247492], "rx": 0, "rz": 0}], "radialSegments": 6});
  if (!endpoint_hair_tip_8_30) {
    mesh_hair_tip_8_30Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hair_tip_8_30 = new THREE.Mesh(
    mesh_hair_tip_8_30Geometry,
    materialMap["hair"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hair_tip_8_30.name = "Scalp-attached tapered crown lock";
  if (endpoint_hair_tip_8_30) {
    mesh_hair_tip_8_30.position.copy(endpoint_hair_tip_8_30.midpoint);
    mesh_hair_tip_8_30.quaternion.copy(endpoint_hair_tip_8_30.quaternion);
  }
  mesh_hair_tip_8_30.castShadow = options.castShadow ?? true;
  mesh_hair_tip_8_30.receiveShadow = options.receiveShadow ?? true;
  mesh_hair_tip_8_30.userData.sculptComponent = {"id": "hair-tip-8", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.12224557352802173, 0.07, 0.03214989347261287], "rx": 0.011, "rz": 0.007}, {"position": [-0.13164249973588082, 0.122, 0.034886054619218225], "rx": 0.008, "rz": 0.005}, {"position": [-0.14197911856452583, 0.155, 0.03830625605247492], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0175, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-8", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-8-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.4444444444444444, "v": 0.35}}};
  node_hair_tip_8_30.add(mesh_hair_tip_8_30);
  meshes["hair-tip-8"] = mesh_hair_tip_8_30;
  colliders["hair-tip-8"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hair-tip-8"] ??= [];
  destructionGroups["hair-tip-8"].push(node_hair_tip_8_30);

  const endpoint_hair_tip_9_31 = makeAttachmentEndpoint(null);
  const node_hair_tip_9_31 = new THREE.Group();
  node_hair_tip_9_31.name = "Scalp-attached tapered crown lock__pivot";
  node_hair_tip_9_31.scale.set(1, 1, 1);
  if (endpoint_hair_tip_9_31) {
    node_hair_tip_9_31.position.copy(endpoint_hair_tip_9_31.start);
    node_hair_tip_9_31.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hair_tip_9_31.position.set(0.0175, 0.0, 0.0);
    node_hair_tip_9_31.rotation.set(0.0, 0.0, 0.0);
  }
  node_hair_tip_9_31.userData.sculptComponent = {"id": "hair-tip-9", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.129, 0.07, 1.1511679911985121e-17], "rx": 0.011, "rz": 0.007}, {"position": [-0.139, 0.112, 1.2491397351303001e-17], "rx": 0.008, "rz": 0.005}, {"position": [-0.15000000000000002, 0.143, 1.3716044150450356e-17], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0175, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-9", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-9-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.5, "v": 0.35}}};
  node_hair_tip_9_31.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-9", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}};
  (nodes["head"] ?? root).add(node_hair_tip_9_31);
  nodes["hair-tip-9"] = node_hair_tip_9_31;
  const mesh_hair_tip_9_31Geometry = endpoint_hair_tip_9_31
    ? new THREE.CylinderGeometry(endpoint_hair_tip_9_31.endRadius, endpoint_hair_tip_9_31.baseRadius, endpoint_hair_tip_9_31.length, 32, 12)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.129, 0.07, 1.1511679911985121e-17], "rx": 0.011, "rz": 0.007}, {"position": [-0.139, 0.112, 1.2491397351303001e-17], "rx": 0.008, "rz": 0.005}, {"position": [-0.15000000000000002, 0.143, 1.3716044150450356e-17], "rx": 0, "rz": 0}], "radialSegments": 6});
  if (!endpoint_hair_tip_9_31) {
    mesh_hair_tip_9_31Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hair_tip_9_31 = new THREE.Mesh(
    mesh_hair_tip_9_31Geometry,
    materialMap["hair"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hair_tip_9_31.name = "Scalp-attached tapered crown lock";
  if (endpoint_hair_tip_9_31) {
    mesh_hair_tip_9_31.position.copy(endpoint_hair_tip_9_31.midpoint);
    mesh_hair_tip_9_31.quaternion.copy(endpoint_hair_tip_9_31.quaternion);
  }
  mesh_hair_tip_9_31.castShadow = options.castShadow ?? true;
  mesh_hair_tip_9_31.receiveShadow = options.receiveShadow ?? true;
  mesh_hair_tip_9_31.userData.sculptComponent = {"id": "hair-tip-9", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.129, 0.07, 1.1511679911985121e-17], "rx": 0.011, "rz": 0.007}, {"position": [-0.139, 0.112, 1.2491397351303001e-17], "rx": 0.008, "rz": 0.005}, {"position": [-0.15000000000000002, 0.143, 1.3716044150450356e-17], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0175, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-9", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-9-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.5, "v": 0.35}}};
  node_hair_tip_9_31.add(mesh_hair_tip_9_31);
  meshes["hair-tip-9"] = mesh_hair_tip_9_31;
  colliders["hair-tip-9"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hair-tip-9"] ??= [];
  destructionGroups["hair-tip-9"].push(node_hair_tip_9_31);

  const endpoint_hair_tip_10_32 = makeAttachmentEndpoint(null);
  const node_hair_tip_10_32 = new THREE.Group();
  node_hair_tip_10_32.name = "Scalp-attached tapered crown lock__pivot";
  node_hair_tip_10_32.scale.set(1, 1, 1);
  if (endpoint_hair_tip_10_32) {
    node_hair_tip_10_32.position.copy(endpoint_hair_tip_10_32.start);
    node_hair_tip_10_32.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hair_tip_10_32.position.set(0.0175, 0.0, 0.0);
    node_hair_tip_10_32.rotation.set(0.0, 0.0, 0.0);
  }
  node_hair_tip_10_32.userData.sculptComponent = {"id": "hair-tip-10", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.12224557352802175, 0.07, -0.03214989347261285], "rx": 0.011, "rz": 0.007}, {"position": [-0.13164249973588082, 0.117, -0.034886054619218204], "rx": 0.008, "rz": 0.005}, {"position": [-0.14197911856452583, 0.149, -0.03830625605247489], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0175, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-10", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-10-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.5555555555555556, "v": 0.35}}};
  node_hair_tip_10_32.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-10", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}};
  (nodes["head"] ?? root).add(node_hair_tip_10_32);
  nodes["hair-tip-10"] = node_hair_tip_10_32;
  const mesh_hair_tip_10_32Geometry = endpoint_hair_tip_10_32
    ? new THREE.CylinderGeometry(endpoint_hair_tip_10_32.endRadius, endpoint_hair_tip_10_32.baseRadius, endpoint_hair_tip_10_32.length, 32, 12)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.12224557352802175, 0.07, -0.03214989347261285], "rx": 0.011, "rz": 0.007}, {"position": [-0.13164249973588082, 0.117, -0.034886054619218204], "rx": 0.008, "rz": 0.005}, {"position": [-0.14197911856452583, 0.149, -0.03830625605247489], "rx": 0, "rz": 0}], "radialSegments": 6});
  if (!endpoint_hair_tip_10_32) {
    mesh_hair_tip_10_32Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hair_tip_10_32 = new THREE.Mesh(
    mesh_hair_tip_10_32Geometry,
    materialMap["hair"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hair_tip_10_32.name = "Scalp-attached tapered crown lock";
  if (endpoint_hair_tip_10_32) {
    mesh_hair_tip_10_32.position.copy(endpoint_hair_tip_10_32.midpoint);
    mesh_hair_tip_10_32.quaternion.copy(endpoint_hair_tip_10_32.quaternion);
  }
  mesh_hair_tip_10_32.castShadow = options.castShadow ?? true;
  mesh_hair_tip_10_32.receiveShadow = options.receiveShadow ?? true;
  mesh_hair_tip_10_32.userData.sculptComponent = {"id": "hair-tip-10", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.12224557352802175, 0.07, -0.03214989347261285], "rx": 0.011, "rz": 0.007}, {"position": [-0.13164249973588082, 0.117, -0.034886054619218204], "rx": 0.008, "rz": 0.005}, {"position": [-0.14197911856452583, 0.149, -0.03830625605247489], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0175, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-10", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-10-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.5555555555555556, "v": 0.35}}};
  node_hair_tip_10_32.add(mesh_hair_tip_10_32);
  meshes["hair-tip-10"] = mesh_hair_tip_10_32;
  colliders["hair-tip-10"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hair-tip-10"] ??= [];
  destructionGroups["hair-tip-10"].push(node_hair_tip_10_32);

  const endpoint_hair_tip_11_33 = makeAttachmentEndpoint(null);
  const node_hair_tip_11_33 = new THREE.Group();
  node_hair_tip_11_33.name = "Scalp-attached tapered crown lock__pivot";
  node_hair_tip_11_33.scale.set(1, 1, 1);
  if (endpoint_hair_tip_11_33) {
    node_hair_tip_11_33.position.copy(endpoint_hair_tip_11_33.start);
    node_hair_tip_11_33.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hair_tip_11_33.position.set(0.0175, 0.0, 0.0);
    node_hair_tip_11_33.rotation.set(0.0, 0.0, 0.0);
  }
  node_hair_tip_11_33.userData.sculptComponent = {"id": "hair-tip-11", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.10279697762932558, 0.07, -0.06042203531053466], "rx": 0.011, "rz": 0.007}, {"position": [-0.11045742206051536, 0.122, -0.06556433618802697], "rx": 0.008, "rz": 0.005}, {"position": [-0.11888391093482413, 0.155, -0.07199221228489236], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0175, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-11", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-11-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.6111111111111112, "v": 0.35}}};
  node_hair_tip_11_33.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-11", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}};
  (nodes["head"] ?? root).add(node_hair_tip_11_33);
  nodes["hair-tip-11"] = node_hair_tip_11_33;
  const mesh_hair_tip_11_33Geometry = endpoint_hair_tip_11_33
    ? new THREE.CylinderGeometry(endpoint_hair_tip_11_33.endRadius, endpoint_hair_tip_11_33.baseRadius, endpoint_hair_tip_11_33.length, 32, 12)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.10279697762932558, 0.07, -0.06042203531053466], "rx": 0.011, "rz": 0.007}, {"position": [-0.11045742206051536, 0.122, -0.06556433618802697], "rx": 0.008, "rz": 0.005}, {"position": [-0.11888391093482413, 0.155, -0.07199221228489236], "rx": 0, "rz": 0}], "radialSegments": 6});
  if (!endpoint_hair_tip_11_33) {
    mesh_hair_tip_11_33Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hair_tip_11_33 = new THREE.Mesh(
    mesh_hair_tip_11_33Geometry,
    materialMap["hair"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hair_tip_11_33.name = "Scalp-attached tapered crown lock";
  if (endpoint_hair_tip_11_33) {
    mesh_hair_tip_11_33.position.copy(endpoint_hair_tip_11_33.midpoint);
    mesh_hair_tip_11_33.quaternion.copy(endpoint_hair_tip_11_33.quaternion);
  }
  mesh_hair_tip_11_33.castShadow = options.castShadow ?? true;
  mesh_hair_tip_11_33.receiveShadow = options.receiveShadow ?? true;
  mesh_hair_tip_11_33.userData.sculptComponent = {"id": "hair-tip-11", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.10279697762932558, 0.07, -0.06042203531053466], "rx": 0.011, "rz": 0.007}, {"position": [-0.11045742206051536, 0.122, -0.06556433618802697], "rx": 0.008, "rz": 0.005}, {"position": [-0.11888391093482413, 0.155, -0.07199221228489236], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0175, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-11", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-11-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.6111111111111112, "v": 0.35}}};
  node_hair_tip_11_33.add(mesh_hair_tip_11_33);
  meshes["hair-tip-11"] = mesh_hair_tip_11_33;
  colliders["hair-tip-11"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hair-tip-11"] ??= [];
  destructionGroups["hair-tip-11"].push(node_hair_tip_11_33);

  const endpoint_hair_tip_12_34 = makeAttachmentEndpoint(null);
  const node_hair_tip_12_34 = new THREE.Group();
  node_hair_tip_12_34.name = "Scalp-attached tapered crown lock__pivot";
  node_hair_tip_12_34.scale.set(1, 1, 1);
  if (endpoint_hair_tip_12_34) {
    node_hair_tip_12_34.position.copy(endpoint_hair_tip_12_34.start);
    node_hair_tip_12_34.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hair_tip_12_34.position.set(0.0175, 0.0, 0.0);
    node_hair_tip_12_34.rotation.set(0.0, 0.0, 0.0);
  }
  node_hair_tip_12_34.userData.sculptComponent = {"id": "hair-tip-12", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.07300000000000005, 0.07, -0.08140638795573721], "rx": 0.011, "rz": 0.007}, {"position": [-0.07800000000000006, 0.112, -0.08833459118601271], "rx": 0.008, "rz": 0.005}, {"position": [-0.08350000000000006, 0.143, -0.0969948452238571], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0175, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-12", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-12-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.6666666666666666, "v": 0.35}}};
  node_hair_tip_12_34.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-12", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}};
  (nodes["head"] ?? root).add(node_hair_tip_12_34);
  nodes["hair-tip-12"] = node_hair_tip_12_34;
  const mesh_hair_tip_12_34Geometry = endpoint_hair_tip_12_34
    ? new THREE.CylinderGeometry(endpoint_hair_tip_12_34.endRadius, endpoint_hair_tip_12_34.baseRadius, endpoint_hair_tip_12_34.length, 32, 12)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.07300000000000005, 0.07, -0.08140638795573721], "rx": 0.011, "rz": 0.007}, {"position": [-0.07800000000000006, 0.112, -0.08833459118601271], "rx": 0.008, "rz": 0.005}, {"position": [-0.08350000000000006, 0.143, -0.0969948452238571], "rx": 0, "rz": 0}], "radialSegments": 6});
  if (!endpoint_hair_tip_12_34) {
    mesh_hair_tip_12_34Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hair_tip_12_34 = new THREE.Mesh(
    mesh_hair_tip_12_34Geometry,
    materialMap["hair"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hair_tip_12_34.name = "Scalp-attached tapered crown lock";
  if (endpoint_hair_tip_12_34) {
    mesh_hair_tip_12_34.position.copy(endpoint_hair_tip_12_34.midpoint);
    mesh_hair_tip_12_34.quaternion.copy(endpoint_hair_tip_12_34.quaternion);
  }
  mesh_hair_tip_12_34.castShadow = options.castShadow ?? true;
  mesh_hair_tip_12_34.receiveShadow = options.receiveShadow ?? true;
  mesh_hair_tip_12_34.userData.sculptComponent = {"id": "hair-tip-12", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.07300000000000005, 0.07, -0.08140638795573721], "rx": 0.011, "rz": 0.007}, {"position": [-0.07800000000000006, 0.112, -0.08833459118601271], "rx": 0.008, "rz": 0.005}, {"position": [-0.08350000000000006, 0.143, -0.0969948452238571], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0175, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-12", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-12-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.6666666666666666, "v": 0.35}}};
  node_hair_tip_12_34.add(mesh_hair_tip_12_34);
  meshes["hair-tip-12"] = mesh_hair_tip_12_34;
  colliders["hair-tip-12"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hair-tip-12"] ??= [];
  destructionGroups["hair-tip-12"].push(node_hair_tip_12_34);

  const endpoint_hair_tip_13_35 = makeAttachmentEndpoint(null);
  const node_hair_tip_13_35 = new THREE.Group();
  node_hair_tip_13_35.name = "Scalp-attached tapered crown lock__pivot";
  node_hair_tip_13_35.scale.set(1, 1, 1);
  if (endpoint_hair_tip_13_35) {
    node_hair_tip_13_35.position.copy(endpoint_hair_tip_13_35.start);
    node_hair_tip_13_35.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hair_tip_13_35.position.set(0.0175, 0.0, 0.0);
    node_hair_tip_13_35.rotation.set(0.0, 0.0, 0.0);
  }
  node_hair_tip_13_35.userData.sculptComponent = {"id": "hair-tip-13", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.0364485958986962, 0.07, -0.09257192878314756], "rx": 0.011, "rz": 0.007}, {"position": [-0.0381850776753655, 0.117, -0.10045039080724522], "rx": 0.008, "rz": 0.005}, {"position": [-0.040095207629701736, 0.149, -0.1102984683373673], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0175, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-13", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-13-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.7222222222222222, "v": 0.35}}};
  node_hair_tip_13_35.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-13", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}};
  (nodes["head"] ?? root).add(node_hair_tip_13_35);
  nodes["hair-tip-13"] = node_hair_tip_13_35;
  const mesh_hair_tip_13_35Geometry = endpoint_hair_tip_13_35
    ? new THREE.CylinderGeometry(endpoint_hair_tip_13_35.endRadius, endpoint_hair_tip_13_35.baseRadius, endpoint_hair_tip_13_35.length, 32, 12)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.0364485958986962, 0.07, -0.09257192878314756], "rx": 0.011, "rz": 0.007}, {"position": [-0.0381850776753655, 0.117, -0.10045039080724522], "rx": 0.008, "rz": 0.005}, {"position": [-0.040095207629701736, 0.149, -0.1102984683373673], "rx": 0, "rz": 0}], "radialSegments": 6});
  if (!endpoint_hair_tip_13_35) {
    mesh_hair_tip_13_35Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hair_tip_13_35 = new THREE.Mesh(
    mesh_hair_tip_13_35Geometry,
    materialMap["hair"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hair_tip_13_35.name = "Scalp-attached tapered crown lock";
  if (endpoint_hair_tip_13_35) {
    mesh_hair_tip_13_35.position.copy(endpoint_hair_tip_13_35.midpoint);
    mesh_hair_tip_13_35.quaternion.copy(endpoint_hair_tip_13_35.quaternion);
  }
  mesh_hair_tip_13_35.castShadow = options.castShadow ?? true;
  mesh_hair_tip_13_35.receiveShadow = options.receiveShadow ?? true;
  mesh_hair_tip_13_35.userData.sculptComponent = {"id": "hair-tip-13", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [-0.0364485958986962, 0.07, -0.09257192878314756], "rx": 0.011, "rz": 0.007}, {"position": [-0.0381850776753655, 0.117, -0.10045039080724522], "rx": 0.008, "rz": 0.005}, {"position": [-0.040095207629701736, 0.149, -0.1102984683373673], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0175, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-13", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-13-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.7222222222222222, "v": 0.35}}};
  node_hair_tip_13_35.add(mesh_hair_tip_13_35);
  meshes["hair-tip-13"] = mesh_hair_tip_13_35;
  colliders["hair-tip-13"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hair-tip-13"] ??= [];
  destructionGroups["hair-tip-13"].push(node_hair_tip_13_35);

  const endpoint_hair_tip_14_36 = makeAttachmentEndpoint(null);
  const node_hair_tip_14_36 = new THREE.Group();
  node_hair_tip_14_36.name = "Scalp-attached tapered crown lock__pivot";
  node_hair_tip_14_36.scale.set(1, 1, 1);
  if (endpoint_hair_tip_14_36) {
    node_hair_tip_14_36.position.copy(endpoint_hair_tip_14_36.start);
    node_hair_tip_14_36.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hair_tip_14_36.position.set(0.0175, 0.0, 0.0);
    node_hair_tip_14_36.rotation.set(0.0, 0.0, 0.0);
  }
  node_hair_tip_14_36.userData.sculptComponent = {"id": "hair-tip-14", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.002448595898696157, 0.07, -0.09257192878314756], "rx": 0.011, "rz": 0.007}, {"position": [0.004185077675365453, 0.122, -0.10045039080724523], "rx": 0.008, "rz": 0.005}, {"position": [0.006095207629701685, 0.155, -0.11029846833736731], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0175, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-14", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-14-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.7777777777777778, "v": 0.35}}};
  node_hair_tip_14_36.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-14", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}};
  (nodes["head"] ?? root).add(node_hair_tip_14_36);
  nodes["hair-tip-14"] = node_hair_tip_14_36;
  const mesh_hair_tip_14_36Geometry = endpoint_hair_tip_14_36
    ? new THREE.CylinderGeometry(endpoint_hair_tip_14_36.endRadius, endpoint_hair_tip_14_36.baseRadius, endpoint_hair_tip_14_36.length, 32, 12)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.002448595898696157, 0.07, -0.09257192878314756], "rx": 0.011, "rz": 0.007}, {"position": [0.004185077675365453, 0.122, -0.10045039080724523], "rx": 0.008, "rz": 0.005}, {"position": [0.006095207629701685, 0.155, -0.11029846833736731], "rx": 0, "rz": 0}], "radialSegments": 6});
  if (!endpoint_hair_tip_14_36) {
    mesh_hair_tip_14_36Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hair_tip_14_36 = new THREE.Mesh(
    mesh_hair_tip_14_36Geometry,
    materialMap["hair"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hair_tip_14_36.name = "Scalp-attached tapered crown lock";
  if (endpoint_hair_tip_14_36) {
    mesh_hair_tip_14_36.position.copy(endpoint_hair_tip_14_36.midpoint);
    mesh_hair_tip_14_36.quaternion.copy(endpoint_hair_tip_14_36.quaternion);
  }
  mesh_hair_tip_14_36.castShadow = options.castShadow ?? true;
  mesh_hair_tip_14_36.receiveShadow = options.receiveShadow ?? true;
  mesh_hair_tip_14_36.userData.sculptComponent = {"id": "hair-tip-14", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.002448595898696157, 0.07, -0.09257192878314756], "rx": 0.011, "rz": 0.007}, {"position": [0.004185077675365453, 0.122, -0.10045039080724523], "rx": 0.008, "rz": 0.005}, {"position": [0.006095207629701685, 0.155, -0.11029846833736731], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0175, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-14", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-14-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.7777777777777778, "v": 0.35}}};
  node_hair_tip_14_36.add(mesh_hair_tip_14_36);
  meshes["hair-tip-14"] = mesh_hair_tip_14_36;
  colliders["hair-tip-14"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hair-tip-14"] ??= [];
  destructionGroups["hair-tip-14"].push(node_hair_tip_14_36);

  const endpoint_hair_tip_15_37 = makeAttachmentEndpoint(null);
  const node_hair_tip_15_37 = new THREE.Group();
  node_hair_tip_15_37.name = "Scalp-attached tapered crown lock__pivot";
  node_hair_tip_15_37.scale.set(1, 1, 1);
  if (endpoint_hair_tip_15_37) {
    node_hair_tip_15_37.position.copy(endpoint_hair_tip_15_37.start);
    node_hair_tip_15_37.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hair_tip_15_37.position.set(0.0175, 0.0, 0.0);
    node_hair_tip_15_37.rotation.set(0.0, 0.0, 0.0);
  }
  node_hair_tip_15_37.userData.sculptComponent = {"id": "hair-tip-15", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.038999999999999924, 0.07, -0.08140638795573726], "rx": 0.011, "rz": 0.007}, {"position": [0.043999999999999914, 0.112, -0.08833459118601278], "rx": 0.008, "rz": 0.005}, {"position": [0.04949999999999992, 0.143, -0.09699484522385718], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0175, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-15", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-15-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.8333333333333334, "v": 0.35}}};
  node_hair_tip_15_37.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-15", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}};
  (nodes["head"] ?? root).add(node_hair_tip_15_37);
  nodes["hair-tip-15"] = node_hair_tip_15_37;
  const mesh_hair_tip_15_37Geometry = endpoint_hair_tip_15_37
    ? new THREE.CylinderGeometry(endpoint_hair_tip_15_37.endRadius, endpoint_hair_tip_15_37.baseRadius, endpoint_hair_tip_15_37.length, 32, 12)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.038999999999999924, 0.07, -0.08140638795573726], "rx": 0.011, "rz": 0.007}, {"position": [0.043999999999999914, 0.112, -0.08833459118601278], "rx": 0.008, "rz": 0.005}, {"position": [0.04949999999999992, 0.143, -0.09699484522385718], "rx": 0, "rz": 0}], "radialSegments": 6});
  if (!endpoint_hair_tip_15_37) {
    mesh_hair_tip_15_37Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hair_tip_15_37 = new THREE.Mesh(
    mesh_hair_tip_15_37Geometry,
    materialMap["hair"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hair_tip_15_37.name = "Scalp-attached tapered crown lock";
  if (endpoint_hair_tip_15_37) {
    mesh_hair_tip_15_37.position.copy(endpoint_hair_tip_15_37.midpoint);
    mesh_hair_tip_15_37.quaternion.copy(endpoint_hair_tip_15_37.quaternion);
  }
  mesh_hair_tip_15_37.castShadow = options.castShadow ?? true;
  mesh_hair_tip_15_37.receiveShadow = options.receiveShadow ?? true;
  mesh_hair_tip_15_37.userData.sculptComponent = {"id": "hair-tip-15", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.038999999999999924, 0.07, -0.08140638795573726], "rx": 0.011, "rz": 0.007}, {"position": [0.043999999999999914, 0.112, -0.08833459118601278], "rx": 0.008, "rz": 0.005}, {"position": [0.04949999999999992, 0.143, -0.09699484522385718], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0175, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-15", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-15-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.8333333333333334, "v": 0.35}}};
  node_hair_tip_15_37.add(mesh_hair_tip_15_37);
  meshes["hair-tip-15"] = mesh_hair_tip_15_37;
  colliders["hair-tip-15"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hair-tip-15"] ??= [];
  destructionGroups["hair-tip-15"].push(node_hair_tip_15_37);

  const endpoint_hair_tip_16_38 = makeAttachmentEndpoint(null);
  const node_hair_tip_16_38 = new THREE.Group();
  node_hair_tip_16_38.name = "Scalp-attached tapered crown lock__pivot";
  node_hair_tip_16_38.scale.set(1, 1, 1);
  if (endpoint_hair_tip_16_38) {
    node_hair_tip_16_38.position.copy(endpoint_hair_tip_16_38.start);
    node_hair_tip_16_38.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hair_tip_16_38.position.set(0.0175, 0.0, 0.0);
    node_hair_tip_16_38.rotation.set(0.0, 0.0, 0.0);
  }
  node_hair_tip_16_38.userData.sculptComponent = {"id": "hair-tip-16", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.06879697762932552, 0.07, -0.06042203531053472], "rx": 0.011, "rz": 0.007}, {"position": [0.07645742206051528, 0.117, -0.06556433618802704], "rx": 0.008, "rz": 0.005}, {"position": [0.08488391093482404, 0.149, -0.07199221228489243], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0175, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-16", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-16-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.8888888888888888, "v": 0.35}}};
  node_hair_tip_16_38.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-16", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}};
  (nodes["head"] ?? root).add(node_hair_tip_16_38);
  nodes["hair-tip-16"] = node_hair_tip_16_38;
  const mesh_hair_tip_16_38Geometry = endpoint_hair_tip_16_38
    ? new THREE.CylinderGeometry(endpoint_hair_tip_16_38.endRadius, endpoint_hair_tip_16_38.baseRadius, endpoint_hair_tip_16_38.length, 32, 12)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.06879697762932552, 0.07, -0.06042203531053472], "rx": 0.011, "rz": 0.007}, {"position": [0.07645742206051528, 0.117, -0.06556433618802704], "rx": 0.008, "rz": 0.005}, {"position": [0.08488391093482404, 0.149, -0.07199221228489243], "rx": 0, "rz": 0}], "radialSegments": 6});
  if (!endpoint_hair_tip_16_38) {
    mesh_hair_tip_16_38Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hair_tip_16_38 = new THREE.Mesh(
    mesh_hair_tip_16_38Geometry,
    materialMap["hair"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hair_tip_16_38.name = "Scalp-attached tapered crown lock";
  if (endpoint_hair_tip_16_38) {
    mesh_hair_tip_16_38.position.copy(endpoint_hair_tip_16_38.midpoint);
    mesh_hair_tip_16_38.quaternion.copy(endpoint_hair_tip_16_38.quaternion);
  }
  mesh_hair_tip_16_38.castShadow = options.castShadow ?? true;
  mesh_hair_tip_16_38.receiveShadow = options.receiveShadow ?? true;
  mesh_hair_tip_16_38.userData.sculptComponent = {"id": "hair-tip-16", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.06879697762932552, 0.07, -0.06042203531053472], "rx": 0.011, "rz": 0.007}, {"position": [0.07645742206051528, 0.117, -0.06556433618802704], "rx": 0.008, "rz": 0.005}, {"position": [0.08488391093482404, 0.149, -0.07199221228489243], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0175, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-16", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-16-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.8888888888888888, "v": 0.35}}};
  node_hair_tip_16_38.add(mesh_hair_tip_16_38);
  meshes["hair-tip-16"] = mesh_hair_tip_16_38;
  colliders["hair-tip-16"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hair-tip-16"] ??= [];
  destructionGroups["hair-tip-16"].push(node_hair_tip_16_38);

  const endpoint_hair_tip_17_39 = makeAttachmentEndpoint(null);
  const node_hair_tip_17_39 = new THREE.Group();
  node_hair_tip_17_39.name = "Scalp-attached tapered crown lock__pivot";
  node_hair_tip_17_39.scale.set(1, 1, 1);
  if (endpoint_hair_tip_17_39) {
    node_hair_tip_17_39.position.copy(endpoint_hair_tip_17_39.start);
    node_hair_tip_17_39.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hair_tip_17_39.position.set(0.0175, 0.0, 0.0);
    node_hair_tip_17_39.rotation.set(0.0, 0.0, 0.0);
  }
  node_hair_tip_17_39.userData.sculptComponent = {"id": "hair-tip-17", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.08824557352802175, 0.07, -0.03214989347261285], "rx": 0.011, "rz": 0.007}, {"position": [0.09764249973588082, 0.122, -0.0348860546192182], "rx": 0.008, "rz": 0.005}, {"position": [0.10797911856452583, 0.155, -0.03830625605247488], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0175, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-17", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-17-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.9444444444444444, "v": 0.35}}};
  node_hair_tip_17_39.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-17", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}};
  (nodes["head"] ?? root).add(node_hair_tip_17_39);
  nodes["hair-tip-17"] = node_hair_tip_17_39;
  const mesh_hair_tip_17_39Geometry = endpoint_hair_tip_17_39
    ? new THREE.CylinderGeometry(endpoint_hair_tip_17_39.endRadius, endpoint_hair_tip_17_39.baseRadius, endpoint_hair_tip_17_39.length, 32, 12)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.08824557352802175, 0.07, -0.03214989347261285], "rx": 0.011, "rz": 0.007}, {"position": [0.09764249973588082, 0.122, -0.0348860546192182], "rx": 0.008, "rz": 0.005}, {"position": [0.10797911856452583, 0.155, -0.03830625605247488], "rx": 0, "rz": 0}], "radialSegments": 6});
  if (!endpoint_hair_tip_17_39) {
    mesh_hair_tip_17_39Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hair_tip_17_39 = new THREE.Mesh(
    mesh_hair_tip_17_39Geometry,
    materialMap["hair"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hair_tip_17_39.name = "Scalp-attached tapered crown lock";
  if (endpoint_hair_tip_17_39) {
    mesh_hair_tip_17_39.position.copy(endpoint_hair_tip_17_39.midpoint);
    mesh_hair_tip_17_39.quaternion.copy(endpoint_hair_tip_17_39.quaternion);
  }
  mesh_hair_tip_17_39.castShadow = options.castShadow ?? true;
  mesh_hair_tip_17_39.receiveShadow = options.receiveShadow ?? true;
  mesh_hair_tip_17_39.userData.sculptComponent = {"id": "hair-tip-17", "name": "Scalp-attached tapered crown lock", "level": "micro", "role": "hair", "importance": 0.9, "confidence": 0.8, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Scalp-attached tapered crown lock follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "taperedSweep": {"stations": [{"position": [0.08824557352802175, 0.07, -0.03214989347261285], "rx": 0.011, "rz": 0.007}, {"position": [0.09764249973588082, 0.122, -0.0348860546192182], "rx": 0.008, "rz": 0.005}, {"position": [0.10797911856452583, 0.155, -0.03830625605247488], "rx": 0, "rz": 0}], "radialSegments": 6}}, "parent": "head", "attachment": null, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0175, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hair-tip-17", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hair"}}, "material": "hair", "materialLayers": ["hair"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hair-tip-17-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(123, 194, 141, 1)", "secondaryAlbedo": "rgba(111, 175, 127, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}, "standProud": {"againstComponentId": "head", "clearance": 0.003, "maxPush": 0.012}, "hairProfile": {"representationTier": "shell", "rootBinding": {"type": "scalp-uv", "u": 0.9444444444444444, "v": 0.35}}};
  node_hair_tip_17_39.add(mesh_hair_tip_17_39);
  meshes["hair-tip-17"] = mesh_hair_tip_17_39;
  colliders["hair-tip-17"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hair-tip-17"] ??= [];
  destructionGroups["hair-tip-17"].push(node_hair_tip_17_39);

  const endpoint_eye_r_40 = makeAttachmentEndpoint(null);
  const node_eye_r_40 = new THREE.Group();
  node_eye_r_40.name = "Open right eye__pivot";
  node_eye_r_40.scale.set(1, 1, 1);
  if (endpoint_eye_r_40) {
    node_eye_r_40.position.copy(endpoint_eye_r_40.start);
    node_eye_r_40.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_eye_r_40.position.set(-0.0295, 0.001, 0.084);
    node_eye_r_40.rotation.set(0.0, 0.0, 0.0);
  }
  node_eye_r_40.userData.sculptComponent = {"id": "eye-r", "name": "Open right eye", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Open right eye follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.056, "height": 0.025, "depth": 0.026, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.0295, 0.001, 0.084], "rotation": [0, 0, 0], "scale": [0.056, 0.025, 0.026]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}}, "material": "white", "materialLayers": ["white"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["eye-r-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 234, 222, 1)", "secondaryAlbedo": "rgba(214, 211, 200, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_eye_r_40.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}};
  (nodes["head"] ?? root).add(node_eye_r_40);
  nodes["eye-r"] = node_eye_r_40;
  const mesh_eye_r_40Geometry = endpoint_eye_r_40
    ? new THREE.CylinderGeometry(endpoint_eye_r_40.endRadius, endpoint_eye_r_40.baseRadius, endpoint_eye_r_40.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_eye_r_40) {
    mesh_eye_r_40Geometry.scale(0.056, 0.025, 0.026);
  }
  const mesh_eye_r_40 = new THREE.Mesh(
    mesh_eye_r_40Geometry,
    materialMap["white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_eye_r_40.name = "Open right eye";
  if (endpoint_eye_r_40) {
    mesh_eye_r_40.position.copy(endpoint_eye_r_40.midpoint);
    mesh_eye_r_40.quaternion.copy(endpoint_eye_r_40.quaternion);
  }
  mesh_eye_r_40.castShadow = options.castShadow ?? true;
  mesh_eye_r_40.receiveShadow = options.receiveShadow ?? true;
  mesh_eye_r_40.userData.sculptComponent = {"id": "eye-r", "name": "Open right eye", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Open right eye follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.056, "height": 0.025, "depth": 0.026, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.0295, 0.001, 0.084], "rotation": [0, 0, 0], "scale": [0.056, 0.025, 0.026]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}}, "material": "white", "materialLayers": ["white"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["eye-r-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 234, 222, 1)", "secondaryAlbedo": "rgba(214, 211, 200, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_eye_r_40.add(mesh_eye_r_40);
  meshes["eye-r"] = mesh_eye_r_40;
  colliders["eye-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["eye-r"] ??= [];
  destructionGroups["eye-r"].push(node_eye_r_40);

  const endpoint_iris_r_41 = makeAttachmentEndpoint(null);
  const node_iris_r_41 = new THREE.Group();
  node_iris_r_41.name = "Right iris__pivot";
  node_iris_r_41.scale.set(1, 1, 1);
  if (endpoint_iris_r_41) {
    node_iris_r_41.position.copy(endpoint_iris_r_41.start);
    node_iris_r_41.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_iris_r_41.position.set(-0.027499999999999997, -0.001, 0.1);
    node_iris_r_41.rotation.set(0.0, 0.0, 0.0);
  }
  node_iris_r_41.userData.sculptComponent = {"id": "iris-r", "name": "Right iris", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Right iris follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.014, "height": 0.016, "depth": 0.006, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.027499999999999997, -0.001, 0.1], "rotation": [0, 0, 0], "scale": [0.014, 0.016, 0.006]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "iris-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark"}}, "material": "dark", "materialLayers": ["dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["iris-r-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(32, 35, 44, 1)", "secondaryAlbedo": "rgba(29, 32, 40, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_iris_r_41.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "iris-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark"}};
  (nodes["head"] ?? root).add(node_iris_r_41);
  nodes["iris-r"] = node_iris_r_41;
  const mesh_iris_r_41Geometry = endpoint_iris_r_41
    ? new THREE.CylinderGeometry(endpoint_iris_r_41.endRadius, endpoint_iris_r_41.baseRadius, endpoint_iris_r_41.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_iris_r_41) {
    mesh_iris_r_41Geometry.scale(0.014, 0.016, 0.006);
  }
  const mesh_iris_r_41 = new THREE.Mesh(
    mesh_iris_r_41Geometry,
    materialMap["dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_iris_r_41.name = "Right iris";
  if (endpoint_iris_r_41) {
    mesh_iris_r_41.position.copy(endpoint_iris_r_41.midpoint);
    mesh_iris_r_41.quaternion.copy(endpoint_iris_r_41.quaternion);
  }
  mesh_iris_r_41.castShadow = options.castShadow ?? true;
  mesh_iris_r_41.receiveShadow = options.receiveShadow ?? true;
  mesh_iris_r_41.userData.sculptComponent = {"id": "iris-r", "name": "Right iris", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Right iris follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.014, "height": 0.016, "depth": 0.006, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.027499999999999997, -0.001, 0.1], "rotation": [0, 0, 0], "scale": [0.014, 0.016, 0.006]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "iris-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark"}}, "material": "dark", "materialLayers": ["dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["iris-r-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(32, 35, 44, 1)", "secondaryAlbedo": "rgba(29, 32, 40, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_iris_r_41.add(mesh_iris_r_41);
  meshes["iris-r"] = mesh_iris_r_41;
  colliders["iris-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["iris-r"] ??= [];
  destructionGroups["iris-r"].push(node_iris_r_41);

  const endpoint_teeth_42 = makeAttachmentEndpoint(null);
  const node_teeth_42 = new THREE.Group();
  node_teeth_42.name = "Clenched grin__pivot";
  node_teeth_42.scale.set(1, 1, 1);
  if (endpoint_teeth_42) {
    node_teeth_42.position.copy(endpoint_teeth_42.start);
    node_teeth_42.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_teeth_42.position.set(0.0175, -0.077, 0.082);
    node_teeth_42.rotation.set(0.0, 0.0, 0.0);
  }
  node_teeth_42.userData.sculptComponent = {"id": "teeth", "name": "Clenched grin", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Clenched grin follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.119, "height": 0.032, "depth": 0.018, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0175, -0.077, 0.082], "rotation": [0, 0, 0], "scale": [0.119, 0.032, 0.018]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "teeth", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}}, "material": "white", "materialLayers": ["white"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["teeth-observed-contour", {"id": "grin", "description": "Broad clenched white teeth with curved lower lip", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 234, 222, 1)", "secondaryAlbedo": "rgba(214, 211, 200, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_teeth_42.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "teeth", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}};
  (nodes["head"] ?? root).add(node_teeth_42);
  nodes["teeth"] = node_teeth_42;
  const mesh_teeth_42Geometry = endpoint_teeth_42
    ? new THREE.CylinderGeometry(endpoint_teeth_42.endRadius, endpoint_teeth_42.baseRadius, endpoint_teeth_42.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_teeth_42) {
    mesh_teeth_42Geometry.scale(0.119, 0.032, 0.018);
  }
  const mesh_teeth_42 = new THREE.Mesh(
    mesh_teeth_42Geometry,
    materialMap["white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_teeth_42.name = "Clenched grin";
  if (endpoint_teeth_42) {
    mesh_teeth_42.position.copy(endpoint_teeth_42.midpoint);
    mesh_teeth_42.quaternion.copy(endpoint_teeth_42.quaternion);
  }
  mesh_teeth_42.castShadow = options.castShadow ?? true;
  mesh_teeth_42.receiveShadow = options.receiveShadow ?? true;
  mesh_teeth_42.userData.sculptComponent = {"id": "teeth", "name": "Clenched grin", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Clenched grin follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.119, "height": 0.032, "depth": 0.018, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0175, -0.077, 0.082], "rotation": [0, 0, 0], "scale": [0.119, 0.032, 0.018]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "teeth", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}}, "material": "white", "materialLayers": ["white"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["teeth-observed-contour", {"id": "grin", "description": "Broad clenched white teeth with curved lower lip", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 234, 222, 1)", "secondaryAlbedo": "rgba(214, 211, 200, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_teeth_42.add(mesh_teeth_42);
  meshes["teeth"] = mesh_teeth_42;
  colliders["teeth"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["teeth"] ??= [];
  destructionGroups["teeth"].push(node_teeth_42);

  const endpoint_scar_43 = makeAttachmentEndpoint(null);
  const node_scar_43 = new THREE.Group();
  node_scar_43.name = "Closed left eye scar__pivot";
  node_scar_43.scale.set(1, 1, 1);
  if (endpoint_scar_43) {
    node_scar_43.position.copy(endpoint_scar_43.start);
    node_scar_43.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_scar_43.position.set(0.059500000000000004, 0.007, 0.09);
    node_scar_43.rotation.set(0.0, 0.0, 0.0);
  }
  node_scar_43.userData.sculptComponent = {"id": "scar", "name": "Closed left eye scar", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "Closed left eye scar follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.003, "height": 0.097, "depth": 0.003, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.059500000000000004, 0.007, 0.09], "rotation": [0, 0, 0], "scale": [0.003, 0.097, 0.003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "scar", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scar"}}, "material": "scar", "materialLayers": ["scar"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["scar-observed-contour", {"id": "left-eye-scar", "description": "Closed left eye crossed by a vertical scar", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(134, 85, 65, 1)", "secondaryAlbedo": "rgba(121, 76, 58, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_scar_43.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "scar", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scar"}};
  (nodes["head"] ?? root).add(node_scar_43);
  nodes["scar"] = node_scar_43;
  const mesh_scar_43Geometry = endpoint_scar_43
    ? new THREE.CylinderGeometry(endpoint_scar_43.endRadius, endpoint_scar_43.baseRadius, endpoint_scar_43.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_scar_43) {
    mesh_scar_43Geometry.scale(0.003, 0.097, 0.003);
  }
  const mesh_scar_43 = new THREE.Mesh(
    mesh_scar_43Geometry,
    materialMap["scar"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_scar_43.name = "Closed left eye scar";
  if (endpoint_scar_43) {
    mesh_scar_43.position.copy(endpoint_scar_43.midpoint);
    mesh_scar_43.quaternion.copy(endpoint_scar_43.quaternion);
  }
  mesh_scar_43.castShadow = options.castShadow ?? true;
  mesh_scar_43.receiveShadow = options.receiveShadow ?? true;
  mesh_scar_43.userData.sculptComponent = {"id": "scar", "name": "Closed left eye scar", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "Closed left eye scar follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.003, "height": 0.097, "depth": 0.003, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.059500000000000004, 0.007, 0.09], "rotation": [0, 0, 0], "scale": [0.003, 0.097, 0.003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "scar", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scar"}}, "material": "scar", "materialLayers": ["scar"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["scar-observed-contour", {"id": "left-eye-scar", "description": "Closed left eye crossed by a vertical scar", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(134, 85, 65, 1)", "secondaryAlbedo": "rgba(121, 76, 58, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_scar_43.add(mesh_scar_43);
  meshes["scar"] = mesh_scar_43;
  colliders["scar"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["scar"] ??= [];
  destructionGroups["scar"].push(node_scar_43);

  const endpoint_brow__1_44 = makeAttachmentEndpoint(null);
  const node_brow__1_44 = new THREE.Group();
  node_brow__1_44.name = "Angled brow__pivot";
  node_brow__1_44.scale.set(1, 1, 1);
  if (endpoint_brow__1_44) {
    node_brow__1_44.position.copy(endpoint_brow__1_44.start);
    node_brow__1_44.rotation.set(0.0, 0.0, 0.16);
  } else {
    node_brow__1_44.position.set(-0.0295, 0.026, 0.086);
    node_brow__1_44.rotation.set(0.0, 0.0, 0.16);
  }
  node_brow__1_44.userData.sculptComponent = {"id": "brow--1", "name": "Angled brow", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "Angled brow follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.061, "height": 0.006, "depth": 0.006, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.0295, 0.026, 0.086], "rotation": [0, 0, 0.16], "scale": [0.061, 0.006, 0.006]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "brow--1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark"}}, "material": "dark", "materialLayers": ["dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["brow--1-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(32, 35, 44, 1)", "secondaryAlbedo": "rgba(29, 32, 40, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_brow__1_44.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "brow--1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark"}};
  (nodes["head"] ?? root).add(node_brow__1_44);
  nodes["brow--1"] = node_brow__1_44;
  const mesh_brow__1_44Geometry = endpoint_brow__1_44
    ? new THREE.CylinderGeometry(endpoint_brow__1_44.endRadius, endpoint_brow__1_44.baseRadius, endpoint_brow__1_44.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_brow__1_44) {
    mesh_brow__1_44Geometry.scale(0.061, 0.006, 0.006);
  }
  const mesh_brow__1_44 = new THREE.Mesh(
    mesh_brow__1_44Geometry,
    materialMap["dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_brow__1_44.name = "Angled brow";
  if (endpoint_brow__1_44) {
    mesh_brow__1_44.position.copy(endpoint_brow__1_44.midpoint);
    mesh_brow__1_44.quaternion.copy(endpoint_brow__1_44.quaternion);
  }
  mesh_brow__1_44.castShadow = options.castShadow ?? true;
  mesh_brow__1_44.receiveShadow = options.receiveShadow ?? true;
  mesh_brow__1_44.userData.sculptComponent = {"id": "brow--1", "name": "Angled brow", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "Angled brow follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.061, "height": 0.006, "depth": 0.006, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.0295, 0.026, 0.086], "rotation": [0, 0, 0.16], "scale": [0.061, 0.006, 0.006]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "brow--1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark"}}, "material": "dark", "materialLayers": ["dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["brow--1-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(32, 35, 44, 1)", "secondaryAlbedo": "rgba(29, 32, 40, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_brow__1_44.add(mesh_brow__1_44);
  meshes["brow--1"] = mesh_brow__1_44;
  colliders["brow--1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["brow--1"] ??= [];
  destructionGroups["brow--1"].push(node_brow__1_44);

  const endpoint_ear__1_45 = makeAttachmentEndpoint(null);
  const node_ear__1_45 = new THREE.Group();
  node_ear__1_45.name = "Ear__pivot";
  node_ear__1_45.scale.set(1, 1, 1);
  if (endpoint_ear__1_45) {
    node_ear__1_45.position.copy(endpoint_ear__1_45.start);
    node_ear__1_45.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ear__1_45.position.set(-0.0815, -0.01, -0.001);
    node_ear__1_45.rotation.set(0.0, 0.0, 0.0);
  }
  node_ear__1_45.userData.sculptComponent = {"id": "ear--1", "name": "Ear", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Ear follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.031, "height": 0.061, "depth": 0.036, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.0815, -0.01, -0.001], "rotation": [0, 0, 0], "scale": [0.031, 0.061, 0.036]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ear--1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["ear--1-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_ear__1_45.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ear--1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["head"] ?? root).add(node_ear__1_45);
  nodes["ear--1"] = node_ear__1_45;
  const mesh_ear__1_45Geometry = endpoint_ear__1_45
    ? new THREE.CylinderGeometry(endpoint_ear__1_45.endRadius, endpoint_ear__1_45.baseRadius, endpoint_ear__1_45.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_ear__1_45) {
    mesh_ear__1_45Geometry.scale(0.031, 0.061, 0.036);
  }
  const mesh_ear__1_45 = new THREE.Mesh(
    mesh_ear__1_45Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ear__1_45.name = "Ear";
  if (endpoint_ear__1_45) {
    mesh_ear__1_45.position.copy(endpoint_ear__1_45.midpoint);
    mesh_ear__1_45.quaternion.copy(endpoint_ear__1_45.quaternion);
  }
  mesh_ear__1_45.castShadow = options.castShadow ?? true;
  mesh_ear__1_45.receiveShadow = options.receiveShadow ?? true;
  mesh_ear__1_45.userData.sculptComponent = {"id": "ear--1", "name": "Ear", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Ear follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.031, "height": 0.061, "depth": 0.036, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.0815, -0.01, -0.001], "rotation": [0, 0, 0], "scale": [0.031, 0.061, 0.036]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ear--1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["ear--1-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_ear__1_45.add(mesh_ear__1_45);
  meshes["ear--1"] = mesh_ear__1_45;
  colliders["ear--1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["ear--1"] ??= [];
  destructionGroups["ear--1"].push(node_ear__1_45);

  const endpoint_brow_1_46 = makeAttachmentEndpoint(null);
  const node_brow_1_46 = new THREE.Group();
  node_brow_1_46.name = "Angled brow__pivot";
  node_brow_1_46.scale.set(1, 1, 1);
  if (endpoint_brow_1_46) {
    node_brow_1_46.position.copy(endpoint_brow_1_46.start);
    node_brow_1_46.rotation.set(0.0, 0.0, -0.16);
  } else {
    node_brow_1_46.position.set(0.0645, 0.026, 0.086);
    node_brow_1_46.rotation.set(0.0, 0.0, -0.16);
  }
  node_brow_1_46.userData.sculptComponent = {"id": "brow-1", "name": "Angled brow", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "Angled brow follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.061, "height": 0.006, "depth": 0.006, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0645, 0.026, 0.086], "rotation": [0, 0, -0.16], "scale": [0.061, 0.006, 0.006]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "brow-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark"}}, "material": "dark", "materialLayers": ["dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["brow-1-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(32, 35, 44, 1)", "secondaryAlbedo": "rgba(29, 32, 40, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_brow_1_46.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "brow-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark"}};
  (nodes["head"] ?? root).add(node_brow_1_46);
  nodes["brow-1"] = node_brow_1_46;
  const mesh_brow_1_46Geometry = endpoint_brow_1_46
    ? new THREE.CylinderGeometry(endpoint_brow_1_46.endRadius, endpoint_brow_1_46.baseRadius, endpoint_brow_1_46.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_brow_1_46) {
    mesh_brow_1_46Geometry.scale(0.061, 0.006, 0.006);
  }
  const mesh_brow_1_46 = new THREE.Mesh(
    mesh_brow_1_46Geometry,
    materialMap["dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_brow_1_46.name = "Angled brow";
  if (endpoint_brow_1_46) {
    mesh_brow_1_46.position.copy(endpoint_brow_1_46.midpoint);
    mesh_brow_1_46.quaternion.copy(endpoint_brow_1_46.quaternion);
  }
  mesh_brow_1_46.castShadow = options.castShadow ?? true;
  mesh_brow_1_46.receiveShadow = options.receiveShadow ?? true;
  mesh_brow_1_46.userData.sculptComponent = {"id": "brow-1", "name": "Angled brow", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "Angled brow follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.061, "height": 0.006, "depth": 0.006, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0645, 0.026, 0.086], "rotation": [0, 0, -0.16], "scale": [0.061, 0.006, 0.006]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "brow-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark"}}, "material": "dark", "materialLayers": ["dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["brow-1-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(32, 35, 44, 1)", "secondaryAlbedo": "rgba(29, 32, 40, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_brow_1_46.add(mesh_brow_1_46);
  meshes["brow-1"] = mesh_brow_1_46;
  colliders["brow-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["brow-1"] ??= [];
  destructionGroups["brow-1"].push(node_brow_1_46);

  const endpoint_ear_1_47 = makeAttachmentEndpoint(null);
  const node_ear_1_47 = new THREE.Group();
  node_ear_1_47.name = "Ear__pivot";
  node_ear_1_47.scale.set(1, 1, 1);
  if (endpoint_ear_1_47) {
    node_ear_1_47.position.copy(endpoint_ear_1_47.start);
    node_ear_1_47.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_ear_1_47.position.set(0.1165, -0.01, -0.001);
    node_ear_1_47.rotation.set(0.0, 0.0, 0.0);
  }
  node_ear_1_47.userData.sculptComponent = {"id": "ear-1", "name": "Ear", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Ear follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.031, "height": 0.061, "depth": 0.036, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.1165, -0.01, -0.001], "rotation": [0, 0, 0], "scale": [0.031, 0.061, 0.036]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ear-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["ear-1-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_ear_1_47.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ear-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["head"] ?? root).add(node_ear_1_47);
  nodes["ear-1"] = node_ear_1_47;
  const mesh_ear_1_47Geometry = endpoint_ear_1_47
    ? new THREE.CylinderGeometry(endpoint_ear_1_47.endRadius, endpoint_ear_1_47.baseRadius, endpoint_ear_1_47.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_ear_1_47) {
    mesh_ear_1_47Geometry.scale(0.031, 0.061, 0.036);
  }
  const mesh_ear_1_47 = new THREE.Mesh(
    mesh_ear_1_47Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ear_1_47.name = "Ear";
  if (endpoint_ear_1_47) {
    mesh_ear_1_47.position.copy(endpoint_ear_1_47.midpoint);
    mesh_ear_1_47.quaternion.copy(endpoint_ear_1_47.quaternion);
  }
  mesh_ear_1_47.castShadow = options.castShadow ?? true;
  mesh_ear_1_47.receiveShadow = options.receiveShadow ?? true;
  mesh_ear_1_47.userData.sculptComponent = {"id": "ear-1", "name": "Ear", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Ear follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.031, "height": 0.061, "depth": 0.036, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.1165, -0.01, -0.001], "rotation": [0, 0, 0], "scale": [0.031, 0.061, 0.036]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ear-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["ear-1-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_ear_1_47.add(mesh_ear_1_47);
  meshes["ear-1"] = mesh_ear_1_47;
  colliders["ear-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["ear-1"] ??= [];
  destructionGroups["ear-1"].push(node_ear_1_47);

  const endpoint_earrings_48 = makeAttachmentEndpoint(null);
  const node_earrings_48 = new THREE.Group();
  node_earrings_48.name = "Gold left ear drop__pivot";
  node_earrings_48.scale.set(1, 1, 1);
  if (endpoint_earrings_48) {
    node_earrings_48.position.copy(endpoint_earrings_48.start);
    node_earrings_48.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_earrings_48.position.set(0.1195, -0.055, 0.004);
    node_earrings_48.rotation.set(0.0, 0.0, 0.0);
  }
  node_earrings_48.userData.sculptComponent = {"id": "earrings", "name": "Gold left ear drop", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Gold left ear drop follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.005, "height": 0.044, "depth": 0.008, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.1195, -0.055, 0.004], "rotation": [0, 0, 0], "scale": [0.005, 0.044, 0.008]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "earrings", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}}, "material": "gold", "materialLayers": ["gold"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["earrings-observed-contour", {"id": "earrings", "description": "Three parallel gold drops on left ear", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(179, 160, 92, 1)", "secondaryAlbedo": "rgba(161, 144, 83, 1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_earrings_48.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "earrings", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}};
  (nodes["head"] ?? root).add(node_earrings_48);
  nodes["earrings"] = node_earrings_48;
  const mesh_earrings_48Geometry = endpoint_earrings_48
    ? new THREE.CylinderGeometry(endpoint_earrings_48.endRadius, endpoint_earrings_48.baseRadius, endpoint_earrings_48.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_earrings_48) {
    mesh_earrings_48Geometry.scale(0.005, 0.044, 0.008);
  }
  const mesh_earrings_48 = new THREE.Mesh(
    mesh_earrings_48Geometry,
    materialMap["gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_earrings_48.name = "Gold left ear drop";
  if (endpoint_earrings_48) {
    mesh_earrings_48.position.copy(endpoint_earrings_48.midpoint);
    mesh_earrings_48.quaternion.copy(endpoint_earrings_48.quaternion);
  }
  mesh_earrings_48.castShadow = options.castShadow ?? true;
  mesh_earrings_48.receiveShadow = options.receiveShadow ?? true;
  mesh_earrings_48.userData.sculptComponent = {"id": "earrings", "name": "Gold left ear drop", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Gold left ear drop follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.005, "height": 0.044, "depth": 0.008, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.1195, -0.055, 0.004], "rotation": [0, 0, 0], "scale": [0.005, 0.044, 0.008]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "earrings", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}}, "material": "gold", "materialLayers": ["gold"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["earrings-observed-contour", {"id": "earrings", "description": "Three parallel gold drops on left ear", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(179, 160, 92, 1)", "secondaryAlbedo": "rgba(161, 144, 83, 1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_earrings_48.add(mesh_earrings_48);
  meshes["earrings"] = mesh_earrings_48;
  colliders["earrings"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["earrings"] ??= [];
  destructionGroups["earrings"].push(node_earrings_48);

  const endpoint_earring_1_49 = makeAttachmentEndpoint(null);
  const node_earring_1_49 = new THREE.Group();
  node_earring_1_49.name = "Gold left ear drop__pivot";
  node_earring_1_49.scale.set(1, 1, 1);
  if (endpoint_earring_1_49) {
    node_earring_1_49.position.copy(endpoint_earring_1_49.start);
    node_earring_1_49.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_earring_1_49.position.set(0.1275, -0.055, 0.004);
    node_earring_1_49.rotation.set(0.0, 0.0, 0.0);
  }
  node_earring_1_49.userData.sculptComponent = {"id": "earring-1", "name": "Gold left ear drop", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Gold left ear drop follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.005, "height": 0.044, "depth": 0.008, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.1275, -0.055, 0.004], "rotation": [0, 0, 0], "scale": [0.005, 0.044, 0.008]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "earring-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}}, "material": "gold", "materialLayers": ["gold"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["earring-1-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(179, 160, 92, 1)", "secondaryAlbedo": "rgba(161, 144, 83, 1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_earring_1_49.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "earring-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}};
  (nodes["head"] ?? root).add(node_earring_1_49);
  nodes["earring-1"] = node_earring_1_49;
  const mesh_earring_1_49Geometry = endpoint_earring_1_49
    ? new THREE.CylinderGeometry(endpoint_earring_1_49.endRadius, endpoint_earring_1_49.baseRadius, endpoint_earring_1_49.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_earring_1_49) {
    mesh_earring_1_49Geometry.scale(0.005, 0.044, 0.008);
  }
  const mesh_earring_1_49 = new THREE.Mesh(
    mesh_earring_1_49Geometry,
    materialMap["gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_earring_1_49.name = "Gold left ear drop";
  if (endpoint_earring_1_49) {
    mesh_earring_1_49.position.copy(endpoint_earring_1_49.midpoint);
    mesh_earring_1_49.quaternion.copy(endpoint_earring_1_49.quaternion);
  }
  mesh_earring_1_49.castShadow = options.castShadow ?? true;
  mesh_earring_1_49.receiveShadow = options.receiveShadow ?? true;
  mesh_earring_1_49.userData.sculptComponent = {"id": "earring-1", "name": "Gold left ear drop", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Gold left ear drop follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.005, "height": 0.044, "depth": 0.008, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.1275, -0.055, 0.004], "rotation": [0, 0, 0], "scale": [0.005, 0.044, 0.008]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "earring-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}}, "material": "gold", "materialLayers": ["gold"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["earring-1-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(179, 160, 92, 1)", "secondaryAlbedo": "rgba(161, 144, 83, 1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_earring_1_49.add(mesh_earring_1_49);
  meshes["earring-1"] = mesh_earring_1_49;
  colliders["earring-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["earring-1"] ??= [];
  destructionGroups["earring-1"].push(node_earring_1_49);

  const endpoint_earring_2_50 = makeAttachmentEndpoint(null);
  const node_earring_2_50 = new THREE.Group();
  node_earring_2_50.name = "Gold left ear drop__pivot";
  node_earring_2_50.scale.set(1, 1, 1);
  if (endpoint_earring_2_50) {
    node_earring_2_50.position.copy(endpoint_earring_2_50.start);
    node_earring_2_50.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_earring_2_50.position.set(0.1355, -0.055, 0.004);
    node_earring_2_50.rotation.set(0.0, 0.0, 0.0);
  }
  node_earring_2_50.userData.sculptComponent = {"id": "earring-2", "name": "Gold left ear drop", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Gold left ear drop follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.005, "height": 0.044, "depth": 0.008, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.1355, -0.055, 0.004], "rotation": [0, 0, 0], "scale": [0.005, 0.044, 0.008]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "earring-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}}, "material": "gold", "materialLayers": ["gold"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["earring-2-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(179, 160, 92, 1)", "secondaryAlbedo": "rgba(161, 144, 83, 1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_earring_2_50.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "earring-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}};
  (nodes["head"] ?? root).add(node_earring_2_50);
  nodes["earring-2"] = node_earring_2_50;
  const mesh_earring_2_50Geometry = endpoint_earring_2_50
    ? new THREE.CylinderGeometry(endpoint_earring_2_50.endRadius, endpoint_earring_2_50.baseRadius, endpoint_earring_2_50.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_earring_2_50) {
    mesh_earring_2_50Geometry.scale(0.005, 0.044, 0.008);
  }
  const mesh_earring_2_50 = new THREE.Mesh(
    mesh_earring_2_50Geometry,
    materialMap["gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_earring_2_50.name = "Gold left ear drop";
  if (endpoint_earring_2_50) {
    mesh_earring_2_50.position.copy(endpoint_earring_2_50.midpoint);
    mesh_earring_2_50.quaternion.copy(endpoint_earring_2_50.quaternion);
  }
  mesh_earring_2_50.castShadow = options.castShadow ?? true;
  mesh_earring_2_50.receiveShadow = options.receiveShadow ?? true;
  mesh_earring_2_50.userData.sculptComponent = {"id": "earring-2", "name": "Gold left ear drop", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Gold left ear drop follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "head", "attachment": null, "dimensions": {"width": 0.005, "height": 0.044, "depth": 0.008, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.1355, -0.055, 0.004], "rotation": [0, 0, 0], "scale": [0.005, 0.044, 0.008]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "earring-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}}, "material": "gold", "materialLayers": ["gold"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["earring-2-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(179, 160, 92, 1)", "secondaryAlbedo": "rgba(161, 144, 83, 1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_earring_2_50.add(mesh_earring_2_50);
  meshes["earring-2"] = mesh_earring_2_50;
  colliders["earring-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["earring-2"] ??= [];
  destructionGroups["earring-2"].push(node_earring_2_50);

  const endpoint_hand_raised_51 = makeAttachmentEndpoint(null);
  const node_hand_raised_51 = new THREE.Group();
  node_hand_raised_51.name = "Gripping hand__pivot";
  node_hand_raised_51.scale.set(1, 1, 1);
  if (endpoint_hand_raised_51) {
    node_hand_raised_51.position.copy(endpoint_hand_raised_51.start);
    node_hand_raised_51.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hand_raised_51.position.set(-0.2775, 2.3225, 0.0);
    node_hand_raised_51.rotation.set(0.0, 0.0, 0.0);
  }
  node_hand_raised_51.userData.sculptComponent = {"id": "hand-raised", "name": "Gripping hand", "level": "meso", "role": "hand", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "Gripping hand follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"sdf": {"primitives": [{"id": "palm", "type": "ellipsoid", "center": [0.0, 0.0, 0.023], "radii": [0.029, 0.039, 0.02], "transform": {"position": [0.0, 0.0, 0.023], "rotation": [0, 0, 0.78]}}], "operations": [], "bounds": {"min": [-0.05, -0.05, -0.035], "max": [0.05, 0.05, 0.035]}, "resolution": 36}, "topologyIntent": "Continuous palm plus four three-joint curled fingers and opposing thumb; no imported mesh; hidden depth inferred.", "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.085, "height": 0.108, "depth": 0.065, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.2775, 2.3225, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-raised", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hand-raised-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L0", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_hand_raised_51.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-raised", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["root"] ?? root).add(node_hand_raised_51);
  nodes["hand-raised"] = node_hand_raised_51;
  const mesh_hand_raised_51Geometry = polygonizeSdf({"primitives": [{"id": "palm", "type": "ellipsoid", "center": [0.0, 0.0, 0.023], "radii": [0.029, 0.039, 0.02], "transform": {"position": [0.0, 0.0, 0.023], "rotation": [0, 0, 0.78]}}], "operations": [], "bounds": {"min": [-0.05, -0.05, -0.035], "max": [0.05, 0.05, 0.035]}, "resolution": 36});
  if (!endpoint_hand_raised_51) {
    mesh_hand_raised_51Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hand_raised_51 = new THREE.Mesh(
    mesh_hand_raised_51Geometry,
    createSculptMaterial("skin", {"id": "skin", "name": "skin", "type": "physical", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#e8be8d", "color": "#e8be8d", "albedo": {"dominant": "#e8be8d", "secondary": ["#e8be8d"], "accents": []}, "colorVariation": {"palette": ["#e8be8d", "#e8be8d"], "pattern": "flat", "amplitude": 0, "heightCorrelation": 0}, "roughness": {"base": 0.62, "variation": 0.02, "map": "independent-micro-response"}, "metalness": {"base": 0, "variation": 0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "skin-fold-tone", "region": "reference-observed fold valleys", "roughness": 0.66, "evidenceRefs": ["full-object"], "notes": "Cloth folds are geometry; front shade boundary comes from de-lit projection."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Observed anime base colour. Physical roughness is inferred, not measured photometric evidence.", "textureless": {"declared": true, "evidence": ["docs/references/user-cast/zoro.png: flat cel-colour fills, bounded linework and painted shadow regions; no observable grain/pores.", ".img2threejs/cast/zoro/material-evidence.json: pixel crop and source-classification evidence."], "limitation": "No photometric PBR recovery is claimed. Geometry carries folds, fittings and wrap diamonds."}}, options, true)
  );
  mesh_hand_raised_51.name = "Gripping hand";
  if (endpoint_hand_raised_51) {
    mesh_hand_raised_51.position.copy(endpoint_hand_raised_51.midpoint);
    mesh_hand_raised_51.quaternion.copy(endpoint_hand_raised_51.quaternion);
  }
  mesh_hand_raised_51.castShadow = options.castShadow ?? true;
  mesh_hand_raised_51.receiveShadow = options.receiveShadow ?? true;
  mesh_hand_raised_51.userData.sculptComponent = {"id": "hand-raised", "name": "Gripping hand", "level": "meso", "role": "hand", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "Gripping hand follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"sdf": {"primitives": [{"id": "palm", "type": "ellipsoid", "center": [0.0, 0.0, 0.023], "radii": [0.029, 0.039, 0.02], "transform": {"position": [0.0, 0.0, 0.023], "rotation": [0, 0, 0.78]}}], "operations": [], "bounds": {"min": [-0.05, -0.05, -0.035], "max": [0.05, 0.05, 0.035]}, "resolution": 36}, "topologyIntent": "Continuous palm plus four three-joint curled fingers and opposing thumb; no imported mesh; hidden depth inferred.", "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.085, "height": 0.108, "depth": 0.065, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.2775, 2.3225, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-raised", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hand-raised-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L0", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_hand_raised_51.add(mesh_hand_raised_51);
  meshes["hand-raised"] = mesh_hand_raised_51;
  colliders["hand-raised"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hand-raised"] ??= [];
  destructionGroups["hand-raised"].push(node_hand_raised_51);

  const endpoint_hand_down_52 = makeAttachmentEndpoint(null);
  const node_hand_down_52 = new THREE.Group();
  node_hand_down_52.name = "Gripping hand__pivot";
  node_hand_down_52.scale.set(1, 1, 1);
  if (endpoint_hand_down_52) {
    node_hand_down_52.position.copy(endpoint_hand_down_52.start);
    node_hand_down_52.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hand_down_52.position.set(0.4, 1.28, 0.0);
    node_hand_down_52.rotation.set(0.0, 0.0, 0.0);
  }
  node_hand_down_52.userData.sculptComponent = {"id": "hand-down", "name": "Gripping hand", "level": "meso", "role": "hand", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "Gripping hand follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"sdf": {"primitives": [{"id": "palm", "type": "ellipsoid", "center": [0.0, 0.0, 0.023], "radii": [0.029, 0.039, 0.02], "transform": {"position": [0.0, 0.0, 0.023], "rotation": [0, 0, 0.36]}}], "operations": [], "bounds": {"min": [-0.05, -0.05, -0.035], "max": [0.05, 0.05, 0.035]}, "resolution": 36}, "topologyIntent": "Continuous palm plus four three-joint curled fingers and opposing thumb; no imported mesh; hidden depth inferred.", "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.075, "height": 0.12, "depth": 0.065, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.4, 1.28, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-down", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hand-down-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L0", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_hand_down_52.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-down", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["root"] ?? root).add(node_hand_down_52);
  nodes["hand-down"] = node_hand_down_52;
  const mesh_hand_down_52Geometry = polygonizeSdf({"primitives": [{"id": "palm", "type": "ellipsoid", "center": [0.0, 0.0, 0.023], "radii": [0.029, 0.039, 0.02], "transform": {"position": [0.0, 0.0, 0.023], "rotation": [0, 0, 0.36]}}], "operations": [], "bounds": {"min": [-0.05, -0.05, -0.035], "max": [0.05, 0.05, 0.035]}, "resolution": 36});
  if (!endpoint_hand_down_52) {
    mesh_hand_down_52Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hand_down_52 = new THREE.Mesh(
    mesh_hand_down_52Geometry,
    createSculptMaterial("skin", {"id": "skin", "name": "skin", "type": "physical", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#e8be8d", "color": "#e8be8d", "albedo": {"dominant": "#e8be8d", "secondary": ["#e8be8d"], "accents": []}, "colorVariation": {"palette": ["#e8be8d", "#e8be8d"], "pattern": "flat", "amplitude": 0, "heightCorrelation": 0}, "roughness": {"base": 0.62, "variation": 0.02, "map": "independent-micro-response"}, "metalness": {"base": 0, "variation": 0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "skin-fold-tone", "region": "reference-observed fold valleys", "roughness": 0.66, "evidenceRefs": ["full-object"], "notes": "Cloth folds are geometry; front shade boundary comes from de-lit projection."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Observed anime base colour. Physical roughness is inferred, not measured photometric evidence.", "textureless": {"declared": true, "evidence": ["docs/references/user-cast/zoro.png: flat cel-colour fills, bounded linework and painted shadow regions; no observable grain/pores.", ".img2threejs/cast/zoro/material-evidence.json: pixel crop and source-classification evidence."], "limitation": "No photometric PBR recovery is claimed. Geometry carries folds, fittings and wrap diamonds."}}, options, true)
  );
  mesh_hand_down_52.name = "Gripping hand";
  if (endpoint_hand_down_52) {
    mesh_hand_down_52.position.copy(endpoint_hand_down_52.midpoint);
    mesh_hand_down_52.quaternion.copy(endpoint_hand_down_52.quaternion);
  }
  mesh_hand_down_52.castShadow = options.castShadow ?? true;
  mesh_hand_down_52.receiveShadow = options.receiveShadow ?? true;
  mesh_hand_down_52.userData.sculptComponent = {"id": "hand-down", "name": "Gripping hand", "level": "meso", "role": "hand", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "Gripping hand follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"sdf": {"primitives": [{"id": "palm", "type": "ellipsoid", "center": [0.0, 0.0, 0.023], "radii": [0.029, 0.039, 0.02], "transform": {"position": [0.0, 0.0, 0.023], "rotation": [0, 0, 0.36]}}], "operations": [], "bounds": {"min": [-0.05, -0.05, -0.035], "max": [0.05, 0.05, 0.035]}, "resolution": 36}, "topologyIntent": "Continuous palm plus four three-joint curled fingers and opposing thumb; no imported mesh; hidden depth inferred.", "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.075, "height": 0.12, "depth": 0.065, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.4, 1.28, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-down", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hand-down-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L0", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_hand_down_52.add(mesh_hand_down_52);
  meshes["hand-down"] = mesh_hand_down_52;
  colliders["hand-down"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hand-down"] ??= [];
  destructionGroups["hand-down"].push(node_hand_down_52);

  const endpoint_raised_grip_53 = makeAttachmentEndpoint(null);
  const node_raised_grip_53 = new THREE.Group();
  node_raised_grip_53.name = "raised grip__pivot";
  node_raised_grip_53.scale.set(1, 1, 1);
  if (endpoint_raised_grip_53) {
    node_raised_grip_53.position.copy(endpoint_raised_grip_53.start);
    node_raised_grip_53.rotation.set(0.0, 0.0, -2.3518655129052854);
  } else {
    node_raised_grip_53.position.set(-0.185, 0.1775000000000002, 0.0);
    node_raised_grip_53.rotation.set(0.0, 0.0, -2.3518655129052854);
  }
  node_raised_grip_53.userData.sculptComponent = {"id": "raised-grip", "name": "raised grip", "level": "meso", "role": "accessory", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "raised grip follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "profile2D": {"points": [[-0.0235, 0], [0.0235, 0], [0.01645, 0.37568935305648476], [0, 0.4083579924527008], [-0.01645, 0.36752219320743074]], "depth": 0.035}}, "parent": "hand-raised", "attachment": {"anchor": "hand-raised", "maxOffset": 0.13, "contactType": "held-grip", "evidenceRefs": ["full-object"], "notes": "Proximity uses measured geometry centroids, not zero pivots of implicit fields."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.185, 0.1775000000000002, 0], "rotation": [0, 0, -2.3518655129052854], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "raised-grip", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark"}}, "material": "dark", "materialLayers": ["dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["raised-grip-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(32, 35, 44, 1)", "secondaryAlbedo": "rgba(29, 32, 40, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_raised_grip_53.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "raised-grip", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark"}};
  (nodes["hand-raised"] ?? root).add(node_raised_grip_53);
  nodes["raised-grip"] = node_raised_grip_53;
  const mesh_raised_grip_53Geometry = endpoint_raised_grip_53
    ? new THREE.CylinderGeometry(endpoint_raised_grip_53.endRadius, endpoint_raised_grip_53.baseRadius, endpoint_raised_grip_53.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.0235, 0], [0.0235, 0], [0.01645, 0.37568935305648476], [0, 0.4083579924527008], [-0.01645, 0.36752219320743074]], "depth": 0.035});
  if (!endpoint_raised_grip_53) {
    mesh_raised_grip_53Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_raised_grip_53 = new THREE.Mesh(
    mesh_raised_grip_53Geometry,
    materialMap["dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_raised_grip_53.name = "raised grip";
  if (endpoint_raised_grip_53) {
    mesh_raised_grip_53.position.copy(endpoint_raised_grip_53.midpoint);
    mesh_raised_grip_53.quaternion.copy(endpoint_raised_grip_53.quaternion);
  }
  mesh_raised_grip_53.castShadow = options.castShadow ?? true;
  mesh_raised_grip_53.receiveShadow = options.receiveShadow ?? true;
  mesh_raised_grip_53.userData.sculptComponent = {"id": "raised-grip", "name": "raised grip", "level": "meso", "role": "accessory", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "raised grip follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "profile2D": {"points": [[-0.0235, 0], [0.0235, 0], [0.01645, 0.37568935305648476], [0, 0.4083579924527008], [-0.01645, 0.36752219320743074]], "depth": 0.035}}, "parent": "hand-raised", "attachment": {"anchor": "hand-raised", "maxOffset": 0.13, "contactType": "held-grip", "evidenceRefs": ["full-object"], "notes": "Proximity uses measured geometry centroids, not zero pivots of implicit fields."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.185, 0.1775000000000002, 0], "rotation": [0, 0, -2.3518655129052854], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "raised-grip", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark"}}, "material": "dark", "materialLayers": ["dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["raised-grip-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(32, 35, 44, 1)", "secondaryAlbedo": "rgba(29, 32, 40, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_raised_grip_53.add(mesh_raised_grip_53);
  meshes["raised-grip"] = mesh_raised_grip_53;
  colliders["raised-grip"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["raised-grip"] ??= [];
  destructionGroups["raised-grip"].push(node_raised_grip_53);

  const endpoint_raised_sheath_54 = makeAttachmentEndpoint(null);
  const node_raised_sheath_54 = new THREE.Group();
  node_raised_sheath_54.name = "raised sheath__pivot";
  node_raised_sheath_54.scale.set(1, 1, 1);
  if (endpoint_raised_sheath_54) {
    node_raised_sheath_54.position.copy(endpoint_raised_sheath_54.start);
    node_raised_sheath_54.rotation.set(0.0, 0.0, -2.4416997838705483);
  } else {
    node_raised_sheath_54.position.set(0.11000000000000001, -0.10999999999999988, 0.0);
    node_raised_sheath_54.rotation.set(0.0, 0.0, -2.4416997838705483);
  }
  node_raised_sheath_54.userData.sculptComponent = {"id": "raised-sheath", "name": "raised sheath", "level": "meso", "role": "accessory", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "raised sheath follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "profile2D": {"points": [[-0.022, 0], [0.022, 0], [0.015399999999999999, 0.11426162960504267], [0, 0.12419742348374203], [-0.015399999999999999, 0.11177768113536783]], "depth": 0.032}}, "parent": "hand-raised", "attachment": {"anchor": "hand-raised", "maxOffset": 0.28, "contactType": "held-grip", "evidenceRefs": ["full-object"], "notes": "Proximity uses measured geometry centroids, not zero pivots of implicit fields."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.11000000000000001, -0.10999999999999988, 0], "rotation": [0, 0, -2.4416997838705483], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "raised-sheath", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark"}}, "material": "dark", "materialLayers": ["dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["raised-sheath-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(32, 35, 44, 1)", "secondaryAlbedo": "rgba(29, 32, 40, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_raised_sheath_54.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "raised-sheath", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark"}};
  (nodes["hand-raised"] ?? root).add(node_raised_sheath_54);
  nodes["raised-sheath"] = node_raised_sheath_54;
  const mesh_raised_sheath_54Geometry = endpoint_raised_sheath_54
    ? new THREE.CylinderGeometry(endpoint_raised_sheath_54.endRadius, endpoint_raised_sheath_54.baseRadius, endpoint_raised_sheath_54.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.022, 0], [0.022, 0], [0.015399999999999999, 0.11426162960504267], [0, 0.12419742348374203], [-0.015399999999999999, 0.11177768113536783]], "depth": 0.032});
  if (!endpoint_raised_sheath_54) {
    mesh_raised_sheath_54Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_raised_sheath_54 = new THREE.Mesh(
    mesh_raised_sheath_54Geometry,
    materialMap["dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_raised_sheath_54.name = "raised sheath";
  if (endpoint_raised_sheath_54) {
    mesh_raised_sheath_54.position.copy(endpoint_raised_sheath_54.midpoint);
    mesh_raised_sheath_54.quaternion.copy(endpoint_raised_sheath_54.quaternion);
  }
  mesh_raised_sheath_54.castShadow = options.castShadow ?? true;
  mesh_raised_sheath_54.receiveShadow = options.receiveShadow ?? true;
  mesh_raised_sheath_54.userData.sculptComponent = {"id": "raised-sheath", "name": "raised sheath", "level": "meso", "role": "accessory", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "raised sheath follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "profile2D": {"points": [[-0.022, 0], [0.022, 0], [0.015399999999999999, 0.11426162960504267], [0, 0.12419742348374203], [-0.015399999999999999, 0.11177768113536783]], "depth": 0.032}}, "parent": "hand-raised", "attachment": {"anchor": "hand-raised", "maxOffset": 0.28, "contactType": "held-grip", "evidenceRefs": ["full-object"], "notes": "Proximity uses measured geometry centroids, not zero pivots of implicit fields."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.11000000000000001, -0.10999999999999988, 0], "rotation": [0, 0, -2.4416997838705483], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "raised-sheath", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark"}}, "material": "dark", "materialLayers": ["dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["raised-sheath-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(32, 35, 44, 1)", "secondaryAlbedo": "rgba(29, 32, 40, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_raised_sheath_54.add(mesh_raised_sheath_54);
  meshes["raised-sheath"] = mesh_raised_sheath_54;
  colliders["raised-sheath"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["raised-sheath"] ??= [];
  destructionGroups["raised-sheath"].push(node_raised_sheath_54);

  const endpoint_hip_grip_55 = makeAttachmentEndpoint(null);
  const node_hip_grip_55 = new THREE.Group();
  node_hip_grip_55.name = "hip grip__pivot";
  node_hip_grip_55.scale.set(1, 1, 1);
  if (endpoint_hip_grip_55) {
    node_hip_grip_55.position.copy(endpoint_hip_grip_55.start);
    node_hip_grip_55.rotation.set(0.0, 0.0, -2.3868597211192935);
  } else {
    node_hip_grip_55.position.set(-0.48, 1.8975, 0.0);
    node_hip_grip_55.rotation.set(0.0, 0.0, -2.3868597211192935);
  }
  node_hip_grip_55.userData.sculptComponent = {"id": "hip-grip", "name": "hip grip", "level": "meso", "role": "accessory", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "hip grip follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "profile2D": {"points": [[-0.024, 0], [0.024, 0], [0.0168, 0.26521902269633674], [0, 0.2882815464090617], [-0.0168, 0.2594533917681555]], "depth": 0.034}}, "parent": "haramaki", "attachment": {"anchor": "haramaki", "maxOffset": 0.45, "contactType": "waist-mounted", "evidenceRefs": ["full-object"], "notes": "Proximity uses measured geometry centroids, not zero pivots of implicit fields."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.48, 1.8975, 0], "rotation": [0, 0, -2.3868597211192935], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hip-grip", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}}, "material": "white", "materialLayers": ["white"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hip-grip-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 234, 222, 1)", "secondaryAlbedo": "rgba(214, 211, 200, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_hip_grip_55.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hip-grip", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}};
  (nodes["haramaki"] ?? root).add(node_hip_grip_55);
  nodes["hip-grip"] = node_hip_grip_55;
  const mesh_hip_grip_55Geometry = endpoint_hip_grip_55
    ? new THREE.CylinderGeometry(endpoint_hip_grip_55.endRadius, endpoint_hip_grip_55.baseRadius, endpoint_hip_grip_55.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.024, 0], [0.024, 0], [0.0168, 0.26521902269633674], [0, 0.2882815464090617], [-0.0168, 0.2594533917681555]], "depth": 0.034});
  if (!endpoint_hip_grip_55) {
    mesh_hip_grip_55Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hip_grip_55 = new THREE.Mesh(
    mesh_hip_grip_55Geometry,
    materialMap["white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hip_grip_55.name = "hip grip";
  if (endpoint_hip_grip_55) {
    mesh_hip_grip_55.position.copy(endpoint_hip_grip_55.midpoint);
    mesh_hip_grip_55.quaternion.copy(endpoint_hip_grip_55.quaternion);
  }
  mesh_hip_grip_55.castShadow = options.castShadow ?? true;
  mesh_hip_grip_55.receiveShadow = options.receiveShadow ?? true;
  mesh_hip_grip_55.userData.sculptComponent = {"id": "hip-grip", "name": "hip grip", "level": "meso", "role": "accessory", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "hip grip follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "profile2D": {"points": [[-0.024, 0], [0.024, 0], [0.0168, 0.26521902269633674], [0, 0.2882815464090617], [-0.0168, 0.2594533917681555]], "depth": 0.034}}, "parent": "haramaki", "attachment": {"anchor": "haramaki", "maxOffset": 0.45, "contactType": "waist-mounted", "evidenceRefs": ["full-object"], "notes": "Proximity uses measured geometry centroids, not zero pivots of implicit fields."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.48, 1.8975, 0], "rotation": [0, 0, -2.3868597211192935], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hip-grip", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}}, "material": "white", "materialLayers": ["white"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hip-grip-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 234, 222, 1)", "secondaryAlbedo": "rgba(214, 211, 200, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_hip_grip_55.add(mesh_hip_grip_55);
  meshes["hip-grip"] = mesh_hip_grip_55;
  colliders["hip-grip"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hip-grip"] ??= [];
  destructionGroups["hip-grip"].push(node_hip_grip_55);

  const endpoint_hip_sheath_56 = makeAttachmentEndpoint(null);
  const node_hip_sheath_56 = new THREE.Group();
  node_hip_sheath_56.name = "hip sheath__pivot";
  node_hip_sheath_56.scale.set(1, 1, 1);
  if (endpoint_hip_sheath_56) {
    node_hip_sheath_56.position.copy(endpoint_hip_sheath_56.start);
    node_hip_sheath_56.rotation.set(0.0, 0.0, -2.507386397175197);
  } else {
    node_hip_sheath_56.position.set(-0.265, 1.6675, 0.0);
    node_hip_sheath_56.rotation.set(0.0, 0.0, -2.507386397175197);
  }
  node_hip_sheath_56.userData.sculptComponent = {"id": "hip-sheath", "name": "hip sheath", "level": "meso", "role": "accessory", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "hip sheath follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "Blunt-ended closed scabbard with a rectangular-to-oval section; observed endpoint.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "profile2D": {"points": [[-0.032, 0], [0.032, 0], [0.03008, 1.2910557695157867], [-0.03008, 1.2910557695157867]], "depth": 0.038}}, "parent": "haramaki", "attachment": {"anchor": "haramaki", "maxOffset": 0.75, "contactType": "waist-mounted", "evidenceRefs": ["full-object"], "notes": "Proximity uses measured geometry centroids, not zero pivots of implicit fields."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.265, 1.6675, 0], "rotation": [0, 0, -2.507386397175197], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hip-sheath", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark"}}, "material": "dark", "materialLayers": ["dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hip-sheath-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(32, 35, 44, 1)", "secondaryAlbedo": "rgba(29, 32, 40, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_hip_sheath_56.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hip-sheath", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark"}};
  (nodes["haramaki"] ?? root).add(node_hip_sheath_56);
  nodes["hip-sheath"] = node_hip_sheath_56;
  const mesh_hip_sheath_56Geometry = endpoint_hip_sheath_56
    ? new THREE.CylinderGeometry(endpoint_hip_sheath_56.endRadius, endpoint_hip_sheath_56.baseRadius, endpoint_hip_sheath_56.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.032, 0], [0.032, 0], [0.03008, 1.2910557695157867], [-0.03008, 1.2910557695157867]], "depth": 0.038});
  if (!endpoint_hip_sheath_56) {
    mesh_hip_sheath_56Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hip_sheath_56 = new THREE.Mesh(
    mesh_hip_sheath_56Geometry,
    materialMap["dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hip_sheath_56.name = "hip sheath";
  if (endpoint_hip_sheath_56) {
    mesh_hip_sheath_56.position.copy(endpoint_hip_sheath_56.midpoint);
    mesh_hip_sheath_56.quaternion.copy(endpoint_hip_sheath_56.quaternion);
  }
  mesh_hip_sheath_56.castShadow = options.castShadow ?? true;
  mesh_hip_sheath_56.receiveShadow = options.receiveShadow ?? true;
  mesh_hip_sheath_56.userData.sculptComponent = {"id": "hip-sheath", "name": "hip sheath", "level": "meso", "role": "accessory", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "hip sheath follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "Blunt-ended closed scabbard with a rectangular-to-oval section; observed endpoint.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "profile2D": {"points": [[-0.032, 0], [0.032, 0], [0.03008, 1.2910557695157867], [-0.03008, 1.2910557695157867]], "depth": 0.038}}, "parent": "haramaki", "attachment": {"anchor": "haramaki", "maxOffset": 0.75, "contactType": "waist-mounted", "evidenceRefs": ["full-object"], "notes": "Proximity uses measured geometry centroids, not zero pivots of implicit fields."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.265, 1.6675, 0], "rotation": [0, 0, -2.507386397175197], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hip-sheath", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark"}}, "material": "dark", "materialLayers": ["dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hip-sheath-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(32, 35, 44, 1)", "secondaryAlbedo": "rgba(29, 32, 40, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_hip_sheath_56.add(mesh_hip_sheath_56);
  meshes["hip-sheath"] = mesh_hip_sheath_56;
  colliders["hip-sheath"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hip-sheath"] ??= [];
  destructionGroups["hip-sheath"].push(node_hip_sheath_56);

  const endpoint_low_grip_57 = makeAttachmentEndpoint(null);
  const node_low_grip_57 = new THREE.Group();
  node_low_grip_57.name = "low grip__pivot";
  node_low_grip_57.scale.set(1, 1, 1);
  if (endpoint_low_grip_57) {
    node_low_grip_57.position.copy(endpoint_low_grip_57.start);
    node_low_grip_57.rotation.set(0.0, 0.0, -2.773611717444809);
  } else {
    node_low_grip_57.position.set(-0.0675, 0.11499999999999999, 0.0);
    node_low_grip_57.rotation.set(0.0, 0.0, -2.773611717444809);
  }
  node_low_grip_57.userData.sculptComponent = {"id": "low-grip", "name": "low grip", "level": "meso", "role": "accessory", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "low grip follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "profile2D": {"points": [[-0.0225, 0], [0.0225, 0], [0.01575, 0.204596603099856], [0, 0.22238761206506086], [-0.01575, 0.20014885085855477]], "depth": 0.032}}, "parent": "hand-down", "attachment": {"anchor": "hand-down", "maxOffset": 0.14, "contactType": "held-grip", "evidenceRefs": ["full-object"], "notes": "Proximity uses measured geometry centroids, not zero pivots of implicit fields."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.0675, 0.11499999999999999, 0], "rotation": [0, 0, -2.773611717444809], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "low-grip", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark"}}, "material": "dark", "materialLayers": ["dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["low-grip-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(32, 35, 44, 1)", "secondaryAlbedo": "rgba(29, 32, 40, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_low_grip_57.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "low-grip", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark"}};
  (nodes["hand-down"] ?? root).add(node_low_grip_57);
  nodes["low-grip"] = node_low_grip_57;
  const mesh_low_grip_57Geometry = endpoint_low_grip_57
    ? new THREE.CylinderGeometry(endpoint_low_grip_57.endRadius, endpoint_low_grip_57.baseRadius, endpoint_low_grip_57.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.0225, 0], [0.0225, 0], [0.01575, 0.204596603099856], [0, 0.22238761206506086], [-0.01575, 0.20014885085855477]], "depth": 0.032});
  if (!endpoint_low_grip_57) {
    mesh_low_grip_57Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_low_grip_57 = new THREE.Mesh(
    mesh_low_grip_57Geometry,
    materialMap["dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_low_grip_57.name = "low grip";
  if (endpoint_low_grip_57) {
    mesh_low_grip_57.position.copy(endpoint_low_grip_57.midpoint);
    mesh_low_grip_57.quaternion.copy(endpoint_low_grip_57.quaternion);
  }
  mesh_low_grip_57.castShadow = options.castShadow ?? true;
  mesh_low_grip_57.receiveShadow = options.receiveShadow ?? true;
  mesh_low_grip_57.userData.sculptComponent = {"id": "low-grip", "name": "low grip", "level": "meso", "role": "accessory", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "low grip follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "profile2D": {"points": [[-0.0225, 0], [0.0225, 0], [0.01575, 0.204596603099856], [0, 0.22238761206506086], [-0.01575, 0.20014885085855477]], "depth": 0.032}}, "parent": "hand-down", "attachment": {"anchor": "hand-down", "maxOffset": 0.14, "contactType": "held-grip", "evidenceRefs": ["full-object"], "notes": "Proximity uses measured geometry centroids, not zero pivots of implicit fields."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.0675, 0.11499999999999999, 0], "rotation": [0, 0, -2.773611717444809], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "low-grip", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "dark"}}, "material": "dark", "materialLayers": ["dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["low-grip-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(32, 35, 44, 1)", "secondaryAlbedo": "rgba(29, 32, 40, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_low_grip_57.add(mesh_low_grip_57);
  meshes["low-grip"] = mesh_low_grip_57;
  colliders["low-grip"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["low-grip"] ??= [];
  destructionGroups["low-grip"].push(node_low_grip_57);

  const endpoint_blade_58 = makeAttachmentEndpoint(null);
  const node_blade_58 = new THREE.Group();
  node_blade_58.name = "blade__pivot";
  node_blade_58.scale.set(1, 1, 1);
  if (endpoint_blade_58) {
    node_blade_58.position.copy(endpoint_blade_58.start);
    node_blade_58.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_blade_58.position.set(-0.4, -1.28, 0.0);
    node_blade_58.rotation.set(0.0, 0.0, 0.0);
  }
  node_blade_58.userData.sculptComponent = {"id": "blade", "name": "blade", "level": "meso", "role": "accessory", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "blade follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "profile2D": {"points": [[0.395, 1.145], [0.4025, 1.115], [0.4125, 1.085], [0.425, 1.065], [0.4325, 1.045], [0.44, 1.025], [0.4475, 1.005], [0.455, 0.985], [0.465, 0.965], [0.4725, 0.945], [0.4825, 0.925], [0.49, 0.905], [0.5, 0.885], [0.5075, 0.865], [0.5175, 0.845], [0.53, 0.825], [0.54, 0.805], [0.5475, 0.785], [0.5575, 0.765], [0.5625, 0.745], [0.5725, 0.725], [0.5825, 0.705], [0.59, 0.685], [0.6, 0.665], [0.61, 0.645], [0.6175, 0.625], [0.6275, 0.605], [0.6375, 0.585], [0.6475, 0.565], [0.66, 0.545], [0.67, 0.525], [0.6825, 0.505], [0.6925, 0.485], [0.705, 0.465], [0.715, 0.445], [0.7275, 0.425], [0.7425, 0.405], [0.755, 0.385], [0.7675, 0.365], [0.7775, 0.345], [0.79, 0.325], [0.8, 0.305], [0.8125, 0.285], [0.825, 0.265], [0.8375, 0.245], [0.8525, 0.225], [0.8675, 0.205], [0.885, 0.185], [0.9125, 0.165], [0.95, 0.145], [0.96, 0.14], [0.9725, 0.135], [0.9825, 0.13], [0.9875, 0.13], [0.99, 0.135], [0.985, 0.14], [0.98, 0.145], [0.965, 0.165], [0.95, 0.185], [0.935, 0.205], [0.92, 0.225], [0.9025, 0.245], [0.8875, 0.265], [0.8725, 0.285], [0.8575, 0.305], [0.8475, 0.325], [0.835, 0.345], [0.8225, 0.365], [0.81, 0.385], [0.7975, 0.405], [0.785, 0.425], [0.775, 0.445], [0.765, 0.465], [0.7525, 0.485], [0.7425, 0.505], [0.7325, 0.525], [0.7225, 0.545], [0.71, 0.565], [0.7, 0.585], [0.6875, 0.605], [0.6775, 0.625], [0.6675, 0.645], [0.6575, 0.665], [0.6475, 0.685], [0.6375, 0.705], [0.6275, 0.725], [0.6175, 0.745], [0.61, 0.765], [0.6, 0.785], [0.5925, 0.805], [0.5825, 0.825], [0.5725, 0.845], [0.565, 0.865], [0.555, 0.885], [0.5475, 0.905], [0.5375, 0.925], [0.53, 0.945], [0.52, 0.965], [0.5125, 0.985], [0.5025, 1.005], [0.495, 1.025], [0.485, 1.045], [0.4775, 1.065], [0.47, 1.085], [0.455, 1.115], [0.445, 1.145]], "depth": 0.011}, "bladeRibbon": {"rows": [{"y": 582, "left": 438, "right": 458}, {"y": 594, "left": 441, "right": 462}, {"y": 606, "left": 445, "right": 468}, {"y": 614, "left": 450, "right": 471}, {"y": 622, "left": 453, "right": 474}, {"y": 630, "left": 456, "right": 478}, {"y": 638, "left": 459, "right": 481}, {"y": 646, "left": 462, "right": 485}, {"y": 654, "left": 466, "right": 488}, {"y": 662, "left": 469, "right": 492}, {"y": 670, "left": 473, "right": 495}, {"y": 678, "left": 476, "right": 499}, {"y": 686, "left": 480, "right": 502}, {"y": 694, "left": 483, "right": 506}, {"y": 702, "left": 487, "right": 509}, {"y": 710, "left": 492, "right": 513}, {"y": 718, "left": 496, "right": 517}, {"y": 726, "left": 499, "right": 520}, {"y": 734, "left": 503, "right": 524}, {"y": 742, "left": 505, "right": 527}, {"y": 750, "left": 509, "right": 531}, {"y": 758, "left": 513, "right": 535}, {"y": 766, "left": 516, "right": 539}, {"y": 774, "left": 520, "right": 543}, {"y": 782, "left": 524, "right": 547}, {"y": 790, "left": 527, "right": 551}, {"y": 798, "left": 531, "right": 555}, {"y": 806, "left": 535, "right": 560}, {"y": 814, "left": 539, "right": 564}, {"y": 822, "left": 544, "right": 569}, {"y": 830, "left": 548, "right": 573}, {"y": 838, "left": 553, "right": 577}, {"y": 846, "left": 557, "right": 581}, {"y": 854, "left": 562, "right": 586}, {"y": 862, "left": 566, "right": 590}, {"y": 870, "left": 571, "right": 594}, {"y": 878, "left": 577, "right": 599}, {"y": 886, "left": 582, "right": 604}, {"y": 894, "left": 587, "right": 609}, {"y": 902, "left": 591, "right": 614}, {"y": 910, "left": 596, "right": 619}, {"y": 918, "left": 600, "right": 623}, {"y": 926, "left": 605, "right": 629}, {"y": 934, "left": 610, "right": 635}, {"y": 942, "left": 615, "right": 641}, {"y": 950, "left": 621, "right": 648}, {"y": 958, "left": 627, "right": 654}, {"y": 966, "left": 634, "right": 660}, {"y": 974, "left": 645, "right": 666}, {"y": 982, "left": 660, "right": 672}, {"y": 984, "left": 664, "right": 674}, {"y": 986, "left": 669, "right": 676}, {"y": 988, "left": 673, "right": 675}], "thickness": 0.011, "source": "blade-contours.json; front outline measured, spine/edge section inferred"}}, "parent": "hand-down", "attachment": {"anchor": "hand-down", "maxOffset": 0.8, "contactType": "held-grip", "evidenceRefs": ["full-object"], "notes": "Proximity uses measured geometry centroids, not zero pivots of implicit fields."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.4, -1.28, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "blade", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "steel"}}, "material": "steel", "materialLayers": ["steel"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["blade-observed-contour", {"id": "blade-edge", "description": "Curved steel blade with thin pale cutting edge", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(180, 192, 199, 1)", "secondaryAlbedo": "rgba(162, 173, 179, 1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_blade_58.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "blade", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "steel"}};
  (nodes["hand-down"] ?? root).add(node_blade_58);
  nodes["blade"] = node_blade_58;
  const mesh_blade_58Geometry = endpoint_blade_58
    ? new THREE.CylinderGeometry(endpoint_blade_58.endRadius, endpoint_blade_58.baseRadius, endpoint_blade_58.length, 32, 12)
    : buildExtrudeGeometry({"points": [[0.395, 1.145], [0.4025, 1.115], [0.4125, 1.085], [0.425, 1.065], [0.4325, 1.045], [0.44, 1.025], [0.4475, 1.005], [0.455, 0.985], [0.465, 0.965], [0.4725, 0.945], [0.4825, 0.925], [0.49, 0.905], [0.5, 0.885], [0.5075, 0.865], [0.5175, 0.845], [0.53, 0.825], [0.54, 0.805], [0.5475, 0.785], [0.5575, 0.765], [0.5625, 0.745], [0.5725, 0.725], [0.5825, 0.705], [0.59, 0.685], [0.6, 0.665], [0.61, 0.645], [0.6175, 0.625], [0.6275, 0.605], [0.6375, 0.585], [0.6475, 0.565], [0.66, 0.545], [0.67, 0.525], [0.6825, 0.505], [0.6925, 0.485], [0.705, 0.465], [0.715, 0.445], [0.7275, 0.425], [0.7425, 0.405], [0.755, 0.385], [0.7675, 0.365], [0.7775, 0.345], [0.79, 0.325], [0.8, 0.305], [0.8125, 0.285], [0.825, 0.265], [0.8375, 0.245], [0.8525, 0.225], [0.8675, 0.205], [0.885, 0.185], [0.9125, 0.165], [0.95, 0.145], [0.96, 0.14], [0.9725, 0.135], [0.9825, 0.13], [0.9875, 0.13], [0.99, 0.135], [0.985, 0.14], [0.98, 0.145], [0.965, 0.165], [0.95, 0.185], [0.935, 0.205], [0.92, 0.225], [0.9025, 0.245], [0.8875, 0.265], [0.8725, 0.285], [0.8575, 0.305], [0.8475, 0.325], [0.835, 0.345], [0.8225, 0.365], [0.81, 0.385], [0.7975, 0.405], [0.785, 0.425], [0.775, 0.445], [0.765, 0.465], [0.7525, 0.485], [0.7425, 0.505], [0.7325, 0.525], [0.7225, 0.545], [0.71, 0.565], [0.7, 0.585], [0.6875, 0.605], [0.6775, 0.625], [0.6675, 0.645], [0.6575, 0.665], [0.6475, 0.685], [0.6375, 0.705], [0.6275, 0.725], [0.6175, 0.745], [0.61, 0.765], [0.6, 0.785], [0.5925, 0.805], [0.5825, 0.825], [0.5725, 0.845], [0.565, 0.865], [0.555, 0.885], [0.5475, 0.905], [0.5375, 0.925], [0.53, 0.945], [0.52, 0.965], [0.5125, 0.985], [0.5025, 1.005], [0.495, 1.025], [0.485, 1.045], [0.4775, 1.065], [0.47, 1.085], [0.455, 1.115], [0.445, 1.145]], "depth": 0.011});
  if (!endpoint_blade_58) {
    mesh_blade_58Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_blade_58 = new THREE.Mesh(
    mesh_blade_58Geometry,
    materialMap["steel"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_blade_58.name = "blade";
  if (endpoint_blade_58) {
    mesh_blade_58.position.copy(endpoint_blade_58.midpoint);
    mesh_blade_58.quaternion.copy(endpoint_blade_58.quaternion);
  }
  mesh_blade_58.castShadow = options.castShadow ?? true;
  mesh_blade_58.receiveShadow = options.receiveShadow ?? true;
  mesh_blade_58.userData.sculptComponent = {"id": "blade", "name": "blade", "level": "meso", "role": "accessory", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "blade follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "profile2D": {"points": [[0.395, 1.145], [0.4025, 1.115], [0.4125, 1.085], [0.425, 1.065], [0.4325, 1.045], [0.44, 1.025], [0.4475, 1.005], [0.455, 0.985], [0.465, 0.965], [0.4725, 0.945], [0.4825, 0.925], [0.49, 0.905], [0.5, 0.885], [0.5075, 0.865], [0.5175, 0.845], [0.53, 0.825], [0.54, 0.805], [0.5475, 0.785], [0.5575, 0.765], [0.5625, 0.745], [0.5725, 0.725], [0.5825, 0.705], [0.59, 0.685], [0.6, 0.665], [0.61, 0.645], [0.6175, 0.625], [0.6275, 0.605], [0.6375, 0.585], [0.6475, 0.565], [0.66, 0.545], [0.67, 0.525], [0.6825, 0.505], [0.6925, 0.485], [0.705, 0.465], [0.715, 0.445], [0.7275, 0.425], [0.7425, 0.405], [0.755, 0.385], [0.7675, 0.365], [0.7775, 0.345], [0.79, 0.325], [0.8, 0.305], [0.8125, 0.285], [0.825, 0.265], [0.8375, 0.245], [0.8525, 0.225], [0.8675, 0.205], [0.885, 0.185], [0.9125, 0.165], [0.95, 0.145], [0.96, 0.14], [0.9725, 0.135], [0.9825, 0.13], [0.9875, 0.13], [0.99, 0.135], [0.985, 0.14], [0.98, 0.145], [0.965, 0.165], [0.95, 0.185], [0.935, 0.205], [0.92, 0.225], [0.9025, 0.245], [0.8875, 0.265], [0.8725, 0.285], [0.8575, 0.305], [0.8475, 0.325], [0.835, 0.345], [0.8225, 0.365], [0.81, 0.385], [0.7975, 0.405], [0.785, 0.425], [0.775, 0.445], [0.765, 0.465], [0.7525, 0.485], [0.7425, 0.505], [0.7325, 0.525], [0.7225, 0.545], [0.71, 0.565], [0.7, 0.585], [0.6875, 0.605], [0.6775, 0.625], [0.6675, 0.645], [0.6575, 0.665], [0.6475, 0.685], [0.6375, 0.705], [0.6275, 0.725], [0.6175, 0.745], [0.61, 0.765], [0.6, 0.785], [0.5925, 0.805], [0.5825, 0.825], [0.5725, 0.845], [0.565, 0.865], [0.555, 0.885], [0.5475, 0.905], [0.5375, 0.925], [0.53, 0.945], [0.52, 0.965], [0.5125, 0.985], [0.5025, 1.005], [0.495, 1.025], [0.485, 1.045], [0.4775, 1.065], [0.47, 1.085], [0.455, 1.115], [0.445, 1.145]], "depth": 0.011}, "bladeRibbon": {"rows": [{"y": 582, "left": 438, "right": 458}, {"y": 594, "left": 441, "right": 462}, {"y": 606, "left": 445, "right": 468}, {"y": 614, "left": 450, "right": 471}, {"y": 622, "left": 453, "right": 474}, {"y": 630, "left": 456, "right": 478}, {"y": 638, "left": 459, "right": 481}, {"y": 646, "left": 462, "right": 485}, {"y": 654, "left": 466, "right": 488}, {"y": 662, "left": 469, "right": 492}, {"y": 670, "left": 473, "right": 495}, {"y": 678, "left": 476, "right": 499}, {"y": 686, "left": 480, "right": 502}, {"y": 694, "left": 483, "right": 506}, {"y": 702, "left": 487, "right": 509}, {"y": 710, "left": 492, "right": 513}, {"y": 718, "left": 496, "right": 517}, {"y": 726, "left": 499, "right": 520}, {"y": 734, "left": 503, "right": 524}, {"y": 742, "left": 505, "right": 527}, {"y": 750, "left": 509, "right": 531}, {"y": 758, "left": 513, "right": 535}, {"y": 766, "left": 516, "right": 539}, {"y": 774, "left": 520, "right": 543}, {"y": 782, "left": 524, "right": 547}, {"y": 790, "left": 527, "right": 551}, {"y": 798, "left": 531, "right": 555}, {"y": 806, "left": 535, "right": 560}, {"y": 814, "left": 539, "right": 564}, {"y": 822, "left": 544, "right": 569}, {"y": 830, "left": 548, "right": 573}, {"y": 838, "left": 553, "right": 577}, {"y": 846, "left": 557, "right": 581}, {"y": 854, "left": 562, "right": 586}, {"y": 862, "left": 566, "right": 590}, {"y": 870, "left": 571, "right": 594}, {"y": 878, "left": 577, "right": 599}, {"y": 886, "left": 582, "right": 604}, {"y": 894, "left": 587, "right": 609}, {"y": 902, "left": 591, "right": 614}, {"y": 910, "left": 596, "right": 619}, {"y": 918, "left": 600, "right": 623}, {"y": 926, "left": 605, "right": 629}, {"y": 934, "left": 610, "right": 635}, {"y": 942, "left": 615, "right": 641}, {"y": 950, "left": 621, "right": 648}, {"y": 958, "left": 627, "right": 654}, {"y": 966, "left": 634, "right": 660}, {"y": 974, "left": 645, "right": 666}, {"y": 982, "left": 660, "right": 672}, {"y": 984, "left": 664, "right": 674}, {"y": 986, "left": 669, "right": 676}, {"y": 988, "left": 673, "right": 675}], "thickness": 0.011, "source": "blade-contours.json; front outline measured, spine/edge section inferred"}}, "parent": "hand-down", "attachment": {"anchor": "hand-down", "maxOffset": 0.8, "contactType": "held-grip", "evidenceRefs": ["full-object"], "notes": "Proximity uses measured geometry centroids, not zero pivots of implicit fields."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.4, -1.28, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "blade", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "steel"}}, "material": "steel", "materialLayers": ["steel"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["blade-observed-contour", {"id": "blade-edge", "description": "Curved steel blade with thin pale cutting edge", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(180, 192, 199, 1)", "secondaryAlbedo": "rgba(162, 173, 179, 1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_blade_58.add(mesh_blade_58);
  meshes["blade"] = mesh_blade_58;
  colliders["blade"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["blade"] ??= [];
  destructionGroups["blade"].push(node_blade_58);

  const endpoint_sword_guards_59 = makeAttachmentEndpoint(null);
  const node_sword_guards_59 = new THREE.Group();
  node_sword_guards_59.name = "Gold katana guard__pivot";
  node_sword_guards_59.scale.set(1, 1, 1);
  if (endpoint_sword_guards_59) {
    node_sword_guards_59.position.copy(endpoint_sword_guards_59.start);
    node_sword_guards_59.rotation.set(0.0, 0.0, -0.55);
  } else {
    node_sword_guards_59.position.set(0.07750000000000001, -0.08499999999999996, 0.0);
    node_sword_guards_59.rotation.set(0.0, 0.0, -0.55);
  }
  node_sword_guards_59.userData.sculptComponent = {"id": "sword-guards", "name": "Gold katana guard", "level": "meso", "role": "accessory", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Gold katana guard follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-raised", "attachment": {"anchor": "hand-raised", "maxOffset": 0.18, "contactType": "held-grip", "evidenceRefs": ["full-object"], "notes": "Proximity uses measured geometry centroids, not zero pivots of implicit fields."}, "dimensions": {"width": 0.12, "height": 0.048, "depth": 0.09, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.07750000000000001, -0.08499999999999996, 0], "rotation": [0, 0, -0.55], "scale": [0.12, 0.048, 0.09]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "sword-guards", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}}, "material": "gold", "materialLayers": ["gold"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["sword-guards-observed-contour", {"id": "sword-guards", "description": "Gold multi-lobed guards at three hilts", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(179, 160, 92, 1)", "secondaryAlbedo": "rgba(161, 144, 83, 1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_sword_guards_59.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "sword-guards", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}};
  (nodes["hand-raised"] ?? root).add(node_sword_guards_59);
  nodes["sword-guards"] = node_sword_guards_59;
  const mesh_sword_guards_59Geometry = endpoint_sword_guards_59
    ? new THREE.CylinderGeometry(endpoint_sword_guards_59.endRadius, endpoint_sword_guards_59.baseRadius, endpoint_sword_guards_59.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_sword_guards_59) {
    mesh_sword_guards_59Geometry.scale(0.12, 0.048, 0.09);
  }
  const mesh_sword_guards_59 = new THREE.Mesh(
    mesh_sword_guards_59Geometry,
    materialMap["gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_sword_guards_59.name = "Gold katana guard";
  if (endpoint_sword_guards_59) {
    mesh_sword_guards_59.position.copy(endpoint_sword_guards_59.midpoint);
    mesh_sword_guards_59.quaternion.copy(endpoint_sword_guards_59.quaternion);
  }
  mesh_sword_guards_59.castShadow = options.castShadow ?? true;
  mesh_sword_guards_59.receiveShadow = options.receiveShadow ?? true;
  mesh_sword_guards_59.userData.sculptComponent = {"id": "sword-guards", "name": "Gold katana guard", "level": "meso", "role": "accessory", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Gold katana guard follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-raised", "attachment": {"anchor": "hand-raised", "maxOffset": 0.18, "contactType": "held-grip", "evidenceRefs": ["full-object"], "notes": "Proximity uses measured geometry centroids, not zero pivots of implicit fields."}, "dimensions": {"width": 0.12, "height": 0.048, "depth": 0.09, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.07750000000000001, -0.08499999999999996, 0], "rotation": [0, 0, -0.55], "scale": [0.12, 0.048, 0.09]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "sword-guards", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}}, "material": "gold", "materialLayers": ["gold"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["sword-guards-observed-contour", {"id": "sword-guards", "description": "Gold multi-lobed guards at three hilts", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(179, 160, 92, 1)", "secondaryAlbedo": "rgba(161, 144, 83, 1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_sword_guards_59.add(mesh_sword_guards_59);
  meshes["sword-guards"] = mesh_sword_guards_59;
  colliders["sword-guards"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["sword-guards"] ??= [];
  destructionGroups["sword-guards"].push(node_sword_guards_59);

  const endpoint_guard_1_60 = makeAttachmentEndpoint(null);
  const node_guard_1_60 = new THREE.Group();
  node_guard_1_60.name = "Gold katana guard__pivot";
  node_guard_1_60.scale.set(1, 1, 1);
  if (endpoint_guard_1_60) {
    node_guard_1_60.position.copy(endpoint_guard_1_60.start);
    node_guard_1_60.rotation.set(0.0, 0.0, -0.55);
  } else {
    node_guard_1_60.position.set(-0.285, 1.685, 0.0);
    node_guard_1_60.rotation.set(0.0, 0.0, -0.55);
  }
  node_guard_1_60.userData.sculptComponent = {"id": "guard-1", "name": "Gold katana guard", "level": "meso", "role": "accessory", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Gold katana guard follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "haramaki", "attachment": {"anchor": "haramaki", "maxOffset": 0.36, "contactType": "waist-mounted", "evidenceRefs": ["full-object"], "notes": "Proximity uses measured geometry centroids, not zero pivots of implicit fields."}, "dimensions": {"width": 0.12, "height": 0.048, "depth": 0.09, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.285, 1.685, 0], "rotation": [0, 0, -0.55], "scale": [0.12, 0.048, 0.09]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "guard-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}}, "material": "gold", "materialLayers": ["gold"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["guard-1-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(179, 160, 92, 1)", "secondaryAlbedo": "rgba(161, 144, 83, 1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_guard_1_60.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "guard-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}};
  (nodes["haramaki"] ?? root).add(node_guard_1_60);
  nodes["guard-1"] = node_guard_1_60;
  const mesh_guard_1_60Geometry = endpoint_guard_1_60
    ? new THREE.CylinderGeometry(endpoint_guard_1_60.endRadius, endpoint_guard_1_60.baseRadius, endpoint_guard_1_60.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_guard_1_60) {
    mesh_guard_1_60Geometry.scale(0.12, 0.048, 0.09);
  }
  const mesh_guard_1_60 = new THREE.Mesh(
    mesh_guard_1_60Geometry,
    materialMap["gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_guard_1_60.name = "Gold katana guard";
  if (endpoint_guard_1_60) {
    mesh_guard_1_60.position.copy(endpoint_guard_1_60.midpoint);
    mesh_guard_1_60.quaternion.copy(endpoint_guard_1_60.quaternion);
  }
  mesh_guard_1_60.castShadow = options.castShadow ?? true;
  mesh_guard_1_60.receiveShadow = options.receiveShadow ?? true;
  mesh_guard_1_60.userData.sculptComponent = {"id": "guard-1", "name": "Gold katana guard", "level": "meso", "role": "accessory", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Gold katana guard follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "haramaki", "attachment": {"anchor": "haramaki", "maxOffset": 0.36, "contactType": "waist-mounted", "evidenceRefs": ["full-object"], "notes": "Proximity uses measured geometry centroids, not zero pivots of implicit fields."}, "dimensions": {"width": 0.12, "height": 0.048, "depth": 0.09, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.285, 1.685, 0], "rotation": [0, 0, -0.55], "scale": [0.12, 0.048, 0.09]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "guard-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}}, "material": "gold", "materialLayers": ["gold"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["guard-1-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(179, 160, 92, 1)", "secondaryAlbedo": "rgba(161, 144, 83, 1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_guard_1_60.add(mesh_guard_1_60);
  meshes["guard-1"] = mesh_guard_1_60;
  colliders["guard-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["guard-1"] ??= [];
  destructionGroups["guard-1"].push(node_guard_1_60);

  const endpoint_guard_2_61 = makeAttachmentEndpoint(null);
  const node_guard_2_61 = new THREE.Group();
  node_guard_2_61.name = "Gold katana guard__pivot";
  node_guard_2_61.scale.set(1, 1, 1);
  if (endpoint_guard_2_61) {
    node_guard_2_61.position.copy(endpoint_guard_2_61.start);
    node_guard_2_61.rotation.set(0.0, 0.0, -0.55);
  } else {
    node_guard_2_61.position.set(0.014999999999999958, -0.11749999999999994, 0.0);
    node_guard_2_61.rotation.set(0.0, 0.0, -0.55);
  }
  node_guard_2_61.userData.sculptComponent = {"id": "guard-2", "name": "Gold katana guard", "level": "meso", "role": "accessory", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Gold katana guard follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-down", "attachment": {"anchor": "hand-down", "maxOffset": 0.2, "contactType": "held-grip", "evidenceRefs": ["full-object"], "notes": "Proximity uses measured geometry centroids, not zero pivots of implicit fields."}, "dimensions": {"width": 0.12, "height": 0.048, "depth": 0.09, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.014999999999999958, -0.11749999999999994, 0], "rotation": [0, 0, -0.55], "scale": [0.12, 0.048, 0.09]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "guard-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}}, "material": "gold", "materialLayers": ["gold"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["guard-2-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(179, 160, 92, 1)", "secondaryAlbedo": "rgba(161, 144, 83, 1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_guard_2_61.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "guard-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}};
  (nodes["hand-down"] ?? root).add(node_guard_2_61);
  nodes["guard-2"] = node_guard_2_61;
  const mesh_guard_2_61Geometry = endpoint_guard_2_61
    ? new THREE.CylinderGeometry(endpoint_guard_2_61.endRadius, endpoint_guard_2_61.baseRadius, endpoint_guard_2_61.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  if (!endpoint_guard_2_61) {
    mesh_guard_2_61Geometry.scale(0.12, 0.048, 0.09);
  }
  const mesh_guard_2_61 = new THREE.Mesh(
    mesh_guard_2_61Geometry,
    materialMap["gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_guard_2_61.name = "Gold katana guard";
  if (endpoint_guard_2_61) {
    mesh_guard_2_61.position.copy(endpoint_guard_2_61.midpoint);
    mesh_guard_2_61.quaternion.copy(endpoint_guard_2_61.quaternion);
  }
  mesh_guard_2_61.castShadow = options.castShadow ?? true;
  mesh_guard_2_61.receiveShadow = options.receiveShadow ?? true;
  mesh_guard_2_61.userData.sculptComponent = {"id": "guard-2", "name": "Gold katana guard", "level": "meso", "role": "accessory", "importance": 0.9, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Gold katana guard follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-down", "attachment": {"anchor": "hand-down", "maxOffset": 0.2, "contactType": "held-grip", "evidenceRefs": ["full-object"], "notes": "Proximity uses measured geometry centroids, not zero pivots of implicit fields."}, "dimensions": {"width": 0.12, "height": 0.048, "depth": 0.09, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.014999999999999958, -0.11749999999999994, 0], "rotation": [0, 0, -0.55], "scale": [0.12, 0.048, 0.09]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "guard-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}}, "material": "gold", "materialLayers": ["gold"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["guard-2-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(179, 160, 92, 1)", "secondaryAlbedo": "rgba(161, 144, 83, 1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_guard_2_61.add(mesh_guard_2_61);
  meshes["guard-2"] = mesh_guard_2_61;
  colliders["guard-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["guard-2"] ??= [];
  destructionGroups["guard-2"].push(node_guard_2_61);

  const endpoint_robe_toggles_62 = makeAttachmentEndpoint(null);
  const node_robe_toggles_62 = new THREE.Group();
  node_robe_toggles_62.name = "Robe front toggle__pivot";
  node_robe_toggles_62.scale.set(1, 1, 1);
  if (endpoint_robe_toggles_62) {
    node_robe_toggles_62.position.copy(endpoint_robe_toggles_62.start);
    node_robe_toggles_62.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_robe_toggles_62.position.set(-0.155, 1.2775, 0.19);
    node_robe_toggles_62.rotation.set(0.0, 0.0, 0.0);
  }
  node_robe_toggles_62.userData.sculptComponent = {"id": "robe-toggles", "name": "Robe front toggle", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Robe front toggle follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.055, "height": 0.014, "depth": 0.018, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.155, 1.2775, 0.19], "rotation": [0, 0, 0], "scale": [0.055, 0.014, 0.018]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "robe-toggles", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}}, "material": "gold", "materialLayers": ["gold"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["robe-toggles-observed-contour", {"id": "robe-toggles", "description": "Four tan double-lobed toggles down robe front", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(179, 160, 92, 1)", "secondaryAlbedo": "rgba(161, 144, 83, 1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_robe_toggles_62.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "robe-toggles", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}};
  (nodes["root"] ?? root).add(node_robe_toggles_62);
  nodes["robe-toggles"] = node_robe_toggles_62;
  const mesh_robe_toggles_62Geometry = endpoint_robe_toggles_62
    ? new THREE.CylinderGeometry(endpoint_robe_toggles_62.endRadius, endpoint_robe_toggles_62.baseRadius, endpoint_robe_toggles_62.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_robe_toggles_62) {
    mesh_robe_toggles_62Geometry.scale(0.055, 0.014, 0.018);
  }
  const mesh_robe_toggles_62 = new THREE.Mesh(
    mesh_robe_toggles_62Geometry,
    materialMap["gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_robe_toggles_62.name = "Robe front toggle";
  if (endpoint_robe_toggles_62) {
    mesh_robe_toggles_62.position.copy(endpoint_robe_toggles_62.midpoint);
    mesh_robe_toggles_62.quaternion.copy(endpoint_robe_toggles_62.quaternion);
  }
  mesh_robe_toggles_62.castShadow = options.castShadow ?? true;
  mesh_robe_toggles_62.receiveShadow = options.receiveShadow ?? true;
  mesh_robe_toggles_62.userData.sculptComponent = {"id": "robe-toggles", "name": "Robe front toggle", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Robe front toggle follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.055, "height": 0.014, "depth": 0.018, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.155, 1.2775, 0.19], "rotation": [0, 0, 0], "scale": [0.055, 0.014, 0.018]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "robe-toggles", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}}, "material": "gold", "materialLayers": ["gold"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["robe-toggles-observed-contour", {"id": "robe-toggles", "description": "Four tan double-lobed toggles down robe front", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(179, 160, 92, 1)", "secondaryAlbedo": "rgba(161, 144, 83, 1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_robe_toggles_62.add(mesh_robe_toggles_62);
  meshes["robe-toggles"] = mesh_robe_toggles_62;
  colliders["robe-toggles"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["robe-toggles"] ??= [];
  destructionGroups["robe-toggles"].push(node_robe_toggles_62);

  const endpoint_toggle_1_63 = makeAttachmentEndpoint(null);
  const node_toggle_1_63 = new THREE.Group();
  node_toggle_1_63.name = "Robe front toggle__pivot";
  node_toggle_1_63.scale.set(1, 1, 1);
  if (endpoint_toggle_1_63) {
    node_toggle_1_63.position.copy(endpoint_toggle_1_63.start);
    node_toggle_1_63.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_toggle_1_63.position.set(-0.1725, 1.1275, 0.19);
    node_toggle_1_63.rotation.set(0.0, 0.0, 0.0);
  }
  node_toggle_1_63.userData.sculptComponent = {"id": "toggle-1", "name": "Robe front toggle", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Robe front toggle follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.055, "height": 0.014, "depth": 0.018, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.1725, 1.1275, 0.19], "rotation": [0, 0, 0], "scale": [0.055, 0.014, 0.018]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "toggle-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}}, "material": "gold", "materialLayers": ["gold"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["toggle-1-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(179, 160, 92, 1)", "secondaryAlbedo": "rgba(161, 144, 83, 1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_toggle_1_63.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "toggle-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}};
  (nodes["root"] ?? root).add(node_toggle_1_63);
  nodes["toggle-1"] = node_toggle_1_63;
  const mesh_toggle_1_63Geometry = endpoint_toggle_1_63
    ? new THREE.CylinderGeometry(endpoint_toggle_1_63.endRadius, endpoint_toggle_1_63.baseRadius, endpoint_toggle_1_63.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_toggle_1_63) {
    mesh_toggle_1_63Geometry.scale(0.055, 0.014, 0.018);
  }
  const mesh_toggle_1_63 = new THREE.Mesh(
    mesh_toggle_1_63Geometry,
    materialMap["gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_toggle_1_63.name = "Robe front toggle";
  if (endpoint_toggle_1_63) {
    mesh_toggle_1_63.position.copy(endpoint_toggle_1_63.midpoint);
    mesh_toggle_1_63.quaternion.copy(endpoint_toggle_1_63.quaternion);
  }
  mesh_toggle_1_63.castShadow = options.castShadow ?? true;
  mesh_toggle_1_63.receiveShadow = options.receiveShadow ?? true;
  mesh_toggle_1_63.userData.sculptComponent = {"id": "toggle-1", "name": "Robe front toggle", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Robe front toggle follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.055, "height": 0.014, "depth": 0.018, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.1725, 1.1275, 0.19], "rotation": [0, 0, 0], "scale": [0.055, 0.014, 0.018]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "toggle-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}}, "material": "gold", "materialLayers": ["gold"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["toggle-1-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(179, 160, 92, 1)", "secondaryAlbedo": "rgba(161, 144, 83, 1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_toggle_1_63.add(mesh_toggle_1_63);
  meshes["toggle-1"] = mesh_toggle_1_63;
  colliders["toggle-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["toggle-1"] ??= [];
  destructionGroups["toggle-1"].push(node_toggle_1_63);

  const endpoint_toggle_2_64 = makeAttachmentEndpoint(null);
  const node_toggle_2_64 = new THREE.Group();
  node_toggle_2_64.name = "Robe front toggle__pivot";
  node_toggle_2_64.scale.set(1, 1, 1);
  if (endpoint_toggle_2_64) {
    node_toggle_2_64.position.copy(endpoint_toggle_2_64.start);
    node_toggle_2_64.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_toggle_2_64.position.set(-0.1975, 0.975, 0.19);
    node_toggle_2_64.rotation.set(0.0, 0.0, 0.0);
  }
  node_toggle_2_64.userData.sculptComponent = {"id": "toggle-2", "name": "Robe front toggle", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Robe front toggle follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.055, "height": 0.014, "depth": 0.018, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.1975, 0.975, 0.19], "rotation": [0, 0, 0], "scale": [0.055, 0.014, 0.018]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "toggle-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}}, "material": "gold", "materialLayers": ["gold"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["toggle-2-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(179, 160, 92, 1)", "secondaryAlbedo": "rgba(161, 144, 83, 1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_toggle_2_64.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "toggle-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}};
  (nodes["root"] ?? root).add(node_toggle_2_64);
  nodes["toggle-2"] = node_toggle_2_64;
  const mesh_toggle_2_64Geometry = endpoint_toggle_2_64
    ? new THREE.CylinderGeometry(endpoint_toggle_2_64.endRadius, endpoint_toggle_2_64.baseRadius, endpoint_toggle_2_64.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_toggle_2_64) {
    mesh_toggle_2_64Geometry.scale(0.055, 0.014, 0.018);
  }
  const mesh_toggle_2_64 = new THREE.Mesh(
    mesh_toggle_2_64Geometry,
    materialMap["gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_toggle_2_64.name = "Robe front toggle";
  if (endpoint_toggle_2_64) {
    mesh_toggle_2_64.position.copy(endpoint_toggle_2_64.midpoint);
    mesh_toggle_2_64.quaternion.copy(endpoint_toggle_2_64.quaternion);
  }
  mesh_toggle_2_64.castShadow = options.castShadow ?? true;
  mesh_toggle_2_64.receiveShadow = options.receiveShadow ?? true;
  mesh_toggle_2_64.userData.sculptComponent = {"id": "toggle-2", "name": "Robe front toggle", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Robe front toggle follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.055, "height": 0.014, "depth": 0.018, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.1975, 0.975, 0.19], "rotation": [0, 0, 0], "scale": [0.055, 0.014, 0.018]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "toggle-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}}, "material": "gold", "materialLayers": ["gold"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["toggle-2-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(179, 160, 92, 1)", "secondaryAlbedo": "rgba(161, 144, 83, 1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_toggle_2_64.add(mesh_toggle_2_64);
  meshes["toggle-2"] = mesh_toggle_2_64;
  colliders["toggle-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["toggle-2"] ??= [];
  destructionGroups["toggle-2"].push(node_toggle_2_64);

  const endpoint_toggle_3_65 = makeAttachmentEndpoint(null);
  const node_toggle_3_65 = new THREE.Group();
  node_toggle_3_65.name = "Robe front toggle__pivot";
  node_toggle_3_65.scale.set(1, 1, 1);
  if (endpoint_toggle_3_65) {
    node_toggle_3_65.position.copy(endpoint_toggle_3_65.start);
    node_toggle_3_65.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_toggle_3_65.position.set(-0.2275, 0.8275, 0.19);
    node_toggle_3_65.rotation.set(0.0, 0.0, 0.0);
  }
  node_toggle_3_65.userData.sculptComponent = {"id": "toggle-3", "name": "Robe front toggle", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Robe front toggle follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.055, "height": 0.014, "depth": 0.018, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.2275, 0.8275, 0.19], "rotation": [0, 0, 0], "scale": [0.055, 0.014, 0.018]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "toggle-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}}, "material": "gold", "materialLayers": ["gold"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["toggle-3-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(179, 160, 92, 1)", "secondaryAlbedo": "rgba(161, 144, 83, 1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_toggle_3_65.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "toggle-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}};
  (nodes["root"] ?? root).add(node_toggle_3_65);
  nodes["toggle-3"] = node_toggle_3_65;
  const mesh_toggle_3_65Geometry = endpoint_toggle_3_65
    ? new THREE.CylinderGeometry(endpoint_toggle_3_65.endRadius, endpoint_toggle_3_65.baseRadius, endpoint_toggle_3_65.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_toggle_3_65) {
    mesh_toggle_3_65Geometry.scale(0.055, 0.014, 0.018);
  }
  const mesh_toggle_3_65 = new THREE.Mesh(
    mesh_toggle_3_65Geometry,
    materialMap["gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_toggle_3_65.name = "Robe front toggle";
  if (endpoint_toggle_3_65) {
    mesh_toggle_3_65.position.copy(endpoint_toggle_3_65.midpoint);
    mesh_toggle_3_65.quaternion.copy(endpoint_toggle_3_65.quaternion);
  }
  mesh_toggle_3_65.castShadow = options.castShadow ?? true;
  mesh_toggle_3_65.receiveShadow = options.receiveShadow ?? true;
  mesh_toggle_3_65.userData.sculptComponent = {"id": "toggle-3", "name": "Robe front toggle", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Robe front toggle follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.055, "height": 0.014, "depth": 0.018, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.2275, 0.8275, 0.19], "rotation": [0, 0, 0], "scale": [0.055, 0.014, 0.018]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "toggle-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}}, "material": "gold", "materialLayers": ["gold"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["toggle-3-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(179, 160, 92, 1)", "secondaryAlbedo": "rgba(161, 144, 83, 1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_toggle_3_65.add(mesh_toggle_3_65);
  meshes["toggle-3"] = mesh_toggle_3_65;
  colliders["toggle-3"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["toggle-3"] ??= [];
  destructionGroups["toggle-3"].push(node_toggle_3_65);

  const endpoint_sword_wrap_66 = makeAttachmentEndpoint(null);
  const node_sword_wrap_66 = new THREE.Group();
  node_sword_wrap_66.name = "Raised grip diamond__pivot";
  node_sword_wrap_66.scale.set(1, 1, 1);
  if (endpoint_sword_wrap_66) {
    node_sword_wrap_66.position.copy(endpoint_sword_wrap_66.start);
    node_sword_wrap_66.rotation.set(0.0, 0.0, 0.78);
  } else {
    node_sword_wrap_66.position.set(-0.43, 2.4625, 0.027);
    node_sword_wrap_66.rotation.set(0.0, 0.0, 0.78);
  }
  node_sword_wrap_66.userData.sculptComponent = {"id": "sword-wrap", "name": "Raised grip diamond", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Raised grip diamond follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.018, "height": 0.012, "depth": 0.004, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.43, 2.4625, 0.027], "rotation": [0, 0, 0.78], "scale": [0.018, 0.012, 0.004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "sword-wrap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}}, "material": "white", "materialLayers": ["white"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["sword-wrap-observed-contour", {"id": "sword-wrap", "description": "Alternating diamonds on dark and white sword grips", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 234, 222, 1)", "secondaryAlbedo": "rgba(214, 211, 200, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_sword_wrap_66.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "sword-wrap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}};
  (nodes["root"] ?? root).add(node_sword_wrap_66);
  nodes["sword-wrap"] = node_sword_wrap_66;
  const mesh_sword_wrap_66Geometry = endpoint_sword_wrap_66
    ? new THREE.CylinderGeometry(endpoint_sword_wrap_66.endRadius, endpoint_sword_wrap_66.baseRadius, endpoint_sword_wrap_66.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_sword_wrap_66) {
    mesh_sword_wrap_66Geometry.scale(0.018, 0.012, 0.004);
  }
  const mesh_sword_wrap_66 = new THREE.Mesh(
    mesh_sword_wrap_66Geometry,
    materialMap["white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_sword_wrap_66.name = "Raised grip diamond";
  if (endpoint_sword_wrap_66) {
    mesh_sword_wrap_66.position.copy(endpoint_sword_wrap_66.midpoint);
    mesh_sword_wrap_66.quaternion.copy(endpoint_sword_wrap_66.quaternion);
  }
  mesh_sword_wrap_66.castShadow = options.castShadow ?? true;
  mesh_sword_wrap_66.receiveShadow = options.receiveShadow ?? true;
  mesh_sword_wrap_66.userData.sculptComponent = {"id": "sword-wrap", "name": "Raised grip diamond", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Raised grip diamond follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.018, "height": 0.012, "depth": 0.004, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.43, 2.4625, 0.027], "rotation": [0, 0, 0.78], "scale": [0.018, 0.012, 0.004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "sword-wrap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}}, "material": "white", "materialLayers": ["white"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["sword-wrap-observed-contour", {"id": "sword-wrap", "description": "Alternating diamonds on dark and white sword grips", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 234, 222, 1)", "secondaryAlbedo": "rgba(214, 211, 200, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_sword_wrap_66.add(mesh_sword_wrap_66);
  meshes["sword-wrap"] = mesh_sword_wrap_66;
  colliders["sword-wrap"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["sword-wrap"] ??= [];
  destructionGroups["sword-wrap"].push(node_sword_wrap_66);

  const endpoint_grip_diamond_1_67 = makeAttachmentEndpoint(null);
  const node_grip_diamond_1_67 = new THREE.Group();
  node_grip_diamond_1_67.name = "Raised grip diamond__pivot";
  node_grip_diamond_1_67.scale.set(1, 1, 1);
  if (endpoint_grip_diamond_1_67) {
    node_grip_diamond_1_67.position.copy(endpoint_grip_diamond_1_67.start);
    node_grip_diamond_1_67.rotation.set(0.0, 0.0, 0.78);
  } else {
    node_grip_diamond_1_67.position.set(-0.405, 2.4375, 0.027);
    node_grip_diamond_1_67.rotation.set(0.0, 0.0, 0.78);
  }
  node_grip_diamond_1_67.userData.sculptComponent = {"id": "grip-diamond-1", "name": "Raised grip diamond", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Raised grip diamond follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.018, "height": 0.012, "depth": 0.004, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.405, 2.4375, 0.027], "rotation": [0, 0, 0.78], "scale": [0.018, 0.012, 0.004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grip-diamond-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}}, "material": "white", "materialLayers": ["white"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["grip-diamond-1-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 234, 222, 1)", "secondaryAlbedo": "rgba(214, 211, 200, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_grip_diamond_1_67.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grip-diamond-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}};
  (nodes["root"] ?? root).add(node_grip_diamond_1_67);
  nodes["grip-diamond-1"] = node_grip_diamond_1_67;
  const mesh_grip_diamond_1_67Geometry = endpoint_grip_diamond_1_67
    ? new THREE.CylinderGeometry(endpoint_grip_diamond_1_67.endRadius, endpoint_grip_diamond_1_67.baseRadius, endpoint_grip_diamond_1_67.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_grip_diamond_1_67) {
    mesh_grip_diamond_1_67Geometry.scale(0.018, 0.012, 0.004);
  }
  const mesh_grip_diamond_1_67 = new THREE.Mesh(
    mesh_grip_diamond_1_67Geometry,
    materialMap["white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_grip_diamond_1_67.name = "Raised grip diamond";
  if (endpoint_grip_diamond_1_67) {
    mesh_grip_diamond_1_67.position.copy(endpoint_grip_diamond_1_67.midpoint);
    mesh_grip_diamond_1_67.quaternion.copy(endpoint_grip_diamond_1_67.quaternion);
  }
  mesh_grip_diamond_1_67.castShadow = options.castShadow ?? true;
  mesh_grip_diamond_1_67.receiveShadow = options.receiveShadow ?? true;
  mesh_grip_diamond_1_67.userData.sculptComponent = {"id": "grip-diamond-1", "name": "Raised grip diamond", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Raised grip diamond follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.018, "height": 0.012, "depth": 0.004, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.405, 2.4375, 0.027], "rotation": [0, 0, 0.78], "scale": [0.018, 0.012, 0.004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grip-diamond-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}}, "material": "white", "materialLayers": ["white"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["grip-diamond-1-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 234, 222, 1)", "secondaryAlbedo": "rgba(214, 211, 200, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_grip_diamond_1_67.add(mesh_grip_diamond_1_67);
  meshes["grip-diamond-1"] = mesh_grip_diamond_1_67;
  colliders["grip-diamond-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["grip-diamond-1"] ??= [];
  destructionGroups["grip-diamond-1"].push(node_grip_diamond_1_67);

  const endpoint_grip_diamond_2_68 = makeAttachmentEndpoint(null);
  const node_grip_diamond_2_68 = new THREE.Group();
  node_grip_diamond_2_68.name = "Raised grip diamond__pivot";
  node_grip_diamond_2_68.scale.set(1, 1, 1);
  if (endpoint_grip_diamond_2_68) {
    node_grip_diamond_2_68.position.copy(endpoint_grip_diamond_2_68.start);
    node_grip_diamond_2_68.rotation.set(0.0, 0.0, 0.78);
  } else {
    node_grip_diamond_2_68.position.set(-0.38, 2.4125, 0.027);
    node_grip_diamond_2_68.rotation.set(0.0, 0.0, 0.78);
  }
  node_grip_diamond_2_68.userData.sculptComponent = {"id": "grip-diamond-2", "name": "Raised grip diamond", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Raised grip diamond follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.018, "height": 0.012, "depth": 0.004, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.38, 2.4125, 0.027], "rotation": [0, 0, 0.78], "scale": [0.018, 0.012, 0.004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grip-diamond-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}}, "material": "white", "materialLayers": ["white"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["grip-diamond-2-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 234, 222, 1)", "secondaryAlbedo": "rgba(214, 211, 200, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_grip_diamond_2_68.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grip-diamond-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}};
  (nodes["root"] ?? root).add(node_grip_diamond_2_68);
  nodes["grip-diamond-2"] = node_grip_diamond_2_68;
  const mesh_grip_diamond_2_68Geometry = endpoint_grip_diamond_2_68
    ? new THREE.CylinderGeometry(endpoint_grip_diamond_2_68.endRadius, endpoint_grip_diamond_2_68.baseRadius, endpoint_grip_diamond_2_68.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_grip_diamond_2_68) {
    mesh_grip_diamond_2_68Geometry.scale(0.018, 0.012, 0.004);
  }
  const mesh_grip_diamond_2_68 = new THREE.Mesh(
    mesh_grip_diamond_2_68Geometry,
    materialMap["white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_grip_diamond_2_68.name = "Raised grip diamond";
  if (endpoint_grip_diamond_2_68) {
    mesh_grip_diamond_2_68.position.copy(endpoint_grip_diamond_2_68.midpoint);
    mesh_grip_diamond_2_68.quaternion.copy(endpoint_grip_diamond_2_68.quaternion);
  }
  mesh_grip_diamond_2_68.castShadow = options.castShadow ?? true;
  mesh_grip_diamond_2_68.receiveShadow = options.receiveShadow ?? true;
  mesh_grip_diamond_2_68.userData.sculptComponent = {"id": "grip-diamond-2", "name": "Raised grip diamond", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Raised grip diamond follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.018, "height": 0.012, "depth": 0.004, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.38, 2.4125, 0.027], "rotation": [0, 0, 0.78], "scale": [0.018, 0.012, 0.004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grip-diamond-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}}, "material": "white", "materialLayers": ["white"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["grip-diamond-2-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 234, 222, 1)", "secondaryAlbedo": "rgba(214, 211, 200, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_grip_diamond_2_68.add(mesh_grip_diamond_2_68);
  meshes["grip-diamond-2"] = mesh_grip_diamond_2_68;
  colliders["grip-diamond-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["grip-diamond-2"] ??= [];
  destructionGroups["grip-diamond-2"].push(node_grip_diamond_2_68);

  const endpoint_grip_diamond_3_69 = makeAttachmentEndpoint(null);
  const node_grip_diamond_3_69 = new THREE.Group();
  node_grip_diamond_3_69.name = "Raised grip diamond__pivot";
  node_grip_diamond_3_69.scale.set(1, 1, 1);
  if (endpoint_grip_diamond_3_69) {
    node_grip_diamond_3_69.position.copy(endpoint_grip_diamond_3_69.start);
    node_grip_diamond_3_69.rotation.set(0.0, 0.0, 0.78);
  } else {
    node_grip_diamond_3_69.position.set(-0.355, 2.3875, 0.027);
    node_grip_diamond_3_69.rotation.set(0.0, 0.0, 0.78);
  }
  node_grip_diamond_3_69.userData.sculptComponent = {"id": "grip-diamond-3", "name": "Raised grip diamond", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Raised grip diamond follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.018, "height": 0.012, "depth": 0.004, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.355, 2.3875, 0.027], "rotation": [0, 0, 0.78], "scale": [0.018, 0.012, 0.004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grip-diamond-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}}, "material": "white", "materialLayers": ["white"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["grip-diamond-3-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 234, 222, 1)", "secondaryAlbedo": "rgba(214, 211, 200, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_grip_diamond_3_69.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grip-diamond-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}};
  (nodes["root"] ?? root).add(node_grip_diamond_3_69);
  nodes["grip-diamond-3"] = node_grip_diamond_3_69;
  const mesh_grip_diamond_3_69Geometry = endpoint_grip_diamond_3_69
    ? new THREE.CylinderGeometry(endpoint_grip_diamond_3_69.endRadius, endpoint_grip_diamond_3_69.baseRadius, endpoint_grip_diamond_3_69.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_grip_diamond_3_69) {
    mesh_grip_diamond_3_69Geometry.scale(0.018, 0.012, 0.004);
  }
  const mesh_grip_diamond_3_69 = new THREE.Mesh(
    mesh_grip_diamond_3_69Geometry,
    materialMap["white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_grip_diamond_3_69.name = "Raised grip diamond";
  if (endpoint_grip_diamond_3_69) {
    mesh_grip_diamond_3_69.position.copy(endpoint_grip_diamond_3_69.midpoint);
    mesh_grip_diamond_3_69.quaternion.copy(endpoint_grip_diamond_3_69.quaternion);
  }
  mesh_grip_diamond_3_69.castShadow = options.castShadow ?? true;
  mesh_grip_diamond_3_69.receiveShadow = options.receiveShadow ?? true;
  mesh_grip_diamond_3_69.userData.sculptComponent = {"id": "grip-diamond-3", "name": "Raised grip diamond", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Raised grip diamond follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.018, "height": 0.012, "depth": 0.004, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.355, 2.3875, 0.027], "rotation": [0, 0, 0.78], "scale": [0.018, 0.012, 0.004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grip-diamond-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}}, "material": "white", "materialLayers": ["white"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["grip-diamond-3-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 234, 222, 1)", "secondaryAlbedo": "rgba(214, 211, 200, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_grip_diamond_3_69.add(mesh_grip_diamond_3_69);
  meshes["grip-diamond-3"] = mesh_grip_diamond_3_69;
  colliders["grip-diamond-3"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["grip-diamond-3"] ??= [];
  destructionGroups["grip-diamond-3"].push(node_grip_diamond_3_69);

  const endpoint_grip_diamond_4_70 = makeAttachmentEndpoint(null);
  const node_grip_diamond_4_70 = new THREE.Group();
  node_grip_diamond_4_70.name = "Raised grip diamond__pivot";
  node_grip_diamond_4_70.scale.set(1, 1, 1);
  if (endpoint_grip_diamond_4_70) {
    node_grip_diamond_4_70.position.copy(endpoint_grip_diamond_4_70.start);
    node_grip_diamond_4_70.rotation.set(0.0, 0.0, 0.78);
  } else {
    node_grip_diamond_4_70.position.set(-0.33, 2.3625, 0.027);
    node_grip_diamond_4_70.rotation.set(0.0, 0.0, 0.78);
  }
  node_grip_diamond_4_70.userData.sculptComponent = {"id": "grip-diamond-4", "name": "Raised grip diamond", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Raised grip diamond follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.018, "height": 0.012, "depth": 0.004, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.33, 2.3625, 0.027], "rotation": [0, 0, 0.78], "scale": [0.018, 0.012, 0.004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grip-diamond-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}}, "material": "white", "materialLayers": ["white"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["grip-diamond-4-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 234, 222, 1)", "secondaryAlbedo": "rgba(214, 211, 200, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_grip_diamond_4_70.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grip-diamond-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}};
  (nodes["root"] ?? root).add(node_grip_diamond_4_70);
  nodes["grip-diamond-4"] = node_grip_diamond_4_70;
  const mesh_grip_diamond_4_70Geometry = endpoint_grip_diamond_4_70
    ? new THREE.CylinderGeometry(endpoint_grip_diamond_4_70.endRadius, endpoint_grip_diamond_4_70.baseRadius, endpoint_grip_diamond_4_70.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_grip_diamond_4_70) {
    mesh_grip_diamond_4_70Geometry.scale(0.018, 0.012, 0.004);
  }
  const mesh_grip_diamond_4_70 = new THREE.Mesh(
    mesh_grip_diamond_4_70Geometry,
    materialMap["white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_grip_diamond_4_70.name = "Raised grip diamond";
  if (endpoint_grip_diamond_4_70) {
    mesh_grip_diamond_4_70.position.copy(endpoint_grip_diamond_4_70.midpoint);
    mesh_grip_diamond_4_70.quaternion.copy(endpoint_grip_diamond_4_70.quaternion);
  }
  mesh_grip_diamond_4_70.castShadow = options.castShadow ?? true;
  mesh_grip_diamond_4_70.receiveShadow = options.receiveShadow ?? true;
  mesh_grip_diamond_4_70.userData.sculptComponent = {"id": "grip-diamond-4", "name": "Raised grip diamond", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Raised grip diamond follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.018, "height": 0.012, "depth": 0.004, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.33, 2.3625, 0.027], "rotation": [0, 0, 0.78], "scale": [0.018, 0.012, 0.004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grip-diamond-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}}, "material": "white", "materialLayers": ["white"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["grip-diamond-4-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 234, 222, 1)", "secondaryAlbedo": "rgba(214, 211, 200, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_grip_diamond_4_70.add(mesh_grip_diamond_4_70);
  meshes["grip-diamond-4"] = mesh_grip_diamond_4_70;
  colliders["grip-diamond-4"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["grip-diamond-4"] ??= [];
  destructionGroups["grip-diamond-4"].push(node_grip_diamond_4_70);

  const endpoint_grip_diamond_5_71 = makeAttachmentEndpoint(null);
  const node_grip_diamond_5_71 = new THREE.Group();
  node_grip_diamond_5_71.name = "Raised grip diamond__pivot";
  node_grip_diamond_5_71.scale.set(1, 1, 1);
  if (endpoint_grip_diamond_5_71) {
    node_grip_diamond_5_71.position.copy(endpoint_grip_diamond_5_71.start);
    node_grip_diamond_5_71.rotation.set(0.0, 0.0, 0.78);
  } else {
    node_grip_diamond_5_71.position.set(-0.305, 2.3375, 0.027);
    node_grip_diamond_5_71.rotation.set(0.0, 0.0, 0.78);
  }
  node_grip_diamond_5_71.userData.sculptComponent = {"id": "grip-diamond-5", "name": "Raised grip diamond", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Raised grip diamond follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.018, "height": 0.012, "depth": 0.004, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.305, 2.3375, 0.027], "rotation": [0, 0, 0.78], "scale": [0.018, 0.012, 0.004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grip-diamond-5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}}, "material": "white", "materialLayers": ["white"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["grip-diamond-5-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 234, 222, 1)", "secondaryAlbedo": "rgba(214, 211, 200, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_grip_diamond_5_71.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grip-diamond-5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}};
  (nodes["root"] ?? root).add(node_grip_diamond_5_71);
  nodes["grip-diamond-5"] = node_grip_diamond_5_71;
  const mesh_grip_diamond_5_71Geometry = endpoint_grip_diamond_5_71
    ? new THREE.CylinderGeometry(endpoint_grip_diamond_5_71.endRadius, endpoint_grip_diamond_5_71.baseRadius, endpoint_grip_diamond_5_71.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_grip_diamond_5_71) {
    mesh_grip_diamond_5_71Geometry.scale(0.018, 0.012, 0.004);
  }
  const mesh_grip_diamond_5_71 = new THREE.Mesh(
    mesh_grip_diamond_5_71Geometry,
    materialMap["white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_grip_diamond_5_71.name = "Raised grip diamond";
  if (endpoint_grip_diamond_5_71) {
    mesh_grip_diamond_5_71.position.copy(endpoint_grip_diamond_5_71.midpoint);
    mesh_grip_diamond_5_71.quaternion.copy(endpoint_grip_diamond_5_71.quaternion);
  }
  mesh_grip_diamond_5_71.castShadow = options.castShadow ?? true;
  mesh_grip_diamond_5_71.receiveShadow = options.receiveShadow ?? true;
  mesh_grip_diamond_5_71.userData.sculptComponent = {"id": "grip-diamond-5", "name": "Raised grip diamond", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Raised grip diamond follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.018, "height": 0.012, "depth": 0.004, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.305, 2.3375, 0.027], "rotation": [0, 0, 0.78], "scale": [0.018, 0.012, 0.004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grip-diamond-5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}}, "material": "white", "materialLayers": ["white"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["grip-diamond-5-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 234, 222, 1)", "secondaryAlbedo": "rgba(214, 211, 200, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_grip_diamond_5_71.add(mesh_grip_diamond_5_71);
  meshes["grip-diamond-5"] = mesh_grip_diamond_5_71;
  colliders["grip-diamond-5"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["grip-diamond-5"] ??= [];
  destructionGroups["grip-diamond-5"].push(node_grip_diamond_5_71);

  const endpoint_grip_diamond_6_72 = makeAttachmentEndpoint(null);
  const node_grip_diamond_6_72 = new THREE.Group();
  node_grip_diamond_6_72.name = "Raised grip diamond__pivot";
  node_grip_diamond_6_72.scale.set(1, 1, 1);
  if (endpoint_grip_diamond_6_72) {
    node_grip_diamond_6_72.position.copy(endpoint_grip_diamond_6_72.start);
    node_grip_diamond_6_72.rotation.set(0.0, 0.0, 0.78);
  } else {
    node_grip_diamond_6_72.position.set(-0.28, 2.3125, 0.027);
    node_grip_diamond_6_72.rotation.set(0.0, 0.0, 0.78);
  }
  node_grip_diamond_6_72.userData.sculptComponent = {"id": "grip-diamond-6", "name": "Raised grip diamond", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Raised grip diamond follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.018, "height": 0.012, "depth": 0.004, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.28, 2.3125, 0.027], "rotation": [0, 0, 0.78], "scale": [0.018, 0.012, 0.004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grip-diamond-6", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}}, "material": "white", "materialLayers": ["white"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["grip-diamond-6-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 234, 222, 1)", "secondaryAlbedo": "rgba(214, 211, 200, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_grip_diamond_6_72.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grip-diamond-6", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}};
  (nodes["root"] ?? root).add(node_grip_diamond_6_72);
  nodes["grip-diamond-6"] = node_grip_diamond_6_72;
  const mesh_grip_diamond_6_72Geometry = endpoint_grip_diamond_6_72
    ? new THREE.CylinderGeometry(endpoint_grip_diamond_6_72.endRadius, endpoint_grip_diamond_6_72.baseRadius, endpoint_grip_diamond_6_72.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_grip_diamond_6_72) {
    mesh_grip_diamond_6_72Geometry.scale(0.018, 0.012, 0.004);
  }
  const mesh_grip_diamond_6_72 = new THREE.Mesh(
    mesh_grip_diamond_6_72Geometry,
    materialMap["white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_grip_diamond_6_72.name = "Raised grip diamond";
  if (endpoint_grip_diamond_6_72) {
    mesh_grip_diamond_6_72.position.copy(endpoint_grip_diamond_6_72.midpoint);
    mesh_grip_diamond_6_72.quaternion.copy(endpoint_grip_diamond_6_72.quaternion);
  }
  mesh_grip_diamond_6_72.castShadow = options.castShadow ?? true;
  mesh_grip_diamond_6_72.receiveShadow = options.receiveShadow ?? true;
  mesh_grip_diamond_6_72.userData.sculptComponent = {"id": "grip-diamond-6", "name": "Raised grip diamond", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Raised grip diamond follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.018, "height": 0.012, "depth": 0.004, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.28, 2.3125, 0.027], "rotation": [0, 0, 0.78], "scale": [0.018, 0.012, 0.004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grip-diamond-6", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}}, "material": "white", "materialLayers": ["white"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["grip-diamond-6-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 234, 222, 1)", "secondaryAlbedo": "rgba(214, 211, 200, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_grip_diamond_6_72.add(mesh_grip_diamond_6_72);
  meshes["grip-diamond-6"] = mesh_grip_diamond_6_72;
  colliders["grip-diamond-6"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["grip-diamond-6"] ??= [];
  destructionGroups["grip-diamond-6"].push(node_grip_diamond_6_72);

  const endpoint_grip_diamond_7_73 = makeAttachmentEndpoint(null);
  const node_grip_diamond_7_73 = new THREE.Group();
  node_grip_diamond_7_73.name = "Raised grip diamond__pivot";
  node_grip_diamond_7_73.scale.set(1, 1, 1);
  if (endpoint_grip_diamond_7_73) {
    node_grip_diamond_7_73.position.copy(endpoint_grip_diamond_7_73.start);
    node_grip_diamond_7_73.rotation.set(0.0, 0.0, 0.78);
  } else {
    node_grip_diamond_7_73.position.set(-0.255, 2.2875, 0.027);
    node_grip_diamond_7_73.rotation.set(0.0, 0.0, 0.78);
  }
  node_grip_diamond_7_73.userData.sculptComponent = {"id": "grip-diamond-7", "name": "Raised grip diamond", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Raised grip diamond follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.018, "height": 0.012, "depth": 0.004, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.255, 2.2875, 0.027], "rotation": [0, 0, 0.78], "scale": [0.018, 0.012, 0.004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grip-diamond-7", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}}, "material": "white", "materialLayers": ["white"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["grip-diamond-7-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 234, 222, 1)", "secondaryAlbedo": "rgba(214, 211, 200, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_grip_diamond_7_73.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grip-diamond-7", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}};
  (nodes["root"] ?? root).add(node_grip_diamond_7_73);
  nodes["grip-diamond-7"] = node_grip_diamond_7_73;
  const mesh_grip_diamond_7_73Geometry = endpoint_grip_diamond_7_73
    ? new THREE.CylinderGeometry(endpoint_grip_diamond_7_73.endRadius, endpoint_grip_diamond_7_73.baseRadius, endpoint_grip_diamond_7_73.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_grip_diamond_7_73) {
    mesh_grip_diamond_7_73Geometry.scale(0.018, 0.012, 0.004);
  }
  const mesh_grip_diamond_7_73 = new THREE.Mesh(
    mesh_grip_diamond_7_73Geometry,
    materialMap["white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_grip_diamond_7_73.name = "Raised grip diamond";
  if (endpoint_grip_diamond_7_73) {
    mesh_grip_diamond_7_73.position.copy(endpoint_grip_diamond_7_73.midpoint);
    mesh_grip_diamond_7_73.quaternion.copy(endpoint_grip_diamond_7_73.quaternion);
  }
  mesh_grip_diamond_7_73.castShadow = options.castShadow ?? true;
  mesh_grip_diamond_7_73.receiveShadow = options.receiveShadow ?? true;
  mesh_grip_diamond_7_73.userData.sculptComponent = {"id": "grip-diamond-7", "name": "Raised grip diamond", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "material-only", "topologyRationale": "Raised grip diamond follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.018, "height": 0.012, "depth": 0.004, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.255, 2.2875, 0.027], "rotation": [0, 0, 0.78], "scale": [0.018, 0.012, 0.004]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "grip-diamond-7", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white"}}, "material": "white", "materialLayers": ["white"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["grip-diamond-7-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(238, 234, 222, 1)", "secondaryAlbedo": "rgba(214, 211, 200, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_grip_diamond_7_73.add(mesh_grip_diamond_7_73);
  meshes["grip-diamond-7"] = mesh_grip_diamond_7_73;
  colliders["grip-diamond-7"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["grip-diamond-7"] ??= [];
  destructionGroups["grip-diamond-7"].push(node_grip_diamond_7_73);

  const endpoint_chest_scar_74 = makeAttachmentEndpoint(null);
  const node_chest_scar_74 = new THREE.Group();
  node_chest_scar_74.name = "Chest scar dash__pivot";
  node_chest_scar_74.scale.set(1, 1, 1);
  if (endpoint_chest_scar_74) {
    node_chest_scar_74.position.copy(endpoint_chest_scar_74.start);
    node_chest_scar_74.rotation.set(0.0, 0.0, -0.65);
  } else {
    node_chest_scar_74.position.set(-0.075, 1.92, 0.098);
    node_chest_scar_74.rotation.set(0.0, 0.0, -0.65);
  }
  node_chest_scar_74.userData.sculptComponent = {"id": "chest-scar", "name": "Chest scar dash", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "Chest scar dash follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.017, "height": 0.003, "depth": 0.003, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.075, 1.92, 0.098], "rotation": [0, 0, -0.65], "scale": [0.017, 0.003, 0.003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-scar", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scar"}}, "material": "scar", "materialLayers": ["scar"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["chest-scar-observed-contour", {"id": "chest-scar", "description": "Diagonal healed scar across bare upper chest", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(134, 85, 65, 1)", "secondaryAlbedo": "rgba(121, 76, 58, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_chest_scar_74.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-scar", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scar"}};
  (nodes["root"] ?? root).add(node_chest_scar_74);
  nodes["chest-scar"] = node_chest_scar_74;
  const mesh_chest_scar_74Geometry = endpoint_chest_scar_74
    ? new THREE.CylinderGeometry(endpoint_chest_scar_74.endRadius, endpoint_chest_scar_74.baseRadius, endpoint_chest_scar_74.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_chest_scar_74) {
    mesh_chest_scar_74Geometry.scale(0.017, 0.003, 0.003);
  }
  const mesh_chest_scar_74 = new THREE.Mesh(
    mesh_chest_scar_74Geometry,
    materialMap["scar"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chest_scar_74.name = "Chest scar dash";
  if (endpoint_chest_scar_74) {
    mesh_chest_scar_74.position.copy(endpoint_chest_scar_74.midpoint);
    mesh_chest_scar_74.quaternion.copy(endpoint_chest_scar_74.quaternion);
  }
  mesh_chest_scar_74.castShadow = options.castShadow ?? true;
  mesh_chest_scar_74.receiveShadow = options.receiveShadow ?? true;
  mesh_chest_scar_74.userData.sculptComponent = {"id": "chest-scar", "name": "Chest scar dash", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "Chest scar dash follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.017, "height": 0.003, "depth": 0.003, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.075, 1.92, 0.098], "rotation": [0, 0, -0.65], "scale": [0.017, 0.003, 0.003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-scar", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scar"}}, "material": "scar", "materialLayers": ["scar"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["chest-scar-observed-contour", {"id": "chest-scar", "description": "Diagonal healed scar across bare upper chest", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(134, 85, 65, 1)", "secondaryAlbedo": "rgba(121, 76, 58, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_chest_scar_74.add(mesh_chest_scar_74);
  meshes["chest-scar"] = mesh_chest_scar_74;
  colliders["chest-scar"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["chest-scar"] ??= [];
  destructionGroups["chest-scar"].push(node_chest_scar_74);

  const endpoint_chest_stitch_1_75 = makeAttachmentEndpoint(null);
  const node_chest_stitch_1_75 = new THREE.Group();
  node_chest_stitch_1_75.name = "Chest scar dash__pivot";
  node_chest_stitch_1_75.scale.set(1, 1, 1);
  if (endpoint_chest_stitch_1_75) {
    node_chest_stitch_1_75.position.copy(endpoint_chest_stitch_1_75.start);
    node_chest_stitch_1_75.rotation.set(0.0, 0.0, -0.65);
  } else {
    node_chest_stitch_1_75.position.set(-0.0525, 1.94, 0.098);
    node_chest_stitch_1_75.rotation.set(0.0, 0.0, -0.65);
  }
  node_chest_stitch_1_75.userData.sculptComponent = {"id": "chest-stitch-1", "name": "Chest scar dash", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "Chest scar dash follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.017, "height": 0.003, "depth": 0.003, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.0525, 1.94, 0.098], "rotation": [0, 0, -0.65], "scale": [0.017, 0.003, 0.003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-stitch-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scar"}}, "material": "scar", "materialLayers": ["scar"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["chest-stitch-1-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(134, 85, 65, 1)", "secondaryAlbedo": "rgba(121, 76, 58, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_chest_stitch_1_75.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-stitch-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scar"}};
  (nodes["root"] ?? root).add(node_chest_stitch_1_75);
  nodes["chest-stitch-1"] = node_chest_stitch_1_75;
  const mesh_chest_stitch_1_75Geometry = endpoint_chest_stitch_1_75
    ? new THREE.CylinderGeometry(endpoint_chest_stitch_1_75.endRadius, endpoint_chest_stitch_1_75.baseRadius, endpoint_chest_stitch_1_75.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_chest_stitch_1_75) {
    mesh_chest_stitch_1_75Geometry.scale(0.017, 0.003, 0.003);
  }
  const mesh_chest_stitch_1_75 = new THREE.Mesh(
    mesh_chest_stitch_1_75Geometry,
    materialMap["scar"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chest_stitch_1_75.name = "Chest scar dash";
  if (endpoint_chest_stitch_1_75) {
    mesh_chest_stitch_1_75.position.copy(endpoint_chest_stitch_1_75.midpoint);
    mesh_chest_stitch_1_75.quaternion.copy(endpoint_chest_stitch_1_75.quaternion);
  }
  mesh_chest_stitch_1_75.castShadow = options.castShadow ?? true;
  mesh_chest_stitch_1_75.receiveShadow = options.receiveShadow ?? true;
  mesh_chest_stitch_1_75.userData.sculptComponent = {"id": "chest-stitch-1", "name": "Chest scar dash", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "Chest scar dash follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.017, "height": 0.003, "depth": 0.003, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.0525, 1.94, 0.098], "rotation": [0, 0, -0.65], "scale": [0.017, 0.003, 0.003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-stitch-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scar"}}, "material": "scar", "materialLayers": ["scar"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["chest-stitch-1-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(134, 85, 65, 1)", "secondaryAlbedo": "rgba(121, 76, 58, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_chest_stitch_1_75.add(mesh_chest_stitch_1_75);
  meshes["chest-stitch-1"] = mesh_chest_stitch_1_75;
  colliders["chest-stitch-1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["chest-stitch-1"] ??= [];
  destructionGroups["chest-stitch-1"].push(node_chest_stitch_1_75);

  const endpoint_chest_stitch_2_76 = makeAttachmentEndpoint(null);
  const node_chest_stitch_2_76 = new THREE.Group();
  node_chest_stitch_2_76.name = "Chest scar dash__pivot";
  node_chest_stitch_2_76.scale.set(1, 1, 1);
  if (endpoint_chest_stitch_2_76) {
    node_chest_stitch_2_76.position.copy(endpoint_chest_stitch_2_76.start);
    node_chest_stitch_2_76.rotation.set(0.0, 0.0, -0.65);
  } else {
    node_chest_stitch_2_76.position.set(-0.03, 1.96, 0.098);
    node_chest_stitch_2_76.rotation.set(0.0, 0.0, -0.65);
  }
  node_chest_stitch_2_76.userData.sculptComponent = {"id": "chest-stitch-2", "name": "Chest scar dash", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "Chest scar dash follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.017, "height": 0.003, "depth": 0.003, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.03, 1.96, 0.098], "rotation": [0, 0, -0.65], "scale": [0.017, 0.003, 0.003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-stitch-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scar"}}, "material": "scar", "materialLayers": ["scar"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["chest-stitch-2-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(134, 85, 65, 1)", "secondaryAlbedo": "rgba(121, 76, 58, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_chest_stitch_2_76.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-stitch-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scar"}};
  (nodes["root"] ?? root).add(node_chest_stitch_2_76);
  nodes["chest-stitch-2"] = node_chest_stitch_2_76;
  const mesh_chest_stitch_2_76Geometry = endpoint_chest_stitch_2_76
    ? new THREE.CylinderGeometry(endpoint_chest_stitch_2_76.endRadius, endpoint_chest_stitch_2_76.baseRadius, endpoint_chest_stitch_2_76.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_chest_stitch_2_76) {
    mesh_chest_stitch_2_76Geometry.scale(0.017, 0.003, 0.003);
  }
  const mesh_chest_stitch_2_76 = new THREE.Mesh(
    mesh_chest_stitch_2_76Geometry,
    materialMap["scar"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chest_stitch_2_76.name = "Chest scar dash";
  if (endpoint_chest_stitch_2_76) {
    mesh_chest_stitch_2_76.position.copy(endpoint_chest_stitch_2_76.midpoint);
    mesh_chest_stitch_2_76.quaternion.copy(endpoint_chest_stitch_2_76.quaternion);
  }
  mesh_chest_stitch_2_76.castShadow = options.castShadow ?? true;
  mesh_chest_stitch_2_76.receiveShadow = options.receiveShadow ?? true;
  mesh_chest_stitch_2_76.userData.sculptComponent = {"id": "chest-stitch-2", "name": "Chest scar dash", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "Chest scar dash follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.017, "height": 0.003, "depth": 0.003, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.03, 1.96, 0.098], "rotation": [0, 0, -0.65], "scale": [0.017, 0.003, 0.003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-stitch-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scar"}}, "material": "scar", "materialLayers": ["scar"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["chest-stitch-2-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(134, 85, 65, 1)", "secondaryAlbedo": "rgba(121, 76, 58, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_chest_stitch_2_76.add(mesh_chest_stitch_2_76);
  meshes["chest-stitch-2"] = mesh_chest_stitch_2_76;
  colliders["chest-stitch-2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["chest-stitch-2"] ??= [];
  destructionGroups["chest-stitch-2"].push(node_chest_stitch_2_76);

  const endpoint_chest_stitch_3_77 = makeAttachmentEndpoint(null);
  const node_chest_stitch_3_77 = new THREE.Group();
  node_chest_stitch_3_77.name = "Chest scar dash__pivot";
  node_chest_stitch_3_77.scale.set(1, 1, 1);
  if (endpoint_chest_stitch_3_77) {
    node_chest_stitch_3_77.position.copy(endpoint_chest_stitch_3_77.start);
    node_chest_stitch_3_77.rotation.set(0.0, 0.0, -0.65);
  } else {
    node_chest_stitch_3_77.position.set(-0.0075, 1.98, 0.098);
    node_chest_stitch_3_77.rotation.set(0.0, 0.0, -0.65);
  }
  node_chest_stitch_3_77.userData.sculptComponent = {"id": "chest-stitch-3", "name": "Chest scar dash", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "Chest scar dash follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.017, "height": 0.003, "depth": 0.003, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.0075, 1.98, 0.098], "rotation": [0, 0, -0.65], "scale": [0.017, 0.003, 0.003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-stitch-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scar"}}, "material": "scar", "materialLayers": ["scar"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["chest-stitch-3-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(134, 85, 65, 1)", "secondaryAlbedo": "rgba(121, 76, 58, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_chest_stitch_3_77.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-stitch-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scar"}};
  (nodes["root"] ?? root).add(node_chest_stitch_3_77);
  nodes["chest-stitch-3"] = node_chest_stitch_3_77;
  const mesh_chest_stitch_3_77Geometry = endpoint_chest_stitch_3_77
    ? new THREE.CylinderGeometry(endpoint_chest_stitch_3_77.endRadius, endpoint_chest_stitch_3_77.baseRadius, endpoint_chest_stitch_3_77.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_chest_stitch_3_77) {
    mesh_chest_stitch_3_77Geometry.scale(0.017, 0.003, 0.003);
  }
  const mesh_chest_stitch_3_77 = new THREE.Mesh(
    mesh_chest_stitch_3_77Geometry,
    materialMap["scar"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chest_stitch_3_77.name = "Chest scar dash";
  if (endpoint_chest_stitch_3_77) {
    mesh_chest_stitch_3_77.position.copy(endpoint_chest_stitch_3_77.midpoint);
    mesh_chest_stitch_3_77.quaternion.copy(endpoint_chest_stitch_3_77.quaternion);
  }
  mesh_chest_stitch_3_77.castShadow = options.castShadow ?? true;
  mesh_chest_stitch_3_77.receiveShadow = options.receiveShadow ?? true;
  mesh_chest_stitch_3_77.userData.sculptComponent = {"id": "chest-stitch-3", "name": "Chest scar dash", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "Chest scar dash follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.017, "height": 0.003, "depth": 0.003, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.0075, 1.98, 0.098], "rotation": [0, 0, -0.65], "scale": [0.017, 0.003, 0.003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-stitch-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scar"}}, "material": "scar", "materialLayers": ["scar"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["chest-stitch-3-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(134, 85, 65, 1)", "secondaryAlbedo": "rgba(121, 76, 58, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_chest_stitch_3_77.add(mesh_chest_stitch_3_77);
  meshes["chest-stitch-3"] = mesh_chest_stitch_3_77;
  colliders["chest-stitch-3"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["chest-stitch-3"] ??= [];
  destructionGroups["chest-stitch-3"].push(node_chest_stitch_3_77);

  const endpoint_chest_stitch_4_78 = makeAttachmentEndpoint(null);
  const node_chest_stitch_4_78 = new THREE.Group();
  node_chest_stitch_4_78.name = "Chest scar dash__pivot";
  node_chest_stitch_4_78.scale.set(1, 1, 1);
  if (endpoint_chest_stitch_4_78) {
    node_chest_stitch_4_78.position.copy(endpoint_chest_stitch_4_78.start);
    node_chest_stitch_4_78.rotation.set(0.0, 0.0, -0.65);
  } else {
    node_chest_stitch_4_78.position.set(0.015, 2.0, 0.098);
    node_chest_stitch_4_78.rotation.set(0.0, 0.0, -0.65);
  }
  node_chest_stitch_4_78.userData.sculptComponent = {"id": "chest-stitch-4", "name": "Chest scar dash", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "Chest scar dash follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.017, "height": 0.003, "depth": 0.003, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.015, 2.0, 0.098], "rotation": [0, 0, -0.65], "scale": [0.017, 0.003, 0.003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-stitch-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scar"}}, "material": "scar", "materialLayers": ["scar"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["chest-stitch-4-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(134, 85, 65, 1)", "secondaryAlbedo": "rgba(121, 76, 58, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_chest_stitch_4_78.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-stitch-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scar"}};
  (nodes["root"] ?? root).add(node_chest_stitch_4_78);
  nodes["chest-stitch-4"] = node_chest_stitch_4_78;
  const mesh_chest_stitch_4_78Geometry = endpoint_chest_stitch_4_78
    ? new THREE.CylinderGeometry(endpoint_chest_stitch_4_78.endRadius, endpoint_chest_stitch_4_78.baseRadius, endpoint_chest_stitch_4_78.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_chest_stitch_4_78) {
    mesh_chest_stitch_4_78Geometry.scale(0.017, 0.003, 0.003);
  }
  const mesh_chest_stitch_4_78 = new THREE.Mesh(
    mesh_chest_stitch_4_78Geometry,
    materialMap["scar"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chest_stitch_4_78.name = "Chest scar dash";
  if (endpoint_chest_stitch_4_78) {
    mesh_chest_stitch_4_78.position.copy(endpoint_chest_stitch_4_78.midpoint);
    mesh_chest_stitch_4_78.quaternion.copy(endpoint_chest_stitch_4_78.quaternion);
  }
  mesh_chest_stitch_4_78.castShadow = options.castShadow ?? true;
  mesh_chest_stitch_4_78.receiveShadow = options.receiveShadow ?? true;
  mesh_chest_stitch_4_78.userData.sculptComponent = {"id": "chest-stitch-4", "name": "Chest scar dash", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "Chest scar dash follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.017, "height": 0.003, "depth": 0.003, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.015, 2.0, 0.098], "rotation": [0, 0, -0.65], "scale": [0.017, 0.003, 0.003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-stitch-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scar"}}, "material": "scar", "materialLayers": ["scar"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["chest-stitch-4-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(134, 85, 65, 1)", "secondaryAlbedo": "rgba(121, 76, 58, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_chest_stitch_4_78.add(mesh_chest_stitch_4_78);
  meshes["chest-stitch-4"] = mesh_chest_stitch_4_78;
  colliders["chest-stitch-4"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["chest-stitch-4"] ??= [];
  destructionGroups["chest-stitch-4"].push(node_chest_stitch_4_78);

  const endpoint_chest_stitch_5_79 = makeAttachmentEndpoint(null);
  const node_chest_stitch_5_79 = new THREE.Group();
  node_chest_stitch_5_79.name = "Chest scar dash__pivot";
  node_chest_stitch_5_79.scale.set(1, 1, 1);
  if (endpoint_chest_stitch_5_79) {
    node_chest_stitch_5_79.position.copy(endpoint_chest_stitch_5_79.start);
    node_chest_stitch_5_79.rotation.set(0.0, 0.0, -0.65);
  } else {
    node_chest_stitch_5_79.position.set(0.0375, 2.02, 0.098);
    node_chest_stitch_5_79.rotation.set(0.0, 0.0, -0.65);
  }
  node_chest_stitch_5_79.userData.sculptComponent = {"id": "chest-stitch-5", "name": "Chest scar dash", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "Chest scar dash follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.017, "height": 0.003, "depth": 0.003, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0375, 2.02, 0.098], "rotation": [0, 0, -0.65], "scale": [0.017, 0.003, 0.003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-stitch-5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scar"}}, "material": "scar", "materialLayers": ["scar"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["chest-stitch-5-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(134, 85, 65, 1)", "secondaryAlbedo": "rgba(121, 76, 58, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_chest_stitch_5_79.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-stitch-5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scar"}};
  (nodes["root"] ?? root).add(node_chest_stitch_5_79);
  nodes["chest-stitch-5"] = node_chest_stitch_5_79;
  const mesh_chest_stitch_5_79Geometry = endpoint_chest_stitch_5_79
    ? new THREE.CylinderGeometry(endpoint_chest_stitch_5_79.endRadius, endpoint_chest_stitch_5_79.baseRadius, endpoint_chest_stitch_5_79.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_chest_stitch_5_79) {
    mesh_chest_stitch_5_79Geometry.scale(0.017, 0.003, 0.003);
  }
  const mesh_chest_stitch_5_79 = new THREE.Mesh(
    mesh_chest_stitch_5_79Geometry,
    materialMap["scar"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chest_stitch_5_79.name = "Chest scar dash";
  if (endpoint_chest_stitch_5_79) {
    mesh_chest_stitch_5_79.position.copy(endpoint_chest_stitch_5_79.midpoint);
    mesh_chest_stitch_5_79.quaternion.copy(endpoint_chest_stitch_5_79.quaternion);
  }
  mesh_chest_stitch_5_79.castShadow = options.castShadow ?? true;
  mesh_chest_stitch_5_79.receiveShadow = options.receiveShadow ?? true;
  mesh_chest_stitch_5_79.userData.sculptComponent = {"id": "chest-stitch-5", "name": "Chest scar dash", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "Chest scar dash follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.017, "height": 0.003, "depth": 0.003, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.0375, 2.02, 0.098], "rotation": [0, 0, -0.65], "scale": [0.017, 0.003, 0.003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-stitch-5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scar"}}, "material": "scar", "materialLayers": ["scar"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["chest-stitch-5-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(134, 85, 65, 1)", "secondaryAlbedo": "rgba(121, 76, 58, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_chest_stitch_5_79.add(mesh_chest_stitch_5_79);
  meshes["chest-stitch-5"] = mesh_chest_stitch_5_79;
  colliders["chest-stitch-5"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["chest-stitch-5"] ??= [];
  destructionGroups["chest-stitch-5"].push(node_chest_stitch_5_79);

  const endpoint_chest_stitch_6_80 = makeAttachmentEndpoint(null);
  const node_chest_stitch_6_80 = new THREE.Group();
  node_chest_stitch_6_80.name = "Chest scar dash__pivot";
  node_chest_stitch_6_80.scale.set(1, 1, 1);
  if (endpoint_chest_stitch_6_80) {
    node_chest_stitch_6_80.position.copy(endpoint_chest_stitch_6_80.start);
    node_chest_stitch_6_80.rotation.set(0.0, 0.0, -0.65);
  } else {
    node_chest_stitch_6_80.position.set(0.06, 2.04, 0.098);
    node_chest_stitch_6_80.rotation.set(0.0, 0.0, -0.65);
  }
  node_chest_stitch_6_80.userData.sculptComponent = {"id": "chest-stitch-6", "name": "Chest scar dash", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "Chest scar dash follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.017, "height": 0.003, "depth": 0.003, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.06, 2.04, 0.098], "rotation": [0, 0, -0.65], "scale": [0.017, 0.003, 0.003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-stitch-6", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scar"}}, "material": "scar", "materialLayers": ["scar"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["chest-stitch-6-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(134, 85, 65, 1)", "secondaryAlbedo": "rgba(121, 76, 58, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_chest_stitch_6_80.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-stitch-6", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scar"}};
  (nodes["root"] ?? root).add(node_chest_stitch_6_80);
  nodes["chest-stitch-6"] = node_chest_stitch_6_80;
  const mesh_chest_stitch_6_80Geometry = endpoint_chest_stitch_6_80
    ? new THREE.CylinderGeometry(endpoint_chest_stitch_6_80.endRadius, endpoint_chest_stitch_6_80.baseRadius, endpoint_chest_stitch_6_80.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_chest_stitch_6_80) {
    mesh_chest_stitch_6_80Geometry.scale(0.017, 0.003, 0.003);
  }
  const mesh_chest_stitch_6_80 = new THREE.Mesh(
    mesh_chest_stitch_6_80Geometry,
    materialMap["scar"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_chest_stitch_6_80.name = "Chest scar dash";
  if (endpoint_chest_stitch_6_80) {
    mesh_chest_stitch_6_80.position.copy(endpoint_chest_stitch_6_80.midpoint);
    mesh_chest_stitch_6_80.quaternion.copy(endpoint_chest_stitch_6_80.quaternion);
  }
  mesh_chest_stitch_6_80.castShadow = options.castShadow ?? true;
  mesh_chest_stitch_6_80.receiveShadow = options.receiveShadow ?? true;
  mesh_chest_stitch_6_80.userData.sculptComponent = {"id": "chest-stitch-6", "name": "Chest scar dash", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "Chest scar dash follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "stylized character part", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.017, "height": 0.003, "depth": 0.003, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.06, 2.04, 0.098], "rotation": [0, 0, -0.65], "scale": [0.017, 0.003, 0.003]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-stitch-6", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scar"}}, "material": "scar", "materialLayers": ["scar"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["chest-stitch-6-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(134, 85, 65, 1)", "secondaryAlbedo": "rgba(121, 76, 58, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_chest_stitch_6_80.add(mesh_chest_stitch_6_80);
  meshes["chest-stitch-6"] = mesh_chest_stitch_6_80;
  colliders["chest-stitch-6"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["chest-stitch-6"] ??= [];
  destructionGroups["chest-stitch-6"].push(node_chest_stitch_6_80);

  const endpoint_ivory_sheath_81 = makeAttachmentEndpoint(null);
  const node_ivory_sheath_81 = new THREE.Group();
  node_ivory_sheath_81.name = "ivory sheath__pivot";
  node_ivory_sheath_81.scale.set(1, 1, 1);
  if (endpoint_ivory_sheath_81) {
    node_ivory_sheath_81.position.copy(endpoint_ivory_sheath_81.start);
    node_ivory_sheath_81.rotation.set(0.0, 0.0, -2.4364813054753616);
  } else {
    node_ivory_sheath_81.position.set(-0.2775, 1.685, 0.0);
    node_ivory_sheath_81.rotation.set(0.0, 0.0, -2.4364813054753616);
  }
  node_ivory_sheath_81.userData.sculptComponent = {"id": "ivory-sheath", "name": "ivory sheath", "level": "meso", "role": "accessory", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "ivory sheath follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "Blunt-ended closed scabbard with a rectangular-to-oval section; observed endpoint.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "profile2D": {"points": [[-0.0315, 0], [0.0315, 0], [0.029609999999999997, 1.234341929936758], [-0.029609999999999997, 1.234341929936758]], "depth": 0.038}}, "parent": "haramaki", "attachment": {"anchor": "haramaki", "maxOffset": 0.75, "contactType": "waist-mounted", "evidenceRefs": ["full-object"], "notes": "Proximity uses measured geometry centroids, not zero pivots of implicit fields."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.2775, 1.685, 0], "rotation": [0, 0, -2.4364813054753616], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ivory-sheath", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scabbardIvory"}}, "material": "scabbardIvory", "materialLayers": ["scabbardIvory"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["ivory-sheath-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(189, 194, 169, 1)", "secondaryAlbedo": "rgba(170, 175, 152, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_ivory_sheath_81.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ivory-sheath", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scabbardIvory"}};
  (nodes["haramaki"] ?? root).add(node_ivory_sheath_81);
  nodes["ivory-sheath"] = node_ivory_sheath_81;
  const mesh_ivory_sheath_81Geometry = endpoint_ivory_sheath_81
    ? new THREE.CylinderGeometry(endpoint_ivory_sheath_81.endRadius, endpoint_ivory_sheath_81.baseRadius, endpoint_ivory_sheath_81.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.0315, 0], [0.0315, 0], [0.029609999999999997, 1.234341929936758], [-0.029609999999999997, 1.234341929936758]], "depth": 0.038});
  if (!endpoint_ivory_sheath_81) {
    mesh_ivory_sheath_81Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_ivory_sheath_81 = new THREE.Mesh(
    mesh_ivory_sheath_81Geometry,
    materialMap["scabbardIvory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ivory_sheath_81.name = "ivory sheath";
  if (endpoint_ivory_sheath_81) {
    mesh_ivory_sheath_81.position.copy(endpoint_ivory_sheath_81.midpoint);
    mesh_ivory_sheath_81.quaternion.copy(endpoint_ivory_sheath_81.quaternion);
  }
  mesh_ivory_sheath_81.castShadow = options.castShadow ?? true;
  mesh_ivory_sheath_81.receiveShadow = options.receiveShadow ?? true;
  mesh_ivory_sheath_81.userData.sculptComponent = {"id": "ivory-sheath", "name": "ivory sheath", "level": "meso", "role": "accessory", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "ivory sheath follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "Blunt-ended closed scabbard with a rectangular-to-oval section; observed endpoint.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "profile2D": {"points": [[-0.0315, 0], [0.0315, 0], [0.029609999999999997, 1.234341929936758], [-0.029609999999999997, 1.234341929936758]], "depth": 0.038}}, "parent": "haramaki", "attachment": {"anchor": "haramaki", "maxOffset": 0.75, "contactType": "waist-mounted", "evidenceRefs": ["full-object"], "notes": "Proximity uses measured geometry centroids, not zero pivots of implicit fields."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.2775, 1.685, 0], "rotation": [0, 0, -2.4364813054753616], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ivory-sheath", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scabbardIvory"}}, "material": "scabbardIvory", "materialLayers": ["scabbardIvory"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["ivory-sheath-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(189, 194, 169, 1)", "secondaryAlbedo": "rgba(170, 175, 152, 1)", "materialClass": "unknown", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_ivory_sheath_81.add(mesh_ivory_sheath_81);
  meshes["ivory-sheath"] = mesh_ivory_sheath_81;
  colliders["ivory-sheath"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["ivory-sheath"] ??= [];
  destructionGroups["ivory-sheath"].push(node_ivory_sheath_81);

  const endpoint_red_sheath_82 = makeAttachmentEndpoint(null);
  const node_red_sheath_82 = new THREE.Group();
  node_red_sheath_82.name = "red sheath__pivot";
  node_red_sheath_82.scale.set(1, 1, 1);
  if (endpoint_red_sheath_82) {
    node_red_sheath_82.position.copy(endpoint_red_sheath_82.start);
    node_red_sheath_82.rotation.set(0.0, 0.0, -2.549377331414203);
  } else {
    node_red_sheath_82.position.set(-0.2875, 1.6525, 0.0);
    node_red_sheath_82.rotation.set(0.0, 0.0, -2.549377331414203);
  }
  node_red_sheath_82.userData.sculptComponent = {"id": "red-sheath", "name": "red sheath", "level": "meso", "role": "accessory", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "red sheath follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "Blunt-ended closed scabbard with a rectangular-to-oval section; observed endpoint.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "profile2D": {"points": [[-0.024, 0], [0.024, 0], [0.02256, 1.3167312747861653], [-0.02256, 1.3167312747861653]], "depth": 0.034}}, "parent": "haramaki", "attachment": {"anchor": "haramaki", "maxOffset": 0.85, "contactType": "waist-mounted", "evidenceRefs": ["full-object"], "notes": "Proximity uses measured geometry centroids, not zero pivots of implicit fields."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.2875, 1.6525, 0], "rotation": [0, 0, -2.549377331414203], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "red-sheath", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scabbardRed"}}, "material": "scabbardRed", "materialLayers": ["scabbardRed"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["red-sheath-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 59, 52, 1)", "secondaryAlbedo": "rgba(125, 53, 47, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_red_sheath_82.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "red-sheath", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scabbardRed"}};
  (nodes["haramaki"] ?? root).add(node_red_sheath_82);
  nodes["red-sheath"] = node_red_sheath_82;
  const mesh_red_sheath_82Geometry = endpoint_red_sheath_82
    ? new THREE.CylinderGeometry(endpoint_red_sheath_82.endRadius, endpoint_red_sheath_82.baseRadius, endpoint_red_sheath_82.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.024, 0], [0.024, 0], [0.02256, 1.3167312747861653], [-0.02256, 1.3167312747861653]], "depth": 0.034});
  if (!endpoint_red_sheath_82) {
    mesh_red_sheath_82Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_red_sheath_82 = new THREE.Mesh(
    mesh_red_sheath_82Geometry,
    materialMap["scabbardRed"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_red_sheath_82.name = "red sheath";
  if (endpoint_red_sheath_82) {
    mesh_red_sheath_82.position.copy(endpoint_red_sheath_82.midpoint);
    mesh_red_sheath_82.quaternion.copy(endpoint_red_sheath_82.quaternion);
  }
  mesh_red_sheath_82.castShadow = options.castShadow ?? true;
  mesh_red_sheath_82.receiveShadow = options.receiveShadow ?? true;
  mesh_red_sheath_82.userData.sculptComponent = {"id": "red-sheath", "name": "red sheath", "level": "meso", "role": "accessory", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "red sheath follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "Blunt-ended closed scabbard with a rectangular-to-oval section; observed endpoint.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "profile2D": {"points": [[-0.024, 0], [0.024, 0], [0.02256, 1.3167312747861653], [-0.02256, 1.3167312747861653]], "depth": 0.034}}, "parent": "haramaki", "attachment": {"anchor": "haramaki", "maxOffset": 0.85, "contactType": "waist-mounted", "evidenceRefs": ["full-object"], "notes": "Proximity uses measured geometry centroids, not zero pivots of implicit fields."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.2875, 1.6525, 0], "rotation": [0, 0, -2.549377331414203], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "red-sheath", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "scabbardRed"}}, "material": "scabbardRed", "materialLayers": ["scabbardRed"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["red-sheath-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 59, 52, 1)", "secondaryAlbedo": "rgba(125, 53, 47, 1)", "materialClass": "fabric", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_red_sheath_82.add(mesh_red_sheath_82);
  meshes["red-sheath"] = mesh_red_sheath_82;
  colliders["red-sheath"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["red-sheath"] ??= [];
  destructionGroups["red-sheath"].push(node_red_sheath_82);

  const endpoint_ivory_sheath_cap_83 = makeAttachmentEndpoint(null);
  const node_ivory_sheath_cap_83 = new THREE.Group();
  node_ivory_sheath_cap_83.name = "ivory sheath cap__pivot";
  node_ivory_sheath_cap_83.scale.set(1, 1, 1);
  if (endpoint_ivory_sheath_cap_83) {
    node_ivory_sheath_cap_83.position.copy(endpoint_ivory_sheath_cap_83.start);
    node_ivory_sheath_cap_83.rotation.set(0.0, 0.0, -2.459276098715046);
  } else {
    node_ivory_sheath_cap_83.position.set(0.49, 0.785, 0.0);
    node_ivory_sheath_cap_83.rotation.set(0.0, 0.0, -2.459276098715046);
  }
  node_ivory_sheath_cap_83.userData.sculptComponent = {"id": "ivory-sheath-cap", "name": "ivory sheath cap", "level": "meso", "role": "accessory", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "ivory sheath cap follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "Blunt-ended closed scabbard with a rectangular-to-oval section; observed endpoint.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "profile2D": {"points": [[-0.036, 0], [0.036, 0], [0.033839999999999995, 0.051538820320220766], [-0.033839999999999995, 0.051538820320220766]], "depth": 0.043}}, "parent": "haramaki", "attachment": {"anchor": "haramaki", "maxOffset": 1.3, "contactType": "waist-mounted", "evidenceRefs": ["full-object"], "notes": "Proximity uses measured geometry centroids, not zero pivots of implicit fields."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.49, 0.785, 0], "rotation": [0, 0, -2.459276098715046], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ivory-sheath-cap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}}, "material": "gold", "materialLayers": ["gold"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["ivory-sheath-cap-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(179, 160, 92, 1)", "secondaryAlbedo": "rgba(161, 144, 83, 1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_ivory_sheath_cap_83.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ivory-sheath-cap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}};
  (nodes["haramaki"] ?? root).add(node_ivory_sheath_cap_83);
  nodes["ivory-sheath-cap"] = node_ivory_sheath_cap_83;
  const mesh_ivory_sheath_cap_83Geometry = endpoint_ivory_sheath_cap_83
    ? new THREE.CylinderGeometry(endpoint_ivory_sheath_cap_83.endRadius, endpoint_ivory_sheath_cap_83.baseRadius, endpoint_ivory_sheath_cap_83.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.036, 0], [0.036, 0], [0.033839999999999995, 0.051538820320220766], [-0.033839999999999995, 0.051538820320220766]], "depth": 0.043});
  if (!endpoint_ivory_sheath_cap_83) {
    mesh_ivory_sheath_cap_83Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_ivory_sheath_cap_83 = new THREE.Mesh(
    mesh_ivory_sheath_cap_83Geometry,
    materialMap["gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_ivory_sheath_cap_83.name = "ivory sheath cap";
  if (endpoint_ivory_sheath_cap_83) {
    mesh_ivory_sheath_cap_83.position.copy(endpoint_ivory_sheath_cap_83.midpoint);
    mesh_ivory_sheath_cap_83.quaternion.copy(endpoint_ivory_sheath_cap_83.quaternion);
  }
  mesh_ivory_sheath_cap_83.castShadow = options.castShadow ?? true;
  mesh_ivory_sheath_cap_83.receiveShadow = options.receiveShadow ?? true;
  mesh_ivory_sheath_cap_83.userData.sculptComponent = {"id": "ivory-sheath-cap", "name": "ivory sheath cap", "level": "meso", "role": "accessory", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "ivory sheath cap follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "Blunt-ended closed scabbard with a rectangular-to-oval section; observed endpoint.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "profile2D": {"points": [[-0.036, 0], [0.036, 0], [0.033839999999999995, 0.051538820320220766], [-0.033839999999999995, 0.051538820320220766]], "depth": 0.043}}, "parent": "haramaki", "attachment": {"anchor": "haramaki", "maxOffset": 1.3, "contactType": "waist-mounted", "evidenceRefs": ["full-object"], "notes": "Proximity uses measured geometry centroids, not zero pivots of implicit fields."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.49, 0.785, 0], "rotation": [0, 0, -2.459276098715046], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "ivory-sheath-cap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}}, "material": "gold", "materialLayers": ["gold"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["ivory-sheath-cap-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(179, 160, 92, 1)", "secondaryAlbedo": "rgba(161, 144, 83, 1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_ivory_sheath_cap_83.add(mesh_ivory_sheath_cap_83);
  meshes["ivory-sheath-cap"] = mesh_ivory_sheath_cap_83;
  colliders["ivory-sheath-cap"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["ivory-sheath-cap"] ??= [];
  destructionGroups["ivory-sheath-cap"].push(node_ivory_sheath_cap_83);

  const endpoint_dark_sheath_cap_84 = makeAttachmentEndpoint(null);
  const node_dark_sheath_cap_84 = new THREE.Group();
  node_dark_sheath_cap_84.name = "dark sheath cap__pivot";
  node_dark_sheath_cap_84.scale.set(1, 1, 1);
  if (endpoint_dark_sheath_cap_84) {
    node_dark_sheath_cap_84.position.copy(endpoint_dark_sheath_cap_84.start);
    node_dark_sheath_cap_84.rotation.set(0.0, 0.0, -2.541542440188041);
  } else {
    node_dark_sheath_cap_84.position.set(0.4675, 0.675, 0.0);
    node_dark_sheath_cap_84.rotation.set(0.0, 0.0, -2.541542440188041);
  }
  node_dark_sheath_cap_84.userData.sculptComponent = {"id": "dark-sheath-cap", "name": "dark sheath cap", "level": "meso", "role": "accessory", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "dark sheath cap follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "Blunt-ended closed scabbard with a rectangular-to-oval section; observed endpoint.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "profile2D": {"points": [[-0.037, 0], [0.037, 0], [0.03478, 0.05755432216610676], [-0.03478, 0.05755432216610676]], "depth": 0.043}}, "parent": "haramaki", "attachment": {"anchor": "haramaki", "maxOffset": 1.3, "contactType": "waist-mounted", "evidenceRefs": ["full-object"], "notes": "Proximity uses measured geometry centroids, not zero pivots of implicit fields."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.4675, 0.675, 0], "rotation": [0, 0, -2.541542440188041], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "dark-sheath-cap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}}, "material": "gold", "materialLayers": ["gold"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["dark-sheath-cap-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(179, 160, 92, 1)", "secondaryAlbedo": "rgba(161, 144, 83, 1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_dark_sheath_cap_84.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "dark-sheath-cap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}};
  (nodes["haramaki"] ?? root).add(node_dark_sheath_cap_84);
  nodes["dark-sheath-cap"] = node_dark_sheath_cap_84;
  const mesh_dark_sheath_cap_84Geometry = endpoint_dark_sheath_cap_84
    ? new THREE.CylinderGeometry(endpoint_dark_sheath_cap_84.endRadius, endpoint_dark_sheath_cap_84.baseRadius, endpoint_dark_sheath_cap_84.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.037, 0], [0.037, 0], [0.03478, 0.05755432216610676], [-0.03478, 0.05755432216610676]], "depth": 0.043});
  if (!endpoint_dark_sheath_cap_84) {
    mesh_dark_sheath_cap_84Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_dark_sheath_cap_84 = new THREE.Mesh(
    mesh_dark_sheath_cap_84Geometry,
    materialMap["gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_dark_sheath_cap_84.name = "dark sheath cap";
  if (endpoint_dark_sheath_cap_84) {
    mesh_dark_sheath_cap_84.position.copy(endpoint_dark_sheath_cap_84.midpoint);
    mesh_dark_sheath_cap_84.quaternion.copy(endpoint_dark_sheath_cap_84.quaternion);
  }
  mesh_dark_sheath_cap_84.castShadow = options.castShadow ?? true;
  mesh_dark_sheath_cap_84.receiveShadow = options.receiveShadow ?? true;
  mesh_dark_sheath_cap_84.userData.sculptComponent = {"id": "dark-sheath-cap", "name": "dark sheath cap", "level": "meso", "role": "accessory", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "dark sheath cap follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "Blunt-ended closed scabbard with a rectangular-to-oval section; observed endpoint.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "profile2D": {"points": [[-0.037, 0], [0.037, 0], [0.03478, 0.05755432216610676], [-0.03478, 0.05755432216610676]], "depth": 0.043}}, "parent": "haramaki", "attachment": {"anchor": "haramaki", "maxOffset": 1.3, "contactType": "waist-mounted", "evidenceRefs": ["full-object"], "notes": "Proximity uses measured geometry centroids, not zero pivots of implicit fields."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.4675, 0.675, 0], "rotation": [0, 0, -2.541542440188041], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "dark-sheath-cap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}}, "material": "gold", "materialLayers": ["gold"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["dark-sheath-cap-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(179, 160, 92, 1)", "secondaryAlbedo": "rgba(161, 144, 83, 1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_dark_sheath_cap_84.add(mesh_dark_sheath_cap_84);
  meshes["dark-sheath-cap"] = mesh_dark_sheath_cap_84;
  colliders["dark-sheath-cap"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["dark-sheath-cap"] ??= [];
  destructionGroups["dark-sheath-cap"].push(node_dark_sheath_cap_84);

  const endpoint_red_sheath_cap_85 = makeAttachmentEndpoint(null);
  const node_red_sheath_cap_85 = new THREE.Group();
  node_red_sheath_cap_85.name = "red sheath cap__pivot";
  node_red_sheath_cap_85.scale.set(1, 1, 1);
  if (endpoint_red_sheath_cap_85) {
    node_red_sheath_cap_85.position.copy(endpoint_red_sheath_cap_85.start);
    node_red_sheath_cap_85.rotation.set(0.0, 0.0, -2.553590050042225);
  } else {
    node_red_sheath_cap_85.position.set(0.4225, 0.5975, 0.0);
    node_red_sheath_cap_85.rotation.set(0.0, 0.0, -2.553590050042225);
  }
  node_red_sheath_cap_85.userData.sculptComponent = {"id": "red-sheath-cap", "name": "red sheath cap", "level": "meso", "role": "accessory", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "red sheath cap follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "Blunt-ended closed scabbard with a rectangular-to-oval section; observed endpoint.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "profile2D": {"points": [[-0.03, 0], [0.03, 0], [0.028199999999999996, 0.04506939094329986], [-0.028199999999999996, 0.04506939094329986]], "depth": 0.043}}, "parent": "haramaki", "attachment": {"anchor": "haramaki", "maxOffset": 1.4, "contactType": "waist-mounted", "evidenceRefs": ["full-object"], "notes": "Proximity uses measured geometry centroids, not zero pivots of implicit fields."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.4225, 0.5975, 0], "rotation": [0, 0, -2.553590050042225], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "red-sheath-cap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}}, "material": "gold", "materialLayers": ["gold"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["red-sheath-cap-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(179, 160, 92, 1)", "secondaryAlbedo": "rgba(161, 144, 83, 1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_red_sheath_cap_85.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "red-sheath-cap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}};
  (nodes["haramaki"] ?? root).add(node_red_sheath_cap_85);
  nodes["red-sheath-cap"] = node_red_sheath_cap_85;
  const mesh_red_sheath_cap_85Geometry = endpoint_red_sheath_cap_85
    ? new THREE.CylinderGeometry(endpoint_red_sheath_cap_85.endRadius, endpoint_red_sheath_cap_85.baseRadius, endpoint_red_sheath_cap_85.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.03, 0], [0.03, 0], [0.028199999999999996, 0.04506939094329986], [-0.028199999999999996, 0.04506939094329986]], "depth": 0.043});
  if (!endpoint_red_sheath_cap_85) {
    mesh_red_sheath_cap_85Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_red_sheath_cap_85 = new THREE.Mesh(
    mesh_red_sheath_cap_85Geometry,
    materialMap["gold"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_red_sheath_cap_85.name = "red sheath cap";
  if (endpoint_red_sheath_cap_85) {
    mesh_red_sheath_cap_85.position.copy(endpoint_red_sheath_cap_85.midpoint);
    mesh_red_sheath_cap_85.quaternion.copy(endpoint_red_sheath_cap_85.quaternion);
  }
  mesh_red_sheath_cap_85.castShadow = options.castShadow ?? true;
  mesh_red_sheath_cap_85.receiveShadow = options.receiveShadow ?? true;
  mesh_red_sheath_cap_85.userData.sculptComponent = {"id": "red-sheath-cap", "name": "red sheath cap", "level": "meso", "role": "accessory", "importance": 0.9, "confidence": 0.8, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "red sheath cap follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"topologyIntent": "Blunt-ended closed scabbard with a rectangular-to-oval section; observed endpoint.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals", "profile2D": {"points": [[-0.03, 0], [0.03, 0], [0.028199999999999996, 0.04506939094329986], [-0.028199999999999996, 0.04506939094329986]], "depth": 0.043}}, "parent": "haramaki", "attachment": {"anchor": "haramaki", "maxOffset": 1.4, "contactType": "waist-mounted", "evidenceRefs": ["full-object"], "notes": "Proximity uses measured geometry centroids, not zero pivots of implicit fields."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.4225, 0.5975, 0], "rotation": [0, 0, -2.553590050042225], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "red-sheath-cap", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "gold"}}, "material": "gold", "materialLayers": ["gold"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["red-sheath-cap-observed-contour"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(179, 160, 92, 1)", "secondaryAlbedo": "rgba(161, 144, 83, 1)", "materialClass": "metal", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_red_sheath_cap_85.add(mesh_red_sheath_cap_85);
  meshes["red-sheath-cap"] = mesh_red_sheath_cap_85;
  colliders["red-sheath-cap"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["red-sheath-cap"] ??= [];
  destructionGroups["red-sheath-cap"].push(node_red_sheath_cap_85);

  const attachment_hand_raised_index_86 = {"parentSocket": "hand-raised-palm", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "surface-overlap", "embedDepth": 0.004, "gapTolerance": 0.003, "evidenceRefs": ["full-object"], "notes": "Curved digit root is embedded into the palm volume; finger bend is static and depth is inferred."};
  const endpoint_hand_raised_index_86 = makeAttachmentEndpoint(attachment_hand_raised_index_86);
  const node_hand_raised_index_86 = new THREE.Group();
  node_hand_raised_index_86.name = "Index curled finger__pivot";
  node_hand_raised_index_86.scale.set(1, 1, 1);
  if (endpoint_hand_raised_index_86) {
    node_hand_raised_index_86.position.copy(endpoint_hand_raised_index_86.start);
    node_hand_raised_index_86.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hand_raised_index_86.position.set(0.0, 0.0, 0.0);
    node_hand_raised_index_86.rotation.set(0.0, 0.0, 0.0);
  }
  node_hand_raised_index_86.userData.sculptComponent = {"id": "hand-raised-index", "name": "Index curled finger", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "tube", "topologyClass": "assembled-solid", "topologyRationale": "Index curled finger follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"fingerTube": {"stations": [[-0.012567420119864975, 0.02976675917077324, 0.023, 0.005], [-0.0019266194061164192, 0.03607337158714133, 0.025, 0.005], [0.007299988350419454, 0.042387618122321294, 0.027000000000000003, 0.005], [0.01794078906416801, 0.048694230538689376, 0.027000000000000003, 0.005]], "radialSegments": 12, "steps": 40}, "topologyIntent": "Single curved solid tube with a round capped fingertip, joined visually into the palm; hidden phalanx depth inferred.", "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-raised", "attachment": {"parentSocket": "hand-raised-palm", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "surface-overlap", "embedDepth": 0.004, "gapTolerance": 0.003, "evidenceRefs": ["full-object"], "notes": "Curved digit root is embedded into the palm volume; finger bend is static and depth is inferred."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-raised-index", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hand-raised-index-grip-curve"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_hand_raised_index_86.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-raised-index", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["hand-raised"] ?? root).add(node_hand_raised_index_86);
  nodes["hand-raised-index"] = node_hand_raised_index_86;
  const mesh_hand_raised_index_86Geometry = endpoint_hand_raised_index_86
    ? new THREE.CylinderGeometry(endpoint_hand_raised_index_86.endRadius, endpoint_hand_raised_index_86.baseRadius, endpoint_hand_raised_index_86.length, 32, 12)
    : buildTubeGeometry({"points": [[0.0, -0.5, 0.0], [0.0, 0.5, 0.0]], "radius": 0.05, "closed": false});
  if (!endpoint_hand_raised_index_86) {
    mesh_hand_raised_index_86Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hand_raised_index_86 = new THREE.Mesh(
    mesh_hand_raised_index_86Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hand_raised_index_86.name = "Index curled finger";
  if (endpoint_hand_raised_index_86) {
    mesh_hand_raised_index_86.position.copy(endpoint_hand_raised_index_86.midpoint);
    mesh_hand_raised_index_86.quaternion.copy(endpoint_hand_raised_index_86.quaternion);
  }
  mesh_hand_raised_index_86.castShadow = options.castShadow ?? true;
  mesh_hand_raised_index_86.receiveShadow = options.receiveShadow ?? true;
  mesh_hand_raised_index_86.userData.sculptComponent = {"id": "hand-raised-index", "name": "Index curled finger", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "tube", "topologyClass": "assembled-solid", "topologyRationale": "Index curled finger follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"fingerTube": {"stations": [[-0.012567420119864975, 0.02976675917077324, 0.023, 0.005], [-0.0019266194061164192, 0.03607337158714133, 0.025, 0.005], [0.007299988350419454, 0.042387618122321294, 0.027000000000000003, 0.005], [0.01794078906416801, 0.048694230538689376, 0.027000000000000003, 0.005]], "radialSegments": 12, "steps": 40}, "topologyIntent": "Single curved solid tube with a round capped fingertip, joined visually into the palm; hidden phalanx depth inferred.", "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-raised", "attachment": {"parentSocket": "hand-raised-palm", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "surface-overlap", "embedDepth": 0.004, "gapTolerance": 0.003, "evidenceRefs": ["full-object"], "notes": "Curved digit root is embedded into the palm volume; finger bend is static and depth is inferred."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-raised-index", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hand-raised-index-grip-curve"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_hand_raised_index_86.add(mesh_hand_raised_index_86);
  meshes["hand-raised-index"] = mesh_hand_raised_index_86;
  colliders["hand-raised-index"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hand-raised-index"] ??= [];
  destructionGroups["hand-raised-index"].push(node_hand_raised_index_86);

  const attachment_hand_raised_middle_87 = {"parentSocket": "hand-raised-palm", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "surface-overlap", "embedDepth": 0.004, "gapTolerance": 0.003, "evidenceRefs": ["full-object"], "notes": "Curved digit root is embedded into the palm volume; finger bend is static and depth is inferred."};
  const endpoint_hand_raised_middle_87 = makeAttachmentEndpoint(attachment_hand_raised_middle_87);
  const node_hand_raised_middle_87 = new THREE.Group();
  node_hand_raised_middle_87.name = "Middle curled finger__pivot";
  node_hand_raised_middle_87.scale.set(1, 1, 1);
  if (endpoint_hand_raised_middle_87) {
    node_hand_raised_middle_87.position.copy(endpoint_hand_raised_middle_87.start);
    node_hand_raised_middle_87.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hand_raised_middle_87.position.set(0.0, 0.0, 0.0);
    node_hand_raised_middle_87.rotation.set(0.0, 0.0, 0.0);
  }
  node_hand_raised_middle_87.userData.sculptComponent = {"id": "hand-raised-middle", "name": "Middle curled finger", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "tube", "topologyClass": "assembled-solid", "topologyRationale": "Middle curled finger follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"fingerTube": {"stations": [[0.0007872547261309482, 0.014845208991327285, 0.025, 0.0058], [0.010021496601478688, 0.022573648483719927, 0.042, 0.0058], [0.02635723973813733, 0.03592068921090399, 0.045, 0.0058], [0.032029279804611815, 0.038718538650081895, 0.026000000000000002, 0.0058]], "radialSegments": 10, "steps": 24}, "topologyIntent": "Single curved solid tube with a round capped fingertip, joined visually into the palm; hidden phalanx depth inferred.", "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-raised", "attachment": {"parentSocket": "hand-raised-palm", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "surface-overlap", "embedDepth": 0.004, "gapTolerance": 0.003, "evidenceRefs": ["full-object"], "notes": "Curved digit root is embedded into the palm volume; finger bend is static and depth is inferred."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-raised-middle", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hand-raised-middle-grip-curve"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_hand_raised_middle_87.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-raised-middle", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["hand-raised"] ?? root).add(node_hand_raised_middle_87);
  nodes["hand-raised-middle"] = node_hand_raised_middle_87;
  const mesh_hand_raised_middle_87Geometry = endpoint_hand_raised_middle_87
    ? new THREE.CylinderGeometry(endpoint_hand_raised_middle_87.endRadius, endpoint_hand_raised_middle_87.baseRadius, endpoint_hand_raised_middle_87.length, 32, 12)
    : buildTubeGeometry({"points": [[0.0, -0.5, 0.0], [0.0, 0.5, 0.0]], "radius": 0.05, "closed": false});
  if (!endpoint_hand_raised_middle_87) {
    mesh_hand_raised_middle_87Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hand_raised_middle_87 = new THREE.Mesh(
    mesh_hand_raised_middle_87Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hand_raised_middle_87.name = "Middle curled finger";
  if (endpoint_hand_raised_middle_87) {
    mesh_hand_raised_middle_87.position.copy(endpoint_hand_raised_middle_87.midpoint);
    mesh_hand_raised_middle_87.quaternion.copy(endpoint_hand_raised_middle_87.quaternion);
  }
  mesh_hand_raised_middle_87.castShadow = options.castShadow ?? true;
  mesh_hand_raised_middle_87.receiveShadow = options.receiveShadow ?? true;
  mesh_hand_raised_middle_87.userData.sculptComponent = {"id": "hand-raised-middle", "name": "Middle curled finger", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "tube", "topologyClass": "assembled-solid", "topologyRationale": "Middle curled finger follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"fingerTube": {"stations": [[0.0007872547261309482, 0.014845208991327285, 0.025, 0.0058], [0.010021496601478688, 0.022573648483719927, 0.042, 0.0058], [0.02635723973813733, 0.03592068921090399, 0.045, 0.0058], [0.032029279804611815, 0.038718538650081895, 0.026000000000000002, 0.0058]], "radialSegments": 10, "steps": 24}, "topologyIntent": "Single curved solid tube with a round capped fingertip, joined visually into the palm; hidden phalanx depth inferred.", "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-raised", "attachment": {"parentSocket": "hand-raised-palm", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "surface-overlap", "embedDepth": 0.004, "gapTolerance": 0.003, "evidenceRefs": ["full-object"], "notes": "Curved digit root is embedded into the palm volume; finger bend is static and depth is inferred."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-raised-middle", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hand-raised-middle-grip-curve"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_hand_raised_middle_87.add(mesh_hand_raised_middle_87);
  meshes["hand-raised-middle"] = mesh_hand_raised_middle_87;
  colliders["hand-raised-middle"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hand-raised-middle"] ??= [];
  destructionGroups["hand-raised-middle"].push(node_hand_raised_middle_87);

  const attachment_hand_raised_ring_88 = {"parentSocket": "hand-raised-palm", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "surface-overlap", "embedDepth": 0.004, "gapTolerance": 0.003, "evidenceRefs": ["full-object"], "notes": "Curved digit root is embedded into the palm volume; finger bend is static and depth is inferred."};
  const endpoint_hand_raised_ring_88 = makeAttachmentEndpoint(attachment_hand_raised_ring_88);
  const node_hand_raised_ring_88 = new THREE.Group();
  node_hand_raised_ring_88.name = "Ring curled finger__pivot";
  node_hand_raised_ring_88.scale.set(1, 1, 1);
  if (endpoint_hand_raised_ring_88) {
    node_hand_raised_ring_88.position.copy(endpoint_hand_raised_ring_88.start);
    node_hand_raised_ring_88.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hand_raised_ring_88.position.set(0.0, 0.0, 0.0);
    node_hand_raised_ring_88.rotation.set(0.0, 0.0, 0.0);
  }
  node_hand_raised_ring_88.userData.sculptComponent = {"id": "hand-raised-ring", "name": "Ring curled finger", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "tube", "topologyClass": "assembled-solid", "topologyRationale": "Ring curled finger follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"fingerTube": {"stations": [[0.014852843110139152, 0.0006269382310817376, 0.025, 0.0055], [0.022665257909462336, 0.006948818885073564, 0.041, 0.0055], [0.03757917397009643, 0.018889300773856803, 0.041, 0.0055], [0.04254030049855863, 0.02098387079383429, 0.025, 0.0055]], "radialSegments": 10, "steps": 24}, "topologyIntent": "Single curved solid tube with a round capped fingertip, joined visually into the palm; hidden phalanx depth inferred.", "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-raised", "attachment": {"parentSocket": "hand-raised-palm", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "surface-overlap", "embedDepth": 0.004, "gapTolerance": 0.003, "evidenceRefs": ["full-object"], "notes": "Curved digit root is embedded into the palm volume; finger bend is static and depth is inferred."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-raised-ring", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hand-raised-ring-grip-curve"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_hand_raised_ring_88.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-raised-ring", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["hand-raised"] ?? root).add(node_hand_raised_ring_88);
  nodes["hand-raised-ring"] = node_hand_raised_ring_88;
  const mesh_hand_raised_ring_88Geometry = endpoint_hand_raised_ring_88
    ? new THREE.CylinderGeometry(endpoint_hand_raised_ring_88.endRadius, endpoint_hand_raised_ring_88.baseRadius, endpoint_hand_raised_ring_88.length, 32, 12)
    : buildTubeGeometry({"points": [[0.0, -0.5, 0.0], [0.0, 0.5, 0.0]], "radius": 0.05, "closed": false});
  if (!endpoint_hand_raised_ring_88) {
    mesh_hand_raised_ring_88Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hand_raised_ring_88 = new THREE.Mesh(
    mesh_hand_raised_ring_88Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hand_raised_ring_88.name = "Ring curled finger";
  if (endpoint_hand_raised_ring_88) {
    mesh_hand_raised_ring_88.position.copy(endpoint_hand_raised_ring_88.midpoint);
    mesh_hand_raised_ring_88.quaternion.copy(endpoint_hand_raised_ring_88.quaternion);
  }
  mesh_hand_raised_ring_88.castShadow = options.castShadow ?? true;
  mesh_hand_raised_ring_88.receiveShadow = options.receiveShadow ?? true;
  mesh_hand_raised_ring_88.userData.sculptComponent = {"id": "hand-raised-ring", "name": "Ring curled finger", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "tube", "topologyClass": "assembled-solid", "topologyRationale": "Ring curled finger follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"fingerTube": {"stations": [[0.014852843110139152, 0.0006269382310817376, 0.025, 0.0055], [0.022665257909462336, 0.006948818885073564, 0.041, 0.0055], [0.03757917397009643, 0.018889300773856803, 0.041, 0.0055], [0.04254030049855863, 0.02098387079383429, 0.025, 0.0055]], "radialSegments": 10, "steps": 24}, "topologyIntent": "Single curved solid tube with a round capped fingertip, joined visually into the palm; hidden phalanx depth inferred.", "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-raised", "attachment": {"parentSocket": "hand-raised-palm", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "surface-overlap", "embedDepth": 0.004, "gapTolerance": 0.003, "evidenceRefs": ["full-object"], "notes": "Curved digit root is embedded into the palm volume; finger bend is static and depth is inferred."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-raised-ring", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hand-raised-ring-grip-curve"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_hand_raised_ring_88.add(mesh_hand_raised_ring_88);
  meshes["hand-raised-ring"] = mesh_hand_raised_ring_88;
  colliders["hand-raised-ring"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hand-raised-ring"] ??= [];
  destructionGroups["hand-raised-ring"].push(node_hand_raised_ring_88);

  const attachment_hand_raised_little_89 = {"parentSocket": "hand-raised-palm", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "surface-overlap", "embedDepth": 0.004, "gapTolerance": 0.003, "evidenceRefs": ["full-object"], "notes": "Curved digit root is embedded into the palm volume; finger bend is static and depth is inferred."};
  const endpoint_hand_raised_little_89 = makeAttachmentEndpoint(attachment_hand_raised_little_89);
  const node_hand_raised_little_89 = new THREE.Group();
  node_hand_raised_little_89.name = "Little curled finger__pivot";
  node_hand_raised_little_89.scale.set(1, 1, 1);
  if (endpoint_hand_raised_little_89) {
    node_hand_raised_little_89.position.copy(endpoint_hand_raised_little_89.start);
    node_hand_raised_little_89.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hand_raised_little_89.position.set(0.0, 0.0, 0.0);
    node_hand_raised_little_89.rotation.set(0.0, 0.0, 0.0);
  }
  node_hand_raised_little_89.userData.sculptComponent = {"id": "hand-raised-little", "name": "Little curled finger", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "tube", "topologyClass": "assembled-solid", "topologyRationale": "Little curled finger follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"fingerTube": {"stations": [[0.027496604418122798, -0.014997891367564627, 0.024, 0.005], [0.033894826260233296, -0.008668376594760937, 0.037000000000000005, 0.005], [0.04596508816881828, 0.00045898761722066445, 0.036000000000000004, 0.005], [0.04880110820205552, 0.0018579123368096112, 0.023, 0.005]], "radialSegments": 10, "steps": 24}, "topologyIntent": "Single curved solid tube with a round capped fingertip, joined visually into the palm; hidden phalanx depth inferred.", "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-raised", "attachment": {"parentSocket": "hand-raised-palm", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "surface-overlap", "embedDepth": 0.004, "gapTolerance": 0.003, "evidenceRefs": ["full-object"], "notes": "Curved digit root is embedded into the palm volume; finger bend is static and depth is inferred."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-raised-little", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hand-raised-little-grip-curve"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_hand_raised_little_89.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-raised-little", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["hand-raised"] ?? root).add(node_hand_raised_little_89);
  nodes["hand-raised-little"] = node_hand_raised_little_89;
  const mesh_hand_raised_little_89Geometry = endpoint_hand_raised_little_89
    ? new THREE.CylinderGeometry(endpoint_hand_raised_little_89.endRadius, endpoint_hand_raised_little_89.baseRadius, endpoint_hand_raised_little_89.length, 32, 12)
    : buildTubeGeometry({"points": [[0.0, -0.5, 0.0], [0.0, 0.5, 0.0]], "radius": 0.05, "closed": false});
  if (!endpoint_hand_raised_little_89) {
    mesh_hand_raised_little_89Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hand_raised_little_89 = new THREE.Mesh(
    mesh_hand_raised_little_89Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hand_raised_little_89.name = "Little curled finger";
  if (endpoint_hand_raised_little_89) {
    mesh_hand_raised_little_89.position.copy(endpoint_hand_raised_little_89.midpoint);
    mesh_hand_raised_little_89.quaternion.copy(endpoint_hand_raised_little_89.quaternion);
  }
  mesh_hand_raised_little_89.castShadow = options.castShadow ?? true;
  mesh_hand_raised_little_89.receiveShadow = options.receiveShadow ?? true;
  mesh_hand_raised_little_89.userData.sculptComponent = {"id": "hand-raised-little", "name": "Little curled finger", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "tube", "topologyClass": "assembled-solid", "topologyRationale": "Little curled finger follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"fingerTube": {"stations": [[0.027496604418122798, -0.014997891367564627, 0.024, 0.005], [0.033894826260233296, -0.008668376594760937, 0.037000000000000005, 0.005], [0.04596508816881828, 0.00045898761722066445, 0.036000000000000004, 0.005], [0.04880110820205552, 0.0018579123368096112, 0.023, 0.005]], "radialSegments": 10, "steps": 24}, "topologyIntent": "Single curved solid tube with a round capped fingertip, joined visually into the palm; hidden phalanx depth inferred.", "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-raised", "attachment": {"parentSocket": "hand-raised-palm", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "surface-overlap", "embedDepth": 0.004, "gapTolerance": 0.003, "evidenceRefs": ["full-object"], "notes": "Curved digit root is embedded into the palm volume; finger bend is static and depth is inferred."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-raised-little", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hand-raised-little-grip-curve"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_hand_raised_little_89.add(mesh_hand_raised_little_89);
  meshes["hand-raised-little"] = mesh_hand_raised_little_89;
  colliders["hand-raised-little"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hand-raised-little"] ??= [];
  destructionGroups["hand-raised-little"].push(node_hand_raised_little_89);

  const attachment_hand_raised_thumb_90 = {"parentSocket": "hand-raised-palm", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "surface-overlap", "embedDepth": 0.004, "gapTolerance": 0.003, "evidenceRefs": ["full-object"], "notes": "Curved digit root is embedded into the palm volume; finger bend is static and depth is inferred."};
  const endpoint_hand_raised_thumb_90 = makeAttachmentEndpoint(attachment_hand_raised_thumb_90);
  const node_hand_raised_thumb_90 = new THREE.Group();
  node_hand_raised_thumb_90.name = "Thumb curled finger__pivot";
  node_hand_raised_thumb_90.scale.set(1, 1, 1);
  if (endpoint_hand_raised_thumb_90) {
    node_hand_raised_thumb_90.position.copy(endpoint_hand_raised_thumb_90.start);
    node_hand_raised_thumb_90.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hand_raised_thumb_90.position.set(0.0, 0.0, 0.0);
    node_hand_raised_thumb_90.rotation.set(0.0, 0.0, 0.0);
  }
  node_hand_raised_thumb_90.userData.sculptComponent = {"id": "hand-raised-thumb", "name": "Thumb curled finger", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "tube", "topologyClass": "assembled-solid", "topologyRationale": "Thumb curled finger follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"fingerTube": {"stations": [[-0.005113808904699552, -0.030378429164231245, 0.023, 0.0064], [-0.028428907401679228, -0.02671698381080372, 0.037000000000000005, 0.0064], [-0.03180789035906767, 0.0022930571090860417, 0.051000000000000004, 0.0064], [-0.01756671724238652, 0.020601224364732308, 0.047, 0.0064]], "radialSegments": 10, "steps": 24}, "topologyIntent": "Single curved solid tube with a round capped fingertip, joined visually into the palm; hidden phalanx depth inferred.", "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-raised", "attachment": {"parentSocket": "hand-raised-palm", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "surface-overlap", "embedDepth": 0.004, "gapTolerance": 0.003, "evidenceRefs": ["full-object"], "notes": "Curved digit root is embedded into the palm volume; finger bend is static and depth is inferred."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-raised-thumb", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hand-raised-thumb-grip-curve"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_hand_raised_thumb_90.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-raised-thumb", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["hand-raised"] ?? root).add(node_hand_raised_thumb_90);
  nodes["hand-raised-thumb"] = node_hand_raised_thumb_90;
  const mesh_hand_raised_thumb_90Geometry = endpoint_hand_raised_thumb_90
    ? new THREE.CylinderGeometry(endpoint_hand_raised_thumb_90.endRadius, endpoint_hand_raised_thumb_90.baseRadius, endpoint_hand_raised_thumb_90.length, 32, 12)
    : buildTubeGeometry({"points": [[0.0, -0.5, 0.0], [0.0, 0.5, 0.0]], "radius": 0.05, "closed": false});
  if (!endpoint_hand_raised_thumb_90) {
    mesh_hand_raised_thumb_90Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hand_raised_thumb_90 = new THREE.Mesh(
    mesh_hand_raised_thumb_90Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hand_raised_thumb_90.name = "Thumb curled finger";
  if (endpoint_hand_raised_thumb_90) {
    mesh_hand_raised_thumb_90.position.copy(endpoint_hand_raised_thumb_90.midpoint);
    mesh_hand_raised_thumb_90.quaternion.copy(endpoint_hand_raised_thumb_90.quaternion);
  }
  mesh_hand_raised_thumb_90.castShadow = options.castShadow ?? true;
  mesh_hand_raised_thumb_90.receiveShadow = options.receiveShadow ?? true;
  mesh_hand_raised_thumb_90.userData.sculptComponent = {"id": "hand-raised-thumb", "name": "Thumb curled finger", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "tube", "topologyClass": "assembled-solid", "topologyRationale": "Thumb curled finger follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"fingerTube": {"stations": [[-0.005113808904699552, -0.030378429164231245, 0.023, 0.0064], [-0.028428907401679228, -0.02671698381080372, 0.037000000000000005, 0.0064], [-0.03180789035906767, 0.0022930571090860417, 0.051000000000000004, 0.0064], [-0.01756671724238652, 0.020601224364732308, 0.047, 0.0064]], "radialSegments": 10, "steps": 24}, "topologyIntent": "Single curved solid tube with a round capped fingertip, joined visually into the palm; hidden phalanx depth inferred.", "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-raised", "attachment": {"parentSocket": "hand-raised-palm", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "surface-overlap", "embedDepth": 0.004, "gapTolerance": 0.003, "evidenceRefs": ["full-object"], "notes": "Curved digit root is embedded into the palm volume; finger bend is static and depth is inferred."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-raised-thumb", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hand-raised-thumb-grip-curve"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_hand_raised_thumb_90.add(mesh_hand_raised_thumb_90);
  meshes["hand-raised-thumb"] = mesh_hand_raised_thumb_90;
  colliders["hand-raised-thumb"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hand-raised-thumb"] ??= [];
  destructionGroups["hand-raised-thumb"].push(node_hand_raised_thumb_90);

  const attachment_hand_down_index_91 = {"parentSocket": "hand-down-palm", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "surface-overlap", "embedDepth": 0.004, "gapTolerance": 0.003, "evidenceRefs": ["full-object"], "notes": "Curved digit root is embedded into the palm volume; finger bend is static and depth is inferred."};
  const endpoint_hand_down_index_91 = makeAttachmentEndpoint(attachment_hand_down_index_91);
  const node_hand_down_index_91 = new THREE.Group();
  node_hand_down_index_91.name = "Index curled finger__pivot";
  node_hand_down_index_91.scale.set(1, 1, 1);
  if (endpoint_hand_down_index_91) {
    node_hand_down_index_91.position.copy(endpoint_hand_down_index_91.start);
    node_hand_down_index_91.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hand_down_index_91.position.set(0.0, 0.0, 0.0);
    node_hand_down_index_91.rotation.set(0.0, 0.0, 0.0);
  }
  node_hand_down_index_91.userData.sculptComponent = {"id": "hand-down-index", "name": "Index curled finger", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "tube", "topologyClass": "assembled-solid", "topologyRationale": "Index curled finger follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"fingerTube": {"stations": [[0.0006625348858825212, 0.03230419550963912, 0.023, 0.005], [0.01295011946984301, 0.0337237958379064, 0.025, 0.005], [0.023949532996850473, 0.03572701875657652, 0.027000000000000003, 0.005], [0.03623711758081096, 0.03714661908484379, 0.027000000000000003, 0.005]], "radialSegments": 12, "steps": 40}, "topologyIntent": "Single curved solid tube with a round capped fingertip, joined visually into the palm; hidden phalanx depth inferred.", "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-down", "attachment": {"parentSocket": "hand-down-palm", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "surface-overlap", "embedDepth": 0.004, "gapTolerance": 0.003, "evidenceRefs": ["full-object"], "notes": "Curved digit root is embedded into the palm volume; finger bend is static and depth is inferred."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-down-index", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hand-down-index-grip-curve"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_hand_down_index_91.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-down-index", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["hand-down"] ?? root).add(node_hand_down_index_91);
  nodes["hand-down-index"] = node_hand_down_index_91;
  const mesh_hand_down_index_91Geometry = endpoint_hand_down_index_91
    ? new THREE.CylinderGeometry(endpoint_hand_down_index_91.endRadius, endpoint_hand_down_index_91.baseRadius, endpoint_hand_down_index_91.length, 32, 12)
    : buildTubeGeometry({"points": [[0.0, -0.5, 0.0], [0.0, 0.5, 0.0]], "radius": 0.05, "closed": false});
  if (!endpoint_hand_down_index_91) {
    mesh_hand_down_index_91Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hand_down_index_91 = new THREE.Mesh(
    mesh_hand_down_index_91Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hand_down_index_91.name = "Index curled finger";
  if (endpoint_hand_down_index_91) {
    mesh_hand_down_index_91.position.copy(endpoint_hand_down_index_91.midpoint);
    mesh_hand_down_index_91.quaternion.copy(endpoint_hand_down_index_91.quaternion);
  }
  mesh_hand_down_index_91.castShadow = options.castShadow ?? true;
  mesh_hand_down_index_91.receiveShadow = options.receiveShadow ?? true;
  mesh_hand_down_index_91.userData.sculptComponent = {"id": "hand-down-index", "name": "Index curled finger", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "tube", "topologyClass": "assembled-solid", "topologyRationale": "Index curled finger follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"fingerTube": {"stations": [[0.0006625348858825212, 0.03230419550963912, 0.023, 0.005], [0.01295011946984301, 0.0337237958379064, 0.025, 0.005], [0.023949532996850473, 0.03572701875657652, 0.027000000000000003, 0.005], [0.03623711758081096, 0.03714661908484379, 0.027000000000000003, 0.005]], "radialSegments": 12, "steps": 40}, "topologyIntent": "Single curved solid tube with a round capped fingertip, joined visually into the palm; hidden phalanx depth inferred.", "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-down", "attachment": {"parentSocket": "hand-down-palm", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "surface-overlap", "embedDepth": 0.004, "gapTolerance": 0.003, "evidenceRefs": ["full-object"], "notes": "Curved digit root is embedded into the palm volume; finger bend is static and depth is inferred."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-down-index", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hand-down-index-grip-curve"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_hand_down_index_91.add(mesh_hand_down_index_91);
  meshes["hand-down-index"] = mesh_hand_down_index_91;
  colliders["hand-down-index"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hand-down-index"] ??= [];
  destructionGroups["hand-down-index"].push(node_hand_down_index_91);

  const attachment_hand_down_middle_92 = {"parentSocket": "hand-down-palm", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "surface-overlap", "embedDepth": 0.004, "gapTolerance": 0.003, "evidenceRefs": ["full-object"], "notes": "Curved digit root is embedded into the palm volume; finger bend is static and depth is inferred."};
  const endpoint_hand_down_middle_92 = makeAttachmentEndpoint(attachment_hand_down_middle_92);
  const node_hand_down_middle_92 = new THREE.Group();
  node_hand_down_middle_92.name = "Middle curled finger__pivot";
  node_hand_down_middle_92.scale.set(1, 1, 1);
  if (endpoint_hand_down_middle_92) {
    node_hand_down_middle_92.position.copy(endpoint_hand_down_middle_92.start);
    node_hand_down_middle_92.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hand_down_middle_92.position.set(0.0, 0.0, 0.0);
    node_hand_down_middle_92.rotation.set(0.0, 0.0, 0.0);
  }
  node_hand_down_middle_92.userData.sculptComponent = {"id": "hand-down-middle", "name": "Middle curled finger", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "tube", "topologyClass": "assembled-solid", "topologyRationale": "Middle curled finger follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"fingerTube": {"stations": [[0.006772122727706382, 0.013233984802805337, 0.025, 0.0058], [0.018355158845116692, 0.01652537877842848, 0.042, 0.0058], [0.038713540608903495, 0.022051344029849502, 0.045, 0.0058], [0.04503347001752129, 0.02229319578214417, 0.026000000000000002, 0.0058]], "radialSegments": 10, "steps": 24}, "topologyIntent": "Single curved solid tube with a round capped fingertip, joined visually into the palm; hidden phalanx depth inferred.", "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-down", "attachment": {"parentSocket": "hand-down-palm", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "surface-overlap", "embedDepth": 0.004, "gapTolerance": 0.003, "evidenceRefs": ["full-object"], "notes": "Curved digit root is embedded into the palm volume; finger bend is static and depth is inferred."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-down-middle", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hand-down-middle-grip-curve"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_hand_down_middle_92.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-down-middle", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["hand-down"] ?? root).add(node_hand_down_middle_92);
  nodes["hand-down-middle"] = node_hand_down_middle_92;
  const mesh_hand_down_middle_92Geometry = endpoint_hand_down_middle_92
    ? new THREE.CylinderGeometry(endpoint_hand_down_middle_92.endRadius, endpoint_hand_down_middle_92.baseRadius, endpoint_hand_down_middle_92.length, 32, 12)
    : buildTubeGeometry({"points": [[0.0, -0.5, 0.0], [0.0, 0.5, 0.0]], "radius": 0.05, "closed": false});
  if (!endpoint_hand_down_middle_92) {
    mesh_hand_down_middle_92Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hand_down_middle_92 = new THREE.Mesh(
    mesh_hand_down_middle_92Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hand_down_middle_92.name = "Middle curled finger";
  if (endpoint_hand_down_middle_92) {
    mesh_hand_down_middle_92.position.copy(endpoint_hand_down_middle_92.midpoint);
    mesh_hand_down_middle_92.quaternion.copy(endpoint_hand_down_middle_92.quaternion);
  }
  mesh_hand_down_middle_92.castShadow = options.castShadow ?? true;
  mesh_hand_down_middle_92.receiveShadow = options.receiveShadow ?? true;
  mesh_hand_down_middle_92.userData.sculptComponent = {"id": "hand-down-middle", "name": "Middle curled finger", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "tube", "topologyClass": "assembled-solid", "topologyRationale": "Middle curled finger follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"fingerTube": {"stations": [[0.006772122727706382, 0.013233984802805337, 0.025, 0.0058], [0.018355158845116692, 0.01652537877842848, 0.042, 0.0058], [0.038713540608903495, 0.022051344029849502, 0.045, 0.0058], [0.04503347001752129, 0.02229319578214417, 0.026000000000000002, 0.0058]], "radialSegments": 10, "steps": 24}, "topologyIntent": "Single curved solid tube with a round capped fingertip, joined visually into the palm; hidden phalanx depth inferred.", "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-down", "attachment": {"parentSocket": "hand-down-palm", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "surface-overlap", "embedDepth": 0.004, "gapTolerance": 0.003, "evidenceRefs": ["full-object"], "notes": "Curved digit root is embedded into the palm volume; finger bend is static and depth is inferred."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-down-middle", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hand-down-middle-grip-curve"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_hand_down_middle_92.add(mesh_hand_down_middle_92);
  meshes["hand-down-middle"] = mesh_hand_down_middle_92;
  colliders["hand-down-middle"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hand-down-middle"] ??= [];
  destructionGroups["hand-down-middle"].push(node_hand_down_middle_92);

  const attachment_hand_down_ring_93 = {"parentSocket": "hand-down-palm", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "surface-overlap", "embedDepth": 0.004, "gapTolerance": 0.003, "evidenceRefs": ["full-object"], "notes": "Curved digit root is embedded into the palm volume; finger bend is static and depth is inferred."};
  const endpoint_hand_down_ring_93 = makeAttachmentEndpoint(attachment_hand_down_ring_93);
  const node_hand_down_ring_93 = new THREE.Group();
  node_hand_down_ring_93.name = "Ring curled finger__pivot";
  node_hand_down_ring_93.scale.set(1, 1, 1);
  if (endpoint_hand_down_ring_93) {
    node_hand_down_ring_93.position.copy(endpoint_hand_down_ring_93.start);
    node_hand_down_ring_93.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hand_down_ring_93.position.set(0.0, 0.0, 0.0);
    node_hand_down_ring_93.rotation.set(0.0, 0.0, 0.0);
  }
  node_hand_down_ring_93.userData.sculptComponent = {"id": "hand-down-ring", "name": "Ring curled finger", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "tube", "topologyClass": "assembled-solid", "topologyRationale": "Ring curled finger follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"fingerTube": {"stations": [[0.01381760739320818, -0.005483951670753359, 0.025, 0.0055], [0.023528849863262622, -0.002897106161680392, 0.041, 0.0055], [0.042015437979693565, 0.0019243106231904457, 0.041, 0.0055], [0.047399470564633416, 0.0018138881422100264, 0.025, 0.0055]], "radialSegments": 10, "steps": 24}, "topologyIntent": "Single curved solid tube with a round capped fingertip, joined visually into the palm; hidden phalanx depth inferred.", "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-down", "attachment": {"parentSocket": "hand-down-palm", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "surface-overlap", "embedDepth": 0.004, "gapTolerance": 0.003, "evidenceRefs": ["full-object"], "notes": "Curved digit root is embedded into the palm volume; finger bend is static and depth is inferred."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-down-ring", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hand-down-ring-grip-curve"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_hand_down_ring_93.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-down-ring", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["hand-down"] ?? root).add(node_hand_down_ring_93);
  nodes["hand-down-ring"] = node_hand_down_ring_93;
  const mesh_hand_down_ring_93Geometry = endpoint_hand_down_ring_93
    ? new THREE.CylinderGeometry(endpoint_hand_down_ring_93.endRadius, endpoint_hand_down_ring_93.baseRadius, endpoint_hand_down_ring_93.length, 32, 12)
    : buildTubeGeometry({"points": [[0.0, -0.5, 0.0], [0.0, 0.5, 0.0]], "radius": 0.05, "closed": false});
  if (!endpoint_hand_down_ring_93) {
    mesh_hand_down_ring_93Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hand_down_ring_93 = new THREE.Mesh(
    mesh_hand_down_ring_93Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hand_down_ring_93.name = "Ring curled finger";
  if (endpoint_hand_down_ring_93) {
    mesh_hand_down_ring_93.position.copy(endpoint_hand_down_ring_93.midpoint);
    mesh_hand_down_ring_93.quaternion.copy(endpoint_hand_down_ring_93.quaternion);
  }
  mesh_hand_down_ring_93.castShadow = options.castShadow ?? true;
  mesh_hand_down_ring_93.receiveShadow = options.receiveShadow ?? true;
  mesh_hand_down_ring_93.userData.sculptComponent = {"id": "hand-down-ring", "name": "Ring curled finger", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "tube", "topologyClass": "assembled-solid", "topologyRationale": "Ring curled finger follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"fingerTube": {"stations": [[0.01381760739320818, -0.005483951670753359, 0.025, 0.0055], [0.023528849863262622, -0.002897106161680392, 0.041, 0.0055], [0.042015437979693565, 0.0019243106231904457, 0.041, 0.0055], [0.047399470564633416, 0.0018138881422100264, 0.025, 0.0055]], "radialSegments": 10, "steps": 24}, "topologyIntent": "Single curved solid tube with a round capped fingertip, joined visually into the palm; hidden phalanx depth inferred.", "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-down", "attachment": {"parentSocket": "hand-down-palm", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "surface-overlap", "embedDepth": 0.004, "gapTolerance": 0.003, "evidenceRefs": ["full-object"], "notes": "Curved digit root is embedded into the palm volume; finger bend is static and depth is inferred."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-down-ring", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hand-down-ring-grip-curve"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_hand_down_ring_93.add(mesh_hand_down_ring_93);
  meshes["hand-down-ring"] = mesh_hand_down_ring_93;
  colliders["hand-down-ring"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hand-down-ring"] ??= [];
  destructionGroups["hand-down-ring"].push(node_hand_down_ring_93);

  const attachment_hand_down_little_94 = {"parentSocket": "hand-down-palm", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "surface-overlap", "embedDepth": 0.004, "gapTolerance": 0.003, "evidenceRefs": ["full-object"], "notes": "Curved digit root is embedded into the palm volume; finger bend is static and depth is inferred."};
  const endpoint_hand_down_little_94 = makeAttachmentEndpoint(attachment_hand_down_little_94);
  const node_hand_down_little_94 = new THREE.Group();
  node_hand_down_little_94.name = "Little curled finger__pivot";
  node_hand_down_little_94.scale.set(1, 1, 1);
  if (endpoint_hand_down_little_94) {
    node_hand_down_little_94.position.copy(endpoint_hand_down_little_94.start);
    node_hand_down_little_94.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hand_down_little_94.position.set(0.0, 0.0, 0.0);
    node_hand_down_little_94.rotation.set(0.0, 0.0, 0.0);
  }
  node_hand_down_little_94.userData.sculptComponent = {"id": "hand-down-little", "name": "Little curled finger", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "tube", "topologyClass": "assembled-solid", "topologyRationale": "Little curled finger follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"fingerTube": {"stations": [[0.01899129841135411, -0.024906436610862233, 0.024, 0.005], [0.027414369824455526, -0.021735968511386424, 0.037000000000000005, 0.005], [0.042157370646174724, -0.018323648659615947, 0.036000000000000004, 0.005], [0.04531733535048362, -0.018202722783468614, 0.023, 0.005]], "radialSegments": 10, "steps": 24}, "topologyIntent": "Single curved solid tube with a round capped fingertip, joined visually into the palm; hidden phalanx depth inferred.", "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-down", "attachment": {"parentSocket": "hand-down-palm", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "surface-overlap", "embedDepth": 0.004, "gapTolerance": 0.003, "evidenceRefs": ["full-object"], "notes": "Curved digit root is embedded into the palm volume; finger bend is static and depth is inferred."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-down-little", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hand-down-little-grip-curve"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_hand_down_little_94.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-down-little", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["hand-down"] ?? root).add(node_hand_down_little_94);
  nodes["hand-down-little"] = node_hand_down_little_94;
  const mesh_hand_down_little_94Geometry = endpoint_hand_down_little_94
    ? new THREE.CylinderGeometry(endpoint_hand_down_little_94.endRadius, endpoint_hand_down_little_94.baseRadius, endpoint_hand_down_little_94.length, 32, 12)
    : buildTubeGeometry({"points": [[0.0, -0.5, 0.0], [0.0, 0.5, 0.0]], "radius": 0.05, "closed": false});
  if (!endpoint_hand_down_little_94) {
    mesh_hand_down_little_94Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hand_down_little_94 = new THREE.Mesh(
    mesh_hand_down_little_94Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hand_down_little_94.name = "Little curled finger";
  if (endpoint_hand_down_little_94) {
    mesh_hand_down_little_94.position.copy(endpoint_hand_down_little_94.midpoint);
    mesh_hand_down_little_94.quaternion.copy(endpoint_hand_down_little_94.quaternion);
  }
  mesh_hand_down_little_94.castShadow = options.castShadow ?? true;
  mesh_hand_down_little_94.receiveShadow = options.receiveShadow ?? true;
  mesh_hand_down_little_94.userData.sculptComponent = {"id": "hand-down-little", "name": "Little curled finger", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "tube", "topologyClass": "assembled-solid", "topologyRationale": "Little curled finger follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"fingerTube": {"stations": [[0.01899129841135411, -0.024906436610862233, 0.024, 0.005], [0.027414369824455526, -0.021735968511386424, 0.037000000000000005, 0.005], [0.042157370646174724, -0.018323648659615947, 0.036000000000000004, 0.005], [0.04531733535048362, -0.018202722783468614, 0.023, 0.005]], "radialSegments": 10, "steps": 24}, "topologyIntent": "Single curved solid tube with a round capped fingertip, joined visually into the palm; hidden phalanx depth inferred.", "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-down", "attachment": {"parentSocket": "hand-down-palm", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "surface-overlap", "embedDepth": 0.004, "gapTolerance": 0.003, "evidenceRefs": ["full-object"], "notes": "Curved digit root is embedded into the palm volume; finger bend is static and depth is inferred."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-down-little", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hand-down-little-grip-curve"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_hand_down_little_94.add(mesh_hand_down_little_94);
  meshes["hand-down-little"] = mesh_hand_down_little_94;
  colliders["hand-down-little"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hand-down-little"] ??= [];
  destructionGroups["hand-down-little"].push(node_hand_down_little_94);

  const attachment_hand_down_thumb_95 = {"parentSocket": "hand-down-palm", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "surface-overlap", "embedDepth": 0.004, "gapTolerance": 0.003, "evidenceRefs": ["full-object"], "notes": "Curved digit root is embedded into the palm volume; finger bend is static and depth is inferred."};
  const endpoint_hand_down_thumb_95 = makeAttachmentEndpoint(attachment_hand_down_thumb_95);
  const node_hand_down_thumb_95 = new THREE.Group();
  node_hand_down_thumb_95.name = "Thumb curled finger__pivot";
  node_hand_down_thumb_95.scale.set(1, 1, 1);
  if (endpoint_hand_down_thumb_95) {
    node_hand_down_thumb_95.position.copy(endpoint_hand_down_thumb_95.start);
    node_hand_down_thumb_95.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hand_down_thumb_95.position.set(0.0, 0.0, 0.0);
    node_hand_down_thumb_95.rotation.set(0.0, 0.0, 0.0);
  }
  node_hand_down_thumb_95.userData.sculptComponent = {"id": "hand-down-thumb", "name": "Thumb curled finger", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "tube", "topologyClass": "assembled-solid", "topologyRationale": "Thumb curled finger follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"fingerTube": {"stations": [[-0.017056484392996753, -0.025652998658080073, 0.023, 0.0064], [-0.03685225035671455, -0.012802798274050573, 0.037000000000000005, 0.0064], [-0.02810841489583879, 0.015063764869493547, 0.051000000000000004, 0.0064], [-0.0076396106510715584, 0.02597376270585442, 0.047, 0.0064]], "radialSegments": 10, "steps": 24}, "topologyIntent": "Single curved solid tube with a round capped fingertip, joined visually into the palm; hidden phalanx depth inferred.", "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-down", "attachment": {"parentSocket": "hand-down-palm", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "surface-overlap", "embedDepth": 0.004, "gapTolerance": 0.003, "evidenceRefs": ["full-object"], "notes": "Curved digit root is embedded into the palm volume; finger bend is static and depth is inferred."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-down-thumb", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hand-down-thumb-grip-curve"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_hand_down_thumb_95.userData.actionProfile = {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-down-thumb", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}};
  (nodes["hand-down"] ?? root).add(node_hand_down_thumb_95);
  nodes["hand-down-thumb"] = node_hand_down_thumb_95;
  const mesh_hand_down_thumb_95Geometry = endpoint_hand_down_thumb_95
    ? new THREE.CylinderGeometry(endpoint_hand_down_thumb_95.endRadius, endpoint_hand_down_thumb_95.baseRadius, endpoint_hand_down_thumb_95.length, 32, 12)
    : buildTubeGeometry({"points": [[0.0, -0.5, 0.0], [0.0, 0.5, 0.0]], "radius": 0.05, "closed": false});
  if (!endpoint_hand_down_thumb_95) {
    mesh_hand_down_thumb_95Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_hand_down_thumb_95 = new THREE.Mesh(
    mesh_hand_down_thumb_95Geometry,
    materialMap["skin"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hand_down_thumb_95.name = "Thumb curled finger";
  if (endpoint_hand_down_thumb_95) {
    mesh_hand_down_thumb_95.position.copy(endpoint_hand_down_thumb_95.midpoint);
    mesh_hand_down_thumb_95.quaternion.copy(endpoint_hand_down_thumb_95.quaternion);
  }
  mesh_hand_down_thumb_95.castShadow = options.castShadow ?? true;
  mesh_hand_down_thumb_95.receiveShadow = options.receiveShadow ?? true;
  mesh_hand_down_thumb_95.userData.sculptComponent = {"id": "hand-down-thumb", "name": "Thumb curled finger", "level": "micro", "role": "detail", "importance": 0.9, "confidence": 0.8, "primitive": "tube", "topologyClass": "assembled-solid", "topologyRationale": "Thumb curled finger follows the observed contour with a real depth extent; it is not a flat image carrier.", "geometryDescriptor": {"fingerTube": {"stations": [[-0.017056484392996753, -0.025652998658080073, 0.023, 0.0064], [-0.03685225035671455, -0.012802798274050573, 0.037000000000000005, 0.0064], [-0.02810841489583879, 0.015063764869493547, 0.051000000000000004, 0.0064], [-0.0076396106510715584, 0.02597376270585442, 0.047, 0.0064]], "radialSegments": 10, "steps": 24}, "topologyIntent": "Single curved solid tube with a round capped fingertip, joined visually into the palm; hidden phalanx depth inferred.", "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "smooth vertex normals"}, "parent": "hand-down", "attachment": {"parentSocket": "hand-down-palm", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "surface-overlap", "embedDepth": 0.004, "gapTolerance": 0.003, "evidenceRefs": ["full-object"], "notes": "Curved digit root is embedded into the palm volume; finger bend is static and depth is inferred."}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": false}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hand-down-thumb", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "skin"}}, "material": "skin", "materialLayers": ["skin"], "deformations": [], "joints": [], "seams": [], "localFeatures": ["hand-down-thumb-grip-curve"], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "geometryLayer": "L3", "colorMaterialRecipe": {"dominantAlbedo": "rgba(232, 190, 141, 1)", "secondaryAlbedo": "rgba(209, 171, 127, 1)", "materialClass": "skin", "materialClassConfidence": 0.85, "evidenceRefs": ["full-object"]}};
  node_hand_down_thumb_95.add(mesh_hand_down_thumb_95);
  meshes["hand-down-thumb"] = mesh_hand_down_thumb_95;
  colliders["hand-down-thumb"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy"};
  destructionGroups["hand-down-thumb"] ??= [];
  destructionGroups["hand-down-thumb"].push(node_hand_down_thumb_95);
  // repetition system "fitting-repeats" describes 15 parts that are already built individually; not instanced.

  // standProud: hold these components outside the surfaces they cover.
  root.userData.sculptBuildPass = "structural-pass";
  refineZoroGeometry(meshes);
  if (meshes["hair"] && nodes["head"]) {
    applyStandProud(
      meshes["hair"].geometry,
      meshes["hair"],
      nodes["head"],
      {"rings": [[-0.1375, 0.030000000000000002, 0.0025, 0.0], [-0.1275, 0.05500000000000001, 0.0225, 0.0], [-0.1025, 0.09, 0.05, 0.0], [-0.07, 0.11, 0.0675, 0.0], [-0.015, 0.1125, 0.0775, 0.0], [0.04, 0.10250000000000001, 0.08, 0.0], [0.0875, 0.085, 0.075, 0.0], [0.12, 0.06, 0.0575, 0.0], [0.135, 0.0025, 0.0025, 0.0]]},
      0.004,
      0.015,
    );
  }
  if (meshes["hair-tip-0"] && nodes["head"]) {
    applyStandProud(
      meshes["hair-tip-0"].geometry,
      meshes["hair-tip-0"],
      nodes["head"],
      {"rings": [[-0.1375, 0.030000000000000002, 0.0025, 0.0], [-0.1275, 0.05500000000000001, 0.0225, 0.0], [-0.1025, 0.09, 0.05, 0.0], [-0.07, 0.11, 0.0675, 0.0], [-0.015, 0.1125, 0.0775, 0.0], [0.04, 0.10250000000000001, 0.08, 0.0], [0.0875, 0.085, 0.075, 0.0], [0.12, 0.06, 0.0575, 0.0], [0.135, 0.0025, 0.0025, 0.0]]},
      0.003,
      0.012,
    );
  }
  if (meshes["hair-tip-1"] && nodes["head"]) {
    applyStandProud(
      meshes["hair-tip-1"].geometry,
      meshes["hair-tip-1"],
      nodes["head"],
      {"rings": [[-0.1375, 0.030000000000000002, 0.0025, 0.0], [-0.1275, 0.05500000000000001, 0.0225, 0.0], [-0.1025, 0.09, 0.05, 0.0], [-0.07, 0.11, 0.0675, 0.0], [-0.015, 0.1125, 0.0775, 0.0], [0.04, 0.10250000000000001, 0.08, 0.0], [0.0875, 0.085, 0.075, 0.0], [0.12, 0.06, 0.0575, 0.0], [0.135, 0.0025, 0.0025, 0.0]]},
      0.003,
      0.012,
    );
  }
  if (meshes["hair-tip-2"] && nodes["head"]) {
    applyStandProud(
      meshes["hair-tip-2"].geometry,
      meshes["hair-tip-2"],
      nodes["head"],
      {"rings": [[-0.1375, 0.030000000000000002, 0.0025, 0.0], [-0.1275, 0.05500000000000001, 0.0225, 0.0], [-0.1025, 0.09, 0.05, 0.0], [-0.07, 0.11, 0.0675, 0.0], [-0.015, 0.1125, 0.0775, 0.0], [0.04, 0.10250000000000001, 0.08, 0.0], [0.0875, 0.085, 0.075, 0.0], [0.12, 0.06, 0.0575, 0.0], [0.135, 0.0025, 0.0025, 0.0]]},
      0.003,
      0.012,
    );
  }
  if (meshes["hair-tip-3"] && nodes["head"]) {
    applyStandProud(
      meshes["hair-tip-3"].geometry,
      meshes["hair-tip-3"],
      nodes["head"],
      {"rings": [[-0.1375, 0.030000000000000002, 0.0025, 0.0], [-0.1275, 0.05500000000000001, 0.0225, 0.0], [-0.1025, 0.09, 0.05, 0.0], [-0.07, 0.11, 0.0675, 0.0], [-0.015, 0.1125, 0.0775, 0.0], [0.04, 0.10250000000000001, 0.08, 0.0], [0.0875, 0.085, 0.075, 0.0], [0.12, 0.06, 0.0575, 0.0], [0.135, 0.0025, 0.0025, 0.0]]},
      0.003,
      0.012,
    );
  }
  if (meshes["hair-tip-4"] && nodes["head"]) {
    applyStandProud(
      meshes["hair-tip-4"].geometry,
      meshes["hair-tip-4"],
      nodes["head"],
      {"rings": [[-0.1375, 0.030000000000000002, 0.0025, 0.0], [-0.1275, 0.05500000000000001, 0.0225, 0.0], [-0.1025, 0.09, 0.05, 0.0], [-0.07, 0.11, 0.0675, 0.0], [-0.015, 0.1125, 0.0775, 0.0], [0.04, 0.10250000000000001, 0.08, 0.0], [0.0875, 0.085, 0.075, 0.0], [0.12, 0.06, 0.0575, 0.0], [0.135, 0.0025, 0.0025, 0.0]]},
      0.003,
      0.012,
    );
  }
  if (meshes["hair-tip-5"] && nodes["head"]) {
    applyStandProud(
      meshes["hair-tip-5"].geometry,
      meshes["hair-tip-5"],
      nodes["head"],
      {"rings": [[-0.1375, 0.030000000000000002, 0.0025, 0.0], [-0.1275, 0.05500000000000001, 0.0225, 0.0], [-0.1025, 0.09, 0.05, 0.0], [-0.07, 0.11, 0.0675, 0.0], [-0.015, 0.1125, 0.0775, 0.0], [0.04, 0.10250000000000001, 0.08, 0.0], [0.0875, 0.085, 0.075, 0.0], [0.12, 0.06, 0.0575, 0.0], [0.135, 0.0025, 0.0025, 0.0]]},
      0.003,
      0.012,
    );
  }
  if (meshes["hair-tip-6"] && nodes["head"]) {
    applyStandProud(
      meshes["hair-tip-6"].geometry,
      meshes["hair-tip-6"],
      nodes["head"],
      {"rings": [[-0.1375, 0.030000000000000002, 0.0025, 0.0], [-0.1275, 0.05500000000000001, 0.0225, 0.0], [-0.1025, 0.09, 0.05, 0.0], [-0.07, 0.11, 0.0675, 0.0], [-0.015, 0.1125, 0.0775, 0.0], [0.04, 0.10250000000000001, 0.08, 0.0], [0.0875, 0.085, 0.075, 0.0], [0.12, 0.06, 0.0575, 0.0], [0.135, 0.0025, 0.0025, 0.0]]},
      0.003,
      0.012,
    );
  }
  if (meshes["hair-tip-7"] && nodes["head"]) {
    applyStandProud(
      meshes["hair-tip-7"].geometry,
      meshes["hair-tip-7"],
      nodes["head"],
      {"rings": [[-0.1375, 0.030000000000000002, 0.0025, 0.0], [-0.1275, 0.05500000000000001, 0.0225, 0.0], [-0.1025, 0.09, 0.05, 0.0], [-0.07, 0.11, 0.0675, 0.0], [-0.015, 0.1125, 0.0775, 0.0], [0.04, 0.10250000000000001, 0.08, 0.0], [0.0875, 0.085, 0.075, 0.0], [0.12, 0.06, 0.0575, 0.0], [0.135, 0.0025, 0.0025, 0.0]]},
      0.003,
      0.012,
    );
  }
  if (meshes["hair-tip-8"] && nodes["head"]) {
    applyStandProud(
      meshes["hair-tip-8"].geometry,
      meshes["hair-tip-8"],
      nodes["head"],
      {"rings": [[-0.1375, 0.030000000000000002, 0.0025, 0.0], [-0.1275, 0.05500000000000001, 0.0225, 0.0], [-0.1025, 0.09, 0.05, 0.0], [-0.07, 0.11, 0.0675, 0.0], [-0.015, 0.1125, 0.0775, 0.0], [0.04, 0.10250000000000001, 0.08, 0.0], [0.0875, 0.085, 0.075, 0.0], [0.12, 0.06, 0.0575, 0.0], [0.135, 0.0025, 0.0025, 0.0]]},
      0.003,
      0.012,
    );
  }
  if (meshes["hair-tip-9"] && nodes["head"]) {
    applyStandProud(
      meshes["hair-tip-9"].geometry,
      meshes["hair-tip-9"],
      nodes["head"],
      {"rings": [[-0.1375, 0.030000000000000002, 0.0025, 0.0], [-0.1275, 0.05500000000000001, 0.0225, 0.0], [-0.1025, 0.09, 0.05, 0.0], [-0.07, 0.11, 0.0675, 0.0], [-0.015, 0.1125, 0.0775, 0.0], [0.04, 0.10250000000000001, 0.08, 0.0], [0.0875, 0.085, 0.075, 0.0], [0.12, 0.06, 0.0575, 0.0], [0.135, 0.0025, 0.0025, 0.0]]},
      0.003,
      0.012,
    );
  }
  if (meshes["hair-tip-10"] && nodes["head"]) {
    applyStandProud(
      meshes["hair-tip-10"].geometry,
      meshes["hair-tip-10"],
      nodes["head"],
      {"rings": [[-0.1375, 0.030000000000000002, 0.0025, 0.0], [-0.1275, 0.05500000000000001, 0.0225, 0.0], [-0.1025, 0.09, 0.05, 0.0], [-0.07, 0.11, 0.0675, 0.0], [-0.015, 0.1125, 0.0775, 0.0], [0.04, 0.10250000000000001, 0.08, 0.0], [0.0875, 0.085, 0.075, 0.0], [0.12, 0.06, 0.0575, 0.0], [0.135, 0.0025, 0.0025, 0.0]]},
      0.003,
      0.012,
    );
  }
  if (meshes["hair-tip-11"] && nodes["head"]) {
    applyStandProud(
      meshes["hair-tip-11"].geometry,
      meshes["hair-tip-11"],
      nodes["head"],
      {"rings": [[-0.1375, 0.030000000000000002, 0.0025, 0.0], [-0.1275, 0.05500000000000001, 0.0225, 0.0], [-0.1025, 0.09, 0.05, 0.0], [-0.07, 0.11, 0.0675, 0.0], [-0.015, 0.1125, 0.0775, 0.0], [0.04, 0.10250000000000001, 0.08, 0.0], [0.0875, 0.085, 0.075, 0.0], [0.12, 0.06, 0.0575, 0.0], [0.135, 0.0025, 0.0025, 0.0]]},
      0.003,
      0.012,
    );
  }
  if (meshes["hair-tip-12"] && nodes["head"]) {
    applyStandProud(
      meshes["hair-tip-12"].geometry,
      meshes["hair-tip-12"],
      nodes["head"],
      {"rings": [[-0.1375, 0.030000000000000002, 0.0025, 0.0], [-0.1275, 0.05500000000000001, 0.0225, 0.0], [-0.1025, 0.09, 0.05, 0.0], [-0.07, 0.11, 0.0675, 0.0], [-0.015, 0.1125, 0.0775, 0.0], [0.04, 0.10250000000000001, 0.08, 0.0], [0.0875, 0.085, 0.075, 0.0], [0.12, 0.06, 0.0575, 0.0], [0.135, 0.0025, 0.0025, 0.0]]},
      0.003,
      0.012,
    );
  }
  if (meshes["hair-tip-13"] && nodes["head"]) {
    applyStandProud(
      meshes["hair-tip-13"].geometry,
      meshes["hair-tip-13"],
      nodes["head"],
      {"rings": [[-0.1375, 0.030000000000000002, 0.0025, 0.0], [-0.1275, 0.05500000000000001, 0.0225, 0.0], [-0.1025, 0.09, 0.05, 0.0], [-0.07, 0.11, 0.0675, 0.0], [-0.015, 0.1125, 0.0775, 0.0], [0.04, 0.10250000000000001, 0.08, 0.0], [0.0875, 0.085, 0.075, 0.0], [0.12, 0.06, 0.0575, 0.0], [0.135, 0.0025, 0.0025, 0.0]]},
      0.003,
      0.012,
    );
  }
  if (meshes["hair-tip-14"] && nodes["head"]) {
    applyStandProud(
      meshes["hair-tip-14"].geometry,
      meshes["hair-tip-14"],
      nodes["head"],
      {"rings": [[-0.1375, 0.030000000000000002, 0.0025, 0.0], [-0.1275, 0.05500000000000001, 0.0225, 0.0], [-0.1025, 0.09, 0.05, 0.0], [-0.07, 0.11, 0.0675, 0.0], [-0.015, 0.1125, 0.0775, 0.0], [0.04, 0.10250000000000001, 0.08, 0.0], [0.0875, 0.085, 0.075, 0.0], [0.12, 0.06, 0.0575, 0.0], [0.135, 0.0025, 0.0025, 0.0]]},
      0.003,
      0.012,
    );
  }
  if (meshes["hair-tip-15"] && nodes["head"]) {
    applyStandProud(
      meshes["hair-tip-15"].geometry,
      meshes["hair-tip-15"],
      nodes["head"],
      {"rings": [[-0.1375, 0.030000000000000002, 0.0025, 0.0], [-0.1275, 0.05500000000000001, 0.0225, 0.0], [-0.1025, 0.09, 0.05, 0.0], [-0.07, 0.11, 0.0675, 0.0], [-0.015, 0.1125, 0.0775, 0.0], [0.04, 0.10250000000000001, 0.08, 0.0], [0.0875, 0.085, 0.075, 0.0], [0.12, 0.06, 0.0575, 0.0], [0.135, 0.0025, 0.0025, 0.0]]},
      0.003,
      0.012,
    );
  }
  if (meshes["hair-tip-16"] && nodes["head"]) {
    applyStandProud(
      meshes["hair-tip-16"].geometry,
      meshes["hair-tip-16"],
      nodes["head"],
      {"rings": [[-0.1375, 0.030000000000000002, 0.0025, 0.0], [-0.1275, 0.05500000000000001, 0.0225, 0.0], [-0.1025, 0.09, 0.05, 0.0], [-0.07, 0.11, 0.0675, 0.0], [-0.015, 0.1125, 0.0775, 0.0], [0.04, 0.10250000000000001, 0.08, 0.0], [0.0875, 0.085, 0.075, 0.0], [0.12, 0.06, 0.0575, 0.0], [0.135, 0.0025, 0.0025, 0.0]]},
      0.003,
      0.012,
    );
  }
  if (meshes["hair-tip-17"] && nodes["head"]) {
    applyStandProud(
      meshes["hair-tip-17"].geometry,
      meshes["hair-tip-17"],
      nodes["head"],
      {"rings": [[-0.1375, 0.030000000000000002, 0.0025, 0.0], [-0.1275, 0.05500000000000001, 0.0225, 0.0], [-0.1025, 0.09, 0.05, 0.0], [-0.07, 0.11, 0.0675, 0.0], [-0.015, 0.1125, 0.0775, 0.0], [0.04, 0.10250000000000001, 0.08, 0.0], [0.0875, 0.085, 0.075, 0.0], [0.12, 0.06, 0.0575, 0.0], [0.135, 0.0025, 0.0025, 0.0]]},
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
