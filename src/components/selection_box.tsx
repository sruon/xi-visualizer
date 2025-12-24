import './selection_box.css';

import * as THREE from "three"
import { createSignal, onCleanup, onMount, Show } from "solid-js";

export interface SelectionBoxProps {
  controls: THREE.Controls<any>,
  canvasElement: HTMLCanvasElement,
  outputSelectionRect: (res: SelectionBoxResult) => any;
}

export interface SelectionBoxResult {
  start: THREE.Vector2Like,
  end: THREE.Vector2Like,
  ctrl: boolean,
}

export default function SelectionBox(ps: SelectionBoxProps) {
  const [getSelectionRect, setSelectionRect] = createSignal({ start: { x: 0, y: 0 }, end: { x: 0, y: 0 }, active: false });

  const selectionRectHasSize = () => {
    const rect = getSelectionRect();
    return rect.start.x != rect.end.x && rect.start.y != rect.end.y;
  };

  const onMouseDown = (e: MouseEvent) => {
    // Disable camera rotation when there's active modifier keys
    if (e.ctrlKey || e.shiftKey) {
      ps.controls.enabled = false;
    }

    if (e.shiftKey) {
      setSelectionRect({ start: { x: e.offsetX, y: e.offsetY }, end: { x: e.offsetX, y: e.offsetY }, active: true });
    }
  };

  const onMouseMove = (e: MouseEvent) => {
    if (getSelectionRect().active) {
      setSelectionRect(prev => ({ ...prev, end: { x: e.offsetX, y: e.offsetY } }));
    }
  };

  const onMouseUp = (e: MouseEvent) => {
    ps.controls.enabled = true; // Reenable camera rotation

    if (getSelectionRect().active) {
      if (selectionRectHasSize()) {
        ps.outputSelectionRect({ start: getSelectionRect().start, end: getSelectionRect().end, ctrl: e.ctrlKey });
      }
      setSelectionRect({ ...getSelectionRect(), active: false });
    }
  };

  onMount(async () => {
    // Attach event listeners
    ps.canvasElement.addEventListener("mousedown", onMouseDown);
    ps.canvasElement.addEventListener("mouseup", onMouseUp);
    ps.canvasElement.addEventListener("mousemove", onMouseMove);

    onCleanup(() => {
      // Remove event listeners
      ps.canvasElement.removeEventListener("mousedown", onMouseDown);
      ps.canvasElement.removeEventListener("mouseup", onMouseUp);
      ps.canvasElement.removeEventListener("mousemove", onMouseMove);
    })
  })

  return <Show when={getSelectionRect().active}>
    <div class="selection-box" style={{
      left: `${Math.min(getSelectionRect().start.x, getSelectionRect().end.x)}px`,
      top: `${Math.min(getSelectionRect().start.y, getSelectionRect().end.y)}px`,
      width: `${Math.abs(getSelectionRect().end.x - getSelectionRect().start.x)}px`,
      height: `${Math.abs(getSelectionRect().end.y - getSelectionRect().start.y)}px`
    }}>
    </div>
  </Show>;
}
