/**
 * src/render/scene.js — the Three.js "realistic diorama" board renderer (Phase 2).
 *
 * Read-only mirror of the reconstructed GameState. Subscribes to the state model and
 * builds/updates meshes reactively (no full rebuilds). Style: naturalistic PBR materials,
 * a dramatic key light + hemisphere fill, soft shadow maps, ACES filmic tone mapping, and
 * OrbitControls with a pleasant default framing. Water ring surrounds the island.
 *
 * Board placement uses src/render/boardGeometry.js (axial -> world). World scale: HEX = 1
 * circumradius unit; we scale the whole board group to taste.
 */
import * as THREE from "../../vendor/three.module.js";
import { OrbitControls } from "../../vendor/OrbitControls.js";
import { hexCenter, hexCorners, cornerPosExact, edgePos, edgeCorners } from "./boardGeometry.js";
import { makeTileMaterial, RESOURCE, makeNumberTexture, makeWaterMaterial, makeSandMaterial, playerColor } from "./materials.js";

const HEX_R = 1;           // hex circumradius in world units
const HEX_H = 0.28;        // hex prism extrude depth
const HEX_BEVEL = 0.06;    // bevel thickness
const TILE_TOP = HEX_H + HEX_BEVEL; // world-Y of the tile's top surface (~0.34)
const BOARD_SCALE = 1;     // overall board scale

// Pointy-top hexagon shape (for extruded prisms) — flat side up would be flat-top; Colonist is
// pointy-top per our coordinate math (corners at ±90°).
function hexPrismGeometry(radius, height, bevel = 0.06) {
  const shape = new THREE.Shape();
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 6 + (i * Math.PI) / 3; // start at 30° -> pointy top
    const x = radius * Math.cos(a), y = radius * Math.sin(a);
    if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
  }
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: height, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel,
    bevelSegments: 2, steps: 1,
  });
  geo.rotateX(-Math.PI / 2);      // lay flat (extrude along +Y)
  // Normalize so the TOP surface sits exactly at y = TILE_TOP and bottom is below 0.
  geo.computeBoundingBox();
  const topLocal = geo.boundingBox.max.y;
  geo.translate(0, TILE_TOP - topLocal, 0);
  geo.computeVertexNormals();
  return geo;
}

export class BoardScene {
  constructor(container, { width, height } = {}) {
    this.container = container;
    this.disposers = [];
    this.tileMeshes = new Map();   // hexIndex -> mesh
    this.numberMeshes = new Map();
    this.pieceMeshes = new Map();  // key -> mesh (settlements/cities/roads/robber)
    this._built = false;

    const w = width || container.clientWidth || 960;
    const h = height || container.clientHeight || 600;

    // Renderer
    // alpha configurable: opaque (sky background) for standalone; transparent for overlay.
    const transparent = this._transparent = false;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: transparent, powerPreference: "high-performance" });
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    // Scene + fog for depth. Solid sky-blue background (reliable across contexts). In the
    // live extension this can be set to null to let the page show through around the island.
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x8fc3ea);
    this.scene = scene;

    // Camera
    const camera = new THREE.PerspectiveCamera(42, w / h, 0.1, 200);
    camera.position.set(0, 11, 12);
    this.camera = camera;

    // Controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 6;
    controls.maxDistance = 40;
    controls.maxPolarAngle = Math.PI * 0.49; // don't go under the board
    controls.target.set(0, 0, 0);
    this.controls = controls;

    this._setupLights();
    this._setupEnvironment();

    // Board group (everything scales/rotates together)
    this.board = new THREE.Group();
    this.board.scale.setScalar(BOARD_SCALE);
    scene.add(this.board);

    this._animate = this._animate.bind(this);
    this._raf = requestAnimationFrame(this._animate);
  }

  _setupLights() {
    const { scene } = this;
    // Warm key light with soft shadows (the "sun").
    const key = new THREE.DirectionalLight(0xfff4e0, 2.6);
    key.position.set(8, 14, 6);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 1; key.shadow.camera.far = 60;
    const d = 14;
    key.shadow.camera.left = -d; key.shadow.camera.right = d;
    key.shadow.camera.top = d; key.shadow.camera.bottom = -d;
    key.shadow.bias = -0.0004;
    key.shadow.radius = 4;
    scene.add(key);
    this.keyLight = key;

    // Cool sky/ground hemisphere fill for natural ambient.
    const hemi = new THREE.HemisphereLight(0xcfe4ff, 0x5a4632, 1.15);
    scene.add(hemi);
    scene.add(new THREE.AmbientLight(0xffffff, 0.18));

    // Soft rim/back light to separate pieces from water.
    const rim = new THREE.DirectionalLight(0x9fc4ff, 0.5);
    rim.position.set(-10, 6, -8);
    scene.add(rim);
  }

  _setupEnvironment() {
    const { scene } = this;
    // Big rippled sea plane. Sits below the sandy island; extends to the horizon/fog.
    const water = new THREE.Mesh(new THREE.CircleGeometry(60, 128), makeWaterMaterial());
    water.rotation.x = -Math.PI / 2;
    water.position.y = -0.35;
    water.receiveShadow = true;
    scene.add(water);
    this.water = water;

    // Island base: a shallow sandy disc the tiles rest on, tapering to a beach edge that meets
    // the water. Sized to hug the hex board so open sea is visible around it.
    const sandTex = makeSandMaterial();
    const island = new THREE.Mesh(new THREE.CylinderGeometry(5.3, 4.6, 0.5, 96), sandTex);
    island.position.y = -0.27; island.receiveShadow = true;
    scene.add(island);
    this.island = island;

    scene.fog = new THREE.Fog(0x8fc3ea, 38, 90);
  }

  // Convert board-space (u,v) to world (x,z). Board v grows "down" in 2D; map to +z.
  _toWorld(u, v) { return [u * HEX_R, v * HEX_R]; }

  /** Build the static board (tiles, numbers, ports, water) from the first snapshot. */
  buildBoard(state) {
    if (this._built) return;
    const hexes = state.hexes;
    if (!hexes.length) return;

    // Center the board group so (0,0) hex sits at world origin (board is already ~centered).
    for (const hex of hexes) this._addTile(hex);
    for (const port of state.ports) this._addPort(port);
    this._built = true;
    this._frameCamera(state);
  }

  _addTile(hex) {
    const { u, v } = hexCenter(hex.x, hex.y);
    const [x, z] = this._toWorld(u, v);
    const geo = hexPrismGeometry(HEX_R * 0.98, HEX_H, HEX_BEVEL);
    const mat = makeTileMaterial(hex.type);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, 0, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData = { hexIndex: hex.index, type: hex.type };
    this.board.add(mesh);
    this.tileMeshes.set(hex.index, mesh);

    // Number token (skip desert / 0).
    if (hex.diceNumber && hex.type !== RESOURCE.DESERT) {
      const token = this._makeNumberToken(hex.diceNumber);
      token.position.set(x, TILE_TOP + 0.05, z);
      this.board.add(token);
      this.numberMeshes.set(hex.index, token);
    }
  }

  _makeNumberToken(n) {
    const isHot = n === 6 || n === 8;
    const R = 0.36;
    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(R, R, 0.08, 48),
      new THREE.MeshStandardMaterial({ color: 0xf5edd6, roughness: 0.8, metalness: 0 })
    );
    disc.castShadow = true; disc.receiveShadow = true;
    const tex = makeNumberTexture(n, isHot);
    const face = new THREE.Mesh(
      new THREE.CircleGeometry(R - 0.015, 48),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55, transparent: true, polygonOffset: true, polygonOffsetFactor: -2 })
    );
    face.rotation.x = -Math.PI / 2;
    face.position.y = 0.041;
    const g = new THREE.Group(); g.add(disc); g.add(face);
    return g;
  }

  _addPort(port) {
    // Simple dock marker: a small post at the port edge, pushed slightly outward.
    const { u, v } = edgePos(port.x, port.y, port.z);
    const [x, z] = this._toWorld(u, v);
    const out = 1.28; // push outward from center
    const len = Math.hypot(x, z) || 1;
    const px = (x / len) * (len * out), pz = (z / len) * (len * out);
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.06, 0.5, 12),
      new THREE.MeshStandardMaterial({ color: 0x7a5230, roughness: 0.9 })
    );
    post.position.set(px, 0.2, pz);
    post.castShadow = true;
    this.board.add(post);
  }

  // -------------------- pieces (settlements / cities / roads / robber) --------------------

  /** Reconcile all pieces from current state — adds new, updates changed, removes gone. */
  syncPieces(state) {
    if (!this._built) this.buildBoard(state);
    if (!this._built) return;
    const seen = new Set();

    // Settlements + cities (corners).
    const corners = state.gameState?.mapState?.tileCornerStates || {};
    for (const [idx, c] of Object.entries(corners)) {
      if (c.owner == null || c.owner === -1) continue;
      const isCity = c.buildingType === 2;
      const key = `corner:${idx}`;
      seen.add(key);
      const existing = this.pieceMeshes.get(key);
      if (existing && existing.userData.isCity === isCity && existing.userData.owner === c.owner) continue;
      if (existing) { this.board.remove(existing); this.pieceMeshes.delete(key); }
      const mesh = isCity ? this._makeCity(c.owner) : this._makeSettlement(c.owner);
      const { u, v } = cornerPosExact(c.x, c.y, c.z);
      const [x, z] = this._toWorld(u, v);
      mesh.position.set(x, TILE_TOP, z);
      mesh.userData = { isCity, owner: c.owner, growAxis: "uniform" };
      mesh.scale.setScalar(0.01);
      this.board.add(mesh);
      this.pieceMeshes.set(key, mesh);
    }

    // Roads (edges).
    const edges = state.gameState?.mapState?.tileEdgeStates || {};
    for (const [idx, e] of Object.entries(edges)) {
      if (e.owner == null || e.owner === -1) continue;
      const key = `edge:${idx}`;
      seen.add(key);
      if (this.pieceMeshes.has(key)) continue;
      const mesh = this._makeRoad(e);
      mesh.userData = { owner: e.owner, growAxis: "x" };
      mesh.scale.set(0.01, 1, 1);
      this.board.add(mesh);
      this.pieceMeshes.set(key, mesh);
    }

    // Robber (single).
    const robberIdx = state.robberTileIndex ?? state.gameState?.mechanicRobberState?.locationTileIndex;
    if (robberIdx != null) {
      const hex = state.hexes.find((h) => h.index === robberIdx);
      if (hex) {
        let rob = this.pieceMeshes.get("robber");
        if (!rob) { rob = this._makeRobber(); this.board.add(rob); this.pieceMeshes.set("robber", rob); }
        seen.add("robber");
        const { u, v } = hexCenter(hex.x, hex.y);
        const [x, z] = this._toWorld(u, v);
        rob.userData.target = new THREE.Vector3(x, TILE_TOP + 0.02, z);
        if (!rob.position.lengthSq()) rob.position.set(x, TILE_TOP + 0.02, z);
      }
    }

    // Remove pieces no longer present (e.g. settlement upgraded to city handled above).
    for (const [key, mesh] of this.pieceMeshes) {
      if (key === "robber") continue;
      if (!seen.has(key)) { this.board.remove(mesh); this.pieceMeshes.delete(key); }
    }
  }

  _makeSettlement(color) {
    const g = new THREE.Group();
    const col = playerColor(color);
    const wall = new THREE.MeshStandardMaterial({ color: col, roughness: 0.4, metalness: 0.05 });
    const roofMat = new THREE.MeshStandardMaterial({ color: darken(col, 0.68), roughness: 0.5 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.28, 0.34), wall);
    body.position.y = 0.14; body.castShadow = true; body.receiveShadow = true;
    const roof = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.22, 4), roofMat);
    roof.position.y = 0.39; roof.rotation.y = Math.PI / 4; roof.castShadow = true;
    g.add(body, roof);
    return g;
  }
  _makeCity(color) {
    const g = new THREE.Group();
    const col = playerColor(color);
    const wall = new THREE.MeshStandardMaterial({ color: col, roughness: 0.38, metalness: 0.08 });
    const roofMat = new THREE.MeshStandardMaterial({ color: darken(col, 0.62), roughness: 0.5 });
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.3, 0.4), wall); base.position.set(-0.06, 0.15, 0); base.castShadow = true; base.receiveShadow = true;
    const tower = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.46, 0.32), wall); tower.position.set(0.18, 0.38, 0); tower.castShadow = true;
    const roof = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.22, 4), roofMat); roof.position.set(0.18, 0.72, 0); roof.rotation.y = Math.PI / 4; roof.castShadow = true;
    const roof2 = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.06, 0.42), roofMat); roof2.position.set(-0.06, 0.31, 0); roof2.castShadow = true;
    g.add(base, tower, roof, roof2);
    return g;
  }
  _makeRoad(edge) {
    // Oriented bar between the edge's two endpoint corners.
    const [a, b] = edgeCorners(edge.x, edge.y, edge.z);
    const pa = cornerPosExact(a.x, a.y, a.z), pb = cornerPosExact(b.x, b.y, b.z);
    const [ax, az] = this._toWorld(pa.u, pa.v), [bx, bz] = this._toWorld(pb.u, pb.v);
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    const len = Math.hypot(bx - ax, bz - az);
    const col = playerColor(edge.owner);
    const h = 0.12;
    const bar = new THREE.Mesh(
      new THREE.BoxGeometry(len * 0.8, h, 0.15),
      new THREE.MeshStandardMaterial({ color: col, roughness: 0.42, metalness: 0.06 })
    );
    bar.position.y = h / 2; bar.castShadow = true; bar.receiveShadow = true;
    const grp = new THREE.Group();
    grp.add(bar);
    grp.position.set(mx, TILE_TOP + 0.005, mz);
    grp.rotation.y = -Math.atan2(bz - az, bx - ax);
    return grp;
  }
  _makeRobber() {
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0x26262b, roughness: 0.55, metalness: 0.25 });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.26, 0.22, 24), mat); base.position.y = 0.11; base.castShadow = true;
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.2, 0.38, 24), mat); body.position.y = 0.4; body.castShadow = true;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 24, 18), mat); head.position.y = 0.68; head.castShadow = true;
    g.add(base, body, head);
    return g;
  }

  _frameCamera(state) {
    // Fit camera to board bounds with a steeper, more top-down diorama angle so flat number
    // tokens stay readable (a shallow angle makes them disappear edge-on).
    const box = new THREE.Box3().setFromObject(this.board);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    this.controls.target.copy(center);
    const radius = Math.max(size.x, size.z) * 0.78;
    // higher Y, moderate Z -> ~52° down-tilt, pulled back so the sea shows around the island
    this.camera.position.set(center.x + radius * 0.12, center.y + radius * 1.85, center.z + radius * 1.25);
    this.camera.lookAt(center);
    this.controls.update();
  }

  resize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  _animate() {
    this._raf = requestAnimationFrame(this._animate);
    this.controls.update();
    // piece pop-in + robber glide animations
    for (const mesh of this.pieceMeshes.values()) {
      const ga = mesh.userData.growAxis;
      if (ga === "uniform" && mesh.scale.x < 1) {
        const s = Math.min(1, mesh.scale.x + 0.09); mesh.scale.setScalar(s); if (s >= 1) mesh.userData.growAxis = null;
      } else if (ga === "x" && mesh.scale.x < 1) {
        mesh.scale.x = Math.min(1, mesh.scale.x + 0.12); if (mesh.scale.x >= 1) mesh.userData.growAxis = null;
      }
      if (mesh.userData.target) {
        mesh.position.lerp(mesh.userData.target, 0.15);
        if (mesh.position.distanceTo(mesh.userData.target) < 0.001) mesh.userData.target = null;
      }
    }
    if (this._onFrame) this._onFrame();
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    cancelAnimationFrame(this._raf);
    this.renderer.dispose();
    this.renderer.domElement.remove();
    for (const d of this.disposers) try { d(); } catch {}
  }
}

function darken(hex, f) {
  const r = ((hex >> 16) & 255) * f, g = ((hex >> 8) & 255) * f, b = (hex & 255) * f;
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
}

function makeSkyTexture() {
  const c = document.createElement("canvas"); c.width = 4; c.height = 256;
  const g = c.getContext("2d"); const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, "#8fc7f0"); grad.addColorStop(0.5, "#bfe0f5"); grad.addColorStop(1, "#e8f2f7");
  g.fillStyle = grad; g.fillRect(0, 0, 4, 256);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.needsUpdate = true;
  return t;
}
