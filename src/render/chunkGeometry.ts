/**
 * Bridges the pure mesher to Three.js. The mesher owns all the geometry logic
 * (and is oracle-tested); this file only uploads its typed arrays into a
 * BufferGeometry. Kept tiny and dependency-facing so the testable core stays
 * free of Three.js.
 */

import {
  BufferGeometry,
  Float32BufferAttribute,
  Uint32BufferAttribute,
} from "three";
import type { World } from "../core/world";
import { buildMesh, type ChunkMesh } from "../core/mesher";

/** Upload a mesher result (whole-world or single-chunk) into a BufferGeometry. */
export function geometryFromMesh(mesh: ChunkMesh): BufferGeometry {
  const geo = new BufferGeometry();
  geo.setAttribute("position", new Float32BufferAttribute(mesh.positions, 3));
  geo.setAttribute("normal", new Float32BufferAttribute(mesh.normals, 3));
  geo.setAttribute("color", new Float32BufferAttribute(mesh.colors, 3));
  geo.setIndex(new Uint32BufferAttribute(mesh.indices, 1));
  geo.computeBoundingSphere();
  return geo;
}

export function buildChunkGeometry(world: World): BufferGeometry {
  return geometryFromMesh(buildMesh(world));
}
