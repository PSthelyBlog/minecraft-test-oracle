/**
 * The terrain material: a Three.js MeshLambertMaterial whose texture fetch is
 * redirected from a single 2D `map` to a tile ARRAY (`sampler2DArray`), indexed by
 * a per-vertex `layer` attribute the mesher emits. Everything else about Lambert —
 * the hemisphere + directional lighting, fog, tone-mapping, and `vertexColors` (our
 * per-vertex AO×shade) — is left untouched, so the look is identical to the old
 * single-atlas material; only the sampling changes (which is what unblocks
 * greedy-meshed quads repeating a tile via UVs > 1).
 *
 * Pure render-shell wiring (no game logic), verified by the headless smoke test.
 */

import {
  MeshLambertMaterial,
  DataTexture,
  RGBAFormat,
  UnsignedByteType,
  NearestFilter,
} from "three";
import { buildTileArrayTexture } from "./atlasTexture";

export function buildTerrainMaterial(): MeshLambertMaterial {
  const tiles = buildTileArrayTexture();

  // A 1×1 white stand-in `map`: setting `map` is what makes three define USE_MAP, so
  // it plumbs the `uv` attribute into `vMapUv` and runs the <map_fragment> chunk. We
  // then override that chunk to sample the tile array instead of this 2D texture, so
  // the white map is declared but never actually read.
  const white = new DataTexture(
    new Uint8Array([255, 255, 255, 255]),
    1,
    1,
    RGBAFormat,
    UnsignedByteType,
  );
  white.magFilter = NearestFilter;
  white.minFilter = NearestFilter;
  white.needsUpdate = true;

  const mat = new MeshLambertMaterial({ vertexColors: true, map: white });

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTiles = { value: tiles };

    // Vertex: forward the per-vertex tile index to the fragment stage. (`attribute`
    // and `varying` are mapped to GLSL3 in/out by three's prefix.)
    shader.vertexShader =
      "attribute float layer;\nvarying float vLayer;\n" +
      shader.vertexShader.replace(
        "#include <uv_vertex>",
        "#include <uv_vertex>\n\tvLayer = layer;",
      );

    // Fragment: replace the default 2D map sample with a tile-array sample at the
    // forwarded layer. vMapUv is the tile-local UV (and repeats, via the texture's
    // RepeatWrapping, when a greedy quad spans multiple cells).
    shader.fragmentShader =
      "uniform sampler2DArray uTiles;\nvarying float vLayer;\n" +
      shader.fragmentShader.replace(
        "#include <map_fragment>",
        [
          "#ifdef USE_MAP",
          "  vec4 sampledDiffuseColor = texture( uTiles, vec3( vMapUv, vLayer ) );",
          "  diffuseColor *= sampledDiffuseColor;",
          "#endif",
        ].join("\n"),
      );
  };

  // Keep this program out of the shared MeshLambertMaterial cache.
  mat.customProgramCacheKey = () => "terrain-tile-array-v1";
  return mat;
}
