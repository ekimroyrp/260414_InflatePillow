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

interface PressState {
  localPoint: THREE.Vector3
  side: number
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
  rippleStiffness: number
  rippleDamping: number
  rippleRestore: number
  pressDepth: number
  pressStiffness: number
  releaseImpulse: number
  interactionRadiusScale: number
  collisionMinGap: number
  collisionGapScale: number
  collisionStiffness: number
  collisionPushBias: number
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
  rippleStiffness: 38,
  rippleDamping: 7.6,
  rippleRestore: 9.5,
  pressDepth: 0.72,
  pressStiffness: 56,
  releaseImpulse: 2.6,
  interactionRadiusScale: 1.6,
  collisionMinGap: 0.05,
  collisionGapScale: 0.18,
  collisionStiffness: 0.9,
  collisionPushBias: 0.78,
}

const MIDPLANE_EPSILON = 0.0025

export class PillowSimulation {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  readonly state: PillowSimulationState

  private readonly wireOverlay: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>
  private readonly forces: THREE.Vector3[]
  private readonly previousPositions: THREE.Vector3[]
  private readonly pinnedMask: boolean[]
  private readonly pairConstraints: PairConstraint[]
  private readonly rippleAdjacency: number[][]
  private readonly rippleOffsets: number[]
  private readonly rippleVelocities: number[]
  private readonly inflationWeights: number[]
  private readonly inflationSigns: number[]
  private readonly maxBulge: number
  private readonly interactionRadius: number
  private readonly params: SimulationParams
  private pressState: PressState | null = null
  private readonly tempVectorA = new THREE.Vector3()
  private readonly tempVectorB = new THREE.Vector3()
  private readonly tempVectorC = new THREE.Vector3()
  private readonly tempVectorD = new THREE.Vector3()

  constructor(
    outline: readonly OutlinePoint[],
    internalSeams: readonly (readonly OutlinePoint[])[] = [],
    seamCurvature = 1,
    params: Partial<SimulationParams> = {},
  ) {
    this.params = {
      ...DEFAULT_PARAMS,
      ...params,
    }

    const flatMesh = buildFlatMeshData(outline, internalSeams, seamCurvature)
    const simData = createSimulationTopology(flatMesh, this.params)

    this.pinnedMask = simData.pinnedMask
    this.pairConstraints = simData.pairConstraints
    this.rippleAdjacency = simData.adjacency
    this.rippleOffsets = simData.positions.map(() => 0)
    this.rippleVelocities = simData.positions.map(() => 0)
    this.inflationWeights = simData.inflationWeights
    this.inflationSigns = simData.inflationSigns
    this.maxBulge = simData.maxBulge
    this.interactionRadius = THREE.MathUtils.clamp(
      simData.maxBulge * this.params.interactionRadiusScale,
      0.45,
      2.1,
    )

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
    this.mesh.receiveShadow = false
    this.mesh.userData.simulation = this

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
    this.pressState = null

    for (let index = 0; index < this.state.positions.length; index += 1) {
      this.state.positions[index].copy(this.state.basePositions[index])
      this.state.velocities[index].set(0, 0, 0)
      this.previousPositions[index].copy(this.state.basePositions[index])
      this.rippleOffsets[index] = 0
      this.rippleVelocities[index] = 0
    }

    this.syncGeometry()
  }

  beginPress(worldPoint: THREE.Vector3): void {
    this.pressState = {
      localPoint: this.mesh.worldToLocal(worldPoint.clone()),
      side: this.mesh.worldToLocal(worldPoint.clone()).y >= 0 ? 1 : -1,
    }
  }

  updatePress(worldPoint: THREE.Vector3): void {
    if (!this.pressState) {
      return
    }

    const localPoint = this.mesh.worldToLocal(worldPoint.clone())
    this.pressState = {
      localPoint,
      side: localPoint.y >= 0 ? 1 : -1,
    }
  }

  endPress(releaseBoost = 1, tapIndent = 0): void {
    if (!this.pressState) {
      return
    }

    const releasePoint = this.pressState.localPoint.clone()
    const releaseSide = this.pressState.side
    this.pressState = null

    for (let index = 0; index < this.state.positions.length; index += 1) {
      if (this.pinnedMask[index]) {
        continue
      }

      const influence = this.getPressInfluence(index, releasePoint)
      if (influence <= 0) {
        continue
      }

      const sign = Math.sign(this.inflationSigns[index])
      if (sign === 0) {
        continue
      }

      const clickedSideBlend = THREE.MathUtils.lerp(0.12, 1, Math.max(0, sign * releaseSide))
      if (tapIndent > 0) {
        const tapOffset = -releaseSide * this.params.pressDepth * tapIndent * influence * clickedSideBlend
        this.rippleOffsets[index] = THREE.MathUtils.lerp(this.rippleOffsets[index], tapOffset, 0.78)
      }

      this.rippleVelocities[index] +=
        releaseSide *
        this.params.releaseImpulse *
        releaseBoost *
        influence *
        clickedSideBlend
    }
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
    this.updateRippleField(deltaTime)

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
      this.solveSheetCollisions()
      this.solveMidplaneCaps()
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

      front.x = THREE.MathUtils.lerp(front.x, averageX, constraint.stiffness)
      front.z = THREE.MathUtils.lerp(front.z, averageZ, constraint.stiffness)
      back.x = THREE.MathUtils.lerp(back.x, averageX, constraint.stiffness)
      back.z = THREE.MathUtils.lerp(back.z, averageZ, constraint.stiffness)
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

      const desiredHeight = sign * weight * inflatedPressure * this.maxBulge + this.rippleOffsets[index]
      this.state.positions[index].y = THREE.MathUtils.lerp(
        this.state.positions[index].y,
        desiredHeight,
        this.params.profileStiffness,
      )
    }
  }

  private solveSeamConstraints(): void {
    for (const seamIndex of this.state.seamIndices) {
      this.rippleOffsets[seamIndex] = 0
      this.rippleVelocities[seamIndex] = 0
      this.state.positions[seamIndex].copy(this.state.basePositions[seamIndex])
    }
  }

  private solveSheetCollisions(): void {
    const inflatedPressure = 1 - Math.pow(1 - this.state.currentPressure, 2)

    for (const constraint of this.pairConstraints) {
      const frontIndex = constraint.front
      const backIndex = constraint.back
      const front = this.state.positions[frontIndex]
      const back = this.state.positions[backIndex]

      const upperIndex = back.y >= front.y ? backIndex : frontIndex
      const lowerIndex = upperIndex === backIndex ? frontIndex : backIndex
      const upper = this.state.positions[upperIndex]
      const lower = this.state.positions[lowerIndex]

      const weight = Math.max(
        this.inflationWeights[frontIndex],
        this.inflationWeights[backIndex],
      )
      const minGap =
        this.params.collisionMinGap +
        weight * inflatedPressure * this.maxBulge * this.params.collisionGapScale

      const currentGap = upper.y - lower.y
      if (currentGap >= minGap) {
        continue
      }

      const correction = (minGap - currentGap) * this.params.collisionStiffness
      let upperShare = 0.5
      let lowerShare = 0.5

      if (this.pressState) {
        const pressedSide = Math.sign(this.pressState.side)
        const upperSign = Math.sign(this.inflationSigns[upperIndex])
        const lowerSign = Math.sign(this.inflationSigns[lowerIndex])

        if (pressedSide !== 0) {
          if (upperSign === pressedSide) {
            upperShare = 1 - this.params.collisionPushBias
            lowerShare = this.params.collisionPushBias
          } else if (lowerSign === pressedSide) {
            upperShare = this.params.collisionPushBias
            lowerShare = 1 - this.params.collisionPushBias
          }
        }
      }

      upper.y += correction * upperShare
      lower.y -= correction * lowerShare
    }
  }

  private solveMidplaneCaps(): void {
    const inflatedPressure = 1 - Math.pow(1 - this.state.currentPressure, 2)

    for (let index = 0; index < this.state.positions.length; index += 1) {
      if (this.pinnedMask[index]) {
        continue
      }

      const sign = Math.sign(this.inflationSigns[index])
      if (sign === 0) {
        continue
      }

      const weight = this.inflationWeights[index]
      const baseHeight = sign * weight * inflatedPressure * this.maxBulge

      if (sign > 0) {
        this.rippleOffsets[index] = Math.max(this.rippleOffsets[index], -baseHeight)

        if (this.state.positions[index].y < MIDPLANE_EPSILON) {
          this.state.positions[index].y = MIDPLANE_EPSILON
          this.previousPositions[index].y = MIDPLANE_EPSILON
          if (this.state.velocities[index].y < 0) {
            this.state.velocities[index].y = 0
          }
          if (this.rippleVelocities[index] < 0) {
            this.rippleVelocities[index] = 0
          }
        }
      } else {
        this.rippleOffsets[index] = Math.min(this.rippleOffsets[index], -baseHeight)

        if (this.state.positions[index].y > -MIDPLANE_EPSILON) {
          this.state.positions[index].y = -MIDPLANE_EPSILON
          this.previousPositions[index].y = -MIDPLANE_EPSILON
          if (this.state.velocities[index].y > 0) {
            this.state.velocities[index].y = 0
          }
          if (this.rippleVelocities[index] > 0) {
            this.rippleVelocities[index] = 0
          }
        }
      }
    }
  }

  private updateRippleField(deltaTime: number): void {
    const accelerations = new Array<number>(this.rippleOffsets.length).fill(0)

    for (let index = 0; index < this.rippleOffsets.length; index += 1) {
      if (this.pinnedMask[index]) {
        continue
      }

      const neighbors = this.rippleAdjacency[index]
      if (neighbors.length > 0) {
        const neighborAverage =
          neighbors.reduce((sum, neighborIndex) => sum + this.rippleOffsets[neighborIndex], 0) /
          neighbors.length
        accelerations[index] +=
          (neighborAverage - this.rippleOffsets[index]) * this.params.rippleStiffness
      }

      accelerations[index] += -this.rippleOffsets[index] * this.params.rippleRestore
      accelerations[index] += -this.rippleVelocities[index] * this.params.rippleDamping

      if (this.pressState) {
        const targetOffset = this.getPressTargetOffset(index, this.pressState)
        accelerations[index] +=
          (targetOffset - this.rippleOffsets[index]) * this.params.pressStiffness
      }
    }

    const maxOffset = this.maxBulge * 0.72
    for (let index = 0; index < this.rippleOffsets.length; index += 1) {
      if (this.pinnedMask[index]) {
        continue
      }

      this.rippleVelocities[index] += accelerations[index] * deltaTime
      this.rippleOffsets[index] = THREE.MathUtils.clamp(
        this.rippleOffsets[index] + this.rippleVelocities[index] * deltaTime,
        -maxOffset,
        maxOffset,
      )
    }
  }

  private getPressTargetOffset(index: number, pressState: PressState): number {
    const influence = this.getPressInfluence(index, pressState.localPoint)
    if (influence <= 0) {
      return 0
    }

    const sign = Math.sign(this.inflationSigns[index])
    if (sign === 0) {
      return 0
    }

    const clickedSideBlend = THREE.MathUtils.lerp(0.12, 1, Math.max(0, sign * pressState.side))
    return -pressState.side * this.params.pressDepth * influence * clickedSideBlend
  }

  private getPressInfluence(index: number, localPoint: THREE.Vector3): number {
    const position = this.state.positions[index]
    this.tempVectorD.set(position.x, 0, position.z)
    const planarDistance = this.tempVectorD.distanceToSquared(
      this.tempVectorA.set(localPoint.x, 0, localPoint.z),
    )
    const normalizedDistance = Math.sqrt(planarDistance) / this.interactionRadius
    if (normalizedDistance >= 1) {
      return 0
    }

    const falloff = 1 - normalizedDistance
    return falloff * falloff * (3 - 2 * falloff)
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
  internalSeams: readonly (readonly OutlinePoint[])[] = [],
  seamCurvature = 1,
  params?: Partial<SimulationParams>,
): PillowSimulation {
  return new PillowSimulation(outline, internalSeams, seamCurvature, params)
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
  adjacency: number[][]
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
  const maxBulge = THREE.MathUtils.clamp(contourWeights.maxDistance * params.maxBulgeScale, 0.24, 2.75)

  for (let index = 0; index < flatMesh.vertices.length; index += 1) {
    const vertex = flatMesh.vertices[index]
    const basePosition = new THREE.Vector3(vertex.x, 0, vertex.y)
    const vertexWeight = contourWeights.weights[index]

    if (flatMesh.stitchedVertexIndices.has(index)) {
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
  const adjacency = buildVertexAdjacency(positions.length, [...frontTriangles, ...backTriangles])

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
    adjacency,
    inflationWeights,
    inflationSigns,
    maxBulge,
  }
}

function buildContourWeights(flatMesh: FlatMeshData): { weights: number[]; maxDistance: number } {
  const rawDistances = flatMesh.vertices.map((vertex, index) => {
    if (flatMesh.stitchedVertexIndices.has(index)) {
      return 0
    }

    let minDistance = Number.POSITIVE_INFINITY
    for (const seamPath of flatMesh.seamPaths) {
      minDistance = Math.min(
        minDistance,
        distanceToSeamPath(vertex, seamPath.points, seamPath.closed),
      )
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
      if (flatMesh.stitchedVertexIndices.has(index)) {
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
    if (flatMesh.stitchedVertexIndices.has(index)) {
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

function distanceToSeamPath(
  point: THREE.Vector2,
  seamPath: readonly THREE.Vector2[],
  closed: boolean,
): number {
  let minDistanceSquared = Number.POSITIVE_INFINITY
  const segmentCount = closed ? seamPath.length : seamPath.length - 1

  for (let index = 0; index < segmentCount; index += 1) {
    const start = seamPath[index]
    const end = seamPath[(index + 1) % seamPath.length]
    minDistanceSquared = Math.min(
      minDistanceSquared,
      distanceToSegmentSquared(point, start, end),
    )
  }

  return Math.sqrt(minDistanceSquared)
}

function distanceToSegmentSquared(
  point: THREE.Vector2,
  start: THREE.Vector2,
  end: THREE.Vector2,
): number {
  const segment = end.clone().sub(start)
  const segmentLengthSquared = segment.lengthSq()

  if (segmentLengthSquared < 1e-6) {
    return point.distanceToSquared(start)
  }

  const projection = THREE.MathUtils.clamp(
    point.clone().sub(start).dot(segment) / segmentLengthSquared,
    0,
    1,
  )
  const closestPoint = start.clone().add(segment.multiplyScalar(projection))
  return point.distanceToSquared(closestPoint)
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
