import * as THREE from 'three';

export class DynamicLineSegments extends THREE.LineSegments {
    private count: number;
    private buffer: ArrayBuffer;
    private idToPosition: Map<number, number> = new Map();
    private positionToId: Map<number, number> = new Map();
    private nextLineId: number = 0;

    constructor(material: THREE.Material, initialPoints = 100) {
        // Setup the buffer (3 floats per vertex, 2 vertices per line, 4 bytes per float)
        const initialBytes = initialPoints * 2 * 3 * 4;

        let buffer = new ArrayBuffer(initialBytes);
        let positions = new Float32Array(buffer);

        const geometry = new THREE.BufferGeometry();
        const positionAttr = new THREE.BufferAttribute(positions, 3);
        positionAttr.setUsage(THREE.DynamicDrawUsage);
        geometry.setAttribute('position', positionAttr);

        // Start with 0 visible lines
        geometry.setDrawRange(0, 0);

        super(geometry, material);

        this.count = 0;
        this.buffer = buffer;
    }

    addLine(start: THREE.Vector3Like, end: THREE.Vector3Like): number {
        const attr = this.geometry.attributes.position;
        const requiredIndices = (this.count + 2);

        if (requiredIndices > attr.array.length / 3) {
            this._growBuffer();
        }

        attr.setXYZ(this.count, start.x, start.y, start.z);
        attr.setXYZ(this.count + 1, end.x, end.y, end.z);

        const lineId = this.nextLineId++;
        this.idToPosition[lineId] = this.count;
        this.positionToId[this.count] = lineId;
        this.count += 2;

        attr.needsUpdate = true;
        this.geometry.setDrawRange(0, this.count);
        this.geometry.computeBoundingSphere()

        return lineId;
    }

    removeLine(lineId: number): boolean {
        const position = this.idToPosition.get(lineId)
        if (!position) {
            return false;
        }

        const attr = this.geometry.attributes.position;
        const lastPosition = this.count - 2;
        if (position && position == lastPosition) {
            // Move the last line entry to the removed line in the array
            attr.setXYZ(position, attr.getX(lastPosition), attr.getY(lastPosition), attr.getZ(lastPosition))
            const nextLastPosition = lastPosition + 1
            attr.setXYZ(position + 1, attr.getX(nextLastPosition), attr.getY(nextLastPosition), attr.getZ(nextLastPosition))

            // Update mappings
            const lastId = this.positionToId[lastPosition];
            this.idToPosition[lastId] = position;
            this.positionToId[position] = lastId
        }

        this.idToPosition.delete(lineId);
        this.positionToId.delete(lastPosition);
        this.count -= 2;

        this.geometry.setDrawRange(0, this.count);
        attr.needsUpdate = true;

        return true;
    }

    private _growBuffer() {
        const currentByteLength = this.buffer.byteLength;
        let newByteLength = currentByteLength * 2;

        if (newByteLength > this.buffer.maxByteLength) {
            // If we exceed maxByteLength, we must transfer to a brand new buffer
            // and set a new, higher maxByteLength
            const nextMax = this.buffer.maxByteLength * 2;
            this.buffer = this.buffer.transfer ?
                this.buffer.transfer(newByteLength) :
                this._manualTransfer(newByteLength, nextMax);
        }

        const newArray = new Float32Array(this.buffer);
        const newAttr = new THREE.BufferAttribute(newArray, 3);
        newAttr.setUsage(THREE.DynamicDrawUsage);

        this.geometry.setAttribute('position', newAttr);

        this.geometry.attributes.position.needsUpdate = true;
        this.geometry.computeBoundingSphere()
    }

    private _manualTransfer(newSize: number, nextMax: number): ArrayBuffer {
        const newBuf = new ArrayBuffer(newSize, { maxByteLength: nextMax });
        new Uint8Array(newBuf).set(new Uint8Array(this.buffer));
        return newBuf;
    }
}