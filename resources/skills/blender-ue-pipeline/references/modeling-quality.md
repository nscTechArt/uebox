# Blender modeling quality

## Contents

- [Understand the subject](#understand-the-subject-before-editing)
- [Native Blender modeling](#build-with-blenders-native-strengths)
- [Capture and correction](#capture-inspect-correct)
- [Trigger and failure examples](#trigger-and-failure-examples)

Method adapted from img2threejs 1.5.1: `image_analysis`, `quality_contract`, `detail_inventory`,
`surface_topology`, and `self_correction`. This is an independent Blender workflow; it does not
run that skill's Three.js generator or require its personal installation on another user's machine.

## Understand the subject before editing

Inspect the actual reference image. Separate visible observations, user requirements, and inferred
hidden geometry. Record proportions and object-space front/back, major masses, part relationships,
openings, seams, repeated features and material families. A photo's brightness is not its albedo.
Camera perspective must not become a permanent distortion in the mesh. Single-view depth and
absolute dimensions are uncertain unless supplied or measured; record assumptions explicitly.

For each important feature, name the implementing part/modifier/material and how to check it.
A handle must have thickness, an opening and contact with its body; a painted dark patch cannot
stand in for a hole. Scan by components or image regions so interior features are not overlooked.
Use as many subject-specific details as are actually visible; do not add meaningless rivets or
invent a fixed detail count to qualify a simple object as high quality.

Write `quality-plan.json` using the linked template. Copy reference images into the exchange,
then record their relative paths and SHA-256 hashes in `references`. Keep `observations` and
`unknowns` with the plan. All evidence stays copyable alongside the project's source art.
Declare a triangle budget, minimum UV layers, and whether openings are intentional (`surface`).
Each feature has an id, observable acceptance description, construction method, and basis
(`observed`, `inferred`, `requested`). Mark identity-defining requirements `critical: true`.

## Build with Blender's native strengths

| Visible form | Blender approach | Check before detailing |
|---|---|---|
| Rigid assembled panels | Editable mesh, bevel, mirror, array | Relative thickness, edge profile, seams |
| Continuous curved body | Profile extrusion/revolve, subdivision or sculpt | Continuous volume, clean curvature, no primitive-stack seams |
| Thin fitted shell | Surface modeling and solidify | Real thickness, offset from the underlying form |
| Cable, pipe or handle | Curve with bevel/sweep, then suitable mesh conversion | Cross-section, bend radius and attachment points |
| Repeated fasteners/modules | Array or geometry nodes on named construction parts | Spacing, orientation, contact, no floating repetitions |
| Fine surface relief | Geometry when it changes visible shape; otherwise normal/bump | Intended viewing distance, UVs, material-slot compatibility |

Use reflection/Mirror for handed pairs, then inspect normals and the subject's own left/right;
rotating a part is not mirroring it. Use Blender's coordinate frame, not Three.js axis constants.

Save editable construction stages. Preserve source parts in hidden, untagged construction
collections when needed; consolidate evaluated delivery geometry into the single tagged mesh
required by this exchange. Joined delivery geometry does not imply every construction part must
be destructively fused while modeling. Retain the original numbered UE material slots.

Review in order: (1) blockout/proportions/silhouette, (2) structure/cross-sections/attachment,
(3) identity details, (4) materials/UVs/shading, (5) optimization and UE delivery. At each stage
save a checkpoint and an image-backed note under `quality/`. Correct the earliest failed stage.
Subdivision or extra polygons cannot repair wrong proportions; lighting cannot hide a missing part.

## Capture, inspect, correct

After saving and exporting, run in a fresh process using discovered absolute paths:

```powershell
& $blenderExe --background --factory-startup --disable-autoexec --python-exit-code 1 --python $captureScript -- $exchangeDirectory
```

The capture helper renders the actual exported FBX into orthographic clay views and records camera
metadata in `quality-captures.json`. Render-only modifiers cannot improve the review beyond delivery geometry.
Its angles are around Blender Z, with azimuth 0 looking from -Y; set them for the subject's front.
It does not save the temporary camera, lighting or material override into `work.blend`.
Inspect all five views, not just the most flattering one. Add close-ups for small identity details.
Photo work also needs a `reference` view and an actual reference/render comparison. The standard
orthographic helper alone does not solve a perspective photo camera: capture an additional matched
perspective view through Blender when necessary, preserving its camera and file-hash evidence.
Unseen rear views check structural plausibility, not fidelity to nonexistent reference data.

Look for holes, thickness collapse, incorrect handedness, intersections, loose attachments,
pinched normals and misplaced details. Record contact measurements for important attachments.
The topology counters catch open/non-manifold/loose edges and zero-area faces; they do not prove
correct normals, absence of self-intersections, correct assembly, silhouette fidelity or likeness.
Clay renders do not prove material quality. Check actual UE material response, UV seams and lightmaps
separately; the current pipe preserves UE materials and does not convert new Blender shader graphs.
Photo projection, if explicitly needed, requires de-lighting and coverage checks; baking a photo's
shadows into base color is not a replacement for geometry or PBR material work.

After actually viewing the captures, write `quality-review.json` with:

- `plan_sha256`, `export_sha256`, `blend_sha256` copied from the current capture manifest;
- `captures_sha256`, the SHA-256 of that manifest;
- `features`, keyed by every plan feature id, each containing `status` (`pass`, `fail`,
  `unverified`), a concrete `observation`, and a list of inspected view ids in `views`;
- `decision: "pass"` only when every required feature passes. No automatic visual scores.

Run `python quality_review.py ABSOLUTE_EXCHANGE_DIRECTORY`. Missing evidence, changed source/FBX,
failed features, open boundaries on an intended solid, missing UVs or excess triangles block return.
Changing the plan requires re-export and fresh review. Changing captures requires re-inspection.
For a mismatch, correct camera, specification, geometry or material according to the actual cause;
change one defect group and recapture. If the same defect persists for three attempts, diagnose the
representation or missing input before another attempt; report the remaining gap without lowering
the requirement silently. A passing file check is not a percentage of photorealistic likeness.

## Trigger and failure examples

- “按这张图完善这个建筑门框，保留 UE 尺寸” → analyze profile, opening, molding, joints and uncertainty.
- “把这个道具倒角做好一点” → a small plan for thickness, corner continuity and shading is sufficient.
- “正面像了，背面还是空的” → fail structure; inspect rear and oblique views before materials.
- “把模型送回去，不再修改” → existing transport can run; do not invent a visual-quality certification.
- “用悟空这张海报做可动画的同等品质角色” → outside this static-prop pipe; identify anatomy, hair,
  armor, missing back views and rigging needs. Do not substitute a beveled prop or claim AAA parity.
