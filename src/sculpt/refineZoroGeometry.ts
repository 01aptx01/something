import * as THREE from 'three';
import {mergeVertices} from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Hand refinement of the current img2threejs pass. All shape inputs are persisted
// in geometryDescriptor.parametricLoft; no mesh or image geometry is imported.
type Section=[number,number,number,number,number]; // y, centreX, radiusX, radiusZ, centreZ
type Feature={x:number;y:number;width:number;height:number;depth:number};
type Loft={sections:Section[];radialSegments:number;verticalSegments:number;thickness?:number;angularRange?:[number,number];frontFeatures?:Feature[];hemWarp?:{frontLift:number;backDrop:number;decay:number};scalpOffset?:{component:string;clearance:number}};

function sample(sections:Section[],y:number,column:number):number{
 let i=0;while(i<sections.length-2&&sections[i+1][0]<y)i++;
 const a=sections[i],b=sections[i+1],span=b[0]-a[0],t=THREE.MathUtils.clamp((y-a[0])/span,0,1);
 const slope=(j:number)=>{
  if(j===0)return(sections[1][column]-sections[0][column])/(sections[1][0]-sections[0][0]);
  if(j===sections.length-1)return(sections[j][column]-sections[j-1][column])/(sections[j][0]-sections[j-1][0]);
  const dl=(sections[j][column]-sections[j-1][column])/(sections[j][0]-sections[j-1][0]);
  const dr=(sections[j+1][column]-sections[j][column])/(sections[j+1][0]-sections[j][0]);
  return dl*dr<=0?0:2*dl*dr/(dl+dr);
 };
 return(2*t*t*t-3*t*t+1)*a[column]+(t*t*t-2*t*t+t)*span*slope(i)+(-2*t*t*t+3*t*t)*b[column]+(t*t*t-t*t)*span*slope(i+1);
}

function loftGeometry(d:Loft,scalp?:{sections:Section[];offset:THREE.Vector3}):THREE.BufferGeometry{
 const sections=d.sections,radial=d.radialSegments,rows=d.verticalSegments;
 const low=sections[0][0],high=sections[sections.length-1][0];
 const rings:Section[]=[],depths:number[]=[];
 for(let row=0;row<=rows;row++){
  const y=THREE.MathUtils.lerp(low,high,row/rows);
  rings.push([y,sample(sections,y,1),Math.max(.00001,sample(sections,y,2)),Math.max(.00001,sample(sections,y,3)),sample(sections,y,4)]);
  depths.push(0);
 }
 if(d.thickness){
  const half=d.thickness/2,outer=[...rings],top=outer[outer.length-1],bottom=outer[0];
  // Round the hem edges; a sharp inner rim has no unique outward normal.
  for(let j=1;j<=8;j++){
   const angle=Math.PI*j/8,offset=half*(1-Math.cos(angle));
   rings.push([top[0]+half*Math.sin(angle),top[1],top[2]-offset,top[3]-offset,top[4]]);
   depths.push(offset/d.thickness);
  }
  for(let row=outer.length-2;row>=0;row--){const a=outer[row];rings.push([a[0],a[1],a[2]-d.thickness,a[3]-d.thickness,a[4]]);depths.push(1);}
  for(let j=1;j<=8;j++){
   const angle=Math.PI+Math.PI*j/8,offset=half*(1-Math.cos(angle));
   rings.push([bottom[0]+half*Math.sin(angle),bottom[1],bottom[2]-offset,bottom[3]-offset,bottom[4]]);
   depths.push(offset/d.thickness);
  }
  rings.pop(); // close by shared indices, never a duplicate ring with split normals
  depths.pop();
 }
 const positions:number[]=[],uvs:number[]=[],indices:number[]=[];
 const columns=d.angularRange?radial+1:radial;
 const features=d.frontFeatures??[];
 for(let row=0;row<rings.length;row++){
  const [y,cx,rx,rz,cz]=rings[row];
  for(let j=0;j<columns;j++){
   const angle=d.angularRange?THREE.MathUtils.lerp(...d.angularRange,j/radial):j/radial*Math.PI*2,front=Math.max(0,Math.sin(angle));
   const yy=d.hemWarp?y+(d.hemWarp.frontLift*front-d.hemWarp.backDrop*Math.max(0,-Math.sin(angle)))*Math.exp(-(y-low)/d.hemWarp.decay):y;
   let x=cx+Math.cos(angle)*rx;
   let z=cz+Math.sin(angle)*rz;
   for(const f of features){const qx=(x-f.x)/f.width,qy=(y-f.y)/f.height;z+=f.depth*Math.exp(-qx*qx-qy*qy)*Math.pow(front,6);}
   if(scalp&&d.scalpOffset&&yy>=scalp.sections[0][0]&&yy<=scalp.sections[scalp.sections.length-1][0]){
    const hx=sample(scalp.sections,yy,1),hz=sample(scalp.sections,yy,4),hrx=sample(scalp.sections,yy,2),hrz=sample(scalp.sections,yy,3);
    const dx=x+scalp.offset.x-hx,dz=z+scalp.offset.z-hz,radius=Math.hypot(dx,dz);
    if(radius>.00001){
     const ux=dx/radius,uz=dz/radius,boundary=1/Math.sqrt((ux/hrx)**2+(uz/hrz)**2);
     const minimum=boundary+d.scalpOffset.clearance+(1-depths[row])*(d.thickness??0);
     const fitted=Math.max(radius,minimum);
     x=hx+ux*fitted-scalp.offset.x;z=hz+uz*fitted-scalp.offset.z;
    }
   }
   positions.push(x,yy,z);uvs.push(j/radial,row/(rings.length-1));
  }
 }
 for(let row=0;row<(d.thickness?rings.length:rings.length-1);row++)for(let j=0;j<radial;j++){
  const next=(row+1)%rings.length;
  const jj=d.angularRange?j+1:(j+1)%radial;
  const a=row*columns+j,b=row*columns+jj,c=next*columns+j,e=next*columns+jj;
  indices.push(a,c,b,b,c,e);
 }
 if(d.angularRange&&d.thickness){
  const profile=rings.map(s=>new THREE.Vector2(s[2],s[0]));
  const caps=THREE.ShapeUtils.triangulateShape(profile,[]);
  for(const [j,angle,sign] of [[0,d.angularRange[0],-1],[radial,d.angularRange[1],1]]){
   const outward=new THREE.Vector3(-Math.sin(angle)*sign,0,Math.cos(angle)*sign);
   for(const face of caps){
    const ids=face.map(row=>row*columns+j);
    const [a,b,c]=ids.map(i=>new THREE.Vector3().fromArray(positions,i*3));
    if(b.clone().sub(a).cross(c.clone().sub(a)).dot(outward)<0)[ids[1],ids[2]]=[ids[2],ids[1]];
    indices.push(...ids);
   }
  }
 }
 if(!d.thickness){
  // Single poles close the cranial/mandibular volume without coincident rings.
  for(const [row,reverse] of [[0,true],[rings.length-1,false]] as const){
   const ring=rings[row],pole=positions.length/3;positions.push(ring[1],ring[0],ring[4]);uvs.push(.5,reverse?0:1);
   for(let j=0;j<radial;j++){const a=row*radial+j,b=row*radial+(j+1)%radial;indices.push(...(reverse?[pole,a,b]:[pole,b,a]));}
  }
 }
 const geometry=new THREE.BufferGeometry();
 geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
 geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));geometry.setIndex(indices);
 geometry.computeVertexNormals();geometry.computeBoundingBox();geometry.computeBoundingSphere();
 return geometry;
}

type ClothPanel={points:[number,number][];depth:number;centreX:number;radiusX:number;radiusZ:number;standOff:number;subdivisions:number};
type Tube={stations:[number,number,number,number][];radialSegments:number;steps:number};
function fingerTube(d:Tube):THREE.BufferGeometry{
 const controls=d.stations.map(s=>new THREE.Vector3(s[0],s[1],s[2]));
 const curve=new THREE.CatmullRomCurve3(controls,false,'centripetal');
 const frames=curve.computeFrenetFrames(d.steps,false),positions:number[]=[],normals:number[]=[],indices:number[]=[];
 for(let i=0;i<=d.steps;i++){
  const t=i/d.steps,scaled=t*(d.stations.length-1),row=Math.min(d.stations.length-2,Math.floor(scaled));
  const r=THREE.MathUtils.lerp(d.stations[row][3],d.stations[row+1][3],scaled-row);
  const center=curve.getPointAt(t),n=frames.normals[i],b=frames.binormals[i];
  for(let j=0;j<d.radialSegments;j++){
   const a=j/d.radialSegments*Math.PI*2;
   const nx=n.x*Math.cos(a)+b.x*Math.sin(a),ny=n.y*Math.cos(a)+b.y*Math.sin(a),nz=n.z*Math.cos(a)+b.z*Math.sin(a);
   positions.push(center.x+r*nx,center.y+r*ny,center.z+r*nz);normals.push(nx,ny,nz);
  }
 }
 for(let i=0;i<d.steps;i++)for(let j=0;j<d.radialSegments;j++){
  const a=i*d.radialSegments+j,b=i*d.radialSegments+(j+1)%d.radialSegments,c=(i+1)*d.radialSegments+j,e=(i+1)*d.radialSegments+(j+1)%d.radialSegments;
  indices.push(a,b,c,b,e,c);
 }
 const base=positions.length/3,start=controls[0],end=controls.at(-1)!;
 const startTangent=curve.getTangentAt(0),endTangent=curve.getTangentAt(1);
 positions.push(start.x,start.y,start.z,end.x,end.y,end.z);
 normals.push(-startTangent.x,-startTangent.y,-startTangent.z,endTangent.x,endTangent.y,endTangent.z);
 for(let j=0;j<d.radialSegments;j++){
  const a=j,b=(j+1)%d.radialSegments, c=d.steps*d.radialSegments+j,e=d.steps*d.radialSegments+(j+1)%d.radialSegments;
  indices.push(base,b,a,base+1,c,e);
 }
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));g.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));g.setIndex(indices);g.computeBoundingBox();g.computeBoundingSphere();return g;
}

function fittedPanel(d:ClothPanel):THREE.BufferGeometry{
 const points=d.points.map(p=>new THREE.Vector2(...p));
 const faces=THREE.ShapeUtils.triangulateShape(points,[]),positions:number[]=[];
 const emit=(a:THREE.Vector3,b:THREE.Vector3,c:THREE.Vector3,level:number)=>{
  if(level>0){
   const ab=a.clone().lerp(b,.5),bc=b.clone().lerp(c,.5),ca=c.clone().lerp(a,.5);
   emit(a,ab,ca,level-1);emit(ab,b,bc,level-1);emit(ca,bc,c,level-1);emit(ab,bc,ca,level-1);return;
  }
  for(const p of [a,b,c]){
   const r=THREE.MathUtils.clamp((p.x-d.centreX)/d.radiusX,-.995,.995);
   positions.push(p.x,p.y,d.radiusZ*Math.sqrt(1-r*r)+d.standOff+p.z);
  }
 };
 for(const face of faces){
  const p=face.map(i=>new THREE.Vector3(points[i].x,points[i].y,0));
  if(p[1].clone().sub(p[0]).cross(p[2].clone().sub(p[0])).z<0)[p[1],p[2]]=[p[2],p[1]];
  emit(p[0],p[1],p[2],d.subdivisions);
  const back=p.map(q=>q.clone().add(new THREE.Vector3(0,0,-d.depth)));
  emit(back[0],back[2],back[1],d.subdivisions);
 }
 const clockwise=THREE.ShapeUtils.isClockWise(points);
 for(let j=0;j<points.length;j++){
  const aa=points[j],bb=points[(j+1)%points.length];
  const a=new THREE.Vector3(aa.x,aa.y,0),b=new THREE.Vector3(bb.x,bb.y,0),c=b.clone().add(new THREE.Vector3(0,0,-d.depth)),e=a.clone().add(new THREE.Vector3(0,0,-d.depth));
  if(clockwise){emit(a,b,c,d.subdivisions);emit(a,c,e,d.subdivisions);}
  else{emit(a,c,b,d.subdivisions);emit(a,e,c,d.subdivisions);}
 }
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
 const welded=mergeVertices(g,1e-6);g.dispose();welded.computeVertexNormals();welded.computeBoundingBox();welded.computeBoundingSphere();return welded;
}

function curvedBlade(rows:{y:number;left:number;right:number}[],thickness:number):THREE.BufferGeometry{
 const positions:number[]=[],indices:number[]=[];
 for(const row of rows){
  const left=(row.left-280)/400,right=(row.right-280)/400,y=(1040-row.y)/400;
  const spine=THREE.MathUtils.lerp(left,right,.18);
  // A diamond grind is a volume with a spine and two converging cutting edges.
  positions.push(left,y,0,spine,y,thickness/2,right,y,0,spine,y,-thickness/2);
 }
 for(let i=0;i<rows.length-1;i++)for(let j=0;j<4;j++){
  const a=i*4+j,b=i*4+(j+1)%4,c=(i+1)*4+j,e=(i+1)*4+(j+1)%4;
  indices.push(a,b,c,b,e,c);
 }
 indices.push(0,2,1,0,3,2);
 const end=(rows.length-1)*4;indices.push(end,end+1,end+2,end,end+2,end+3);
 for(let i=0;i<indices.length;i+=3){const b=indices[i+1];indices[i+1]=indices[i+2];indices[i+2]=b;}
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));g.setIndex(indices);
 g.computeVertexNormals();g.computeBoundingBox();g.computeBoundingSphere();return g;
}

export function refineZoroGeometry(meshes:Record<string,THREE.Mesh>):void{
 for(const mesh of Object.values(meshes)){
  const descriptor=mesh.userData.sculptComponent?.geometryDescriptor;
  const loft=descriptor?.parametricLoft as Loft|undefined;
  const blade=descriptor?.bladeRibbon as {rows:{y:number;left:number;right:number}[];thickness:number}|undefined;
  const panel=descriptor?.fittedPanel as ClothPanel|undefined;
  const finger=descriptor?.fingerTube as Tube|undefined;
  if(!loft&&!blade&&!panel&&!finger)continue;
  const anchor=loft?.scalpOffset?meshes[loft.scalpOffset.component]:undefined;
  const scalp=anchor?{sections:anchor.userData.sculptComponent.geometryDescriptor.parametricLoft.sections as Section[],offset:mesh.parent!.position.clone()}:undefined;
  const geometry=loft?loftGeometry(loft,scalp):panel?fittedPanel(panel):finger?fingerTube(finger):curvedBlade(blade!.rows,blade!.thickness);
  mesh.geometry.dispose();mesh.geometry=geometry;
  mesh.userData.geometryProvenance={method:'code-generated parametric loft',parameters:'sculptComponent.geometryDescriptor.parametricLoft',sourceMeshImported:false};
 }
}
