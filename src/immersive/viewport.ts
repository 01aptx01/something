const clamp=(v:number,min:number,max:number)=>Math.max(min,Math.min(max,v));
export function boundedOffset(span:number,focus:number,pan:number) {
  const base=span*focus,margin=Math.min(.004,span/2);
  return clamp(base+clamp(pan,-1,1)*(pan<0?base:span-base),margin,span-margin);
}
export function panAfterDrag(crop:number,focus:number,pan:number,pixels:number,extent:number) {
  const span=1-crop,base=span*focus;
  const next=clamp(boundedOffset(span,focus,pan)+pixels/Math.max(1,extent)*crop,0,span);
  return clamp((next-base)/Math.max(.00001,next<base?base:span-base),-1,1);
}
export function portraitLimit(frameWidth:number,frameHeight:number,imageAspect:number,zoom:number):[number,number] {
  const width=Math.min(frameWidth,frameHeight*imageAspect),height=width/Math.max(.001,imageAspect);
  return [Math.max(0,(width*zoom-frameWidth)/2)+16,Math.max(0,(height*zoom-frameHeight)/2)+16];
}
