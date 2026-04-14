# 260414_InflatePillow

`260414_InflatePillow` is an interactive Three.js prototype for drawing stitched floor outlines and inflating them into two-sided pillow forms. The app lets you sketch multiple seams directly on the ground plane, adjust corners before inflation, select a closed outline to add internal chamber seams, and then drive a custom paired-sheet solver with a pressure control to inflate every closed outline together.

## Features

- Click-to-place seam drawing on a ground grid
- Multiple closed outlines can be authored before inflation
- Selectable closed outlines with internal chamber seam drawing
- Vertex handle editing before inflation
- Closed-outline validation with self-intersection rejection
- Pressure-driven pillow inflation and deflation across all closed seams
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
- `Left Click on First Point`: close the current outline when at least three corners exist
- `Left Click on Ground After Closing`: start another outline
- `Left Click on Closed Outline`: select it for chamber seam authoring
- `Left Click Inside Selected Outline`: add a chamber seam point
- `Left Click Near Outer or Existing Chamber Seam`: finish the current chamber seam
- `Left Drag on Handle`: move an existing corner before inflation
- `Undo`: remove the last unclosed point
- `Inflate`: build pillow meshes for every closed outline and pump toward the slider target
- `Pressure Slider`: raise or lower the inflation target
- `Mesh Wires`: show or hide the triangle wire overlay
- `Reset`: return to the editable flat outlines, or clear all drafts if no pillow exists
- `Right Drag`: orbit the camera
- `Middle Drag`: pan the camera
- `Mouse Wheel`: zoom
