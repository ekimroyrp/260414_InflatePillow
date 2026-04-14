# 260414_InflatePillow

`260414_InflatePillow` is an interactive Three.js prototype for drawing stitched floor outlines and inflating them into two-sided pillow forms. The app lets you sketch multiple seams directly on the ground plane, adjust corners before inflation, select a closed outline to add internal chamber seams, round outer and inner stitched paths with separate curvature controls, and then drive a custom paired-sheet solver with a pressure control to inflate every closed outline together through a compact floating control panel.

## Features

- Click-to-place seam drawing on a ground grid
- Multiple closed outlines can be authored before inflation
- Selectable closed outlines with internal chamber seam drawing
- Outer Seam Curvature slider that rounds and subdivides the stitched outline used for inflation
- Inner Seam Curvature slider that rounds and subdivides chamber seams independently
- Vertex handle editing before inflation
- Closed-outline validation with self-intersection rejection
- Pressure-driven pillow inflation and deflation across all closed seams
- Adaptive, more uniform pillow triangulation
- Custom paired-sheet mass-spring simulation with rounded inflation profiling
- Toggleable mesh wire overlay for previewing the triangle layout
- Toggleable Foil Material mode with reflective balloon shading and shared iridescence across foil and matte looks
- DifferentialLayers-style floating control panel with Start/Pause, Pressure, and seam controls
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
- `Enter` while drawing an outer outline: auto-close the current outline
- `Left Click on Ground After Closing`: start another outline
- `Left Click on Closed Outline`: select it for chamber seam authoring
- `Left Click Inside Selected Outline`: add a chamber seam point
- `Left Click on First Chamber Point`: close the current chamber seam into a loop
- `Left Click Near Outer or Existing Chamber Seam`: finish the current chamber seam open
- `Enter` while drawing a chamber seam: end the current chamber seam open
- `Left Drag on Handle`: move an existing corner before inflation
- `Undo`: remove the last unclosed point
- `Start`: build pillow meshes for every closed outline and start pumping toward the slider target
- `Pause`: pause the running inflation state
- `Outer Seam Curvature`: round and subdivide the outer seam path used for preview and inflation
- `Inner Seam Curvature`: round and subdivide chamber seam paths used for preview and inflation
- `Pressure Slider`: raise or lower the inflation target
- `Mesh Wires`: show or hide the triangle wire overlay
- `Foil Material`: toggle between reflective foil shading and the softer matte look
- `Reset`: return to the editable flat outlines, or clear all drafts if no pillow exists
- `Right Drag`: orbit the camera
- `Middle Drag`: pan the camera
- `Mouse Wheel`: zoom
