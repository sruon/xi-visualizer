import type { InstancedMesh2 } from '@three.ez/instanced-mesh';
import * as THREE from 'three';

export class TargetedSelectionBox {
    private frustum = new THREE.Frustum();
    private center = new THREE.Vector3();
    private tmpPoint = new THREE.Vector3();
    private vecNear = new THREE.Vector3();
    private vecTopLeft = new THREE.Vector3();
    private vecTopRight = new THREE.Vector3();
    private vecDownRight = new THREE.Vector3();
    private vecDownLeft = new THREE.Vector3();

    private vectemp1 = new THREE.Vector3();
    private vectemp2 = new THREE.Vector3();
    private vectemp3 = new THREE.Vector3();
    private matrix = new THREE.Matrix4();
    private quaternion = new THREE.Quaternion();
    private scale = new THREE.Vector3();

    constructor(private camera: THREE.PerspectiveCamera, private depth = Number.MAX_VALUE) {
    }

    selectInstances(startPoint: THREE.Vector2Like, endPoint: THREE.Vector2Like, mesh: InstancedMesh2) {
        if (startPoint.x == endPoint.x && startPoint.y == endPoint.y) {
            return [];
        }

        const vec3Start = new THREE.Vector3(startPoint.x, startPoint.y, 0);
        const vec3End = new THREE.Vector3(endPoint.x, endPoint.y, 0);
        this.updateFrustum(vec3Start, vec3End);
        return this.searchInstancesInFrustum(mesh);
    }

    updateFrustum(startPoint: THREE.Vector3, endPoint: THREE.Vector3) {
        if (startPoint.x === endPoint.x) {
            endPoint.x += Number.EPSILON;
        }
        if (startPoint.y === endPoint.y) {
            endPoint.y += Number.EPSILON;
        }

        this.camera.updateProjectionMatrix();
        this.camera.updateMatrixWorld();

        this.tmpPoint.copy(startPoint);
        this.tmpPoint.x = Math.min(startPoint.x, endPoint.x);
        this.tmpPoint.y = Math.max(startPoint.y, endPoint.y);

        endPoint.x = Math.max(startPoint.x, endPoint.x);
        endPoint.y = Math.min(startPoint.y, endPoint.y);

        this.vecNear.setFromMatrixPosition(this.camera.matrixWorld);
        this.vecTopLeft.copy(this.tmpPoint);
        this.vecTopRight.set(endPoint.x, this.tmpPoint.y, 0);
        this.vecDownRight.copy(endPoint);
        this.vecDownLeft.set(this.tmpPoint.x, endPoint.y, 0);

        this.vecTopLeft.unproject(this.camera);
        this.vecTopRight.unproject(this.camera);
        this.vecDownRight.unproject(this.camera);
        this.vecDownLeft.unproject(this.camera);

        this.vectemp1.copy(this.vecTopLeft).sub(this.vecNear);
        this.vectemp2.copy(this.vecTopRight).sub(this.vecNear);
        this.vectemp3.copy(this.vecDownRight).sub(this.vecNear);

        this.vectemp1.normalize();
        this.vectemp2.normalize();
        this.vectemp3.normalize();

        this.vectemp1.multiplyScalar(this.depth);
        this.vectemp2.multiplyScalar(this.depth);
        this.vectemp3.multiplyScalar(this.depth);

        this.vectemp1.add(this.vecNear);
        this.vectemp2.add(this.vecNear);
        this.vectemp3.add(this.vecNear);

        const planes = this.frustum.planes;
        planes[0].setFromCoplanarPoints(this.vecNear, this.vecTopLeft, this.vecTopRight);
        planes[1].setFromCoplanarPoints(this.vecNear, this.vecTopRight, this.vecDownRight);
        planes[2].setFromCoplanarPoints(this.vecDownRight, this.vecDownLeft, this.vecNear);
        planes[3].setFromCoplanarPoints(this.vecDownLeft, this.vecTopLeft, this.vecNear);
        planes[4].setFromCoplanarPoints(this.vecTopRight, this.vecDownRight, this.vecDownLeft);
        planes[5].setFromCoplanarPoints(this.vectemp3, this.vectemp2, this.vectemp1);
        planes[5].normal.multiplyScalar(-1);
    }

    searchInstancesInFrustum(mesh: InstancedMesh2): number[] {
        let result: number[] = []
        for (let i = 0; i < mesh.instancesCount; i++) {
            mesh.getMatrixAt(i, this.matrix);
            this.matrix.decompose(this.center, this.quaternion, this.scale);
            mesh.localToWorld(this.center);
            if (this.frustum.containsPoint(this.center)) {
                result.push(i);
            }
        }
        return result;
    }
}
