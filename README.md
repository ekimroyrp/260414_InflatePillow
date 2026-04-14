# 260414_InflatePillow

`260414_InflatePillow` is an interactive Three.js prototype for drawing a stitched floor outline and inflating it into a two-sided pillow form. The app lets you sketch a seam directly on the ground plane, adjust the corners before locking the outline, and then drive a custom paired-sheet solver with a pressure control to create a soft inflated result.

## Features

- Click-to-place seam drawing on a ground grid
- Vertex handle editing before inflation
- Closed-outline validation with self-intersection rejection
- Pressure-driven pillow inflation and deflation
- Adaptive, more uniform pillow triangulation
- Custom paired-sheet mass-spring simulation with rounded inflation profiling
- Toggleable mesh wire overlay for previewing the triangle layout
- Desktop-focused Three.js viewport with orbit, pan, and below-ground inspection

## Getting Started

```bash
npm install
npm run dev
```

To create a production build:

```bash
npm run build
```

## Controls

- `Left Click`: add a seam corner
- `Left Drag on Handle`: move an existing corner before inflation
- `Undo`: remove the last unclosed point
- `Close Shape`: stitch the current outline into a valid seam
- `Inflate`: build the pillow mesh and pump toward the slider target
- `Pressure Slider`: raise or lower the inflation target
- `Mesh Wires`: show or hide the triangle wire overlay
- `Reset`: return to the editable flat outline, or clear the draft if no pillow exists
- `Right Drag`: orbit the camera
- `Middle Drag`: pan the camera
- `Mouse Wheel`: zoom
