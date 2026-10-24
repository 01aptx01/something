# Anatomical foundation

`base.obj` is the MakeHuman hm08 base mesh. Its header explicitly releases this asset under CC0 in September 2020 and identifies Data Collection AB, Joel Palmius and Jonas Hauquier as the copyright holders at release.

- Source: https://github.com/makehumancommunity/makehuman/blob/master/makehuman/data/3dobjs/base.obj
- Downloaded: 2026-10-23 UTC
- SHA-256: `8e761e6624b8f54536409135d1636da63b32486a90d4897f84e121d144f6fb4c`
- License text: [CC0-1.0.txt](CC0-1.0.txt)
- Upstream license overview: [MAKEHUMAN-LICENSE.md](MAKEHUMAN-LICENSE.md)

The MakeHuman program is not bundled. Only the CC0 mesh and its asset license are included. Hidden helper, genital, joint and proxy groups are excluded from exported sculptures.

`../build-characters.py` deforms the anatomy and models original hair, clothes, eyes, textile patterns, swords, harnesses and equipment in Blender. The output is six self-contained GLBs in `public/models`. Character designs remain fan interpretations of the respective original works; CC0 applies to the anatomical base, not to those character designs.

Rebuild with Blender 4.3+: `npm run models:build`. To rebuild one character: `blender -b --python scripts/build-characters.py -- tanjiro`. The checked-in GLBs are enough to run/build the web app; Blender is only required to regenerate assets.
