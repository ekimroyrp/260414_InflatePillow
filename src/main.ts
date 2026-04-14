import './style.css'

import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

import {
  buildShape,
  cloneOutlinePoints,
  createEditableOutline,
  type EditableOutline,
  validateOutline,
} from './geometry'
import { buildPillowFromOutline, type PillowSimulation } from './pillowSimulation'

document.title = '260414_InflatePillow'

const app = document.querySelector<HTMLDivElement>('#app') ?? (() => {
  throw new Error('App root was not found.')
})()

app.innerHTML = `
  <div class="app-shell">
    <canvas class="viewport" aria-label="Inflate pillow viewport"></canvas>
    <section class="hud brand-panel">
      <p class="eyebrow">Three.js seam inflator</p>
      <h1>260414_InflatePillow</h1>
      <p class="lede">Draw a stitched outline on the floor, refine the corners, then pump a two-sided pillow between the seams.</p>
    </section>
    <section class="hud control-panel">
      <div class="control-grid">
        <button id="undoButton" type="button">Undo</button>
        <button id="closeButton" type="button">Close Shape</button>
        <button id="resetButton" type="button">Reset</button>
        <button id="inflateButton" type="button">Inflate</button>
      </div>
      <label class="slider-block" for="pressureSlider">
        <span>Pressure</span>
        <span id="pressureValue">0.42</span>
      </label>
      <input id="pressureSlider" type="range" min="0" max="1" value="0.42" step="0.01" />
      <label class="toggle-row" for="wireToggle">
        <span>Mesh Wires</span>
        <input id="wireToggle" type="checkbox" checked />
      </label>
      <p id="statusText" class="status-text"></p>
      <p class="hint-text">Left click adds corners. Drag handles before inflation to reshape. Right mouse drag orbits the camera. Middle mouse drag pans.</p>
    </section>
  </div>
`

function requireElement<T extends Element>(selector: string): T {
  const element = app.querySelector<T>(selector)
  if (!element) {
    throw new Error(`Missing UI element: ${selector}`)
  }

  return element
}

const canvas = requireElement<HTMLCanvasElement>('.viewport')
const undoButton = requireElement<HTMLButtonElement>('#undoButton')
const closeButton = requireElement<HTMLButtonElement>('#closeButton')
const resetButton = requireElement<HTMLButtonElement>('#resetButton')
const inflateButton = requireElement<HTMLButtonElement>('#inflateButton')
const pressureSlider = requireElement<HTMLInputElement>('#pressureSlider')
const pressureValue = requireElement<HTMLSpanElement>('#pressureValue')
const wireToggle = requireElement<HTMLInputElement>('#wireToggle')
const statusText = requireElement<HTMLParagraphElement>('#statusText')

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
})
renderer.outputColorSpace = THREE.SRGBColorSpace
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap

const scene = new THREE.Scene()
scene.background = new THREE.Color(0xe6edf3)

const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200)
camera.position.set(8.5, 7.2, 8.5)

const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true
controls.target.set(0, 0.3, 0)
controls.minDistance = 3
controls.maxDistance = 30
controls.maxPolarAngle = Math.PI - 0.01
controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE
controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN
controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE
controls.enabled = true

const ambientLight = new THREE.HemisphereLight(0xf9fbff, 0x8b96a4, 1.2)
scene.add(ambientLight)

const keyLight = new THREE.DirectionalLight(0xffffff, 1.5)
keyLight.position.set(6, 11, 4)
keyLight.castShadow = true
keyLight.shadow.mapSize.set(2048, 2048)
keyLight.shadow.camera.near = 0.5
keyLight.shadow.camera.far = 40
keyLight.shadow.camera.left = -12
keyLight.shadow.camera.right = 12
keyLight.shadow.camera.top = 12
keyLight.shadow.camera.bottom = -12
scene.add(keyLight)

const fillLight = new THREE.DirectionalLight(0xd7ebff, 0.55)
fillLight.position.set(-9, 6, -8)
scene.add(fillLight)

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(40, 40),
  new THREE.ShadowMaterial({ color: 0x718096, opacity: 0.12 }),
)
ground.rotation.x = -Math.PI / 2
ground.receiveShadow = true
scene.add(ground)

const gridHelper = new THREE.GridHelper(40, 40, 0x8ea4b7, 0xc7d3de)
gridHelper.position.y = 0.002
scene.add(gridHelper)

const seamLine = new THREE.Line(
  new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ color: 0xf3f7fb }),
)
seamLine.position.y = 0.025
scene.add(seamLine)

const previewMaterial = new THREE.MeshStandardMaterial({
  color: 0x8ecae6,
  transparent: true,
  opacity: 0.32,
  roughness: 0.95,
  metalness: 0.03,
  side: THREE.DoubleSide,
})
let previewMesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> | null = null
let showWireframe = wireToggle.checked

const handleGeometry = new THREE.CylinderGeometry(0.11, 0.11, 0.08, 20)
const handleGroup = new THREE.Group()
scene.add(handleGroup)

const raycaster = new THREE.Raycaster()
const drawPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
const pointer = new THREE.Vector2()
const hitPoint = new THREE.Vector3()
const clock = new THREE.Clock()

let nextPointId = 1
let outline: EditableOutline = createEditableOutline()
let pillowSimulation: PillowSimulation | null = null
let hasActivatedInflation = false
let draggingVertexId: number | null = null
let pendingGroundClick:
  | {
      pointerId: number
      clientX: number
      clientY: number
      point: THREE.Vector3
    }
  | null = null

const CLICK_DRAG_THRESHOLD = 6

function makeHandleMaterial(color: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.35,
    metalness: 0.02,
  })
}

function getPressureValue(): number {
  return Number.parseFloat(pressureSlider.value)
}

function refreshOutlineState(): void {
  const validation = validateOutline(outline.points, outline.closed)
  outline.valid = validation.valid
  outline.error = validation.error
  pressureValue.textContent = getPressureValue().toFixed(2)

  statusText.textContent = pillowSimulation && hasActivatedInflation
    ? `Pumping toward ${getPressureValue().toFixed(2)} pressure. Lower the slider to deflate, or reset to edit the seam again.`
    : outline.error

  undoButton.disabled = outline.closed || outline.points.length === 0 || pillowSimulation !== null
  closeButton.disabled = outline.closed || !validation.valid || pillowSimulation !== null
  inflateButton.disabled = !outline.closed || !validation.valid
  resetButton.disabled = outline.points.length === 0 && pillowSimulation === null
}

function clearPreviewMesh(): void {
  if (!previewMesh) {
    return
  }

  for (const child of previewMesh.children) {
    if (child instanceof THREE.Mesh) {
      ;(child.material as THREE.Material).dispose()
    }
  }

  scene.remove(previewMesh)
  previewMesh.geometry.dispose()
  previewMesh = null
}

function rebuildPreviewMesh(): void {
  clearPreviewMesh()

  if (!outline.closed || !outline.valid) {
    return
  }

  const shape = buildShape(outline.points)
  if (!shape) {
    return
  }

  const geometry = new THREE.ShapeGeometry(shape)
  previewMesh = new THREE.Mesh(geometry, previewMaterial)
  previewMesh.rotation.x = Math.PI / 2
  previewMesh.position.y = 0.01
  previewMesh.receiveShadow = true
  const previewWireOverlay = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({
      color: 0x37506c,
      wireframe: true,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
    }),
  )
  previewWireOverlay.visible = showWireframe
  previewWireOverlay.renderOrder = 2
  previewMesh.add(previewWireOverlay)
  scene.add(previewMesh)
}

function rebuildSeamLine(): void {
  const positions: number[] = []
  for (const point of outline.points) {
    positions.push(point.position.x, 0, point.position.y)
  }

  if (outline.closed && outline.points.length > 0) {
    const first = outline.points[0]
    positions.push(first.position.x, 0, first.position.y)
  }

  const geometry = new THREE.BufferGeometry()
  if (positions.length > 0) {
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  }

  seamLine.geometry.dispose()
  seamLine.geometry = geometry
  seamLine.visible = positions.length >= 6
}

function rebuildHandles(): void {
  for (const child of [...handleGroup.children]) {
    const mesh = child as THREE.Mesh
    mesh.geometry.dispose()
    ;(mesh.material as THREE.Material).dispose()
    handleGroup.remove(child)
  }

  if (pillowSimulation) {
    return
  }

  for (const point of outline.points) {
    const isSelected = outline.selectedVertexId === point.id
    const isHovered = outline.hoveredVertexId === point.id
    const material = makeHandleMaterial(isSelected ? 0xffca76 : isHovered ? 0xfef3c7 : 0x14213d)
    const handle = new THREE.Mesh(handleGeometry.clone(), material)
    handle.position.set(point.position.x, 0.06, point.position.y)
    handle.userData.pointId = point.id
    handle.castShadow = true
    handle.receiveShadow = true
    handleGroup.add(handle)
  }
}

function syncOutlineVisuals(): void {
  rebuildSeamLine()
  rebuildPreviewMesh()
  rebuildHandles()
  refreshOutlineState()
}

function disposeSimulation(): void {
  if (!pillowSimulation) {
    return
  }

  scene.remove(pillowSimulation.mesh)
  pillowSimulation.dispose()
  pillowSimulation = null
}

function resetToEditableClosedOutline(): void {
  disposeSimulation()
  hasActivatedInflation = false
  outline.selectedVertexId = null
  outline.hoveredVertexId = null
  syncOutlineVisuals()
}

function addPoint(position: THREE.Vector3): void {
  outline.points.push({
    id: nextPointId,
    position: new THREE.Vector2(position.x, position.z),
  })
  nextPointId += 1
  syncOutlineVisuals()
}

function updatePoint(pointId: number, position: THREE.Vector3): void {
  const point = outline.points.find((candidate) => candidate.id === pointId)
  if (!point) {
    return
  }

  point.position.set(position.x, position.z)
  syncOutlineVisuals()
}

function updatePointer(clientX: number, clientY: number): void {
  const rect = renderer.domElement.getBoundingClientRect()
  pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1
  pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1
}

function pickHandle(clientX: number, clientY: number): THREE.Intersection<THREE.Object3D> | null {
  updatePointer(clientX, clientY)
  raycaster.setFromCamera(pointer, camera)
  const intersections = raycaster.intersectObjects(handleGroup.children, false)
  return intersections[0] ?? null
}

function getGroundIntersection(clientX: number, clientY: number): THREE.Vector3 | null {
  updatePointer(clientX, clientY)
  raycaster.setFromCamera(pointer, camera)
  const point = raycaster.ray.intersectPlane(drawPlane, hitPoint)
  return point ? point.clone() : null
}

function closeOutline(): void {
  if (outline.closed || !outline.valid) {
    return
  }

  outline.closed = true
  syncOutlineVisuals()
}

function inflateOutline(): void {
  if (!outline.closed || !outline.valid) {
    return
  }

  if (!pillowSimulation) {
    pillowSimulation = buildPillowFromOutline(cloneOutlinePoints(outline.points))
    pillowSimulation.setWireframeVisible(showWireframe)
    scene.add(pillowSimulation.mesh)
    clearPreviewMesh()
  }

  hasActivatedInflation = true
  pillowSimulation.update(0, getPressureValue())
  rebuildHandles()
  refreshOutlineState()
}

function handleReset(): void {
  if (pillowSimulation) {
    resetToEditableClosedOutline()
    return
  }

  outline = createEditableOutline()
  nextPointId = 1
  syncOutlineVisuals()
}

undoButton.addEventListener('click', () => {
  if (outline.closed || pillowSimulation || outline.points.length === 0) {
    return
  }

  outline.points.pop()
  syncOutlineVisuals()
})

closeButton.addEventListener('click', closeOutline)
inflateButton.addEventListener('click', inflateOutline)
resetButton.addEventListener('click', handleReset)

pressureSlider.addEventListener('input', () => {
  pressureValue.textContent = getPressureValue().toFixed(2)
  refreshOutlineState()
})

wireToggle.addEventListener('change', () => {
  showWireframe = wireToggle.checked

  if (previewMesh) {
    const previewWireOverlay = previewMesh.children[0]
    if (previewWireOverlay) {
      previewWireOverlay.visible = showWireframe
    }
  }

  pillowSimulation?.setWireframeVisible(showWireframe)
})

renderer.domElement.addEventListener('contextmenu', (event) => {
  event.preventDefault()
})

renderer.domElement.addEventListener(
  'pointerdown',
  (event: PointerEvent) => {
    if (event.button === 1 || event.button === 2) {
      controls.enabled = true
      pendingGroundClick = null
      return
    }

    controls.enabled = false

    if (event.button !== 0) {
      pendingGroundClick = null
      return
    }

    if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
      pendingGroundClick = null
      return
    }

    const handleHit = !pillowSimulation ? pickHandle(event.clientX, event.clientY) : null
    if (handleHit) {
      draggingVertexId = Number(handleHit.object.userData.pointId)
      outline.selectedVertexId = draggingVertexId
      outline.hoveredVertexId = draggingVertexId
      controls.enabled = false
      renderer.domElement.setPointerCapture(event.pointerId)
      rebuildHandles()
      refreshOutlineState()
      pendingGroundClick = null
      event.stopPropagation()
      return
    }

    if (outline.closed || pillowSimulation) {
      pendingGroundClick = null
      return
    }

    const point = getGroundIntersection(event.clientX, event.clientY)
    pendingGroundClick = point
      ? {
          pointerId: event.pointerId,
          clientX: event.clientX,
          clientY: event.clientY,
          point,
        }
      : null
  },
  { capture: true },
)

renderer.domElement.addEventListener('pointermove', (event) => {
  if (draggingVertexId !== null) {
    const point = getGroundIntersection(event.clientX, event.clientY)
    if (!point) {
      return
    }

    updatePoint(draggingVertexId, point)
    return
  }

  if (pendingGroundClick && pendingGroundClick.pointerId === event.pointerId) {
    const dragDistance = Math.hypot(
      event.clientX - pendingGroundClick.clientX,
      event.clientY - pendingGroundClick.clientY,
    )

    if (dragDistance > CLICK_DRAG_THRESHOLD) {
      pendingGroundClick = null
    }
  }

  if (pillowSimulation) {
    return
  }

  const handleHit = pickHandle(event.clientX, event.clientY)
  const hoveredVertexId = handleHit ? Number(handleHit.object.userData.pointId) : null

  if (outline.hoveredVertexId !== hoveredVertexId) {
    outline.hoveredVertexId = hoveredVertexId
    rebuildHandles()
  }
})

renderer.domElement.addEventListener('pointerup', (event) => {
  if (draggingVertexId !== null) {
    renderer.domElement.releasePointerCapture(event.pointerId)
    draggingVertexId = null
    outline.selectedVertexId = null
    controls.enabled = true
    rebuildHandles()
    refreshOutlineState()
    return
  }

  if (pendingGroundClick && pendingGroundClick.pointerId === event.pointerId) {
    const dragDistance = Math.hypot(
      event.clientX - pendingGroundClick.clientX,
      event.clientY - pendingGroundClick.clientY,
    )

    if (dragDistance <= CLICK_DRAG_THRESHOLD && !outline.closed && !pillowSimulation) {
      addPoint(pendingGroundClick.point)
    }
  }

  pendingGroundClick = null
})

renderer.domElement.addEventListener('pointercancel', () => {
  draggingVertexId = null
  outline.selectedVertexId = null
  controls.enabled = true
  pendingGroundClick = null
  rebuildHandles()
  refreshOutlineState()
})

window.addEventListener('resize', onResize)

function onResize(): void {
  const width = window.innerWidth
  const height = window.innerHeight

  camera.aspect = width / height
  camera.updateProjectionMatrix()
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(width, height, false)
}

function animate(): void {
  const deltaTime = clock.getDelta()
  controls.update()

  if (pillowSimulation && hasActivatedInflation) {
    pillowSimulation.update(deltaTime, getPressureValue())
  }

  renderer.render(scene, camera)
}

syncOutlineVisuals()
onResize()
renderer.setAnimationLoop(animate)
