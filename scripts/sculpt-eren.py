"""Young cadet Eren, authored from the user's visible full-body reference.
No source pixels/landmark scores are claimed. Uses the existing project Blender
sculpt toolkit, not an img2threejs-accepted generated factory.
blender -b --python-exit-code 1 --python scripts/sculpt-eren.py -- --output /tmp/eren
"""
import bpy,sys,json,argparse,importlib.util,math
from pathlib import Path
from mathutils import Vector
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('cast_sculpt',ROOT/'scripts/sculpt-anime-cast.py')
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
c.PROFILES['eren']=dict(width=.157,jaw=.75,eye=.020,skin=(.70,.47,.32),hair=(.012,.008,.005),iris=(.10,.22,.18),body=.98)


def eren_hair():
    m=c.mat('Hair | cadet brown',(.014,.009,.006),.76)
    def paint(u,v):
        shade=.68+.32*math.sin(u*math.pi*35+.3*math.sin(v*8))**4
        return tuple(x*shade for x in (.022,.013,.008))
    c.texture(m,c.pattern('Eren brown hair strands',256,paint))
    vs=[];faces=[];uv=[];N=64;M=26
    for i in range(M+1):
        for j in range(N+1):
            a=j/N*math.pi*2;theta=.01+(1.06+.94*(1-math.cos(a))/2-.01)*i/M
            y=c.HEAD_Y+.227*math.cos(theta);rx,rz,cz=c.head_shape(y)
            vs.append(((rx+.006)*math.sin(a),y,cz+(rz+.008)*math.cos(a)));uv.append((j/N,i/M))
            if i and j:faces.append(((i-1)*(N+1)+j-1,i*(N+1)+j-1,i*(N+1)+j,(i-1)*(N+1)+j))
    c.obj('Hair | fitted short scalp',vs,faces,m,uv)
    # Asymmetrical separated centre fringe. Short cadet cut, no adult bun.
    for side in (-1,1):
        for j in range(6):
            x=side*(.019+j*.022);tipx=x+side*(.025+.008*math.sin(j))
            tipy=c.HEAD_Y+(.055 if j<2 else .080)+.012*math.sin(j*1.7)
            c.hair_lock('Hair | swept centre fringe',[(x*.45,c.HEAD_Y+.222,.045),(x*.85,c.HEAD_Y+.245,.157),(x*1.05,c.HEAD_Y+.14,.183),(tipx,tipy,.155-abs(x)*.12)],.021,m,(side*.25,0,1),20)
    for j in range(26):
        a=1.02+(2*math.pi-2.04)*j/25;out=(math.sin(a),0,math.cos(a));r=.166
        end=(r*math.sin(a),c.HEAD_Y-.042+.017*math.sin(j*2.3),.012+.143*math.cos(a))
        c.hair_lock('Hair | tapered ear and nape locks',[(math.sin(a)*.085,c.HEAD_Y+.205,.01+math.cos(a)*.075),(math.sin(a)*.177,c.HEAD_Y+.19,.01+math.cos(a)*.15),(end[0]*1.04,c.HEAD_Y+.03,end[2]*1.02),end],.023,m,out,18)
    return m


def training_badge(p,scale,blue,white,ink,back=False):
    # Training Corps crossed blades, rather than the Survey Corps wings.
    cx,cy,cz=p;sgn=-1 if back else 1
    c.cube('Insignia | training shield',p,(scale*.74,scale,.004),ink,.004)
    for side in (-1,1):
        c.seam_path('Insignia | crossed sword emblem',[(cx-side*scale*.22,cy-scale*.31,cz+sgn*.004),(cx+side*scale*.22,cy+scale*.32,cz+sgn*.004)],white,.0018)
        c.seam_path('Insignia | sword guard',[(cx-side*scale*.25,cy-scale*.11,cz+sgn*.005),(cx-side*scale*.04,cy-scale*.24,cz+sgn*.005)],white,.0015)


base_garments=c.garments
base_head=c.head

def eren_head(skin,ink,hair):
    base_head(skin,ink,hair)
    for o in list(bpy.context.scene.objects):
        if o.name.startswith(('Brow |','Face | quiet mouth')):bpy.data.objects.remove(o,do_unlink=True)
    for side in (-1,1):
        cx=side*.071;points=[]
        for j in range(17):
            x=cx+(j/16*2-1)*.045;y=c.HEAD_Y+.047+side*(x-cx)*.22
            points.append((x,y))
        c.strip('Brow | determined cadet expression',points,.0034,hair)
    lip=c.mat('Face | cadet lip line',(.20,.075,.055),.9)
    c.face_curve('Face | serious mouth',[(-.027,c.HEAD_Y-.094,.003),(0,c.HEAD_Y-.090,.003),(.027,c.HEAD_Y-.094,.003)],.0011,lip)

def eren_garments(skin,ink,hair):
    # Share the anatomical garment foundation, then author cadet-specific modules.
    old=c.CID;old_profile=c.PROFILES['levi'];old_badge=c.badge
    try:
        c.CID='levi';c.PROFILES['levi']=c.PROFILES['eren'];c.badge=training_badge
        base_garments(skin,ink,hair)
    finally:c.CID=old;c.PROFILES['levi']=old_profile;c.badge=old_badge
    remove=('Cloak','Cravat','ODM','Weapon','Clothing | folded shirt collar','Clothing | tailored undershirt','Harness | torso strap')
    for o in list(bpy.context.scene.objects):
        if o.type=='MESH' and o.name.startswith(remove):bpy.data.objects.remove(o,do_unlink=True)
    jacket=c.fabric('Cadet | muted brown jacket',(.15,.080,.041))
    leather=c.fabric('Cadet | dark harness leather',(.026,.016,.012))
    boots=c.fabric('Cadet | dark brown boots',(.018,.010,.008))
    ivory=c.fabric('Cadet | ivory lace-up shirt',(.64,.60,.46))
    metal=c.mat('Cadet | brushed buckles',(.32,.34,.30),.44,.65)
    for o in bpy.context.scene.objects:
        if o.type!='MESH' or not o.data.materials:continue
        if o.name.startswith('Boot'):o.data.materials[0]=boots
        elif o.name.startswith('Harness') and 'clasp' not in o.name and 'buckle' not in o.name:o.data.materials[0]=leather
        elif o.data.materials[0].name.startswith('Leather'):o.data.materials[0]=jacket
    c.loft('Shirt | ivory torso',[(1.31,.232,.195,.065),(1.51,.242,.199,.065),(1.74,.242,.194,.05),(1.84,.222,.17,.04),(1.90,.094,.075,.035)],ivory,fold=.001)
    # Open neck and paired eyelets, with visible crossing cord over the shirt.
    c.obj('Shirt | open neck inset',[(-.047,1.91,.117),(.047,1.91,.117),(0,1.785,.249)],[(0,1,2)],skin)
    for j in range(4):
        y=1.81+j*.023;w=.015+j*.006;z=.261-(y-1.81)*1.05
        for side in (-1,1):
            c.torus('Shirt | lace eyelet',(side*w,y,z),.0038,.001,metal,(math.pi/2,0,0))
        if j<3:
            yy=y+.023;zz=.261-(yy-1.81)*1.05;ww=w+.006
            for side in (-1,1):c.line('Shirt | crossed neck lace',[(side*w,y,z+.003),(-side*ww,yy,zz+.003)],.0018,ink)
    c.belt('Harness | chest strap',1.765,.252,.207,.043,.025,leather)
    c.cube('Harness | chest clasp',(0,1.765,.258),(.037,.032,.009),metal,.003)
    for side in (-1,1):
        c.line('Harness | cadet shoulder brace',[(side*.12,1.88,.14),(side*.12,1.70,.26),(side*.105,1.39,.26)],.009,leather)
    skirt=c.loft('Clothing | cadet hip wrap',[(1.075,.283,.215,.045),(1.16,.278,.212,.050),(1.29,.257,.206,.060),(1.37,.247,.196,.065)],leather,gap=.20,fold=.0015)
    for v in skirt.data.vertices:
        if v.co.z<1.18:v.co.z+=.065*(1-min(1,abs(v.co.x)/.24))
    c.belt('Harness | cadet waist strap',1.37,.255,.209,.063,.038,leather)
    c.cube('Harness | cadet waist clasp',(0,1.37,.28),(.059,.038,.010),metal,.003)
    # Shoulder epaulets, small fasteners, and large upper-arm training patch.
    for side in (-1,1):
        c.line('Jacket | shoulder epaulet',[(side*.11,1.913,.045),(side*.245,1.87,.045)],.011,jacket)
        c.ell('Jacket | epaulet button',(side*.13,1.918,.048),(.004,.004,.004),metal)
    training_badge((.294,1.76,.076),.090,metal,ivory,ink)
    c.badge=old_badge


def main():
    p=argparse.ArgumentParser();p.add_argument('--output',type=Path,default=ROOT/'public/models');p.add_argument('--save-blend',action='store_true')
    args=p.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
    args.output.mkdir(parents=True,exist_ok=True);c.hair=eren_hair;c.head=eren_head;c.garments=eren_garments
    report=c.build('eren',args.output,args.save_blend)
    report['source']='scripts/sculpt-eren.py';report['referenceMethod']='visual interpretation of user inline full-body reference; no pixel-fidelity score'
    dest=args.output/'build-report.json';old=json.loads(dest.read_text()) if dest.exists() else []
    dest.write_text(json.dumps([x for x in old if x['id']!='eren']+[report],indent=2)+'\n')
    manifest=args.output/'manifest.json'
    if manifest.exists():
        data=json.loads(manifest.read_text())
        for asset in data['assets']:
            if asset['id']=='eren':
                asset.update({key:report[key] for key in ('sha256','joints','sculptVersion','animations')})
        manifest.write_text(json.dumps(data,indent=2,ensure_ascii=False)+'\n')

if __name__=='__main__':main()
