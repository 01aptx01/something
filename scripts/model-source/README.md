# Anatomical foundation

`base.obj` is the MakeHuman hm08 base mesh. Its header explicitly releases this asset under CC0 in September 2020 and identifies Data Collection AB, Joel Palmius and Jonas Hauquier as the copyright holders at release.

- Source: https://github.com/makehumancommunity/makehuman/blob/master/makehuman/data/3dobjs/base.obj
- Downloaded: 2026-10-23 UTC
- SHA-256: `8e761e6624b8f54536409135d1636da63b32486a90d4897f84e121d144f6fb4c`
- License text: [CC0-1.0.txt](CC0-1.0.txt)
- Upstream license overview: [MAKEHUMAN-LICENSE.md](MAKEHUMAN-LICENSE.md)

The MakeHuman program is not bundled. Only the CC0 mesh and its asset license are included. Hidden helper, genital, joint and proxy groups are excluded from exported sculptures.

`../sculpt-anime-cast.py` builds the v2 cast, importing anatomical/mesh helpers from the legacy `../build-characters.py`. It uses the body and hands only; all anime heads, layered hair, painted eyes, garments, textile patterns, swords, harnesses and equipment are original procedural sculpts. It exports a 20-joint presentation skeleton, weighted surfaces, a HeadTarget camera marker and eyelid blink morphs. The output is five v2 GLBs plus the separately supplied Luffy asset in `public/models`. Character designs remain fan interpretations of the respective original works; CC0 applies to the anatomical base, not to those character designs.

The uploaded Luffy is preserved and cannot be overwritten by this generator. Rebuild the five procedural characters with Blender 4.3+: `npm run models:build`. To rebuild one character: `blender -b --python-exit-code 1 --python scripts/sculpt-anime-cast.py -- tanjiro`. The checked-in GLBs are enough to run/build the web app; Blender is only required to regenerate assets.


The current reference-costume revisions use `sculpt-reference-cast.py` (Zoro, Tanjiro, Nezuko, Mikasa) and `sculpt-eren.py` (young cadet Eren), reusing this anatomical toolkit. `npm run models:build` rebuilds these five. The uploaded Luffy and the existing Levi are preserved. See `docs/model-reviews/visual-reference-cast/README.md` for the visual-reference route and limits.
