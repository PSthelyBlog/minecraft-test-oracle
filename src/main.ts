/**
 * Minecraft Classic clone — entry point and game glue.
 *
 * All the silent-failure-prone math lives in src/core/* (pure, oracle-tested).
 * This file is the deliberately untested "shell": Three.js setup, the DOM, input,
 * and the frame loop. It re-uses the tested core for world storage, terrain,
 * meshing, ray picking, camera direction, and AABB collision.
 */

import {
  Scene,
  PerspectiveCamera,
  WebGLRenderer,
  Color,
  Fog,
  HemisphereLight,
  DirectionalLight,
  MeshLambertMaterial,
  BoxGeometry,
  EdgesGeometry,
  LineSegments,
  LineBasicMaterial,
} from "three";

import { World } from "./core/world";
import { generateTerrain, heightAt } from "./core/terrain";
import { Block, HOTBAR, blockDef } from "./core/blocks";
import { raycast } from "./core/raycast";
import { boxIntersectsSolid } from "./core/physics";
import { directionFromYawPitch, type Vec3 } from "./core/math";
import { ChunkedTerrain } from "./render/chunkedTerrain";
import { buildAtlasTexture } from "./render/atlasTexture";
import { selfCheck } from "./core/selfcheck";
import { stepMovement, type PlayerState, type MovementTuning } from "./game/movement";

// Fail loudly at the door if the core invariants are broken.
selfCheck();

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------
const SIZE_X = 80, SIZE_Y = 32, SIZE_Z = 80;
const SEED = 20090513; // Minecraft Classic's first public release date :)

const world = new World(SIZE_X, SIZE_Y, SIZE_Z);
generateTerrain(world, SEED);

// ---------------------------------------------------------------------------
// Three.js scene
// ---------------------------------------------------------------------------
const canvas = document.getElementById("app") as HTMLCanvasElement;
const renderer = new WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new Scene();
const SKY = new Color(0x8fbcff);
scene.background = SKY;
scene.fog = new Fog(SKY, 40, 110);

const camera = new PerspectiveCamera(70, 1, 0.1, 1000);
camera.rotation.order = "YXZ";

scene.add(new HemisphereLight(0xffffff, 0x6b6b6b, 1.05));
const sun = new DirectionalLight(0xffffff, 0.7);
sun.position.set(0.5, 1, 0.3);
scene.add(sun);

// Chunked terrain: the world is split into fixed cubes, each its own mesh, so a
// block edit rebuilds only the chunk(s) it touches instead of the whole world.
// Blocks are textured from a procedural atlas; the per-vertex colour now carries
// only the per-face ambient shade, so the final look is texel × shade × lighting.
const terrainMaterial = new MeshLambertMaterial({ vertexColors: true, map: buildAtlasTexture() });
const terrain = new ChunkedTerrain(world, terrainMaterial);
scene.add(terrain.group);

// Block-selection highlight (wireframe cube).
const highlight = new LineSegments(
  new EdgesGeometry(new BoxGeometry(1.001, 1.001, 1.001)),
  new LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.4 }),
);
highlight.visible = false;
scene.add(highlight);

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------
const HALF: Vec3 = [0.3, 0.9, 0.3]; // 0.6 x 1.8 x 0.6 box
const EYE = 0.72; // eye offset above the box centre
const REACH = 6;
const TUNING: MovementTuning = { walk: 5.2, fly: 11, gravity: -28, jump: 9, half: HALF };

const spawnH = heightAt(SEED, SIZE_Y, SIZE_X >> 1, SIZE_Z >> 1);
let player: PlayerState = {
  pos: [SIZE_X / 2 + 0.5, spawnH + 3, SIZE_Z / 2 + 0.5],
  vel: [0, 0, 0],
  yaw: 0,
  pitch: 0,
  onGround: false,
  flying: false,
};

let selected = 0; // index into HOTBAR

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
const keys = new Set<string>();
const overlay = document.getElementById("overlay") as HTMLDivElement;

// Request the lock from any click anywhere — the start overlay sits ON TOP of the
// canvas, so a click lands on the overlay, not the canvas. Listening on the whole
// document (capture phase) means both the overlay and the canvas trigger the lock.
function requestLock(): void {
  if (document.pointerLockElement !== canvas) canvas.requestPointerLock();
}
overlay.addEventListener("click", requestLock);
canvas.addEventListener("click", requestLock);
document.addEventListener("pointerlockchange", () => {
  overlay.classList.toggle("hidden", document.pointerLockElement === canvas);
});

const SENS = 0.0022;
document.addEventListener("mousemove", (e) => {
  if (document.pointerLockElement !== canvas) return;
  player.yaw -= e.movementX * SENS;
  player.pitch -= e.movementY * SENS;
  const lim = Math.PI / 2 - 0.001;
  player.pitch = Math.max(-lim, Math.min(lim, player.pitch));
});

window.addEventListener("keydown", (e) => {
  keys.add(e.code);
  if (e.code === "KeyF") player.flying = !player.flying;
  if (e.code.startsWith("Digit")) {
    const n = Number(e.code.slice(5));
    if (n >= 1 && n <= HOTBAR.length) setSelected(n - 1);
  }
});
window.addEventListener("keyup", (e) => keys.delete(e.code));

window.addEventListener("wheel", (e) => {
  if (document.pointerLockElement !== canvas) return;
  setSelected((selected + (e.deltaY > 0 ? 1 : -1) + HOTBAR.length) % HOTBAR.length);
});

canvas.addEventListener("mousedown", (e) => {
  if (document.pointerLockElement !== canvas) return;
  const hit = pickBlock();
  if (!hit) return;
  if (e.button === 0) breakBlock(hit.block);
  else if (e.button === 2) placeBlock(hit.place);
});
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

// ---------------------------------------------------------------------------
// Block interaction
// ---------------------------------------------------------------------------
function eye(): Vec3 {
  return [player.pos[0], player.pos[1] + EYE, player.pos[2]];
}

function pickBlock() {
  const dir = directionFromYawPitch(player.yaw, player.pitch);
  return raycast(world, eye(), dir, REACH);
}

function breakBlock(b: Vec3): void {
  const [x, y, z] = b;
  if (world.get(x, y, z) === Block.Bedrock) return; // Classic: bedrock is permanent
  if (world.set(x, y, z, Block.Air)) terrain.rebuildAround(x, y, z);
}

function placeBlock(p: Vec3): void {
  const [x, y, z] = p;
  if (!world.inBounds(x, y, z) || world.get(x, y, z) !== Block.Air) return;
  // Don't entomb the player: refuse if the new block would overlap their box.
  world.set(x, y, z, HOTBAR[selected]);
  if (boxIntersectsSolid(world, player.pos, HALF)) {
    world.set(x, y, z, Block.Air); // undo
    return;
  }
  terrain.rebuildAround(x, y, z);
}

// ---------------------------------------------------------------------------
// HUD / hotbar
// ---------------------------------------------------------------------------
const hud = document.getElementById("hud") as HTMLDivElement;
const hotbarEl = document.getElementById("hotbar") as HTMLDivElement;

function buildHotbar(): void {
  hotbarEl.innerHTML = "";
  HOTBAR.forEach((id, i) => {
    const def = blockDef(id);
    const slot = document.createElement("div");
    slot.className = "slot" + (i === selected ? " active" : "");
    const sw = document.createElement("div");
    sw.className = "swatch";
    const [r, g, b] = def.color;
    sw.style.background = `rgb(${(r * 255) | 0}, ${(g * 255) | 0}, ${(b * 255) | 0})`;
    slot.appendChild(sw);
    hotbarEl.appendChild(slot);
  });
}
function setSelected(i: number): void {
  selected = i;
  buildHotbar();
}
buildHotbar();

// ---------------------------------------------------------------------------
// Movement + frame loop
// ---------------------------------------------------------------------------
function updatePlayer(dt: number): void {
  const input = {
    forward: (keys.has("KeyW") ? 1 : 0) - (keys.has("KeyS") ? 1 : 0),
    strafe: (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0),
    up: (keys.has("Space") ? 1 : 0) - (keys.has("ShiftLeft") ? 1 : 0),
    jump: keys.has("Space"),
  };
  player = stepMovement(world, player, input, dt, TUNING);

  // Respawn if you somehow fall out of the world.
  if (player.pos[1] < -5) {
    player = { ...player, pos: [SIZE_X / 2 + 0.5, SIZE_Y + 2, SIZE_Z / 2 + 0.5], vel: [0, 0, 0] };
  }
}

function updateCamera(): void {
  const e = eye();
  camera.position.set(e[0], e[1], e[2]);
  camera.rotation.set(player.pitch, player.yaw, 0, "YXZ");
}

function updateHighlight(): void {
  const hit = pickBlock();
  if (hit) {
    highlight.visible = true;
    highlight.position.set(hit.block[0] + 0.5, hit.block[1] + 0.5, hit.block[2] + 0.5);
  } else {
    highlight.visible = false;
  }
}

function resize(): void {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

let last = performance.now();
let fpsT = 0, frames = 0, fps = 0;

function frame(now: number): void {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;

  updatePlayer(dt);
  updateCamera();
  updateHighlight();
  renderer.render(scene, camera);

  frames++; fpsT += dt;
  if (fpsT >= 0.5) { fps = Math.round(frames / fpsT); frames = 0; fpsT = 0; }
  const [px, py, pz] = player.pos;
  const held = blockDef(HOTBAR[selected]).name;
  hud.innerHTML =
    `xyz: ${px.toFixed(1)}, ${py.toFixed(1)}, ${pz.toFixed(1)}<br>` +
    `${fps} fps · ${player.flying ? "flying" : player.onGround ? "ground" : "air"}<br>` +
    `holding: <b>${held}</b>`;

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
