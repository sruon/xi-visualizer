import { createResource, createSignal, Match, Show, Switch } from "solid-js";
import { useNavigate, useParams } from "@solidjs/router";
import LookupInput from "../components/lookup_input";
import RoamViewer from "../components/roam_viewer";
import { ZoneData } from "../components/zone_model";
import zones from "../data/zones";
import { decompress, fetchProgress } from "../util";

const PATHDATA_BASE_URL = import.meta.env.VITE_PATHDATA_URL || `${import.meta.env.BASE_URL}/pathdata`;

// Map pathdata filenames to zone info
interface RoamZone {
  id: number;
  name: string;
  pathFile: string;
}

// Load available roam zones by checking which pathdata files exist
const roamZones: { [id: number]: RoamZone } = {};

// Map zone names to pathdata filenames (underscore format)
function zoneNameToPathFile(name: string): string {
  return name
    .replaceAll(" - ", "_-_")
    .replaceAll(" ", "_")
    .replaceAll("'", "_")
    .replaceAll("#", "");
}

// Build roam zones lookup from zones data
for (const zoneId in zones) {
  const zone = zones[zoneId];
  roamZones[zoneId] = {
    id: zone.id,
    name: zone.name,
    pathFile: zoneNameToPathFile(zone.name),
  };
}

interface PathPoint {
  x: number;
  y: number;
  z: number;
  dir: number;
  t: number;
}

interface MobPathData {
  name: string;
  points: PathPoint[];
}

interface PathData {
  [mobId: string]: MobPathData;
}

export default function RoamPage() {
  const navigate = useNavigate();
  const params = useParams();

  const [getLoadingMessage, setLoadingMessage] = createSignal<string | undefined>();

  // Load zone mesh
  const [zoneMesh] = createResource(
    () => params.id,
    async (zoneIdStr) => {
      if (!zoneIdStr) return undefined;

      const zoneId = parseInt(zoneIdStr);
      const zone = zones[zoneId];
      if (!zone) return undefined;

      const filename = zone.name
        .replaceAll(" - ", "-")
        .replaceAll(" ", "_")
        .replaceAll("'", "")
        .replaceAll("(", "")
        .replaceAll(")", "")
        .replaceAll("#", "");

      const url = `${import.meta.env.BASE_URL}/ximeshes/${filename}.ximesh`;

      setLoadingMessage("Downloading mesh...");
      const compressed = await fetchProgress(url, (progress: number) => {
        if (progress !== undefined) {
          setLoadingMessage(`Downloading mesh ${(progress * 100).toFixed(0)}%`);
        }
      });

      setLoadingMessage("Decompressing mesh...");
      const bytes = await decompress(compressed);

      return {
        id: zoneId,
        name: zone.name,
        mesh: bytes,
      } as ZoneData;
    }
  );

  // Load path data (gzipped from B2 or local)
  const [pathData] = createResource(
    () => params.id,
    async (zoneIdStr) => {
      if (!zoneIdStr) return undefined;

      const zoneId = parseInt(zoneIdStr);
      const roamZone = roamZones[zoneId];
      if (!roamZone) return undefined;

      setLoadingMessage("Loading path data...");
      const url = `${PATHDATA_BASE_URL}/${roamZone.pathFile}.json.gz`;

      try {
        const compressed = await fetchProgress(url, (progress) => {
          if (progress !== undefined) {
            setLoadingMessage(`Loading path data ${(progress * 100).toFixed(0)}%`);
          }
        });
        const bytes = await decompress(compressed, "gzip");
        const text = new TextDecoder().decode(bytes);
        const data: PathData = JSON.parse(text);
        setLoadingMessage(undefined);
        return data;
      } catch (e) {
        console.log("Failed to load path data:", e);
        setLoadingMessage(undefined);
        return undefined;
      }
    }
  );


  return (
    <section class="p-8">
      <h1 class="text-2xl font-bold">Roam Data</h1>
      <LookupInput
        options={roamZones}
        nameFn={(v) => v.name}
        autofocus
        onChange={(value) => {
          navigate(`/roam/${value.data.id}`);
        }}
        initialId={params.id}
      />

      <Show when={params.id}>
        <Switch>
          <Match when={zoneMesh.loading || pathData.loading}>
            <div class="mt-4">Loading... {getLoadingMessage()}</div>
          </Match>
          <Match when={zoneMesh.error}>
            <div class="mt-4 text-red-500">
              Failed to load zone mesh: {zoneMesh.error?.toString()}
            </div>
          </Match>
          <Match when={zoneMesh()}>
            <div class="mt-4">
              <Show
                when={pathData()}
                fallback={<div class="text-yellow-500 mb-2">No path data available for this zone.</div>}
              >
                <div class="text-green-500 mb-2">
                  Loaded {Object.keys(pathData()!).length} mobs with path data.
                </div>
              </Show>
              <RoamViewer
                zoneData={zoneMesh()!}
                pathData={pathData()}
              />
            </div>
          </Match>
        </Switch>
      </Show>
    </section>
  );
}
