import zones from "./data/zones";
import { decompress, fetchProgress } from "./util";

const PATHDATA = import.meta.env.VITE_PATHDATA_URL || `${import.meta.env.BASE_URL}/pathdata_gz`;

/** Flattened roam trails: one buffer for the whole zone, plus where each mob's points live in it. */
export interface RoamData {
  positions: Float32Array;
  times: Float64Array;
  ranges: Record<string, [number, number]>;
  count: number;
}

/** Downloads a zone's recorded roam trails. Rejects for a zone nobody has recorded. */
export async function loadRoam(id: number): Promise<RoamData> {
  // '#' is kept: the roam files are named for the zone, so Riverne is Riverne_-_Site_#A01.
  const file = zones[id].name
    .replaceAll(" - ", "_-_")
    .replaceAll(" ", "_")
    .replaceAll("'", "_");
  const compressed = await fetchProgress(`${PATHDATA}/${encodeURIComponent(file)}.json.gz`, () => {});
  const data = JSON.parse(new TextDecoder().decode(await decompress(compressed, "gzip")));

  let count = 0;
  for (const mob of Object.values<any>(data)) count += mob.points.length;
  const positions = new Float32Array(count * 3);
  // Capture time, kept because the samples are not evenly spaced: minutes can pass between two of
  // them, and a route must not draw a leg through a stretch where nobody was watching the mob.
  const times = new Float64Array(count);
  const ranges: Record<string, [number, number]> = {};
  let o = 0;
  for (const [mobId, mob] of Object.entries<any>(data)) {
    ranges[mobId] = [o / 3, mob.points.length];
    for (const p of mob.points) {
      times[o / 3] = p.t ?? 0;
      positions[o++] = p.x;
      positions[o++] = p.y;
      positions[o++] = p.z;
    }
  }
  return { positions, times, ranges, count };
}

/** The recorded points of a set of mobs, as one flat xyz buffer. */
export function trailOf(data: RoamData, ids: string[]): Float32Array {
  const slices = ids.map(id => data.ranges[id]).filter((r): r is [number, number] => !!r);
  const out = new Float32Array(slices.reduce((n, [, count]) => n + count * 3, 0));
  let o = 0;
  for (const [start, count] of slices) {
    out.set(data.positions.subarray(start * 3, (start + count) * 3), o);
    o += count * 3;
  }
  return out;
}
