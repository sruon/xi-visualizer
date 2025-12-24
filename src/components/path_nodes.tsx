import * as THREE from "three"
import { batch, createEffect, createMemo, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import { createStore, produce } from "solid-js/store";

import { castRay, roundDecimals } from "../graphics/util";
import { InstancedMesh2 } from "@three.ez/instanced-mesh";
import { TargetedSelectionBox } from '../graphics/selection';
import { db } from '../localdb/db';
import type { SelectionBoxResult } from './selection_box';

export interface PathNodesProps {
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  canvasElement: HTMLCanvasElement,
  zoneMesh: THREE.Mesh,
  zoneId: number,
  selectionBox: SelectionBoxResult,
}

export interface PathNode {
  x: number,
  y: number,
  z: number,
  dbId: number,
}

interface Position {
  x: number,
  y: number,
  z: number,
}

interface PathNodeStore {
  collectionId?: number,
  collectionName?: string,
  nodes: { [dbId: number]: PathNode },
}

const defaultColor = new THREE.Color(0x00AA00);
const selectedColor = new THREE.Color(0x00EE00);

export default function PathNodes(ps: PathNodesProps) {

  const [nodes, setNodes] = createStore<PathNodeStore>({ nodes: {} });
  const [selectedInstanceIds, setSelectedInstanceId] = createSignal<Set<number>>(new Set());

  const toggleSelectedInstanceId = (instanceId: number) => {
    const newSet = new Set([...selectedInstanceIds()]);
    if (selectedInstanceIds().has(instanceId)) {
      newSet.delete(instanceId);
    } else {
      newSet.add(instanceId);
    }
    setSelectedInstanceId(newSet);
  };

  const addSelectedInstanceId = (instanceId: number) => {
    if (selectedInstanceIds().has(instanceId)) {
      return;
    }
    const newSet = new Set([...selectedInstanceIds()]);
    newSet.add(instanceId);
    setSelectedInstanceId(newSet);
  };

  const removeSelectedInstanceId = (instanceId: number) => {
    if (!selectedInstanceIds().has(instanceId)) {
      return;
    }
    const newSet = new Set([...selectedInstanceIds()]);
    newSet.delete(instanceId);
    setSelectedInstanceId(newSet);
  };

  const addNode = async (p: Position) => {
    if (!nodes.collectionId) {
      // Make a new collection
      const name = `Zone ${ps.zoneId} at ${new Date().toISOString()}`;
      const res = await db.pathNodeCollections.add({ name, creationTime: Date.now(), });
      await db.pathNodeByZone.add({ collectionId: res, zoneId: ps.zoneId });

      setNodes("collectionId", res);
      setNodes("collectionName", name);
    }

    // Round to one decimal precision
    p = {
      x: roundDecimals(p.x, 1),
      y: roundDecimals(p.y, 1),
      z: roundDecimals(p.z, 1),
    }

    const dbId = await db.pathNodes.add({
      collectionId: nodes.collectionId!,
      x: p.x,
      y: p.y,
      z: p.z,
    })

    const mesh = nodeMesh();
    mesh.addInstances(1, (obj, instanceId) => {
      obj.position.set(p.x, p.y - 1, p.z);
      mesh.userData[instanceId] = dbId;
      obj.color = defaultColor;
    });


    setNodes("nodes", dbId, {
      x: p.x,
      y: p.y,
      z: p.z,
      dbId,
    })

    // Need to recompute bounding sphere for raycasting to work on the mesh
    mesh.computeBoundingSphere();
  };

  const removeNodes = async (instanceIds: Set<number>) => {
    const mesh = nodeMesh();

    // Remove from database
    const dbIds = new Set<number>(instanceIds.keys().map(i => mesh.userData[i]))
    try {
      await db.pathNodes.bulkDelete(Array.from(dbIds));
    } catch (err) {
      console.error(err);
    }

    // Remove from mesh
    mesh.removeInstances(...instanceIds);

    // Remove from store
    setNodes("nodes", produce((nodes) => {
      for (const dbId of dbIds) {
        delete nodes[dbId];
      }
      return nodes;
    }));
  }

  const nodeMesh = createMemo(() => {
    const geo = new THREE.CapsuleGeometry(0.4, 2);
    const mat = new THREE.MeshBasicMaterial({ color: 0xFFFFFF });
    const mesh = new InstancedMesh2(geo, mat);
    mesh.computeBVH();

    mesh.layers.enableAll();

    mesh.userData = {};

    ps.scene.add(mesh);

    onCleanup(() => {
      ps.scene.remove(mesh);
    });

    return mesh;
  });


  const onKeyUp = (e: KeyboardEvent) => {
    switch (e.key) {
      case "Delete":
        removeNodes(selectedInstanceIds());
        setSelectedInstanceId(new Set<number>());
        break;
      case "Escape":
        setSelectedInstanceId(new Set<number>());
        break;
    }
  };

  createEffect(on(selectedInstanceIds, (newValue, prev) => {
    const mesh = nodeMesh();

    // Handle case where prev is undefined
    if (!prev) {
      for (const idx of newValue) {
        mesh.setColorAt(idx, selectedColor);
      }
      return;
    }

    // Update selected/unselected
    for (const idx of newValue.difference(prev)) {
      mesh.setColorAt(idx, selectedColor);
    }
    for (const idx of prev.difference(newValue)) {
      mesh.setColorAt(idx, defaultColor);
    }
  }, { defer: true }));

  const selectionHelper = new TargetedSelectionBox(ps.camera);
  const cameraMouse = new THREE.Vector2();

  createEffect(on(() => ps.selectionBox, () => {
    if (!ps.selectionBox) {
      return;
    }

    const mesh = nodeMesh();
    const start = ps.selectionBox.start;
    const end = ps.selectionBox.end;

    const x1 = (start.x / ps.canvasElement.offsetWidth * 2) - 1;
    const y1 = -(start.y / ps.canvasElement.offsetHeight * 2) + 1;
    const x2 = (end.x / ps.canvasElement.offsetWidth * 2) - 1;
    const y2 = -(end.y / ps.canvasElement.offsetHeight * 2) + 1;

    let indices = selectionHelper.selectInstances({ x: x1, y: y1 }, { x: x2, y: y2 }, mesh);

    if (ps.selectionBox.ctrl) {
      // Remove when CTRL is held
      batch(() => {
        indices.forEach(idx => {
          removeSelectedInstanceId(idx)
        })
      })
    } else {
      // Add when CTRL is not held
      batch(() => {
        indices.forEach(idx => {
          addSelectedInstanceId(idx)
        })
      })
    }
  }));

  const mouseClickPos = new THREE.Vector2();
  const onMouseDown = (e: MouseEvent) => {
    mouseClickPos.x = e.offsetX;
    mouseClickPos.y = e.offsetY;
  };

  const onMouseUp = async (e: MouseEvent) => {
    if (mouseClickPos.x != e.offsetX || mouseClickPos.y != e.offsetY) {
      // The mouse moved between mouse down and up, so do not treat it as a selection click.
      return;
    }

    cameraMouse.x = (2 * e.offsetX) / ps.canvasElement.offsetWidth - 1;
    cameraMouse.y = (-2 * e.offsetY) / ps.canvasElement.offsetHeight + 1;

    const mesh = nodeMesh();
    const nodeHits = castRay(cameraMouse, ps.camera, mesh);
    const nodeHit = nodeHits?.[0]

    if (e.ctrlKey) {
      // Add new node on clicked part of zone mesh
      const hits = castRay(cameraMouse, ps.camera, ps.zoneMesh);
      if (!hits) {
        return;
      }
      const hit = hits[0];

      if (nodeHit) {
        if (Math.abs(hit.x - nodeHit.x) < 2 && Math.abs(hit.z + nodeHit.z) < 2 && Math.abs(hit.y + nodeHit.y) < 5) {
          // Hit another node that's too close
          console.log("Hit another node that's too close, so a new one has not been added.");
          return;
        }
      }

      await addNode({
        x: hit.x,
        y: -hit.y,
        z: -hit.z,
      });

    } else if (nodeHit) {
      // We're in select/toggle mode.
      if (e.shiftKey || selectedInstanceIds().size == 0) {
        toggleSelectedInstanceId(nodeHit.instanceId);
      } else if (!selectedInstanceIds().has(nodeHit.instanceId)) {
        const newSet = new Set<number>();
        newSet.add(nodeHit.instanceId);
        setSelectedInstanceId(newSet);
      }
    }
  };

  onMount(async () => {
    // Attach event listeners
    ps.canvasElement.addEventListener("keyup", onKeyUp);
    ps.canvasElement.addEventListener("mousedown", onMouseDown);
    ps.canvasElement.addEventListener("mouseup", onMouseUp);

    // Load saved path nodes for the zone
    batch(async () => {
      const nodeByZone = await db.pathNodeByZone.get(ps.zoneId);
      if (nodeByZone) {
        const nodes = await db.pathNodes.where("collectionId").equals(nodeByZone.collectionId).toArray();
        setNodes("collectionId", nodeByZone.collectionId);
        const collection = await db.pathNodeCollections.get(nodeByZone.collectionId);
        setNodes("collectionName", collection.name);

        if (nodes.length > 0) {
          setNodes("nodes", nodes.map(n => ({ x: n.x, y: n.y, z: n.z, dbId: n.id })));

          const mesh = nodeMesh();
          let idx = 0;
          mesh.addInstances(nodes.length, (obj, instanceId) => {
            const node = nodes[idx++];
            mesh.userData[instanceId] = node.id;
            obj.position.set(node.x, node.y - 1, node.z);
            obj.color = defaultColor;
          });
          mesh.computeBoundingSphere();
        }
      }
    });

    onCleanup(() => {
      // Remove event listeners
      ps.canvasElement.removeEventListener("keyup", onKeyUp);
      ps.canvasElement.removeEventListener("mousedown", onMouseDown);
      ps.canvasElement.removeEventListener("mouseup", onMouseUp);
    })
  })

  const [getShowDetails, setShowDetails] = createSignal<boolean>(true);

  const selectedDistance = createMemo(() => {
    if (selectedInstanceIds().size != 2) {
      return undefined;
    }

    const mesh = nodeMesh();
    const ns = selectedInstanceIds().keys().map(id => nodes.nodes[mesh.userData[id]]).toArray();
    return roundDecimals(Math.sqrt(Math.pow(ns[0].x - ns[1].x, 2) + Math.pow(ns[0].y - ns[1].y, 2) + Math.pow(ns[0].z - ns[1].z, 2)), 1)
  })

  return (
    <div class="h-full absolute left-0 top-0 overflow-y-auto m-0 p-0 pointer-events-none noselect z-50" style={{ "width": "20%", "min-width": "40ch" }}>
      <div class="w-full bg-black bg-opacity-90 m-0 rounded-sm  pointer-events-auto">
        {/* Details expand */}
        <div onClick={() => setShowDetails(!getShowDetails())} class="cursor-pointer px-2 py-1 font-bold">
          <span class="font-mono">{getShowDetails() ? "—" : "▼"}</span> Node Manager
        </div>

        {/* Box content */}
        <Show when={getShowDetails()}>
          <div class="px-2">
            <div>Current collection:</div>
            <div class="italic">{nodes.collectionName}</div>

            <div>Node count: <span class="font-bold">{Object.keys(nodes.nodes).length}</span></div>

            <Show when={selectedDistance()}>
              <div>Distance: <span class="font-bold">{selectedDistance()}</span></div>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  );
}
