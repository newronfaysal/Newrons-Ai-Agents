import { DEFAULT_ROLES, type DepartmentId } from "@ai-office/shared";

export const ROOM_W = 720;
export const ROOM_H = 480;
export const GAP = 24;
export const WORLD_W = ROOM_W * 2 + GAP;
export const WORLD_H = ROOM_H * 2 + GAP;
export const CENTER = { x: WORLD_W / 2, y: WORLD_H / 2 };

export interface Pt {
  x: number;
  y: number;
}
export interface Seat {
  x: number;
  y: number;
  exit: Pt;
}

export interface RoomDef {
  id: DepartmentId;
  name: string;
  x: number;
  y: number;
  floorA: number;
  floorB: number;
  wall: number;
  trim: number;
  accent: number;
  seats: Seat[];
  /** Planning room only: seats around the meeting table. */
  meetingSeats: Seat[];
  breakSpot: Pt;
  door: Pt; // inner-corner waypoint on the way to the central hallway
  overflow: Pt[];
}

const mkSeats = (rx: number, ry: number, rows: { y: number; xs: number[] }[]): Seat[] =>
  rows.flatMap((r) => r.xs.map((x) => ({ x: rx + x, y: ry + r.y, exit: { x: rx + x, y: ry + r.y + 40 } })));

const overflowRow = (rx: number, ry: number): Pt[] =>
  Array.from({ length: 8 }, (_, i) => ({ x: rx + 70 + i * 82, y: ry + ROOM_H - 26 }));

function room(
  id: DepartmentId,
  name: string,
  gx: number,
  gy: number,
  theme: Pick<RoomDef, "floorA" | "floorB" | "wall" | "trim" | "accent">,
  rows: { y: number; xs: number[] }[],
): RoomDef {
  const x = gx * (ROOM_W + GAP);
  const y = gy * (ROOM_H + GAP);
  const doorX = gx === 0 ? x + ROOM_W - 26 : x + 26;
  const doorY = gy === 0 ? y + ROOM_H - 26 : y + 26;
  return {
    id,
    name,
    x,
    y,
    ...theme,
    seats: mkSeats(x, y, rows),
    meetingSeats: [],
    breakSpot: { x: gx === 0 ? x + 80 : x + ROOM_W - 90, y: y + ROOM_H - 70 },
    door: { x: doorX, y: doorY },
    overflow: overflowRow(x, y),
  };
}

export const ROOMS: Record<DepartmentId, RoomDef> = {
  planning: room(
    "planning",
    "PLANNING TEAM",
    0,
    0,
    { floorA: 0xc9b99a, floorB: 0xbfae8e, wall: 0x6b5a45, trim: 0x8d7a5f, accent: 0xf2b94b },
    [{ y: 212, xs: [90, 200, 310] }],
  ),
  video: room(
    "video",
    "VIDEO EDITOR TEAM",
    1,
    0,
    { floorA: 0x2a2540, floorB: 0x262139, wall: 0x15122a, trim: 0x2f2a52, accent: 0xb084ff },
    [
      { y: 212, xs: [90, 220, 350, 480] },
      { y: 352, xs: [90, 220] },
    ],
  ),
  dev: room(
    "dev",
    "APP DEVELOPMENT TEAM",
    0,
    1,
    { floorA: 0x4a5160, floorB: 0x444b59, wall: 0x2b303b, trim: 0x3d4452, accent: 0x5ec8ff },
    [
      { y: 212, xs: [90, 220, 350, 480] },
      { y: 352, xs: [90, 220, 350, 480] },
    ],
  ),
  qa: room(
    "qa",
    "QA TEAM",
    1,
    1,
    { floorA: 0xe7f0ee, floorB: 0xdbe8e5, wall: 0x93a9a4, trim: 0xb7c9c5, accent: 0x38c98b },
    [
      { y: 212, xs: [90, 220, 350, 480] },
      { y: 352, xs: [90, 220] },
    ],
  ),
};

// Meeting table in the Planning room (agents of any department walk here when delegating/meeting).
{
  const r = ROOMS.planning;
  const cx = r.x + 420;
  const cy = r.y + 330;
  const pts: [number, number][] = [
    [-70, -34],
    [-24, -34],
    [24, -34],
    [70, -34],
    [-70, 34],
    [-24, 34],
    [24, 34],
    [70, 34],
  ];
  r.meetingSeats = pts.map(([dx, dy]) => ({
    x: cx + dx,
    y: cy + dy + (dy < 0 ? -6 : 18),
    exit: { x: cx + dx, y: cy + (dy < 0 ? -70 : 80) },
  }));
}

export const roomList = Object.values(ROOMS);

/** Stable preferred seat for a role, so roster placeholders and real agents with that role share a desk. */
export function preferredSeat(roleId: string | null, dept: DepartmentId): number | null {
  if (!roleId) return null;
  const inDept = DEFAULT_ROLES.filter((r) => r.departmentId === dept);
  const i = inDept.findIndex((r) => r.id === roleId);
  return i >= 0 ? i : null;
}

/**
 * Waypoints from a seat exit in `fromRoom` to a destination in `toRoom`. Movement always runs along aisles
 * and the room's door column, so avatars never cut through desks.
 */
export function route(
  fromRoom: RoomDef | null,
  fromExit: Pt | null,
  toRoom: RoomDef,
  toExit: Pt,
  dest: Pt,
): Pt[] {
  const out: Pt[] = [];
  if (fromRoom && fromExit) {
    if (fromRoom.id === toRoom.id) {
      // same room: stay in the aisle lane when both ends share it, otherwise change lanes along the door column
      if (Math.abs(fromExit.y - toExit.y) < 30) out.push(fromExit, { x: toExit.x, y: fromExit.y });
      else out.push(fromExit, { x: fromRoom.door.x, y: fromExit.y }, { x: toRoom.door.x, y: toExit.y });
    } else {
      out.push(fromExit, { x: fromRoom.door.x, y: fromExit.y }, fromRoom.door, CENTER, toRoom.door, {
        x: toRoom.door.x,
        y: toExit.y,
      });
    }
  } else {
    out.push(CENTER, toRoom.door, { x: toRoom.door.x, y: toExit.y });
  }
  out.push(toExit, dest);
  return out;
}
