export type Point = readonly [number,number];
export type CharacterRegion = { id:string; polygon:readonly Point[] };
// Source-image coordinates (top-left origin). Foreground figures take precedence.
export const CHARACTER_REGIONS: readonly (readonly (readonly CharacterRegion[])[])[] = [
 [
  [{id:'luffy',polygon:[[.69,.16],[.78,.16],[.84,.44],[.89,.67],[.77,.74],[.70,.49]]},{id:'zoro',polygon:[[.61,.36],[.67,.36],[.68,.52],[.63,.65],[.59,.59]]}],
  [{id:'luffy',polygon:[[.68,.29],[.78,.29],[.84,.53],[.82,.89],[.68,.89],[.65,.53]]},{id:'zoro',polygon:[[.84,.29],[.93,.29],[.99,.57],[.98,.86],[.86,.86],[.83,.51]]}],
  [{id:'luffy',polygon:[[.75,.16],[.83,.17],[.89,.48],[.80,.66],[.70,.72],[.71,.47],[.68,.40]]}],
 ],
 [
  [{id:'tanjiro',polygon:[[.68,.14],[.83,.14],[.86,.40],[.95,.65],[.93,.96],[.49,.98],[.51,.72],[.62,.39]]},{id:'nezuko',polygon:[[.91,.19],[1,.18],[1,.88],[.92,.75],[.85,.43]]}],
  [{id:'tanjiro',polygon:[[.68,.19],[.82,.19],[.85,.44],[.94,.69],[.91,.96],[.52,.98],[.53,.67],[.62,.42]]},{id:'nezuko',polygon:[[.86,.29],[.96,.28],[1,.54],[1,.91],[.89,.83],[.83,.50]]}],
  [{id:'tanjiro',polygon:[[.72,.19],[.82,.19],[.91,.40],[.88,.67],[.75,.73],[.66,.51],[.58,.44],[.60,.37],[.70,.37]]},{id:'nezuko',polygon:[[.47,.35],[.50,.35],[.52,.54],[.45,.54],[.46,.43]]}],
 ],
 [
  [{id:'levi',polygon:[[.56,.41],[.65,.41],[.75,.79],[.68,.98],[.51,.98],[.47,.70],[.32,.47],[.46,.41]]},{id:'mikasa',polygon:[[.85,.30],[.92,.33],[.91,.49],[.79,.67],[.72,.63],[.74,.49],[.75,.35]]}],
  [{id:'levi',polygon:[[.68,.35],[.77,.35],[.84,.51],[.98,.61],[.97,.73],[.76,.70],[.69,.85],[.61,.82],[.66,.58]]},{id:'mikasa',polygon:[[.86,.20],[.92,.20],[.96,.40],[.91,.54],[.82,.53],[.79,.42]]}],
  [{id:'levi',polygon:[[.60,.32],[.68,.32],[.81,.66],[.79,.92],[.56,.93],[.49,.74],[.52,.60],[.61,.48]]},{id:'mikasa',polygon:[[.83,.16],[.90,.17],[.94,.29],[1,.34],[1,.43],[.92,.40],[.98,.64],[.94,.78],[.82,.62],[.79,.34]]}],
 ],
];
export function containsPoint(polygon:readonly Point[],u:number,v:number){
 let inside=false;
 for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){
  const [x,y]=polygon[i],[px,py]=polygon[j];
  if(((y>v)!==(py>v))&&u<(px-x)*(v-y)/(py-y)+x)inside=!inside;
 }
 return inside;
}
export function characterAt(world:number,scene:number,u:number,v:number){
 return CHARACTER_REGIONS[world]?.[scene]?.find(r=>containsPoint(r.polygon,u,v))?.id;
}
