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
  stats: { numTiles: number; totalPolys: number; totalVerts: number; };
}

interface MeshHeader {
  magic: number;
  polyCount: number;
  vertCount: number;
  maxLinkCount: number;
  detailMeshCount: number;
  detailVertCount: number;
  detailTriCount: number;
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
  i32(); // bvNodeCount
  i32(); // offMeshConCount
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
  // bvTree, offMeshCons follow but aren't needed for the surface.

  // Read a vec3 and convert Detour -> FFXI space (negate y, z).
  const readVert = (o: number, i: number): [number, number, number] => [
    dv.getFloat32(o + i * 12, true),
    -dv.getFloat32(o + i * 12 + 4, true),
    -dv.getFloat32(o + i * 12 + 8, true),
  ];

  const positions: number[] = [];
  const edges: number[] = [];

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

    // Poly outline edges (base verts, closed loop).
    for (let k = 0; k < polyVertCount; k++) {
      const a = readVert(vertsOff, polyVerts[k]);
      const b = readVert(vertsOff, polyVerts[(k + 1) % polyVertCount]);
      edges.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    }

    // Detail-mesh triangles for the filled surface.
    const dmOff = detailMeshOff + ip * SZ_POLY_DETAIL;
    const vertBase = dv.getUint32(dmOff, true);
    const triBase = dv.getUint32(dmOff + 4, true);
    const triCount = dv.getUint8(dmOff + 9);

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
  };
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

  return {
    version,
    params: { orig, tileWidth, tileHeight, maxTiles, maxPolys },
    tiles,
    stats: { numTiles: tiles.length, totalPolys, totalVerts },
  };
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
    let o = 0;
    parsed.tiles.forEach((t, i) => {
      const col = opts.colorByTile ? tileColor(i, c) : BASE_SURFACE;
      for (let k = 0; k < t.positions.length; k += 3) {
        positions[o] = t.positions[k];
        positions[o + 1] = t.positions[k + 1];
        positions[o + 2] = t.positions[k + 2];
        colors[o] = col.r;
        colors[o + 1] = col.g;
        colors[o + 2] = col.b;
        o += 3;
      }
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

  return group;
}
