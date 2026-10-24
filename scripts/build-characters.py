"""Legacy v1 sculptures and shared anatomical/mesh helpers. Blender 4.3+.
Use sculpt-anime-cast.py (npm run models:build) for the current v2 assets.
The user-uploaded Luffy is managed separately and is never overwritten.

blender -b --python scripts/build-characters.py
Anatomical foundation: MakeHuman hm08, CC0 (see model-source/).
All costume, hair, eyes, props, UV patterns and posing below are original.
"""
import bpy, bmesh, math, random, json, sys
from pathlib import Path
from mathutils import Vector, Matrix

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'public/models'
OUT.mkdir(exist_ok=True)
random.seed(71)
PI = math.pi
S = .137
verts, faces, uv, groups = [], [], [], {}
group = ''
for line in (ROOT/'scripts/model-source/base.obj').read_text().splitlines():
    a = line.split()
    if not a: continue
    if a[0]=='v': verts.append(tuple(map(float,a[1:4])))
    elif a[0]=='vt': uv.append(tuple(map(float,a[1:3])))
    elif a[0]=='g': group=a[1]
    elif a[0]=='f':
        f=[int(t.split('/')[0])-1 for t in a[1:]]
        groups.setdefault(group,[]).append(f)

def xyz(p): return (p[0],-p[2],p[1])
def bodypoint(p):
    x,y,z=p
    if CURRENT not in ('nezuko','mikasa') and z>.7:
        z-=.30*math.exp(-((y-3.9)/.75)**2)*math.exp(-((abs(x)-.75)/.7)**2)
    # Lower the A-pose, bring the hands toward a relaxed standing position.
    if abs(x)>1.55 and y>-.2:
        side=1 if x>0 else -1
        weight=min(1,max(0,(abs(x)-1.55)/.55))
        angle=-side*math.radians(24)*weight
        dx,dy=x-side*1.67,y-5.25
        x=side*1.67+dx*math.cos(angle)-dy*math.sin(angle)
        y=5.25+dx*math.sin(angle)+dy*math.cos(angle)
        z*=1-.48*weight
        y-=max(0,z-.35)*.6*weight
    if p[1]<1: x*=1-.23*min(1,max(0,(1-p[1])/2))
    if y>5.8:
        w=min(1,(y-5.8)/.5)
        x*=1+(.23 if CURRENT=='zoro' else .10 if CURRENT in ('nezuko','mikasa') else .16)*w
        y=5.8+(y-5.8)*1.04
        # Gentle eye-socket enlargement, reduced nose projection.
        eye=math.exp(-((abs(x)-.36)/.32)**2-((y-7.36)/.35)**2)
        x+=(x-math.copysign(.36,x))*.18*eye
        y+=(y-7.36)*.24*eye
        z-=.12*math.exp(-(x/.2)**2-((y-7.05)/.42)**2)
    return Vector((x*S,(y+8.18)*S,z*S))

def mat(name,color,rough=.65,metal=0):
    m=bpy.data.materials.new(name);m.use_nodes=True
    n=m.node_tree.nodes.get('Principled BSDF')
    n.inputs['Base Color'].default_value=(*color,1)
    n.inputs['Roughness'].default_value=rough;n.inputs['Metallic'].default_value=metal
    return m

def pattern(name,size,fn):
    # Images generated once, embedded into each standalone GLB by the exporter.
    image=bpy.data.images.get(name)
    if image:return image
    image=bpy.data.images.new(name,width=size,height=size,alpha=True)
    pixels=[]
    for y in range(size):
        for x in range(size): pixels.extend((*fn(x/size,y/size),1))
    image.pixels.foreach_set(pixels);image.pack();return image

def texture(m,img,scale=1,normal=False):
    nodes=m.node_tree.nodes;links=m.node_tree.links
    tex=nodes.new('ShaderNodeTexImage');tex.image=img
    if normal:
        tex.image.colorspace_settings.name='Non-Color'
        n=nodes.new('ShaderNodeNormalMap');n.inputs['Strength'].default_value=.24
        links.new(tex.outputs['Color'],n.inputs['Color']);links.new(n.outputs['Normal'],nodes.get('Principled BSDF').inputs['Normal'])
    else: links.new(tex.outputs['Color'],nodes.get('Principled BSDF').inputs['Base Color'])

def obj(name,points,polygons,m,uvs=None,sub=0):
    data=bpy.data.meshes.new(name);data.from_pydata([xyz(p) for p in points],[],polygons);data.update()
    o=bpy.data.objects.new(name,data);bpy.context.collection.objects.link(o);o.data.materials.append(m)
    if uvs:
        layer=data.uv_layers.new(name='UVMap')
        for p in data.polygons:
            for li in p.loop_indices:layer.data[li].uv=uvs[data.loops[li].vertex_index]
    bm=bmesh.new();bm.from_mesh(data);bmesh.ops.remove_doubles(bm,verts=list(bm.verts),dist=.000001);bm.to_mesh(data);bm.free()
    for p in data.polygons:p.use_smooth=True
    if sub:
        mod=o.modifiers.new('Sculpt surface','SUBSURF');mod.levels=sub
    return o

def ell(name,p,scale,m):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=32,ring_count=20,location=xyz(p))
    o=bpy.context.object;o.name=name;o.scale=(scale[0],scale[2],scale[1]);o.data.materials.append(m)
    for f in o.data.polygons:f.use_smooth=True
    return o

def cube(name,p,scale,m,bevel=.008):
    bpy.ops.mesh.primitive_cube_add(size=1,location=xyz(p));o=bpy.context.object;o.name=name;o.scale=(scale[0],scale[2],scale[1]);
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True);o.data.materials.append(m)
    if bevel:
        mod=o.modifiers.new('Machined edges','BEVEL');mod.width=bevel;mod.segments=3
        mod=o.modifiers.new('Weighted normals','WEIGHTED_NORMAL')
    return o

def tube(name,points,r,m,radii=None,sides=12):
    points=[Vector(p) for p in points];v=[];f=[];uvs=[]
    for i,p in enumerate(points):
        tangent=(points[min(i+1,len(points)-1)]-points[max(0,i-1)]).normalized()
        axis=Vector((0,0,1))
        if abs(tangent.dot(axis))>.95:axis=Vector((1,0,0))
        u=tangent.cross(axis).normalized();w=tangent.cross(u)
        radius=r*(radii[i] if radii else 1)
        for j in range(sides+1):
            a=j/sides*2*PI;v.append(p+radius*(u*math.cos(a)+w*math.sin(a)));uvs.append((j/sides,i/max(1,len(points)-1)))
            if i and j:f.append(((i-1)*(sides+1)+j-1,i*(sides+1)+j-1,i*(sides+1)+j,(i-1)*(sides+1)+j))
    f.append(tuple(range(sides,-1,-1)));f.append(tuple((len(points)-1)*(sides+1)+j for j in range(sides+1)))
    return obj(name,v,[tuple(reversed(p)) for p in f],m,uvs)

def line(name,points,r,m):return tube(name,points,r,m,sides=8)

def loft(name,rings,m,gap=0,fold=.004,phase=0):
    # Curved garment panels, independently cut around the front opening.
    v=[];f=[];uvs=[];N=64
    for i,(y,rx,rz,cz) in enumerate(rings):
        for j in range(N+1):
            a=gap+(2*PI-2*gap)*j/N
            ripple=fold*(math.cos(a*7+phase+y*3)*(.3+.7*math.cos(y*5)**2)+.25*math.cos(a*15+y*15))
            v.append(((rx+ripple)*math.sin(a),y,(rz+ripple)*math.cos(a)+cz));uvs.append((j/N*2,i/(len(rings)-1)*2))
            if i and j:f.append(((i-1)*(N+1)+j-1,i*(N+1)+j-1,i*(N+1)+j,(i-1)*(N+1)+j))
    o=obj(name,v,[tuple(reversed(p)) for p in f],m,uvs,1)
    solid=o.modifiers.new('Cloth thickness','SOLIDIFY');solid.thickness=.003
    return o

def extract(name,m,predicate,offset=0):
    chosen=[f for f in groups['body'] if predicate(tuple(sum(verts[k][i] for k in f)/len(f) for i in range(3)))]
    ids=sorted(set(k for f in chosen for k in f));lookup={k:i for i,k in enumerate(ids)}
    points=[]
    for k in ids:
        x,y,z=verts[k];p=bodypoint((x,y,z))
        if offset:
            center=Vector((math.copysign(.19,p.x) if p.y<1.25 else 0,p.y,0))
            d=p-center;d.y=0
            if d.length:p+=d.normalized()*offset
            p.x+=math.sin(p.y*55+p.z*20)*.002
        points.append(p)
    o=obj(name,points,[[lookup[k] for k in f] for f in chosen],m,sub=1)
    # Triplanar-like UVs for small weave, seams and clothing microdetail.
    uv=o.data.uv_layers.new(name='UVMap')
    for p in o.data.polygons:
        for li in p.loop_indices:
            co=o.data.vertices[o.data.loops[li].vertex_index].co;uv.data[li].uv=(co.x*4,co.z*4)
    return o

def ribbon(name,controls,width,m,reverse=False):
    v=[];f=[];uvs=[];N=20;W=6
    def bez(t):return sum((Vector(controls[k])*math.comb(3,k)*(1-t)**(3-k)*t**k for k in range(4)),Vector())
    for i in range(N+1):
        t=i/N;p=bez(t);tangent=(bez(min(1,t+.01))-bez(max(0,t-.01))).normalized()
        side=tangent.cross(Vector((0,0,1))).normalized()
        if side.length<.1:side=Vector((1,0,0))
        w=width*(.25+.75*math.sin(PI*t)**.7)*(1-t**8)
        for j in range(W+1):
            u=j/W*2-1;q=p+side*u*w;q.z+=math.cos(u*PI/2)*w*.32
            v.append(q);uvs.append((j/W,t))
            if i and j:f.append(((i-1)*(W+1)+j-1,i*(W+1)+j-1,i*(W+1)+j,(i-1)*(W+1)+j))
    o=obj(name,v,[tuple(reversed(p)) for p in f],m,uvs)
    sol=o.modifiers.new('Hair volume','SOLIDIFY');sol.thickness=.003
    return o

def katana(p,angle,blade,guard,grip,length=.8,sheathed=False):
    objs=set(bpy.context.scene.objects)
    # Flattened, tapered, gently curved blade with a visible beveled edge.
    rows=20;v=[];f=[]
    for i in range(rows+1):
        t=i/rows;w=.014*(1-t**10);x=.04*t*t
        v.extend([(x-w,-length*t,0),(x,-length*t,.003),(x+w,-length*t,0),(x,-length*t,-.003)])
        if i:
            for j in range(4):f.append(((i-1)*4+j,i*4+j,i*4+(j+1)%4,(i-1)*4+(j+1)%4))
    obj('Curved steel blade',v,f,grip if sheathed else blade)
    ell('Sword tsuba',(0,.03,0),(.065,.012,.045),guard)
    tube('Braided grip',[(0,.02,0),(0,.23,0)],.022,grip,sides=16)
    for i in range(11):
        a=(i%2)*.5;line('Hilt binding',[(-.02,.05+i*.016,0),(0,.06+i*.016,.023),(.02,.05+i*.016,0)],.003,guard)
    bpy.context.view_layer.update()
    transform=Matrix.Translation(Vector(xyz(p))) @ Matrix.Rotation(-angle,4,'Y')
    for o in set(bpy.context.scene.objects)-objs:
        o.matrix_world=transform @ o.matrix_world

def build(cid):
    global CURRENT
    CURRENT=cid
    random.seed(71+sum(map(ord,cid)))
    bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
    # Remove data from the previous sculpture without deleting reusable images.
    for mesh in list(bpy.data.meshes):
        if mesh.users==0:bpy.data.meshes.remove(mesh)
    pirate=cid in ('luffy','zoro');scout=cid in ('levi','mikasa');female=cid in ('nezuko','mikasa')
    skin=mat('Warm skin',(.43,.22,.12) if cid=='zoro' else (.64,.40,.29) if female else (.55,.29,.17),.57)
    skin.node_tree.nodes.get('Principled BSDF').inputs['Specular IOR Level'].default_value=.25
    dark=mat('Indigo uniform',(.016,.023,.036),.88);black=mat('Ink black',(.008,.012,.018),.6)
    white=mat('Ivory cotton',(.72,.70,.60),.88);red=mat('Vermilion cloth',(.50,.025,.035),.8)
    green=mat('Forest cloth',(.035,.18,.095),.9);pink=mat('Rose silk',(.69,.26,.36),.62)
    leather=mat('Chestnut leather',(.22,.095,.042),.68);steel=mat('Brushed steel',(.42,.51,.58),.25,.9)
    gold=mat('Aged brass',(.58,.36,.095),.3,.75);seam=mat('Seam thread',(.48,.35,.19),.9)
    weave=pattern('Textile normal',128,lambda u,v:(.5+.12*math.sin(u*PI*64),.5+.12*math.sin(v*PI*64),1))
    for m in (dark,white,red,green,pink,leather):texture(m,weave,normal=True)
    if cid=='tanjiro':
        texture(green,pattern('Ichimatsu checks',256,lambda u,v:(.035,.20,.11) if (int(u*8)+int(v*8))%2==0 else (.008,.015,.018)))
    if cid=='nezuko':
        def asanoha(u,v):
            x=(u*8)%1;y=(v*8)%1
            edge=min(abs(x-.5),abs(y-.5),abs(x-y),abs(x+y-1))
            return (.35,.12,.17) if edge<.025 else (.72,.32,.41)
        texture(pink,pattern('Asanoha silk',512,asanoha))
    # Anatomical skin: retain the sculpted face, ears, hands and appropriate exposed limbs.
    extract('Anatomical skin and articulated fingers',skin,lambda p: (p[1]>6.1 or (p[1]>5.65 and abs(p[0])<.85)) or (abs(p[0])>3.7 and p[1]<3.1) or (cid=='luffy' and (p[1]<-3.25 or p[1]>.6)))
    if cid not in ('nezuko','luffy'):
        extract('Tailored trousers',white if scout else dark if cid!='luffy' else mat('Indigo denim',(.055,.16,.31),.95),lambda p: (-3.9 if scout else -4.9 if cid=='tanjiro' else -7.55)<p[1]<1.3 if cid!='luffy' else -3.45<p[1]<.8,.016 if scout else .025)
    if cid!='luffy':extract('Fitted undershirt',pink if cid=='nezuko' else white if scout or cid=='zoro' else dark,lambda p: 1<p[1]<5.62 and abs(p[0])<2.05,-.002)
    # Cloth cut and sewn around a human torso, rather than attached boxes.
    top=1.885;bottom=.97 if cid=='tanjiro' else .45 if cid=='nezuko' else 1.29 if cid=='luffy' else 1.38 if scout else 1.27
    coat=red if cid=='luffy' else white if cid=='zoro' else green if cid=='tanjiro' else mat('Chocolate haori',(.055,.024,.029),.91) if cid=='nezuko' else leather
    gap=.48 if cid=='luffy' else .64 if cid=='nezuko' else .40
    rings=[]
    for i in range(15):
        t=i/14;y=bottom+(top-bottom)*t
        rx=.25+.045*math.cos(t*2*PI)+(.025 if cid=='nezuko' else 0)*(1-t)
        if t>.8:rx-=.05*(t-.8)/.2
        rz=.175+(.035 if cid in ('luffy','zoro') else .027)*t
        rings.append((y,rx,rz,.080))
    rings.extend([(1.91,.15,.12,.065),(1.94,.075,.095,.045)])
    loft('Sewn open coat',rings,coat,gap,.006 if cid=='tanjiro' else .003)
    for side in (-1,1):
        # Curved lapels and a seam defining the front opening.
        path=[(side*rx*math.sin(gap),y,rz*math.cos(gap)+.085) for y,rx,rz,cz in rings]
        line('Coat edge piping',path,.004,coat if cid!='luffy' else seam)
        if cid!='luffy':
            shoulder=bodypoint((side*1.8,5.1,0));elbow=bodypoint((side*3.12,3.48,.13));wrist=bodypoint((side*4.24,2.5,1.7))
            ell('Tailored shoulder seam',shoulder+Vector((0,.015,0)),(.089 if cid in ('tanjiro','nezuko') else .073,.075,.088 if cid in ('tanjiro','nezuko') else .075),coat)
            points=[];radii=[]
            for i in range(17):
                t=i/16;p=shoulder.lerp(elbow,min(1,t*2)) if t<.5 else elbow.lerp(wrist,(t-.5)*2)
                points.append(p);radii.append((1.3-.55*t)*(1+.055*math.sin(t*45)))
            tube('Folded cloth sleeve',points,.095 if cid in ('tanjiro','nezuko') else .073,coat,radii,24)
            tube('Turned cuff',[points[-1],points[-1]+Vector((0,-.025,0))],.061,white if cid=='tanjiro' else coat,sides=24)
    # Belt, tailored hems, buckles and costume-specific details.
    if cid!='nezuko':
        loft('Waist sash' if pirate else 'Waist belt',[(1.255,.245,.164,.065),(1.28,.248,.166,.065),(1.34 if cid=='zoro' else 1.30,.246,.166,.065)],green if cid=='zoro' else mat('Yellow cotton sash',(.64,.39,.04),.9) if cid=='luffy' else leather,fold=.001)
        if not pirate:cube('Belt buckle',(0,1.285,.169),(.055,.038,.012),steel,.004)
    for side in (-1,1):
        if cid=='luffy':
            tube('Turned denim hem',[(side*.173,.65,.025),(side*.173,.705,.025)],.094,white,sides=32)
            ell('Leather sandal sole',(side*.22,.045,.13),(.087,.024,.18),leather)
            line('Sandal toe straps',[(side*.22-.07,.09,.16),(side*.22,.10,.08),(side*.22+.07,.09,.16)],.012,leather)
        else:
            x=side*.22
            ell('Leather boot toe' if scout else 'Sandal sole',(x,.055,.12),(.086,.052 if scout else .022,.16),leather if scout else dark)
            if scout:
                tube('Knee high fitted boot',[(x,.10,.02),(side*.195,.34,.015),(side*.174,.65,.02)],.075,leather,[.9,1,1.08],24)
                line('Boot stitching',[(x+.045,.13,.073),(side*.195+.05,.34,.078),(side*.174+.05,.65,.084)],.0018,seam)
            elif cid=='tanjiro':
                tube('White leg wraps',[(x,.13,0),(side*.19,.50,.02)],.08,white,[.9,1.05],24)
                for j in range(7):line('Leg wrap seams',[(x-.065,.16+j*.045,.058),(x+.065,.18+j*.045,.058)],.002,seam)
            elif cid=='nezuko':
                tube('Kyahan wraps',[(x,.12,0),(side*.18,.47,.02)],.077,white,[.9,1.03],24)
    # Sculpted scalp and layered, curved hair locks with directional highlights.
    haircolor=(.025,.16,.065) if cid=='zoro' else (.10,.016,.025) if cid=='tanjiro' else (.009,.011,.018)
    hair=mat('Layered hair',haircolor,.62)
    hair.node_tree.nodes.get('Principled BSDF').inputs['Specular IOR Level'].default_value=.22
    def hairtex(u,v):
        strand=.76+.22*math.cos(u*PI*62+math.sin(v*9))**6
        if cid=='nezuko' and v>.72:
            t=(v-.72)/.28;return tuple((haircolor[i]*(1-t)+(.38,.085,.024)[i]*t)*strand for i in range(3))
        return tuple(c*strand for c in haircolor)
    texture(hair,pattern('Hair strands '+cid,256,hairtex))
    cy=2.15;rx=.158;ry=.177;rz=.151;cz=.038
    v=[];f=[];uvs=[];N=48;M=16
    for i in range(M+1):
        for j in range(N+1):
            a=j/N*2*PI;end=1.25+.8*(1-math.cos(a))/2;t=.025+(end-.025)*i/M
            v.append((rx*math.sin(t)*math.sin(a),cy+ry*math.cos(t),cz+rz*math.sin(t)*math.cos(a)));uvs.append((j/N,i/M))
            if i and j:f.append(((i-1)*(N+1)+j-1,i*(N+1)+j-1,i*(N+1)+j,(i-1)*(N+1)+j))
    obj('Sculpted hair cap',v,f,hair,uvs)
    # Parted bangs stay above the eyes; side and rear layers establish each silhouette.
    for i in range(13):
        x=(i-6)*.022
        y=2.145+(.025 if cid in ('levi','mikasa') else 0)+.022*math.sin(i*2.1)
        if cid=='zoro':y=2.21+.012*math.sin(i*2)
        if cid=='tanjiro' and x<-.015:y=2.205+.012*math.sin(i*2)
        tipx=x+(.025 if cid in ('levi','mikasa') and x>0 else -.025 if cid in ('levi','mikasa') else .013*math.sin(i))
        ribbon('Sculpted fringe',[(x*.5,2.32,.06),(x*.9,2.30,.23),(x,2.20,.245),(tipx,y,.23-abs(x)*.12)],.021 if cid!='zoro' else .016,hair)
    for i in range(36 if cid!='zoro' else 62):
        a=i/(36 if cid!='zoro' else 62)*2*PI
        long=cid=='nezuko';bob=cid=='mikasa'
        if abs(a-PI*2)<.5 or a<.5:continue
        endy=1.16+random.random()*.17 if long else 1.96+random.random()*.025 if bob else 2.10+random.random()*.06
        start=(math.sin(a)*.07,2.32,cz+math.cos(a)*.06)
        end=(math.sin(a)*(.19 if bob else .21 if long else .17),endy,cz+math.cos(a)*(.19 if bob or long else .15))
        if cid=='zoro':end=(math.sin(a)*(.17+random.random()*.025),2.20+random.random()*.12,cz+math.cos(a)*.16)
        ribbon('Layered hair lock',[start,(math.sin(a)*.17,2.34,cz+math.cos(a)*.16),(end[0]*1.05,(2.21+endy)/2,end[2]+(-.02 if a>PI/2 and a<3*PI/2 else .01)),end],.025 if long else .023,hair)
    if cid=='tanjiro':
        for i in range(15):
            x=(i-7)*.018
            ribbon('Swept burgundy crown',[(x,2.22,.15),(x-.025,2.39,.19),(x+.04,2.40,-.02),(x+.06,2.31,-.13)],.024,hair)
    # Anatomical eye sockets with separate sclera, radial irises, pupils and catchlights.
    sclera=mat('Sclera',(.92,.89,.79),.24);lid=mat('Warm eyelid',(.40,.19,.13),.6)
    iris=mat('Iris',(.12,.035,.025),.28)
    irisbase=(.6,.16,.28) if cid=='nezuko' else (.23,.028,.04) if cid=='tanjiro' else (.075,.10,.12) if scout else (.30,.13,.045)
    def irisp(u,v):
        dx,dy=u-.5,v-.5;r=math.hypot(dx,dy)*2;a=math.atan2(dy,dx)
        if r<.38:return (.003,.004,.007)
        if r>.9:return (.008,.011,.017)
        k=(.7+.3*math.sin(a*87+r*25)**2)*(1.4-.6*r)
        return tuple(c*k for c in irisbase)
    texture(iris,pattern('Iris fibers '+cid,256,irisp))
    for side in (-1,1):
        center=bodypoint((side*.317,7.284,1.29))
        center.z+=.006
        if cid=='zoro' and side==1:
            ell('Closed eyelid',center+Vector((0,0,.010)),(.029,.023,.013),skin)
            line('Closed eye line',[(center.x-.025,center.y,center.z+.025),(center.x,center.y-.002,center.z+.025),(center.x+.025,center.y+.001,center.z+.018)],.002,black)
            line('Swordsman eye scar',[(center.x-.003,center.y+.055,center.z+.022),(center.x+.004,center.y+.01,center.z+.029),(center.x-.002,center.y-.05,center.z+.022)],.0028,lid)
            continue
        ey= .013 if scout else .021 if cid=='nezuko' else .018
        ell('Inset eye',center,(.027,ey,.021),sclera)
        # A curved disk gives the iris proper depth, rather than a painted planar face.
        vs=[(center.x,center.y,center.z+.023)];uvs=[(.5,.5)];fs=[]
        for j in range(49):
            a=j/48*2*PI;vs.append((center.x+math.cos(a)*.0135,center.y+math.sin(a)*(.012 if scout else .017 if cid=='nezuko' else .016),center.z+.020));uvs.append((.5+.5*math.cos(a),.5+.5*math.sin(a)))
            if j:fs.append((0,j,j+1))
        obj('Radial iris',vs,fs,iris,uvs)
        ell('Eye catchlight',(center.x-.004,center.y+.007,center.z+.024),(.0033,.0033,.001),sclera)
        for upper in (True,False):
            pts=[]
            for j in range(17):
                t=j/16;pts.append((center.x+(t-.5)*.055,center.y+(1 if upper else -1)*math.sin(t*PI)*(.012 if scout else .018),center.z+.010+math.sin(t*PI)*.004))
            line('Upper lash' if upper else 'Lower eyelid',pts,.0025 if upper else .0015,black if upper else lid)
        line('Expressive brow',[(center.x-side*.025,center.y+.039,center.z+.023),(center.x,center.y+.045,center.z+.026),(center.x+side*.030,center.y+.040,center.z+.019)],.004,hair)
    # Costume identifiers are modeled in volume and readable from side and back.
    if cid=='luffy':
        denim=mat('Woven indigo denim',(.035,.105,.24),.95);texture(denim,weave,normal=True)
        loft('Shorts waistband',[(1.08,.25,.17,.045),(1.22,.25,.17,.045),(1.28,.235,.16,.045)],denim,fold=.0015)
        for side in (-1,1):
            shorts=loft('Loose tailored shorts',[(.68,.098,.105,.045),(.72,.105,.11,.045),(.90,.118,.12,.045),(1.08,.126,.135,.045),(1.20,.12,.13,.045)],denim,fold=.0015)
            shorts.location.x=side*.145
        straw=mat('Woven straw',(.64,.40,.13),.82)
        texture(straw,pattern('Woven straw color',256,lambda u,v:tuple(c*(.85+.15*math.cos(u*PI*150)*math.cos(v*PI*100)) for c in (.64,.42,.16))))
        # Rounded brim, low crown and stitched red hatband.
        loft('Straw brim',[(2.315,.002,.002,0),(2.317,.18,.18,0),(2.320,.29,.29,0),(2.328,.30,.30,0),(2.335,.29,.29,0),(2.340,.18,.18,0),(2.341,.002,.002,0)],straw,fold=.001)
        ell('Straw crown',(0,2.35,0),(.193,.122,.19),straw)
        loft('Red hat band',[(2.347,.199,.196,0),(2.371,.196,.193,0)],red,fold=0)
        for side in (-1,1):
            for j in range(3):ell('Vest brass button',(side*.14,1.40+j*.12,.165),(.009,.009,.004),gold)
        line('Under eye scar',[(.063,2.103,.206),(.097,2.098,.190)],.0018,lid)
        line('Subtle smile',[(-.032,2.033,.208),(-.015,2.028,.218),(0,2.027,.220),(.015,2.028,.218),(.032,2.033,.208)],.0012,lid)
    if cid=='zoro':
        for i in range(3):katana((-.27,1.23-i*.045,-.07),-.26+i*.15,steel,gold,white if i==0 else black,.88,True)
        for i in range(3):ell('Gold earring',(-.146,2.09-i*.012,.052),(.007,.012,.006),gold)
    if cid=='tanjiro':
        for side in (-1,1):
            e=cube('Hanafuda earring',(side*.15,2.035,.055),(.035,.088,.004),white,.002)
            ell('Hanafuda red sun',(side*.15,2.052,.059),(.010,.010,.002),red)
            for j in range(5):line('Hanafuda ink ray',[(side*.15,2.05,.061),(side*.15+(j-2)*.006,2.005,.061)],.0008,black)
        scar=mat('Forehead scar',(.31,.055,.042),.8)
        # Project a thin irregular scar onto the actual forehead surface.
        samples=[bodypoint(verts[k]) for k in set(k for f in groups['body'] for k in f) if verts[k][1]>6.5 and verts[k][2]>.5]
        outline=[(-.045,2.211),(-.073,2.218),(-.083,2.206),(-.074,2.198),(-.09,2.184),(-.067,2.178),(-.049,2.191),(-.057,2.198)]
        patch=[]
        for x,y in outline:
            near=sorted(samples,key=lambda p:(p.x-x)**2+(p.y-y)**2)[:4]
            weights=[1/(.000001+(p.x-x)**2+(p.y-y)**2) for p in near]
            z=sum(p.z*w for p,w in zip(near,weights))/sum(weights)
            patch.append((x,y,z+.0015))
        center=tuple(sum(p[i] for p in patch)/len(patch) for i in range(3));patch.insert(0,center)
        obj('Forehead scar inlay',patch,[(0,i+1,(i+1)%len(outline)+1) for i in range(len(outline))],scar)

        katana((.28,1.21,-.08),.2,steel,black,black,.85,True)
        for j in range(5):ell('Uniform button',(0,1.38+j*.08,.16),(.006,.006,.003),gold)
    if cid=='nezuko':
        loft('Asanoha kimono',[(.25,.30,.18,.065),(.35,.29,.18,.065),(.65,.26,.17,.065),(.95,.23,.15,.065),(1.26,.21,.145,.065),(1.60,.22,.155,.065),(1.83,.18,.13,.065)],pink,fold=.005)
        loft('Obi sash',[(1.19,.25,.18,.065),(1.23,.253,.18,.065),(1.38,.252,.18,.065)],white,fold=0)
        loft('Crimson obi tie',[(1.265,.255,.184,.065),(1.30,.255,.184,.065)],red,fold=0)
        bamboo=mat('Living bamboo',(.16,.32,.055),.45)
        tube('Bamboo muzzle',[(-.105,2.055,.212),(.105,2.055,.212)],.026,bamboo,sides=32)
        for side in (-1,1):tube('Bamboo node',[(side*.075,2.055,.212),(side*.080,2.055,.212)],.029,gold,sides=24)
        line('Muzzle cord',[(-.12,2.055,.21),(-.15,2.065,.065),(0,2.05,-.115),(.15,2.065,.065),(.12,2.055,.21)],.003,red)
        for side in (-1,1):ell('Pink hair ribbon',(side*.017+.126,2.29,.11),(.025,.016,.010),pink)
    if scout:
        for side in (-1,1):
            # Believable straps follow chest and thigh surfaces, with metal buckles.
            line('Crossed harness',[(side*.22,1.82,.09),(-side*.13,1.39,.163)],.014,leather)
            for y in (.88,1.06):
                loft('Thigh harness',[(y,.09,.09,0),(y+.025,.092,.092,0)],leather,fold=0).location.x=side*.17
                cube('Harness clasp',(side*.17,y+.012,.097),(.038,.028,.01),steel,.003)
            cube('ODM blade scabbard',(side*.30,1.06,-.04),(.11,.13,.37),steel,.008)
            for j in range(5):cube('ODM blade cartridges',(side*.30,1.01+j*.023,.151),(.075,.009,.014),black,.001)
            tube('Gas canister',[(side*.27,.96,-.19),(side*.27,1.20,-.19)],.045,steel,sides=24)
            tube('Gas line',[(side*.27,1.20,-.19),(side*.22,1.30,-.15),(side*.14,1.27,0)],.006,black)
            katana((side*.39,1.12,.13),side*-.20,steel,steel,black,.77)
            cube('Jacket chest pocket',(side*.16,1.68,.171),(.09,.09,.014),leather,.004)
            cube('Pocket flap',(side*.16,1.72,.183),(.095,.023,.01),leather,.002)
        if cid=='mikasa':
            loft('Red scarf',[(1.86,.105,.10,.01),(1.91,.11,.10,.01),(1.96,.10,.10,.01)],red,fold=.006)
            ribbon('Scarf tail',[(-.07,1.89,.11),(-.17,1.72,.19),(-.12,1.60,.20),(-.17,1.48,.19)],.04,red)
        else:
            ribbon('White cravat',[(0,1.91,.12),(-.015,1.82,.18),(.015,1.73,.19),(0,1.69,.185)],.035,white)
            v=[];f=[];uvs=[];N=32;M=25
            for i in range(M+1):
                t=i/M;y=1.86-t*1.02
                for j in range(N+1):
                    u=j/N*2-1;x=u*(.24+.17*t);z=-.15-.20*t+.045*math.cos(u*12)*(t+.1)
                    v.append((x,y+.018*math.cos(u*9)*t,z));uvs.append((j/N,t))
                    if i and j:f.append(((i-1)*(N+1)+j-1,i*(N+1)+j-1,i*(N+1)+j,(i-1)*(N+1)+j))
            o=obj('Draped scout cloak',v,f,green,uvs,1);sol=o.modifiers.new('Cloak lining','SOLIDIFY');sol.thickness=.004
            # Wings are inlaid raised pieces, visible on the back of the cloak.
            for side in (-1,1):
                for j in range(6):
                    ribbon('Wings of freedom',[(side*.015,1.66,-.232),(side*.08,1.70-j*.012,-.24),(side*(.09+j*.012),1.64-j*.03,-.255),(side*(.02+j*.013),1.52-j*.015,-.27)],.011,white if side<0 else steel)
    # Apply every subdivision/bevel and batch by material, retaining PBR UVs.
    for o in list(bpy.context.scene.objects):
        if o.type!='MESH':continue
        bpy.context.view_layer.objects.active=o;o.select_set(True)
        for mod in list(o.modifiers):
            try:bpy.ops.object.modifier_apply(modifier=mod.name)
            except RuntimeError:pass
        if len(o.data.polygons)>5000:
            mod=o.modifiers.new('Optimized sculpt topology','DECIMATE');mod.ratio=.62;bpy.ops.object.modifier_apply(modifier=mod.name)
        o.select_set(False)
    bymat={}
    for o in list(bpy.context.scene.objects):
        if o.type=='MESH':bymat.setdefault(o.data.materials[0].name,[]).append(o)
    for key,objects in bymat.items():
        bpy.ops.object.select_all(action='DESELECT')
        for o in objects:o.select_set(True)
        bpy.context.view_layer.objects.active=objects[0];bpy.ops.object.join();bpy.context.object.name=key
    bpy.ops.object.select_all(action='SELECT')
    # No runtime subdivision or skeleton overhead: ready-to-render, separate GLBs.
    bpy.ops.export_scene.gltf(filepath=str(OUT/(cid+'.glb')),export_format='GLB',export_yup=True,export_texcoords=True,export_normals=True,export_materials='EXPORT',export_animations=False,export_extras=True)
    tris=sum(sum(len(p.vertices)-2 for p in o.data.polygons) for o in bpy.context.scene.objects if o.type=='MESH')
    return {'id':cid,'file':cid+'.glb','bytes':(OUT/(cid+'.glb')).stat().st_size,'triangles':tris,'materials':len(bymat)}

if __name__=='__main__':
    ids=sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else ['zoro','tanjiro','nezuko','levi','mikasa']
    if any(cid not in ('zoro','tanjiro','nezuko','levi','mikasa') for cid in ids):raise ValueError('Only the five procedural characters may be rebuilt; the uploaded Luffy asset is preserved.')
    previous=json.loads((OUT/'build-report.json').read_text()) if (OUT/'build-report.json').exists() else []
    entries={entry['id']:entry for entry in previous}
    entries.update({cid:build(cid) for cid in ids})
    report=[entries[cid] for cid in ('luffy','zoro','tanjiro','nezuko','levi','mikasa') if cid in entries]
    (OUT/'build-report.json').write_text(json.dumps(report,indent=2)+'\n')
    print('MODEL_REPORT',json.dumps(report))
