import './style.css'

import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

import {
  buildShape,
  cloneOutlinePoints,
  createEditableOutline,
  type EditableOutline,
  type OutlinePoint,
  validateOutline,
} from './geometry'
import { buildPillowFromOutline, type PillowSimulation } from './pillowSimulation'

interface OutlineRecord {
  id: number
  outline: EditableOutline
}

interface HandleTarget {
  outlineId: number
  pointId: number
}

interface PendingHandleClick extends HandleTarget {
  pointerId: number
  clientX: number
  clientY: number
  canClose: boolean
}

type VertexFocusKey = 'selectedVertexId' | 'hoveredVertexId'

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
      <p class="lede">Draw stitched outlines on the floor, refine the corners, then pump every closed seam into a two-sided pillow.</p>
    </section>
    <section class="hud control-panel">
      <div class="control-grid">
        <button id="undoButton" type="button">Undo</button>
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
      <p class="hint-text">Left click adds corners. Click the first point to close an outline, then click the ground to start another. Drag handles before inflation to reshape. Inflate pumps every closed outline. Right mouse drag orbits the camera. Middle mouse drag pans.</p>
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
controls.mouseButtons.LEFT = -1 as THREE.MOUSE
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

const seamGroup = new THREE.Group()
seamGroup.position.y = 0.025
scene.add(seamGroup)

const previewGroup = new THREE.Group()
scene.add(previewGroup)

const seamMaterial = new THREE.LineBasicMaterial({ color: 0xf3f7fb })
const previewMaterial = new THREE.MeshStandardMaterial({
  color: 0x8ecae6,
  transparent: true,
  opacity: 0.32,
  roughness: 0.95,
  metalness: 0.03,
  side: THREE.DoubleSide,
})
const previewWireMaterial = new THREE.MeshBasicMaterial({
  color: 0x37506c,
  wireframe: true,
  transparent: true,
  opacity: 0.35,
  depthWrite: false,
})

let showWireframe = wireToggle.checked

const handleGeometry = new THREE.CylinderGeometry(0.11, 0.11, 0.08, 20)
const handleGroup = new THREE.Group()
scene.add(handleGroup)

const raycaster = new THREE.Raycaster()
const drawPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
const pointer = new THREE.Vector2()
const hitPoint = new THREE.Vector3()
const clock = new THREE.Clock()

let nextOutlineId = 1
let nextPointId = 1
let closedOutlineRecords: OutlineRecord[] = []
let activeOutlineRecord = advanceOutlineRecord()
let pillowSimulations: PillowSimulation[] = []
let hasActivatedInflation = false
let draggingHandle: HandleTarget | null = null
let pendingHandleClick: PendingHandleClick | null = null

const CLICK_DRAG_THRESHOLD = 6

function createOutlineRecord(): OutlineRecord {
  return {
    id: nextOutlineId,
    outline: createEditableOutline(),
  }
}

function advanceOutlineRecord(): OutlineRecord {
  const record = createOutlineRecord()
  nextOutlineId += 1
  return record
}

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

function getAllOutlineRecords(): OutlineRecord[] {
  return [...closedOutlineRecords, activeOutlineRecord]
}

function getActiveOutline(): EditableOutline {
  return activeOutlineRecord.outline
}

function findOutlineRecord(outlineId: number): OutlineRecord | null {
  if (activeOutlineRecord.id === outlineId) {
    return activeOutlineRecord
  }

  return closedOutlineRecords.find((record) => record.id === outlineId) ?? null
}

function setVertexFocus(key: VertexFocusKey, target: HandleTarget | null): boolean {
  let changed = false

  for (const record of getAllOutlineRecords()) {
    const nextValue = target && record.id === target.outlineId ? target.pointId : null
    if (record.outline[key] !== nextValue) {
      record.outline[key] = nextValue
      changed = true
    }
  }

  return changed
}

function formatOutlineCount(count: number): string {
  return `${count} closed outline${count === 1 ? '' : 's'}`
}

function formatPillowCount(count: number): string {
  return `${count} pillow${count === 1 ? '' : 's'}`
}

function refreshOutlineState(): void {
  for (const record of getAllOutlineRecords()) {
    const validation = validateOutline(record.outline.points, record.outline.closed)
    record.outline.valid = validation.valid
    record.outline.error = validation.error
  }

  const activeOutline = getActiveOutline()
  const invalidClosedOutline = closedOutlineRecords.find((record) => !record.outline.valid)
  const closedOutlineCount = closedOutlineRecords.length
  const hasOpenDraft = activeOutline.points.length > 0
  const canInflate = hasOpenDraft === false && closedOutlineCount > 0 && !invalidClosedOutline

  pressureValue.textContent = getPressureValue().toFixed(2)

  if (pillowSimulations.length > 0 && hasActivatedInflation) {
    statusText.textContent = `Pumping ${formatPillowCount(pillowSimulations.length)} toward ${getPressureValue().toFixed(2)} pressure. Lower the slider to deflate, or reset to edit the seams again.`
  } else if (hasOpenDraft) {
    const readySuffix =
      closedOutlineCount > 0
        ? ` ${formatOutlineCount(closedOutlineCount)} ${closedOutlineCount === 1 ? 'is' : 'are'} waiting once you finish this draft.`
        : ''
    statusText.textContent = activeOutline.error + readySuffix
  } else if (invalidClosedOutline) {
    statusText.textContent = `Adjust a closed outline before inflating all seams. ${invalidClosedOutline.outline.error}`
  } else if (closedOutlineCount > 0) {
    statusText.textContent = `${formatOutlineCount(closedOutlineCount)} ready. Click the ground to start another outline, or inflate all of them.`
  } else {
    statusText.textContent = activeOutline.error
  }

  undoButton.disabled = pillowSimulations.length > 0 || activeOutline.points.length === 0
  inflateButton.disabled = !canInflate
  resetButton.disabled =
    pillowSimulations.length === 0 &&
    closedOutlineCount === 0 &&
    activeOutline.points.length === 0
}

function clearPreviewMeshes(): void {
  for (const child of [...previewGroup.children]) {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose()
    }

    previewGroup.remove(child)
  }
}

function rebuildPreviewMeshes(): void {
  clearPreviewMeshes()

  for (const record of closedOutlineRecords) {
    if (!record.outline.valid) {
      continue
    }

    const shape = buildShape(record.outline.points)
    if (!shape) {
      continue
    }

    const geometry = new THREE.ShapeGeometry(shape)
    const previewMesh = new THREE.Mesh(geometry, previewMaterial)
    previewMesh.rotation.x = Math.PI / 2
    previewMesh.position.y = 0.01
    previewMesh.receiveShadow = true

    const previewWireOverlay = new THREE.Mesh(geometry, previewWireMaterial)
    previewWireOverlay.visible = showWireframe
    previewWireOverlay.renderOrder = 2
    previewMesh.add(previewWireOverlay)
    previewGroup.add(previewMesh)
  }
}

function clearSeamLines(): void {
  for (const child of [...seamGroup.children]) {
    const line = child as THREE.Line
    line.geometry.dispose()
    seamGroup.remove(child)
  }
}

function buildLineGeometry(points: readonly OutlinePoint[]): THREE.BufferGeometry {
  const positions: number[] = []
  for (const point of points) {
    positions.push(point.position.x, 0, point.position.y)
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  return geometry
}

function rebuildSeamLines(): void {
  clearSeamLines()

  for (const record of closedOutlineRecords) {
    if (record.outline.points.length < 3) {
      continue
    }

    const line = new THREE.LineLoop(buildLineGeometry(record.outline.points), seamMaterial)
    seamGroup.add(line)
  }

  const activeOutline = getActiveOutline()
  if (activeOutline.points.length >= 2) {
    const line = new THREE.Line(buildLineGeometry(activeOutline.points), seamMaterial)
    seamGroup.add(line)
  }
}

function clearHandles(): void {
  for (const child of [...handleGroup.children]) {
    const mesh = child as THREE.Mesh
    ;(mesh.material as THREE.Material).dispose()
    handleGroup.remove(child)
  }
}

function rebuildHandles(): void {
  clearHandles()

  if (pillowSimulations.length > 0) {
    return
  }

  for (const record of getAllOutlineRecords()) {
    const isActiveOutline = record.id === activeOutlineRecord.id

    for (const point of record.outline.points) {
      const isStartPoint = isActiveOutline && record.outline.points[0]?.id === point.id
      const isSelected = record.outline.selectedVertexId === point.id
      const isHovered = record.outline.hoveredVertexId === point.id
      const isInvalidClosedOutline = record.outline.closed && !record.outline.valid
      const material = makeHandleMaterial(
        isSelected
          ? 0xffca76
          : isHovered && isStartPoint
            ? 0x9ef0b5
            : isHovered
              ? 0xfef3c7
              : isStartPoint
                ? 0x3ca66b
                : isInvalidClosedOutline
                  ? 0xaa5162
                  : 0x14213d,
      )

      const handle = new THREE.Mesh(handleGeometry, material)
      handle.position.set(point.position.x, 0.06, point.position.y)
      handle.scale.setScalar(isStartPoint ? 1.18 : 1)
      handle.userData.outlineId = record.id
      handle.userData.pointId = point.id
      handle.castShadow = true
      handle.receiveShadow = true
      handleGroup.add(handle)
    }
  }
}

function syncOutlineVisuals(): void {
  rebuildSeamLines()
  rebuildPreviewMeshes()
  rebuildHandles()
  refreshOutlineState()
}

function disposeSimulations(): void {
  for (const simulation of pillowSimulations) {
    scene.remove(simulation.mesh)
    simulation.dispose()
  }

  pillowSimulations = []
}

function resetToEditableOutlines(): void {
  disposeSimulations()
  hasActivatedInflation = false
  setVertexFocus('selectedVertexId', null)
  setVertexFocus('hoveredVertexId', null)
  syncOutlineVisuals()
}

function addPoint(position: THREE.Vector3): void {
  getActiveOutline().points.push({
    id: nextPointId,
    position: new THREE.Vector2(position.x, position.z),
  })
  nextPointId += 1
  syncOutlineVisuals()
}

function updatePoint(target: HandleTarget, position: THREE.Vector3): void {
  const record = findOutlineRecord(target.outlineId)
  const point = record?.outline.points.find((candidate) => candidate.id === target.pointId)
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

function closeActiveOutline(): void {
  const activeOutline = getActiveOutline()
  if (activeOutline.points.length < 3 || !activeOutline.valid) {
    return
  }

  activeOutline.closed = true
  activeOutline.selectedVertexId = null
  activeOutline.hoveredVertexId = null
  closedOutlineRecords = [...closedOutlineRecords, activeOutlineRecord]
  activeOutlineRecord = advanceOutlineRecord()
  syncOutlineVisuals()
}

function inflateOutlines(): void {
  const activeOutline = getActiveOutline()
  const invalidClosedOutline = closedOutlineRecords.find((record) => !record.outline.valid)
  if (activeOutline.points.length > 0 || closedOutlineRecords.length === 0 || invalidClosedOutline) {
    return
  }

  if (pillowSimulations.length === 0) {
    pillowSimulations = closedOutlineRecords.map((record) => {
      const simulation = buildPillowFromOutline(cloneOutlinePoints(record.outline.points))
      simulation.setWireframeVisible(showWireframe)
      scene.add(simulation.mesh)
      return simulation
    })

    clearPreviewMeshes()
  }

  hasActivatedInflation = true
  for (const simulation of pillowSimulations) {
    simulation.update(0, getPressureValue())
  }

  rebuildHandles()
  refreshOutlineState()
}

function handleReset(): void {
  if (pillowSimulations.length > 0) {
    resetToEditableOutlines()
    return
  }

  nextOutlineId = 1
  nextPointId = 1
  closedOutlineRecords = []
  activeOutlineRecord = advanceOutlineRecord()
  hasActivatedInflation = false
  pendingHandleClick = null
  draggingHandle = null
  syncOutlineVisuals()
}

undoButton.addEventListener('click', () => {
  const activeOutline = getActiveOutline()
  if (pillowSimulations.length > 0 || activeOutline.points.length === 0) {
    return
  }

  activeOutline.points.pop()
  syncOutlineVisuals()
})

inflateButton.addEventListener('click', inflateOutlines)
resetButton.addEventListener('click', handleReset)

pressureSlider.addEventListener('input', () => {
  pressureValue.textContent = getPressureValue().toFixed(2)
  refreshOutlineState()
})

wireToggle.addEventListener('change', () => {
  showWireframe = wireToggle.checked

  for (const previewMesh of previewGroup.children) {
    const previewWireOverlay = previewMesh.children[0]
    if (previewWireOverlay) {
      previewWireOverlay.visible = showWireframe
    }
  }

  for (const simulation of pillowSimulations) {
    simulation.setWireframeVisible(showWireframe)
  }
})

renderer.domElement.addEventListener('contextmenu', (event) => {
  event.preventDefault()
})

renderer.domElement.addEventListener(
  'pointerdown',
  (event: PointerEvent) => {
    if (event.button === 1 || event.button === 2) {
      controls.enabled = true
      return
    }

    controls.enabled = false

    if (event.button !== 0) {
      return
    }

    if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
      pendingHandleClick = null
      return
    }

    const handleHit = pillowSimulations.length === 0 ? pickHandle(event.clientX, event.clientY) : null
    if (handleHit) {
      const outlineId = Number(handleHit.object.userData.outlineId)
      const pointId = Number(handleHit.object.userData.pointId)
      const record = findOutlineRecord(outlineId)
      const firstPointId = record?.outline.points[0]?.id ?? null

      pendingHandleClick = {
        pointerId: event.pointerId,
        outlineId,
        pointId,
        clientX: event.clientX,
        clientY: event.clientY,
        canClose:
          outlineId === activeOutlineRecord.id &&
          record !== null &&
          !record.outline.closed &&
          record.outline.points.length >= 3 &&
          record.outline.valid &&
          firstPointId === pointId,
      }

      setVertexFocus('selectedVertexId', { outlineId, pointId })
      setVertexFocus('hoveredVertexId', { outlineId, pointId })
      renderer.domElement.setPointerCapture(event.pointerId)
      rebuildHandles()
      refreshOutlineState()
      event.stopPropagation()
      return
    }

    if (pillowSimulations.length > 0) {
      return
    }

    const point = getGroundIntersection(event.clientX, event.clientY)
    if (point) {
      addPoint(point)
    }
  },
  { capture: true },
)

renderer.domElement.addEventListener('pointermove', (event) => {
  if (pendingHandleClick && draggingHandle === null) {
    if (pendingHandleClick.pointerId !== event.pointerId) {
      return
    }

    const dragDistance = Math.hypot(
      event.clientX - pendingHandleClick.clientX,
      event.clientY - pendingHandleClick.clientY,
    )

    if (dragDistance > CLICK_DRAG_THRESHOLD) {
      draggingHandle = {
        outlineId: pendingHandleClick.outlineId,
        pointId: pendingHandleClick.pointId,
      }
      pendingHandleClick = null
    } else {
      return
    }
  }

  if (draggingHandle) {
    const point = getGroundIntersection(event.clientX, event.clientY)
    if (!point) {
      return
    }

    updatePoint(draggingHandle, point)
    return
  }

  if (pillowSimulations.length > 0) {
    return
  }

  const handleHit = pickHandle(event.clientX, event.clientY)
  const hoveredTarget = handleHit
    ? {
        outlineId: Number(handleHit.object.userData.outlineId),
        pointId: Number(handleHit.object.userData.pointId),
      }
    : null

  if (setVertexFocus('hoveredVertexId', hoveredTarget)) {
    rebuildHandles()
  }
})

renderer.domElement.addEventListener('pointerup', (event) => {
  if (draggingHandle) {
    if (renderer.domElement.hasPointerCapture(event.pointerId)) {
      renderer.domElement.releasePointerCapture(event.pointerId)
    }

    draggingHandle = null
    setVertexFocus('selectedVertexId', null)
    controls.enabled = true
    rebuildHandles()
    refreshOutlineState()
    return
  }

  if (pendingHandleClick && pendingHandleClick.pointerId === event.pointerId) {
    if (renderer.domElement.hasPointerCapture(event.pointerId)) {
      renderer.domElement.releasePointerCapture(event.pointerId)
    }

    const dragDistance = Math.hypot(
      event.clientX - pendingHandleClick.clientX,
      event.clientY - pendingHandleClick.clientY,
    )

    const shouldClose = dragDistance <= CLICK_DRAG_THRESHOLD && pendingHandleClick.canClose
    pendingHandleClick = null
    setVertexFocus('selectedVertexId', null)
    controls.enabled = true

    if (shouldClose) {
      closeActiveOutline()
      return
    }

    rebuildHandles()
    refreshOutlineState()
    return
  }
  controls.enabled = true
})

renderer.domElement.addEventListener('pointercancel', () => {
  draggingHandle = null
  pendingHandleClick = null
  setVertexFocus('selectedVertexId', null)
  setVertexFocus('hoveredVertexId', null)
  controls.enabled = true
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

  if (hasActivatedInflation) {
    for (const simulation of pillowSimulations) {
      simulation.update(deltaTime, getPressureValue())
    }
  }

  renderer.render(scene, camera)
}

syncOutlineVisuals()
onResize()
renderer.setAnimationLoop(animate)
