"""Original anime fan sculpts, version 2. Blender 4.3+.

Uses the project's CC0 anatomical hands/body foundation. Heads, hair,
painted maps, garments, props, skin weights and blink shapes are authored here.
The uploaded Luffy is a visual reference only and is never read or modified.
blender -b --python scripts/sculpt-anime-cast.py -- --output /tmp/cast-v2 tanjiro
"""
import bpy, math, random, json, sys, argparse, importlib.util
from pathlib import Path
from mathutils import Vector, Matrix

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('sculpt_kit',ROOT/'scripts/build-characters.py')
k=importlib.util.module_from_spec(spec);spec.loader.exec_module(k)
PI=math.pi
obj,ell,cube,tube,line,loft,mat,texture=(getattr(k,n) for n in ('obj','ell','cube','tube','line','loft','mat','texture'))
# Write conventional sRGB PNGs directly. This avoids generated-image packing
# applying a second color-space conversion, so textured skin matches bare skin.
def pattern(name,size,fn,data=False):
    import struct,zlib,tempfile,hashlib
    def encode(c):return round(255*min(1,max(0,12.92*c if c<=.0031308 else 1.055*max(0,c)**(1/2.4)-.055)))
    raw=bytearray()
    for y in range(size):
        raw.append(0)
        for x in range(size):raw.extend((*map((lambda c:round(255*c)) if data else encode,fn(x/size,(size-1-y)/size)),255))
    def chunk(kind,data):return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
    png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',size,size,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(raw))+chunk(b'IEND',b'')
    path=Path(tempfile.gettempdir())/('anime-map-'+hashlib.sha256((CID+name).encode()).hexdigest()[:16]+'.png');path.write_bytes(png)
    img=bpy.data.images.load(str(path),check_existing=False);img.name=name;img.pack();return img

CID='tanjiro';BLINK=[];HEAD_Y=2.19;HEAD_W=.16;JAW=.70;EYE_H=.020
PROFILES={
 'zoro':dict(width=.158,jaw=.86,eye=.013,skin=(.57,.34,.18),hair=(.018,.10,.012),iris=(.12,.16,.10),body=1.12),
 'tanjiro':dict(width=.165,jaw=.68,eye=.022,skin=(.70,.43,.27),hair=(.022,.0025,.006),iris=(.36,.055,.07),body=1.00),
 'nezuko':dict(width=.174,jaw=.61,eye=.026,skin=(.79,.53,.42),hair=(.002,.0015,.004),iris=(.64,.18,.36),body=.91),
 'levi':dict(width=.152,jaw=.79,eye=.013,skin=(.66,.43,.30),hair=(.003,.004,.006),iris=(.20,.28,.32),body=.97),
 'mikasa':dict(width=.159,jaw=.66,eye=.018,skin=(.75,.51,.37),hair=(.003,.004,.006),iris=(.18,.22,.25),body=.96),
}

def cat(values,t):
    x=max(0,min(len(values)-1.000001,t));i=int(x);u=x-i
    a,b,c,d=values[max(0,i-1)],values[i],values[min(i+1,len(values)-1)],values[min(i+2,len(values)-1)]
    return .5*((2*b)+(-a+c)*u+(2*a-5*b+4*c-d)*u*u+(-a+3*b-3*c+d)*u*u*u)

def head_shape(y):
    t=max(0,min(1,(y-(HEAD_Y-.165))/.385))*7
    rx=cat([.028,HEAD_W*.47*JAW/.7,HEAD_W*.77,HEAD_W*.97,HEAD_W,HEAD_W*.96,HEAD_W*.73,.008],t)
    rz=cat([.040,.082,.119,.141,.147,.140,.110,.012],t)
    cz=cat([.055,.035,.022,.012,.008,.005,0,0],t)
    return max(.008,rx),max(.008,rz),cz

def face_relief(x,y):
    # Joined facial planes, rather than a separate bead attached as a nose.
    bridge=.010*math.exp(-(x/.017)**2-((y-(HEAD_Y-.013))/.044)**2)
    tip=.017*math.exp(-(x/.015)**2-((y-(HEAD_Y-.046))/.015)**2)
    cheeks=.006*math.exp(-((abs(x)-.075)/.038)**2-((y-(HEAD_Y-.043))/.040)**2)
    sockets=-.0025*math.exp(-((abs(x)-.071)/.045)**2-((y-(HEAD_Y+.012))/.024)**2)
    lips=.003*math.exp(-(x/.035)**2-((y-(HEAD_Y-.090))/.014)**2)
    return bridge+tip+cheeks+sockets+lips

def face_z(x,y):
    rx,rz,cz=head_shape(y);front=math.sqrt(max(.02,1-(x/rx)**2))
    return cz+rz*front+face_relief(x,y)*front**3

def face_curve(name,points,r,m):
    return line(name,[(x,y,face_z(x,y)+offset) for x,y,offset in points],r,m)

def strip(name,points,width,m):
    vs=[];fs=[]
    for i,(x,y) in enumerate(points):
        for sign in (-1,1):
            yy=y+sign*width*(.35+.65*math.sin(PI*i/(len(points)-1)))
            vs.append((x,yy,face_z(x,yy)+.002))
        if i:fs.append((i*2-2,i*2-1,i*2+1,i*2))
    return obj(name,vs,fs,m)

def blink_shape(o,mid):
    o.shape_key_add(name='Basis');key=o.shape_key_add(name='Blink')
    for v in key.data:
        x,y,z=v.co.x,v.co.z,-v.co.y
        yy=mid(x)+(y-mid(x))*.025
        v.co=(x,-(face_z(x,yy)+.004),yy)
    for frame,value in ((1,0),(3,1),(5,1),(8,0)):
        key.value=value;key.keyframe_insert(data_path='value',frame=frame)
    keys=o.data.shape_keys;action=keys.animation_data.action
    action.name=f'{CID} eye {len(BLINK)}';track=keys.animation_data.nla_tracks.new();track.name='blink'
    track.strips.new('blink',1,action);keys.animation_data.action=None
    BLINK.append(o)

def head(skin,ink,hair):
    P=PROFILES[CID]
    def skinmap(u,v):
        front=max(0,math.cos(u*PI*2))**8
        blush=math.exp(-((abs(math.sin(u*PI*2))-.53)/.26)**2-((v-.40)/.075)**2)*front
        shade=1-.07*max(0,(v-.77)/.23)-.055*max(0,(.17-v)/.17)
        color=P['skin'];pink=(.84,.37,.32)
        amount=blush*(.13 if CID in ('nezuko','mikasa') else .035)
        return tuple((c*(1-amount)+pink[i]*amount)*shade for i,c in enumerate(color))
    face=mat('Face | painted warm complexion',P['skin'],.82);texture(face,pattern('Face paint '+CID,512,skinmap))
    face.node_tree.nodes.get('Principled BSDF').inputs['Specular IOR Level'].default_value=.16
    rings=[]
    for i in range(43):
        y=HEAD_Y-.165+i*.385/42;rx,rz,cz=head_shape(y);rings.append((y,rx,rz,cz))
    skull=loft('Head | custom anime jaw and cheek planes',rings,face,fold=0)
    for vertex in skull.data.vertices:
        x,y,z=vertex.co.x,vertex.co.z,-vertex.co.y;rx,rz,cz=head_shape(y)
        front=max(0,(z-cz)/rz)
        vertex.co.y-=face_relief(x,y)*front**3
    for uv in skull.data.uv_layers.active.data:uv.uv/=2
    for side in (-1,1):
        ear=ell('Ear | shaped auricle',(side*HEAD_W*.97,HEAD_Y-.018,.018),(.023,.035,.017),skin)
        inner=mat('Ear inner warmth',tuple(c*.78 for c in P['skin']),.9)
        pts=[(side*(HEAD_W+.005+math.sin(t/16*PI*1.5)*.009),HEAD_Y-.02+math.cos(t/16*PI*1.5)*.028,.032) for t in range(17)]
        line('Ear | helix fold',pts,.0022,inner)
    lip=mat('Lip line',(.26,.105,.080),.9)
    face_curve('Face | subtle nose underside',[(-.007,HEAD_Y-.056,.001),(0,HEAD_Y-.058,.001),(.007,HEAD_Y-.056,.001)],.00045,lip)
    mouth_y=HEAD_Y-.090
    face_curve('Face | quiet mouth',[(-.028,mouth_y+.001,.003),(-.014,mouth_y,.003),(0,mouth_y-.001,.003),(.014,mouth_y,.003),(.028,mouth_y+.001,.003)],.0012,lip)
    if CID in ('zoro','levi'):
        face_curve('Face | lower lip plane',[(-.012,mouth_y-.013,.001),(0,mouth_y-.014,.001),(.012,mouth_y-.013,.001)],.0007,lip)
    eye_white=mat('Eyes | warm sclera',(.92,.91,.86),.65)
    iris=mat('Eyes | hand-painted iris',P['iris'],.65)
    def irispaint(u,v):
        x,y=u-.5,v-.5;r=math.hypot(x,y)*2;a=math.atan2(y,x)
        pupil=abs(x)<.045 and abs(y)<.33 if CID=='nezuko' else r<.36
        if pupil:return (.006,.008,.012)
        if r>.91:return (.025,.018,.029)
        if (x+.14)**2+(y-.18)**2<.012:return (.98,.98,.95)
        if (x-.16)**2+(y+.23)**2<.002:return (.82,.86,.89)
        light=.82+.18*math.sin(a*47+r*19)**2+.28*max(0,-y)
        return tuple(min(1,c*light) for c in P['iris'])
    texture(iris,pattern('Painted iris '+CID,256,irispaint))
    for side in (-1,1):
        cx=side*(.075 if CID=='nezuko' else .071);cy=HEAD_Y+.012;w=.048 if CID=='nezuko' else .045
        tilt=side*(.13 if CID in ('zoro','levi') else .075)
        mid=lambda x,cx=cx,cy=cy,tilt=tilt:cy+(x-cx)*tilt
        if CID=='zoro' and side==1:
            face_curve('Eye | closed left lid',[(cx-w,mid(cx-w),.003),(cx,cy-.002,.003),(cx+w,mid(cx+w),.003)],.0017,ink)
            face_curve('Face | left eye scar',[(cx-.007,HEAD_Y+.10,.003),(cx+.002,HEAD_Y+.04,.003),(cx-.002,HEAD_Y-.055,.003)],.0021,lip)
        else:
            v=[];f=[];uv=[];N=32;M=10
            for i in range(N+1):
                t=i/N;x=cx+(t*2-1)*w;arc=math.sin(PI*t)**.7
                for j in range(M+1):
                    q=j/M;y=mid(x)+arc*((1-q)*(-EYE_H*.70)+q*EYE_H)
                    v.append((x,y,face_z(x,y)+.003));uv.append((t,q))
                    if i and j:f.append(((i-1)*(M+1)+j-1,i*(M+1)+j-1,i*(M+1)+j,(i-1)*(M+1)+j))
            eye=obj('Eyes | almond sclera',v,f,eye_white,uv);blink_shape(eye,mid)
            v=[(cx,cy,face_z(cx,cy)+.007)];uv=[(.5,.5)];f=[]
            iris_w=.016 if CID in ('levi','zoro') else .020
            iris_h=EYE_H*.93
            for j in range(49):
                a=j/48*2*PI;x=cx+math.cos(a)*iris_w;y=cy+math.sin(a)*iris_h
                v.append((x,y,face_z(x,y)+.006));uv.append((.5+.5*math.cos(a),.5+.5*math.sin(a)))
                if j:f.append((0,j,j+1))
            disk=obj('Eyes | iris depth and pupil',v,f,iris,uv);blink_shape(disk,mid)
            for upper in (True,False):
                vs=[];fs=[]
                for i in range(33):
                    t=i/32;x=cx+(t*2-1)*w;arc=math.sin(PI*t)**.7;y=mid(x)+(1 if upper else -.70)*EYE_H*arc
                    thick=(.0019 if upper else .0008)*(math.sin(PI*t)**.4+.2)
                    for sign in (-1,1):
                        yy=y+sign*thick;vs.append((x,yy,face_z(x,yy)+.005))
                    if i:fs.append((i*2-2,i*2-1,i*2+1,i*2))
                lash=obj('Eyes | tapered upper lash' if upper else 'Eyes | lower lash',vs,fs,ink);blink_shape(lash,mid)
        # Flat tapered brows follow the skin; adult characters have lower brows.
        brow_y=cy+(.037 if CID in ('zoro','levi') else .050)
        pts=[]
        for j in range(13):
            t=j/12;x=cx+(t*2-1)*w*.95;y=brow_y+math.sin(t*PI)*.006+(x-cx)*side*(.13 if CID=='zoro' else .02)
            pts.append((x,y))
        strip('Brow | character expression',pts,.0023 if CID in ('zoro','levi') else .0017,hair)
    if CID=='tanjiro':
        scar=mat('Face | burgundy forehead scar',(.12,.021,.018),.95)
        outline=[(-.032,HEAD_Y+.135),(-.079,HEAD_Y+.128),(-.096,HEAD_Y+.104),(-.074,HEAD_Y+.090),(-.094,HEAD_Y+.067),(-.064,HEAD_Y+.052),(-.040,HEAD_Y+.072),(-.053,HEAD_Y+.092)]
        # Subdivide the concave scar and project every vertex onto the face.
        # A single planar polygon would disappear inside the curved forehead.
        from mathutils.geometry import tessellate_polygon
        vertices=[Vector((x,y,0)) for x,y in outline]
        triangles=tessellate_polygon([vertices])
        v=[];f=[]
        for triangle in triangles:
            if isinstance(triangle[0],int):triangle=[vertices[i] for i in triangle]
            grid={};N=7
            for i in range(N+1):
                for j in range(N+1-i):
                    p=triangle[0]*(1-(i+j)/N)+triangle[1]*(i/N)+triangle[2]*(j/N)
                    grid[i,j]=len(v);v.append((p.x,p.y,face_z(p.x,p.y)+.0025))
            for i in range(N):
                for j in range(N-i):
                    f.append((grid[i,j],grid[i+1,j],grid[i,j+1]))
                    if i+j<N-1:f.append((grid[i+1,j],grid[i+1,j+1],grid[i,j+1]))
        obj('Face | irregular scar inlay',v,f,scar)

def hair_lock(name,controls,width,m,out=(0,0,1),segments=22):
    v=[];f=[];uv=[];out=Vector(out);W=6
    def bez(t):return sum((Vector(controls[j])*math.comb(3,j)*(1-t)**(3-j)*t**j for j in range(4)),Vector())
    for i in range(segments+1):
        t=i/segments;p=bez(t);tangent=(bez(min(1,t+.01))-bez(max(0,t-.01))).normalized()
        side=tangent.cross(out).normalized()
        if side.length<.1:side=Vector((1,0,0))
        normal=side.cross(tangent).normalized()
        if normal.dot(out)<0:normal=-normal
        w=width*(.45+.55*math.sin(t*PI)**.65)*(1-t**7)+.0002
        for j in range(W+1):
            u=j/W*2-1;pnt=p+side*u*w+normal*math.cos(u*PI/2)*w*.24
            v.append(pnt);uv.append((j/W,t))
            if i and j:f.append(((i-1)*(W+1)+j-1,i*(W+1)+j-1,i*(W+1)+j,(i-1)*(W+1)+j))
    o=obj(name,v,f,m,uv)
    mod=o.modifiers.new('Tapered lock thickness','SOLIDIFY');mod.thickness=.0018
    return o

def hair():
    P=PROFILES[CID];base=P['hair'];m=mat('Hair | ink and painted strands',base,.77)
    m.node_tree.nodes.get('Principled BSDF').inputs['Specular IOR Level'].default_value=.18
    def strands(u,v):
        highlight=.84+.16*math.sin(u*PI*38+math.sin(v*5)*.3)**6
        return tuple(c*highlight for c in base)
    texture(m,pattern('Hair paint '+CID,256,strands))
    # A shaped hairline: high on the forehead, lower at temples and nape.
    v=[];f=[];uv=[];N=64;M=26
    for i in range(M+1):
        for j in range(N+1):
            a=j/N*2*PI;end=1.07+.98*(1-math.cos(a))/2
            theta=.012+(end-.012)*i/M
            y=HEAD_Y+.230*math.cos(theta);rx,rz,cz=head_shape(y)
            v.append(((rx+.006)*math.sin(a),y,cz+(rz+.007)*math.cos(a)))
            uv.append((j/N,i/M))
            if i and j:f.append(((i-1)*(N+1)+j-1,i*(N+1)+j-1,i*(N+1)+j,(i-1)*(N+1)+j))
    cap=obj('Hair | fitted scalp with sculpted hairline',v,f,m,uv)
    if CID=='zoro':
        for row in range(4):
            for j in range(24):
                a=j/24*2*PI+(row%2)*.13;theta=.25+row*.27
                y=HEAD_Y+.23*math.cos(theta);rx,rz,cz=head_shape(y)
                p=Vector(((rx+.006)*math.sin(a),y,cz+(rz+.007)*math.cos(a)))
                out=(math.sin(a),.3,math.cos(a));tip=p+Vector((math.sin(a)*.020,.027+random.random()*.024,math.cos(a)*.020))
                hair_lock('Hair | short green spike',[p,p+Vector((0,.016,0)),tip-Vector((0,.012,0)),tip],.011+random.random()*.004,m,out,12)
    elif CID=='tanjiro':
        # Uneven flame-shaped clumps grow outwards and sweep back, leaving the scar visible.
        for row in range(3):
            for j in range(9):
                x=(j-4)*.036+random.uniform(-.006,.006)
                root=(x*.92,HEAD_Y+.125+row*.020,.110-row*.052)
                tip=(x*1.12+random.uniform(-.022,.022),HEAD_Y+.245+random.uniform(-.015,.060),-.070-row*.047)
                hair_lock('Hair | swept flame crown',[root,(x*1.02,HEAD_Y+.235+row*.015,.145-row*.04),(tip[0],tip[1]+.015,.015-row*.04),tip],.025+random.random()*.009,m,(x*3,.55,.7),18)
        for side in (-1,1):
            for j in range(8):
                a=side*(.80+j*.25);out=(math.sin(a),0,math.cos(a))
                y=HEAD_Y+.13-j*.008
                hair_lock('Hair | jagged temple layer',[(math.sin(a)*.10,HEAD_Y+.19,math.cos(a)*.08),(math.sin(a)*.18,HEAD_Y+.19,math.cos(a)*.14),(math.sin(a)*.19,y+.05,math.cos(a)*.15),(math.sin(a)*.205,y-.015,math.cos(a)*.15)],.022,m,out,18)
        for j in range(3):
            x=.042+j*.034
            hair_lock('Hair | pointed right fringe',[(x*.8,HEAD_Y+.22,.09),(x,HEAD_Y+.22,.17),(x+.015,HEAD_Y+.16,.18),(x+.018,HEAD_Y+.080+j*.012,.16)],.022,m)
    else:
        # Asymmetrical front locks: Nezuko's forehead, Levi's part and Mikasa's bob.
        if CID=='nezuko':
            # Open centre part leaves both pink eyes and the forehead unobstructed.
            for side in (-1,1):
                for j in range(4):
                    hair_lock('Hair | open centre-part sweep',[(side*(.022+j*.022),HEAD_Y+.225,.040),(side*(.09+j*.014),HEAD_Y+.23,.15),(side*.165,HEAD_Y+.08,.16),(side*(.165+j*.004),HEAD_Y-.025-j*.018,.075)],.022,m,(side*.5,0,1))
        else:
            for j in range(10):
                x=(j-4.5)*.030
                length=(.045 if CID=='levi' else .052)+.017*math.sin(j*1.9)
                tipx=x+(.035 if CID=='levi' and x>0 else -.024 if CID=='levi' else .012)
                hair_lock('Hair | parted fringe',[(x*.50,HEAD_Y+.227,.045),(x*.8,HEAD_Y+.24,.18),(x,HEAD_Y+.13,.195),(tipx,HEAD_Y+length,.18-abs(x)*.1)],.025,m)
        long=CID=='nezuko';bob=CID=='mikasa';longmat=m
        if long:
            longmat=mat('Hair | orange ombre tips',base,.78)
            def ombre(u,v):
                t=max(0,min(1,(v-.67)/.33));tip=(.42,.10,.025);h=.85+.15*math.sin(u*PI*42)**6
                return tuple((base[i]*(1-t)+tip[i]*t)*h for i in range(3))
            texture(longmat,pattern('Orange ombre '+CID,512,ombre))
        count=30 if long else 24
        for j in range(count):
            edge=1.12 if long else .90 if bob else 1.0
            a=edge+(2*PI-2*edge)*j/(count-1);out=(math.sin(a),0,math.cos(a))
            end_y=1.08+random.random()*.18 if long else HEAD_Y-.20+random.random()*.025 if bob else HEAD_Y-.055+random.random()*.025
            radius=.22 if long else .19 if bob else .163
            start=(math.sin(a)*.09,HEAD_Y+.21,.01+math.cos(a)*.075)
            end=(math.sin(a)*radius,end_y,.01+math.cos(a)*(.28 if long else .17))
            hair_lock('Hair | long flowing layer' if long else 'Hair | angled bob panel' if bob else 'Hair | tapered undercut layer',[start,(math.sin(a)*.19,HEAD_Y+.23,.01+math.cos(a)*.16),(end[0]*1.10,(HEAD_Y+.02+end_y)/2,end[2]*1.02),end],.035 if long else .027,longmat if long else m,out)
    return m

FABRIC_NORMAL=None
def fabric(name,color,checks=False,hemp=False):
    global FABRIC_NORMAL
    m=mat(name,color,.88)
    def paint(u,v):
        shade=.94+.04*math.cos(u*PI*8)+.02*math.cos(v*PI*10)
        base=color
        if checks:base=(.012,.095,.038) if (int(u*8)+int(v*4))%2==0 else (.0015,.0035,.005)
        if hemp:
            # Repeating six-point hemp-leaf stars on a triangular lattice.
            xx=(u*8)%1-.5;yy=(v*8)%1-.5
            d=min(abs(xx),abs(yy),abs(yy-math.sqrt(3)*xx),abs(yy+math.sqrt(3)*xx))
            if d<.014:base=(.40,.16,.21)
        return tuple(c*shade for c in base)
    texture(m,pattern(name+' paint',512,paint))
    if FABRIC_NORMAL is None:
        def weave(u,v):
            n=Vector((.13*math.sin(u*PI*64),.10*math.sin(v*PI*64),1)).normalized()
            return tuple(.5+.5*c for c in n)
        FABRIC_NORMAL=pattern('Fine woven cloth normal '+CID,128,weave,data=True)
    texture(m,FABRIC_NORMAL,normal=True)
    return m

def torus(name,p,radius,wire,m,rotation=None):
    bpy.ops.mesh.primitive_torus_add(major_segments=32,minor_segments=8,location=k.xyz(p),major_radius=radius,minor_radius=wire)
    o=bpy.context.object;o.name=name;o.data.materials.append(m)
    if rotation:o.rotation_euler=rotation
    for f in o.data.polygons:f.use_smooth=True
    return o

def belt(name,y,rx,rz,cz,height,m):
    return loft(name,[(y-height/2,rx,rz,cz),(y,rx+.002,rz+.002,cz),(y+height/2,rx,rz,cz)],m,fold=.0007)

def seam_path(name,points,m,r=.0014):return line(name,points,r,m)

def sword(p,angle,steel,gold,grip,sheath,ink,open_blade=False,length=.87):
    before=set(bpy.context.scene.objects)
    if open_blade:
        v=[];f=[]
        for i in range(25):
            t=i/24;w=.014*(1-t**12);x=.022*t*t
            v.extend([(x-w,-length*t,0),(x,-length*t,.003),(x+w,-length*t,0),(x,-length*t,-.003)])
            if i:
                for j in range(4):f.append(((i-1)*4+j,i*4+j,i*4+(j+1)%4,(i-1)*4+(j+1)%4))
        obj('Weapon | honed tapered blade',v,f,steel)
        for j in range(8):cube('Weapon | replaceable blade break',(0,-.08-j*.075,.0035),(.027,.001,.001),ink,.0003)
    else:
        tube('Weapon | curved lacquer scabbard',[(.025*(i/20)**2,-length*i/20,0) for i in range(21)],.023,sheath,[1-.22*(i/20)**8 for i in range(21)],20)
        for y in (-.03,-length+.025):
            tube('Weapon | scabbard ferrule',[(0,y,0),(0,y-.017,0)],.025,gold,sides=24)
        for j in range(12):
            y=-.08-j*.052
            seam_path('Weapon | lacquer inlay',[(-.017,y,.017),(0,y-.019,.024),(.017,y,.017)],gold,.0008)
    guard=torus('Weapon | pierced tsuba',(0,.014,0),.045,.006,gold,(PI/2,0,0))
    cube('Weapon | habaki',(0,-.012,0),(.032,.036,.018),gold,.003)
    tube('Weapon | wrapped handle',[(0,.035,0),(0,.222,0)],.021,grip,sides=24)
    for j in range(10):
        y=.047+j*.016
        seam_path('Weapon | crossed silk wrap',[(-.02,y,0),(0,y+.013,.022),(.02,y,0)],ink,.0025)
        seam_path('Weapon | reversed silk wrap',[(-.02,y+.013,0),(0,y,.022),(.02,y+.013,0)],ink,.0025)
    tube('Weapon | kashira',[(0,.215,0),(0,.230,0)],.023,gold,sides=20)
    bpy.context.view_layer.update()
    transform=Matrix.Translation(Vector(k.xyz(p))) @ Matrix.Rotation(-angle,4,'Y')
    for o in set(bpy.context.scene.objects)-before:o.matrix_world=transform @ o.matrix_world

def badge(p,scale,blue,white,ink,back=False):
    # Embroidered crossed wings, not a plain gold rectangle.
    cx,cy,cz=p;sign=-1 if back else 1
    if back:
        v=[];f=[];N=12
        for i in range(N+1):
            for j in range(N+1):
                v.append((cx+(j/N-.5)*scale*.75,cy+(i/N-.5)*scale,cz))
                if i and j:f.append(((i-1)*(N+1)+j-1,i*(N+1)+j-1,i*(N+1)+j,(i-1)*(N+1)+j))
        obj('Insignia | shield backing',v,f,ink)
    else:cube('Insignia | shield backing',p,(scale*.75,scale,.003),ink,.004)
    for side in (-1,1):
        material=blue if side<0 else white
        for j in range(6):
            x=cx+side*(.04+j*.032)*scale;y=cy+(.30-j*.085)*scale
            points=[(cx+side*.025*scale,y+.12*scale,cz+sign*.003),(x+side*.10*scale,y+.09*scale,cz+sign*.003),(x+side*.025*scale,y-.10*scale,cz+sign*.003),(cx+side*.018*scale,y-.18*scale,cz+sign*.003)]
            obj('Insignia | embroidered wing feather',points,[(0,1,2,3)],material)
    seam_path('Insignia | center seam',[(cx,cy-.39*scale,cz+sign*.004),(cx,cy+.39*scale,cz+sign*.004)],white,.001)

def garments(skin,ink,hairmat):
    P=PROFILES[CID];scout=CID in ('levi','mikasa');zoro=CID=='zoro';nezu=CID=='nezuko'
    white=fabric('Cloth | warm ivory cotton',(.72,.70,.62))
    dark=fabric('Cloth | navy uniform',(.012,.020,.032))
    leather=fabric('Leather | chestnut grain',(.095,.034,.012))
    seam=mat('Stitch | flax thread',(.47,.32,.16),.98)
    red=fabric('Cloth | deep crimson',(.40,.018,.030))
    green=fabric('Cloth | forest green',(.008,.040,.016))
    gold=mat('Metal | aged brass',(.48,.29,.065),.32,.78)
    steel=mat('Metal | brushed steel',(.40,.48,.54),.32,.82)
    blue=mat('Insignia | blue embroidery',(.10,.24,.36),.86)
    # Preserve the CC0 hand anatomy; replace its realistic-human head completely.
    k.extract('Anatomy | detailed hands',skin,lambda p: abs(p[0])>3.7 and p[1]<3.1)
    tube('Anatomy | neck',[(0,1.84,.036),(0,1.96,.035),(0,2.08,.04)],.063,skin,[1.10,.94,.87],32)
    if zoro:
        k.extract('Anatomy | muscular torso and forearms',skin,lambda p: .8<p[1]<5.8 and (abs(p[0])<1.8 or abs(p[0])>2.3))
    if not nezu:
        minimum=-3.9 if scout else -4.9 if CID=='tanjiro' else -7.55
        k.extract('Clothing | fitted trousers',white if scout else dark,lambda p: minimum<p[1]<1.4,.015 if scout else .023)
    if not zoro and not nezu:k.extract('Clothing | tailored undershirt',white if scout else dark,lambda p: 1<p[1]<5.65 and abs(p[0])<2.0,-.005)
    kimono=fabric('Silk | pink asanoha',(.70,.30,.40),hemp=True) if nezu else None
    if nezu:
        loft('Clothing | layered asanoha kimono',[(.27,.30,.19,.06),(.43,.295,.19,.06),(.72,.26,.18,.06),(1.00,.225,.17,.06),(1.30,.215,.17,.06),(1.70,.23,.18,.06),(1.87,.17,.13,.04),(1.92,.08,.085,.03)],kimono,fold=.0025)
        # The diagonal folded collar is separate from the overcoat.
        seam_path('Clothing | crossed kimono collar',[(-.11,1.90,.15),(.03,1.63,.235),(.13,1.40,.24)],white,.009)
        seam_path('Clothing | under collar',[(.11,1.90,.15),(-.04,1.64,.235)],white,.007)
    coat=fabric('Haori | green black ichimatsu',(.03,.19,.11),checks=True) if CID=='tanjiro' else fabric('Haori | plum-black',(.042,.020,.030)) if nezu else green if zoro else leather
    bottom=.55 if zoro else .93 if CID=='tanjiro' else .40 if nezu else 1.39
    width=P['body'];gap=.51 if nezu else .46 if zoro else .42
    rings=[(bottom,.32 if nezu or zoro else .28,.225,.07),(bottom+.12,.30 if nezu or zoro else .26,.215,.07),(1.28,.245*width,.22,.075),(1.50,.26*width,.23,.075),(1.75,.29*width,.235,.060),(1.84,.285*width,.22,.05),(1.91,.235*width,.142,.05),(1.97,.078,.090,.035)]
    if scout:rings=[r for r in rings if r[0]>=1.38]
    loft('Clothing | cut and draped overcoat',rings,coat,gap,.0015)
    for side in (-1,1):
        # The front lapel traces the actual curved garment edge.
        path=[(side*rx*math.sin(gap),y,cz+rz*math.cos(gap)+.004) for y,rx,rz,cz in rings]
        seam_path('Clothing | lapel seam',path,coat,.003)
        shoulder=k.bodypoint((side*1.8,5.1,0));elbow=k.bodypoint((side*3.12,3.48,.13));wrist=k.bodypoint((side*4.24,2.5,1.7))
        stop=elbow.lerp(wrist,.12) if zoro else wrist
        points=[];radii=[]
        for j in range(23):
            t=j/22
            p=shoulder.lerp(elbow,min(1,t*1.7)) if t<.58 else elbow.lerp(stop,(t-.58)/.42)
            fold=1+.035*math.exp(-((t-.55)/.10)**2)*math.cos(t*70)
            points.append(p);radii.append((1.0-.25*t)*fold)
        radius=.106 if nezu else .102 if CID=='tanjiro' else .088 if zoro else .078
        tube('Clothing | shaped sleeve',points,radius,coat,radii,32)
        ell('Clothing | fitted shoulder',shoulder+Vector((0,.018,0)),(radius,.083,radius),coat)
        tube('Clothing | folded sleeve hem',[points[-1],points[-1]+Vector((0,-.027,0))],radius*radii[-1]*1.035,coat,sides=32)
        # Fine lengthwise seams give cloth volume without ribbed cylindrical rings.
        seam_path('Clothing | sleeve stitch',[(p.x+side*radius*.55,p.y,p.z+radius*.80) for p in points],seam,.0009)
        if scout:
            x=side*.21
            tube('Boot | fitted leather shaft',[(x,.09,.025),(side*.193,.30,.018),(side*.17,.63,.026)],.111,leather,[.73,.88,1.0],32)
            ell('Boot | shaped instep',(x,.09,.085),(.076,.071,.13),leather)
            ell('Boot | toe box',(x,.047,.16),(.078,.041,.135),leather)
            ell('Boot | rubber sole',(x,.020,.12),(.083,.014,.18),ink)
            seam_path('Boot | back seam',[(x,.13,-.048),(side*.19,.35,-.061),(side*.17,.61,-.062)],seam,.0011)
            tube('Boot | top binding',[(side*.17,.615,.026),(side*.17,.64,.026)],.113,leather,sides=32)
            cube('Boot | ankle buckle',(side*.27,.18,.035),(.025,.024,.012),steel,.003)
        else:
            x=side*.22
            if zoro:
                tube('Boot | black leather shaft',[(x,.09,.025),(x,.25,.018),(side*.20,.39,.020)],.084,dark,[.90,1,1],28)
                ell('Boot | shaped black instep',(x,.090,.085),(.078,.070,.13),dark)
                ell('Boot | black toe box',(x,.048,.16),(.081,.040,.13),dark)
                ell('Boot | sole',(x,.019,.12),(.085,.014,.18),ink)
            else:
                ell('Footwear | zori sole',(x,.028,.12),(.09,.018,.18),ink)
            if not zoro:
                tube('Footwear | calf wrapping',[(x,.10,.012),(side*.18,.49,.025)],.079,white,[.88,1.04],32)
                for j in range(9):
                    y=.135+j*.037;seam_path('Footwear | winding stitch',[(x-.065,y,.069),(x+.065,y+.013,.069)],seam,.0008)
                k.extract('Anatomy | exposed sandal toes',skin,lambda p:p[1]<-7.52)
                seam_path('Footwear | crossed zori straps',[(x-.069,.083,.14),(x,.11,.10),(x+.069,.083,.14)],dark,.009)
    if CID=='tanjiro':
        belt('Clothing | white uniform belt',1.29,.25,.225,.065,.065,white)
        cube('Clothing | belt clasp',(0,1.29,.295),(.066,.045,.010),steel,.003)
        tube('Clothing | standing collar',[(0,1.87,.04),(0,1.94,.04)],.077,dark,sides=40)
        for j in range(5):ell('Clothing | uniform button',(0,1.43+j*.079,.228),(.006,.006,.003),gold)
        for side in (-1,1):
            torus('Hanafuda | earring loop',(side*.17,2.135,.035),.009,.0015,steel,(PI/2,0,0))
            cube('Hanafuda | ivory plate',(side*.17,2.069,.040),(.034,.106,.004),white,.0014)
            ell('Hanafuda | red sun',(side*.17,2.091,.043),(.010,.010,.0015),red)
            for j in range(7):seam_path('Hanafuda | ink ray',[(side*.17,2.085,.044),(side*.17+(j-3)*.0044,2.026,.044)],ink,.00065)
            seam_path('Hanafuda | mountain ridge',[(side*.17-.014,2.030,.044),(side*.17,2.040,.044),(side*.17+.014,2.030,.044)],ink,.001)
        sword((-.31,1.25,-.07),-.20,steel,gold,white,ink,red)
    elif zoro:
        belt('Clothing | green haramaki',1.28,.282,.23,.07,.16,green)
        belt('Clothing | crimson waist wrap',1.255,.291,.237,.07,.070,red)
        for j in range(6):belt('Clothing | sash rib',1.22+j*.025,.283,.232,.07,.004,green)
        for j,(grip,scabbard) in enumerate([(white,white),(red,red),(ink,ink)]):
            sword((.32,1.29-j*.049,-.06),.22-j*.12,steel,gold,grip,scabbard,ink)
        for j in range(3):torus('Ear | three gold hoops',(.174,HEAD_Y-.06-j*.012,.02+j*.008),.011,.0022,gold,(PI/2,0,0))
        body_samples=[k.bodypoint(v) for v in k.verts[:13380] if .7<v[1]<5.9 and abs(v[0])<1.7 and v[2]>.5]
        def torso_z(x,y):
            near=sorted(body_samples,key=lambda p:(p.x-x)**2+(p.y-y)**2)[:4]
            return max(p.z for p in near)+.002
        scar=mat('Skin | healed chest scar',(.35,.14,.10),.95)
        points=[]
        for j in range(25):
            t=j/24;x=-.17+t*.30;y=1.82-t*.48;points.append((x,y,torso_z(x,y)))
        seam_path('Skin | long diagonal chest scar',points,scar,.0018)
        for j in range(14):
            t=(j+1)/16;x=-.17+t*.30;y=1.82-t*.48
            seam_path('Skin | healed scar stitches',[(x-.008,y-.004,torso_z(x-.008,y-.004)),(x+.008,y+.004,torso_z(x+.008,y+.004))],scar,.001)
    elif nezu:
        obi=fabric('Obi | red white check',(.8,.7,.6))
        texture(obi,pattern('Obi checks',128,lambda u,v:(.55,.05,.07) if (int(u*16)+int(v*4))%2 else (.83,.79,.68)))
        v=[];uv=[];f=[]
        for i in range(5):
            for j in range(25):
                x=(j/24*2-1)*.124;y=1.225+i*.17/4;z=.325-.035*(x/.124)**2
                v.append((x,y,z));uv.append((j/24,i/4))
                if i and j:f.append(((i-1)*25+j-1,i*25+j-1,i*25+j,(i-1)*25+j))
        obj('Obi | curved front sash',v,f,obi,uv)
        seam_path('Obi | crimson cord',[(-.125,1.29,.291),(-.06,1.29,.321),(0,1.29,.329),(.06,1.29,.321),(.125,1.29,.291)],red,.008)

        bowmat=fabric('Ribbon | warm pink silk',(.64,.21,.31))
        for side in (-1,1):
            hair_lock('Bow | folded silk loop',[(.145,HEAD_Y+.11,.055),(.145+side*.05,HEAD_Y+.16,.06),(.145+side*.06,HEAD_Y+.08,.08),(.145,HEAD_Y+.105,.08)],.018,bowmat)
        ell('Bow | center knot',(.145,HEAD_Y+.11,.078),(.012,.014,.010),bowmat)
        bamboo=mat('Bamboo | pale green stalk',(.25,.43,.10),.78);node=mat('Bamboo | darker nodes',(.075,.23,.035),.82)
        tube('Bamboo | mouthpiece',[(-.11,HEAD_Y-.087,.181),(.11,HEAD_Y-.087,.181)],.027,bamboo,sides=40)
        for side in (-1,1):
            tube('Bamboo | node band',[(side*.073,HEAD_Y-.087,.181),(side*.082,HEAD_Y-.087,.181)],.029,node,sides=32)
            seam_path('Bamboo | cord tie',[(side*.108,HEAD_Y-.087,.181),(side*.16,HEAD_Y-.06,.02),(side*.10,HEAD_Y-.06,-.10)],red,.002)
        for j in range(6):seam_path('Bamboo | grain',[(-.070,HEAD_Y-.087+(j-2.5)*.006,.207),(.070,HEAD_Y-.086+(j-2.5)*.006,.207)],node,.0005)
    if scout:
        body_ids={i for face in k.groups['body'] for i in face}
        leg_samples=[k.bodypoint(k.verts[i]) for i in body_ids]
        def fitted_thigh(side,y):
            near=[p for p in leg_samples if abs(p.y-y)<.023 and .012<side*p.x<.29]
            lo=min(p.x for p in near);hi=max(p.x for p in near)
            back=min(p.z for p in near);front=max(p.z for p in near)
            # The trousers expand the CC0 anatomy by .015, plus their seam ripple.
            return (lo+hi)/2,(hi-lo)/2+.017,(front-back)/2+.017,(front+back)/2
        belt('Harness | waist belt',1.29,.25,.19,.07,.038,leather)
        cube('Harness | waist buckle',(0,1.29,.270),(.057,.038,.012),steel,.003)
        for side in (-1,1):
            obj('Clothing | folded shirt collar',[(side*.053,1.95,.10),(side*.135,1.87,.18),(side*.080,1.79,.234),(side*.030,1.87,.19)],[(0,1,2,3)],white,[(0,1),(1,1),(1,0),(0,0)])
            # Harness bands, clasps and the detailed ODM assembly.
            anchors={}
            for y in (.88,1.06):
                cx,rx,rz,cz=fitted_thigh(side,y);anchors[y]=(cx,cz+rz)
                ring=belt('Harness | thigh band',y,rx,rz,cz,.026,leather);ring.location.x=cx
                cube('Harness | thigh clasp',(cx,y,cz+rz+.005),(.034,.029,.008),steel,.003)
            seam_path('Harness | torso strap',[(side*.20,1.84,.145),(-side*.13,1.39,.244)],leather,.013)
            seam_path('Harness | angled thigh strap',[(side*.13,1.27,.23),(anchors[1.06][0],1.10,anchors[1.06][1]+.006),(anchors[.88][0],.88,anchors[.88][1]+.006)],leather,.012)
            cube('Jacket | chest pocket',(side*.17,1.69,.284),(.083,.085,.010),leather,.003)
            cube('Jacket | pocket flap',(side*.17,1.728,.294),(.087,.020,.006),leather,.002)
            ell('Jacket | pocket button',(side*.17,1.717,.300),(.0035,.0035,.002),gold)
            badge((side*.17,1.66,.299),.058,blue,white,ink)
            cube('ODM | steel blade box',(side*.31,1.075,-.005),(.13,.145,.38),steel,.010)
            for j in range(6):cube('ODM | stacked blade cartridge',(side*.31,1.018+j*.020,.190),(.098,.007,.016),ink,.001)
            tube('ODM | compressed gas cylinder',[(side*.27,.96,-.215),(side*.27,1.23,-.215)],.047,steel,sides=32)
            for y in (1.0,1.19):tube('ODM | cylinder clamp',[(side*.27,y,-.215),(side*.27,y+.016,-.215)],.051,leather,sides=24)
            seam_path('ODM | pressure hose',[(side*.27,1.23,-.215),(side*.20,1.32,-.16),(side*.16,1.29,.06)],ink,.005)
            sword((side*.39,1.025,.205),side*-.12,steel,steel,ink,ink,ink,True,.77)
            cube('ODM | trigger guard',(side*.39,1.145,.235),(.070,.045,.035),steel,.004)
        if CID=='mikasa':
            belt('Scarf | layered collar',1.94,.095,.104,.030,.10,red)
            for j in range(4):seam_path('Scarf | rolled fold',[(-.07,1.905+j*.017,.108),(0,1.902+j*.017,.137),(.07,1.905+j*.017,.108)],red,.004)
            hair_lock('Scarf | long trailing end',[(-.04,1.91,.12),(-.15,1.78,.265),(-.13,1.63,.28),(-.18,1.45,.25)],.037,red)
        else:
            hair_lock('Cravat | folded white linen',[(0,1.93,.12),(-.02,1.84,.23),(.02,1.77,.245),(0,1.70,.23)],.032,white)
            for j in range(3):seam_path('Cravat | pleat',[(j*.009-.009,1.88,.20),(j*.007-.007,1.74,.247)],white,.0013)
            v=[];f=[];uv=[];N=36;M=28
            for i in range(M+1):
                t=i/M;y=1.90-t*1.03
                for j in range(N+1):
                    u=j/N*2-1;x=u*(.25+.19*t);z=-.20-.23*t+.025*math.cos(u*PI*3)*(t+.2)
                    v.append((x,y+.014*math.cos(u*8)*t,z));uv.append((j/N,t))
                    if i and j:f.append(((i-1)*(N+1)+j-1,(i-1)*(N+1)+j,i*(N+1)+j,i*(N+1)+j-1))
            cloak=obj('Cloak | draped survey mantle',v,f,green,uv,1);mod=cloak.modifiers.new('Cape lining','SOLIDIFY');mod.thickness=.003
            before=set(bpy.context.scene.objects)
            badge((0,1.53,-.285),.22,blue,white,ink,True)
            bpy.context.view_layer.update()
            # Project embroidery onto the draped cloth instead of floating in front of it.
            for o in set(bpy.context.scene.objects)-before:
                if 'feather' in o.name:
                    import bmesh
                    bm=bmesh.new();bm.from_mesh(o.data)
                    bmesh.ops.subdivide_edges(bm,edges=list(bm.edges),cuts=5,use_grid_fill=True)
                    bm.to_mesh(o.data);bm.free()
                inv=o.matrix_world.inverted()
                for vertex in o.data.vertices:
                    co=o.matrix_world@vertex.co;x,y=co.x,co.z;t=(1.90-y)/1.03;u=x/(.25+.19*t)
                    z=-.20-.23*t+.025*math.cos(u*PI*3)*(t+.2)-(.013 if 'feather' in o.name or 'seam' in o.name else .006)
                    co.y=-z;vertex.co=inv@co

            loft('Cloak | folded hood',[(1.79,.19,.09,-.21),(1.86,.155,.10,-.18),(1.92,.10,.08,-.14)],green,gap=.9,fold=.003)

def rig_and_export(cid,out):
    # Apply sculpting modifiers only. Shape-key meshes retain their blink deltas.
    for o in list(bpy.context.scene.objects):
        if o.type!='MESH':continue
        bpy.context.view_layer.objects.active=o
        for mod in list(o.modifiers):
            if o.data.shape_keys:continue
            bpy.ops.object.modifier_apply(modifier=mod.name)
        if not o.data.shape_keys and len(o.data.polygons)>5500:
            mod=o.modifiers.new('Web sculpt reduction','DECIMATE');mod.ratio=.50;bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.ops.object.select_all(action='DESELECT')
    arm=bpy.data.armatures.new(cid+' presentation rig');rig=bpy.data.objects.new('CharacterRig',arm);bpy.context.collection.objects.link(rig);bpy.context.view_layer.objects.active=rig;rig.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    specs=[('Root',(0,0,0),(0,.15,0),None),('Hips',(0,1.05,0),(0,1.33,0),'Root'),('Spine',(0,1.33,0),(0,1.62,.02),'Hips'),('Chest',(0,1.62,.02),(0,1.85,.035),'Spine'),('Neck',(0,1.85,.035),(0,2.04,.035),'Chest'),('Head',(0,2.04,.035),(0,2.40,.02),'Neck')]
    for side,suffix in ((-1,'R'),(1,'L')):
        sh=k.bodypoint((side*1.8,5.1,0));el=k.bodypoint((side*3.12,3.48,.13));wr=k.bodypoint((side*4.24,2.5,1.7))
        specs.extend([(f'Clavicle.{suffix}',(0,1.81,.02),sh,'Chest'),(f'UpperArm.{suffix}',sh,el,f'Clavicle.{suffix}'),(f'Forearm.{suffix}',el,wr,f'UpperArm.{suffix}'),(f'Hand.{suffix}',wr,wr+Vector((0,-.16,.02)),f'Forearm.{suffix}'),(f'Thigh.{suffix}',(side*.12,1.11,.02),(side*.17,.62,.03),'Hips'),(f'Shin.{suffix}',(side*.17,.62,.03),(side*.21,.11,.02),f'Thigh.{suffix}'),(f'Foot.{suffix}',(side*.21,.11,.02),(side*.21,.04,.25),f'Shin.{suffix}')])
    for name,a,b,parent in specs:
        bone=arm.edit_bones.new(name);bone.head=k.xyz(a);bone.tail=k.xyz(b)
        if parent:bone.parent=arm.edit_bones[parent]
    bpy.ops.object.mode_set(mode='OBJECT');rig.select_set(False)
    bpy.context.view_layer.update()
    for o in [o for o in bpy.context.scene.objects if o.type=='MESH']:
        name=o.name
        if not o.data.uv_layers:
            layer=o.data.uv_layers.new(name='UVMap')
            for loop in o.data.loops:
                co=o.data.vertices[loop.vertex_index].co;layer.data[loop.index].uv=(co.x*3,co.z*3)
        is_arm=name.startswith('Anatomy | detailed hands') or any(word in name.lower() for word in ('sleeve','shoulder'))
        is_head=name.startswith(('Head','Face','Ear','Eyes','Brow','Hair','Bamboo','Bow','Hanafuda'))
        for v in o.data.vertices:
            co=o.matrix_world@v.co;x,y,z=co.x,co.z,-co.y
            if is_head:bone='Head'
            elif name.startswith('Weapon'):bone=('Hand.L' if x>0 else 'Hand.R') if CID in ('levi','mikasa') else 'Hips'
            elif name.startswith('ODM'):bone='Hips'
            elif name.startswith(('Cloak','Cravat','Scarf','Insignia','Jacket')):bone='Chest'
            elif is_arm or (CID=='zoro' and name.startswith('Anatomy | muscular') and abs(x)>.27):
                side='L' if x>0 else 'R';bone=('Hand.' if y<1.30 else 'Forearm.' if y<1.53 else 'UpperArm.')+side
            elif y<1.14:
                side='L' if x>0 else 'R';bone=('Foot.' if y<.15 else 'Shin.' if y<.63 else 'Thigh.')+side
            elif abs(x)>.30:
                side='L' if x>0 else 'R';bone=('Hand.' if y<1.18 else 'Forearm.' if y<1.48 else 'UpperArm.')+side
            else:bone='Neck' if y>1.90 else 'Chest' if y>1.60 else 'Spine' if y>1.32 else 'Hips'
            group=o.vertex_groups.get(bone) or o.vertex_groups.new(name=bone);group.add([v.index],1,'REPLACE')
    # Batch static meshes by material; keep keyed eyes separate for morph animation.
    bymat={}
    for o in list(bpy.context.scene.objects):
        if o.type=='MESH' and not o.data.shape_keys:bymat.setdefault(o.data.materials[0].name,[]).append(o)
    for name,objects in bymat.items():
        bpy.ops.object.select_all(action='DESELECT')
        for o in objects:o.select_set(True)
        bpy.context.view_layer.objects.active=objects[0];bpy.ops.object.join();bpy.context.object.name=name
    for o in list(bpy.context.scene.objects):
        if o.type=='MESH':
            mod=o.modifiers.new('Presentation skeleton','ARMATURE');mod.object=rig;o.parent=rig
    marker=bpy.data.objects.new('HeadTarget',None);bpy.context.collection.objects.link(marker);marker.location=k.xyz((0,HEAD_Y+.012,.04));marker.parent=rig
    rig['sculptVersion']=2;rig['character']=cid;rig['anatomicalFoundation']='MakeHuman hm08 CC0 (hands/body only)';rig['headAndCostume']='Original project anime sculpt'
    bpy.context.scene.render.fps=30
    bpy.ops.object.select_all(action='SELECT')
    path=out/(cid+'.glb')
    bpy.ops.export_scene.gltf(filepath=str(path),export_format='GLB',export_yup=True,export_texcoords=True,export_normals=True,export_materials='EXPORT',export_skins=True,export_animations=True,export_animation_mode='NLA_TRACKS',export_extras=True)
    import struct,hashlib
    data=path.read_bytes();length=struct.unpack_from('<I',data,12)[0];gltf=json.loads(data[20:20+length])
    tris=sum(gltf['accessors'][p.get('indices',p['attributes']['POSITION'])]['count']//3 for m in gltf['meshes'] for p in m['primitives'])
    return dict(id=cid,file=cid+'.glb',bytes=len(data),triangles=tris,materials=len(gltf['materials']),sculptVersion=2,joints=sum(len(s['joints']) for s in gltf.get('skins',[])),animations=[a.get('name') for a in gltf.get('animations',[])],sha256=hashlib.sha256(data).hexdigest())

BASE_POINT=k.bodypoint
def build(cid,out,save_blend=False):
    global CID,HEAD_Y,HEAD_W,JAW,EYE_H,BLINK,FABRIC_NORMAL
    FABRIC_NORMAL=None
    CID=cid;P=PROFILES[cid];HEAD_Y=2.19;HEAD_W=P['width'];JAW=P['jaw'];EYE_H=P['eye'];BLINK=[]
    random.seed(143+sum(map(ord,cid)));k.CURRENT=cid
    def point(p):
        v=BASE_POINT(p);v.x*=P['body']
        if cid=='zoro' and v.z>.08 and abs(v.x)<.22:
            v.z+=.012*math.exp(-((abs(v.x)-.10)/.07)**2-((v.y-1.68)/.11)**2)
        return v
    k.bodypoint=point
    bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
    for mesh in list(bpy.data.meshes):
        if mesh.users==0:bpy.data.meshes.remove(mesh)
    skin=mat('Skin | warm anime tone',P['skin'],.82);skin.node_tree.nodes.get('Principled BSDF').inputs['Specular IOR Level'].default_value=.15
    ink=mat('Ink | soft outline',(.009,.012,.018),.92)
    hairmat=hair();head(skin,ink,hairmat);garments(skin,ink,hairmat)
    result=rig_and_export(cid,out)
    if save_blend:bpy.ops.wm.save_as_mainfile(filepath=str(out/(cid+'.blend')))
    print('SCULPT_REPORT',json.dumps(result));return result

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,default=ROOT/'public/models');parser.add_argument('--save-blend',action='store_true');parser.add_argument('characters',nargs='*',choices=list(PROFILES))
    args=parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
    args.output.mkdir(parents=True,exist_ok=True)
    previous=json.loads((args.output/'build-report.json').read_text()) if (args.output/'build-report.json').exists() else []
    report={e['id']:e for e in previous}
    selected=args.characters or list(PROFILES)
    for cid in selected:report[cid]=build(cid,args.output,args.save_blend)
    (args.output/'build-report.json').write_text(json.dumps(list(report.values()),indent=2)+'\n')
    manifest_path=args.output/'manifest.json'
    if manifest_path.exists():
        manifest=json.loads(manifest_path.read_text())
        for asset in manifest['assets']:
            cid=asset['id']
            if cid in selected:
                asset.update({key:report[cid][key] for key in ('sha256','animations','joints','sculptVersion')})
                asset['status']='active-project-sculpture-v2';asset['source']='scripts/sculpt-anime-cast.py'
        manifest_path.write_text(json.dumps(manifest,indent=2,ensure_ascii=False)+'\n')

if __name__=='__main__':main()
