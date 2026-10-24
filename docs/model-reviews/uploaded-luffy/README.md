# Uploaded Luffy asset review — 24 October 2026

This is a read-only review of the user-uploaded `luffy.glb`. The application's models and source code have not been changed.

## Verified from the file and a local Three.js render

- GLB 2.0, 5,013,272 bytes; SHA-256 `70c9516935eca0065f22da082e46405150225215eeb617d2e6ad394d714c85c4`.
- 48,964 triangles, 32,388 vertices including seams, 20 mesh primitives, 19 materials.
- Nine embedded images; largest is 2048×1024. No external image/buffer URI or required compression extension.
- One skin with 452 joints; one animation named `blink` lasting about 0.417 seconds. No walking or combat animation in the file.
- Default pose is a T-pose. Front, side, back and face renders complete without JavaScript runtime exceptions using Three.js 0.180.
- Bind-pose bounds are approximately 1.680 × 1.787 × 0.392 model units. Units are not assumed to be metres.
- The current application's hardcoded full-body and face framing should be replaced with model-specific bounds and head landmarks before adopting external models.

## Provenance embedded in asset.extras (metadata, not an independent license verification)

- Title: Luffy
- Author: ᗰOᑎKEY ᗪ. ᒪᑌᖴᖴY — https://sketchfab.com/KingOfThePirates
- Source: https://sketchfab.com/3d-models/luffy-338ea5a381a34210b13d89cfe049c410
- License string: SKETCHFAB Standard — https://sketchfab.com/licenses

This source differs from the earlier linked Luffy model URL. This file does not identify itself as CC0 or CC BY; free availability and redistribution terms have not been independently verified because the source websites return a network-proxy 403 in this environment.

## Recommended implementation

1. Use this finished anime-character asset as the visual benchmark; preserve character-specific silhouette, face, hair, costume and painted textures.
2. Prepare a relaxed presentation pose from the supplied rig, preserving an untouched original file and the original rig/animation. Validate shoulder/elbow deformation before baking or optimizing. Schedule the blink clip as an occasional blink; a continuous 0.417-second loop would look unnatural. Respect reduced motion.
3. Separate source assets, optimized web assets and asset manifests. Record per-character author/source/license, dimensions, orientation, head target and supported animations. Treat the remaining five characters as missing replacement assets until suitable free candidates are actually obtained and reviewed.
4. Normalize orientation and scale once per model; compute full-body framing from its bounds and use a per-character head target for face views. Preserve the authored color style and tune neutral studio lighting before applying shared material changes.
5. Separate world presentation from character-gallery presentation. Clicking a painted character should open that character directly in 3D and closing should restore the original painted scene, pan, zoom and focus.
6. Author character hit regions in source-image coordinates for each of the nine scenes. Reproject with crop/pan/zoom, support tap and keyboard, and suppress activation after dragging/pinching. Only characters actually present in an image should have a region. Keep a named character list for off-screen or occluded characters.
7. Validate six-character selection, all scene regions, 320px/mobile/landscape, pose deformation, blink/reduced motion, load failure/retry, rapid selection, view restoration and disposal of skinned geometry/textures/animation mixers. Capture real before/after screenshots.

## Review images

- [Front](luffy-front.png)
- [Side](luffy-side.png)
- [Back](luffy-back.png)
- [Face](luffy-face.png)
- [Blink sample](luffy-blink.png)
