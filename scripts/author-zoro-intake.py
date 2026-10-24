"""Observed reference measurements for the official img2threejs character run.

This authors intake evidence, not geometry. All pixel coordinates are read from
the admitted 697 x 1050 public mirror; depth is explicitly unobserved.
"""
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / '.img2threejs/cast/zoro'
gate=subprocess.run(['python3','forge/next.py','--state','../../.img2threejs/cast/zoro/state.json'],cwd=ROOT/'.tools/img2threejs')
if gate.returncode:raise SystemExit(gate.returncode)

def write(name, value):
    (OUT / name).write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n')

payload = json.loads((OUT / 'anatomy.json').read_text())
a = payload['anatomy']
a.update(applies=True, styleHeads=8.57, confidence=0.85,
    source='agent-measured-admitted-image', evidenceRef='full-object')
a['proportions'] = dict(headUnit=116/1050, torso=285/116,
    legs=575/116, shoulderWidth=201/116, hipWidth=194/116)
a['faceLandmarks'] = dict(hairline=0.24, eyeLine=67/116,
    eyeSpacing=0.22, noseBase=87/116, mouthLine=96/116,
    earTop=0.48, earBottom=0.77)
a['pose']['type'] = 'contrapposto; raised right elbow and hand holding sword at shoulder; left arm down'
a['pose']['jointAngles'].update(rightShoulder=[0,0,-125], rightElbow=[0,0,137],
    leftShoulder=[0,0,12], leftElbow=[0,0,-7], rightHip=[0,0,-4], leftHip=[0,0,4])
a['features'] = ['closed anatomical left eye with vertical scar',
    'narrow open right eye, clenched teeth grin', 'three earrings on anatomical left ear',
    'short green crown with irregular tapered tips']
a['measurementEvidence'] = {
    'imageSize': [697,1050], 'crown':[264,44], 'chin':[274,160],
    'neckBase':[270,175], 'hip':[284,460], 'floorY':1035,
    'headBounds':[217,44,309,160], 'rightEye':[250,110], 'leftEye':[285,112],
    'shoulderRight':[159,188], 'elbowRight':[91,233], 'wristRight':[152,116],
    'shoulderLeft':[347,190], 'elbowLeft':[386,353], 'wristLeft':[421,501],
    'rightKnee':[191,758], 'leftKnee':[354,762],
    'rightAnkle':[175,943], 'leftAnkle':[377,945],
    'units':'source pixels; joint centres estimated under loose cloth',
    'torsoDefinition':'neck-base to hip; crown-to-hip is 3.59 HU, not the spine segment length',
    'depth': {'method':'inference only', 'confidence':0.4,
        'note':'No profile/back reference. Preserve volume and validate meaningful orbits; do not claim measured depth.'}}
write('anatomy.json', payload)

observed = [
    ('hair-tips','contour','hair','Irregular short green triangular crown tips',[.31,.04,.16,.06]),
    ('left-eye-scar','linework','scar','Closed left eye crossed by a vertical scar',[.41,.085,.025,.055]),
    ('grin','contour','teeth','Broad clenched white teeth with curved lower lip',[.355,.122,.087,.026]),
    ('earrings','gloss','earrings','Three parallel gold drops on left ear',[.437,.113,.025,.038]),
    ('chest-scar','linework','chest-scar','Diagonal healed scar across bare upper chest',[.35,.19,.12,.087]),
    ('haramaki-ribs','seam','haramaki','Vertical ribs in bright green waist wrap',[.34,.27,.14,.105]),
    ('sash-folds','ridge','sash','Layered purple wrap with strong horizontal creases',[.22,.367,.35,.095]),
    ('sash-tails','contour','sash-tail','Two long purple fabric tails on left hip',[.49,.36,.105,.28]),
    ('robe-toggles','fastener','robe-toggles','Four tan double-lobed toggles down robe front',[.25,.49,.09,.21]),
    ('armband','seam','armband','Black band tied on anatomical left upper arm',[.52,.27,.13,.075]),
    ('sword-guards','bevel','sword-guards','Gold multi-lobed guards at three hilts',[.16,.31,.57,.28]),
    ('sword-wrap','linework','sword-wrap','Alternating diamonds on dark and white sword grips',[.10,.025,.23,.34]),
    ('blade-edge','gloss','blade','Curved steel blade with thin pale cutting edge',[.62,.55,.38,.405]),
    ('robe-hem','contour','robe','Scalloped lower hem and long folded green skirt',[.15,.73,.47,.11]),
    ('boot-toes','contour','boots','Pointed dark boots angled outward from ankles',[.10,.86,.63,.14]),
]
details=[]
for ident,kind,component,description,box in observed:
    details.append(dict(id=ident,kind=kind,description=description,
        region=dict(zip(['x','y','width','height'],box),units='normalized'),
        scale='object-relative',affects=['silhouette' if kind=='contour' else 'surface'],
        mapsTo={'type':'component','ref':component},evidenceRef='full-object',confidence=.9,
        realization='geometry' if kind in ('contour','ridge','bevel','fastener') else 'reference-projection'))
inventory=dict(scanMethod='grid-3x3',targetMinDetails=10,details=details)
d=json.loads((OUT/'di.json').read_text());d['detailInventory']=inventory;write('di.json',d)
p=json.loads((OUT/'assessment.json').read_text());s=p['preSpecAssessment']
s['objectClass'].update(primaryType='full-body anime swordsman',primaryDomain='character',
    formLanguage=['organic','fabric-like','hard-surface'],
    structureKind=['continuous body','layered cloth shells','rigid sword assemblies'],
    motionPotential=['static orbitable sculpture','clickable detachable accessory groups'],
    materialFamilies=['skin-like','short hair','woven cloth','steel','gold','leather'],
    notes='Preserve the supplied adult long-limbed anime proportions, not a chibi template.')
s['complexity']['scores'].update(silhouetteComplexity=3,componentCount=3,hierarchyDepth=3,
    repetitionDensity=2,materialLayerCount=3,localDetailDensity=3,occlusionRisk=2,actionReadinessNeed=2)
s['complexity']['estimatedCounts'].update(macroComponents=8,mesoComponents=22,
    microFeatureGroups=15,materialLayers=9,repetitionSystems=3)
s['complexity']['reasoning']=['Raised bent arm interrupts silhouette; three differently placed swords.',
    'Open robe, ribbed wrap, layered sash and asymmetrical long tails.',
    'Face identity depends on closed left eye, scar, teeth, short green hair and earrings.']
s['specDepthDecision']['rationale']='Character silhouette, nested layered garments and repeated fittings require complex depth.'
s['anatomy']=a;s['detailInventory']=inventory
p['qualityContract']['definitionOfDone']=[
    'Full-height pose matches the raised right hand and low left hand; long-limbed 8.57 HU proportions remain recognizable.',
    'Green open robe, purple sash/tails, ribbed haramaki and three separate swords match the admitted reference.',
    'Closed left eye/scar, grin, three earrings and short green scalp silhouette survive a head close-up.',
    'Front, +/-35, side, rear-three-quarter, rear and both head views show continuous volumes and attached accessories.',
    'Unobserved side/back are explicitly inferred. No source mesh, Blender model or GLB geometry enters the factory.']
p['qualityContract']['minimumSpecDepth']['reviewViewpoints']=8
write('assessment.json',p)
write('contracts-read.json',{'reader':'agent','contracts':[
    'grimoire/character/reconstruction.md','grimoire/character/likeness_maximization.md',
    'grimoire/character/structure_decomposition.md','grimoire/character/head_construction.md',
    'grimoire/character/stylized_hair_threejs.md','grimoire/character/threejs_hair_parameter_contract.json',
    'grimoire/intake/surface_topology.md','grimoire/intake/detail_inventory.md',
    'grimoire/intake/quality_contract.md','grimoire/intake/local_spec_search.md'],
    'interpretation':'Head construction numeric example is an imp, not human canon. Use Zoro source pixels.'})
print('Zoro intake authored from admitted image; geometry and visual acceptance remain pending.')
