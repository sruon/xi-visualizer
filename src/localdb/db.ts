import { Dexie, type EntityTable } from "dexie"

interface PathNode {
    id: number,
    collectionId: number,
    x: number,
    y: number,
    z: number,
}

interface PathNodeCollection {
    id: number,
    name: string,
    creationTime: number,
}

interface PathNodeZone {
    zoneId: number,
    collectionId: number,
}

interface PathNodeSet {
    id: number,
    nodeIds: number[],
}

const db = new Dexie("XiVisualizer") as Dexie & {
    pathNodes: EntityTable<PathNode, "id">,
    pathNodeCollections: EntityTable<PathNodeCollection, "id">,
    pathNodeByZone: EntityTable<PathNodeZone, "zoneId">,
    pathNodeSets: EntityTable<PathNodeSet, "id">,
}

db.version(1).stores({
    pathNodes: "++id, collectionId",
    pathNodeCollections: "++id, name, creationTime",
    pathNodeByZone: "zoneId",
    pathNodeSets: "++id, *nodeIds",
})

export type { PathNode }
export { db }
