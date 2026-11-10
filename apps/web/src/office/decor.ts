import { Container, Graphics, Text } from "pixi.js";
import { ROOM_H, ROOM_W, type RoomDef, type Seat } from "./layout";

type G = Graphics;
const R = (g: G, x: number, y: number, w: number, h: number, c: number, a = 1) =>
  g.rect(Math.round(x), Math.round(y), w, h).fill({ color: c, alpha: a });

export const shade = (c: number, f: number) => {
  const r = Math.max(0, Math.min(255, Math.round(((c >> 16) & 255) * f)));
  const g = Math.max(0, Math.min(255, Math.round(((c >> 8) & 255) * f)));
  const b = Math.max(0, Math.min(255, Math.round((c & 255) * f)));
  return (r << 16) | (g << 8) | b;
};

function plant(g: G, x: number, y: number) {
  R(g, x - 8, y - 2, 16, 12, 0x8a5a3a);
  R(g, x - 8, y - 2, 16, 3, 0xa8714a);
  R(g, x - 3, y - 22, 6, 20, 0x2f7a3a);
  R(g, x - 12, y - 18, 10, 8, 0x3fa04c);
  R(g, x + 2, y - 24, 10, 9, 0x3fa04c);
  R(g, x - 8, y - 30, 8, 8, 0x58bd63);
}

function whiteboard(g: G, x: number, y: number, w: number, h: number, accent: number, seed = 1) {
  R(g, x - 3, y - 3, w + 6, h + 6, 0x777f8c);
  R(g, x, y, w, h, 0xf6f7fa);
  for (let i = 0; i < 5; i++)
    R(g, x + 8, y + 8 + i * 9, 24 + ((i * 37 + seed * 13) % (w - 50)), 2, shade(accent, 0.8));
  const cols = [0xffd166, 0xef476f, 0x06d6a0, 0x118ab2];
  for (let i = 0; i < 4; i++)
    R(g, x + w - 40 + (i % 2) * 18, y + 8 + Math.floor(i / 2) * 18, 14, 14, cols[(i + seed) % 4]!);
}

function window_(g: G, x: number, y: number, w: number, h: number, sky = 0x9fd4ff) {
  R(g, x - 3, y - 3, w + 6, h + 6, 0x40485a);
  R(g, x, y, w, h, sky);
  R(g, x, y + h - 10, w, 10, shade(sky, 0.9));
  R(g, x + w / 2 - 1, y, 2, h, 0x40485a);
  R(g, x + 4, y + 4, 10, 4, 0xffffff, 0.5);
}

function tableTop(g: G, x: number, y: number, w: number, h: number, c: number) {
  R(g, x, y + 8, w, h, shade(c, 0.7));
  R(g, x, y, w, h, c);
  R(g, x, y, w, 3, shade(c, 1.2));
}

function floor(g: G, r: RoomDef) {
  for (let ty = 0; ty < ROOM_H / 32; ty++)
    for (let tx = 0; tx < ROOM_W / 32; tx++)
      R(g, r.x + tx * 32, r.y + ty * 32, 32, 32, (tx + ty) % 2 ? r.floorA : r.floorB);
  // top wall (2.5D: face + top edge) and side walls
  R(g, r.x, r.y, ROOM_W, 72, r.wall);
  R(g, r.x, r.y + 72, ROOM_W, 6, shade(r.wall, 0.7));
  R(g, r.x, r.y, ROOM_W, 4, shade(r.wall, 1.3));
  R(g, r.x, r.y, 8, ROOM_H, r.trim);
  R(g, r.x + ROOM_W - 8, r.y, 8, ROOM_H, r.trim);
  R(g, r.x, r.y + ROOM_H - 8, ROOM_W, 8, r.trim);
  // leave openings toward the central hallway so the doors read as doors
  const gx = r.x === 0 ? r.x + ROOM_W - 8 : r.x;
  const gy = r.y === 0 ? r.y + ROOM_H - 8 : r.y;
  R(g, gx, r.y + ROOM_H / 2 - 60, 8, 120, r.floorA); // side opening
  R(g, r.x + ROOM_W / 2 - 60, gy, 120, 8, r.floorA); // bottom/top opening
}

export function drawStaticRoom(r: RoomDef): Container {
  const c = new Container();
  const g = new Graphics();
  c.addChild(g);
  floor(g, r);
  const x = r.x;
  const y = r.y;
  if (r.id === "planning") {
    window_(g, x + 40, y + 12, 70, 44);
    window_(g, x + 130, y + 12, 70, 44);
    whiteboard(g, x + 250, y + 12, 160, 50, r.accent, 1);
    whiteboard(g, x + 440, y + 12, 160, 50, r.accent, 2);
    R(g, x + 60, y + 250, 300, 190, 0x9c4f4f, 0.35); // rug
    tableTop(g, x + 330, y + 290, 180, 70, 0x7a5236);
    for (let i = 0; i < 4; i++) {
      R(g, x + 346 + i * 40, y + 296, 22, 14, 0xdfe6f0);
      R(g, x + 346 + i * 40, y + 322, 14, 10, 0xffffff, 0.7);
    }
    R(g, x + 620, y + 90, 70, 150, 0x5a3f2a);
    for (let i = 0; i < 4; i++) {
      R(g, x + 626, y + 98 + i * 36, 58, 26, 0x6d4d34);
      for (let k = 0; k < 5; k++)
        R(
          g,
          x + 630 + k * 11,
          y + 100 + i * 36,
          8,
          22,
          [0xd95d39, 0x4f86c6, 0xf2b94b, 0x7bc67e, 0xb084ff][(k + i) % 5]!,
        );
    }
    plant(g, x + 30, y + 120);
    plant(g, x + 690, y + 330);
    plant(g, x + 30, y + 430);
    R(g, x + 38, y + 84, 56, 40, 0x8a5a3a);
    R(g, x + 42, y + 88, 20, 16, 0xe8e0d0);
    R(g, x + 66, y + 88, 20, 16, 0xa8714a); // break counter
  } else if (r.id === "video") {
    R(g, x + 30, y + 20, ROOM_W - 60, 6, r.accent, 0.9);
    R(g, x + 30, y + 26, ROOM_W - 60, 2, shade(r.accent, 1.4));
    R(g, x + 220, y + 30, 280, 38, 0x0b0a16);
    for (let i = 0; i < 14; i++)
      R(
        g,
        x + 228 + i * 19,
        y + 38 + (i % 3) * 8,
        15 + (i % 4) * 2,
        6,
        [0x6c5ce7, 0x00cec9, 0xfd79a8][i % 3]!,
      );
    R(g, x + 560, y + 100, 120, 60, 0x1a1730);
    R(g, x + 566, y + 106, 108, 48, 0x0e0c1b);
    R(g, x + 330, y + 410, 110, 30, 0x4a3a7a);
    R(g, x + 330, y + 404, 110, 10, 0x5b49a0);
    R(g, x + 340, y + 396, 90, 10, 0x5b49a0); // sofa
    R(g, x + 600, y + 330, 6, 70, 0x14122a);
    R(g, x + 590, y + 330, 26, 22, 0x2a2850);
    R(g, x + 596, y + 336, 14, 10, 0x0b0a16); // camera tripod
    R(g, x + 640, y + 300, 40, 56, 0xffffff, 0.85);
    R(g, x + 658, y + 356, 4, 50, 0x14122a); // softbox
    R(g, x + 30, y + 130, 18, 40, 0x14122a);
    R(g, x + 660, y + 410, 22, 40, 0x14122a);
    plant(g, x + 690, y + 220);
  } else if (r.id === "dev") {
    window_(g, x + 40, y + 12, 90, 44, 0x6b8fb8);
    window_(g, x + 150, y + 12, 90, 44, 0x6b8fb8);
    whiteboard(g, x + 300, y + 12, 200, 50, r.accent, 3);
    R(g, x + 590, y + 10, 100, 62, 0x1b2029);
    for (let i = 0; i < 6; i++) {
      R(g, x + 596, y + 14 + i * 9, 88, 6, 0x2e3644);
      R(g, x + 676, y + 15 + i * 9, 4, 4, i % 2 ? 0x4ade80 : 0xfbbf24);
    } // server rack
    R(g, x + 620, y + 360, 46, 60, 0x555d6e);
    R(g, x + 626, y + 366, 34, 22, 0x1b2029);
    R(g, x + 636, y + 396, 14, 18, 0xf5f5f5); // coffee machine
    R(g, x + 560, y + 410, 60, 36, 0x3e5a8a);
    R(g, x + 566, y + 404, 48, 14, 0x4d70a8); // bean bag
    plant(g, x + 30, y + 430);
    plant(g, x + 690, y + 250);
  } else {
    window_(g, x + 40, y + 12, 80, 44, 0xbfe8ff);
    window_(g, x + 140, y + 12, 80, 44, 0xbfe8ff);
    R(g, x + 300, y + 10, 190, 56, 0xffffff);
    R(g, x + 300, y + 10, 190, 3, 0x38c98b);
    for (let i = 0; i < 4; i++) {
      R(g, x + 312, y + 20 + i * 11, 8, 8, 0xffffff);
      g.rect(x + 312, y + 20 + i * 11, 8, 8).stroke({ width: 1, color: 0x38c98b });
      R(g, x + 326, y + 23 + i * 11, 60 + ((i * 23) % 50), 3, 0x93a9a4);
    }
    R(g, x + 520, y + 10, 160, 56, 0xffffff);
    R(g, x + 520, y + 10, 160, 3, 0xef476f);
    for (let i = 0; i < 5; i++) {
      R(g, x + 532 + i * 28, y + 24, 16, 16, 0xfff3b0);
      R(g, x + 536 + i * 28, y + 20, 4, 4, i % 2 ? 0xef476f : 0x38c98b);
    }
    tableTop(g, x + 400, y + 330, 220, 56, 0xcfd9d6);
    R(g, x + 420, y + 336, 30, 18, 0x2b3340);
    R(g, x + 470, y + 334, 12, 22, 0x2b3340);
    R(g, x + 500, y + 338, 36, 16, 0x2b3340);
    R(g, x + 560, y + 336, 40, 20, 0x2b3340);
    plant(g, x + 40, y + 430);
    plant(g, x + 690, y + 140);
  }
  // sign plate
  g.roundRect(x + ROOM_W / 2 - 110, y + 80, 220, 20, 4).fill({ color: 0x0b0d14, alpha: 0.78 });
  const label = new Text({
    text: r.name,
    style: {
      fontFamily: "Consolas, monospace",
      fontSize: 12,
      fontWeight: "700",
      fill: r.accent,
      letterSpacing: 2,
    },
  });
  label.anchor.set(0.5);
  label.position.set(x + ROOM_W / 2, y + 90);
  label.resolution = 2;
  c.addChild(label);
  return c;
}

export function drawChair(g: G, s: Seat, accent: number) {
  R(g, s.x - 9, s.y - 6, 18, 18, shade(accent, 0.55));
  R(g, s.x - 9, s.y - 14, 18, 10, shade(accent, 0.75));
}

export function drawDeskFront(g: G, s: Seat, r: RoomDef) {
  const top = r.id === "video" ? 0x3a3560 : r.id === "qa" ? 0xf3f6f5 : r.id === "dev" ? 0x707a8c : 0xa8774a;
  R(g, s.x - 30, s.y + 10, 60, 6, shade(top, 1.2));
  R(g, s.x - 30, s.y + 16, 60, 16, top);
  R(g, s.x - 30, s.y + 32, 60, 4, shade(top, 0.6));
  R(g, s.x - 6, s.y + 20, 12, 4, shade(top, 0.8)); // keyboard
  // two monitor frames (screens are drawn separately, animated)
  for (const dx of [-26, 6]) {
    R(g, s.x + dx, s.y - 6, 22, 18, 0x20242e);
    R(g, s.x + dx + 8, s.y + 12, 6, 3, 0x20242e);
  }
}

export type ScreenMode =
  "off" | "idle" | "code" | "timeline" | "tests" | "read" | "render" | "alert" | "error" | "done";

export function drawScreen(g: G, s: Seat, mode: ScreenMode, t: number, seed: number) {
  g.clear();
  const colors: Record<ScreenMode, number> = {
    off: 0x0b0d12,
    idle: 0x131a28,
    code: 0x0f1e17,
    timeline: 0x151128,
    tests: 0x0f1b24,
    read: 0x1c2230,
    render: 0x151128,
    alert: 0x3a1212,
    error: 0x2a0c0c,
    done: 0x0f2418,
  };
  for (const [i, dx] of [-26, 6].entries()) {
    const x = s.x + dx + 2;
    const y = s.y - 4;
    R(g, x, y, 18, 14, colors[mode]);
    if (mode === "idle") R(g, x + 6, y + 6, 6, 2, 0x35425e);
    if (mode === "code")
      for (let l = 0; l < 4; l++)
        R(
          g,
          x + 2,
          y + 2 + l * 3,
          4 + ((seed + l * 5 + Math.floor(t * 2) * (i + 1)) % 11),
          2,
          [0x4ade80, 0x7dd3fc, 0xfbbf24, 0xf87171][(l + i) % 4]!,
        );
    if (mode === "timeline") {
      for (let l = 0; l < 3; l++) R(g, x + 1, y + 2 + l * 4, 16, 3, 0x241d42);
      for (let k = 0; k < 5; k++)
        R(
          g,
          x + 1 + ((k * 5 + seed) % 11),
          y + 2 + (k % 3) * 4,
          5,
          3,
          [0x6c5ce7, 0x00cec9, 0xfd79a8][k % 3]!,
        );
      R(g, x + 2 + Math.floor((t * 6) % 14), y + 1, 1, 12, 0xffffff);
    }
    if (mode === "tests")
      for (let l = 0; l < 4; l++) {
        R(g, x + 2, y + 2 + l * 3, 2, 2, l === 3 && Math.floor(t * 3) % 2 ? 0xfbbf24 : 0x4ade80);
        R(g, x + 6, y + 2 + l * 3, 8, 2, 0x35425e);
      }
    if (mode === "read")
      for (let l = 0; l < 5; l++) R(g, x + 2, y + 2 + l * 2, 6 + ((seed + l * 7) % 9), 1, 0x9aa3ba);
    if (mode === "render") {
      R(g, x + 2, y + 6, 14, 3, 0x241d42);
      const w = 5;
      R(g, x + 2 + Math.floor((t * 8) % 10), y + 6, w, 3, 0xb084ff);
    } // indeterminate sweep, NOT progress
    if (mode === "alert" || mode === "error") {
      if (Math.floor(t * 3) % 2) R(g, x + 7, y + 3, 4, 7, 0xf87171);
      R(g, x + 7, y + 11, 4, 2, 0xf87171);
    }
    if (mode === "done") {
      R(g, x + 4, y + 7, 3, 2, 0x4ade80);
      R(g, x + 7, y + 9, 3, 2, 0x4ade80);
      R(g, x + 10, y + 5, 3, 4, 0x4ade80);
    }
  }
}
