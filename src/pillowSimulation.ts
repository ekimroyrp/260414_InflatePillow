import * as THREE from 'three'

import {
  buildFlatMeshData,
  type FlatMeshData,
  type InternalSeamInput,
  type OutlinePoint,
  type TriangleIndices,
} from './geometry'

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

interface PillowMaterialStyle {
  color: number
  metalness: number
  roughness: number
  clearcoat: number
  clearcoatRoughness: number
  envMapIntensity: number
  iridescence: number
  iridescenceIOR: number
  iridescenceThicknessRange: [number, number]
  reflectivity: number
  specularIntensity: number
  sheen: number
  sheenRoughness: number
  sheenColor: number
  eggIridescence: number
  eggIridescenceFrequency: number
}

interface VertexStencil {
  indices: number[]
  weights: number[]
}

interface RenderTopology {
  vertexStencils: VertexStencil[]
  triangles: TriangleIndices[]
  indices: number[]
  wireEdgePairs: number[]
  creaseVertices: boolean[]
  creaseEdges: Set<string>
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
const WIRE_SURFACE_OFFSET = 0.008
const FOIL_MATERIAL_STYLE: PillowMaterialStyle = {
  color: 0xf1f5ff,
  metalness: 1,
  roughness: 0.28,
  clearcoat: 1,
  clearcoatRoughness: 0.24,
  envMapIntensity: 1.9,
  iridescence: 0.72,
  iridescenceIOR: 1.22,
  iridescenceThicknessRange: [140, 460] as [number, number],
  reflectivity: 1,
  specularIntensity: 1,
  sheen: 0.1,
  sheenRoughness: 0.5,
  sheenColor: 0xe7eeff,
  eggIridescence: 1.05,
  eggIridescenceFrequency: 1.25,
}

const MATTE_MATERIAL_STYLE: PillowMaterialStyle = {
  color: 0xc2d5f2,
  metalness: 0.04,
  roughness: 0.86,
  clearcoat: 0,
  clearcoatRoughness: 0,
  envMapIntensity: 0,
  iridescence: 0.18,
  iridescenceIOR: 1.22,
  iridescenceThicknessRange: [140, 460] as [number, number],
  reflectivity: 0.18,
  specularIntensity: 0.22,
  sheen: 0,
  sheenRoughness: 1,
  sheenColor: 0xffffff,
  eggIridescence: 0.42,
  eggIridescenceFrequency: 1.1,
}

export class PillowSimulation {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>
  readonly state: PillowSimulationState

  private displaySubdivisionLevel: number
  private readonly eggIridescenceState: {
    strength: number
    frequency: number
    uniforms:
      | null
      | {
          uEggIridescence: { value: number }
          uEggIridescenceFrequency: { value: number }
        }
  }
  private readonly renderTopologyCache = new Map<number, RenderTopology>()
  private wireEdgePairs: number[] = []
  private readonly wireOverlay: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>
  private readonly coarseRenderTopology: RenderTopology
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
    internalSeams: readonly InternalSeamInput[] = [],
    outerSeamCurvature = 1,
    innerSeamCurvature = 1,
    displaySubdivisionLevel = 0,
    params: Partial<SimulationParams> = {},
  ) {
    this.params = {
      ...DEFAULT_PARAMS,
      ...params,
    }

    const flatMesh = buildFlatMeshData(
      outline,
      internalSeams,
      outerSeamCurvature,
      innerSeamCurvature,
    )
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

    const combinedTriangles = [...simData.frontTriangles, ...simData.backTriangles]
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3))
    geometry.setIndex([])

    this.state = {
      currentPressure: this.params.pressure,
      targetPressure: this.params.pressure,
      positions: simData.positions,
      velocities: simData.velocities,
      basePositions: simData.basePositions,
      seamIndices: simData.seamIndices,
      springs: simData.springs,
      triangles: combinedTriangles,
      frontTriangles: simData.frontTriangles,
      backTriangles: simData.backTriangles,
      geometry,
    }

    this.forces = simData.positions.map(() => new THREE.Vector3())
    this.previousPositions = simData.positions.map((position) => position.clone())
    this.displaySubdivisionLevel = Math.max(0, Math.round(displaySubdivisionLevel))
    this.eggIridescenceState = {
      strength: FOIL_MATERIAL_STYLE.eggIridescence,
      frequency: FOIL_MATERIAL_STYLE.eggIridescenceFrequency,
      uniforms: null,
    }
    this.coarseRenderTopology = buildBaseRenderTopology(
      simData.positions.length,
      combinedTriangles,
      new Set(simData.seamIndices),
    )
    this.renderTopologyCache.set(0, this.coarseRenderTopology)

    this.mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshPhysicalMaterial({
        color: FOIL_MATERIAL_STYLE.color,
        metalness: FOIL_MATERIAL_STYLE.metalness,
        roughness: FOIL_MATERIAL_STYLE.roughness,
        clearcoat: FOIL_MATERIAL_STYLE.clearcoat,
        clearcoatRoughness: FOIL_MATERIAL_STYLE.clearcoatRoughness,
        envMapIntensity: FOIL_MATERIAL_STYLE.envMapIntensity,
        iridescence: FOIL_MATERIAL_STYLE.iridescence,
        iridescenceIOR: FOIL_MATERIAL_STYLE.iridescenceIOR,
        iridescenceThicknessRange: FOIL_MATERIAL_STYLE.iridescenceThicknessRange,
        reflectivity: FOIL_MATERIAL_STYLE.reflectivity,
        specularIntensity: FOIL_MATERIAL_STYLE.specularIntensity,
        sheen: FOIL_MATERIAL_STYLE.sheen,
        sheenRoughness: FOIL_MATERIAL_STYLE.sheenRoughness,
        sheenColor: new THREE.Color(FOIL_MATERIAL_STYLE.sheenColor),
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      }),
    )
    this.installEggIridescenceShader()
    const wireGeometry = new THREE.BufferGeometry()
    wireGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(0), 3),
    )

    this.wireOverlay = new THREE.LineSegments(
      wireGeometry,
      new THREE.LineBasicMaterial({
        color: 0x37506c,
        transparent: true,
        opacity: 0.38,
        depthWrite: false,
        toneMapped: false,
      }),
    )
    this.wireOverlay.visible = false
    this.wireOverlay.frustumCulled = false
    this.wireOverlay.renderOrder = 3
    this.mesh.add(this.wireOverlay)
    this.mesh.castShadow = true
    this.mesh.receiveShadow = false
    this.mesh.userData.simulation = this

    this.rebuildRenderGeometry()
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

  setSubdivisionLevel(level: number): void {
    const nextLevel = Math.max(0, Math.round(level))
    if (this.displaySubdivisionLevel === nextLevel) {
      return
    }

    this.displaySubdivisionLevel = nextLevel
    this.rebuildRenderGeometry()
    this.syncGeometry()
  }

  setReflectionEnabled(enabled: boolean): void {
    this.applyMaterialStyle(enabled ? FOIL_MATERIAL_STYLE : MATTE_MATERIAL_STYLE)
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
    this.wireOverlay.geometry.dispose()
    this.wireOverlay.material.dispose()
  }

  private applyMaterialStyle(style: PillowMaterialStyle): void {
    this.mesh.material.color.setHex(style.color)
    this.mesh.material.metalness = style.metalness
    this.mesh.material.roughness = style.roughness
    this.mesh.material.clearcoat = style.clearcoat
    this.mesh.material.clearcoatRoughness = style.clearcoatRoughness
    this.mesh.material.envMapIntensity = style.envMapIntensity
    this.mesh.material.iridescence = style.iridescence
    this.mesh.material.iridescenceIOR = style.iridescenceIOR
    this.mesh.material.iridescenceThicknessRange = [...style.iridescenceThicknessRange]
    this.mesh.material.reflectivity = style.reflectivity
    this.mesh.material.specularIntensity = style.specularIntensity
    this.mesh.material.sheen = style.sheen
    this.mesh.material.sheenRoughness = style.sheenRoughness
    this.mesh.material.sheenColor.setHex(style.sheenColor)
    this.eggIridescenceState.strength = style.eggIridescence
    this.eggIridescenceState.frequency = style.eggIridescenceFrequency
    if (this.eggIridescenceState.uniforms) {
      this.eggIridescenceState.uniforms.uEggIridescence.value = style.eggIridescence
      this.eggIridescenceState.uniforms.uEggIridescenceFrequency.value =
        style.eggIridescenceFrequency
    }
    this.mesh.material.needsUpdate = true
  }

  private installEggIridescenceShader(): void {
    this.mesh.material.customProgramCacheKey = () => 'pillow-egg-iridescence-v1'
    this.mesh.material.onBeforeCompile = (shader) => {
      const uniforms = {
        uEggIridescence: { value: this.eggIridescenceState.strength },
        uEggIridescenceFrequency: { value: this.eggIridescenceState.frequency },
      }
      this.eggIridescenceState.uniforms = uniforms
      shader.uniforms.uEggIridescence = uniforms.uEggIridescence
      shader.uniforms.uEggIridescenceFrequency = uniforms.uEggIridescenceFrequency

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
varying vec3 vEggIriWorldPosition;
varying vec3 vEggIriWorldNormal;`,
        )
        .replace(
          '#include <worldpos_vertex>',
          `#include <worldpos_vertex>
vEggIriWorldPosition = worldPosition.xyz;
vEggIriWorldNormal = normalize( mat3( modelMatrix ) * normal );`,
        )

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
uniform float uEggIridescence;
uniform float uEggIridescenceFrequency;
varying vec3 vEggIriWorldPosition;
varying vec3 vEggIriWorldNormal;

float eggSaturate01(float value) {
  return clamp(value, 0.0, 1.0);
}

float eggHash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 19.19);
  return fract((p.x + p.y) * p.z);
}

float eggSmoothNoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);

  float n000 = eggHash13(i + vec3(0.0, 0.0, 0.0));
  float n100 = eggHash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = eggHash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = eggHash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = eggHash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = eggHash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = eggHash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = eggHash13(i + vec3(1.0, 1.0, 1.0));

  float nx00 = mix(n000, n100, u.x);
  float nx10 = mix(n010, n110, u.x);
  float nx01 = mix(n001, n101, u.x);
  float nx11 = mix(n011, n111, u.x);
  float nxy0 = mix(nx00, nx10, u.y);
  float nxy1 = mix(nx01, nx11, u.y);
  return mix(nxy0, nxy1, u.z);
}

vec3 eggBismuthPalette(float t) {
  t = fract(t);
  vec3 c0 = vec3(1.00, 0.84, 0.20);
  vec3 c1 = vec3(1.00, 0.33, 0.77);
  vec3 c2 = vec3(0.18, 0.93, 1.00);
  vec3 c3 = vec3(0.30, 1.00, 0.46);
  if (t < 0.25) {
    return mix(c0, c1, t * 4.0);
  }
  if (t < 0.50) {
    return mix(c1, c2, (t - 0.25) * 4.0);
  }
  if (t < 0.75) {
    return mix(c2, c3, (t - 0.50) * 4.0);
  }
  return mix(c3, c0, (t - 0.75) * 4.0);
}

vec3 applyEggIridescence(vec3 baseColor) {
  float iriStrength = eggSaturate01(uEggIridescence);
  if (iriStrength <= 0.0001) {
    return baseColor;
  }

  vec3 n = normalize(vEggIriWorldNormal);
  vec3 viewDir = normalize(cameraPosition - vEggIriWorldPosition);
  float ndv = eggSaturate01(dot(n, viewDir));
  float jitter = eggSmoothNoise3(vEggIriWorldPosition * 1.5 + vec3(31.4));
  float broadNoise = eggSmoothNoise3(vEggIriWorldPosition * 0.48 + vec3(11.7));
  float bandFreq = max(0.2, uEggIridescenceFrequency);
  float facetBand =
    (vEggIriWorldPosition.y * 1.8 + vEggIriWorldPosition.x * 0.42 - vEggIriWorldPosition.z * 0.31) * bandFreq;
  float stepBand = (abs(vEggIriWorldPosition.x) + abs(vEggIriWorldPosition.z)) * 0.92;
  float swirl =
    0.5 +
    0.5 *
      sin(
        dot(vEggIriWorldPosition, vec3(0.73, 0.51, -0.46)) * bandFreq * 1.25 +
        broadNoise * 4.6 +
        6.283
      );
  float thicknessT = fract(facetBand * 0.123 + stepBand * 0.081 + swirl * 0.39 + jitter * 0.27 + 5.7);
  float thicknessNm = mix(120.0, 980.0, thicknessT);

  vec3 wavelengths = vec3(680.0, 540.0, 440.0);
  vec3 phase = (4.0 * 3.14159265 * 1.65 * thicknessNm * max(ndv, 0.08)) / wavelengths;
  vec3 interference = 0.5 + 0.5 * cos(phase + vec3(0.0, 2.094, 4.188));

  float hueSweep =
    fract(
      thicknessT * (0.55 + uEggIridescenceFrequency * 0.65) +
      dot(n, vec3(0.23, 0.11, -0.37)) * 0.18
    );
  vec3 oxidePalette = eggBismuthPalette(hueSweep);
  vec3 oxideColor = mix(interference, oxidePalette, 0.68);

  float fresnel = pow(1.0 - ndv, 2.2);
  float filmAmount = iriStrength * (0.48 + 0.52 * fresnel);
  vec3 branchTint = mix(vec3(1.0), baseColor, 0.58);
  vec3 metallicBase = vec3(0.92, 0.94, 0.98) * mix(vec3(1.0), branchTint, 0.26);
  vec3 oxideTinted = mix(oxideColor, oxideColor * branchTint, 0.62);
  vec3 blendTint = mix(metallicBase, oxideTinted, eggSaturate01(filmAmount * 0.78));
  vec3 overlayTint = mix(vec3(1.0), blendTint, 0.62 * iriStrength);
  vec3 iridescentBase = baseColor * overlayTint;
  iridescentBase += oxideColor * fresnel * iriStrength * 0.22;
  return mix(baseColor, iridescentBase, 0.85 * iriStrength);
}`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
diffuseColor.rgb = applyEggIridescence(diffuseColor.rgb);`,
        )
    }
  }

  private getRenderTopology(level: number): RenderTopology {
    const targetLevel = Math.max(0, Math.round(level))
    if (this.renderTopologyCache.has(targetLevel)) {
      return this.renderTopologyCache.get(targetLevel)!
    }

    for (let currentLevel = 1; currentLevel <= targetLevel; currentLevel += 1) {
      if (this.renderTopologyCache.has(currentLevel)) {
        continue
      }

      const previousLevel = this.renderTopologyCache.get(currentLevel - 1)
      if (!previousLevel) {
        throw new Error(`Missing subdivision topology for level ${currentLevel - 1}.`)
      }

      let nextLevelTopology = subdivideRenderTopology(previousLevel)
      nextLevelTopology = smoothRenderTopology(nextLevelTopology, currentLevel, 0.18)
      this.renderTopologyCache.set(currentLevel, nextLevelTopology)
    }

    return this.renderTopologyCache.get(targetLevel)!
  }

  private rebuildRenderGeometry(): void {
    const topology = this.getRenderTopology(this.displaySubdivisionLevel)
    this.wireEdgePairs = topology.wireEdgePairs
    this.state.geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(topology.vertexStencils.length * 3), 3),
    )
    this.state.geometry.setIndex(topology.indices)
    this.state.geometry.deleteAttribute('normal')

    this.wireOverlay.geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(this.wireEdgePairs.length * 3), 3),
    )
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
    const topology = this.getRenderTopology(this.displaySubdivisionLevel)
    const positionAttribute = this.state.geometry.getAttribute('position') as THREE.BufferAttribute

    for (let index = 0; index < topology.vertexStencils.length; index += 1) {
      const stencil = topology.vertexStencils[index]
      let x = 0
      let y = 0
      let z = 0

      for (let weightIndex = 0; weightIndex < stencil.indices.length; weightIndex += 1) {
        const sourceIndex = stencil.indices[weightIndex]
        const sourcePosition = this.state.positions[sourceIndex]
        const weight = stencil.weights[weightIndex]
        x += sourcePosition.x * weight
        y += sourcePosition.y * weight
        z += sourcePosition.z * weight
      }

      positionAttribute.setXYZ(index, x, y, z)
    }

    positionAttribute.needsUpdate = true
    this.state.geometry.computeVertexNormals()
    this.state.geometry.computeBoundingSphere()

    const normalAttribute = this.state.geometry.getAttribute('normal') as THREE.BufferAttribute
    const wirePositionAttribute = this.wireOverlay.geometry.getAttribute('position') as THREE.BufferAttribute

    for (let slot = 0; slot < this.wireEdgePairs.length; slot += 1) {
      const vertexIndex = this.wireEdgePairs[slot]
      const positionX = positionAttribute.getX(vertexIndex)
      const positionY = positionAttribute.getY(vertexIndex)
      const positionZ = positionAttribute.getZ(vertexIndex)
      const normalX = normalAttribute.getX(vertexIndex)
      const normalY = normalAttribute.getY(vertexIndex)
      const normalZ = normalAttribute.getZ(vertexIndex)

      wirePositionAttribute.setXYZ(
        slot,
        positionX + normalX * WIRE_SURFACE_OFFSET,
        positionY + normalY * WIRE_SURFACE_OFFSET,
        positionZ + normalZ * WIRE_SURFACE_OFFSET,
      )
    }

    wirePositionAttribute.needsUpdate = true
    this.wireOverlay.geometry.computeBoundingSphere()
  }
}

export function buildPillowFromOutline(
  outline: readonly OutlinePoint[],
  internalSeams: readonly InternalSeamInput[] = [],
  outerSeamCurvature = 1,
  innerSeamCurvature = 1,
  displaySubdivisionLevel = 0,
  params?: Partial<SimulationParams>,
): PillowSimulation {
  return new PillowSimulation(
    outline,
    internalSeams,
    outerSeamCurvature,
    innerSeamCurvature,
    displaySubdivisionLevel,
    params,
  )
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
  let weights = smoothedWeights.map((weight, index) => {
    if (flatMesh.stitchedVertexIndices.has(index)) {
      return 0
    }

    const normalized = THREE.MathUtils.clamp(weight / smoothedMax, 0, 1)
    return applyInflationRamp(normalized)
  })

  for (let iteration = 0; iteration < 4; iteration += 1) {
    const nextWeights = weights.slice()

    for (let index = 0; index < weights.length; index += 1) {
      if (flatMesh.stitchedVertexIndices.has(index)) {
        continue
      }

      const neighbors = adjacency[index]
      if (neighbors.length === 0) {
        continue
      }

      const seamBlend = 1 - THREE.MathUtils.smoothstep(normalizedDistances[index], 0.08, 0.28)
      if (seamBlend <= 0) {
        continue
      }

      const neighborAverage =
        neighbors.reduce((sum, neighborIndex) => sum + weights[neighborIndex], 0) /
        neighbors.length

      nextWeights[index] = THREE.MathUtils.lerp(
        weights[index],
        neighborAverage,
        seamBlend * 0.24,
      )
    }

    weights = nextWeights
  }

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

function buildWireEdgePairs(triangles: readonly TriangleIndices[]): number[] {
  const edgeMap = new Map<string, [number, number]>()

  const addEdge = (indexA: number, indexB: number): void => {
    const minIndex = Math.min(indexA, indexB)
    const maxIndex = Math.max(indexA, indexB)
    const key = `${minIndex}:${maxIndex}`

    if (!edgeMap.has(key)) {
      edgeMap.set(key, [indexA, indexB])
    }
  }

  for (const [indexA, indexB, indexC] of triangles) {
    addEdge(indexA, indexB)
    addEdge(indexB, indexC)
    addEdge(indexC, indexA)
  }

  return [...edgeMap.values()].flat()
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

function makeEdgeKey(indexA: number, indexB: number): string {
  return indexA < indexB ? `${indexA}:${indexB}` : `${indexB}:${indexA}`
}

function cloneVertexStencil(stencil: VertexStencil): VertexStencil {
  return {
    indices: [...stencil.indices],
    weights: [...stencil.weights],
  }
}

function buildBaseRenderTopology(
  vertexCount: number,
  triangles: readonly TriangleIndices[],
  creaseVertexSet: ReadonlySet<number>,
): RenderTopology {
  const nextTriangles = triangles.map(
    ([indexA, indexB, indexC]) => [indexA, indexB, indexC] satisfies TriangleIndices,
  )
  const creaseVertices = Array.from({ length: vertexCount }, (_, index) => creaseVertexSet.has(index))
  const creaseEdges = new Set<string>()

  for (const [indexA, indexB, indexC] of nextTriangles) {
    if (creaseVertices[indexA] && creaseVertices[indexB]) {
      creaseEdges.add(makeEdgeKey(indexA, indexB))
    }
    if (creaseVertices[indexB] && creaseVertices[indexC]) {
      creaseEdges.add(makeEdgeKey(indexB, indexC))
    }
    if (creaseVertices[indexC] && creaseVertices[indexA]) {
      creaseEdges.add(makeEdgeKey(indexC, indexA))
    }
  }

  return {
    vertexStencils: Array.from({ length: vertexCount }, (_, index) => ({
      indices: [index],
      weights: [1],
    })),
    triangles: nextTriangles,
    indices: nextTriangles.flat(),
    wireEdgePairs: buildWireEdgePairs(nextTriangles),
    creaseVertices,
    creaseEdges,
  }
}

function buildTopologyAdjacency(
  triangles: readonly TriangleIndices[],
  vertexCount: number,
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

function combineVertexStencils(
  entries: readonly { stencil: VertexStencil; weight: number }[],
): VertexStencil {
  const combinedWeights = new Map<number, number>()

  for (const entry of entries) {
    if (Math.abs(entry.weight) < 1e-8) {
      continue
    }

    for (let index = 0; index < entry.stencil.indices.length; index += 1) {
      const sourceIndex = entry.stencil.indices[index]
      const sourceWeight = entry.stencil.weights[index] * entry.weight
      combinedWeights.set(
        sourceIndex,
        (combinedWeights.get(sourceIndex) ?? 0) + sourceWeight,
      )
    }
  }

  const filteredEntries = [...combinedWeights.entries()]
    .filter(([, weight]) => Math.abs(weight) > 1e-8)
    .sort(([indexA], [indexB]) => indexA - indexB)

  const totalWeight = filteredEntries.reduce((sum, [, weight]) => sum + weight, 0)
  if (filteredEntries.length === 0 || Math.abs(totalWeight) < 1e-8) {
    return {
      indices: [],
      weights: [],
    }
  }

  return {
    indices: filteredEntries.map(([index]) => index),
    weights: filteredEntries.map(([, weight]) => weight / totalWeight),
  }
}

function smoothRenderTopology(
  topology: RenderTopology,
  passes: number,
  lambda: number,
): RenderTopology {
  if (passes <= 0 || lambda <= 0) {
    return topology
  }

  const adjacency = buildTopologyAdjacency(
    topology.triangles,
    topology.vertexStencils.length,
  )
  let vertexStencils = topology.vertexStencils.map(cloneVertexStencil)

  for (let pass = 0; pass < passes; pass += 1) {
    const nextStencils = vertexStencils.map(cloneVertexStencil)

    for (let index = 0; index < vertexStencils.length; index += 1) {
      if (topology.creaseVertices[index]) {
        continue
      }

      const neighbors = adjacency[index]
      if (neighbors.length === 0) {
        continue
      }

      const neighborWeight = 1 / neighbors.length
      const neighborAverage = combineVertexStencils(
        neighbors.map((neighborIndex) => ({
          stencil: vertexStencils[neighborIndex],
          weight: neighborWeight,
        })),
      )

      nextStencils[index] = combineVertexStencils([
        { stencil: vertexStencils[index], weight: 1 - lambda },
        { stencil: neighborAverage, weight: lambda },
      ])
    }

    vertexStencils = nextStencils
  }

  return {
    vertexStencils,
    triangles: topology.triangles.map(
      ([indexA, indexB, indexC]) => [indexA, indexB, indexC] satisfies TriangleIndices,
    ),
    indices: [...topology.indices],
    wireEdgePairs: [...topology.wireEdgePairs],
    creaseVertices: [...topology.creaseVertices],
    creaseEdges: new Set(topology.creaseEdges),
  }
}

function subdivideRenderTopology(topology: RenderTopology): RenderTopology {
  const vertexCount = topology.vertexStencils.length
  const adjacency = buildTopologyAdjacency(topology.triangles, vertexCount)
  const edgeOpposites = new Map<string, number[]>()
  const edgeEndpoints = new Map<string, [number, number]>()
  const creaseNeighbors = Array.from({ length: vertexCount }, () => new Set<number>())

  const registerEdge = (indexA: number, indexB: number, oppositeIndex: number): void => {
    const edgeKey = makeEdgeKey(indexA, indexB)
    if (!edgeEndpoints.has(edgeKey)) {
      edgeEndpoints.set(edgeKey, [indexA, indexB])
    }

    const opposites = edgeOpposites.get(edgeKey)
    if (opposites) {
      opposites.push(oppositeIndex)
      return
    }

    edgeOpposites.set(edgeKey, [oppositeIndex])
  }

  for (const [indexA, indexB, indexC] of topology.triangles) {
    registerEdge(indexA, indexB, indexC)
    registerEdge(indexB, indexC, indexA)
    registerEdge(indexC, indexA, indexB)
  }

  for (const [edgeKey, [indexA, indexB]] of edgeEndpoints) {
    const oppositeCount = edgeOpposites.get(edgeKey)?.length ?? 0
    if (topology.creaseEdges.has(edgeKey) || oppositeCount <= 1) {
      creaseNeighbors[indexA].add(indexB)
      creaseNeighbors[indexB].add(indexA)
    }
  }

  const nextVertexStencils = new Array<VertexStencil>(vertexCount)
  const nextCreaseVertices = Array.from({ length: vertexCount }, (_, index) =>
    topology.creaseVertices[index] || creaseNeighbors[index].size > 0,
  )

  for (let index = 0; index < vertexCount; index += 1) {
    const vertexStencil = topology.vertexStencils[index]
    const sharpNeighbors = [...creaseNeighbors[index]]

    if (sharpNeighbors.length === 2) {
      nextVertexStencils[index] = combineVertexStencils([
        { stencil: vertexStencil, weight: 0.75 },
        { stencil: topology.vertexStencils[sharpNeighbors[0]], weight: 0.125 },
        { stencil: topology.vertexStencils[sharpNeighbors[1]], weight: 0.125 },
      ])
      continue
    }

    if (sharpNeighbors.length > 2) {
      const sharedWeight = 0.25 / sharpNeighbors.length
      nextVertexStencils[index] = combineVertexStencils([
        { stencil: vertexStencil, weight: 0.75 },
        ...sharpNeighbors.map((neighborIndex) => ({
          stencil: topology.vertexStencils[neighborIndex],
          weight: sharedWeight,
        })),
      ])
      continue
    }

    const neighbors = adjacency[index]
    if (neighbors.length === 0) {
      nextVertexStencils[index] = cloneVertexStencil(vertexStencil)
      continue
    }

    const valence = neighbors.length
    const beta = valence === 3 ? 3 / 16 : 3 / (8 * valence)
    nextVertexStencils[index] = combineVertexStencils([
      { stencil: vertexStencil, weight: 1 - valence * beta },
      ...neighbors.map((neighborIndex) => ({
        stencil: topology.vertexStencils[neighborIndex],
        weight: beta,
      })),
    ])
  }

  const edgeVertexIndices = new Map<string, number>()
  const nextCreaseEdges = new Set<string>()
  const orderedEdges = [...edgeEndpoints.entries()].sort(([edgeKeyA], [edgeKeyB]) =>
    edgeKeyA.localeCompare(edgeKeyB),
  )

  for (const [edgeKey, [indexA, indexB]] of orderedEdges) {
    const opposites = edgeOpposites.get(edgeKey) ?? []
    const isSharpEdge = topology.creaseEdges.has(edgeKey) || opposites.length <= 1

    const oddStencil = isSharpEdge || opposites.length < 2
      ? combineVertexStencils([
          { stencil: topology.vertexStencils[indexA], weight: 0.5 },
          { stencil: topology.vertexStencils[indexB], weight: 0.5 },
        ])
      : combineVertexStencils([
          { stencil: topology.vertexStencils[indexA], weight: 3 / 8 },
          { stencil: topology.vertexStencils[indexB], weight: 3 / 8 },
          { stencil: topology.vertexStencils[opposites[0]], weight: 1 / 8 },
          { stencil: topology.vertexStencils[opposites[1]], weight: 1 / 8 },
        ])

    const edgeVertexIndex = nextVertexStencils.length
    nextVertexStencils.push(oddStencil)
    nextCreaseVertices.push(isSharpEdge)
    edgeVertexIndices.set(edgeKey, edgeVertexIndex)

    if (isSharpEdge) {
      nextCreaseEdges.add(makeEdgeKey(indexA, edgeVertexIndex))
      nextCreaseEdges.add(makeEdgeKey(edgeVertexIndex, indexB))
    }
  }

  const nextTriangles: TriangleIndices[] = []
  for (const [indexA, indexB, indexC] of topology.triangles) {
    const edgeAB = edgeVertexIndices.get(makeEdgeKey(indexA, indexB))
    const edgeBC = edgeVertexIndices.get(makeEdgeKey(indexB, indexC))
    const edgeCA = edgeVertexIndices.get(makeEdgeKey(indexC, indexA))

    if (
      edgeAB === undefined ||
      edgeBC === undefined ||
      edgeCA === undefined
    ) {
      throw new Error('Failed to build subdivided render topology.')
    }

    nextTriangles.push(
      [indexA, edgeAB, edgeCA],
      [edgeAB, indexB, edgeBC],
      [edgeCA, edgeBC, indexC],
      [edgeAB, edgeBC, edgeCA],
    )
  }

  return {
    vertexStencils: nextVertexStencils,
    triangles: nextTriangles,
    indices: nextTriangles.flat(),
    wireEdgePairs: buildWireEdgePairs(nextTriangles),
    creaseVertices: nextCreaseVertices,
    creaseEdges: nextCreaseEdges,
  }
}
