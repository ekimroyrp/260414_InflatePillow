import * as THREE from 'three'
import Delaunator from 'delaunator'

export interface OutlinePoint {
  id: number
  position: THREE.Vector2
}

export interface EditableOutline {
  points: OutlinePoint[]
  closed: boolean
  selectedVertexId: number | null
  hoveredVertexId: number | null
  valid: boolean
  error: string
}

export interface OutlineValidation {
  valid: boolean
  error: string
}

export interface SampledSeamPath {
  points: THREE.Vector2[]
  closed: boolean
}

export type TriangleIndices = [number, number, number]

export interface FlatMeshData {
  vertices: THREE.Vector2[]
  triangles: TriangleIndices[]
  boundaryVertexIndices: Set<number>
  stitchedVertexIndices: Set<number>
  seamPaths: SampledSeamPath[]
  area: number
}

const MIN_AREA = 0.05
const EPSILON = 1e-6

export function createEditableOutline(): EditableOutline {
  return {
    points: [],
    closed: false,
    selectedVertexId: null,
    hoveredVertexId: null,
    valid: false,
    error: 'Click on the ground to place the first corner.',
  }
}

export function cloneOutlinePoints(points: readonly OutlinePoint[]): OutlinePoint[] {
  return points.map((point) => ({
    id: point.id,
    position: point.position.clone(),
  }))
}

export function getOutlineVectors(points: readonly OutlinePoint[]): THREE.Vector2[] {
  return points.map((point) => point.position.clone())
}

export function buildSubdividedPath(
  points: readonly OutlinePoint[] | readonly THREE.Vector2[],
  closed: boolean,
  subdivision: number,
): THREE.Vector2[] {
  const source =
    points.length > 0 && 'position' in points[0]
      ? getOutlineVectors(points as readonly OutlinePoint[])
      : (points as readonly THREE.Vector2[]).map((point) => point.clone())

  const safeSubdivision = Math.max(1, Math.round(subdivision))
  if (source.length < 2 || safeSubdivision <= 1) {
    return source
  }

  const controls = source.map((point) => new THREE.Vector3(point.x, point.y, 0))
  const curve = new THREE.CatmullRomCurve3(controls, closed, 'centripetal')
  const segmentCount = closed ? controls.length : controls.length - 1
  const sampleCount = Math.max(closed ? 3 : 2, segmentCount * safeSubdivision)
  const result: THREE.Vector2[] = []

  if (closed) {
    for (let index = 0; index < sampleCount; index += 1) {
      const sample = curve.getPoint(index / sampleCount)
      appendUniqueVector(result, new THREE.Vector2(sample.x, sample.y))
    }
  } else {
    for (let index = 0; index <= sampleCount; index += 1) {
      const sample = curve.getPoint(index / sampleCount)
      appendUniqueVector(result, new THREE.Vector2(sample.x, sample.y))
    }
  }

  return result
}

export function computeSignedArea(points: readonly THREE.Vector2[]): number {
  let area = 0

  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    area += current.x * next.y - next.x * current.y
  }

  return area * 0.5
}

export function validateOutline(points: readonly OutlinePoint[], closed: boolean): OutlineValidation {
  if (points.length === 0) {
    return {
      valid: false,
      error: 'Click on the ground to place the first corner.',
    }
  }

  if (points.length < 3) {
    return {
      valid: false,
      error: 'Add at least three corners to define a seam.',
    }
  }

  const contour = getOutlineVectors(points)
  if (hasSelfIntersection(contour, closed)) {
    return {
      valid: false,
      error: 'Outline crosses itself. Move a corner or undo the last point.',
    }
  }

  if (closed) {
    const area = Math.abs(computeSignedArea(contour))
    if (area < MIN_AREA) {
      return {
        valid: false,
        error: 'Outline is too small to inflate cleanly.',
      }
    }

    return {
      valid: true,
      error: 'Closed seam is ready to inflate.',
    }
  }

  return {
    valid: true,
    error: 'Click the first point to close the seam.',
  }
}

export function validatePathVectors(
  points: readonly THREE.Vector2[],
  closed: boolean,
): OutlineValidation {
  if (points.length < 3) {
    return {
      valid: false,
      error: 'Add at least three corners to define a seam.',
    }
  }

  if (hasSelfIntersection(points, closed)) {
    return {
      valid: false,
      error: 'Seam curvature crosses itself. Lower Seam Curvature or move a corner.',
    }
  }

  if (closed) {
    const area = Math.abs(computeSignedArea(points))
    if (area < MIN_AREA) {
      return {
        valid: false,
        error: 'Curved seam is too small to inflate cleanly.',
      }
    }

    return {
      valid: true,
      error: 'Closed seam is ready to inflate.',
    }
  }

  return {
    valid: true,
    error: 'Click the first point to close the seam.',
  }
}

export function pointInOutline(
  point: THREE.Vector2,
  outline: readonly OutlinePoint[] | readonly THREE.Vector2[],
): boolean {
  const contour =
    outline.length > 0 && 'position' in outline[0]
      ? getOutlineVectors(outline as readonly OutlinePoint[])
      : (outline as readonly THREE.Vector2[]).map((candidate) => candidate.clone())

  return pointInPolygonOrOnEdge(point, contour)
}

export function buildFlatMeshData(
  points: readonly OutlinePoint[],
  internalSeams: readonly (readonly OutlinePoint[])[] = [],
  seamCurvature = 1,
): FlatMeshData {
  const rawContour = normalizeCounterClockwise(getOutlineVectors(points))
  const contour = normalizeCounterClockwise(buildSubdividedPath(rawContour, true, seamCurvature))
  const area = Math.abs(computeSignedArea(contour))
  const perimeter = computePerimeter(contour)
  const targetSpacing = computeTargetSpacing(area, perimeter)
  const sampledContour = resampleClosedContour(
    contour,
    THREE.MathUtils.clamp(Math.round(perimeter / targetSpacing), contour.length * 2, 240),
  )

  const seamPaths: SampledSeamPath[] = [{ points: sampledContour, closed: true }]
  for (const seam of internalSeams) {
    if (seam.length < 2) {
      continue
    }

    const projectedSeam = projectOpenSeamEndpoints(
      getOutlineVectors(seam),
      rawContour,
      sampledContour,
      Math.max(targetSpacing * 1.4, 0.16),
    )
    const sampledSeam = resampleOpenPath(
      projectedSeam,
      THREE.MathUtils.clamp(targetSpacing, 0.12, 0.36),
    )

    if (sampledSeam.length >= 2) {
      seamPaths.push({ points: sampledSeam, closed: false })
    }
  }

  const vertices: THREE.Vector2[] = []
  const boundaryVertexIndices = new Set<number>()
  const stitchedVertexIndices = new Set<number>()

  appendUniqueVertices(vertices, sampledContour, boundaryVertexIndices, stitchedVertexIndices)

  for (let seamIndex = 1; seamIndex < seamPaths.length; seamIndex += 1) {
    appendUniqueVertices(vertices, seamPaths[seamIndex].points, undefined, stitchedVertexIndices)
  }

  const interiorPoints = generateInteriorPoints(contour, seamPaths, targetSpacing)
  appendUniqueVertices(vertices, interiorPoints)

  const delaunay = Delaunator.from(vertices, (point) => point.x, (point) => point.y)
  const triangles = buildUniformTriangles(vertices, sampledContour, delaunay.triangles)

  return {
    vertices,
    triangles,
    boundaryVertexIndices,
    stitchedVertexIndices,
    seamPaths,
    area,
  }
}

export function buildShape(points: readonly OutlinePoint[], seamCurvature = 1): THREE.Shape | null {
  if (points.length < 3) {
    return null
  }

  const contour = normalizeCounterClockwise(buildSubdividedPath(points, true, seamCurvature))
  const shape = new THREE.Shape(contour)
  shape.autoClose = true
  return shape
}

function normalizeCounterClockwise(points: readonly THREE.Vector2[]): THREE.Vector2[] {
  const contour = points.map((point) => point.clone())
  if (computeSignedArea(contour) < 0) {
    contour.reverse()
  }

  return contour
}

function appendUniqueVertices(
  target: THREE.Vector2[],
  candidates: readonly THREE.Vector2[],
  boundaryVertexIndices?: Set<number>,
  stitchedVertexIndices?: Set<number>,
): void {
  for (const candidate of candidates) {
    const existingIndex = findExistingVertexIndex(target, candidate)
    if (existingIndex >= 0) {
      boundaryVertexIndices?.add(existingIndex)
      stitchedVertexIndices?.add(existingIndex)
      continue
    }

    const nextIndex = target.length
    target.push(candidate.clone())
    boundaryVertexIndices?.add(nextIndex)
    stitchedVertexIndices?.add(nextIndex)
  }
}

function appendUniqueVector(target: THREE.Vector2[], candidate: THREE.Vector2): void {
  const previous = target[target.length - 1]
  if (!previous || previous.distanceToSquared(candidate) > EPSILON) {
    target.push(candidate)
  }
}

function findExistingVertexIndex(vertices: readonly THREE.Vector2[], candidate: THREE.Vector2): number {
  for (let index = 0; index < vertices.length; index += 1) {
    if (vertices[index].distanceToSquared(candidate) <= EPSILON * 16) {
      return index
    }
  }

  return -1
}

function resampleClosedContour(points: readonly THREE.Vector2[], desiredSegments: number): THREE.Vector2[] {
  const contour: THREE.Vector2[] = []
  const perimeter = computePerimeter(points)
  const segmentLength = perimeter / desiredSegments

  for (let index = 0; index < points.length; index += 1) {
    const start = points[index]
    const end = points[(index + 1) % points.length]
    const edgeLength = start.distanceTo(end)
    const steps = Math.max(1, Math.ceil(edgeLength / segmentLength))

    for (let step = 0; step < steps; step += 1) {
      const sample = new THREE.Vector2().lerpVectors(start, end, step / steps)
      const previous = contour[contour.length - 1]

      if (!previous || previous.distanceToSquared(sample) > EPSILON) {
        contour.push(sample)
      }
    }
  }

  return contour
}

function resampleOpenPath(points: readonly THREE.Vector2[], targetSpacing: number): THREE.Vector2[] {
  const path: THREE.Vector2[] = []

  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index]
    const end = points[index + 1]
    const edgeLength = start.distanceTo(end)
    const steps = Math.max(1, Math.ceil(edgeLength / targetSpacing))

    for (let step = 0; step < steps; step += 1) {
      const sample = new THREE.Vector2().lerpVectors(start, end, step / steps)
      const previous = path[path.length - 1]
      if (!previous || previous.distanceToSquared(sample) > EPSILON) {
        path.push(sample)
      }
    }
  }

  const finalPoint = points[points.length - 1]
  if (finalPoint) {
    const previous = path[path.length - 1]
    if (!previous || previous.distanceToSquared(finalPoint) > EPSILON) {
      path.push(finalPoint.clone())
    }
  }

  return path
}

function projectOpenSeamEndpoints(
  points: readonly THREE.Vector2[],
  rawContour: readonly THREE.Vector2[],
  processedContour: readonly THREE.Vector2[],
  snapDistance: number,
): THREE.Vector2[] {
  if (points.length < 2) {
    return points.map((point) => point.clone())
  }

  const projected = points.map((point) => point.clone())
  const firstProjection = projectEndpointToContour(projected[0], rawContour, processedContour, snapDistance)
  if (firstProjection) {
    projected[0].copy(firstProjection)
  }

  const lastIndex = projected.length - 1
  const lastProjection = projectEndpointToContour(projected[lastIndex], rawContour, processedContour, snapDistance)
  if (lastProjection) {
    projected[lastIndex].copy(lastProjection)
  }

  return projected
}

function projectEndpointToContour(
  point: THREE.Vector2,
  rawContour: readonly THREE.Vector2[],
  processedContour: readonly THREE.Vector2[],
  snapDistance: number,
): THREE.Vector2 | null {
  const rawCandidate = closestPointOnPolyline(point, rawContour, true)
  const processedCandidate = closestPointOnPolyline(point, processedContour, true)
  const rawDistance = rawCandidate.distanceTo(point)
  const processedDistance = processedCandidate.distanceTo(point)

  if (Math.min(rawDistance, processedDistance) > snapDistance) {
    return null
  }

  return processedCandidate
}

function closestPointOnPolyline(
  point: THREE.Vector2,
  polyline: readonly THREE.Vector2[],
  closed: boolean,
): THREE.Vector2 {
  let bestPoint = polyline[0]?.clone() ?? new THREE.Vector2()
  let bestDistanceSquared = Number.POSITIVE_INFINITY
  const segmentCount = closed ? polyline.length : polyline.length - 1

  for (let index = 0; index < segmentCount; index += 1) {
    const start = polyline[index]
    const end = polyline[(index + 1) % polyline.length]
    const projected = projectPointToSegment(point, start, end)
    const distanceSquared = projected.distanceToSquared(point)

    if (distanceSquared < bestDistanceSquared) {
      bestDistanceSquared = distanceSquared
      bestPoint = projected
    }
  }

  return bestPoint
}

function projectPointToSegment(
  point: THREE.Vector2,
  start: THREE.Vector2,
  end: THREE.Vector2,
): THREE.Vector2 {
  const segment = end.clone().sub(start)
  const segmentLengthSquared = segment.lengthSq()

  if (segmentLengthSquared < EPSILON) {
    return start.clone()
  }

  const projection = THREE.MathUtils.clamp(
    point.clone().sub(start).dot(segment) / segmentLengthSquared,
    0,
    1,
  )

  return start.clone().add(segment.multiplyScalar(projection))
}

function computePerimeter(points: readonly THREE.Vector2[]): number {
  let perimeter = 0

  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    perimeter += current.distanceTo(next)
  }

  return Math.max(perimeter, EPSILON)
}

function computeTargetSpacing(area: number, perimeter: number): number {
  const targetTriangles = THREE.MathUtils.clamp(
    Math.round(area * 52 + perimeter * 8),
    180,
    2200,
  )
  const equilateralSpacing = Math.sqrt((area * 4) / (Math.sqrt(3) * targetTriangles))
  return THREE.MathUtils.clamp(equilateralSpacing, 0.12, 0.42)
}

function generateInteriorPoints(
  contour: readonly THREE.Vector2[],
  seamPaths: readonly SampledSeamPath[],
  spacing: number,
): THREE.Vector2[] {
  const bounds = new THREE.Box2().setFromPoints([...contour])
  const verticalStep = spacing * Math.sqrt(3) * 0.5
  const insetDistance = spacing * 0.42
  const points: THREE.Vector2[] = []

  let row = 0
  for (let y = bounds.min.y + verticalStep; y <= bounds.max.y - verticalStep; y += verticalStep) {
    const rowOffset = row % 2 === 0 ? 0 : spacing * 0.5
    for (let x = bounds.min.x + spacing * 0.5 + rowOffset; x <= bounds.max.x - spacing * 0.5; x += spacing) {
      const candidate = new THREE.Vector2(x, y)
      if (!pointInPolygonOrOnEdge(candidate, contour)) {
        continue
      }

      if (distanceToPathSet(candidate, seamPaths) < insetDistance) {
        continue
      }

      points.push(candidate)
    }

    row += 1
  }

  return points
}

function buildUniformTriangles(
  vertices: readonly THREE.Vector2[],
  contour: readonly THREE.Vector2[],
  delaunayIndices: Uint32Array | Uint16Array,
): TriangleIndices[] {
  const triangles: TriangleIndices[] = []

  for (let index = 0; index < delaunayIndices.length; index += 3) {
    const triangle: TriangleIndices = [
      delaunayIndices[index],
      delaunayIndices[index + 1],
      delaunayIndices[index + 2],
    ]

    const vertexA = vertices[triangle[0]]
    const vertexB = vertices[triangle[1]]
    const vertexC = vertices[triangle[2]]

    if (!triangleFitsPolygon(vertexA, vertexB, vertexC, contour)) {
      continue
    }

    if (triangleSignedArea(vertexA, vertexB, vertexC) < 0) {
      triangles.push([triangle[0], triangle[2], triangle[1]])
      continue
    }

    triangles.push(triangle)
  }

  return triangles
}

function triangleFitsPolygon(
  vertexA: THREE.Vector2,
  vertexB: THREE.Vector2,
  vertexC: THREE.Vector2,
  contour: readonly THREE.Vector2[],
): boolean {
  if (Math.abs(triangleSignedArea(vertexA, vertexB, vertexC)) < EPSILON) {
    return false
  }

  const centroid = vertexA.clone().add(vertexB).add(vertexC).multiplyScalar(1 / 3)
  if (!pointInPolygonOrOnEdge(centroid, contour)) {
    return false
  }

  const midpointAB = vertexA.clone().add(vertexB).multiplyScalar(0.5)
  const midpointBC = vertexB.clone().add(vertexC).multiplyScalar(0.5)
  const midpointCA = vertexC.clone().add(vertexA).multiplyScalar(0.5)

  return (
    pointInPolygonOrOnEdge(midpointAB, contour) &&
    pointInPolygonOrOnEdge(midpointBC, contour) &&
    pointInPolygonOrOnEdge(midpointCA, contour)
  )
}

function triangleSignedArea(
  vertexA: THREE.Vector2,
  vertexB: THREE.Vector2,
  vertexC: THREE.Vector2,
): number {
  return (
    vertexA.x * (vertexB.y - vertexC.y) +
    vertexB.x * (vertexC.y - vertexA.y) +
    vertexC.x * (vertexA.y - vertexB.y)
  ) * 0.5
}

function pointInPolygonOrOnEdge(point: THREE.Vector2, contour: readonly THREE.Vector2[]): boolean {
  for (let index = 0; index < contour.length; index += 1) {
    const start = contour[index]
    const end = contour[(index + 1) % contour.length]
    if (pointOnSegment(start, point, end)) {
      return true
    }
  }

  let inside = false

  for (let index = 0, previous = contour.length - 1; index < contour.length; previous = index, index += 1) {
    const current = contour[index]
    const prior = contour[previous]

    const intersects =
      current.y > point.y !== prior.y > point.y &&
      point.x < ((prior.x - current.x) * (point.y - current.y)) / (prior.y - current.y + EPSILON) + current.x

    if (intersects) {
      inside = !inside
    }
  }

  return inside
}

function distanceToPathSet(point: THREE.Vector2, seamPaths: readonly SampledSeamPath[]): number {
  let minDistance = Number.POSITIVE_INFINITY

  for (const seamPath of seamPaths) {
    minDistance = Math.min(
      minDistance,
      distanceToPolyline(point, seamPath.points, seamPath.closed),
    )
  }

  return minDistance
}

function distanceToPolyline(
  point: THREE.Vector2,
  polyline: readonly THREE.Vector2[],
  closed: boolean,
): number {
  let minDistanceSquared = Number.POSITIVE_INFINITY
  const segmentCount = closed ? polyline.length : polyline.length - 1

  for (let index = 0; index < segmentCount; index += 1) {
    const start = polyline[index]
    const end = polyline[(index + 1) % polyline.length]
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

  if (segmentLengthSquared < EPSILON) {
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

function hasSelfIntersection(points: readonly THREE.Vector2[], closed: boolean): boolean {
  const segmentCount = closed ? points.length : points.length - 1

  for (let firstIndex = 0; firstIndex < segmentCount; firstIndex += 1) {
    const firstStart = points[firstIndex]
    const firstEnd = points[(firstIndex + 1) % points.length]

    for (let secondIndex = firstIndex + 1; secondIndex < segmentCount; secondIndex += 1) {
      if (segmentsShareEndpoint(firstIndex, secondIndex, points.length, closed)) {
        continue
      }

      const secondStart = points[secondIndex]
      const secondEnd = points[(secondIndex + 1) % points.length]

      if (segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd)) {
        return true
      }
    }
  }

  return false
}

function segmentsShareEndpoint(
  firstIndex: number,
  secondIndex: number,
  pointCount: number,
  closed: boolean,
): boolean {
  if (Math.abs(firstIndex - secondIndex) <= 1) {
    return true
  }

  if (!closed) {
    return false
  }

  return (
    (firstIndex === 0 && secondIndex === pointCount - 1) ||
    (secondIndex === 0 && firstIndex === pointCount - 1)
  )
}

function segmentsIntersect(
  segmentAStart: THREE.Vector2,
  segmentAEnd: THREE.Vector2,
  segmentBStart: THREE.Vector2,
  segmentBEnd: THREE.Vector2,
): boolean {
  const orientationA = orientation(segmentAStart, segmentAEnd, segmentBStart)
  const orientationB = orientation(segmentAStart, segmentAEnd, segmentBEnd)
  const orientationC = orientation(segmentBStart, segmentBEnd, segmentAStart)
  const orientationD = orientation(segmentBStart, segmentBEnd, segmentAEnd)

  if (orientationA !== orientationB && orientationC !== orientationD) {
    return true
  }

  if (orientationA === 0 && pointOnSegment(segmentAStart, segmentBStart, segmentAEnd)) {
    return true
  }

  if (orientationB === 0 && pointOnSegment(segmentAStart, segmentBEnd, segmentAEnd)) {
    return true
  }

  if (orientationC === 0 && pointOnSegment(segmentBStart, segmentAStart, segmentBEnd)) {
    return true
  }

  if (orientationD === 0 && pointOnSegment(segmentBStart, segmentAEnd, segmentBEnd)) {
    return true
  }

  return false
}

function orientation(start: THREE.Vector2, middle: THREE.Vector2, end: THREE.Vector2): number {
  const value =
    (middle.y - start.y) * (end.x - middle.x) -
    (middle.x - start.x) * (end.y - middle.y)

  if (Math.abs(value) < EPSILON) {
    return 0
  }

  return value > 0 ? 1 : 2
}

function pointOnSegment(start: THREE.Vector2, test: THREE.Vector2, end: THREE.Vector2): boolean {
  return (
    test.x <= Math.max(start.x, end.x) + EPSILON &&
    test.x + EPSILON >= Math.min(start.x, end.x) &&
    test.y <= Math.max(start.y, end.y) + EPSILON &&
    test.y + EPSILON >= Math.min(start.y, end.y)
  )
}
