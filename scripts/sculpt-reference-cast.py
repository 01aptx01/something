"""Visual-reference costume revisions requested by the user.
Uses the project's original Blender toolkit. No img2threejs pixel acceptance is
claimed; inline chat images inform the authored shapes, not measured pixels.
"""
import bpy,math,sys,json,argparse,importlib.util
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('cast',ROOT/'scripts/sculpt-anime-cast.py');c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
IDS=('zoro','tanjiro','nezuko','mikasa');base_garments=c.garments;base_head=c.head

def ribbon(name,points,width,material):
    v=[];f=[];uv=[]
    for i,(x,y,z) in enumerate(points):
        for sign in (-1,1):v.append((x+sign*width/2,y,z));uv.append(((sign+1)/2,i/(len(points)-1)))
        if i:f.append((i*2-2,i*2-1,i*2+1,i*2))
    o=c.obj(name,v,f,material,uv,1);m=o.modifiers.new('Woven band thickness','SOLIDIFY');m.thickness=.003
    return o

def smile_head(skin,ink,hair):
    base_head(skin,ink,hair)
    if c.CID not in ('tanjiro','zoro'):return
    for o in list(bpy.context.scene.objects):
        if o.name.startswith(('Face | quiet mouth','Face | lower lip plane')):bpy.data.objects.remove(o,do_unlink=True)
    cavity=c.mat('Face | smile cavity',(.055,.008,.012),.9);teeth=c.mat('Face | smile teeth',(.83,.79,.69),.75)
    y=c.HEAD_Y-.089;w=.038 if c.CID=='tanjiro' else .043;h=.023 if c.CID=='tanjiro' else .012
    v=[(0,y,c.face_z(0,y)+.004)];f=[]
    for j in range(49):
        a=j/48*math.pi*2;x=math.cos(a)*w;yy=y+math.sin(a)*h;v.append((x,yy,c.face_z(x,yy)+.004))
        if j:f.append((0,j,j+1))
    c.obj('Face | open smile',v,f,cavity)
    v=[];f=[]
    for i in range(21):
        x=(i/20*2-1)*w*.86;arc=math.sqrt(max(0,1-(x/w)**2))
        for sign in (-1,1):
            yy=y+sign*h*.70*arc if c.CID=='zoro' else y+h*arc*.72+sign*h*.20
            v.append((x,yy,c.face_z(x,yy)+.0055))
        if i:f.append((i*2-2,i*2-1,i*2+1,i*2))
    c.obj('Face | upper tooth band',v,f,teeth)
    if c.CID=='zoro':
        c.face_curve('Face | clenched tooth seam',[(-w*.82,y,.007),(0,y-.001,.007),(w*.82,y,.007)],.00045,ink)
        for x in (-.025,-.012,.012,.025):c.face_curve('Face | tooth division',[(x,y-.005,.007),(x,y+.005,.007)],.00030,ink)


def revised_garments(skin,ink,hair):
    base_garments(skin,ink,hair)
    if c.CID=='zoro':
        purple=c.fabric('Reference | purple magenta sash',(.20,.025,.065))
        for o in bpy.context.scene.objects:
            if o.type=='MESH' and o.name.startswith('Clothing | crimson waist wrap'):o.data.materials[0]=purple
        c.belt('Clothing | wide wrapped purple sash',1.27,.298,.245,.07,.14,purple)
        for j in range(3):
            points=[]
            for t in range(21):
                a=-1.35+t/20*2.70;points.append((.301*math.sin(a),1.225+j*.040+.008*math.sin(a),.07+.249*math.cos(a)+.002))
            c.line('Clothing | layered sash crease',points,.0015,purple)
        robe=next(o.data.materials[0] for o in bpy.context.scene.objects if o.type=='MESH' and o.name.startswith('Clothing | cut and draped overcoat'))
        c.loft('Clothing | closed lower robe',[(.55,.325,.230,.070),(.70,.317,.228,.070),(1.02,.285,.225,.075),(1.22,.277,.225,.075)],robe,fold=.0012)

        for j in range(2):
            c.hair_lock('Clothing | hanging sash tail',[(.25+j*.025,1.31,.20),(.32+j*.025,1.18,.29),(.30+j*.035,.98,.29),(.30+j*.030,.75-j*.04,.26)],.044,purple,(0,0,1),24)
        c.ell('Clothing | sash knot',(.26,1.31,.25),(.045,.052,.032),purple)
        horn=c.mat('Clothing | horn toggles',(.27,.16,.075),.85)
        for j in range(4):
            y=1.10-j*.125
            c.line('Clothing | robe toggle', [(-.06,y,.29),(.005,y+.004,.30),(.055,y+.007,.29)],.004,horn)
        black=c.fabric('Clothing | upper arm band',(.009,.012,.009))
        sh=c.k.bodypoint((1.8,5.1,0));el=c.k.bodypoint((3.12,3.48,.13))
        c.tube('Clothing | left arm tied band',[sh.lerp(el,.38),sh.lerp(el,.55)],.090,black,sides=32)
    elif c.CID=='tanjiro':
        # Remove the hidden upper-rear trouser surface under the opaque haori.
        # Its anatomical seat otherwise penetrates the garment envelope.
        import bmesh
        for o in bpy.context.scene.objects:
            if o.type=='MESH' and o.name.startswith('Clothing | fitted trousers'):
                bm=bmesh.new();bm.from_mesh(o.data)
                hidden=[f for f in bm.faces if f.calc_center_median().z>1.01 and -f.calc_center_median().y<.035]
                bmesh.ops.delete(bm,geom=hidden,context='FACES')
                loose=[v for v in bm.verts if not v.link_faces]
                if loose:bmesh.ops.delete(bm,geom=loose,context='VERTS')
                bm.to_mesh(o.data);bm.free()
        wood=c.fabric('Backpack | cedar planks',(.20,.080,.034))
        metal=c.mat('Backpack | dark iron bands',(.022,.026,.032),.48,.65)
        brass=c.mat('Backpack | corner rivets',(.18,.16,.11),.40,.7)
        canvas=c.fabric('Backpack | ivory canvas straps',(.48,.43,.30))
        burgundy=c.fabric('Uniform | reference burgundy',(.035,.008,.014))
        for o in bpy.context.scene.objects:
            if o.type=='MESH' and o.name.startswith(('Clothing | tailored undershirt','Clothing | fitted trousers','Clothing | standing collar')):o.data.materials[0]=burgundy
        c.cube('Backpack | wooden carrying box',(0,1.58,-.322),(.39,.67,.285),wood,.007)
        for j in range(6):
            x=-.16+j*.064
            c.line('Backpack | plank joint',[(x,1.27,-.467),(x,1.89,-.467)],.0017,metal)
        for y in (1.32,1.60,1.84):
            c.cube('Backpack | iron reinforcing band',(0,y,-.472),(.40,.034,.012),metal,.002)
            for side in (-1,1):
                c.ell('Backpack | band rivet',(side*.17,y,-.482),(.004,.004,.002),brass)
                c.cube('Backpack | side band',(side*.198,y,-.324),(.012,.034,.286),metal,.002)
        for side in (-1,1):
            ribbon('Backpack | shoulder carrying strap',[(side*.155,1.89,-.18),(side*.17,1.91,-.01),(side*.18,1.90,.18),(side*.20,1.69,.31),(side*.17,1.45,.30),(side*.21,1.30,.12),(side*.18,1.29,-.20)],.038,canvas)
            c.cube('Backpack | strap adjuster',(side*.18,1.57,.315),(.049,.030,.009),brass,.003)
    elif c.CID=='nezuko':
        cord=c.fabric('Obi | reference gold orange cord',(.45,.20,.025))
        dark=c.fabric('Haori | reference black cloth',(.006,.005,.008))
        for o in bpy.context.scene.objects:
            if o.type!='MESH' or not o.data.materials:continue
            if o.name.startswith('Obi | crimson cord'):o.data.materials[0]=cord
            elif o.data.materials[0].name.startswith('Haori | plum-black'):o.data.materials[0]=dark
        c.ell('Obi | cord knot',(0,1.29,.34),(.017,.013,.009),cord)
        for side in (-1,1):c.hair_lock('Obi | knotted cord loop',[(0,1.29,.34),(side*.03,1.32,.35),(side*.055,1.28,.35),(side*.01,1.29,.345)],.006,cord)
    elif c.CID=='mikasa':
        leather=c.fabric('Uniform | hip wrap leather',(.038,.019,.012))
        housing=c.mat('ODM | reference dark housings',(.035,.040,.042),.47,.72)
        for o in bpy.context.scene.objects:
            if o.type=='MESH' and o.name.startswith('ODM | steel blade box'):o.data.materials[0]=housing
        skirt=c.loft('Clothing | layered hip wrap',[(1.08,.281,.218,.046),(1.18,.277,.216,.05),(1.30,.26,.21,.06),(1.37,.249,.199,.06)],leather,gap=.24,fold=.0015)
        for v in skirt.data.vertices:
            if v.co.z<1.17:v.co.z+=.065*(1-min(1,abs(v.co.x)/.24))
        for side in (-1,1):c.line('Clothing | hip wrap hem',[(side*.064,1.14,.263),(side*.19,1.10,.22),(side*.27,1.10,.10)],.0015,leather)

def main():
    p=argparse.ArgumentParser();p.add_argument('--output',type=Path,default=ROOT/'public/models');p.add_argument('characters',nargs='*',choices=IDS)
    args=p.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []);args.output.mkdir(parents=True,exist_ok=True)
    c.head=smile_head;c.garments=revised_garments;dest=args.output/'build-report.json';old=json.loads(dest.read_text()) if dest.exists() else [];report={x['id']:x for x in old}
    selected=args.characters or IDS
    for cid in selected:
        data=c.build(cid,args.output);data.update(source='scripts/sculpt-reference-cast.py',referenceMethod='visual interpretation of user inline image; no measured pixel-fidelity score');report[cid]=data
    dest.write_text(json.dumps(list(report.values()),indent=2)+'\n')
    manifest=args.output/'manifest.json'
    if manifest.exists():
        data=json.loads(manifest.read_text())
        for asset in data['assets']:
            if asset['id'] in selected:
                asset['sha256']=report[asset['id']]['sha256'];asset['source']='scripts/sculpt-reference-cast.py'
                asset['referenceMethod']='Visual interpretation of user inline image; no img2threejs pixel acceptance.'
        manifest.write_text(json.dumps(data,indent=2,ensure_ascii=False)+'\n')
if __name__=='__main__':main()
