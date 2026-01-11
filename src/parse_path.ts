import { EntityUpdate, EntityUpdateKind, Position, PositionUpdate } from "./parse_packets";

export const enum PathPartKind {
  Start,
  NewDirection,
  End,
  Interrupted,
}

export interface PathStart {
  kind: PathPartKind.Start;
  pauseTime: number;
  rot: number;
  rotDiff: number;
}

export interface PathEnd {
  kind: PathPartKind.End;
  moveTime: number;
  pathDist: number;
  legDist: number;
  startPos: Position;
  endPos: Position;
}

export interface PathDirection {
  kind: PathPartKind.NewDirection;
  walkTime: number;
  walkDist: number;
  rot: number;
  rotDiff: number;
}

export interface PathInterrupted {
  kind: PathPartKind.Interrupted;
}
export interface PathBase {
  pos: Position;
  time: number;
}

export type PathPart = PathBase & (PathStart | PathDirection | PathEnd | PathInterrupted);

interface PrevUpdates {
  one?: PositionUpdate,
  move?: PositionUpdate,
  stop?: PositionUpdate,
  rot?: PositionUpdate,
}


export function parsePath2(updates: EntityUpdate[]): PathPart[] {
  let prev: PrevUpdates = {}
  let path: PathPart[] = [];

  let distMoved = 0;
  let timeSinceLastMove = 0;
  let moveTime = 0;
  let stopDist = 0;
  let stopTime = 0;

  for (const update of updates) {
    if (update.kind === EntityUpdateKind.OutOfRange || update.kind === EntityUpdateKind.Despawn) {
      if (prev.rot) {
        path.push({
          kind: PathPartKind.Interrupted,
          pos: prev.one.pos,
          time: update.time,
        });
      }
      prev = {}
      continue;
    }

    if (update.kind !== EntityUpdateKind.Position) {
      continue;
    }

    if (!prev.one) {
      prev.one = update;
      continue;
    }

    distMoved = calcDistance(update.pos, prev.one.pos);

    if (distMoved > 0.1) {
      if (prev.move) {
        timeSinceLastMove = update.time - prev.move.time;

        if (timeSinceLastMove > 3000) {

        }
      }

      stopTime = 0;
      prev.move = update;
    } else {
      stopTime += update.time - prev.one.time
      if (stopTime > 3000) {

      }
    }
  }

  return path;
}

export function parsePath(updates: EntityUpdate[]): PathPart[] {
  let prev: PrevUpdates = {}

  let distMoved = 0;
  let timeSinceLastMove = 0;
  let moveTime = 0;
  let stopDist = 0;

  let path: PathPart[] = [];
  for (const update of updates) {
    if (update.kind === EntityUpdateKind.OutOfRange || update.kind === EntityUpdateKind.Despawn) {
      if (prev.rot) {
        path.push({
          kind: PathPartKind.Interrupted,
          pos: prev.one.pos,
          time: update.time,
        });
      }
      prev = {}
      continue;
    }
    if (update.kind !== EntityUpdateKind.Position) {
      continue;
    }

    if (!prev.one) {
      prev.one = update;
      prev.rot = update;
      continue;
    }

    distMoved = calcDistance(update.pos, prev.one.pos);

    if (distMoved > 0.1) {
      if (prev.move) {
        timeSinceLastMove = update.time - prev.move.time;

        if (timeSinceLastMove > 3000) {
          if (prev.stop) {
            moveTime = prev.move.time - prev.stop.time;
            stopDist = calcDistance(prev.move.pos, prev.stop.pos);
            path.push({
              kind: PathPartKind.End,
              pos: prev.move.pos,
              time: prev.move.time,
              moveTime: moveTime,
              pathDist: stopDist,
              legDist: calcDistance(prev.rot.pos, prev.move.pos),
              startPos: prev.stop.pos,
              endPos: prev.move.pos,
            });

            path.push({
              kind: PathPartKind.Start,
              pos: update.pos,
              time: update.time,
              pauseTime: timeSinceLastMove,
              rot: update.pos.rotation!,
              rotDiff: calcRotDiff(prev.move.pos.rotation!, update.pos.rotation!),
            });
          }

          prev.stop = update;
          prev.rot = update;
        }
      }

      prev.move = update;
    }

    if (prev.rot && update.pos.rotation != prev.rot.pos.rotation) {
      path.push({
        kind: PathPartKind.NewDirection,
        time: update.time,
        pos: update.pos,
        rot: update.pos.rotation!,
        rotDiff: calcRotDiff(prev.rot.pos.rotation!, update.pos.rotation!),
        walkDist: calcDistance(prev.rot.pos, update.pos),
        walkTime: update.time - prev.rot.time,
      });
      prev.rot = update;
    }

    prev.one = update;
  }

  if (prev.one && path.length > 0 && path[-1]?.kind !== PathPartKind.End) {
    path.push({
      kind: PathPartKind.Interrupted,
      pos: prev.one.pos,
      time: prev.one.time,
    });
  }

  return path;
}

function calcRotDiff(startRot: number, endRot: number): number {
  let diff = endRot - startRot;
  if (diff > 128) {
    return diff - 256;
  }
  if (diff < -128) {
    return diff + 256;
  }
  return diff;
}

function calcDistance(pos1: Position, pos2: Position): number {
  return Math.sqrt(Math.pow(pos1.x - pos2.x, 2) + Math.pow(pos1.z - pos2.z, 2));
}
