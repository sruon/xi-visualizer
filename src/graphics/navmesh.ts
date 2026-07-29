import * as THREE from "three";

// Parser + mesh builder for LandSandBoat / RecastNavigation ".nav" files
// (the "MSET" tiled navmesh format, as loaded by CNavMesh::load in lsb).
//
// A file is: NavMeshSetHeader, then per-tile { NavMeshTileHeader, tileData }.
// Each tileData is a Detour tile built by dtCreateNavMeshData: a dtMeshHeader
// followed by tightly packed (dtAlign4) blocks of verts, polys, links,
// detailMeshes, detailVerts, detailTris, bvTree, offMeshCons.
//
// Struct layouts assume the build flags lsb uses:
//   RECASTNAVIGATION_DT_POLYREF64 OFF  -> dtPolyRef / dtTileRef = uint32
//   DT_VERTS_PER_POLYGON = 6
// All little-endian (built on x86).
//
// Vertices are emitted in FFXI coordinates (Detour y/z negated), matching the
// ximesh convention, so a navmesh overlays its zone mesh and renders correctly
// under setupBaseScene()'s scale(1, -1, -1).

const NAVMESHSET_MAGIC = 0x4d534554; // 'MSET'
const DT_NAVMESH_MAGIC = 0x444e4156; // 'DNAV'
const DT_VERTS_PER_POLYGON = 6;
const DT_POLYTYPE_OFFMESH_CONNECTION = 1;

// sizeof() of the fixed-size Detour structs, in bytes.
const SZ_POLY = 4 + DT_VERTS_PER_POLYGON * 2 + DT_VERTS_PER_POLYGON * 2 + 2 + 1 + 1; // 32
const SZ_LINK = 12;
const SZ_POLY_DETAIL = 12;
const SZ_BVNODE = 16; // dtBVNode: unsigned short bmin[3], bmax[3], int i
const SZ_OFFMESH_CON = 36; // dtOffMeshConnection: float pos[6], rad, u16 poly, u8 flags, u8 side, u32 userId

// Vertex-weld tolerance (world units) for connectivity analysis. Detour portal
// verts are bit-identical across tile borders, so this is generous.
const COMPONENT_WELD = 0.15;
// Components smaller than this (in polys) are treated as noise "specks" and
// greyed out rather than given a distinct island color.
const SPECK_MAX = 3;

function align4(x: number): number {
  return (x + 3) & ~3;
}

export interface NavTile {
  x: number;
  y: number;
  layer: number;
  polyCount: number;
  vertCount: number;
  positions: number[]; // flat xyz triangle soup (FFXI coords)
  edges: number[]; // flat xyz line-segment pairs (FFXI coords)
  // Per non-offmesh poly (in emission order): triangle count in `positions`.
  polyTriCounts: number[];
  // Per non-offmesh poly: quantized base-vert keys, for shared-edge adjacency.
  // Cleared once components are computed to release memory.
  polyVKeys: string[][];
  // Auto-generated off-mesh (drop/step) links: flat [ax,ay,az, bx,by,bz, ...]
  // in FFXI coords, one endpoint pair per link.
  offMeshLinks: number[];
}

// Connected-component ("island") analysis of the walkable surface. Two polys
// are connected iff they share an edge (two welded verts); Detour can only path
// within a single component (LSB navmeshes carry no off-mesh connections).
export interface NavComponents {
  idOfPoly: Int32Array; // global poly index (emission order) -> component rank
  colors: [number, number, number][]; // per component rank -> rgb
  sizes: number[]; // polys per component, ranked descending
  count: number; // total components (incl. specks)
  islands: number; // components with >= SPECK_MAX polys
  largestPct: number; // % of polys in the biggest component
}

export interface ParsedNavMesh {
  version: number;
  params: {
    orig: [number, number, number];
    tileWidth: number;
    tileHeight: number;
    maxTiles: number;
    maxPolys: number;
  };
  tiles: NavTile[];
  components: NavComponents;
  stats: { numTiles: number; totalPolys: number; totalVerts: number; offMeshLinks: number; };
}

interface MeshHeader {
  magic: number;
  polyCount: number;
  vertCount: number;
  maxLinkCount: number;
  detailMeshCount: number;
  detailVertCount: number;
  detailTriCount: number;
  bvNodeCount: number;
  offMeshConCount: number;
  x: number;
  y: number;
  layer: number;
  size: number;
}

function readMeshHeader(dv: DataView, off: number): MeshHeader {
  let p = off;
  const i32 = () => {
    const v = dv.getInt32(p, true);
    p += 4;
    return v;
  };
  const u32 = () => {
    const v = dv.getUint32(p, true);
    p += 4;
    return v;
  };

  const magic = i32();
  i32(); // version
  const x = i32();
  const y = i32();
  const layer = i32();
  u32(); // userId
  const polyCount = i32();
  const vertCount = i32();
  const maxLinkCount = i32();
  const detailMeshCount = i32();
  const detailVertCount = i32();
  const detailTriCount = i32();
  const bvNodeCount = i32();
  const offMeshConCount = i32();
  i32(); // offMeshBase
  // 10 trailing floats: walkableHeight/Radius/Climb, bmin[3], bmax[3], bvQuantFactor
  p += 10 * 4;

  return {
    magic,
    polyCount,
    vertCount,
    maxLinkCount,
    detailMeshCount,
    detailVertCount,
    detailTriCount,
    bvNodeCount,
    offMeshConCount,
    x,
    y,
    layer,
    size: p - off, // == 100
  };
}

function parseTile(dv: DataView, base: number): NavTile | null {
  const h = readMeshHeader(dv, base);
  if (h.magic !== DT_NAVMESH_MAGIC) {
    return null;
  }

  let off = base + h.size;

  const vertsOff = off;
  off += align4(h.vertCount * 3 * 4);

  const polysOff = off;
  off += align4(h.polyCount * SZ_POLY);

  off += align4(h.maxLinkCount * SZ_LINK); // links (unused)

  const detailMeshOff = off;
  off += align4(h.detailMeshCount * SZ_POLY_DETAIL);

  const detailVertsOff = off;
  off += align4(h.detailVertCount * 3 * 4);

  const detailTrisOff = off;
  off += align4(h.detailTriCount * 4);

  off += align4(h.bvNodeCount * SZ_BVNODE); // bvTree

  const offMeshConsOff = off; // dtOffMeshConnection array

  // Read a vec3 and convert Detour -> FFXI space (negate y, z).
  const readVert = (o: number, i: number): [number, number, number] => [
    dv.getFloat32(o + i * 12, true),
    -dv.getFloat32(o + i * 12 + 4, true),
    -dv.getFloat32(o + i * 12 + 8, true),
  ];

  // Off-mesh connection endpoints: dtOffMeshConnection.pos[6] = start xyz, end xyz.
  const offMeshLinks: number[] = [];
  for (let c = 0; c < h.offMeshConCount; c++) {
    const o = offMeshConsOff + c * SZ_OFFMESH_CON;
    const a = readVert(o, 0);
    const b = readVert(o, 1);
    offMeshLinks.push(a[0], a[1], a[2], b[0], b[1], b[2]);
  }

  const positions: number[] = [];
  const edges: number[] = [];
  const polyTriCounts: number[] = [];
  const polyVKeys: string[][] = [];

  const q = (n: number) => Math.round(n / COMPONENT_WELD);

  for (let ip = 0; ip < h.polyCount; ip++) {
    const pOff = polysOff + ip * SZ_POLY;
    // dtPoly: firstLink(u32), verts[6](u16), neis[6](u16), flags(u16), vertCount(u8), areaAndtype(u8)
    const vidxOff = pOff + 4;
    const polyVertCount = dv.getUint8(pOff + 4 + 12 + 12 + 2);
    const areaAndType = dv.getUint8(pOff + 4 + 12 + 12 + 2 + 1);
    if (areaAndType >> 6 === DT_POLYTYPE_OFFMESH_CONNECTION) {
      continue;
    }

    const polyVerts: number[] = [];
    for (let k = 0; k < polyVertCount; k++) {
      polyVerts.push(dv.getUint16(vidxOff + k * 2, true));
    }

    // Poly outline edges (base verts, closed loop) + welded keys for adjacency.
    const vkeys: string[] = [];
    for (let k = 0; k < polyVertCount; k++) {
      const a = readVert(vertsOff, polyVerts[k]);
      const b = readVert(vertsOff, polyVerts[(k + 1) % polyVertCount]);
      edges.push(a[0], a[1], a[2], b[0], b[1], b[2]);
      vkeys.push(`${q(a[0])},${q(a[1])},${q(a[2])}`);
    }
    polyVKeys.push(vkeys);

    // Detail-mesh triangles for the filled surface.
    const dmOff = detailMeshOff + ip * SZ_POLY_DETAIL;
    const vertBase = dv.getUint32(dmOff, true);
    const triBase = dv.getUint32(dmOff + 4, true);
    const triCount = dv.getUint8(dmOff + 9);
    polyTriCounts.push(triCount);

    for (let j = 0; j < triCount; j++) {
      const tOff = detailTrisOff + (triBase + j) * 4;
      for (let k = 0; k < 3; k++) {
        const vi = dv.getUint8(tOff + k);
        const v = vi < polyVertCount
          ? readVert(vertsOff, polyVerts[vi])
          : readVert(detailVertsOff, vertBase + (vi - polyVertCount));
        positions.push(v[0], v[1], v[2]);
      }
    }
  }

  return {
    x: h.x,
    y: h.y,
    layer: h.layer,
    polyCount: h.polyCount,
    vertCount: h.vertCount,
    positions,
    edges,
    polyTriCounts,
    polyVKeys,
    offMeshLinks,
  };
}

// Flood-fill the walkable surface into connected components via shared-edge
// adjacency, rank them by size, and assign each a display color (specks grey).
function computeComponents(tiles: NavTile[]): NavComponents {
  // Weld base verts globally, then list each poly's welded vert ids.
  const weld = new Map<string, number>();
  let nextV = 0;
  const wid = (k: string): number => {
    let v = weld.get(k);
    if (v === undefined) {
      v = nextV++;
      weld.set(k, v);
    }

    return v;
  };

  const polyWverts: number[][] = [];
  for (const t of tiles) {
    for (const vk of t.polyVKeys) {
      polyWverts.push(vk.map(wid));
    }
  }

  const n = polyWverts.length;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;

  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }

    return x;
  };
  const union = (a: number, b: number) => {
    a = find(a);
    b = find(b);
    if (a !== b) parent[a] = b;
  };

  // Two polys sharing an edge (ordered vert pair) are adjacent.
  const edgeOwner = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const ids = polyWverts[i];
    const L = ids.length;
    for (let k = 0; k < L; k++) {
      let a = ids[k];
      let b = ids[(k + 1) % L];
      if (a > b) {
        const t = a;
        a = b;
        b = t;
      }

      const key = a * 4000037 + b;
      const owner = edgeOwner.get(key);
      if (owner === undefined) {
        edgeOwner.set(key, i);
      } else {
        union(owner, i);
      }
    }
  }

  const sizeByRoot = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    sizeByRoot.set(r, (sizeByRoot.get(r) ?? 0) + 1);
  }

  const roots = [...sizeByRoot.entries()].sort((a, b) => b[1] - a[1]);
  const rankOfRoot = new Map<number, number>();
  roots.forEach(([r], idx) => rankOfRoot.set(r, idx));

  const idOfPoly = new Int32Array(n);
  for (let i = 0; i < n; i++) idOfPoly[i] = rankOfRoot.get(find(i))!;

  const sizes = roots.map(([, s]) => s);
  const tmp = new THREE.Color();
  const colors: [number, number, number][] = sizes.map((s, rank) => {
    if (s < SPECK_MAX) return [0.32, 0.32, 0.36];
    tmp.setHSL((rank * 0.618033988749895) % 1.0, 0.68, 0.55);
    return [tmp.r, tmp.g, tmp.b];
  });

  const islands = sizes.filter(s => s >= SPECK_MAX).length;
  const largestPct = n > 0 ? (100 * sizes[0]) / n : 0;

  return { idOfPoly, colors, sizes, count: roots.length, islands, largestPct };
}

export function parseNavMesh(buffer: ArrayBufferLike): ParsedNavMesh {
  const dv = new DataView(buffer as ArrayBuffer);
  let off = 0;

  // NavMeshSetHeader: magic(i32), version(i32), numTiles(i32), dtNavMeshParams
  const magic = dv.getInt32(off, true);
  off += 4;
  const version = dv.getInt32(off, true);
  off += 4;
  if (magic !== NAVMESHSET_MAGIC) {
    throw new Error(`Not a MSET navmesh (magic=0x${(magic >>> 0).toString(16)})`);
  }

  const numTiles = dv.getInt32(off, true);
  off += 4;

  // dtNavMeshParams: float orig[3], float tileWidth, float tileHeight, int maxTiles, int maxPolys
  const orig: [number, number, number] = [
    dv.getFloat32(off, true),
    dv.getFloat32(off + 4, true),
    dv.getFloat32(off + 8, true),
  ];
  off += 12;
  const tileWidth = dv.getFloat32(off, true);
  off += 4;
  const tileHeight = dv.getFloat32(off, true);
  off += 4;
  const maxTiles = dv.getInt32(off, true);
  off += 4;
  const maxPolys = dv.getInt32(off, true);
  off += 4;

  const tiles: NavTile[] = [];
  let totalPolys = 0;
  let totalVerts = 0;

  for (let i = 0; i < numTiles; i++) {
    // NavMeshTileHeader: dtTileRef tileRef(u32), int dataSize
    const tileRef = dv.getUint32(off, true);
    off += 4;
    const dataSize = dv.getInt32(off, true);
    off += 4;
    if (!tileRef || !dataSize) {
      break;
    }

    const tile = parseTile(dv, off);
    if (tile) {
      tiles.push(tile);
      totalPolys += tile.polyCount;
      totalVerts += tile.vertCount;
    }

    off += dataSize;
  }

  const components = computeComponents(tiles);
  // Free the per-poly weld keys now that components are resolved.
  for (const t of tiles) t.polyVKeys = [];

  let offMeshLinks = 0;
  for (const t of tiles) offMeshLinks += t.offMeshLinks.length / 6;

  return {
    version,
    params: { orig, tileWidth, tileHeight, maxTiles, maxPolys },
    tiles,
    components,
    stats: { numTiles: tiles.length, totalPolys, totalVerts, offMeshLinks },
  };
}

// Find the walkable island nearest an FFXI (x, y, z) point: the poly whose
// triangle centroid is closest, and the connected component it belongs to.
// Lets the viewer answer "is this coordinate reachable / on its own island?".
export function nearestIsland(
  parsed: ParsedNavMesh,
  x: number,
  y: number,
  z: number,
): { island: number; size: number; dist: number; } | null {
  const comp = parsed.components;
  let globalPoly = 0;
  let best = -1;
  let bestDsq = Infinity;

  for (const t of parsed.tiles) {
    let vtx = 0;
    for (let pi = 0; pi < t.polyTriCounts.length; pi++) {
      const verts = t.polyTriCounts[pi] * 3;
      if (verts > 0) {
        let cx = 0;
        let cy = 0;
        let cz = 0;
        for (let v = 0; v < verts; v++) {
          const b = (vtx + v) * 3;
          cx += t.positions[b];
          cy += t.positions[b + 1];
          cz += t.positions[b + 2];
        }

        cx /= verts;
        cy /= verts;
        cz /= verts;
        const dsq = (cx - x) ** 2 + (cy - y) ** 2 + (cz - z) ** 2;
        if (dsq < bestDsq) {
          bestDsq = dsq;
          best = globalPoly;
        }
      }

      vtx += verts;
      globalPoly++;
    }
  }

  if (best < 0) return null;

  const island = comp.idOfPoly[best];
  return { island, size: comp.sizes[island], dist: Math.sqrt(bestDsq) };
}

// Distinct-ish per-tile hue via the golden-ratio sequence.
function tileColor(i: number, out: THREE.Color): THREE.Color {
  return out.setHSL((i * 0.618033988749895) % 1.0, 0.55, 0.6);
}

const BASE_SURFACE = new THREE.Color(0x4a8fe0);

export interface NavMeshBuildOptions {
  showSurface: boolean;
  showEdges: boolean;
  colorByTile: boolean;
  colorByComponent: boolean; // takes precedence over colorByTile when set
  showOffMesh: boolean; // auto-generated drop/step links
  opacity: number;
}

// Build a single Group holding the merged navmesh surface + poly outlines.
// Everything is merged into one geometry each (with vertex colors) so even
// zones with thousands of tiles stay at two draw calls.
export function buildNavMeshGroup(parsed: ParsedNavMesh, opts: NavMeshBuildOptions): THREE.Group {
  const group = new THREE.Group();
  const c = new THREE.Color();

  if (opts.showSurface) {
    let total = 0;
    for (const t of parsed.tiles) total += t.positions.length;

    const positions = new Float32Array(total);
    const colors = new Float32Array(total);
    const comp = parsed.components;
    let o = 0;
    let globalPoly = 0; // index into comp.idOfPoly, in tile/poly emission order
    parsed.tiles.forEach((t, i) => {
      // Copy the tile's triangle-soup positions verbatim.
      for (let k = 0; k < t.positions.length; k++) positions[o + k] = t.positions[k];

      if (opts.colorByComponent) {
        // Color each poly's triangles by its connected-component color.
        let vtx = 0; // vertex offset within this tile
        for (let pi = 0; pi < t.polyTriCounts.length; pi++) {
          const cc = comp.colors[comp.idOfPoly[globalPoly++]];
          const verts = t.polyTriCounts[pi] * 3;
          for (let v = 0; v < verts; v++) {
            const b = o + vtx * 3;
            colors[b] = cc[0];
            colors[b + 1] = cc[1];
            colors[b + 2] = cc[2];
            vtx++;
          }
        }
      } else {
        const col = opts.colorByTile ? tileColor(i, c) : BASE_SURFACE;
        for (let k = 0; k < t.positions.length; k += 3) {
          colors[o + k] = col.r;
          colors[o + k + 1] = col.g;
          colors[o + k + 2] = col.b;
        }
      }

      o += t.positions.length;
    });

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    geo.computeBoundingBox();

    const mat = new THREE.MeshLambertMaterial({
      vertexColors: true,
      transparent: opts.opacity < 1,
      opacity: opts.opacity,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = "navmesh-surface";
    group.add(mesh);
  }

  if (opts.showEdges) {
    let total = 0;
    for (const t of parsed.tiles) total += t.edges.length;

    const positions = new Float32Array(total);
    const colors = new Float32Array(total);
    let o = 0;
    parsed.tiles.forEach((t, i) => {
      if (opts.colorByTile) {
        tileColor(i, c).offsetHSL(0, 0, 0.18);
      } else {
        c.setHex(0x0c1016);
      }
      for (let k = 0; k < t.edges.length; k += 3) {
        positions[o] = t.edges[k];
        positions[o + 1] = t.edges[k + 1];
        positions[o + 2] = t.edges[k + 2];
        colors[o] = c.r;
        colors[o + 1] = c.g;
        colors[o + 2] = c.b;
        o += 3;
      }
    });

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));

    const mesh = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true }));
    mesh.name = "navmesh-edges";
    group.add(mesh);
  }

  if (opts.showOffMesh) {
    let total = 0;
    for (const t of parsed.tiles) total += t.offMeshLinks.length;

    if (total > 0) {
      // One bright line per link (start -> end) + a small marker at each endpoint,
      // drawn on top (depthTest off) so links stay visible through the surface.
      const linePos = new Float32Array(total);
      let o = 0;
      for (const t of parsed.tiles) {
        for (let k = 0; k < t.offMeshLinks.length; k++) linePos[o++] = t.offMeshLinks[k];
      }

      const lineGeo = new THREE.BufferGeometry();
      lineGeo.setAttribute("position", new THREE.BufferAttribute(linePos, 3));
      const lines = new THREE.LineSegments(
        lineGeo,
        new THREE.LineBasicMaterial({ color: 0xff2d55, depthTest: false, transparent: true }),
      );
      lines.name = "navmesh-offmesh";
      lines.renderOrder = 998;
      group.add(lines);

      // Endpoint markers as points.
      const points = new THREE.Points(
        lineGeo,
        new THREE.PointsMaterial({ color: 0xffe066, size: 3, sizeAttenuation: false, depthTest: false }),
      );
      points.name = "navmesh-offmesh-pts";
      points.renderOrder = 999;
      group.add(points);
    }
  }

  return group;
}
