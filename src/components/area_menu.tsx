import { IoCheckmarkDoneSharp, IoChevronDown, IoChevronUp, IoCopy, IoExitOutline, IoEye, IoEyeOff, IoLocate, IoTrash } from "solid-icons/io";
import { batch, createEffect, createSignal, For, Match, on, onCleanup, onMount, Show, Switch } from "solid-js";
import { createStore, produce, SetStoreFunction } from "solid-js/store";

export interface AreaMenuProps {
  showDetails: boolean;
  setShowDetails: (show: boolean) => any;
  areas: Area[];
  setAreas: SetStoreFunction<Area[]>;
  selectedAreaIdx: number | undefined;
  setSelectedAreaIdx: (newIdx: number | undefined) => any;
  selectedSubPolygonIdx: number | undefined;
  setSelectedSubPolygonIdx: (newIdx: number | undefined) => any;
  selectedVertexIdx: number | undefined;
  setSelectedVertexIdx: (newIdx: number | undefined) => any;
  /** While on, left-dragging the map pulls out a rectangle instead of moving the camera. */
  rectMode: boolean;
  setRectMode: (on: boolean) => any;
}

export interface Point {
  x: number;
  z: number;
}

export interface Area {
  yMin?: number;
  yMax?: number;

  yMid?: number;
  yExtent?: number;

  polygon: Point[];
  holes?: Point[][];
  hidden?: boolean;
  description?: string;
  /** The id an imported registerCuboidTriggerArea call used, so exporting it again keeps it. */
  triggerId?: number;
  /** Which call this area writes out as. Cuboid when unset. */
  triggerShape?: "cuboid" | "cylinder";
  /** Radians the box is turned about its own centre in the xz plane. Absent or 0 is axis aligned. */
  triggerRotation?: number;
}

/** Radians need more than the three decimals coordinates get: -2.3562 has to survive a round trip. */
export function tidyAngle(n: number): number {
  return Number(n.toFixed(5));
}

export function rotateAbout(p: Point, cx: number, cz: number, angle: number): Point {
  const dx = p.x - cx, dz = p.z - cz;
  const sin = Math.sin(angle), cos = Math.cos(angle);
  return { x: cx + dx * cos - dz * sin, z: cz + dx * sin + dz * cos };
}

/** Centre of a box, which for four corners is their average whether or not it is turned. */
export function centreOf(polygon: Point[]): { cx: number; cz: number; } {
  const cx = polygon.reduce((sum, p) => sum + p.x, 0) / polygon.length;
  const cz = polygon.reduce((sum, p) => sum + p.z, 0) / polygon.length;
  return { cx, cz };
}

/**
 * The corners in the box's own frame, which is what the call's min/max pair describes. The server
 * turns the point by -rotation before comparing, so the drawn shape is the box turned by +rotation
 * and undoing that is how the numbers to write out are recovered.
 */
export function boxFrame(polygon: Point[], rotation: number): Point[] {
  if (!rotation) {
    return polygon;
  }
  const { cx, cz } = centreOf(polygon);
  return polygon.map(p => rotateAbout(p, cx, cz, -rotation));
}

/** Trim float noise without flattening a real decimal: -487.3 survives, 15.000000002 does not. */
export function tidy(n: number): number {
  return Number(n.toFixed(3));
}

/**
 * A circle as a polygon, which is all the renderer and the vertex editor understand. 32 is
 * divisible by 4, so there are vertices exactly on both axes and the bounding box is exactly the
 * diameter: that is what lets the centre and radius be read back off the points without drift.
 */
export function circlePoints(cx: number, cz: number, radius: number, segments = 32): Point[] {
  const points: Point[] = [];
  for (let i = 0; i < segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    points.push({ x: tidy(cx + Math.cos(angle) * radius), z: tidy(cz + Math.sin(angle) * radius) });
  }
  return points;
}

/** Centre and radius of an area drawn as a circle, read back off its bounding box. */
export function circleOf(polygon: Point[]): { cx: number; cz: number; radius: number; } {
  const xs = polygon.map(p => p.x), zs = polygon.map(p => p.z);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const zMin = Math.min(...zs), zMax = Math.max(...zs);
  return {
    cx: tidy((xMin + xMax) / 2),
    cz: tidy((zMin + zMax) / 2),
    radius: tidy(((xMax - xMin) + (zMax - zMin)) / 4),
  };
}

export default function AreaMenu(ps: AreaMenuProps) {
  const selectedArea = () => ps.selectedAreaIdx !== undefined ? ps.areas[ps.selectedAreaIdx] : undefined;

  const setYValue = (element: HTMLInputElement, key: "yMid" | "yMax" | "yMin" | "yExtent") => {
    const newNum = parseInt(element.value);
    if (isNaN(newNum)) {
      element.textContent = ps.areas[ps.selectedAreaIdx][key] + "";
      return;
    }
    ps.setAreas(ps.selectedAreaIdx, key, newNum);
    element.textContent = ps.areas[ps.selectedAreaIdx][key] + "";
  };

  const setActivePoints = (...args: any[]) => {
    const setPoints = ps.selectedSubPolygonIdx === undefined
      ? ps.setAreas.bind(null, ps.selectedAreaIdx, "polygon")
      : ps.setAreas.bind(null, ps.selectedAreaIdx, "holes", ps.selectedSubPolygonIdx);

    return setPoints(...args);
  };

  const setCoordName = (coordName: keyof Point, index: number, element: Element) => {
    const newNum = parseInt(element.textContent);
    if (isNaN(newNum)) {
      element.textContent = ps.areas[ps.selectedAreaIdx].polygon[index][coordName] + "";
      return;
    }
    setActivePoints(index, coordName, newNum);
    element.textContent = ps.areas[ps.selectedAreaIdx].polygon[index][coordName] + "";
  };

  const setCoordX = (index: number, element: Element) => {
    setCoordName("x", index, element);
  };
  const setCoordZ = (index: number, element: Element) => {
    setCoordName("z", index, element);
  };

  const addNewArea = () => {
    ps.setAreas(ps.areas.length, { polygon: [] });
    ps.setSelectedAreaIdx(ps.areas.length - 1);
  };

  const addNewHole = () => {
    if (ps.selectedVertexIdx !== undefined) {
      ps.setSelectedVertexIdx(undefined);
    }

    if (ps.areas[ps.selectedAreaIdx].holes == undefined) {
      // First hole
      ps.setAreas(
        ps.selectedAreaIdx,
        "holes",
        [[]],
      );
      ps.setSelectedSubPolygonIdx(0);
    } else {
      // Additional hole
      ps.setAreas(
        ps.selectedAreaIdx,
        "holes",
        ps.areas[ps.selectedAreaIdx].holes.length,
        [],
      );
      ps.setSelectedSubPolygonIdx(ps.areas[ps.selectedAreaIdx].holes.length - 1);
    }
  };

  const addNewVertex = () => {
    const isSubPolygon = ps.selectedSubPolygonIdx !== undefined;
    const points = isSubPolygon ? ps.areas[ps.selectedAreaIdx].holes[ps.selectedSubPolygonIdx] : ps.areas[ps.selectedAreaIdx].polygon;

    const vertexToCopy = ps.selectedVertexIdx !== undefined ? points[ps.selectedVertexIdx] : points[points.length - 1];
    const newVertex = { x: vertexToCopy?.x || 0, z: vertexToCopy?.z || 0 };

    if (ps.selectedVertexIdx !== undefined) {
      // Insert after selected
      setActivePoints(produce<Point[]>(vertices => {
        vertices.splice(ps.selectedVertexIdx + 1, 0, newVertex);
        return vertices;
      }));
      ps.setSelectedVertexIdx(ps.selectedVertexIdx + 1);
    } else {
      // Insert at the end
      setActivePoints(points.length, newVertex);
      ps.setSelectedVertexIdx(points.length - 1);
    }
  };

  const moveVertex = (index: number, moveDown: boolean) => {
    const isSubPolygon = ps.selectedSubPolygonIdx !== undefined;
    const vertexCount = isSubPolygon ? ps.areas[ps.selectedAreaIdx].holes[ps.selectedSubPolygonIdx].length : ps.areas[ps.selectedAreaIdx].polygon.length;

    const swapIdx = moveDown ? index + 1 : index - 1;
    if (swapIdx < 0 || swapIdx >= vertexCount) {
      return;
    }

    if (ps.selectedVertexIdx == index) {
      ps.setSelectedVertexIdx(swapIdx);
    }

    setActivePoints(produce(vertices => {
      if (!vertices[swapIdx]) {
        return vertices;
      }
      [vertices[index], vertices[swapIdx]] = [vertices[swapIdx], vertices[index]];
      return vertices;
    }));
  };

  const deleteVertex = (index: number) => {
    const isSubPolygon = ps.selectedSubPolygonIdx !== undefined;
    const currentPointCount = isSubPolygon
      ? ps.areas[ps.selectedAreaIdx].holes[ps.selectedSubPolygonIdx].length
      : ps.areas[ps.selectedAreaIdx].polygon.length;

    if (ps.selectedVertexIdx == index && index == currentPointCount - 1) {
      ps.setSelectedVertexIdx(undefined);
    }

    setActivePoints(vertices => vertices.filter((_, idx) => idx !== index));
  };

  // Clear selected vertex and hole on area change
  createEffect(on(() => ps.selectedAreaIdx, () => {
    ps.setSelectedVertexIdx(undefined);
    ps.setSelectedSubPolygonIdx(undefined);
  }));

  // Clear selected vertex on sub polygon change
  createEffect(on(() => ps.selectedSubPolygonIdx, () => {
    ps.setSelectedVertexIdx(undefined);
  }));

  const deleteArea = (index: number) => {
    if (ps.selectedAreaIdx == index) {
      ps.setSelectedAreaIdx(undefined);
    } else if (ps.selectedAreaIdx > index) {
      ps.setSelectedAreaIdx(ps.selectedAreaIdx - 1);
    }
    ps.setAreas(areas => areas.filter((_, idx) => idx !== index));
  };

  const deleteHole = (index: number) => {
    if (ps.selectedSubPolygonIdx == index) {
      ps.setSelectedSubPolygonIdx(undefined);
    } else if (ps.selectedSubPolygonIdx > index) {
      ps.setSelectedSubPolygonIdx(ps.selectedSubPolygonIdx - 1);
    }
    ps.setAreas(ps.selectedAreaIdx, "holes", holes => holes.filter((_, idx) => idx !== index));
  };

  const [copyTimers, setCopyTimers] = createStore<{ [idx: number]: ReturnType<typeof setTimeout>; }>({});
  const areaToClipboard = (index?: number) => {
    const idxToUse = index ?? ps.selectedAreaIdx;
    const area = ps.areas[idxToUse];

    let lines = [];

    if (area.description) {
      lines.push(`-- ${area.description.trim()}`);
    }

    // Add y-value lines, prioritizing yMin and yMax if they are present.
    if (area.yMin !== undefined || area.yMax !== undefined) {
      if (area.yMin !== undefined) {
        lines.push(`yMin = ${area.yMin},`);
      }
      if (area.yMax !== undefined) {
        lines.push(`yMax = ${area.yMax},`);
      }
    } else {
      if (area.yMid !== undefined) {
        lines.push(`y = ${area.yMid},`);
        if (area.yExtent !== undefined) {
          lines.push(`yExtent = ${area.yExtent},`);
        }
      }
    }

    lines.push(`polygon = {`);
    for (const point of area.polygon) {
      lines.push(`    { x = ${point.x}, z = ${point.z} },`);
    }
    lines.push(`},`);
    if (area.holes?.length > 0) {
      lines.push(`holes = {`);
      for (const hole of area.holes) {
        lines.push(`    {`);
        for (const point of hole) {
          lines.push(`        { x = ${point.x}, z = ${point.z} },`);
        }
        lines.push(`    },`);
      }
      lines.push(`},`);
    }

    navigator.clipboard.writeText(lines.join("\n"));

    if (copyTimers[idxToUse] !== undefined) {
      clearTimeout(copyTimers[idxToUse]);
    }
    setCopyTimers(
      idxToUse,
      setTimeout(() => {
        setCopyTimers(idxToUse, undefined);
      }, 1000),
    );
  };

  const [triggerTimers, setTriggerTimers] = createStore<{ [idx: number]: ReturnType<typeof setTimeout>; }>({});

  /**
   * The same area written the way a zone script takes it:
   * zone:registerCuboidTriggerArea(id, xMin, yMin, zMin, xMax, yMax, zMax).
   *
   * A cuboid is the bounding box either way, so this works on any area, not only the rectangles
   * the drag tool makes. The id is the area number, which is a guess: trigger area ids are
   * per-zone and the script may already use some.
   */
  const triggerAreaToClipboard = (index?: number) => {
    const idxToUse = index ?? ps.selectedAreaIdx;
    const area = ps.areas[idxToUse];
    if (!area?.polygon?.length) {
      return;
    }

    const id = area.triggerId ?? idxToUse + 1;
    let line: string;

    if (area.triggerShape === "cylinder") {
      // A cylinder is unbounded vertically, so the call takes no y at all and this area's y
      // inputs, if it has any, are not written out.
      const c = circleOf(area.polygon);
      line = `zone:registerCylindricalTriggerArea(${id}, ${c.cx}, ${c.cz}, ${c.radius})`;
    } else {
      const rotation = area.triggerRotation ?? 0;
      const frame = boxFrame(area.polygon, rotation);
      const xs = frame.map(p => p.x);
      const zs = frame.map(p => p.z);
      const ys = deriveAreaYs(area);

      line = `zone:registerCuboidTriggerArea(${id}, ${tidy(Math.min(...xs))}, ${ys.yMin}, ${tidy(Math.min(...zs))}, `
        + `${tidy(Math.max(...xs))}, ${ys.yMax}, ${tidy(Math.max(...zs))}`
        // The argument is optional and defaults to 0, so an unturned box does not carry it.
        + `${rotation ? `, ${tidyAngle(rotation)}` : ""})`;
      // Without y bounds the derived range is the +/-1000 placeholder, which would look deliberate
      // once pasted.
      if (ys.unlimited) {
        line += " -- y bounds not set, these are placeholders";
      }
    }

    navigator.clipboard.writeText(line);

    if (triggerTimers[idxToUse] !== undefined) {
      clearTimeout(triggerTimers[idxToUse]);
    }
    setTriggerTimers(
      idxToUse,
      setTimeout(() => {
        setTriggerTimers(idxToUse, undefined);
      }, 1000),
    );
  };

  /**
   * Swap an area between the two call shapes, rewriting its points to match: a box becomes the
   * circle that fits inside it, a circle becomes the box that fits around it. Going box, circle,
   * box returns the box you started with, since both use the same bounding box.
   */
  const toggleShape = () => {
    const idx = ps.selectedAreaIdx;
    const area = ps.areas[idx];
    if (!area?.polygon?.length) {
      return;
    }

    if (area.triggerShape === "cylinder") {
      const c = circleOf(area.polygon);
      batch(() => {
        ps.setAreas(idx, "triggerShape", "cuboid");
        ps.setAreas(idx, "polygon", [
          { x: tidy(c.cx - c.radius), z: tidy(c.cz - c.radius) },
          { x: tidy(c.cx + c.radius), z: tidy(c.cz - c.radius) },
          { x: tidy(c.cx + c.radius), z: tidy(c.cz + c.radius) },
          { x: tidy(c.cx - c.radius), z: tidy(c.cz + c.radius) },
        ]);
        ps.setSelectedVertexIdx(undefined);
      });
      return;
    }

    const c = circleOf(area.polygon);
    batch(() => {
      ps.setAreas(idx, "triggerShape", "cylinder");
      ps.setAreas(idx, "polygon", circlePoints(c.cx, c.cz, c.radius));
      ps.setSelectedVertexIdx(undefined);
    });
  };

  /**
   * Turn the box about its own centre. The corners are moved by the difference rather than
   * rebuilt, so an edited box keeps whatever size it was dragged to.
   */
  const setRotation = (radians: number) => {
    const idx = ps.selectedAreaIdx;
    const area = ps.areas[idx];
    if (!area?.polygon?.length) {
      return;
    }
    const next = Number.isFinite(radians) ? tidyAngle(radians) : 0;
    const delta = next - (area.triggerRotation ?? 0);
    if (delta === 0) {
      return;
    }
    const { cx, cz } = centreOf(area.polygon);
    batch(() => {
      ps.setAreas(idx, "triggerRotation", next || undefined);
      ps.setAreas(idx, "polygon", area.polygon.map(p => rotateAbout(p, cx, cz, delta)));
    });
  };

  const importAreas = (str: string) => {
    const newAreas = parseTriggerAreas(str) ?? parseAreasDef(str);
    if (newAreas) {
      ps.setAreas(newAreas);
      ps.setSelectedAreaIdx(undefined);
      ps.setSelectedSubPolygonIdx(undefined);
      ps.setSelectedVertexIdx(undefined);
    }
  };

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key == "Escape") {
      if (ps.selectedVertexIdx !== undefined) {
        ps.setSelectedVertexIdx(undefined);
      } else if (ps.selectedAreaIdx !== undefined) {
        ps.setSelectedAreaIdx(undefined);
      }
      return;
    }

    // Remaining actions require Shift to be held and a selected vertex
    if (!e.shiftKey || ps.selectedVertexIdx === undefined) {
      return;
    }

    const el = e.target as any;
    if (el.contentEditable == "true" || el.tagName == "input") {
      return;
    }

    function changeCoord(coordName: keyof Point, valueChangeFn: (c: number) => number) {
      setActivePoints(ps.selectedVertexIdx, coordName, valueChangeFn);
    }

    const diff = e.ctrlKey ? 5 : 1;
    switch (e.key) {
      case "ArrowLeft":
        changeCoord("x", x => x - diff);
        break;
      case "ArrowRight":
        changeCoord("x", x => x + diff);
        break;
      case "ArrowUp":
        changeCoord("z", z => z + diff);
        break;
      case "ArrowDown":
        changeCoord("z", z => z - diff);
        break;
      case "N":
        addNewVertex();
        break;
      default:
        return;
    }

    e.preventDefault();
  }

  const toggleAllAreasHidden = () => {
    const newHidden = ps.areas.some(area => !area.hidden);
    ps.setAreas({ from: 0, to: ps.areas.length - 1 }, "hidden", newHidden);
  };

  onMount(() => {
    document.addEventListener("keydown", handleKeyDown);
  });

  onCleanup(() => {
    document.removeEventListener("keydown", handleKeyDown);
  });

  return (
    <div class="h-full absolute left-0 top-0 overflow-y-auto m-0 p-0 pointer-events-none noselect z-50" style={{ "width": "20%", "min-width": "12rem" }}>
      <div class="w-full bg-black bg-opacity-90 m-0 rounded-sm  pointer-events-auto">
        {/* Details expand */}
        <div onClick={() => ps.setShowDetails(!ps.showDetails)} class="cursor-pointer px-2 py-1 font-bold">
          <span class="font-mono">{ps.showDetails ? "—" : "▼"}</span> Area Manager
        </div>

        <Show when={ps.showDetails}>
          {/* Current area editing */}
          <Show when={ps.selectedAreaIdx != undefined}>
            <div style={{ height: "50%" }} class="border-t border-t-white p-2">
              <div class="flex flex-row font-semibold">
                <span class="flex-grow text-lg">
                  Editing: <span class="text-yellow-300">Area {ps.selectedAreaIdx + 1}</span>
                  <Show
                    when={copyTimers[ps.selectedAreaIdx] === undefined}
                    fallback={<IoCheckmarkDoneSharp size={18} class="font-bold inline-block ml-2 text-green-300"></IoCheckmarkDoneSharp>}
                  >
                    <IoCopy
                      class="inline-block ml-2 text-blue-300 cursor-pointer"
                      onClick={() => areaToClipboard()}
                      title="Copy area to clipboard"
                    >
                    </IoCopy>
                  </Show>
                  <Show
                    when={triggerTimers[ps.selectedAreaIdx] === undefined}
                    fallback={<IoCheckmarkDoneSharp size={18} class="font-bold inline-block ml-2 text-green-300"></IoCheckmarkDoneSharp>}
                  >
                    <span
                      class="inline-block ml-2 text-xs align-middle text-blue-300 cursor-pointer border px-1 rounded-sm"
                      onClick={() => triggerAreaToClipboard()}
                      title={`Copy as zone:register${selectedArea()?.triggerShape === "cylinder" ? "Cylindrical" : "Cuboid"}TriggerArea(...)`}
                    >
                      {selectedArea()?.triggerShape === "cylinder" ? "cylinder" : "cuboid"}
                    </span>
                  </Show>
                  <Show when={selectedArea()}>
                    <span
                      class="inline-block ml-1 text-xs align-middle text-slate-300 cursor-pointer border px-1 rounded-sm"
                      onClick={() => toggleShape()}
                      title="Switch between a box and a circle"
                    >
                      {selectedArea()?.triggerShape === "cylinder" ? "→ box" : "→ circle"}
                    </span>
                  </Show>
                  <Show when={ps.selectedSubPolygonIdx !== undefined}>
                    <span class="ml-1">Hole {ps.selectedSubPolygonIdx + 1}</span>
                  </Show>
                </span>
                <span class="cursor-pointer" onClick={() => ps.setSelectedAreaIdx(undefined)}>
                  <IoExitOutline class="inline-block" title="Deselect current area"></IoExitOutline>
                </span>
              </div>

              <Show when={ps.areas[ps.selectedAreaIdx].holes?.length > 0}>
                <div>
                  <ul>
                    <li class="flex flex-row">
                      <span
                        class="text-blue-300 cursor-pointer hover:underline font-mono flex-grow"
                        onClick={() => ps.setSelectedSubPolygonIdx(undefined)}
                      >
                        Outline
                        <Show when={ps.selectedSubPolygonIdx === undefined}>
                          <span class="ml-1">
                            <IoLocate class="inline-block">
                            </IoLocate>
                          </span>
                        </Show>
                      </span>
                    </li>
                    <For each={ps.areas[ps.selectedAreaIdx].holes}>
                      {(item, index) => (
                        <li class="flex flex-row">
                          <span
                            class="text-blue-300 cursor-pointer hover:underline font-mono flex-grow"
                            onClick={() => ps.setSelectedSubPolygonIdx(index())}
                          >
                            Hole {index() + 1}
                            <Show when={ps.selectedSubPolygonIdx == index()}>
                              <span class="ml-1">
                                <IoLocate class="inline-block">
                                </IoLocate>
                              </span>
                            </Show>
                          </span>
                          <span class="cursor-pointer px-1 align-bottom text-red-300 font-mono" onClick={() => deleteHole(index())}>
                            <IoTrash class="inline-block"></IoTrash>
                          </span>
                        </li>
                      )}
                    </For>
                  </ul>
                </div>
              </Show>
              <div
                class="cursor-pointer hover:underline font-bold border rounded-sm px-2 my-1 text-blue-300"
                onClick={() => addNewHole()}
              >
                Add hole
              </div>

              <input
                class="m-0 mt-2 p-0 px-2 font-mono text-lime-300 bg-transparent rounded-sm w-full"
                placeholder="Area description"
                onInput={e => {
                  ps.setAreas(ps.selectedAreaIdx, "description", e.target.value);
                }}
                onFocusOut={e => {
                  ps.setAreas(ps.selectedAreaIdx, "description", e.target.value?.trim());
                }}
                value={selectedArea()?.description ?? ""}
              >
              </input>

              <div>
                Y range:
                <select
                  class="font-mono inline-block"
                  value={(() => {
                    if (selectedArea()?.yMin !== undefined || selectedArea()?.yMax !== undefined) {
                      return "1";
                    }
                    if (selectedArea()?.yMid !== undefined) {
                      return "2";
                    }
                    return "0";
                  })()}
                  onChange={(e) => {
                    switch (e.currentTarget.value) {
                      default:
                      case "0":
                        ps.setAreas(ps.selectedAreaIdx, produce((area) => {
                          area.yMin = undefined;
                          area.yMax = undefined;
                          area.yMid = undefined;
                          area.yExtent = undefined;
                        }));
                        break;
                      case "1":
                        ps.setAreas(ps.selectedAreaIdx, produce((area) => {
                          area.yMin = area.yMin ?? -10;
                          area.yMax = area.yMax ?? area.yMin + 20;
                          area.yMid = undefined;
                          area.yExtent = undefined;
                        }));
                        break;
                      case "2":
                        ps.setAreas(ps.selectedAreaIdx, produce((area) => {
                          area.yMin = undefined;
                          area.yMax = undefined;
                          area.yMid = area.yMid ?? 0;
                          area.yExtent = area.yExtent ?? undefined;
                        }));
                        break;
                    }
                  }}>
                  <option value="0">Unlimited</option>
                  <option value="1">Min Max</option>
                  <option value="2">Extent</option>
                </select>
              </div>
              <Switch>
                <Match when={selectedArea()?.yMin !== undefined || selectedArea()?.yMax !== undefined}>
                  <div class="pt-2">
                    <span class="font-semibold">Min Y:</span>{" "}
                    <input
                      type="number"
                      class="p-1 font-mono text-lime-300 w-16 inline-block"
                      value={selectedArea()?.yMin}
                      onChange={e => setYValue(e.currentTarget, "yMin")}
                    ></input>
                  </div>
                  <div class="pt-2">
                    <span class="font-semibold">Max Y:</span>{" "}
                    <input
                      type="number"
                      class="p-1 font-mono text-lime-300 w-16 inline-block"
                      value={selectedArea()?.yMax}
                      onChange={e => setYValue(e.currentTarget, "yMax")}
                    ></input>
                  </div>
                </Match>

                <Match when={selectedArea()?.yMid !== undefined}>
                  <div class="pt-2">
                    <span class="font-semibold">Y:</span>{" "}
                    <input
                      type="number"
                      class="p-1 font-mono text-lime-300 w-16 inline-block"
                      value={selectedArea()?.yMid}
                      onChange={e => setYValue(e.currentTarget, "yMid")}
                    ></input>
                  </div>

                  <div class="pb-2">
                    <span class="font-semibold">Extent:</span>{" "}
                    <input
                      type="number"
                      class="p-1 font-mono text-lime-300 w-16 inline-block"
                      value={selectedArea()?.yExtent}
                      onChange={e => setYValue(e.currentTarget, "yExtent")}
                    ></input>
                  </div>

                </Match>
              </Switch>

              {/* Cylinders are round, so turning one is a no-op and the field would only mislead. */}
              <Show when={selectedArea()?.triggerShape !== "cylinder"}>
                <div class="pt-2">
                  <span class="font-semibold">Rotation:</span>{" "}
                  <input
                    type="number"
                    step="0.0001"
                    class="p-1 font-mono text-lime-300 w-24 inline-block"
                    value={selectedArea()?.triggerRotation ?? 0}
                    onChange={e => setRotation(parseFloat(e.currentTarget.value))}
                  ></input>{" "}
                  <span class="text-xs text-slate-400">rad</span>
                </div>
              </Show>

              <div>
                <div class="flex flex-row">
                  <span class="font-semibold flex-grow">Vertices (x, z)</span>
                  <Show when={ps.selectedVertexIdx !== undefined}>
                    <span class="font-mono">
                      <span class="cursor-pointer mr-1 text-red-300" onClick={() => deleteVertex(ps.selectedVertexIdx)}>
                        <IoTrash class="inline-block" title="Delete selected vertex"></IoTrash>
                      </span>
                      <span class="cursor-pointer text-lime-300" onClick={() => moveVertex(ps.selectedVertexIdx, false)}>
                        <IoChevronUp class="inline-block" title="Move selected vertex up"></IoChevronUp>
                      </span>
                      <span class="cursor-pointer text-lime-300" onClick={() => moveVertex(ps.selectedVertexIdx, true)}>
                        <IoChevronDown class="inline-block" title="Move selected vertex down"></IoChevronDown>
                      </span>
                      <span class="cursor-pointer ml-1" onClick={() => ps.setSelectedVertexIdx(undefined)}>
                        <IoExitOutline class="inline-block" title="Deselect current vertex"></IoExitOutline>
                      </span>
                    </span>
                  </Show>
                </div>
                <ul class="font-mono">
                  <For each={ps.selectedSubPolygonIdx !== undefined ? selectedArea()?.holes[ps.selectedSubPolygonIdx] : selectedArea()?.polygon}>
                    {(item, index) => (
                      <li
                        class="cursor-pointer"
                        classList={{ "text-yellow-300": ps.selectedVertexIdx == index() }}
                        onClick={() => ps.setSelectedVertexIdx(index())}
                      >
                        <span>
                          <span
                            classList={{ underline: ps.selectedVertexIdx == index() }}
                          >
                            {String.fromCharCode("A".charCodeAt(0) + index())}
                          </span>
                          : (<span
                            contentEditable={true}
                            class="p-1 text-lime-300 cursor-text"
                            onFocusOut={e => setCoordX(index(), e.target)}
                          >
                            {item.x.toFixed(0)}
                          </span>,
                          <span
                            contentEditable={true}
                            class="p-1 text-lime-300 cursor-text"
                            onFocusOut={e => setCoordZ(index(), e.target)}
                          >
                            {item.z.toFixed(0)}
                          </span>)
                        </span>
                        <Show when={ps.selectedVertexIdx == index()}>
                          <span class="ml-1">
                            <IoLocate
                              class="inline-block"
                              title="Hold shift and use arrow keys to move the point"
                            >
                            </IoLocate>
                          </span>
                        </Show>
                      </li>
                    )}
                  </For>
                </ul>
                <div
                  class="cursor-pointer hover:underline font-bold border rounded-sm px-2 my-1 text-blue-300"
                  onClick={() => addNewVertex()}
                >
                  Add vertex
                </div>
              </div>
            </div>
          </Show>

          {/* Area list */}
          <div class="border-t border-t-white p-1">
            <div>
              <span
                class="px-0.5 mr-1 align-bottom cursor-pointer"
                onClick={toggleAllAreasHidden}
              >
                <Show
                  when={ps.areas.some(area => !area.hidden)}
                  fallback={<IoEyeOff class="inline-block text-gray-500"></IoEyeOff>}
                >
                  <IoEye class="inline-block"></IoEye>
                </Show>
              </span>
              <span class="font-semibold">Areas</span>
            </div>
            <ul>
              <For each={ps.areas}>
                {(item, index) => (
                  <li class="flex flex-row">
                    <span
                      class="px-0.5 align-bottom cursor-pointer"
                      onClick={() => ps.setAreas(index(), "hidden", !item.hidden)}
                    >
                      <Show
                        when={!item.hidden}
                        fallback={<IoEyeOff class="inline-block text-gray-500"></IoEyeOff>}
                      >
                        <IoEye class="inline-block"></IoEye>
                      </Show>
                    </span>
                    <span class="px-1 align-bottom">
                      <Show
                        when={copyTimers[index()] === undefined}
                        fallback={<IoCheckmarkDoneSharp class="font-bold inline-block text-green-300"></IoCheckmarkDoneSharp>}
                      >
                        <IoCopy
                          class="inline-block cursor-pointer"
                          onClick={() => areaToClipboard(index())}
                          title="Copy area to clipboard"
                        >
                        </IoCopy>
                      </Show>
                    </span>
                    <span
                      class="text-blue-300 cursor-pointer hover:underline font-mono whitespace-nowrap"
                      onClick={() => ps.setSelectedAreaIdx(index())}
                    >
                      Area {index() + 1}
                    </span>
                    <Show when={item.description} fallback={<span class="flex-grow"></span>}>
                      <span
                        class="mx-3 text-gray-400 text-xs font-mono inline-block flex-grow whitespace-nowrap overflow-hidden"
                        style={{ "align-content": "center", "text-overflow": "ellipsis" }}
                        title={item.description}
                      >
                        [{item.description}]
                      </span>
                    </Show>
                    <span class="cursor-pointer px-1 align-bottom text-red-300 font-mono" onClick={() => deleteArea(index())}>
                      <IoTrash class="inline-block"></IoTrash>
                    </span>
                  </li>
                )}
              </For>
            </ul>
            <div class="flex gap-1 my-1">
              <div
                class="flex-1 text-center cursor-pointer hover:underline font-bold border px-2 rounded-sm text-blue-300"
                onClick={() => addNewArea()}
              >
                Add area
              </div>
              <div
                class="flex-1 text-center cursor-pointer hover:underline font-bold border px-2 rounded-sm"
                classList={{ "text-blue-300": !ps.rectMode, "bg-yellow-300 text-black": ps.rectMode }}
                onClick={() => ps.setRectMode(!ps.rectMode)}
                title="Drag on the map to pull out a rectangle. The camera stays put while this is on."
              >
                {ps.rectMode ? "Drawing…" : "Draw rect"}
              </div>
            </div>
            <textarea
              class="font-bold border px-2 my-1 rounded-sm w-full h-7 overflow-hidden"
              onInput={e => {
                importAreas(e.target.value);
                e.target.value = "";
              }}
              placeholder="Paste areas or registerCuboidTriggerArea lines"
            >
            </textarea>
          </div>
        </Show>
      </div>
    </div >
  );
}

const KV_NUM_PATTERN = /^([a-zA-Z]+)\s*=\s*(\-?\d+)\s*,?/;
const POLYGON_PATTERN = /^polygon\s*=\s*\{/;
const XZ_PATTERN = /^\{\s*x\s*=\s*(\-?\d+)\s*,\s*z\s*=\s*(\-?\d+),?\s*\}\s*,?/;
const HOLES_PATTERN = /^holes\s*=\s*\{/;
const START_BRACKET = /^\{/;
const END_BRACKET = /^\},?/;
const COMMENT_PATTERN = /^--([^\r\n]+)\r?\n/;

function skipWhitespaceAndComments(str: string): number {
  let idx = 0;
  while (idx < str.length) {
    switch (str[idx]) {
      case " ":
      case "\t":
      case "\n":
      case "\r":
        idx++;
        continue;
      case "-":
        // Skip comment lines
        if (str[idx + 1] == "-") {
          idx += 2;
          while (idx < str.length && str[idx] != "\n") {
            idx++;
          }
          idx++;
          continue;
        }
        break;
      default:
        break;
    }

    break;
  }
  return idx;
}


function skipWhitespace(str: string): number {
  let idx = 0;
  while (idx < str.length) {
    switch (str[idx]) {
      case " ":
      case "\t":
      case "\n":
      case "\r":
        idx++;
        continue;
      default:
        break;
    }

    break;
  }
  return idx;
}

/// Returns the number of characters to skip to proceed
function parseAreaDef(fullStr: string, startIdx: number, areas: Area[]): number {
  const str = fullStr.substring(startIdx);

  // Parse y values
  let idx = skipWhitespace(str);
  let yMin: number, yMax: number, yMid: number, yExtent: number;
  let description: string | undefined;

  const commentMatch = COMMENT_PATTERN.exec(str.substring(idx));
  if (commentMatch) {
    description = commentMatch[1].trim();
    idx += commentMatch[0].length;
    idx += skipWhitespaceAndComments(str.substring(idx));
  }

  let kvMatch = KV_NUM_PATTERN.exec(str.substring(idx));
  while (kvMatch) {
    const val = parseFloat(kvMatch[2]);
    if (isNaN(val)) {
      return 1;
    }

    switch (kvMatch[1]) {
      case "yMin":
        yMin = val;
        break;
      case "yMax":
        yMax = val;
        break;
      case "y":
        yMid = val;
        break;
      case "yExtent":
        yExtent = val;
        break;
      default:
        break;
    }

    idx += kvMatch[0].length;
    idx += skipWhitespaceAndComments(str.substring(idx));

    kvMatch = KV_NUM_PATTERN.exec(str.substring(idx));
  }

  // Find polygon key
  const polygonMatch = POLYGON_PATTERN.exec(str.substring(idx));
  if (!polygonMatch) {
    return 1;
  }
  idx += polygonMatch[0].length;
  idx += skipWhitespaceAndComments(str.substring(idx));

  let area: Area = {
    yMin,
    yMax,
    yMid,
    yExtent,
    description,
    polygon: [],
  };

  // Parse polygon points
  while (true) {
    const xzMatch = XZ_PATTERN.exec(str.substring(idx));
    if (!xzMatch) {
      break;
    }
    idx += xzMatch[0].length;
    idx += skipWhitespaceAndComments(str.substring(idx));

    const x = parseFloat(xzMatch[1]);
    if (isNaN(x)) {
      continue;
    }
    const z = parseFloat(xzMatch[2]);
    if (isNaN(z)) {
      continue;
    }

    area.polygon.push({ x, z });
  }

  // End polygon table
  const endBracketMatch = END_BRACKET.exec(str.substring(idx));
  if (!endBracketMatch) {
    return 1;
  }
  idx += endBracketMatch[0].length;
  idx += skipWhitespaceAndComments(str.substring(idx));

  // Parse holes, if any
  const holesMatch = HOLES_PATTERN.exec(str.substring(idx));
  if (holesMatch) {
    idx += holesMatch[0].length;
    idx += skipWhitespaceAndComments(str.substring(idx));

    idx += parseHoles(str.substring(idx), area);

    const endBracketMatch = END_BRACKET.exec(str.substring(idx));
    if (!endBracketMatch) {
      return 1;
    }
    idx += endBracketMatch[0].length;
    idx += skipWhitespaceAndComments(str.substring(idx));
  }

  areas.push(area);
  return idx;
}

function parseHoles(str: string, area: Area): number {
  let idx = 0;

  area.holes = [];

  while (idx < str.length) {
    const startBracketMatch = START_BRACKET.exec(str.substring(idx));
    if (!startBracketMatch) {
      break;
    }
    idx += startBracketMatch[0].length;
    idx += skipWhitespaceAndComments(str.substring(idx));

    let hole = [];
    // Parse hole points
    while (true) {
      const xzMatch = XZ_PATTERN.exec(str.substring(idx));
      if (!xzMatch) {
        break;
      }
      idx += xzMatch[0].length;
      idx += skipWhitespaceAndComments(str.substring(idx));

      const x = parseFloat(xzMatch[1]);
      if (isNaN(x)) {
        continue;
      }
      const z = parseFloat(xzMatch[2]);
      if (isNaN(z)) {
        continue;
      }

      hole.push({ x, z });
    }

    const endBracketMatch = END_BRACKET.exec(str.substring(idx));
    if (!endBracketMatch) {
      return 0;
    }
    idx += endBracketMatch[0].length;
    idx += skipWhitespaceAndComments(str.substring(idx));

    area.holes.push(hole);
  }

  return idx;
}

/**
 * Read registerCuboidTriggerArea and registerCylindricalTriggerArea calls, so an area
 * already in a zone script can be pulled back in and adjusted rather than retyped. Paste one line
 * or a whole onInitialize; anything that is not such a call is ignored.
 */
export function parseTriggerAreas(str: string): Area[] | undefined {
  const N = String.raw`\s*(-?\d+(?:\.\d+)?)\s*`;
  const call = new RegExp(String.raw`registerCuboidTriggerArea\s*\(` + [N, N, N, N, N, N, N].join(",") + String.raw`(?:,` + N + String.raw`)?\)`, "g");

  const cylinder = new RegExp(String.raw`registerCylindricalTriggerArea\s*\(` + [N, N, N, N].join(",") + String.raw`\)`, "g");

  const areas: Area[] = [];
  for (const m of str.matchAll(cylinder)) {
    const [id, cx, cz, radius] = m.slice(1).map(Number);
    areas.push({
      triggerId: id,
      triggerShape: "cylinder",
      polygon: circlePoints(cx, cz, radius),
    });
  }

  for (const m of str.matchAll(call)) {
    const [id, xMin, yMin, zMin, xMax, yMax, zMax] = m.slice(1, 8).map(Number);
    // The 8th argument is optional and defaults to 0 on the server.
    const rotation = m[8] === undefined ? 0 : Number(m[8]);

    // The call takes opposite corners in either order; the box is the same box.
    const x1 = Math.min(xMin, xMax), x2 = Math.max(xMin, xMax);
    const z1 = Math.min(zMin, zMax), z2 = Math.max(zMin, zMax);
    const corners = [{ x: x1, z: z1 }, { x: x2, z: z1 }, { x: x2, z: z2 }, { x: x1, z: z2 }];

    // min/max describe the box in its own frame, so what gets drawn is those corners turned by
    // +rotation about the centre. Left at full precision: rounding the drawn corners would drift
    // back out through the un-rotation on export.
    const cx = (x1 + x2) / 2, cz = (z1 + z2) / 2;

    areas.push({
      triggerId: id,
      yMin: Math.min(yMin, yMax),
      yMax: Math.max(yMin, yMax),
      triggerShape: "cuboid",
      triggerRotation: rotation || undefined,
      polygon: rotation ? corners.map(p => rotateAbout(p, cx, cz, rotation)) : corners,
    });
  }

  return areas.length > 0 ? areas : undefined;
}

function parseAreasDef(str: string): Area[] | undefined {
  let areas: Area[] = [];
  let i = 0;
  while (i < str.length) {
    if (str[i] == "{") {
      i++;
      i += parseAreaDef(str, i, areas);
    } else {
      i++;
    }
  }

  if (areas.length == 0) {
    return undefined;
  }

  return areas;
}

export function deriveAreaYs(area: Area): { yMin: number; yMax: number; unlimited: boolean } {
  let yMin = -1000, yMax = 1000, unlimited = true;

  if (area.yMin !== undefined || area.yMax !== undefined) {
    yMin = area.yMin ?? yMin;
    yMax = area.yMax ?? yMax;
    unlimited = false;
  } else if (area.yMid !== undefined) {
    const extent = area.yExtent ?? 10;
    yMin = area.yMid - extent;
    yMax = area.yMid + extent;
    unlimited = false;
  }

  return { yMin, yMax, unlimited };
}
