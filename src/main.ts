import './style.css'

import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

import {
  buildSubdividedPath,
  buildShape,
  cloneOutlinePoints,
  createEditableOutline,
  getOutlineVectors,
  pointInOutline,
  type EditableOutline,
  type OutlinePoint,
  validatePathVectors,
  validateOutline,
} from './geometry'
import { buildPillowFromOutline, type PillowSimulation } from './pillowSimulation'

interface InternalSeamRecord {
  id: number
  points: OutlinePoint[]
  closed: boolean
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
    <section id="ui-panel" class="apple-panel" aria-label="Inflate pillow controls">
      <div id="ui-handle" class="panel-drag-handle">
        <button
          id="collapseToggle"
          class="collapse-button panel-collapse-toggle"
          type="button"
          aria-label="Collapse controls"
          aria-expanded="true"
        >
          <span class="collapse-icon" aria-hidden="true"></span>
        </button>
      </div>
      <div class="ui-body panel-sections">
        <p class="control-hint">Wheel = Zoom, MMB = Pan, RMB = Orbit</p>
        <section class="panel-section">
          <button class="panel-section-header" type="button" aria-expanded="true">
            <span class="panel-section-label">Simulation</span>
          </button>
          <div class="panel-section-content panel-controls-stack">
            <div class="control control-grid-2">
              <button id="inflateButton" class="pill-button action-button" type="button">Start</button>
              <button id="resetButton" class="pill-button reset-button" type="button">Reset</button>
            </div>
            <label class="control" for="pressureSlider">
              <div class="control-row">
                <span>Pressure</span>
                <span id="pressure-value">0.42</span>
              </div>
              <input id="pressureSlider" type="range" min="0" max="1" value="0.42" step="0.01" />
            </label>
          </div>
        </section>
        <section class="panel-section">
          <button class="panel-section-header" type="button" aria-expanded="true">
            <span class="panel-section-label">Seams</span>
          </button>
          <div class="panel-section-content panel-controls-stack">
            <label class="control" for="outerSeamCurvature">
              <div class="control-row">
                <span>Outer Seam Curvature</span>
                <span id="outer-seam-curvature-value">1</span>
              </div>
              <input id="outerSeamCurvature" type="range" min="1" max="12" value="1" step="1" />
            </label>
            <label class="control" for="innerSeamCurvature">
              <div class="control-row">
                <span>Inner Seam Curvature</span>
                <span id="inner-seam-curvature-value">1</span>
              </div>
              <input id="innerSeamCurvature" type="range" min="1" max="12" value="1" step="1" />
            </label>
            <div class="control control-grid-2">
              <button id="undoButton" class="pill-button" type="button">Undo</button>
            </div>
            <label class="toggle-control" for="wireToggle">
              <span>Mesh Wires</span>
              <input id="wireToggle" type="checkbox" checked />
            </label>
            <label class="toggle-control" for="reflectionToggle">
              <span>Foil Material</span>
              <input id="reflectionToggle" type="checkbox" checked />
            </label>
            <p id="statusText" class="status-text"></p>
          </div>
        </section>
        <p class="hint-text">Click the first outer point or press Enter to close an outline. Click a closed outline to add chamber seams, click the first chamber point to close a loop, and press Enter to end a chamber seam open.</p>
      </div>
      <div id="ui-handle-bottom"></div>
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

function addWrappedGlow(
  context: CanvasRenderingContext2D,
  width: number,
  x: number,
  y: number,
  radius: number,
  stops: readonly [number, string][],
): void {
  for (const offset of [-width, 0, width]) {
    const gradient = context.createRadialGradient(x + offset, y, 0, x + offset, y, radius)
    for (const [position, color] of stops) {
      gradient.addColorStop(position, color)
    }

    context.fillStyle = gradient
    context.fillRect(x + offset - radius, y - radius, radius * 2, radius * 2)
  }
}

function createStudioReflectionEnvironment(renderer: THREE.WebGLRenderer): THREE.WebGLRenderTarget {
  const pmremGenerator = new THREE.PMREMGenerator(renderer)
  const canvas = document.createElement('canvas')
  canvas.width = 1024
  canvas.height = 512

  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('Could not create environment canvas context.')
  }

  const width = canvas.width
  const height = canvas.height
  const baseGradient = context.createLinearGradient(0, 0, 0, height)
  baseGradient.addColorStop(0, '#172241')
  baseGradient.addColorStop(0.24, '#35538b')
  baseGradient.addColorStop(0.52, '#9aa8e2')
  baseGradient.addColorStop(0.76, '#ebf1ff')
  baseGradient.addColorStop(1, '#c8f3ff')
  context.fillStyle = baseGradient
  context.fillRect(0, 0, width, height)

  addWrappedGlow(context, width, width * 0.18, height * 0.5, width * 0.24, [
    [0, 'rgba(255, 92, 223, 0.62)'],
    [0.42, 'rgba(255, 92, 223, 0.18)'],
    [1, 'rgba(255, 92, 223, 0)'],
  ])

  addWrappedGlow(context, width, width * 0.82, height * 0.52, width * 0.24, [
    [0, 'rgba(255, 207, 103, 0.82)'],
    [0.4, 'rgba(255, 207, 103, 0.24)'],
    [1, 'rgba(255, 207, 103, 0)'],
  ])

  addWrappedGlow(context, width, width * 0.5, height * 0.84, width * 0.34, [
    [0, 'rgba(79, 230, 255, 0.72)'],
    [0.38, 'rgba(79, 230, 255, 0.24)'],
    [1, 'rgba(79, 230, 255, 0)'],
  ])

  addWrappedGlow(context, width, width * 0.5, height * 0.2, width * 0.26, [
    [0, 'rgba(255, 255, 255, 0.82)'],
    [0.48, 'rgba(255, 255, 255, 0.18)'],
    [1, 'rgba(255, 255, 255, 0)'],
  ])

  addWrappedGlow(context, width, width * 0.58, height * 0.58, width * 0.18, [
    [0, 'rgba(255, 255, 255, 0.34)'],
    [0.55, 'rgba(255, 255, 255, 0.08)'],
    [1, 'rgba(255, 255, 255, 0)'],
  ])

  const environmentTexture = new THREE.CanvasTexture(canvas)
  environmentTexture.colorSpace = THREE.SRGBColorSpace
  environmentTexture.mapping = THREE.EquirectangularReflectionMapping

  const environmentTarget = pmremGenerator.fromEquirectangular(environmentTexture)
  environmentTexture.dispose()
  pmremGenerator.dispose()

  return environmentTarget
}

const canvas = requireElement<HTMLCanvasElement>('.viewport')
const uiPanel = requireElement<HTMLDivElement>('#ui-panel')
const uiHandleTop = requireElement<HTMLDivElement>('#ui-handle')
const uiHandleBottom = requireElement<HTMLDivElement>('#ui-handle-bottom')
const collapseToggle = requireElement<HTMLButtonElement>('#collapseToggle')
const undoButton = requireElement<HTMLButtonElement>('#undoButton')
const resetButton = requireElement<HTMLButtonElement>('#resetButton')
const inflateButton = requireElement<HTMLButtonElement>('#inflateButton')
const outerSeamCurvatureSlider = requireElement<HTMLInputElement>('#outerSeamCurvature')
const outerSeamCurvatureValue = requireElement<HTMLSpanElement>('#outer-seam-curvature-value')
const innerSeamCurvatureSlider = requireElement<HTMLInputElement>('#innerSeamCurvature')
const innerSeamCurvatureValue = requireElement<HTMLSpanElement>('#inner-seam-curvature-value')
const pressureSlider = requireElement<HTMLInputElement>('#pressureSlider')
const pressureValue = requireElement<HTMLSpanElement>('#pressure-value')
const wireToggle = requireElement<HTMLInputElement>('#wireToggle')
const reflectionToggle = requireElement<HTMLInputElement>('#reflectionToggle')
const statusText = requireElement<HTMLParagraphElement>('#statusText')

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
})
renderer.outputColorSpace = THREE.SRGBColorSpace
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.18
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap

const scene = new THREE.Scene()
scene.background = new THREE.Color(0xe8edf8)
const reflectionEnvironment = createStudioReflectionEnvironment(renderer)
scene.environment = reflectionEnvironment.texture
const REFLECTION_ACCENT_INTENSITIES = {
  magenta: 6.2,
  cyan: 7.8,
  amber: 6.9,
} as const

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
keyLight.shadow.bias = -0.00015
keyLight.shadow.normalBias = 0.045
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

const magentaAccentLight = new THREE.PointLight(
  0xff4cc8,
  REFLECTION_ACCENT_INTENSITIES.magenta,
  30,
  2,
)
magentaAccentLight.position.set(-7.5, 4.5, 4.8)
scene.add(magentaAccentLight)

const cyanAccentLight = new THREE.PointLight(
  0x4fe6ff,
  REFLECTION_ACCENT_INTENSITIES.cyan,
  28,
  2,
)
cyanAccentLight.position.set(6.5, 2.4, 7.5)
scene.add(cyanAccentLight)

const amberAccentLight = new THREE.PointLight(
  0xffc857,
  REFLECTION_ACCENT_INTENSITIES.amber,
  28,
  2,
)
amberAccentLight.position.set(7.8, 5.2, -4.8)
scene.add(amberAccentLight)

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
let reflectionsEnabled = reflectionToggle.checked

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
let draggingPanel = false
let outerSeamCurvature = Math.max(1, Math.round(Number.parseFloat(outerSeamCurvatureSlider.value) || 1))
let innerSeamCurvature = Math.max(1, Math.round(Number.parseFloat(innerSeamCurvatureSlider.value) || 1))

const CLICK_DRAG_THRESHOLD = 6
const INTERNAL_SNAP_DISTANCE = 0.32
const INTERNAL_FINISH_DISTANCE = 0.2
const MIN_INTERNAL_SEGMENT_LENGTH = 0.06
const QUICK_TAP_DURATION_MS = 170
const QUICK_TAP_TRAVEL = 0.32
const panelDragOffset = { x: 0, y: 0 }

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

function updateRangeProgress(input: HTMLInputElement): void {
  const min = Number.parseFloat(input.min || '0')
  const max = Number.parseFloat(input.max || '1')
  const value = Number.parseFloat(input.value)
  const span = Math.max(max - min, 1e-6)
  const progress = THREE.MathUtils.clamp((value - min) / span, 0, 1)
  input.style.setProperty('--range-progress', `${(progress * 100).toFixed(3)}%`)
}

function getCurvedOutlinePoints(points: readonly OutlinePoint[], closed = true): THREE.Vector2[] {
  return buildSubdividedPath(points, closed, outerSeamCurvature)
}

function getCurvedInternalSeamPoints(points: readonly OutlinePoint[], closed: boolean): THREE.Vector2[] {
  return buildSubdividedPath(points, closed, innerSeamCurvature)
}

function buildLineGeometryFromVectors(points: readonly THREE.Vector2[]): THREE.BufferGeometry {
  const positions: number[] = []
  for (const point of points) {
    positions.push(point.x, 0, point.y)
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  return geometry
}

function warmStartSimulation(simulation: PillowSimulation, targetPressure: number, steps = 18): void {
  for (let step = 0; step < steps; step += 1) {
    simulation.update(1 / 60, targetPressure)
  }
}

function applyReflectionState(): void {
  scene.environment = reflectionsEnabled ? reflectionEnvironment.texture : null
  magentaAccentLight.intensity = reflectionsEnabled ? REFLECTION_ACCENT_INTENSITIES.magenta : 0
  cyanAccentLight.intensity = reflectionsEnabled ? REFLECTION_ACCENT_INTENSITIES.cyan : 0
  amberAccentLight.intensity = reflectionsEnabled ? REFLECTION_ACCENT_INTENSITIES.amber : 0

  for (const simulation of pillowSimulations) {
    simulation.setReflectionEnabled(reflectionsEnabled)
  }
}

function rebuildInflatedSimulations(): void {
  if (pillowSimulations.length === 0) {
    return
  }

  const targetPressure = getPressureValue()
  const wasRunning = hasActivatedInflation
  activePressInteraction?.simulation.endPress()
  activePressInteraction = null
  disposeSimulations()

  pillowSimulations = closedOutlineRecords.map((record) => {
    const simulation = buildPillowFromOutline(
      cloneOutlinePoints(record.outline.points),
      record.internalPaths.map((path) => ({
        points: cloneOutlinePoints(path.points),
        closed: path.closed,
      })),
      outerSeamCurvature,
      innerSeamCurvature,
    )
    simulation.setWireframeVisible(showWireframe)
    simulation.setReflectionEnabled(reflectionsEnabled)
    scene.add(simulation.mesh)
    warmStartSimulation(simulation, targetPressure)
    return simulation
  })

  hasActivatedInflation = wasRunning
  clearPreviewMeshes()
  rebuildHandles()
  refreshOutlineState()
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

function isTypingInUi(): boolean {
  const activeElement = document.activeElement
  return (
    activeElement instanceof HTMLInputElement ||
    activeElement instanceof HTMLButtonElement ||
    activeElement instanceof HTMLSelectElement ||
    activeElement instanceof HTMLTextAreaElement
  )
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
    if (validation.valid && record.outline.closed) {
      const curvedValidation = validatePathVectors(getCurvedOutlinePoints(record.outline.points), true)
      if (!curvedValidation.valid) {
        record.outline.valid = false
        record.outline.error = curvedValidation.error
        continue
      }
    }

    record.outline.valid = validation.valid
    record.outline.error = validation.error
  }

  const activeOutline = getActiveOutline()
  const selectedOutline = getSelectedOutlineRecord()
  const invalidClosedOutline = closedOutlineRecords.find((record) => !record.outline.valid)
  const closedOutlineCount = closedOutlineRecords.length
  const hasOpenOuterDraft = activeOutline.points.length > 0
  const hasInternalDraft = internalPathDraft.length > 0
  const hasInflatedMeshes = pillowSimulations.length > 0
  const isRunning = hasInflatedMeshes && hasActivatedInflation

  pressureValue.textContent = getPressureValue().toFixed(2)
  updateRangeProgress(pressureSlider)
  inflateButton.textContent = isRunning ? 'Pause' : 'Start'
  inflateButton.classList.toggle('is-start-state', !isRunning)
  inflateButton.classList.toggle('is-stop-state', isRunning)

  if (isRunning) {
    statusText.textContent = `Pumping ${formatPillowCount(pillowSimulations.length)} toward ${getPressureValue().toFixed(2)} pressure. Left drag presses a pillow in, release lets it ripple back, and a quick tap gives a stronger bounce.`
  } else if (hasInflatedMeshes) {
    statusText.textContent = `Paused ${formatPillowCount(pillowSimulations.length)}. Press Start to resume, or Reset to return to seam editing.`
  } else if (hasOpenOuterDraft) {
    const readySuffix =
      closedOutlineCount > 0
        ? ` ${formatOutlineCount(closedOutlineCount)} ${closedOutlineCount === 1 ? 'is' : 'are'} waiting once you finish this draft.`
        : ''
    statusText.textContent = activeOutline.error + readySuffix
  } else if (selectedOutline && hasInternalDraft) {
    statusText.textContent = 'Drawing a chamber seam. Click inside the selected outline to add points. Click the first chamber point to close a loop, click near the outer seam or an existing chamber seam to finish open, or press Enter to end the seam open.'
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
  inflateButton.disabled = false
  resetButton.disabled = false
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

    const shape = buildShape(record.outline.points, outerSeamCurvature)
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

function rebuildSeamLines(): void {
  clearSeamLines()
  clearInternalDraftMarkers()

  for (const record of closedOutlineRecords) {
    if (record.outline.points.length < 3) {
      continue
    }

    const isSelected = record.id === selectedOutlineId
    const outerLine = new THREE.LineLoop(
      buildLineGeometryFromVectors(getCurvedOutlinePoints(record.outline.points)),
      isSelected ? selectedOuterSeamMaterial : outerSeamMaterial,
    )
    seamGroup.add(outerLine)

    for (const internalPath of record.internalPaths) {
      if (internalPath.points.length < 2) {
        continue
      }

      const internalGeometry = buildLineGeometryFromVectors(
        getCurvedInternalSeamPoints(internalPath.points, internalPath.closed),
      )
      const internalLine = internalPath.closed
        ? new THREE.LineLoop(
            internalGeometry,
            isSelected ? selectedInternalSeamMaterial : internalSeamMaterial,
          )
        : new THREE.Line(
            internalGeometry,
            isSelected ? selectedInternalSeamMaterial : internalSeamMaterial,
          )
      seamGroup.add(internalLine)
    }
  }

  const activeOutline = getActiveOutline()
  if (activeOutline.points.length >= 2) {
    const line = new THREE.Line(
      buildLineGeometryFromVectors(getCurvedOutlinePoints(activeOutline.points, false)),
      outerSeamMaterial,
    )
    seamGroup.add(line)
  }

  if (internalPathDraft.length >= 2) {
    const line = new THREE.Line(
      buildLineGeometryFromVectors(getCurvedInternalSeamPoints(internalPathDraft, false)),
      internalDraftMaterial,
    )
    seamGroup.add(line)
  }

  for (let index = 0; index < internalPathDraft.length; index += 1) {
    const point = internalPathDraft[index]
    const marker = new THREE.Mesh(
      internalDraftPointGeometry,
      makeHandleMaterial(
        index === 0 && internalPathDraft.length >= 3
          ? 0x9ef0b5
          : index === internalPathDraft.length - 1
            ? 0xe05a78
            : 0xffc2cf,
      ),
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

function finalizeInternalPath(record: OutlineRecord, closed: boolean): boolean {
  if (internalPathDraft.length < (closed ? 3 : 2)) {
    return false
  }

  const nextPoints = cloneOutlinePoints(internalPathDraft)

  if (closed) {
    const validation = validatePathVectors(getOutlineVectors(nextPoints), true)
    if (!validation.valid) {
      return false
    }
  } else {
    const span = nextPoints.reduce(
      (maxDistance, point) =>
        Math.max(maxDistance, point.position.distanceTo(nextPoints[0].position)),
      0,
    )

    if (span <= MIN_INTERNAL_SEGMENT_LENGTH) {
      return false
    }
  }

  record.internalPaths = [
    ...record.internalPaths,
    {
      id: nextInternalPathId,
      points: nextPoints,
      closed,
    },
  ]
  nextInternalPathId += 1
  internalPathDraft = []
  syncOutlineVisuals()
  return true
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
  const curvedOutline = getCurvedOutlinePoints(record.outline.points)
  let bestTarget = getSnapTargetForPath(
    curvedOutline.map((point, index) => ({ id: -(index + 1), position: point })),
    true,
    position,
  )

  for (const internalPath of record.internalPaths) {
    const candidate = getSnapTargetForPath(
      getCurvedInternalSeamPoints(internalPath.points, internalPath.closed).map((point, index) => ({
        id: -(index + 1),
        position: point,
      })),
      internalPath.closed,
      position,
    )
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
  const isInside = pointInOutline(position, getCurvedOutlinePoints(record.outline.points))
  const candidate = snappedTarget ? snappedTarget.position : position

  if (!isInside && !snappedTarget) {
    return false
  }

  if (internalPathDraft.length >= 3) {
    const firstPoint = internalPathDraft[0]
    if (firstPoint.position.distanceTo(position) <= INTERNAL_FINISH_DISTANCE) {
      return finalizeInternalPath(record, true)
    }
  }

  if (internalPathDraft.length >= 2) {
    const lastPoint = internalPathDraft[internalPathDraft.length - 1]
    if (lastPoint.position.distanceTo(position) <= INTERNAL_FINISH_DISTANCE) {
      return finalizeInternalPath(record, false)
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
    return finalizeInternalPath(record, false)
  }

  syncOutlineVisuals()
  return true
}

function selectOutline(outlineId: number | null): void {
  selectedOutlineId = outlineId
  internalPathDraft = []
  syncOutlineVisuals()
}

function toggleInflation(): void {
  if (pillowSimulations.length > 0) {
    if (hasActivatedInflation) {
      activePressInteraction?.simulation.endPress()
      activePressInteraction = null
      hasActivatedInflation = false
    } else {
      hasActivatedInflation = true
      for (const simulation of pillowSimulations) {
        simulation.update(0, getPressureValue())
      }
    }

    refreshOutlineState()
    return
  }

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
        record.internalPaths.map((path) => ({
          points: cloneOutlinePoints(path.points),
          closed: path.closed,
        })),
        outerSeamCurvature,
        innerSeamCurvature,
      )
      simulation.setWireframeVisible(showWireframe)
      simulation.setReflectionEnabled(reflectionsEnabled)
      scene.add(simulation.mesh)
      warmStartSimulation(simulation, getPressureValue())
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

function clampPanelToViewport(): void {
  if (window.innerWidth <= 700) {
    uiPanel.style.left = ''
    uiPanel.style.top = ''
    return
  }

  const rect = uiPanel.getBoundingClientRect()
  const maxLeft = Math.max(12, window.innerWidth - rect.width - 12)
  const maxTop = Math.max(12, window.innerHeight - rect.height - 12)
  const nextLeft = THREE.MathUtils.clamp(rect.left, 12, maxLeft)
  const nextTop = THREE.MathUtils.clamp(rect.top, 12, maxTop)

  uiPanel.style.left = `${nextLeft}px`
  uiPanel.style.top = `${nextTop}px`
  uiPanel.style.right = 'auto'
  uiPanel.style.bottom = 'auto'
}

function bindSectionCollapses(): void {
  const headers = app.querySelectorAll<HTMLButtonElement>('.panel-section-header')
  for (const header of headers) {
    header.addEventListener('click', () => {
      const section = header.closest<HTMLElement>('.panel-section')
      if (!section) {
        return
      }

      const collapsed = section.classList.toggle('is-collapsed')
      header.setAttribute('aria-expanded', collapsed ? 'false' : 'true')
    })
  }
}

function beginPanelDrag(event: PointerEvent): void {
  if (window.innerWidth <= 700) {
    return
  }

  if (event.target instanceof Element && event.target.closest('.collapse-button')) {
    return
  }

  const rect = uiPanel.getBoundingClientRect()
  draggingPanel = true
  panelDragOffset.x = event.clientX - rect.left
  panelDragOffset.y = event.clientY - rect.top
  uiPanel.style.left = `${rect.left}px`
  uiPanel.style.top = `${rect.top}px`
  uiPanel.style.right = 'auto'
  uiPanel.style.bottom = 'auto'
  ;(event.currentTarget as HTMLElement | null)?.setPointerCapture(event.pointerId)
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

inflateButton.addEventListener('click', toggleInflation)
resetButton.addEventListener('click', handleReset)

outerSeamCurvatureSlider.addEventListener('input', () => {
  const nextCurvature = Math.max(1, Math.round(Number.parseFloat(outerSeamCurvatureSlider.value) || 1))
  outerSeamCurvature = nextCurvature
  outerSeamCurvatureSlider.value = `${nextCurvature}`
  outerSeamCurvatureValue.textContent = `${nextCurvature}`
  updateRangeProgress(outerSeamCurvatureSlider)

  if (pillowSimulations.length > 0) {
    rebuildInflatedSimulations()
    return
  }

  syncOutlineVisuals()
})

innerSeamCurvatureSlider.addEventListener('input', () => {
  const nextCurvature = Math.max(1, Math.round(Number.parseFloat(innerSeamCurvatureSlider.value) || 1))
  innerSeamCurvature = nextCurvature
  innerSeamCurvatureSlider.value = `${nextCurvature}`
  innerSeamCurvatureValue.textContent = `${nextCurvature}`
  updateRangeProgress(innerSeamCurvatureSlider)

  if (pillowSimulations.length > 0) {
    rebuildInflatedSimulations()
    return
  }

  syncOutlineVisuals()
})

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

reflectionToggle.addEventListener('change', () => {
  reflectionsEnabled = reflectionToggle.checked
  applyReflectionState()
})

renderer.domElement.addEventListener('contextmenu', (event) => {
  event.preventDefault()
})

uiPanel.addEventListener('contextmenu', (event) => {
  event.preventDefault()
})

collapseToggle.addEventListener('pointerdown', (event) => {
  event.stopPropagation()
})

collapseToggle.addEventListener('click', () => {
  const collapsed = uiPanel.classList.toggle('is-collapsed')
  collapseToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true')
  clampPanelToViewport()
})

uiHandleTop.addEventListener('pointerdown', beginPanelDrag)
uiHandleBottom.addEventListener('pointerdown', beginPanelDrag)

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
      if (!hasActivatedInflation) {
        controls.enabled = true
        return
      }

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
        pointInOutline(groundVector, getCurvedOutlinePoints(selectedOutline.outline.points)) ||
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

window.addEventListener('pointermove', (event) => {
  if (!draggingPanel) {
    return
  }

  uiPanel.style.left = `${event.clientX - panelDragOffset.x}px`
  uiPanel.style.top = `${event.clientY - panelDragOffset.y}px`
  uiPanel.style.right = 'auto'
  uiPanel.style.bottom = 'auto'
  clampPanelToViewport()
})

window.addEventListener('pointerup', (event) => {
  if (!draggingPanel) {
    return
  }

  draggingPanel = false
  if (uiHandleTop.hasPointerCapture(event.pointerId)) {
    uiHandleTop.releasePointerCapture(event.pointerId)
  }
  if (uiHandleBottom.hasPointerCapture(event.pointerId)) {
    uiHandleBottom.releasePointerCapture(event.pointerId)
  }
})

window.addEventListener('pointercancel', (event) => {
  if (!draggingPanel) {
    return
  }

  draggingPanel = false
  if (uiHandleTop.hasPointerCapture(event.pointerId)) {
    uiHandleTop.releasePointerCapture(event.pointerId)
  }
  if (uiHandleBottom.hasPointerCapture(event.pointerId)) {
    uiHandleBottom.releasePointerCapture(event.pointerId)
  }
})

window.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.repeat || isTypingInUi() || pillowSimulations.length > 0) {
    return
  }

  const selectedOutline = getSelectedOutlineRecord()
  if (selectedOutline && internalPathDraft.length > 0) {
    event.preventDefault()
    finalizeInternalPath(selectedOutline, false)
    return
  }

  const activeOutline = getActiveOutline()
  if (
    activeOutline.points.length >= 3 &&
    !activeOutline.closed &&
    activeOutline.valid &&
    internalPathDraft.length === 0
  ) {
    event.preventDefault()
    closeActiveOutline()
  }
})

window.addEventListener('resize', onResize)

function onResize(): void {
  const width = window.innerWidth
  const height = window.innerHeight

  camera.aspect = width / height
  camera.updateProjectionMatrix()
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(width, height, false)
  clampPanelToViewport()
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
bindSectionCollapses()
outerSeamCurvatureValue.textContent = `${outerSeamCurvature}`
innerSeamCurvatureValue.textContent = `${innerSeamCurvature}`
updateRangeProgress(outerSeamCurvatureSlider)
updateRangeProgress(innerSeamCurvatureSlider)
applyReflectionState()
requestAnimationFrame(() => {
  document.documentElement.classList.add('ui-ready')
})

window.addEventListener('beforeunload', () => {
  reflectionEnvironment.dispose()
})
renderer.setAnimationLoop(animate)
