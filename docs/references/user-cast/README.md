# Original user references for img2threejs

Awaiting the original five images shown inline in chat on 2026-10-24. Inline previews are visible to the agent but their image bytes were not made available to filesystem tools. This folder deliberately contains no replacement, generated reference or screenshot masquerading as an original.

Expected names: `zoro.png`, `nezuko.png`, `eren.png`, `tanjiro.png`, `mikasa.png`.

PNG/JPG originals or a ZIP are suitable. Keep original bytes; if the input is JPEG, use `.jpg` and update `expectedReference` in `docs/model-reviews/img2threejs-cast/request.json`. Eren's current reference is a portrait; a full-body target needs an additional full-body reference. Nezuko's legs/feet are also cropped and must not be described as measured.

Run `npm run skill:cast:admit` after placing the files. Acceptance, source hash, metadata, camera, landmarks, silhouette and visual fidelity remain separate checks; file presence alone cannot pass them.
