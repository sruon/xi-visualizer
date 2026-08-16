import type { ZoneData } from "./components/zone_model";
import zones from "./data/zones";
import { decompress, fetchProgress } from "./util";

/** Downloads and decompresses a zone's ximesh, reporting progress as it goes. */
export async function loadZoneMesh(id: number, onStatus: (message?: string) => void): Promise<ZoneData> {
  const zone = zones[id];
  if (!zone) throw new Error(`unknown zone id ${id}`);

  const filename = zone.name
    .replaceAll(" - ", "-")
    .replaceAll(" ", "_")
    .replaceAll("'", "")
    .replaceAll("(", "")
    .replaceAll(")", "")
    .replaceAll("#", "");

  onStatus("Downloading mesh...");
  const compressed = await fetchProgress(`${import.meta.env.BASE_URL}/ximeshes/${filename}.ximesh`, progress => {
    if (progress !== undefined) onStatus(`Downloading mesh ${(progress * 100).toFixed(0)}%`);
  });
  onStatus("Decompressing mesh...");
  const mesh = await decompress(compressed);
  onStatus(undefined);
  return { id, name: zone.name, mesh } as ZoneData;
}
