import CameraControls from "camera-controls";
import { IoHelpCircle } from "solid-icons/io";
import { batch, createEffect, createMemo, createSignal, mapArray, Match, on, onCleanup, onMount, Show, Switch } from "solid-js";
import { createStore, produce, SetStoreFunction } from "solid-js/store";
import * as THREE from "three";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";
import { FlyControls, MapControls } from "three/examples/jsm/Addons.js";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { addCustomCameraControls, addMapControls, adjustCameraAspect, fitCameraToContents } from "../graphics/camera";
import { setupBaseScene } from "../graphics/scene";
import { cleanupNode, parseCoordinatesToVector3, roundDecimals } from "../graphics/util";
import { EntityUpdate, EntityUpdateKind, Position, PositionUpdate, ZoneEntityUpdates } from "../parse_packets";
import { ByZone } from "../types";
import { binarySearchLower } from "../util";
import AreaMenu, { Area, deriveAreaYs as deriveAreaYRange, Point } from "./area_menu";
import LookupInput from "./lookup_input";
import RangeInput from "./range_input";
import Table from "./table";
import { ColorKind, colorMesh, createZoneMesh, getHitData, getMapId, markLineCollisions, prepareMeshData, RayHit } from "../graphics/ximesh";
import { ZoneInfoBox, TargetInfo } from "./zone_info_box";

// @ts-ignore
import Stats from "three/addons/libs/stats.module.js";

// Add the extension functions
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

interface ZoneDataProps {
  zoneData: ByZone<ZoneData>;
  showZoneTools?: boolean;
  entityUpdates?: ZoneEntityUpdates;
  clientUpdates?: PositionUpdate[];
}

export interface ZoneData {
  id: number;
  name: string;
  mesh: ArrayBuffer;
}

export interface EntitySettings {
  hidden?: boolean;
  color?: number;
}

export interface EntitiesSettings {
  [entityKey: string]: EntitySettings;
}

export interface EntitiesMeshes {
  [entityKey: string]: THREE.InstancedMesh;
}

interface EntityRow {
  id: string;
  index: string;
  entityKey: string;
  name: string;
  updateCount: number;
}

interface NormalizedEntityUpdates {
  entityRows: EntityRow[];
  maxUpdatesKey: string;
  firstTime: number;
  lastTime: number;
}

export default function ZoneModel(props: ZoneDataProps) {
  const [getShowHelp, setShowHelp] = createSignal<boolean>(false);

  const zoneIds = Object.keys(props.zoneData);
  const startingZoneId = zoneIds[0] != "0" ? parseInt(zoneIds[0]) : (parseInt(zoneIds[1]) || 0);
  const [getSelectedZone, setSelectedZone] = createSignal<number>(startingZoneId);

  const [entitySettings, setEntitySettings] = createStore<EntitiesSettings>();

  const [getShowWidescan, setShowWidescan] = createSignal<boolean>(true);
  const [getShowRendered, setShowRendered] = createSignal<boolean>(true);

  const [getShowDiscrete, setShowDiscrete] = createSignal<boolean>(true);
  const [getDiscreteLowerTime, setDiscreteLowerTime] = createSignal<number>(0);
  const [getDiscreteUpperTime, setDiscreteUpperTime] = createSignal<number>(1);

  const summarizedEntityUpdates = createMemo(() => {
    if (!props.entityUpdates) {
      return undefined;
    }

    let result: {
      [zoneId: number]: NormalizedEntityUpdates;
    } = {};

    Object.keys(props.entityUpdates).forEach(zoneId => {
      let firstTime = Number.MAX_SAFE_INTEGER;
      let lastTime = Number.MIN_SAFE_INTEGER;

      let maxUpdatesKey;
      let maxUpdates = Number.MIN_SAFE_INTEGER;

      let rows = Object.keys(props.entityUpdates[zoneId]).map(
        entityKey => {
          const updates: EntityUpdate[] = props.entityUpdates[zoneId][entityKey];
          const updateCount = updates.length;
          if (updateCount == 0) {
            return undefined;
          }

          firstTime = Math.min(firstTime, updates[0].time);
          lastTime = Math.max(lastTime, updates[updates.length - 1].time);

          if (updates.length > maxUpdates) {
            maxUpdates = updates.length;
            if (maxUpdatesKey) {
              setEntitySettings(maxUpdatesKey, { hidden: true });
            }
            maxUpdatesKey = entityKey;
          } else {
            setEntitySettings(entityKey, { hidden: true });
          }

          let name = "";
          for (const update of updates) {
            if ("name" in update && update.name?.length > 0) {
              name = update.name;
              break;
            }
          }

          const split = entityKey.split("-");
          return {
            id: split[1],
            index: split[0],
            entityKey,
            name,
            updateCount,
          };
        },
      ).filter(x => x !== undefined);

      result[zoneId] = {
        entityRows: rows,
        firstTime,
        lastTime,
        maxUpdatesKey,
      };
    });

    return result;
  });

  const scene = createMemo(() => {
    return setupBaseScene();
  })

  const camera = createMemo(() => {
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 5000);
    camera.position.set(0, 1000, 0);
    camera.lookAt(0, 0, 0);
    return camera;
  })

  const raycaster = new THREE.Raycaster();
  raycaster.firstHitOnly = true;

  // Prepare mesh data
  const prepMeshData = createMemo(() => {
    const preparedMeshesData = {};
    for (const zoneId in props.zoneData) {
      const zoneData = props.zoneData[zoneId];
      const preparedMeshData = prepareMeshData(zoneData.mesh);

      preparedMeshesData[zoneData.id] = preparedMeshData;
    }

    return preparedMeshesData;
  }, {});

  // Create zones
  const zoneMeshes = createMemo(() => {
    const zoneMeshes: { [zoneid: number]: THREE.Mesh } = {};
    for (const zoneId in props.zoneData) {
      const zoneData = props.zoneData[zoneId];
      const prep = prepMeshData()[zoneId];
      const mesh = createZoneMesh(zoneData.id, zoneData.mesh, prep, ColorKind.None);
      mesh.visible = false;

      zoneMeshes[zoneData.id] = mesh;
      scene().add(mesh);
    }

    onCleanup(() => {
      for (const zoneId in zoneMeshes) {
        console.log("Disposing zone " + zoneId);
        const mesh = zoneMeshes[zoneId];
        scene().remove(mesh);
        cleanupNode(mesh);
      }
    });

    return zoneMeshes;
  }, {});

  // Adjust widescan updates to nearest ground point on the zone mesh in the Y-axis
  const adjustedEntityUpdates = createMemo(() => {
    const scanPoint = new THREE.Vector3();
    const rayStartPoint = new THREE.Vector3();
    const down = new THREE.Vector3(0, -1, 0);
    const rayResults: THREE.Intersection<THREE.Object3D<THREE.Object3DEventMap>>[] = [];
    let bestResult: THREE.Intersection<THREE.Object3D<THREE.Object3DEventMap>> | undefined = undefined;
    let bestDistance = Number.MAX_SAFE_INTEGER;

    // Enable multi hit for this purpose
    raycaster.firstHitOnly = false;

    const adjusted: ZoneEntityUpdates = {};
    for (const zoneId in props.entityUpdates) {
      const zoneMesh = zoneMeshes()[zoneId];
      if (!zoneMesh) {
        continue;
      }

      adjusted[zoneId] = {};

      for (const entityKey in props.entityUpdates[zoneId]) {
        const updates = props.entityUpdates[zoneId][entityKey];
        const adjustedUpdates = adjusted[zoneId][entityKey] = new Array(updates.length);
        for (let i = 0; i < updates.length; i++) {
          const update = updates[i];
          if (update.kind !== EntityUpdateKind.Widescan) {
            adjustedUpdates[i] = update;
            continue;
          }

          scanPoint.set(update.pos.x, -update.pos.y, update.pos.z);
          rayStartPoint.set(update.pos.x, -update.pos.y + 100, update.pos.z);

          raycaster.set(rayStartPoint, down);
          raycaster.intersectObject(zoneMesh, false, rayResults);

          bestResult = undefined;
          bestDistance = Number.MAX_SAFE_INTEGER;
          for (const result of rayResults) {
            const dist = result.point.distanceTo(scanPoint);
            if (!bestResult || dist < bestDistance) {
              bestResult = result;
              bestDistance = dist;
            }
          }

          if (bestResult) {
            adjustedUpdates[i] = {
              ...update,
              pos: {
                ...update.pos,
                y: -bestResult.point.y - 1,
              },
            };
          } else {
            // Did not find a new Y value for the update, so keep whatever it had originally
            adjustedUpdates[i] = update;
          }

          // Clear the result array again
          rayResults.length = 0;
        }
      }
    }

    raycaster.firstHitOnly = true;
    return adjusted;
  });

  const [getShowAnimated, setShowAnimated] = createSignal<boolean>(false);
  const [isPlaying, setIsPlaying] = createSignal<boolean>(false);
  const [isSeeking, setIsSeeking] = createSignal<boolean>(false);
  const [getPlayTime, setPlayTime] = createSignal<number>(0);
  const [getTimeScale, setTimeScale] = createSignal<number>(10);

  const getPlayTimeMax = () => {
    return (currentEntityUpdates().lastTime - currentEntityUpdates().firstTime) / 1000;
  };

  // Common entity setup
  const mobColor = new THREE.Color(0xFF0000);
  const clientColor = new THREE.Color(0x0000FF);
  const npcColor = new THREE.Color(0x00FF00);
  const widescanColor = new THREE.Color(0xE000DC);
  const geo = new THREE.CapsuleGeometry();

  // Setup animations for entities
  const mixers = createMemo(() => {
    if (!getShowAnimated()) {
      return [];
    }

    const zoneId = getSelectedZone();
    let parsedUpdates = summarizedEntityUpdates();
    if (!parsedUpdates[zoneId]) {
      return [];
    }

    let mixers: THREE.AnimationMixer[] = [];

    const startTime = parsedUpdates[zoneId].firstTime;
    const endTime = parsedUpdates[zoneId].lastTime;
    const length = endTime - startTime;

    for (const entityKey in props.entityUpdates[zoneId]) {
      if (entitySettings[entityKey].hidden) {
        continue;
      }

      const updates = props.entityUpdates[zoneId][entityKey];

      // Count how long the arrays needs to be.
      let count = 0;
      let prevPosUpdate: PositionUpdate | undefined = undefined;
      for (const update of updates) {
        if (update.kind == EntityUpdateKind.Position) {
          if (!prevPosUpdate) {
            // No previous position, so add a hidden frame just before this one.
            count++;
          }
          prevPosUpdate = update;
          count++;
        } else if (prevPosUpdate && (update.kind == EntityUpdateKind.OutOfRange || update.kind == EntityUpdateKind.Despawn)) {
          // Out of range
          prevPosUpdate = undefined;
          count++;
        }
      }

      if (count == 0) {
        continue;
      }
      if (prevPosUpdate) {
        count++; // Last hiding frame
      }

      const times = new Float32Array(count);
      const opacity = new Float32Array(count);
      const positions = new Float32Array(count * 3);
      const scale = new Float32Array(count * 3);

      let i = 0;
      const addFrame = (pos: Position, time: number, show: boolean = true) => {
        times[i] = (time - startTime) / 1000;
        const showNum = show ? 1 : 0;
        opacity[i] = showNum;
        scale.set([showNum, showNum, showNum], i * 3);
        positions.set([pos.x, -pos.y, pos.z], i * 3);
        i++;
      };

      prevPosUpdate = undefined;
      for (const update of updates) {
        if (update.kind == EntityUpdateKind.Position) {
          if (!prevPosUpdate) {
            // No previous position, so add a hidden frame just before this one.
            addFrame(update.pos, update.time - 1000, false);
          }
          // Add current position frame
          addFrame(update.pos, update.time, true);
          prevPosUpdate = update;
        } else if (prevPosUpdate && (update.kind == EntityUpdateKind.OutOfRange || update.kind == EntityUpdateKind.Despawn)) {
          addFrame(prevPosUpdate.pos, prevPosUpdate.time + 1000, false);
          prevPosUpdate = undefined;
        }
      }

      // Add final hide frame
      if (prevPosUpdate) {
        addFrame(prevPosUpdate.pos, prevPosUpdate.time + 1000, false);
      }

      const positionKF = new THREE.VectorKeyframeTrack(".position", times, positions);
      const scaleKF = new THREE.VectorKeyframeTrack(".scale", times, scale);
      const opacityKF = new THREE.NumberKeyframeTrack(".material.opacity", times, opacity);
      const clip = new THREE.AnimationClip(entityKey, length / 1000, [positionKF, scaleKF, opacityKF]);

      const mat = new THREE.MeshToonMaterial({
        color: mobColor,
        opacity: 1,
        transparent: true,
      });
      const mesh = new THREE.Mesh(geo, mat);
      scene().add(mesh);

      const mixer = new THREE.AnimationMixer(mesh);
      mixer.timeScale = 1;
      mixers.push(mixer);

      const clipAction = mixer.clipAction(clip);
      clipAction.play();
      mixer.update(0);
    }

    // Client mesh
    if (props.clientUpdates) {
      const updates = props.clientUpdates;

      // Count how long the arrays needs to be.
      let startIdx = binarySearchLower(updates, startTime, x => x.time);
      let endIdx = binarySearchLower(updates, endTime + 1, x => x.time);

      const count = endIdx - startIdx;

      const times = new Float32Array(count);
      const positions = new Float32Array(count * 3);

      for (let i = startIdx, j = 0; i < endIdx; i++, j++) {
        times[j] = (updates[i].time - startTime) / 1000;
        const pos = updates[i].pos;
        positions.set([pos.x, -pos.y, pos.z], j * 3);
      }

      const positionKF = new THREE.VectorKeyframeTrack(".position", times, positions);
      const clip = new THREE.AnimationClip("client", length / 1000, [positionKF]);

      const mat = new THREE.MeshToonMaterial({
        color: clientColor,
      });
      const mesh = new THREE.Mesh(geo, mat);
      scene().add(mesh);

      const mixer = new THREE.AnimationMixer(mesh);
      mixer.timeScale = 1;
      mixers.push(mixer);

      const clipAction = mixer.clipAction(clip);
      clipAction.play();
      mixer.update(0);
    }

    onCleanup(() => {
      for (const mixer of mixers) {
        const mesh = mixer.getRoot() as THREE.Mesh;
        cleanupNode(mesh);
        scene().remove(mesh);
      }
    });
    return mixers;
  });

  // Setup meshes for entities
  const mat = new THREE.MeshToonMaterial();
  const discreteEntityMeshes = createMemo(() => {
    let discreteEntityMeshes: ByZone<{ [entityKey: string]: THREE.InstancedMesh; }> = {};

    for (const zoneId in adjustedEntityUpdates()) {
      const entities = (discreteEntityMeshes[zoneId] = discreteEntityMeshes[zoneId] || {});

      for (const entityKey in adjustedEntityUpdates()[zoneId]) {
        const updates = adjustedEntityUpdates()[zoneId][entityKey];
        const mesh = new THREE.InstancedMesh(geo, mat, updates.length);

        scene().add(mesh);
        entities[entityKey] = mesh;
      }
    }

    onCleanup(() => {
      for (const zoneId in discreteEntityMeshes) {
        for (const entityKey in discreteEntityMeshes[zoneId]) {
          const mesh = discreteEntityMeshes[zoneId][entityKey];
          scene().remove(mesh);
          cleanupNode(mesh);
        }
      }
    });

    return discreteEntityMeshes;
  });

  // Show entities at different points in time
  createEffect(() => {
    if (!props.entityUpdates || !getShowDiscrete()) {
      return;
    }

    const zoneId = getSelectedZone();
    const meshes = discreteEntityMeshes()[zoneId];
    let obj = new THREE.Object3D();
    const hideWidescan = !getShowWidescan();
    const hideRendered = !getShowRendered();
    for (const entityKey in adjustedEntityUpdates()[zoneId]) {
      if (entitySettings[entityKey]?.hidden) {
        continue;
      }

      const mesh = meshes[entityKey];
      const updates = adjustedEntityUpdates()[zoneId][entityKey];

      // Skip until first visible update
      let idx = binarySearchLower(updates, getDiscreteLowerTime(), x => x.time);

      let showCount = 0;
      // Add until last visible update
      while (idx < updates.length && updates[idx].time <= getDiscreteUpperTime()) {
        const update = updates[idx];
        if (update.kind !== EntityUpdateKind.Position && update.kind !== EntityUpdateKind.Widescan) {
          // Only add positional updates
          idx++;
          continue;
        }

        if (hideWidescan && update.kind == EntityUpdateKind.Widescan) {
          // Widescan is hidden
          idx++;
          continue;
        }

        if (hideRendered && update.kind == EntityUpdateKind.Position) {
          // Entity updates is hidden
          idx++;
          continue;
        }

        obj.position.set(update.pos.x, update.pos.y * -1, update.pos.z);
        obj.updateMatrix();
        mesh.setMatrixAt(showCount, obj.matrix);
        if (update.kind == EntityUpdateKind.Position) {
          mesh.setColorAt(showCount, mobColor);
        } else {
          mesh.setColorAt(showCount, widescanColor);
        }
        idx++;
        showCount++;
      }
      mesh.count = showCount;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) {
        mesh.instanceColor.needsUpdate = true;
      }
    }
  });

  // Show/hide zone meshes and associated entities
  createEffect(() => {
    const parsedUpdates = summarizedEntityUpdates();
    for (const zoneId in zoneMeshes()) {
      const zoneIsVisible = parseInt(zoneId) == getSelectedZone();
      zoneMeshes()[zoneId].visible = zoneIsVisible;
      if (!props.entityUpdates) {
        continue;
      }

      // Show/hide entities from other zones
      for (const entityKey in props.entityUpdates[zoneId]) {
        setEntitySettings(entityKey, { hidden: !zoneIsVisible || (entityKey != parsedUpdates[zoneId].maxUpdatesKey) });
      }
      // if (zoneIsVisible) {
      //   fitCameraToContents(camera, fn => {
      //     Object.keys(currentZoneEntities[zoneId]).forEach(entityKey => fn(currentZoneEntities[zoneId][entityKey]));
      //   });
      // }
    }
  });

  // Show/hide discrete entity meshes
  createEffect(() => {
    for (const entityKey in entitySettings) {
      const entityId = parseInt(entityKey.split("-")[1]);
      const zoneId = (entityId >> 12) & 0x01ff;
      discreteEntityMeshes()[zoneId][entityKey].visible = getShowDiscrete() && !entitySettings[entityKey].hidden;
    }
  });

  let controls: CameraControls | FlyControls | MapControls;
  let canvasElement: HTMLCanvasElement;
  let labelRendererElement: HTMLDivElement;
  let coordLabelRef: HTMLDivElement;

  let hasMouseMovedSinceLast = false;

  const [getNeedsResize, setNeedsResize] = createSignal<boolean>(true);
  function resizeCanvas() {
    const parentRect = canvasElement.parentElement!.getBoundingClientRect();
    canvasElement.width = parentRect.width;
    canvasElement.height = parentRect.height;
    setNeedsResize(true);
  }

  onMount(() => {
    window.addEventListener("resize", resizeCanvas);

    canvasElement.addEventListener("mousemove", event => {
      const canvas = canvasElement;
      cameraMouse.x = (2 * event.offsetX) / canvas.offsetWidth - 1;
      cameraMouse.y = (-2 * event.offsetY) / canvas.offsetHeight + 1;
      screenMouse.x = event.offsetX;
      screenMouse.y = event.offsetY;
      hasMouseMovedSinceLast = true;
    });

    canvasElement.addEventListener("mouseout", event => {
      coordLabelRef.style.display = "none";
    });

    // Area details clicking
    canvasElement.addEventListener("click", event => {
      if (!getShowAreaDetails() || !event.ctrlKey) {
        return;
      }

      const hits = castRayOntoMesh();
      if (!hits) {
        return;
      }
      const hit = hits[0];

      setShowAreaDetails(true);

      // Add a new polygon if none is selected
      if (getSelectedAreaIdx() == undefined) {
        setAreas(areas.length, { polygon: [] });
        setSelectedAreaIdx(areas.length - 1);
      }

      const area = areas[getSelectedAreaIdx()];
      const polygon = area.polygon;

      const newVertex = { x: Math.round(hit.x), z: Math.round(-hit.z) };

      let setPoints: SetStoreFunction<Point[]>;
      let points: Point[];
      if (getSelectedSubPolygonIdx() !== undefined) {
        setPoints = setAreas.bind(null, getSelectedAreaIdx(), "holes", getSelectedSubPolygonIdx());
        points = area.holes?.[getSelectedSubPolygonIdx()];
      } else {
        setPoints = setAreas.bind(null, getSelectedAreaIdx(), "polygon");
        points = polygon;
      }

      if (getSelectedVertexIdx() !== undefined) {
        // If there's a selected vertex, add the new vertex right after it
        setPoints(produce<Point[]>(vertices => {
          vertices.splice(getSelectedVertexIdx() + 1, 0, newVertex);
          return vertices;
        }));
        setSelectedVertexIdx(getSelectedVertexIdx() + 1);
      } else {
        // Else just add the new vertex at the end
        setPoints(points.length, newVertex);
        setSelectedVertexIdx(points.length - 1);
      }
    });

    // Ray clicking
    canvasElement.addEventListener("click", event => {
      if (getShowAreaDetails() || !event.ctrlKey && !event.shiftKey) {
        return;
      }

      raycaster.firstHitOnly = false;
      const hits = castRayOntoMesh();
      raycaster.firstHitOnly = true;

      if (!hits || hits.length == 0) {
        return;
      }

      const hitsData = getHitData(zoneMeshes()[getSelectedZone()], props.zoneData[getSelectedZone()].mesh, prepMeshData()[getSelectedZone()], hits);

      for (let i = 0; i < hitsData.length; i++) {
        const hitData = hitsData[i];
        console.log(`======================= Hit ${i} =======================`)
        console.log("Hit", hitData.hit);
        console.log("Block", hitData.block);
        console.log("Placement", hitData.placement);
        console.log("Material", hitData.material);
      }

      const firstHit = hits[0];
      const markerPos = new THREE.Vector3(roundDecimals(firstHit.x, 3), roundDecimals(-firstHit.y - 2.25, 3), roundDecimals(-firstHit.z, 3));

      if (event.ctrlKey) {
        setStartPos(markerPos);
      } else if (event.shiftKey) {
        setEndPos(markerPos);
      }
    });

    controls = addMapControls(camera(), canvasElement);

    const renderer = new THREE.WebGLRenderer({ canvas: canvasElement, antialias: true, alpha: true });
    const labelRenderer = new CSS2DRenderer({ element: labelRendererElement });

    renderer.setAnimationLoop(() => animate(renderer, labelRenderer));
  });

  onCleanup(() => {
    window.removeEventListener("resize", resizeCanvas);
    cleanupNode(scene());
    if (controls) {
      controls.dispose();
    }
    scene().clear();
    camera().clear();
  });

  const clock = new THREE.Clock();
  const stats = new Stats();
  stats.dom.style.position = "absolute";

  const cameraMouse = new THREE.Vector2(1, 1);
  const screenMouse = new THREE.Vector2(1, 1);

  function updatePosLabel() {
    const hits = castRayOntoMesh();
    if (hits) {
      const hitsData = getHitData(zoneMeshes()[getSelectedZone()], props.zoneData[getSelectedZone()].mesh, prepMeshData()[getSelectedZone()], hits);
      const hitData = hitsData[0];
      setTargetInfo({
        x: hitData.hit.x,
        y: hitData.hit.y * -1,
        z: hitData.hit.z * -1,
        mapId: getMapId(hitData.placement),
        material: hitData.material,
        cellIdx: hitData.cellIdx,
        cellEntryIdx: hitData.entryIdx,
        block: hitData.block,
        placement: hitData.placement,
      });

      coordLabelRef.textContent = `${hitData.hit.x.toFixed(1)}, ${(hitData.hit.y * -1).toFixed(1)}, ${(hitData.hit.z * -1).toFixed(1)}`;
      coordLabelRef.style.left = `${screenMouse.x + 20}px`;
      coordLabelRef.style.top = `${screenMouse.y - 20}px`;
      coordLabelRef.style.display = "block";
    } else {
      coordLabelRef.style.display = "none";
      setTargetInfo(undefined);
    }
  }

  function castRayOntoMesh(): RayHit[] | undefined {
    raycaster.setFromCamera(cameraMouse, camera());
    const intersections = raycaster.intersectObjects([zoneMeshes()[getSelectedZone()]], false);
    if (intersections.length == 0) {
      return;
    }

    let result = [];
    for (const int of intersections) {
      const p = int.point;
      const face = int.face ? { a: int.face.a, b: int.face.b, c: int.face.c } : undefined;
      result.push({
        x: p.x,
        y: p.y,
        z: p.z,
        object: int.object,
        index: int.index!,
        faceIndex: int.faceIndex!,
        face,
      });
    }
    return result;
  }

  function getFirstYForPoint(
    point: Point,
    zoneMesh: THREE.Mesh,
    origin: THREE.Vector3,
    direction: THREE.Vector3,
  ): number | undefined {
    origin.x = point.x;
    origin.z = -point.z;
    raycaster.set(origin, direction)
    const intersections = raycaster.intersectObject(zoneMesh, false);
    if (intersections.length == 0) {
      return undefined;
    }
    return intersections[0].point.y;
  }

  function updateYRangeForPoint(
    range: { yMin: number, yMax: number },
    point: Point,
    zoneMesh: THREE.Mesh,
    origin: THREE.Vector3,
    direction: THREE.Vector3,
  ) {
    origin.x = point.x;
    origin.z = -point.z;
    raycaster.set(origin, direction)
    const intersections = raycaster.intersectObject(zoneMesh, false);
    for (const intersection of intersections) {
      const y = intersection.point.y;
      if (y < range.yMin) {
        range.yMin = y;
      }
      if (y > range.yMax) {
        range.yMax = y;
      }
    }
  }

  function animate(renderer: THREE.WebGLRenderer, labelRenderer: CSS2DRenderer) {
    stats.update();

    const delta = clock.getDelta();
    controls?.update(delta);

    if (getNeedsResize()) {
      const canvas = canvasElement;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      renderer.setSize(width, height, false);
      labelRenderer.setSize(width, height);
      adjustCameraAspect(camera(), canvasElement);
      setNeedsResize(false);
    }

    if (hasMouseMovedSinceLast) {
      hasMouseMovedSinceLast = false;
      updatePosLabel();
    }

    if (isPlaying()) {
      if (!isSeeking()) {
        const playTime = getPlayTime();
        setPlayTime((playTime + delta * getTimeScale()) % getPlayTimeMax());
      }
    }

    renderer.render(scene(), camera());
    labelRenderer.render(scene(), camera());
  }

  createEffect(() => {
    for (const mixer of mixers()) {
      mixer.setTime(getPlayTime());
    }
  });

  const currentEntityUpdates = createMemo(() => {
    const key = getSelectedZone();
    if (key !== undefined && summarizedEntityUpdates()) {
      const updates = summarizedEntityUpdates()[key];
      if (updates) {
        setDiscreteLowerTime(updates.firstTime);
        setDiscreteUpperTime(updates.lastTime);
        setPlayTime(0);
        return updates;
      }
    }
  });

  const [areas, setAreas] = createStore<Area[]>([]);
  const [getSelectedAreaIdx, setSelectedAreaIdx] = createSignal<number | undefined>();
  const [getSelectedSubPolygonIdx, setSelectedSubPolygonIdx] = createSignal<number | undefined>();
  const [getSelectedVertexIdx, setSelectedVertexIdx] = createSignal<number | undefined>();
  const [getShowAreaDetails, setShowAreaDetails] = createSignal<boolean>(false);

  const areaMat = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0.5,
    color: 0xFCAA58,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const selectedAreaMat = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0.6,
    color: 0xFCF63C,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  // Draw areas
  createEffect(() => {
    const zoneMesh = zoneMeshes()[getSelectedZone()];
    if (!zoneMesh) {
      return;
    }

    let meshes: THREE.Mesh[] = [];
    let elements: Element[] = [];
    let labels: CSS2DObject[] = [];

    let origin = new THREE.Vector3();
    const direction = new THREE.Vector3(0, -1, 0);

    for (let i = 0; i < areas.length; i++) {
      const area = areas[i];
      if (area.hidden || area.polygon.length < 3) {
        continue;
      }

      // Create the polygon shape
      const shape = new THREE.Shape(area.polygon.map(p => new THREE.Vector2(p.x, p.z)));
      if (area.holes?.length > 0) {
        for (const hole of area.holes) {
          if (hole.length < 3) {
            continue;
          }
          shape.holes.push(new THREE.Shape(hole.map(p => new THREE.Vector2(p.x, p.z))));
        }
      }


      // Determine where the area should be displayed on the Y-axis
      const areaYRange = deriveAreaYRange(area);

      let visualYRange = { yMax: -areaYRange.yMin, yMin: -areaYRange.yMax };
      if (areaYRange.unlimited) {
        visualYRange.yMin = 1000;
        visualYRange.yMax = -1000;
        origin.y = -areaYRange.yMin;

        for (const p of area.polygon) {
          updateYRangeForPoint(visualYRange, p, zoneMesh, origin, direction);
        }
        if (area.holes) {
          for (const hole of area.holes) {
            for (const p of hole) {
              updateYRangeForPoint(visualYRange, p, zoneMesh, origin, direction);
            }
          }
        }

        if (visualYRange.yMin == 1000) {
          // No intersections, so lower it to some default min max
          visualYRange.yMin = -100;
          visualYRange.yMax = 100;
        } else {
          visualYRange.yMin -= 10;
          visualYRange.yMax += 10;
        }
      }

      const geo = new THREE.ExtrudeGeometry(shape, { depth: Math.abs(visualYRange.yMax - visualYRange.yMin), bevelEnabled: false });
      geo.rotateX(Math.PI / 2);
      geo.translate(0, -visualYRange.yMin, 0);
      geo.computeBoundingBox();

      const mat = getSelectedAreaIdx() == i ? selectedAreaMat : areaMat;
      const areaMesh = new THREE.Mesh(geo, mat);

      areaMesh.layers.enableAll();

      if (getSelectedAreaIdx() !== i) {
        // Add area labels for non-selected areas
        const div = document.createElement("div");
        div.textContent = `Area ${i + 1}`;
        div.className = "vertex-label noselect pointer-events-auto cursor-pointer text-sm font-mono";
        div.onclick = () => {
          setSelectedAreaIdx(i);
        };
        elements.push(div);

        const label = new CSS2DObject(div);
        const box = geo.boundingBox;

        label.position.set(
          box.min.x + (box.max.x - box.min.x) / 2,
          box.min.y + (box.max.y - box.min.y) / 2 - 10,
          box.min.z + (box.max.z - box.min.z) / 2,
        );

        // If possible, place the area label according to the y position of the underlying mesh
        origin.y = -areaYRange.yMin;
        const y = getFirstYForPoint({ x: label.position.x, z: label.position.z }, zoneMesh, origin, direction);
        if (y !== undefined) {
          label.position.y = -y - 10;
        }

        areaMesh.add(label);
        label.layers.set(0);
        labels.push(label);
      }

      meshes.push(areaMesh);
      scene().add(areaMesh);
    }

    onCleanup(() => {
      for (const label of labels) {
        cleanupNode(label);
      }
      for (const el of elements) {
        el.remove();
      }
      for (const mesh of meshes) {
        cleanupNode(mesh);
        scene().remove(mesh);
      }
    });
  });

  // Draw current area handles
  createEffect(() => {
    if (getSelectedAreaIdx() === undefined) {
      return;
    }

    let meshes: THREE.Mesh[] = [];
    let elements: Element[] = [];
    let labels: CSS2DObject[] = [];

    const area = areas[getSelectedAreaIdx()];
    if (area.hidden) {
      return;
    }

    const zoneMesh = zoneMeshes()[getSelectedZone()];
    if (!zoneMesh) {
      return;
    }

    const areaYRange = deriveAreaYRange(area);
    let origin = new THREE.Vector3();
    const direction = new THREE.Vector3(0, -1, 0);
    origin.y = -areaYRange.yMin;

    // Default Y to place the handles at, if they do not intersect the zone mesh
    let defaultY = 0;
    if (!areaYRange.unlimited) {
      if (areaYRange.yMax > 1000) {
        defaultY = areaYRange.yMin;
      } else if (areaYRange.yMin < -1000) {
        defaultY = areaYRange.yMax;
      } else {
        defaultY = (areaYRange.yMax - areaYRange.yMin) / 2 + areaYRange.yMin;
      }
    }

    const points = getSelectedSubPolygonIdx() !== undefined ? area.holes[getSelectedSubPolygonIdx()] : area.polygon;

    // Handles
    for (let i = 0; i < points.length; i++) {
      const pos = points[i];
      const geo = new THREE.SphereGeometry(1);
      const mat = new THREE.MeshBasicMaterial({ color: 0xFF7F00 });
      const mesh = new THREE.Mesh(geo, mat);

      const y = getFirstYForPoint({ x: pos.x, z: pos.z }, zoneMesh, origin, direction) ?? -defaultY;
      mesh.position.set(pos.x, -y, pos.z);

      mesh.layers.enableAll();

      const div = document.createElement("div");
      div.textContent = String.fromCharCode("A".charCodeAt(0) + i);
      div.className = "vertex-label noselect pointer-events-auto cursor-pointer text-sm font-mono";
      if (getSelectedVertexIdx() == i) {
        div.className += " font-bold bg-blue-800 underline";
      } else {
        div.onclick = () => {
          setSelectedVertexIdx(i);
        };
      }
      elements.push(div);

      const label = new CSS2DObject(div);
      label.position.set(0, -5, 0);
      mesh.add(label);
      label.layers.set(0);
      labels.push(label);

      meshes.push(mesh);
      scene().add(mesh);
    }

    onCleanup(() => {
      for (const label of labels) {
        cleanupNode(label);
      }
      for (const el of elements) {
        el.remove();
      }
      for (const mesh of meshes) {
        cleanupNode(mesh);
        scene().remove(mesh);
      }
    });
  });

  const zoneSelector = (
    <Show when={Object.keys(props.zoneData).length > 1}>
      <div class="flex-grow m-1">
        <LookupInput
          options={props.zoneData}
          nameFn={v => v.name}
          onChange={v => setSelectedZone(parseInt(v.id) || undefined)}
          placeholder="Select zone"
          initialId={getSelectedZone() + ""}
        >
        </LookupInput>
      </div>
    </Show>
  );

  const [getColorKind, setColorKind] = createSignal<ColorKind>(ColorKind.Materials);
  const [getStartPos, setStartPos] = createSignal<THREE.Vector3 | undefined>();
  const [getEndPos, setEndPos] = createSignal<THREE.Vector3 | undefined>();

  const [getTargetInfo, setTargetInfo] = createSignal<TargetInfo | undefined>();


  // Start marker mesh
  createEffect(on(getStartPos, (pos?: THREE.Vector3, _prevPos?: THREE.Vector3, prevMesh?: THREE.Mesh) => {
    if (!pos) {
      if (prevMesh) {
        onCleanup(() => {
          scene().remove(prevMesh);
          cleanupNode(prevMesh);
        });
      }
      return;
    }

    let mesh = prevMesh;
    if (!mesh) {
      const geo = new THREE.SphereGeometry(0.5);
      const mat = new THREE.MeshPhongMaterial({
        color: new THREE.Color(0, 1, 0),
      });
      mesh = new THREE.Mesh(geo, mat);
      mesh.visible = true;
      scene().add(mesh);
    }

    mesh.position.copy(pos);

    return mesh;
  }));

  // End marker mesh
  createEffect(on(getEndPos, (pos?: THREE.Vector3, _prevPos?: THREE.Vector3, prevMesh?: THREE.Mesh) => {
    if (!pos) {
      if (prevMesh) {
        onCleanup(() => {
          scene().remove(prevMesh);
          cleanupNode(prevMesh);
        });
      }
      return;
    }

    let mesh = prevMesh;
    if (!mesh) {
      const geo = new THREE.SphereGeometry(0.5);
      const mat = new THREE.MeshPhongMaterial({
        color: new THREE.Color(0, 0, 1),
      });
      mesh = new THREE.Mesh(geo, mat);
      scene().add(mesh);
    }

    mesh.position.copy(pos);

    return mesh;
  }));

  // Line between markers
  createEffect(on([getStartPos, getEndPos], (
    value: [THREE.Vector3 | undefined, THREE.Vector3 | undefined],
    _prevValue?: [THREE.Vector3 | undefined, THREE.Vector3 | undefined],
    prevLine?: THREE.Line) => {
    if (!value[0] || !value[1]) {
      if (prevLine) {
        onCleanup(() => {
          scene().remove(prevLine);
          cleanupNode(prevLine);
        });
      }
      return;
    }

    const mesh = zoneMeshes()[getSelectedZone()];
    if (!mesh) {
      return;
    }

    let line = prevLine;
    if (!line) {
      const geo = new THREE.BufferGeometry();
      const positions = new Float32Array(2 * 3);
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

      const mat = new THREE.LineBasicMaterial({
        color: new THREE.Color(1, 0, 0),
        linewidth: 1,
        depthTest: true,
      });
      line = new THREE.Line(geo, mat);
      scene().add(line);
    }

    const positions = line.geometry.attributes.position;
    positions.array.set(value[0].toArray(), 0);
    positions.array.set(value[1].toArray(), 3);
    positions.needsUpdate = true;

    // Recompute box and sphere to ensure the new position doesn't get culled from the camera
    line.geometry.computeBoundingBox();
    line.geometry.computeBoundingSphere();

    markLineCollisions(mesh, props.zoneData[getSelectedZone()].mesh, prepMeshData()![getSelectedZone()], value[0], value[1]);

    return line;
  }));

  createEffect(on(getColorKind, (colorKind) => {
    const meshes = zoneMeshes();
    const prep = prepMeshData();
    for (const zoneId of Object.keys(meshes)) {
      const mesh = meshes[zoneId];
      colorMesh(mesh, prep[zoneId]!, colorKind);
    }
  }));

  const colorKindButton = (colorKind: ColorKind, name: string) => (
    <button
      classList={{ "active": getColorKind() == colorKind }}
      onClick={() => {
        setColorKind(colorKind);
      }}>
      {name}
    </button>
  );

  const positionField = (getter: () => THREE.Vector3 | undefined, setter: (val: THREE.Vector3) => THREE.Vector3) => {
    let copyTimer: number | undefined;

    return <>
      <input class="w-24 text-center hide-spin-buttons" type="number" lang="en-US"
        value={getter()?.x}
        placeholder="x"
        onInput={(e) => {
          let pos = getter()?.clone() ?? new THREE.Vector3();
          pos.x = parseFloat(e.target.value);
          setter(pos);
        }}></input>

      <input class="w-24 text-center hide-spin-buttons" type="number" lang="en-US"
        value={getter()?.y}
        placeholder="y"
        onInput={(e) => {
          let pos = getter()?.clone() ?? new THREE.Vector3();
          pos.y = parseFloat(e.target.value);
          setter(pos);
        }}></input>

      <input class="w-24 text-center hide-spin-buttons" type="number" lang="en-US"
        value={getter()?.z}
        placeholder="z"
        onInput={(e) => {
          let pos = getter()?.clone() ?? new THREE.Vector3();
          pos.z = parseFloat(e.target.value);
          setter(pos);
        }}></input>

      <button class="w-20" onClick={(e) => {
        const pos = getter();
        if (!pos) {
          return;
        }
        let value;
        if (e.shiftKey) {
          value = `${pos.x} ${pos.y} ${pos.z}`;
        } else {
          value = `${pos.x},${pos.y},${pos.z}`;
        }
        navigator.clipboard.writeText(value);

        e.target.textContent = "Copied"
        if (copyTimer) {
          clearTimeout(copyTimer);
        }
        copyTimer = setTimeout(() => {
          e.target.textContent = "Copy"
          copyTimer = undefined;
        }, 2000);
      }}>
        Copy
      </button>


      <button class="w-20" onClick={async () => {
        let coords = parseCoordinatesToVector3(await navigator.clipboard.readText());
        if (coords) {
          setter(coords);
        }
      }}>
        Paste
      </button>
    </>
  };

  return (
    <div class="w-full h-full">
      <div class="m-auto relative" style={{ height: "60vh" }}>
        <canvas class="block w-full h-full" ref={canvasElement}>
        </canvas>
        <AreaMenu
          showDetails={getShowAreaDetails()}
          setShowDetails={setShowAreaDetails}
          areas={areas}
          setAreas={setAreas}
          selectedAreaIdx={getSelectedAreaIdx()}
          setSelectedAreaIdx={setSelectedAreaIdx}
          selectedSubPolygonIdx={getSelectedSubPolygonIdx()}
          setSelectedSubPolygonIdx={setSelectedSubPolygonIdx}
          selectedVertexIdx={getSelectedVertexIdx()}
          setSelectedVertexIdx={setSelectedVertexIdx}
        >
        </AreaMenu>
        <ZoneInfoBox targetInfo={getTargetInfo()}></ZoneInfoBox>
        <div
          class="absolute hidden p-1 text-white bg-black pointer-events-none rounded font-mono opacity-70 text-sm noselect"
          ref={coordLabelRef}
        >
        </div>
        <div
          class="absolute top-0 pointer-events-none"
          ref={labelRendererElement}
        >
        </div>

        {/* Helper menu */}
        <div class="absolute top-0 left-0 pointer-events-none h-full flex flex-col-reverse" style={{ width: "40%" }}>
          <Show
            when={getShowHelp()}
            fallback={
              <div class="pointer-events-auto cursor-pointer p-1" onClick={() => setShowHelp(true)}>
                <IoHelpCircle size={20} title="Mouse and keyboard help"></IoHelpCircle>
              </div>
            }
          >
            {import.meta.env.DEV ? stats.dom : undefined}
            <div class="pointer-events-auto cursor-pointer bg-black bg-opacity-80 p-2 rounded-tr text-sm" onClick={() => setShowHelp(false)}>
              Click this to hide it again.
              <ul class="list-disc list-inside">
                <li>
                  <b>Move/rotate camera:</b> Left/right-click and drag
                </li>
                <li>
                  <b>Area editing:</b> Most of the contents of the Area Manager can be clicked/edited.
                </li>
                <li>
                  <b>Add a new area node:</b>{" "}
                  With the Area Manager expanded: CTRL + left-click. If an existing node is selected, the new one will be inserted after it. While having a node selected, you can also press
                  SHIFT + N to create a copy.
                </li>
                <li>
                  <b>Select a node:</b> Select a node by either clicking it in the world, or on it in the Area Manager.
                </li>
                <li>
                  <b>Move a node:</b>{" "}
                  Select the node, then hold SHIFT + arrow keys to move it along the X- and/or Z-axis. Hold CTRL to move it faster. The coordinates can also be
                  edited directly in the Area Manager.
                </li>
                <li>
                  <b>Area to Lua:</b> Click the copy button next to an area in the Area Manager to get Lua code defining it into your clipboard.
                </li>
                <li>
                  <b>Lua to areas:</b> Paste text containing Lua code that defines the areas (i.e. a zone Setup.lua file)
                </li>
              </ul>
            </div>
          </Show>
        </div>
      </div>

      <Show when={props.showZoneTools}>
        <div class="flex items-start justify-around pt-3 flex-wrap">
          <div class="flex flex-col items-center pb-5">
            <span class="font-semibold">Colors</span>
            <div class="flex items-center justify-center gap-2 flex-wrap">
              {colorKindButton(ColorKind.None, "Clear")}
              {colorKindButton(ColorKind.Barriers, "Barriers")}
              {colorKindButton(ColorKind.Materials, "Materials")}
              {colorKindButton(ColorKind.Maps, "Map")}
              {colorKindButton(ColorKind.IsRoofed, "Roofed")}
            </div>
          </div>

          <div class="flex flex-col items-center">
            <span class="font-semibold">Ray testing</span>
            <div class="text-sm">CTRL- and SHIFT-clicking works with Area Manager minimized</div>
            <div class="flex items-center gap-1 flex-wrap">
              <span class="w-32">Start (CTRL+click):</span>
              {positionField(getStartPos, setStartPos)}
            </div>

            <div class="flex items-center gap-1 flex-wrap">
              <span class="w-32">End (SHIFT+click):</span>
              {positionField(getEndPos, setEndPos)}
            </div>
          </div>
        </div>
      </Show>

      <Show when={props.entityUpdates}>
        <Show
          fallback={zoneSelector}
          when={getSelectedZone() in summarizedEntityUpdates()}
        >
          <div class="flex flex-row my-2">
            <div class="m-auto h-full px-1 font-bold" style={{ "min-width": "6rem" }}>
              Discrete:
            </div>
            <div class="px-1 m-auto h-full">
              <button style={{ "min-width": "5rem" }} onClick={() => setShowDiscrete(!getShowDiscrete())}>
                {getShowDiscrete() ? "Hide" : "Show"}
              </button>
            </div>
            <div class="flex-grow">
              <RangeInput
                min={currentEntityUpdates().firstTime}
                max={currentEntityUpdates().lastTime}
                lower={getDiscreteLowerTime()}
                upper={getDiscreteUpperTime()}
                inputKind="timestamp"
                onChangeLower={setDiscreteLowerTime}
                onChangeUpper={setDiscreteUpperTime}
                disabled={!getShowDiscrete()}
              >
              </RangeInput>
            </div>
          </div>

          <div class="flex flex-row my-2">
            <div class="m-auto h-full px-1 font-bold" style={{ "min-width": "6rem" }}>
              Animated:
            </div>
            <div class="m-auto h-full px-1">
              <button style={{ "min-width": "5rem" }} onClick={() => setShowAnimated(!getShowAnimated())}>
                {getShowAnimated() ? "Hide" : "Show"}
              </button>
            </div>
            <div class="m-auto h-full px-1">
              <button style={{ "min-width": "5rem" }} onClick={() => setIsPlaying(!isPlaying())}>
                {isPlaying() ? "Pause" : "Play"}
              </button>
            </div>
            <div class="m-auto relative">
              <input
                type="number"
                class="text-right pr-3"
                min={1}
                max={1000}
                style={{ width: "4.5rem" }}
                value={getTimeScale()}
                onInput={e => setTimeScale(parseInt(e.target.value) || 1)}
              >
              </input>
              <span style={{ position: "absolute", right: "0.8rem", top: "0.5rem", margin: "auto" }}>
                ×
              </span>
            </div>
            <div class="m-auto flex-grow">
              <input
                type="range"
                class="w-full"
                min={currentEntityUpdates().firstTime}
                max={currentEntityUpdates().lastTime}
                value={getPlayTime() * 1000 + currentEntityUpdates().firstTime}
                onMouseDown={() => setIsSeeking(true)}
                onMouseUp={() => setIsSeeking(false)}
                onInput={e => setPlayTime((parseInt(e.target.value) - currentEntityUpdates().firstTime) / 1000)}
              >
              </input>
            </div>
          </div>

          <Table
            inputRows={currentEntityUpdates().entityRows}
            columns={[
              { name: "Name", key: "name" },
              { name: "ID", key: "id" },
              { name: "Index", key: "index" },
              { name: "Count", key: "updateCount" },
            ]}
            defaultSortColumn="index"
            defaultSortAsc={true}
            additionalColumns={[
              {
                name: "Visible",
                content: v => (
                  <input
                    type="checkbox"
                    checked={!entitySettings[v.entityKey]?.hidden}
                  />
                ),
              },
            ]}
            onRowClick={v => {
              setEntitySettings(v.entityKey, {
                hidden: !entitySettings[v.entityKey]?.hidden,
              });
            }}
            headerElements={[
              rows => (
                <button
                  onClick={() => batch(() => rows.forEach(v => setEntitySettings(v.entityKey, { hidden: false })))}
                >
                  Show filtered
                </button>
              ),
              rows => (
                <button
                  onClick={() => batch(() => rows.forEach(v => setEntitySettings(v.entityKey, { hidden: true })))}
                >
                  Hide filtered
                </button>
              ),
              _rows => (
                <button
                  onClick={() => setShowWidescan(!getShowWidescan())}
                >
                  {getShowWidescan() ? "Hide widescan" : "Show widescan"}
                </button>
              ),
              _rows => (
                <button
                  onClick={() => setShowRendered(!getShowRendered())}
                >
                  {getShowRendered() ? "Hide rendered" : "Show rendered"}
                </button>
              ),
              zoneSelector,
            ]}
          >
          </Table>
        </Show>
      </Show>
    </div>
  );
}
