"""Subject-specific sculpt data for the img2threejs Zoro reconstruction.

Runs after the upstream scaffold. Geometry is independently parameterized in
Three.js descriptor space; no Blender/GLB mesh is read by this script.
"""
import copy
import json
import math
import subprocess
import sys
from pathlib import Path

ROOT=Path(__file__).resolve().parent.parent
SKILL=ROOT/'.tools/img2threejs'
sys.path.insert(0,str(SKILL/'forge/stage2_spec'))
from new_sculpt_spec import _cnode

OUT=ROOT/'.img2threejs/cast/zoro'
gate=subprocess.run(['python3','forge/next.py','--state','../../.img2threejs/cast/zoro/state.json','../../.img2threejs/cast/zoro/character-sculpt-spec.json'],cwd=SKILL)
if gate.returncode:raise SystemExit(gate.returncode)
path=OUT/'character-sculpt-spec.json'
spec=json.loads(path.read_text())
assessment=json.loads((OUT/'assessment.json').read_text())
spec['preSpecAssessment']=assessment['preSpecAssessment']
spec['qualityContract']=assessment['qualityContract']
spec.pop('rig',None)  # Static character profile. A moving rig is a separate gated run.
spec['coordinateFrame']={'up':'y','forward':'z','handedness':'right',
    'scaleReference':'400 reference pixels per world unit; source pixel origin maps to x=-0.7, y=2.6'}
spec['silhouette']={'boundingShape':'long robe, spread boots, bent raised right elbow and diagonal drawn sword',
    'aspectRatios':[697/1050], 'symmetry':'asymmetric pose and accessories',
    'dominantCurves':['bent right arm','long flared green robe','curved katana cutting edge'],
    'negativeSpaces':['between raised right elbow and torso','between boots','left arm to waist'],
    'landmarks':spec['preSpecAssessment']['anatomy']['measurementEvidence']}
spec['assumptions']=['Side/back depth is inferred, confidence 0.4; no hidden-side fidelity claim.',
    'Static sculpture with clickable parts; no animation readiness claim.',
    'Projection descriptor is a plan; actual projection must be rendered and reviewed before acceptance.']
spec['proceduralStrategy']=['continuous implicit head and exposed body volumes',
    'tapered 3D garment volumes and layered separate sash shells',
    'scalp-bound short green hair crown with tapered locks',
    'independently clickable sword assemblies with beveled fittings',
    'de-lit camera projection for observed front appearance; palette continuation for unseen regions']
spec['performanceBudget']={'targetTriangles':90000,'maxDrawCalls':180,'notes':'One inspected hero model at a time.'}
spec['qualityTargets']['reviewViewpoints']=['reference','orbit+35','orbit-35','side90','rear135','rear180','head','head+35']
spec['qualityTargets']['targetFidelity']=.85
spec['selfCorrectLoop']['visualAcceptance']['threshold']=.8
spec['selfCorrectLoop']['reviewAfterPasses']=[p['id'] for p in spec['buildPasses']]
spec['referenceCamera']['aspect']=697/1050
spec['referenceCamera']['note']='Unsolved until rendered overlay; orthographic source art, no photographic focal length claim.'
spec['referenceCamera']['solved']=False
spec['projectedTextureBake']=json.loads((OUT/'projection.json').read_text())['projectedTextureBake']

PALETTE={
 'skin':('#e8be8d',.62,0,'skin'), 'robe':('#426953',.9,0,'fabric'),
 'sash':('#7e2e50',.86,0,'fabric'), 'haramaki':('#79a735',.92,0,'fabric'),
 'hair':('#7bc28d',.67,0,'unknown'), 'boots':('#101614',.64,0,'fabric'),
 'gold':('#b3a05c',.28,.75,'metal'), 'steel':('#b4c0c7',.23,.85,'metal'),
 'dark':('#20232c',.74,0,'fabric'), 'white':('#eeeade',.48,0,'unknown'),
 'scar':('#865541',.7,0,'skin'), 'hidden':('#000000',1,0,'unknown')}
PALETTE.update(scabbardRed=('#8b3b34',.7,0,'fabric'),scabbardIvory=('#bdc2a9',.63,0,'unknown'))
base=copy.deepcopy(spec['materials'][0])
spec['materials']=[]
for mid,(color,rough,metal,kind) in PALETTE.items():
 m=copy.deepcopy(base);m.update(id=mid,name=mid,color=color,baseColor=color,
     type='physical' if mid in ('gold','steel','skin') else 'standard')
 m['albedo']={'dominant':color,'secondary':[color],'accents':[]}
 m['colorVariation']={'palette':[color,color],'pattern':'flat','amplitude':0,'heightCorrelation':0}
 m['roughness']={'base':rough,'variation':.02,'map':'independent-micro-response'}
 m['metalness']={'base':metal,'variation':0}
 m['normal']={'pattern':'none','strength':0,'scale':1,'space':'tangent'}
 m['bump']={'pattern':'none','amplitude':0,'scale':1}
 m['displacement']={'pattern':'none','amplitude':0,'scale':1,'silhouetteAffects':False}
 m['localOverrides']=[{'id':mid+'-fold-tone','region':'reference-observed fold valleys',
     'roughness':min(1,rough+.04),'evidenceRefs':['full-object'],'notes':'Cloth folds are geometry; front shade boundary comes from de-lit projection.'}]
 m['notes']='Observed anime base colour. Physical roughness is inferred, not measured photometric evidence.'
 # The admitted source is flat cel artwork, with no pores, grain or image texture
 # in these fills. Do not fabricate PBR maps from its painted shadow boundaries.
 for field in ('normal','bump','displacement','surfaceFrequencyBands','textureProjection','textureResolution','referencePbr'):
  m.pop(field,None)
 m['textureless']={'declared':True,'evidence':[
     'docs/references/user-cast/zoro.png: flat cel-colour fills, bounded linework and painted shadow regions; no observable grain/pores.',
     '.img2threejs/cast/zoro/material-evidence.json: pixel crop and source-classification evidence.'],
     'limitation':'No photometric PBR recovery is claimed. Geometry carries folds, fittings and wrap diamonds.'}
 if mid=='hidden':m['opacity']={'base':0}
 spec['materials'].append(m)

def xyz(x,y,z=0):return [(x-280)/400,(1040-y)/400,z]
tree=[]
anchors={'root':[0,0,0]}
def add(cid,name,prim,point,size,mat='robe',level='meso',parent='root',role='garment',topology='continuous-sculpt'):
 p=xyz(*point) if len(point)==2 else list(point)
 if parent!='head':p=[p[i]-anchors[parent][i] for i in range(3)]
 c=_cnode(cid,name,prim,parent,p,size,material=mat,level=level,role=role,
     topology_class=topology,topology_rationale=f'{name} follows the observed contour with a real depth extent; it is not a flat image carrier.',
     importance=.9,evidence=['full-object'])
 anchors[cid]=[anchors[parent][i]+p[i] for i in range(3)]
 c['geometryLayer']='L4' if role=='garment' else 'L3'
 c['localFeatures']=[cid+'-observed-contour']
 color,rough,metal,kind=PALETTE[mat];r,g,b=[int(color[i:i+2],16) for i in (1,3,5)]
 c['colorMaterialRecipe']={'dominantAlbedo':f'rgba({r}, {g}, {b}, 1)',
     'secondaryAlbedo':f'rgba({round(r*.9)}, {round(g*.9)}, {round(b*.9)}, 1)',
     'materialClass':kind,'materialClassConfidence':.85,'evidenceRefs':['full-object']}
 tree.append(c);return c
root=add('root','Zoro reconstruction root','box',[0,0,0],[.001,.001,.001],'hidden','macro',role='body',topology='assembled-solid');root['parent']=None

def sweep(cid,name,stations,mat='robe',level='meso',parent='root',role='garment'):
 # A neck, sleeve or skirt is a blunt continuous volume, not a pointed hair lock.
 # Build its field from overlapping ellipsoids; retain observed station data so
 # the field can be refined without moving landmarks from memory.
 c=add(cid,name,'ellipsoid',[0,0,0],[1,1,1],mat,level,parent,role,'implicit')
 seeds=[];ops=[];mins=[1e9]*3;maxs=[-1e9]*3
 for i,(x,y,z,rx,rz) in enumerate(stations):
  prev=stations[max(0,i-1)];nxt=stations[min(len(stations)-1,i+1)]
  axial=max(12,math.hypot(nxt[0]-prev[0],nxt[1]-prev[1])*.6)
  center=xyz(x,y,z);radii=[rx/400,axial/400,rz/400]
  seeds.append({'id':f'section-{i}','type':'ellipsoid','center':center,'radii':radii})
  for j in range(3):mins[j]=min(mins[j],center[j]-radii[j]-.03);maxs[j]=max(maxs[j],center[j]+radii[j]+.03)
  if i:ops.append({'id':f'blend-{i}','type':'smooth-union','left':f'blend-{i-1}' if i>1 else 'section-0','right':f'section-{i}','radius':.025})
 c['geometryDescriptor']['sdf']={'primitives':seeds,'operations':ops,'bounds':{'min':mins,'max':maxs},'resolution':42}
 c['geometryDescriptor']['observedStations']=stations
 c['geometryDescriptor']['topologyIntent']='Smooth-union body/garment blockout; garment shell offset and silhouette refinement remain later pass tasks.'
 c['geometryLayer']='L0' if role=='body' else 'L4'
 if cid in ('armband','sash-tail','sash-tail-back'):
  start=xyz(*stations[0][:2],stations[0][2])
  c['attachment']={'parentSocket':cid+'-root','localStart':start,'localEnd':start,
      'contactType':'surface-overlap','embedDepth':.025,'gapTolerance':.008,
      'evidenceRefs':['full-object'],'notes':'Point anchor; field geometry supplies extent, not a linear attachment cylinder.'}
 return c

# Silhouette-defining mass and fitted layers, all in the admitted reference pose.
sweep('robe','Long flared robe',[(278,463,0,85,52),(274,530,0,96,60),(266,665,0,125,71),(262,800,0,153,79),(262,852,0,147,78)],level='macro')
sweep('chest','Bare muscular chest',[(275,285,.01,41,30),(274,242,.01,51,34),(275,197,.01,44,31),(274,174,.01,29,25)],'skin','macro',role='body')
sweep('neck','Neck',[(274,180,.005,24,22),(274,148,.005,19,20)],'skin',role='body')
sweep('haramaki','Green ribbed haramaki',[(275,390,.015,61,39),(274,340,.015,49,32),(274,282,.015,41,30)],'haramaki')
sweep('robe-left','Left lapel and shoulder',[(339,390,.005,41,32),(359,325,.005,45,35),(354,248,.005,42,34),(340,202,.005,34,31),(308,180,.005,17,24)],level='macro')
sweep('robe-right','Right lapel and shoulder',[(197,389,.005,30,30),(185,320,.005,31,35),(186,245,.005,37,35),(185,200,.005,39,33),(228,182,.005,14,23)],level='macro')
sweep('sleeve-raised','Raised right sleeve',[(176,204,0,36,37),(128,240,0,37,34),(91,247,0,36,33),(86,218,0,32,29),(111,180,0,28,27),(126,153,0,25,25)])
sweep('forearm-raised','Raised right forearm',[(126,161,.005,21,20),(146,135,.02,19,18),(160,115,.04,16,16)],'skin',role='body')
sweep('sleeve-down','Low left sleeve',[(353,233,0,32,32),(380,334,0,30,28),(393,411,0,28,27),(407,468,0,25,24)])
sweep('forearm-down','Low left forearm',[(409,464,.01,18,17),(424,498,.035,14,14),(432,523,.055,12,13)],'skin',role='body')
sweep('pants-left','Left trouser cuff',[(354,839,0,30,30),(363,887,0,26,27),(368,905,0,19,21)],'boots')
sweep('pants-right','Right trouser cuff',[(176,841,0,29,30),(169,887,0,25,27),(167,905,0,18,21)],'boots')
sweep('boots','Left boot',[(369,895,0,15,18),(371,952,.005,18,22),(390,1005,.06,38,29),(414,1026,.08,32,30)],'boots','macro',role='foot')
sweep('boot-right','Right boot',[(165,896,0,15,18),(160,956,.005,17,22),(129,1004,.06,35,29),(110,1025,.08,33,30)],'boots','macro',role='foot')
sweep('sash','Purple wrapped sash',[(274,478,.015,89,55),(273,450,.015,104,63),(266,418,.015,112,65),(267,393,.015,107,61)],'sash')
sweep('sash-tail','Long purple sash tail',[(351,384,.18,20,11),(358,468,.19,23,11),(370,559,.18,26,12),(378,653,.16,24,12)],'sash')
sweep('sash-tail-back','Rear purple sash tail',[(360,389,.13,19,10),(374,491,.13,20,10),(389,645,.11,24,11)],'sash')
sweep('armband','Black left upper arm band',[(380,285,.015,32,30),(386,315,.015,33,30)],'boots')

# L0 head volume uses implicit smooth unions, then a real eye subtraction.
head=add('head','Continuous head volume','sphere',[274,108],[1,1,1],'skin','macro',role='head',topology='implicit')
head['geometryLayer']='L0'
head['geometryDescriptor']['sdf']={
 'primitives':[
  {'id':'cranium','type':'ellipsoid','center':[0,.025,0],'radii':[.096,.12,.09]},
  {'id':'jaw','type':'ellipsoid','center':[0,-.068,.009],'radii':[.073,.067,.071]},
  {'id':'chin','type':'ellipsoid','center':[0,-.113,.022],'radii':[.046,.028,.048]},
  {'id':'cheek-r','type':'ellipsoid','center':[-.055,-.035,.039],'radii':[.038,.052,.054]},
  {'id':'cheek-l','type':'ellipsoid','center':[.055,-.035,.039],'radii':[.038,.052,.054]},
  {'id':'nose','type':'ellipsoid','center':[0,-.042,.091],'radii':[.013,.033,.022]},
  {'id':'eye-carve','type':'ellipsoid','center':[-.046,.001,.089],'radii':[.033,.018,.022]}],
 'operations':[
  {'id':'join1','type':'smooth-union','left':'cranium','right':'jaw','radius':.025},
  {'id':'join2','type':'smooth-union','left':'join1','right':'chin','radius':.018},
  {'id':'join3','type':'smooth-union','left':'join2','right':'cheek-r','radius':.02},
  {'id':'join4','type':'smooth-union','left':'join3','right':'cheek-l','radius':.02},
  {'id':'join5','type':'smooth-union','left':'join4','right':'nose','radius':.01},
  {'id':'face','type':'subtract','left':'join5','right':'eye-carve'}],
 'bounds':{'min':[-.13,-.15,-.115],'max':[.13,.16,.125]},'resolution':42}
if (OUT/'head-rings.json').exists():
 head['geometryDescriptor']['ringStack']={'rings':json.loads((OUT/'head-rings.json').read_text()),
     'source':'Triangle-plane intersections from inspect-sculpt-geometry.mjs; geometry-derived approximation for standProud.'}
hair=add('hair','Short green scalp crown','ellipsoid',[0,.074,-.006],[.235,.153,.218],'hair','meso','head','hair')
hair['standProud']={'againstComponentId':'head','clearance':.004,'maxPush':.015}
hair['hairProfile']={'representationTier':'shell','rootBinding':{'type':'scalp-uv','u':.5,'v':.3}}
for i in range(18):
 angle=2*math.pi*i/18
 x,z=math.cos(angle),math.sin(angle)
 c=add(f'hair-tip-{i}','Scalp-attached tapered crown lock','tapered-sweep',[0,0,0],[1,1,1],'hair','micro','head','hair')
 c['geometryDescriptor']['taperedSweep']={'stations':[
     {'position':[x*.08,.072,z*.067],'rx':.022,'rz':.015},
     {'position':[x*.106,.108+(i%3)*.008,z*.087],'rx':.016,'rz':.011},
     {'position':[x*.122,.13+(i%3)*.009,z*.101],'rx':0,'rz':0}], 'radialSegments':6}
 c['standProud']={'againstComponentId':'head','clearance':.003,'maxPush':.012}
 c['hairProfile']={'representationTier':'shell','rootBinding':{'type':'scalp-uv','u':i/18,'v':.35}}

add('eye-r','Open right eye','ellipsoid',[-.047,.001,.084],[.056,.025,.026],'white','micro','head','detail')
add('iris-r','Right iris','ellipsoid',[-.045,-.001,.100],[.014,.016,.006],'dark','micro','head','detail')
add('teeth','Clenched grin','ellipsoid',[0,-.077,.082],[.119,.032,.018],'white','micro','head','detail')
add('scar','Closed left eye scar','box',[.042,.007,.09],[.003,.097,.003],'scar','micro','head','detail','surface-relief')
for side in (-1,1):
 c=add(f'brow-{side}','Angled brow','box',[side*.047,.026,.086],[.061,.006,.006],'dark','micro','head','detail','surface-relief')
 c['transform']['rotation'][2]=side*-.16
 add(f'ear-{side}','Ear','ellipsoid',[side*.099,-.01,-.001],[.031,.061,.036],'skin','micro','head','detail')
for i in range(3):
 c=add('earrings' if i==0 else f'earring-{i}','Gold left ear drop','box',[.102+i*.008,-.055,.004],[.005,.044,.008],'gold','micro','head','detail','assembled-solid')

# Hand volumes (individual curved fingers are deliberately a form-pass task).
for cid,p,sz in [('hand-raised',[169,111],[.085,.108,.065]),('hand-down',[434,528],[.075,.12,.065])]:
 add(cid,'Gripping hand','ellipsoid',p,sz,'skin',role='hand')

# Three separate rigid sword groups, with observed diagonal pose.
def blade(cid,start,end,width,depth,mat):
 p0,p1=xyz(*start),xyz(*end);d=[p1[j]-p0[j] for j in range(3)]
 length=math.sqrt(sum(v*v for v in d));angle=math.atan2(-d[0],d[1])
 c=add(cid,cid.replace('-',' '),'extrude',p0,[1,1,1],mat,'meso',role='accessory',topology='assembled-solid')
 c['geometryDescriptor']['profile2D']={'points':[[-width/2,0],[width/2,0],[width*.35,length*.92],[0,length],[-width*.35,length*.90]],'depth':depth}
 c['transform']['rotation'][2]=angle
 return c
blade('raised-grip',[95,40],[211,155],.047,.035,'dark')
blade('raised-sheath',[213,155],[245,193],.044,.032,'dark')
blade('hip-grip',[88,281],[167,365],.048,.034,'white')
blade('hip-sheath',[174,373],[465,790],.049,.039,'dark')
blade('low-grip',[413,482],[445,565],.045,.032,'dark')
blade('blade',[453,583],[672,985],.047,.011,'steel')
for i,p in enumerate([(200,145),(166,366),(446,575)]):
 c=add('sword-guards' if i==0 else f'guard-{i}','Gold katana guard','ellipsoid',p,[.12,.048,.09],'gold',role='accessory',topology='assembled-solid')
 c['transform']['rotation'][2]=-.55
for i,(x,y) in enumerate([(218,529),(211,589),(201,650),(189,709)]):
 c=add('robe-toggles' if i==0 else f'toggle-{i}','Robe front toggle','box',[*xyz(x,y,.19)],[.055,.014,.018],'gold','micro',role='detail',topology='assembled-solid')
for i in range(8):
 c=add('sword-wrap' if i==0 else f'grip-diamond-{i}','Raised grip diamond','box',xyz(108+i*10,55+i*10,.027),[.018,.012,.004],'white','micro',role='detail',topology='material-only')
 c['transform']['rotation'][2]=.78
for i in range(7):
 c=add('chest-scar' if i==0 else f'chest-stitch-{i}','Chest scar dash','box',xyz(250+i*9,272-i*8,.098),[.017,.003,.003],'scar','micro',role='detail',topology='surface-relief')
 c['transform']['rotation'][2]=-.65

# Correction 1: replace inflated garment/foot fields with their actual topology.
# These are still the blockout pass: silhouette and garment thickness only.
by_id={c['id']:c for c in tree}
def panel(cid,points,z,depth):
 c=by_id[cid];c['primitive']='extrude';c['topologyClass']='conforming-shell'
 c['topologyRationale']='Thin fitted garment panel follows observed contour; thickness is physical fabric thickness, not a continuous body volume.'
 c['geometryDescriptor']={'profile2D':{'points':[xyz(x,y)[:2] for x,y in points],'depth':depth},
     'topologyIntent':'garment shell with observed hem and folds; depth inferred',
     'edgeTreatment':{'type':'none','bevelRadius':0,'segments':1},'deformationStack':[],
     'uvStrategy':'generated procedural coordinates','normalStrategy':'crease-preserving vertex normals'}
 c['transform']={'position':[0,0,z],'rotation':[0,0,0],'scale':[1,1,1]}
 c['dimensions']={'width':(max(x for x,y in points)-min(x for x,y in points))/400,
     'height':(max(y for x,y in points)-min(y for x,y in points))/400,'depth':depth,'units':'relative','confidence':.85}
def wrap(cid,center_x,sections,depth_ratio):
 c=by_id[cid];c['primitive']='lathe';c['topologyClass']='conforming-shell'
 c['topologyRationale']='Open-ended elliptical cloth shell; outer and inner profiles form a real thickness around the body.'
 outer=[[r/400,(1040-y)/400] for r,y in sections]
 inner=[[(r-6)/400,(1040-y)/400] for r,y in reversed(sections)]
 c['geometryDescriptor']={'latheProfile':{'points':outer+inner+[outer[0]],'segments':64},
     'topologyIntent':'hollow elliptical garment wrap, six-pixel inferred thickness',
     'edgeTreatment':{'type':'none','bevelRadius':0,'segments':1},'deformationStack':[],
     'uvStrategy':'generated procedural coordinates','normalStrategy':'smooth vertex normals'}
 c['transform']={'position':[(center_x-280)/400,0,0],'rotation':[0,0,0],'scale':[1,1,depth_ratio]}
 c['attachment']=None
wrap('robe',262,[(147,855),(154,825),(143,740),(126,650),(110,560),(91,469)],.52)
wrap('sash',273,[(89,479),(103,454),(110,417),(105,391)],.58)
panel('robe-right',[(232,174),(211,185),(177,185),(172,274),(166,348),(193,387),(248,394),(223,350),(229,255)],.09,.035)
panel('robe-left',[(308,173),(342,186),(374,230),(371,311),(349,383),(291,393),(323,342),(320,244)],.09,.035)
panel('sash-tail',[(333,385),(355,380),(367,436),(396,648),(378,665),(350,652)],.18,.012)
panel('sash-tail-back',[(346,388),(365,387),(390,508),(421,644),(389,650)],.13,.012)
for cid,points in [
 ('boot-right',[(167,899),(187,900),(183,963),(179,995),(166,1011),(111,1034),(75,1031),(82,1020),(119,995),(143,965),(149,913)]),
 ('boots',[(354,901),(390,899),(397,964),(412,989),(464,1027),(472,1039),(434,1039),(393,1027),(361,1013),(351,991)])]:
 panel(cid,points,-.04,.11)
 c=by_id[cid];c['topologyClass']='assembled-solid';c['topologyRationale']='Closed leather boot volume with a pointed toe and a thick ankle shaft; source contour defines the stance.';c['geometryLayer']='L3'
band=by_id['armband'];band['primitive']='torus';band['topologyClass']='conforming-shell'
band['topologyRationale']='A fitted textile band wraps the upper arm, with an elliptical opening and finite thickness.'
band['geometryDescriptor']={'torusTubeRatio':.18,'topologyIntent':'fitted upper arm band','deformationStack':[],'uvStrategy':'generated procedural coordinates','normalStrategy':'smooth vertex normals'}
band['transform']={'position':xyz(383,304,.0),'rotation':[math.pi/2,0,-.15],'scale':[.17,.16,.05]}
band['attachment']={'parentSocket':'left-upper-arm','localStart':xyz(383,304,0),'localEnd':xyz(383,304,0),
    'contactType':'surface-overlap','embedDepth':.02,'gapTolerance':.008,'evidenceRefs':['full-object']}
band['name']='Fitted upper-arm wrap'

# Correction 2: an arm's long axis follows its bone, not global Y. This removes
# the previous overshoot below the bent elbow without narrowing the whole sleeve.
def capsule_field(cid,points,radii,depth_scale=.9):
 c=by_id[cid];prims=[];ops=[];mins=[1e9]*3;maxs=[-1e9]*3
 for i,(a,b) in enumerate(zip(points,points[1:])):
  start,end=xyz(*a),xyz(*b);d=[end[j]-start[j] for j in range(3)];length=math.sqrt(sum(v*v for v in d));r=radii[i]/400
  middle=[(start[j]+end[j])/2 for j in range(3)]
  prims.append({'id':f'bone-{i}','type':'capsule','radius':r,'height':length,
      'transform':{'position':middle,'rotation':[0,0,math.atan2(-d[0],d[1])],'scale':[1,1,depth_scale]}})
  for j in range(3):mins[j]=min(mins[j],start[j]-r-.025,end[j]-r-.025);maxs[j]=max(maxs[j],start[j]+r+.025,end[j]+r+.025)
  if i:ops.append({'id':f'join-{i}','type':'smooth-union','left':f'join-{i-1}' if i>1 else 'bone-0','right':f'bone-{i}','radius':.02})
 c['geometryDescriptor']['sdf']={'primitives':prims,'operations':ops,'bounds':{'min':mins,'max':maxs},'resolution':42}
 c['geometryDescriptor']['topologyIntent']='Continuous oriented capsules fitted to observed shoulder, elbow and cuff.'
capsule_field('sleeve-raised',[(179,207),(74,238),(115,166)],[31,29])
capsule_field('forearm-raised',[(126,157),(158,118)],[17],.85)
capsule_field('sleeve-down',[(353,221),(379,347),(405,446)],[30,26])
capsule_field('forearm-down',[(410,469),(431,520)],[13],.85)

# A real hollow scalp shell avoids forcing the inside of a solid ellipsoid
# through the outer surface during standProud. This is a geometry repair.
hair['transform']['position']=[0,0,0]
hair['transform']['scale']=[1,1,1]
hair['topologyClass']='implicit';hair['geometryLayer']='L3'
hair['geometryDescriptor']['sdf']={
 'primitives':[
  {'id':'outer','type':'ellipsoid','center':[0,.074,-.006],'radii':[.1175,.083,.109]},
  {'id':'inner','type':'ellipsoid','center':[0,.025,0],'radii':[.099,.123,.093]},
  {'id':'crown-crop','type':'box','center':[0,.15,0],'size':[.3,.18,.3]}],
 'operations':[{'id':'shell','type':'subtract','left':'outer','right':'inner'},
     {'id':'crop','type':'intersect','left':'shell','right':'crown-crop'}],
 'bounds':{'min':[-.13,.055,-.13],'max':[.13,.165,.13]},'resolution':50}
hair['topologyRationale']='Finite scalp shell is cut from an outer crown by subtracting a slightly expanded cranium; roots overlap the shell.'

# Resume correction: fit continuous volumes to measured front cross-sections.
# The loft is volumetric, with a separate inferred depth profile; not a cutout.
def loft(cid,sections,thickness=None,features=None):
 c=by_id[cid];c['primitive']='ellipsoid' if cid=='head' else 'lathe'
 c['topologyClass']='continuous-sculpt' if cid=='head' else 'conforming-shell'
 c['topologyRationale']='Continuous parameterized cross-sections fit the observed frontal outline; depth and hidden sides remain inferred.'
 c['geometryDescriptor'].pop('sdf',None)
 c['geometryDescriptor']['parametricLoft']={'sections':sections,'radialSegments':72,'verticalSegments':64,
     **({'thickness':thickness} if thickness else {}),**({'frontFeatures':features} if features else {})}
 c['geometryDescriptor']['topologyIntent']='Monotone cubic section loft, closed volume or rounded cloth shell; see refineZoroGeometry.ts.'
 c['transform']['scale']=[1,1,1]
 if cid!='head':
  c['transform']['position']=[0,0,0]
  c['geometryDescriptor']['latheProfile']={'points':[[s[2],s[0]] for s in sections],'segments':64}
loft('robe',[[.45,-.045,.34,.19,0],[.485,-.045,.382,.205,0],[.6,-.045,.397,.21,0],
    [.85,-.022,.365,.2,0],[1.1,-.0175,.317,.18,0],[1.3,-.015,.277,.16,0],[1.435,-.015,.255,.15,0]],.012)
loft('sash',[[1.405,-.005,.245,.15,.015],[1.48,-.02,.27,.16,.015],[1.56,-.04,.278,.163,.015],[1.62,-.04,.273,.16,.015]],.01)
head['transform']['position']=xyz(269,108)
head_rows=[(163,273,1,1),(159,273,11,9),(149,273,25,20),(136,270,36,27),
    (114,267,40,31),(92,263,40,32),(73,262,34,30),(60,262,24,23),(54,262,1,1)]
head_sections=[[(108-y)/400,(cx-269)/400,rx/400,rz/400,0] for y,cx,rx,rz in head_rows]
loft('head',head_sections,features=[
    {'x':-.047,'y':-.002,'width':.027,'height':.018,'depth':-.013},
    {'x':.044,'y':.002,'width':.027,'height':.018,'depth':-.009},
    {'x':0,'y':-.04,'width':.013,'height':.038,'depth':.025}])
head['geometryDescriptor']['ringStack']={'rings':[[s[0],s[2]+abs(s[1]),s[3],s[4]] for s in head_sections],
    'source':'Observed loft sections; conservative lateral bound for the shifted head axis.'}
for primitive in hair['geometryDescriptor']['sdf']['primitives']:
 if primitive['id'] in ('outer','inner'):primitive['center'][0]-=.015
for c in tree:
 if c['id'].startswith('hair-tip-'):
  for station in c['geometryDescriptor']['taperedSweep']['stations']:station['position'][0]-=.015

# The hair shell follows the fitted scalp; a front/back hem warp preserves the
# forehead opening and the longer nape without pushing inner surfaces through it.
loft('hair',[[.055,-.014,.116,.094,0],[.075,-.017,.11,.087,0],[.1,-.017,.092,.076,0],
    [.125,-.017,.06,.05,0],[.142,-.017,.032,.027,0],[.15,-.017,.010,.010,0]],.008)
hair['geometryDescriptor']['parametricLoft']['hemWarp']={'frontLift':.02,'backDrop':.04,'decay':.04}
hair['geometryDescriptor']['parametricLoft']['scalpOffset']={'component':'head','clearance':.012,
    'evidence':'Offset the inner/outer shell coherently around the fitted scalp; keep positive wall thickness before standProud.'}
for c in tree:
 if not c['id'].startswith('hair-tip-'):continue
 i=int(c['id'].split('-')[-1]);angle=i*math.pi*2/18;co,si=math.cos(angle),math.sin(angle)
 c['geometryDescriptor']['taperedSweep']['stations']=[
    {'position':[-.017+co*.112,.07,si*.094],'rx':.011,'rz':.007},
    {'position':[-.017+co*.122,.112+(i%3)*.005,si*.102],'rx':.008,'rz':.005},
    {'position':[-.017+co*.133,.143+(i%3)*.006,si*.112],'rx':0,'rz':0}]
for ident,profile in json.loads((OUT/'boot-contours.json').read_text())['profiles'].items():
 sections=[]
 for row in reversed(profile):
  y,cx,rx=row['y'],(row['left']+row['right'])/2,(row['right']-row['left'])/2
  rz=.032+.06*max(0,min(1,(y-950)/75))
  sections.append([(1040-y)/400,(cx-280)/400,max(.001,rx/400),rz,0])
 low=sections[0];high=sections[-1]
 sections.insert(0,[low[0]-.002,low[1],.001,.001,0])
 sections.append([high[0]+.004,high[1],high[2]*.95,high[3],0])
 loft(ident,sections)
 by_id[ident]['topologyClass']='continuous-sculpt'
 by_id[ident]['topologyRationale']='Closed curved boot volume fitted to isolated source alpha contours, with separately inferred ankle and toe depth.'

# Align the head-local origin with the crown axis used by the scalp field.
# Preserve every surface's world position; only the previously biased field changes.
basis_shift=7/400
head['transform']['position']=xyz(262,108)
for section in head['geometryDescriptor']['parametricLoft']['sections']:section[1]+=basis_shift
for feature in head['geometryDescriptor']['parametricLoft']['frontFeatures']:feature['x']+=basis_shift
head['geometryDescriptor']['ringStack']['rings']=[[s[0],s[2]+abs(s[1]),s[3],s[4]] for s in head['geometryDescriptor']['parametricLoft']['sections']]
for c in tree:
 if c['parent']=='head':c['transform']['position'][0]+=basis_shift
blade_rows=json.loads((OUT/'blade-contours.json').read_text())['rows']
blade_rows=[{'y':582,'left':438,'right':458},{'y':594,'left':441,'right':462},{'y':606,'left':445,'right':468}]+[row for row in blade_rows if row['y']>606]
blade_part=by_id['blade'];blade_part['geometryDescriptor']['bladeRibbon']={'rows':blade_rows,'thickness':.011,
    'source':'blade-contours.json; front outline measured, spine/edge section inferred'}
blade_part['geometryDescriptor']['profile2D']={'points':[[*xyz(row['left'],row['y'])[:2]] for row in blade_rows]+[[*xyz(row['right'],row['y'])[:2]] for row in reversed(blade_rows)],'depth':.011}
blade_part['transform']={'position':[0,0,0],'rotation':[0,0,0],'scale':[1,1,1]}
by_id['hand-raised']['transform']['scale']=[.10,.14,.075]
by_id['hand-down']['transform']['position']=xyz(440,528)
by_id['hand-down']['transform']['scale']=[.105,.125,.075]
capsule_field('sleeve-raised',[(180,223),(68,241),(107,171)],[29,31])
for ident in ('pants-left','pants-right'):
 for seed in by_id[ident]['geometryDescriptor']['sdf']['primitives']:
  seed['radii'][0]+=.015
  if ident=='pants-left':seed['center'][0]+=.018

def scabbard(cid,start,end,width,depth,mat):
 if cid not in by_id:
  c=blade(cid,start,end,width,depth,mat);by_id[cid]=c
 else:c=by_id[cid]
 p0,p1=xyz(*start),xyz(*end);length=math.dist(p0,p1)
 c['material']=mat;c['materialLayers']=[mat]
 c['transform']={'position':p0,'rotation':[0,0,math.atan2(-(p1[0]-p0[0]),p1[1]-p0[1])],'scale':[1,1,1]}
 c['geometryDescriptor']['profile2D']={'points':[[-width/2,0],[width/2,0],[width*.47,length],[-width*.47,length]],'depth':depth}
 c['geometryDescriptor']['topologyIntent']='Blunt-ended closed scabbard with a rectangular-to-oval section; observed endpoint.'
 return c
scabbard('hip-sheath',(174,373),(480,789),.064,.038,'dark')
scabbard('ivory-sheath',(169,366),(489,742),.063,.038,'scabbardIvory')
scabbard('red-sheath',(165,379),(459,816),.048,.034,'scabbardRed')
for ident,start,end,width in [('ivory-sheath-cap',(476,726),(489,742),.072),
    ('dark-sheath-cap',(467,770),(480,789),.074),('red-sheath-cap',(449,801),(459,816),.06)]:
 scabbard(ident,start,end,width,.043,'gold')

# Structural pass: panels wrap a continuous torso/back shell, and hands carry
# five articulated gripping digits. Source XY is observed; depth is inferred.
stage_order=['blockout','proportion-lock','structural-pass','feature-placement','material-pass','lighting-pass','interaction-pass','optimization-pass']
stage=spec['sculptPipeline']['currentPass']
if stage_order.index(stage)>=stage_order.index('structural-pass'):
 loft('chest',[[1.78,-.014,.09,.072,.0],[1.88,-.014,.123,.085,0],[2.02,-.015,.13,.09,0],
      [2.14,-.02,.095,.074,-.01],[2.2,-.02,.055,.051,-.018]])
 by_id['chest']['topologyClass']='continuous-sculpt';by_id['chest']['geometryLayer']='L0'
 capsule_field('neck',[(273,183,-.018),(272,150,-.018)],[20],.9)
 # A jacket has a back. Its open front remains open, with physical cut edges.
 back=add('coat-back','Continuous open-front jacket back','lathe',[0,0,0],[1,1,1],level='macro',parent='chest')
 by_id['coat-back']=back
 loft('coat-back',[[1.6,-.025,.265,.15,0],[1.72,-.025,.247,.155,0],[1.9,-.02,.235,.16,0],
      [2.1,-.03,.25,.15,0],[2.16,-.03,.19,.12,0]],.015)
 back['geometryDescriptor']['parametricLoft']['angularRange']=[math.pi,math.pi*2]
 back['geometryDescriptor']['topologyIntent']='Back half of a rounded cloth shell, with triangulated closed cut edges; hidden depth inferred at confidence 0.4.'
 for ident in ('robe-left','robe-right'):
  c=by_id[ident];c['parent']='coat-back'
  c['geometryDescriptor']['fittedPanel']={'points':c['geometryDescriptor']['profile2D']['points'],
      'depth':.018,'centreX':-.025,'radiusX':.285,'radiusZ':.16,'standOff':.014,'subdivisions':3}
  c['transform']['position']=[0,0,0]
  c['topologyRationale']='Subdivided finite-thickness lapel bends around the torso ellipse, joining the open jacket back; not a flat card.'
 by_id['neck']['parent']='chest';head['parent']='neck'
 # Keep node rotations identity: sword children retain their authored world pose.
 for ident,angle in [('hand-raised',.78),('hand-down',.36)]:
  hand_id=ident
  c=by_id[ident];c['transform']['scale']=[1,1,1];c['geometryLayer']='L0';c['topologyClass']='implicit'
  c['primitive']='ellipsoid';prims=[]
  def rotate(p):return [p[0]*math.cos(angle)-p[1]*math.sin(angle),p[0]*math.sin(angle)+p[1]*math.cos(angle),p[2]+.025]
  prims.append({'id':'palm','type':'ellipsoid','center':rotate([0,0,-.002]),'radii':[.029,.039,.020],
      'transform':{'position':rotate([0,0,-.002]),'rotation':[0,0,angle]}})
  # Keep the palm a single continuous field. Each curled finger is a real capped,
  # round tube under the palm node, so narrow gaps do not collapse into SDF aliases.
  c['geometryDescriptor']={'sdf':{'primitives':prims,'operations':[],'bounds':{'min':[-.05,-.05,-.035],'max':[.05,.05,.035]},'resolution':36},
      'topologyIntent':'Continuous palm plus four three-joint curled fingers and opposing thumb; no imported mesh; hidden depth inferred.',
      'deformationStack':[],'uvStrategy':'generated procedural coordinates','normalStrategy':'smooth vertex normals'}
  for index,(name,stations,radius) in enumerate([
   ('index',[[.012,.030,-.002],[.024,.027,.000],[.035,.025,.002],[.047,.022,.002]],.0050),
   ('middle',[[.011,.010,0],[.023,.009,.017],[.044,.007,.020],[.050,.005,.001]],.0058),
   ('ring',[[.011,-.010,0],[.021,-.011,.016],[.040,-.013,.016],[.045,-.015,0]],.0055),
   ('little',[[.009,-.030,-.001],[.018,-.030,.012],[.033,-.032,.011],[.036,-.033,-.002]],.0050),
   ('thumb',[[-.025,-.018,-.002],[-.039,.001,.012],[-.021,.024,.026],[.002,.027,.022]],.0064)]):
   finger=add(f'{hand_id}-{name}',f'{name.title()} curled finger','tube',[0,0,0],[1,1,1],'skin','micro','root','detail','assembled-solid')
   finger['parent']=hand_id;finger['transform']={'position':[0,0,0],'rotation':[0,0,0],'scale':[1,1,1]}
   finger['geometryDescriptor']={'fingerTube':{'stations':[[*rotate(p),radius] for p in stations],
      'radialSegments':12 if name=='index' else 10,'steps':40 if name=='index' else 24},
      'topologyIntent':'Single curved solid tube with a round capped fingertip, joined visually into the palm; hidden phalanx depth inferred.',
      'deformationStack':[],'uvStrategy':'generated procedural coordinates','normalStrategy':'smooth vertex normals'}
   finger['geometryLayer']='L3';finger['topologyClass']='assembled-solid';finger['localFeatures']=[f'{hand_id}-{name}-grip-curve']
   finger['colorMaterialRecipe']=copy.deepcopy(c['colorMaterialRecipe'])
   finger['attachment']={'parentSocket':f'{hand_id}-palm','localStart':[0,0,0],'localEnd':[0,0,0],
      'contactType':'surface-overlap','embedDepth':.004,'gapTolerance':.003,'evidenceRefs':['full-object'],
      'notes':'Curved digit root is embedded into the palm volume; finger bend is static and depth is inferred.'}

# Held parts now inherit their actual hand, and hip fittings inherit the waist.
# Limits are reference-derived centroid-to-anchor distances plus contact slack.
for cid,anchor,limit in [
 ('raised-grip','hand-raised',.13),('raised-sheath','hand-raised',.28),
 ('sword-guards','hand-raised',.18),('hip-grip','haramaki',.45),
 ('hip-sheath','haramaki',.75),('guard-1','haramaki',.36),
 ('low-grip','hand-down',.14),('guard-2','hand-down',.20),('blade','hand-down',.80),
 ('ivory-sheath','haramaki',.75),('red-sheath','haramaki',.85),
 ('ivory-sheath-cap','haramaki',1.3),('dark-sheath-cap','haramaki',1.3),('red-sheath-cap','haramaki',1.4)]:
 c=by_id[cid];parent=by_id[anchor]
 c['parent']=anchor
 c['transform']['position']=[c['transform']['position'][j]-parent['transform']['position'][j] for j in range(3)]
 c['attachment']={'anchor':anchor,'maxOffset':limit,'contactType':'held-grip' if 'hand' in anchor else 'waist-mounted',
     'evidenceRefs':['full-object'],'notes':'Proximity uses measured geometry centroids, not zero pivots of implicit fields.'}

spec['componentTree']=tree
spec['repetitionSystems']=[{'id':'fitting-repeats','componentRefs':['robe-toggles','sword-wrap','earrings'],
    'elementComponentIds':['robe-toggles','toggle-1','toggle-2','toggle-3','sword-wrap']+[f'grip-diamond-{i}' for i in range(1,8)]+['earrings','earring-1','earring-2'],
    'distribution':'authored-observed-positions','buildsGeometry':True,'count':15,
    'notes':'Named fitting meshes retain individual click/explode identity; instance optimization deferred to optimization pass.'}]
for d in spec['preSpecAssessment']['detailInventory']['details']:
 owner=next(c for c in tree if c['id']==d['mapsTo']['ref'])
 owner['localFeatures'].append({'id':d['id'],'description':d['description'],'evidenceRefs':['full-object']})
for p in spec['buildPasses']:p['componentRefs']=[c['id'] for c in tree]
if not any(p['id']=='structural-pass' for p in spec['buildPasses']):
 spec['buildPasses'].insert(2,{'id':'structural-pass','goal':'Verify layered garment and three sword assemblies before facial refinement.',
     'componentRefs':[c['id'] for c in tree],'acceptance':['All observed major parts remain attached from meaningful orbit views.']})
spec['sculptPipeline']['passOrder']=[p['id'] for p in spec['buildPasses']]
spec['selfCorrectLoop']['reviewAfterPasses']=[p['id'] for p in spec['buildPasses']]
spec['lightingFromPhoto']=[
 {'type':'directional','role':'key','position':[-3,5,5],'color':'#fff3df','intensity':2.2,'shadowSoftness':2},
 {'type':'directional','role':'fill','position':[3,2,3],'color':'#dceaff','intensity':.8},
 {'type':'directional','role':'rim','position':[2,4,-3],'color':'#d9edff','intensity':1.4},
 {'type':'hemisphere','role':'ambient','color':'#e8f3ff','groundColor':'#65605a','intensity':1}]
spec['lightingFromPhoto'].append({'type':'render-settings','exposure':1,
    'toneMapping':'ACESFilmicToneMapping','background':'#f4f5f2',
    'contact shadow':'soft ground shadow at the soles, opacity 0.16; no painted shadow texture'})
spec['featureReviewTargets']=[
 {'id':'anatomy-proportion','name':'Source head units and long robe proportions','tier':'critical','passIds':['blockout','proportion-lock'],'minimumScore':.8,'mustPass':True,'componentRefs':['head','robe','boots'],'evidenceRefs':['full-object']},
 {'id':'pose-silhouette','name':'Bent raised right arm and three sword placements','tier':'critical','passIds':['blockout','proportion-lock'],'minimumScore':.8,'mustPass':True,'componentRefs':['sleeve-raised','forearm-raised','blade'],'evidenceRefs':['full-object']},
 {'id':'layered-garment','name':'Curved lapels join a continuous back, neck and torso','tier':'critical','passIds':['structural-pass'],'minimumScore':.8,'mustPass':True,'componentRefs':['robe-left','robe-right','chest','neck'],'evidenceRefs':['full-object']},
 {'id':'held-sword-assembly','name':'Five-digit grips and separate sword assemblies retain contact','tier':'critical','passIds':['structural-pass'],'minimumScore':.8,'mustPass':True,'componentRefs':['hand-raised','hand-down','raised-grip','low-grip'],'evidenceRefs':['full-object']},
 {'id':'face-landmark-placement','name':'Closed left eye/scar, narrow open eye and grin','tier':'critical','passIds':['feature-placement'],'minimumScore':.8,'mustPass':True,'componentRefs':['head','scar','eye-r','teeth'],'evidenceRefs':['full-object']},
 {'id':'outfit-and-palette','name':'Green robe/haramaki and purple sash','tier':'critical','passIds':['material-pass'],'minimumScore':.8,'mustPass':True,'componentRefs':['robe','haramaki','sash'],'evidenceRefs':['full-object']}]
path.write_text(json.dumps(spec,indent=2)+'\n')
print(f'Authored {len(tree)} source-specific components; visual gates remain pending.')
