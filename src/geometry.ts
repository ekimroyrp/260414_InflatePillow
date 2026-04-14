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

export type TriangleIndices = [number, number, number]

export interface FlatMeshData {
  vertices: THREE.Vector2[]
  triangles: TriangleIndices[]
  boundaryVertexIndices: Set<number>
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
    error: 'Outline can be closed when you are ready.',
  }
}

export function buildFlatMeshData(points: readonly OutlinePoint[]): FlatMeshData {
  const contour = normalizeCounterClockwise(getOutlineVectors(points))
  const area = Math.abs(computeSignedArea(contour))
  const perimeter = computePerimeter(contour)
  const targetSpacing = computeTargetSpacing(area, perimeter)
  const sampledContour = resampleClosedContour(
    contour,
    THREE.MathUtils.clamp(Math.round(perimeter / targetSpacing), contour.length * 2, 240),
  )
  const interiorPoints = generateInteriorPoints(contour, targetSpacing)
  const vertices = [...sampledContour, ...interiorPoints]
  const delaunay = Delaunator.from(vertices, (point) => point.x, (point) => point.y)
  const triangles = buildUniformTriangles(vertices, sampledContour, delaunay.triangles)
  const boundaryVertexIndices = new Set<number>(
    sampledContour.map((_, index) => index),
  )

  return {
    vertices,
    triangles,
    boundaryVertexIndices,
    area,
  }
}

export function buildShape(points: readonly OutlinePoint[]): THREE.Shape | null {
  if (points.length < 3) {
    return null
  }

  const contour = normalizeCounterClockwise(getOutlineVectors(points))
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

      if (distanceToContour(candidate, contour) < insetDistance) {
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

function distanceToContour(point: THREE.Vector2, contour: readonly THREE.Vector2[]): number {
  let minDistanceSquared = Number.POSITIVE_INFINITY

  for (let index = 0; index < contour.length; index += 1) {
    const start = contour[index]
    const end = contour[(index + 1) % contour.length]
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

  return (firstIndex === 0 && secondIndex === pointCount - 1) || (secondIndex === 0 && firstIndex === pointCount - 1)
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
