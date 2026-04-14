import './style.css'

import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

import {
  buildShape,
  cloneOutlinePoints,
  createEditableOutline,
  pointInOutline,
  type EditableOutline,
  type OutlinePoint,
  validateOutline,
} from './geometry'
import { buildPillowFromOutline, type PillowSimulation } from './pillowSimulation'

interface InternalSeamRecord {
  id: number
  points: OutlinePoint[]
}

interface OutlineRecord {
  id: number
  outline: EditableOutline
  internalPaths: InternalSeamRecord[]
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

interface SnapTarget {
  position: THREE.Vector2
  distance: number
}

interface ActivePressInteraction {
  pointerId: number
  simulation: PillowSimulation
  startedAt: number
  startPoint: THREE.Vector3
  maxTravel: number
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
      <p class="lede">Draw stitched outlines on the floor, select a closed one to add chamber seams, then pump every closed seam into a two-sided pillow.</p>
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
      <p class="hint-text">Left click adds outer corners. Click the first point to close an outline. Click a closed outline to select it, then click inside it to draw chamber seams. In inflate mode, left drag on a pillow presses it in and release lets it bounce with a ripple. A quick tap gives a sharper rebound. Right mouse drag orbits the camera. Middle mouse drag pans.</p>
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

const internalDraftPointGroup = new THREE.Group()
internalDraftPointGroup.position.y = 0.055
scene.add(internalDraftPointGroup)

const outerSeamMaterial = new THREE.LineBasicMaterial({ color: 0xf3f7fb })
const selectedOuterSeamMaterial = new THREE.LineBasicMaterial({ color: 0xffd47a })
const internalSeamMaterial = new THREE.LineBasicMaterial({ color: 0x345a84 })
const selectedInternalSeamMaterial = new THREE.LineBasicMaterial({ color: 0x173a5f })
const internalDraftMaterial = new THREE.LineBasicMaterial({ color: 0xe05a78 })
const previewWireMaterial = new THREE.MeshBasicMaterial({
  color: 0x37506c,
  wireframe: true,
  transparent: true,
  opacity: 0.35,
  depthWrite: false,
})

let showWireframe = wireToggle.checked

const handleGeometry = new THREE.CylinderGeometry(0.11, 0.11, 0.08, 20)
const internalDraftPointGeometry = new THREE.SphereGeometry(0.08, 12, 10)
const handleGroup = new THREE.Group()
scene.add(handleGroup)

const raycaster = new THREE.Raycaster()
const drawPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
const pointer = new THREE.Vector2()
const hitPoint = new THREE.Vector3()
const clock = new THREE.Clock()

let nextOutlineId = 1
let nextPointId = 1
let nextInternalPathId = 1
let closedOutlineRecords: OutlineRecord[] = []
let activeOutlineRecord = advanceOutlineRecord()
let pillowSimulations: PillowSimulation[] = []
let hasActivatedInflation = false
let selectedOutlineId: number | null = null
let internalPathDraft: OutlinePoint[] = []
let draggingHandle: HandleTarget | null = null
let pendingHandleClick: PendingHandleClick | null = null
let activePressInteraction: ActivePressInteraction | null = null

const CLICK_DRAG_THRESHOLD = 6
const INTERNAL_SNAP_DISTANCE = 0.32
const INTERNAL_FINISH_DISTANCE = 0.2
const MIN_INTERNAL_SEGMENT_LENGTH = 0.06
const QUICK_TAP_DURATION_MS = 170
const QUICK_TAP_TRAVEL = 0.32

function createOutlineRecord(): OutlineRecord {
  return {
    id: nextOutlineId,
    outline: createEditableOutline(),
    internalPaths: [],
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

function getSelectedOutlineRecord(): OutlineRecord | null {
  return selectedOutlineId !== null ? findOutlineRecord(selectedOutlineId) : null
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

function createPoint(position: THREE.Vector2): OutlinePoint {
  const point: OutlinePoint = {
    id: nextPointId,
    position: position.clone(),
  }
  nextPointId += 1
  return point
}

function clearSelection(): void {
  selectedOutlineId = null
  internalPathDraft = []
}

function refreshOutlineState(): void {
  for (const record of getAllOutlineRecords()) {
    const validation = validateOutline(record.outline.points, record.outline.closed)
    record.outline.valid = validation.valid
    record.outline.error = validation.error
  }

  const activeOutline = getActiveOutline()
  const selectedOutline = getSelectedOutlineRecord()
  const invalidClosedOutline = closedOutlineRecords.find((record) => !record.outline.valid)
  const closedOutlineCount = closedOutlineRecords.length
  const hasOpenOuterDraft = activeOutline.points.length > 0
  const hasInternalDraft = internalPathDraft.length > 0
  const canInflate =
    !hasOpenOuterDraft &&
    !hasInternalDraft &&
    closedOutlineCount > 0 &&
    !invalidClosedOutline

  pressureValue.textContent = getPressureValue().toFixed(2)

  if (pillowSimulations.length > 0 && hasActivatedInflation) {
    statusText.textContent = `Pumping ${formatPillowCount(pillowSimulations.length)} toward ${getPressureValue().toFixed(2)} pressure. Left drag presses a pillow in, release lets it ripple back, and a quick tap gives a stronger bounce.`
  } else if (hasOpenOuterDraft) {
    const readySuffix =
      closedOutlineCount > 0
        ? ` ${formatOutlineCount(closedOutlineCount)} ${closedOutlineCount === 1 ? 'is' : 'are'} waiting once you finish this draft.`
        : ''
    statusText.textContent = activeOutline.error + readySuffix
  } else if (selectedOutline && hasInternalDraft) {
    statusText.textContent = 'Drawing a chamber seam. Click inside the selected outline to add points. Click near the outer seam or an existing chamber seam to finish, or click the last chamber point again to finish it floating.'
  } else if (selectedOutline) {
    statusText.textContent = 'Outline selected. Click inside it to draw a chamber seam. Click another closed outline to switch selection, or click empty ground to start a new outer outline.'
  } else if (invalidClosedOutline) {
    statusText.textContent = `Adjust a closed outline before inflating all seams. ${invalidClosedOutline.outline.error}`
  } else if (closedOutlineCount > 0) {
    statusText.textContent = `${formatOutlineCount(closedOutlineCount)} ready. Click a closed outline to add chamber seams, click the ground to start another outline, or inflate all of them.`
  } else {
    statusText.textContent = activeOutline.error
  }

  undoButton.disabled =
    pillowSimulations.length > 0 ||
    (
      activeOutline.points.length === 0 &&
      internalPathDraft.length === 0 &&
      !(selectedOutline && selectedOutline.internalPaths.length > 0)
    )
  inflateButton.disabled = !canInflate
  resetButton.disabled =
    pillowSimulations.length === 0 &&
    closedOutlineCount === 0 &&
    activeOutline.points.length === 0
}

function clearPreviewMeshes(): void {
  for (const child of [...previewGroup.children]) {
    if (child instanceof THREE.Mesh) {
      for (const overlay of child.children) {
        if (overlay instanceof THREE.Mesh) {
          ;(overlay.material as THREE.Material).dispose()
        }
      }

      ;(child.material as THREE.Material).dispose()
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
    const isSelected = record.id === selectedOutlineId
    const previewMesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({
        color: isSelected ? 0xaed6ff : 0x8ecae6,
        transparent: true,
        opacity: isSelected ? 0.42 : 0.32,
        roughness: 0.95,
        metalness: 0.03,
        side: THREE.DoubleSide,
      }),
    )
    previewMesh.rotation.x = Math.PI / 2
    previewMesh.position.y = 0.01
    previewMesh.receiveShadow = true
    previewMesh.userData.outlineId = record.id

    const previewWireOverlay = new THREE.Mesh(geometry, previewWireMaterial.clone())
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

function clearInternalDraftMarkers(): void {
  for (const child of [...internalDraftPointGroup.children]) {
    const mesh = child as THREE.Mesh
    ;(mesh.material as THREE.Material).dispose()
    internalDraftPointGroup.remove(child)
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
  clearInternalDraftMarkers()

  for (const record of closedOutlineRecords) {
    if (record.outline.points.length < 3) {
      continue
    }

    const isSelected = record.id === selectedOutlineId
    const outerLine = new THREE.LineLoop(
      buildLineGeometry(record.outline.points),
      isSelected ? selectedOuterSeamMaterial : outerSeamMaterial,
    )
    seamGroup.add(outerLine)

    for (const internalPath of record.internalPaths) {
      if (internalPath.points.length < 2) {
        continue
      }

      const internalLine = new THREE.Line(
        buildLineGeometry(internalPath.points),
        isSelected ? selectedInternalSeamMaterial : internalSeamMaterial,
      )
      seamGroup.add(internalLine)
    }
  }

  const activeOutline = getActiveOutline()
  if (activeOutline.points.length >= 2) {
    const line = new THREE.Line(buildLineGeometry(activeOutline.points), outerSeamMaterial)
    seamGroup.add(line)
  }

  if (internalPathDraft.length >= 2) {
    const line = new THREE.Line(buildLineGeometry(internalPathDraft), internalDraftMaterial)
    seamGroup.add(line)
  }

  for (let index = 0; index < internalPathDraft.length; index += 1) {
    const point = internalPathDraft[index]
    const marker = new THREE.Mesh(
      internalDraftPointGeometry,
      makeHandleMaterial(index === internalPathDraft.length - 1 ? 0xe05a78 : 0xffc2cf),
    )
    marker.position.set(point.position.x, 0, point.position.y)
    internalDraftPointGroup.add(marker)
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
    const isSelectedOutline = record.id === selectedOutlineId

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
                  : isSelectedOutline
                    ? 0x24507f
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
  activePressInteraction?.simulation.endPress()
  activePressInteraction = null
  disposeSimulations()
  hasActivatedInflation = false
  clearSelection()
  setVertexFocus('selectedVertexId', null)
  setVertexFocus('hoveredVertexId', null)
  syncOutlineVisuals()
}

function addOuterPoint(position: THREE.Vector3): void {
  clearSelection()
  getActiveOutline().points.push(createPoint(new THREE.Vector2(position.x, position.z)))
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

function pickPreview(clientX: number, clientY: number): THREE.Intersection<THREE.Object3D> | null {
  updatePointer(clientX, clientY)
  raycaster.setFromCamera(pointer, camera)
  const intersections = raycaster.intersectObjects(previewGroup.children, false)
  return intersections[0] ?? null
}

function findSimulationForObject(object: THREE.Object3D | null): PillowSimulation | null {
  let current: THREE.Object3D | null = object

  while (current) {
    const simulation = current.userData.simulation as PillowSimulation | undefined
    if (simulation) {
      return simulation
    }

    current = current.parent
  }

  return null
}

function pickInflatedMesh(clientX: number, clientY: number): THREE.Intersection<THREE.Object3D> | null {
  updatePointer(clientX, clientY)
  raycaster.setFromCamera(pointer, camera)
  const intersections = raycaster.intersectObjects(
    pillowSimulations.map((simulation) => simulation.mesh),
    true,
  )

  return intersections.find((intersection) => findSimulationForObject(intersection.object) !== null) ?? null
}

function getGroundIntersection(clientX: number, clientY: number): THREE.Vector3 | null {
  updatePointer(clientX, clientY)
  raycaster.setFromCamera(pointer, camera)
  const point = raycaster.ray.intersectPlane(drawPlane, hitPoint)
  return point ? point.clone() : null
}

function toGroundVector(point: THREE.Vector3): THREE.Vector2 {
  return new THREE.Vector2(point.x, point.z)
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
  clearSelection()
  syncOutlineVisuals()
}

function finalizeInternalPath(record: OutlineRecord): void {
  if (internalPathDraft.length < 2) {
    return
  }

  const span = internalPathDraft.reduce(
    (maxDistance, point) =>
      Math.max(maxDistance, point.position.distanceTo(internalPathDraft[0].position)),
    0,
  )

  if (span <= MIN_INTERNAL_SEGMENT_LENGTH) {
    return
  }

  record.internalPaths = [
    ...record.internalPaths,
    {
      id: nextInternalPathId,
      points: cloneOutlinePoints(internalPathDraft),
    },
  ]
  nextInternalPathId += 1
  internalPathDraft = []
  syncOutlineVisuals()
}

function projectPointToSegment(
  point: THREE.Vector2,
  start: THREE.Vector2,
  end: THREE.Vector2,
): THREE.Vector2 {
  const segment = end.clone().sub(start)
  const segmentLengthSquared = segment.lengthSq()

  if (segmentLengthSquared < 1e-6) {
    return start.clone()
  }

  const projection = THREE.MathUtils.clamp(
    point.clone().sub(start).dot(segment) / segmentLengthSquared,
    0,
    1,
  )

  return start.clone().add(segment.multiplyScalar(projection))
}

function getSnapTargetForPath(
  points: readonly OutlinePoint[],
  closed: boolean,
  position: THREE.Vector2,
): SnapTarget | null {
  if (points.length < 2) {
    return null
  }

  const segmentCount = closed ? points.length : points.length - 1
  let bestTarget: SnapTarget | null = null

  for (let index = 0; index < segmentCount; index += 1) {
    const start = points[index].position
    const end = points[(index + 1) % points.length].position
    const projected = projectPointToSegment(position, start, end)
    const distance = projected.distanceTo(position)

    if (!bestTarget || distance < bestTarget.distance) {
      bestTarget = {
        position: projected,
        distance,
      }
    }
  }

  return bestTarget
}

function getInternalSnapTarget(record: OutlineRecord, position: THREE.Vector2): SnapTarget | null {
  let bestTarget = getSnapTargetForPath(record.outline.points, true, position)

  for (const internalPath of record.internalPaths) {
    const candidate = getSnapTargetForPath(internalPath.points, false, position)
    if (!candidate) {
      continue
    }

    if (!bestTarget || candidate.distance < bestTarget.distance) {
      bestTarget = candidate
    }
  }

  return bestTarget && bestTarget.distance <= INTERNAL_SNAP_DISTANCE ? bestTarget : null
}

function tryAddInternalSeamPoint(record: OutlineRecord, position: THREE.Vector2): boolean {
  const snappedTarget = getInternalSnapTarget(record, position)
  const isInside = pointInOutline(position, record.outline.points)
  const candidate = snappedTarget ? snappedTarget.position : position

  if (!isInside && !snappedTarget) {
    return false
  }

  if (internalPathDraft.length >= 2) {
    const lastPoint = internalPathDraft[internalPathDraft.length - 1]
    if (lastPoint.position.distanceTo(position) <= INTERNAL_FINISH_DISTANCE) {
      finalizeInternalPath(record)
      return true
    }
  }

  if (internalPathDraft.length === 0) {
    internalPathDraft = [createPoint(candidate)]
    syncOutlineVisuals()
    return true
  }

  const lastPoint = internalPathDraft[internalPathDraft.length - 1]
  if (lastPoint.position.distanceTo(candidate) <= MIN_INTERNAL_SEGMENT_LENGTH) {
    return false
  }

  internalPathDraft = [...internalPathDraft, createPoint(candidate)]

  if (snappedTarget && internalPathDraft.length >= 2) {
    finalizeInternalPath(record)
    return true
  }

  syncOutlineVisuals()
  return true
}

function selectOutline(outlineId: number | null): void {
  selectedOutlineId = outlineId
  internalPathDraft = []
  syncOutlineVisuals()
}

function inflateOutlines(): void {
  const activeOutline = getActiveOutline()
  const invalidClosedOutline = closedOutlineRecords.find((record) => !record.outline.valid)
  if (
    activeOutline.points.length > 0 ||
    internalPathDraft.length > 0 ||
    closedOutlineRecords.length === 0 ||
    invalidClosedOutline
  ) {
    return
  }

  if (pillowSimulations.length === 0) {
    pillowSimulations = closedOutlineRecords.map((record) => {
      const simulation = buildPillowFromOutline(
        cloneOutlinePoints(record.outline.points),
        record.internalPaths.map((path) => cloneOutlinePoints(path.points)),
      )
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
  nextInternalPathId = 1
  closedOutlineRecords = []
  activeOutlineRecord = advanceOutlineRecord()
  hasActivatedInflation = false
  clearSelection()
  pendingHandleClick = null
  draggingHandle = null
  syncOutlineVisuals()
}

undoButton.addEventListener('click', () => {
  if (pillowSimulations.length > 0) {
    return
  }

  const activeOutline = getActiveOutline()
  const selectedOutline = getSelectedOutlineRecord()

  if (activeOutline.points.length > 0) {
    activeOutline.points.pop()
    syncOutlineVisuals()
    return
  }

  if (internalPathDraft.length > 0) {
    internalPathDraft = internalPathDraft.slice(0, -1)
    syncOutlineVisuals()
    return
  }

  if (selectedOutline && selectedOutline.internalPaths.length > 0) {
    selectedOutline.internalPaths = selectedOutline.internalPaths.slice(0, -1)
    syncOutlineVisuals()
  }
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
      const meshHit = pickInflatedMesh(event.clientX, event.clientY)
      const simulation = meshHit ? findSimulationForObject(meshHit.object) : null
      if (simulation) {
        activePressInteraction = {
          pointerId: event.pointerId,
          simulation,
          startedAt: performance.now(),
          startPoint: meshHit!.point.clone(),
          maxTravel: 0,
        }
        renderer.domElement.setPointerCapture(event.pointerId)
        simulation.beginPress(meshHit!.point)
      } else {
        controls.enabled = true
      }
      return
    }

    const previewHit = pickPreview(event.clientX, event.clientY)
    const previewOutlineId = previewHit ? Number(previewHit.object.userData.outlineId) : null
    const point = getGroundIntersection(event.clientX, event.clientY)
    if (!point) {
      controls.enabled = true
      return
    }

    const activeOutline = getActiveOutline()
    const selectedOutline = getSelectedOutlineRecord()

    if (activeOutline.points.length > 0) {
      addOuterPoint(point)
      return
    }

    if (
      selectedOutline &&
      previewOutlineId !== null &&
      previewOutlineId !== selectedOutline.id &&
      internalPathDraft.length === 0
    ) {
      selectOutline(previewOutlineId)
      return
    }

    if (selectedOutline) {
      const groundVector = toGroundVector(point)
      if (
        previewOutlineId === selectedOutline.id ||
        pointInOutline(groundVector, selectedOutline.outline.points) ||
        getInternalSnapTarget(selectedOutline, groundVector)
      ) {
        if (tryAddInternalSeamPoint(selectedOutline, groundVector)) {
          return
        }
      }

      if (internalPathDraft.length === 0) {
        if (previewOutlineId !== null) {
          selectOutline(previewOutlineId)
          return
        }

        clearSelection()
        addOuterPoint(point)
        return
      }

      return
    }

    if (previewOutlineId !== null) {
      selectOutline(previewOutlineId)
      return
    }

    addOuterPoint(point)
  },
  { capture: true },
)

renderer.domElement.addEventListener('pointermove', (event) => {
  if (activePressInteraction) {
    if (activePressInteraction.pointerId !== event.pointerId) {
      return
    }

    const meshHit = pickInflatedMesh(event.clientX, event.clientY)
    const simulation = meshHit ? findSimulationForObject(meshHit.object) : null
    if (meshHit && simulation === activePressInteraction.simulation) {
      activePressInteraction.maxTravel = Math.max(
        activePressInteraction.maxTravel,
        meshHit.point.distanceTo(activePressInteraction.startPoint),
      )
      activePressInteraction.simulation.updatePress(meshHit.point)
    }
    return
  }

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
  if (activePressInteraction && activePressInteraction.pointerId === event.pointerId) {
    if (renderer.domElement.hasPointerCapture(event.pointerId)) {
      renderer.domElement.releasePointerCapture(event.pointerId)
    }

    const durationMs = performance.now() - activePressInteraction.startedAt
    const tapDurationWeight = 1 - THREE.MathUtils.clamp(durationMs / QUICK_TAP_DURATION_MS, 0, 1)
    const tapTravelWeight = 1 - THREE.MathUtils.clamp(activePressInteraction.maxTravel / QUICK_TAP_TRAVEL, 0, 1)
    const quickTapStrength = tapDurationWeight * tapTravelWeight

    activePressInteraction.simulation.endPress(
      THREE.MathUtils.lerp(1, 2.4, quickTapStrength),
      THREE.MathUtils.lerp(0, 0.68, quickTapStrength),
    )
    activePressInteraction = null
    controls.enabled = true
    return
  }

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
  activePressInteraction?.simulation.endPress()
  activePressInteraction = null
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
