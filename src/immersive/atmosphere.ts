import * as T from 'three';

/** A light screen-space layer; the painted characters and original color stay untouched. */
export function atmosphere(world: number) {
  const count=innerWidth<=650?36:64,positions=new Float32Array(count*3),speeds=new Float32Array(count);
  for(let i=0;i<count;i++){
    const seed=Math.sin((i+1)*127.1+world*31.7)*43758.5453;
    positions.set([seed-Math.floor(seed),(Math.sin(seed)*.5+.5),i/count],i*3);speeds[i]=.012+(i%7)*.003;
  }
  const geometry=new T.BufferGeometry();geometry.setAttribute('position',new T.BufferAttribute(positions,3));geometry.setAttribute('speed',new T.BufferAttribute(speeds,1));
  const material=new T.ShaderMaterial({
    uniforms:{time:{value:0},theme:{value:world},ratio:{value:Math.min(devicePixelRatio,1.5)}},transparent:true,depthTest:false,depthWrite:false,toneMapped:false,
    vertexShader:`uniform float time;uniform float theme;uniform float ratio;attribute float speed;varying float phase;
      void main(){phase=position.z;vec2 p=position.xy;p.y=fract(p.y+time*speed*(theme==1.?-1.:1.));p.x+=sin(time*.25+phase*40.)*.022;gl_Position=vec4(p*2.-1.,0.,1.);gl_PointSize=(theme==1.?5.+phase*4.:1.5+phase*2.)*ratio;}`,
    fragmentShader:`uniform float theme;varying float phase;void main(){vec2 p=gl_PointCoord-.5;float d=theme==1.?length(vec2(p.x*.85+p.y*.35,p.y*1.5)):length(p);float alpha=(1.-smoothstep(.12,.48,d))*(theme==1.?.30:.35);vec3 color=theme==1.?vec3(.83,.63,1.):theme==2.?vec3(1.,.66,.35):vec3(.75,.94,1.);gl_FragColor=vec4(color,alpha);}`,
  });
  const points=new T.Points(geometry,material);points.frustumCulled=false;points.renderOrder=-999;return {points,material};
}
