import { createSignal, Show, type Accessor, type Setter } from "solid-js";
import { parseCoordinatesToVector3 } from "../graphics/util";
import * as THREE from "three";


export interface ZoneRayTestingBoxProps {
    getStartPos: Accessor<THREE.Vector3>,
    setStartPos: Setter<THREE.Vector3>,
    getEndPos: Accessor<THREE.Vector3>,
    setEndPos: Setter<THREE.Vector3>,
}

export function ZoneRayTestingBox(props: ZoneRayTestingBoxProps) {
    const [getShowDetails, setShowDetails] = createSignal<boolean>(false);

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
                let value: string;
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
        <div class="absolute right-0 bottom-0 overflow-y-auto m-0 p-0 pointer-events-none noselect z-50" style={{ "width": "20%", "min-width": "40rem" }}>
            <div class="w-full bg-black bg-opacity-90 m-0 rounded-sm pointer-events-auto font-mono text-xs">
                <div onClick={() => setShowDetails(!getShowDetails())} class="cursor-pointer px-2 py-1 font-bold">
                    <span class="font-mono">{getShowDetails() ? "—" : "▲"}</span> Ray Testing
                </div>
                <hr></hr>

                <Show when={getShowDetails()}>
                    <div class="flex flex-col items-center">
                        <div class="text-sm">CTRL- and SHIFT-clicking works with Area Manager minimized</div>
                        <div class="flex items-center gap-1 flex-wrap">
                            <span class="w-32">Start (CTRL+click):</span>
                            {positionField(props.getStartPos, props.setStartPos)}
                        </div>

                        <div class="flex items-center gap-1 flex-wrap">
                            <span class="w-32">End (SHIFT+click):</span>
                            {positionField(props.getEndPos, props.setEndPos)}
                        </div>
                    </div>
                </Show>
            </div>
        </div>);
}