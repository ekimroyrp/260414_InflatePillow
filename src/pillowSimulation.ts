import * as THREE from 'three'

import { buildFlatMeshData, type FlatMeshData, type OutlinePoint, type TriangleIndices } from './geometry'

interface SpringConstraint {
  a: number
  b: number
  restLength: number
  stiffness: number
}

interface PairConstraint {
  front: number
  back: number
  stiffness: number
}

export interface SimulationParams {
  pressure: number
  pressureScale: number
  pressureResponse: number
  damping: number
  substeps: number
  constraintIterations: number
  stiffness: number
  pairStiffness: number
  profileStiffness: number
  maxBulgeScale: number
  maxDeltaTime: number
}

export interface PillowSimulationState {
  currentPressure: number
  targetPressure: number
  positions: THREE.Vector3[]
  velocities: THREE.Vector3[]
  basePositions: THREE.Vector3[]
  seamIndices: number[]
  springs: SpringConstraint[]
  triangles: TriangleIndices[]
  frontTriangles: TriangleIndices[]
  backTriangles: TriangleIndices[]
  geometry: THREE.BufferGeometry
}

const DEFAULT_PARAMS: SimulationParams = {
  pressure: 0,
  pressureScale: 26,
  pressureResponse: 1.9,
  damping: 4.2,
  substeps: 5,
  constraintIterations: 10,
  stiffness: 0.76,
  pairStiffness: 0.7,
  profileStiffness: 0.2,
  maxBulgeScale: 1.2,
  maxDeltaTime: 1 / 24,
}

export class PillowSimulation {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  readonly state: PillowSimulationState

  private readonly wireOverlay: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>
  private readonly forces: THREE.Vector3[]
  private readonly previousPositions: THREE.Vector3[]
  private readonly pinnedMask: boolean[]
  private readonly pairConstraints: PairConstraint[]
  private readonly inflationWeights: number[]
  private readonly inflationSigns: number[]
  private readonly maxBulge: number
  private readonly params: SimulationParams
  private readonly tempVectorA = new THREE.Vector3()
  private readonly tempVectorB = new THREE.Vector3()
  private readonly tempVectorC = new THREE.Vector3()

  constructor(outline: readonly OutlinePoint[], params: Partial<SimulationParams> = {}) {
    this.params = {
      ...DEFAULT_PARAMS,
      ...params,
    }

    const flatMesh = buildFlatMeshData(outline)
    const simData = createSimulationTopology(flatMesh, this.params)

    this.pinnedMask = simData.pinnedMask
    this.pairConstraints = simData.pairConstraints
    this.inflationWeights = simData.inflationWeights
    this.inflationSigns = simData.inflationSigns
    this.maxBulge = simData.maxBulge

    const geometry = new THREE.BufferGeometry()
    const positionsArray = new Float32Array(simData.positions.length * 3)
    const indices = [...simData.frontTriangles, ...simData.backTriangles].flat()

    geometry.setAttribute('position', new THREE.BufferAttribute(positionsArray, 3))
    geometry.setIndex(indices)

    this.state = {
      currentPressure: this.params.pressure,
      targetPressure: this.params.pressure,
      positions: simData.positions,
      velocities: simData.velocities,
      basePositions: simData.basePositions,
      seamIndices: simData.seamIndices,
      springs: simData.springs,
      triangles: [...simData.frontTriangles, ...simData.backTriangles],
      frontTriangles: simData.frontTriangles,
      backTriangles: simData.backTriangles,
      geometry,
    }

    this.forces = simData.positions.map(() => new THREE.Vector3())
    this.previousPositions = simData.positions.map((position) => position.clone())

    this.mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({
        color: 0xc2d5f2,
        roughness: 0.86,
        metalness: 0.04,
      }),
    )
    this.wireOverlay = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        color: 0x37506c,
        wireframe: true,
        transparent: true,
        opacity: 0.3,
        depthWrite: false,
      }),
    )
    this.wireOverlay.visible = false
    this.wireOverlay.renderOrder = 2
    this.mesh.add(this.wireOverlay)
    this.mesh.castShadow = true
    this.mesh.receiveShadow = true

    this.syncGeometry()
  }

  update(deltaTime: number, targetPressure: number): void {
    this.state.targetPressure = Math.max(0, targetPressure)
    const stepDelta = Math.min(deltaTime, this.params.maxDeltaTime)
    const substepDelta = stepDelta / this.params.substeps

    for (let substep = 0; substep < this.params.substeps; substep += 1) {
      this.step(substepDelta)
    }

    this.syncGeometry()
  }

  reset(): void {
    this.state.currentPressure = 0
    this.state.targetPressure = 0

    for (let index = 0; index < this.state.positions.length; index += 1) {
      this.state.positions[index].copy(this.state.basePositions[index])
      this.state.velocities[index].set(0, 0, 0)
      this.previousPositions[index].copy(this.state.basePositions[index])
    }

    this.syncGeometry()
  }

  setWireframeVisible(visible: boolean): void {
    this.wireOverlay.visible = visible
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
    this.wireOverlay.material.dispose()
  }

  private step(deltaTime: number): void {
    this.state.currentPressure = THREE.MathUtils.damp(
      this.state.currentPressure,
      this.state.targetPressure,
      this.params.pressureResponse,
      deltaTime,
    )

    for (let index = 0; index < this.state.positions.length; index += 1) {
      this.previousPositions[index].copy(this.state.positions[index])
      this.forces[index].set(0, 0, 0)
    }

    this.applyPressureForces(this.state.frontTriangles)
    this.applyPressureForces(this.state.backTriangles)

    const dampingFactor = Math.exp(-this.params.damping * deltaTime)
    for (let index = 0; index < this.state.positions.length; index += 1) {
      if (this.pinnedMask[index]) {
        continue
      }

      this.state.velocities[index].addScaledVector(this.forces[index], deltaTime)
      this.state.velocities[index].multiplyScalar(dampingFactor)
      this.state.positions[index].addScaledVector(this.state.velocities[index], deltaTime)
    }

    for (let iteration = 0; iteration < this.params.constraintIterations; iteration += 1) {
      this.solveSpringConstraints()
      this.solvePairConstraints()
      this.solveInflationProfile()
      this.solveSeamConstraints()
    }

    const inverseDelta = deltaTime > 0 ? 1 / deltaTime : 0
    for (let index = 0; index < this.state.positions.length; index += 1) {
      if (this.pinnedMask[index]) {
        this.state.velocities[index].set(0, 0, 0)
        continue
      }

      this.state.velocities[index]
        .copy(this.state.positions[index])
        .sub(this.previousPositions[index])
        .multiplyScalar(inverseDelta)
    }
  }

  private applyPressureForces(triangles: readonly TriangleIndices[]): void {
    const strength = this.state.currentPressure * this.params.pressureScale
    if (strength < 1e-5) {
      return
    }

    for (const [indexA, indexB, indexC] of triangles) {
      const positionA = this.state.positions[indexA]
      const positionB = this.state.positions[indexB]
      const positionC = this.state.positions[indexC]

      this.tempVectorA.subVectors(positionB, positionA)
      this.tempVectorB.subVectors(positionC, positionA)
      this.tempVectorC.crossVectors(this.tempVectorA, this.tempVectorB).multiplyScalar(0.5 * strength / 3)

      this.forces[indexA].add(this.tempVectorC)
      this.forces[indexB].add(this.tempVectorC)
      this.forces[indexC].add(this.tempVectorC)
    }
  }

  private solveSpringConstraints(): void {
    for (const spring of this.state.springs) {
      const positionA = this.state.positions[spring.a]
      const positionB = this.state.positions[spring.b]
      this.tempVectorA.subVectors(positionB, positionA)
      const currentLength = this.tempVectorA.length()

      if (currentLength < 1e-6) {
        continue
      }

      const stretch = (currentLength - spring.restLength) / currentLength
      const correction = this.tempVectorA.multiplyScalar(stretch * spring.stiffness)
      const pinnedA = this.pinnedMask[spring.a]
      const pinnedB = this.pinnedMask[spring.b]

      if (!pinnedA && !pinnedB) {
        positionA.addScaledVector(correction, 0.5)
        positionB.addScaledVector(correction, -0.5)
      } else if (!pinnedA) {
        positionA.add(correction)
      } else if (!pinnedB) {
        positionB.addScaledVector(correction, -1)
      }
    }
  }

  private solvePairConstraints(): void {
    for (const constraint of this.pairConstraints) {
      const front = this.state.positions[constraint.front]
      const back = this.state.positions[constraint.back]

      const averageX = (front.x + back.x) * 0.5
      const averageZ = (front.z + back.z) * 0.5
      const mirroredHeight = (front.y - back.y) * 0.5

      front.x = THREE.MathUtils.lerp(front.x, averageX, constraint.stiffness)
      front.z = THREE.MathUtils.lerp(front.z, averageZ, constraint.stiffness)
      back.x = THREE.MathUtils.lerp(back.x, averageX, constraint.stiffness)
      back.z = THREE.MathUtils.lerp(back.z, averageZ, constraint.stiffness)

      front.y = THREE.MathUtils.lerp(front.y, mirroredHeight, constraint.stiffness)
      back.y = THREE.MathUtils.lerp(back.y, -mirroredHeight, constraint.stiffness)
    }
  }

  private solveInflationProfile(): void {
    const inflatedPressure = 1 - Math.pow(1 - this.state.currentPressure, 2)
    for (let index = 0; index < this.state.positions.length; index += 1) {
      if (this.pinnedMask[index]) {
        continue
      }

      const weight = this.inflationWeights[index]
      const sign = this.inflationSigns[index]
      if (weight <= 0 || sign === 0) {
        continue
      }

      const desiredHeight = sign * weight * inflatedPressure * this.maxBulge
      this.state.positions[index].y = THREE.MathUtils.lerp(
        this.state.positions[index].y,
        desiredHeight,
        this.params.profileStiffness,
      )
    }
  }

  private solveSeamConstraints(): void {
    for (const seamIndex of this.state.seamIndices) {
      this.state.positions[seamIndex].copy(this.state.basePositions[seamIndex])
    }
  }

  private syncGeometry(): void {
    const positionAttribute = this.state.geometry.getAttribute('position') as THREE.BufferAttribute

    for (let index = 0; index < this.state.positions.length; index += 1) {
      const position = this.state.positions[index]
      positionAttribute.setXYZ(index, position.x, position.y, position.z)
    }

    positionAttribute.needsUpdate = true
    this.state.geometry.computeVertexNormals()
    this.state.geometry.computeBoundingSphere()
  }
}

export function buildPillowFromOutline(
  outline: readonly OutlinePoint[],
  params?: Partial<SimulationParams>,
): PillowSimulation {
  return new PillowSimulation(outline, params)
}

function createSimulationTopology(flatMesh: FlatMeshData, params: SimulationParams): {
  positions: THREE.Vector3[]
  velocities: THREE.Vector3[]
  basePositions: THREE.Vector3[]
  seamIndices: number[]
  springs: SpringConstraint[]
  frontTriangles: TriangleIndices[]
  backTriangles: TriangleIndices[]
  pairConstraints: PairConstraint[]
  pinnedMask: boolean[]
  inflationWeights: number[]
  inflationSigns: number[]
  maxBulge: number
} {
  const positions: THREE.Vector3[] = []
  const velocities: THREE.Vector3[] = []
  const basePositions: THREE.Vector3[] = []
  const pinnedMask: boolean[] = []
  const pairConstraints: PairConstraint[] = []
  const seamIndices: number[] = []
  const inflationWeights: number[] = []
  const inflationSigns: number[] = []
  const frontMap = new Array<number>(flatMesh.vertices.length)
  const backMap = new Array<number>(flatMesh.vertices.length)
  const contourWeights = buildContourWeights(flatMesh)
  const maxBulge = THREE.MathUtils.clamp(contourWeights.maxDistance * params.maxBulgeScale, 0.35, 2.75)

  for (let index = 0; index < flatMesh.vertices.length; index += 1) {
    const vertex = flatMesh.vertices[index]
    const basePosition = new THREE.Vector3(vertex.x, 0, vertex.y)
    const vertexWeight = contourWeights.weights[index]

    if (flatMesh.boundaryVertexIndices.has(index)) {
      const seamIndex = positions.length
      positions.push(basePosition.clone())
      velocities.push(new THREE.Vector3())
      basePositions.push(basePosition)
      pinnedMask.push(true)
      seamIndices.push(seamIndex)
      inflationWeights.push(0)
      inflationSigns.push(0)
      frontMap[index] = seamIndex
      backMap[index] = seamIndex
      continue
    }

    const frontIndex = positions.length
    positions.push(basePosition.clone())
    velocities.push(new THREE.Vector3())
    basePositions.push(basePosition.clone())
    pinnedMask.push(false)
    inflationWeights.push(vertexWeight)
    inflationSigns.push(-1)
    frontMap[index] = frontIndex

    const backIndex = positions.length
    positions.push(basePosition.clone())
    velocities.push(new THREE.Vector3())
    basePositions.push(basePosition.clone())
    pinnedMask.push(false)
    inflationWeights.push(vertexWeight)
    inflationSigns.push(1)
    backMap[index] = backIndex

    pairConstraints.push({
      front: frontIndex,
      back: backIndex,
      stiffness: params.pairStiffness,
    })
  }

  const frontTriangles = flatMesh.triangles.map(
    ([indexA, indexB, indexC]) =>
      [frontMap[indexA], frontMap[indexB], frontMap[indexC]] satisfies TriangleIndices,
  )
  const backTriangles = flatMesh.triangles.map(
    ([indexA, indexB, indexC]) =>
      [backMap[indexC], backMap[indexB], backMap[indexA]] satisfies TriangleIndices,
  )

  const springs = buildSpringConstraints(frontTriangles, backTriangles, positions, params.stiffness)

  return {
    positions,
    velocities,
    basePositions,
    seamIndices,
    springs,
    frontTriangles,
    backTriangles,
    pairConstraints,
    pinnedMask,
    inflationWeights,
    inflationSigns,
    maxBulge,
  }
}

function buildContourWeights(flatMesh: FlatMeshData): { weights: number[]; maxDistance: number } {
  const boundaryVertices = [...flatMesh.boundaryVertexIndices].map((index) => flatMesh.vertices[index])
  const rawDistances = flatMesh.vertices.map((vertex, index) => {
    if (flatMesh.boundaryVertexIndices.has(index)) {
      return 0
    }

    let minDistance = Number.POSITIVE_INFINITY
    for (const boundaryVertex of boundaryVertices) {
      minDistance = Math.min(minDistance, vertex.distanceTo(boundaryVertex))
    }

    return Number.isFinite(minDistance) ? minDistance : 0
  })

  const maxDistance = Math.max(...rawDistances, 0.001)
  const normalizedDistances = rawDistances.map((distance) =>
    THREE.MathUtils.clamp(distance / maxDistance, 0, 1),
  )
  const adjacency = buildVertexAdjacency(flatMesh.vertices.length, flatMesh.triangles)
  let smoothedWeights = normalizedDistances.slice()

  for (let iteration = 0; iteration < 6; iteration += 1) {
    const nextWeights = smoothedWeights.slice()

    for (let index = 0; index < smoothedWeights.length; index += 1) {
      if (flatMesh.boundaryVertexIndices.has(index)) {
        continue
      }

      const neighbors = adjacency[index]
      if (neighbors.length === 0) {
        continue
      }

      const neighborAverage =
        neighbors.reduce((sum, neighborIndex) => sum + smoothedWeights[neighborIndex], 0) /
        neighbors.length

      nextWeights[index] = THREE.MathUtils.lerp(smoothedWeights[index], neighborAverage, 0.18)
    }

    smoothedWeights = nextWeights
  }

  const smoothedMax = Math.max(...smoothedWeights, 0.001)
  const weights = smoothedWeights.map((weight, index) => {
    if (flatMesh.boundaryVertexIndices.has(index)) {
      return 0
    }

    const normalized = THREE.MathUtils.clamp(weight / smoothedMax, 0, 1)
    return applyInflationRamp(normalized)
  })

  return { weights, maxDistance }
}

function buildVertexAdjacency(
  vertexCount: number,
  triangles: readonly TriangleIndices[],
): number[][] {
  const adjacency = Array.from({ length: vertexCount }, () => new Set<number>())

  for (const [indexA, indexB, indexC] of triangles) {
    adjacency[indexA].add(indexB)
    adjacency[indexA].add(indexC)
    adjacency[indexB].add(indexA)
    adjacency[indexB].add(indexC)
    adjacency[indexC].add(indexA)
    adjacency[indexC].add(indexB)
  }

  return adjacency.map((neighbors) => [...neighbors])
}

function applyInflationRamp(normalizedDistance: number): number {
  const base = THREE.MathUtils.clamp(normalizedDistance, 0, 1)
  const edgeLift = 1 - Math.pow(1 - base, 1.65)
  const crownFill = 1 - Math.pow(1 - base, 3.2)
  const crownBlend = THREE.MathUtils.smoothstep(base, 0.58, 0.98)
  return THREE.MathUtils.lerp(edgeLift, crownFill, crownBlend * 0.42)
}

function buildSpringConstraints(
  frontTriangles: readonly TriangleIndices[],
  backTriangles: readonly TriangleIndices[],
  positions: readonly THREE.Vector3[],
  stiffness: number,
): SpringConstraint[] {
  const edgeMap = new Map<string, SpringConstraint>()

  const addTriangleEdges = ([indexA, indexB, indexC]: TriangleIndices): void => {
    addEdge(edgeMap, indexA, indexB, positions, stiffness)
    addEdge(edgeMap, indexB, indexC, positions, stiffness)
    addEdge(edgeMap, indexC, indexA, positions, stiffness)
  }

  frontTriangles.forEach(addTriangleEdges)
  backTriangles.forEach(addTriangleEdges)

  return [...edgeMap.values()]
}

function addEdge(
  edgeMap: Map<string, SpringConstraint>,
  indexA: number,
  indexB: number,
  positions: readonly THREE.Vector3[],
  stiffness: number,
): void {
  const edgeKey = indexA < indexB ? `${indexA}:${indexB}` : `${indexB}:${indexA}`
  if (edgeMap.has(edgeKey)) {
    return
  }

  edgeMap.set(edgeKey, {
    a: indexA,
    b: indexB,
    restLength: positions[indexA].distanceTo(positions[indexB]),
    stiffness,
  })
}
