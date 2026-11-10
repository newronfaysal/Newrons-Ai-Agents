import { Application, Container, Graphics, Text } from "pixi.js";
import type { AgentSnapshot, DepartmentId } from "@ai-office/shared";
import { Avatar } from "./avatar";
import { drawChair, drawDeskFront, drawScreen, drawStaticRoom, type ScreenMode } from "./decor";
import {
  CENTER,
  ROOMS,
  WORLD_H,
  WORLD_W,
  preferredSeat,
  roomList,
  route,
  type Pt,
  type RoomDef,
} from "./layout";

export interface SceneOptions {
  onSelect(id: string | null): void;
  onHover(id: string | null, x: number, y: number): void;
}

export interface DebugAgent {
  id: string;
  x: number;
  y: number;
  activity: string;
  origin: string;
  dept: string;
  seat: string | null;
  moving: boolean;
}

const ACTIVITY_SCREEN: Record<string, ScreenMode> = {
  coding: "code",
  testing: "tests",
  reading: "read",
  researching: "read",
  rendering: "render",
  thinking: "code",
  meeting: "idle",
  needs_attention: "alert",
  error: "error",
  finished: "done",
  idle: "idle",
};

interface View {
  x: number;
  y: number;
  s: number;
}
interface DeskView {
  room: RoomDef;
  idx: number;
  screen: Graphics;
  mode: ScreenMode;
  seed: number;
}

export class OfficeScene {
  app = new Application();
  private world = new Container();
  private decor = new Container();
  private chairs = new Graphics();
  private avatarLayer = new Container();
  private deskFront = new Graphics();
  private screens = new Container();
  private lights = new Container();
  private nightOverlay = new Graphics();
  private pips = new Container();
  private desks: DeskView[] = [];
  private avatars = new Map<string, Avatar>();
  private seatOwner = new Map<string, string>(); // "dept:idx" -> agentId
  private view: View = { x: 0, y: 0, s: 1 };
  private tween: { from: View; to: View; t: number; dur: number } | null = null;
  private opts: SceneOptions;
  private host: HTMLElement;
  private t = 0;
  private screenClock = 0;
  reduced = false;
  paused = false;
  private night = false;
  private destroyed = false;
  private ready = false;
  private resizeObs?: ResizeObserver;
  private cleanup: (() => void)[] = [];
  private lastAgents: AgentSnapshot[] = [];
  private overflowOwner = new Map<string, number>();

  constructor(host: HTMLElement, opts: SceneOptions) {
    this.host = host;
    this.opts = opts;
  }

  async init() {
    await this.app.init({
      background: 0x0e1018,
      antialias: false,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
      resizeTo: this.host,
      preference: "webgl",
    });
    if (this.destroyed) {
      this.app.destroy(true, { children: true });
      return;
    }
    this.host.appendChild(this.app.canvas);
    this.app.canvas.setAttribute("aria-label", "Animated virtual office with four departments");
    this.app.canvas.style.display = "block";
    const stage = this.app.stage;
    stage.eventMode = "static";
    stage.hitArea = this.app.screen;
    stage.addChild(this.world);
    this.avatarLayer.sortableChildren = true;
    this.world.addChild(
      this.decor,
      this.chairs,
      this.avatarLayer,
      this.deskFront,
      this.screens,
      this.pips,
      this.lights,
      this.nightOverlay,
    );

    for (const r of roomList) {
      const c = drawStaticRoom(r);
      this.decor.addChild(c);
      r.seats.forEach((s, idx) => {
        drawChair(this.chairs, s, r.accent);
        drawDeskFront(this.deskFront, s, r);
        const screen = new Graphics();
        this.screens.addChild(screen);
        const d: DeskView = { room: r, idx, screen, mode: "off", seed: (idx + 1) * 7 + r.x };
        this.desks.push(d);
        drawScreen(screen, s, "off", 0, d.seed);
      });
    }
    // Planning meeting table chairs
    for (const s of ROOMS.planning.meetingSeats) this.chairs.rect(s.x - 8, s.y - 6, 16, 14).fill(0x5a4630);
    this.buildLights();
    this.nightOverlay.rect(0, 0, WORLD_W, WORLD_H).fill({ color: 0x0a1030, alpha: 0.5 });
    this.nightOverlay.visible = false;
    this.lights.visible = false;

    this.fit(false);
    this.bindInput();
    this.resizeObs = new ResizeObserver(() => {
      if (!this.tween) this.fit(false, this.focused);
    });
    this.resizeObs.observe(this.host);
    this.app.ticker.add((tk) => this.tick(tk.deltaMS));
    this.ready = true;
    this.setAgents(this.lastAgents);
    this.applyFps();
  }

  private focused: DepartmentId | "all" = "all";

  private buildLights() {
    for (const r of roomList) {
      for (const s of r.seats) {
        const g = new Graphics()
          .circle(s.x, s.y + 6, 46)
          .fill({ color: 0xffd98a, alpha: 0.16 })
          .circle(s.x, s.y + 6, 24)
          .fill({ color: 0xffd98a, alpha: 0.18 });
        g.blendMode = "add";
        this.lights.addChild(g);
      }
    }
  }

  // ---- camera
  private applyView() {
    this.world.position.set(this.view.x, this.view.y);
    this.world.scale.set(this.view.s);
  }

  private rectView(x: number, y: number, w: number, h: number, pad = 24) {
    const W = this.app.screen.width;
    const H = this.app.screen.height;
    const s = Math.min((W - pad * 2) / w, (H - pad * 2) / h);
    return { s, x: (W - w * s) / 2 - x * s, y: (H - h * s) / 2 - y * s };
  }

  private goTo(v: { x: number; y: number; s: number }, animate: boolean) {
    if (!animate || this.reduced) {
      this.tween = null;
      this.view = v;
      this.applyView();
      this.render();
      return;
    }
    this.tween = { from: { ...this.view }, to: v, t: 0, dur: 420 };
  }

  fit(animate = true, which: DepartmentId | "all" = "all") {
    this.focused = which;
    if (which === "all") this.goTo(this.rectView(0, 0, WORLD_W, WORLD_H), animate);
    else {
      const r = ROOMS[which];
      this.goTo(this.rectView(r.x, r.y, 720, 480, 12), animate);
    }
  }

  zoomBy(f: number, cx = this.app.screen.width / 2, cy = this.app.screen.height / 2) {
    const s = Math.max(0.3, Math.min(3.5, this.view.s * f));
    const k = s / this.view.s;
    this.view = { s, x: cx - (cx - this.view.x) * k, y: cy - (cy - this.view.y) * k };
    this.tween = null;
    this.applyView();
    this.render();
  }

  private bindInput() {
    const canvas = this.app.canvas;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      this.zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left, e.clientY - r.top);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    this.cleanup.push(() => canvas.removeEventListener("wheel", onWheel));
    let drag: { x: number; y: number; vx: number; vy: number; moved: boolean } | null = null;
    const stage = this.app.stage;
    stage.on("pointerdown", (e) => {
      drag = { x: e.global.x, y: e.global.y, vx: this.view.x, vy: this.view.y, moved: false };
    });
    stage.on("pointermove", (e) => {
      if (drag) {
        const dx = e.global.x - drag.x;
        const dy = e.global.y - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
        if (drag.moved) {
          this.tween = null;
          this.view.x = drag.vx + dx;
          this.view.y = drag.vy + dy;
          this.applyView();
          this.render();
          this.opts.onHover(null, 0, 0);
        }
      }
    });
    const up = () => {
      if (drag && !drag.moved && !this.hitAvatar) this.opts.onSelect(null);
      drag = null;
      this.hitAvatar = false;
    };
    stage.on("pointerup", up);
    stage.on("pointerupoutside", up);
  }
  private hitAvatar = false;

  private wireAvatar(a: Avatar) {
    a.root.on("pointerdown", () => {
      this.hitAvatar = true;
    });
    a.root.on("pointertap", () => this.opts.onSelect(a.data.agentId));
    a.root.on("pointerover", (e) => this.opts.onHover(a.data.agentId, e.global.x, e.global.y));
    a.root.on("pointermove", (e) => this.opts.onHover(a.data.agentId, e.global.x, e.global.y));
    a.root.on("pointerout", () => this.opts.onHover(null, 0, 0));
  }

  // ---- settings
  setReduced(v: boolean) {
    this.reduced = v;
    this.applyFps();
    this.render();
  }
  setPaused(v: boolean) {
    this.paused = v;
    this.applyFps();
    if (this.ready) this.render();
  }
  setNight(v: boolean) {
    this.night = v;
    this.nightOverlay.visible = v;
    this.lights.visible = v;
    this.render();
  }
  private applyFps() {
    if (!this.ready) return;
    if (this.paused) this.app.ticker.stop();
    else this.app.ticker.start();
  }
  private render() {
    if (this.ready && this.paused) this.app.render();
  }

  /** Small per-room caption (real task counts) and attention pips. */
  setRoomInfo(info: Partial<Record<DepartmentId, string | { text: string; color?: number }>>) {
    this.pips.removeChildren().forEach((c) => c.destroy());
    for (const r of roomList) {
      const raw = info[r.id];
      if (!raw) continue;
      const { text, color } = typeof raw === "string" ? { text: raw, color: undefined } : raw;
      // Department state from the Task Router: coloured outline when the department is not just "available".
      const g = new Graphics()
        .roundRect(r.x + 720 / 2 - 130, r.y + 102, 260, 16, 4)
        .fill({ color: 0x0b0d14, alpha: 0.78 });
      if (color !== undefined)
        g.roundRect(r.x + 720 / 2 - 130, r.y + 102, 260, 16, 4).stroke({ color, width: 1.5 });
      this.pips.addChild(g);
      const t = new Text({
        text,
        style: { fontFamily: "Consolas, monospace", fontSize: 10, fill: color ?? 0xe6e9f2 },
      });
      t.anchor.set(0.5);
      t.position.set(r.x + 720 / 2, r.y + 110);
      t.resolution = 2;
      this.pips.addChild(t);
    }
    this.render();
  }

  // ---- agents
  setAgents(list: AgentSnapshot[]) {
    this.lastAgents = list;
    if (!this.ready) return;
    const seen = new Set<string>();
    for (const snap of list) {
      seen.add(snap.agentId);
      let av = this.avatars.get(snap.agentId);
      if (!av) {
        av = new Avatar(snap);
        this.avatars.set(snap.agentId, av);
        this.avatarLayer.addChild(av.root);
        this.wireAvatar(av);
        this.place(av, true);
      } else {
        const deptChanged = av.data.departmentId !== snap.departmentId;
        const wasActivity = av.data.activity;
        av.apply(snap);
        if (deptChanged) this.releaseSeat(av);
        if (deptChanged || wasActivity !== snap.activity) av.idleSince = this.t;
        this.place(av, false);
      }
    }
    for (const [id, av] of this.avatars) {
      if (!seen.has(id)) {
        this.releaseSeat(av);
        av.root.destroy({ children: true });
        this.avatars.delete(id);
      }
    }
    this.render();
  }

  private releaseSeat(av: Avatar) {
    if (av.seatKey && this.seatOwner.get(av.seatKey) === av.data.agentId) this.seatOwner.delete(av.seatKey);
    this.overflowOwner.delete(av.data.agentId);
    av.seatKey = null;
  }

  private claimSeat(av: Avatar): { room: RoomDef; idx: number | null; overflow: number | null } {
    const room = ROOMS[av.data.departmentId];
    if (av.seatKey) {
      const [d, i] = av.seatKey.split(":");
      if (d === room.id && this.seatOwner.get(av.seatKey) === av.data.agentId)
        return { room, idx: Number(i), overflow: null };
    }
    const pref = preferredSeat(av.data.roleId, room.id);
    const order = [...(pref !== null ? [pref] : []), ...room.seats.map((_, i) => i)];
    for (const i of order) {
      const key = `${room.id}:${i}`;
      const owner = this.seatOwner.get(key);
      if (i < room.seats.length && (!owner || owner === av.data.agentId || !this.avatars.has(owner))) {
        this.seatOwner.set(key, av.data.agentId);
        av.seatKey = key;
        return { room, idx: i, overflow: null };
      }
    }
    const used = new Set(this.overflowOwner.values());
    let o = this.overflowOwner.get(av.data.agentId);
    if (o === undefined) {
      o = 0;
      while (used.has(o)) o++;
      this.overflowOwner.set(av.data.agentId, o);
    }
    av.seatKey = null;
    return { room, idx: null, overflow: o % room.overflow.length };
  }

  private location(p: Pt): RoomDef | null {
    return roomList.find((r) => p.x >= r.x && p.x <= r.x + 720 && p.y >= r.y && p.y <= r.y + 480) ?? null;
  }

  private place(av: Avatar, first: boolean) {
    const s = av.data;
    const claim = this.claimSeat(av);
    let destKey: string;
    let dest: Pt;
    let exit: Pt;
    let toRoom = claim.room;
    let seated = false;
    const wantsMeeting = s.activity === "meeting" && s.origin !== "roster" && s.freshness !== "stale";
    const wantsBreak =
      !wantsMeeting &&
      (s.activity === "idle" || s.activity === "finished") &&
      (s.origin === "roster"
        ? !first && Math.floor(this.t / 25 + hashN(s.agentId)) % 3 === 0
        : s.freshness === "live" && this.t - av.idleSince > 45);
    if (wantsMeeting) {
      const ms = ROOMS.planning.meetingSeats;
      const idx = Math.abs(hashN(s.agentId)) % ms.length;
      const m = ms[idx]!;
      destKey = `meet:${idx}`;
      dest = { x: m.x, y: m.y + 6 };
      exit = m.exit;
      toRoom = ROOMS.planning;
      seated = true;
    } else if (wantsBreak && !s.errorMessage) {
      destKey = `break:${claim.room.id}`;
      dest = claim.room.breakSpot;
      exit = claim.room.breakSpot;
    } else if (claim.idx !== null) {
      const seat = claim.room.seats[claim.idx]!;
      destKey = `seat:${claim.room.id}:${claim.idx}`;
      dest = { x: seat.x, y: seat.y + 10 };
      exit = seat.exit;
      seated = true;
    } else {
      const o = claim.room.overflow[claim.overflow ?? 0]!;
      destKey = `overflow:${claim.room.id}:${claim.overflow}`;
      dest = o;
      exit = o;
    }
    if (first) {
      av.pos = { ...dest };
      av.destKey = destKey;
      av.seated = seated;
      av.path = [];
      av.idleSince = this.t;
      return;
    }
    if (destKey === av.destKey) return;
    av.destKey = destKey;
    av.seated = seated;
    const here = this.location(av.pos);
    av.path = route(here, here ? { x: av.pos.x, y: av.pos.y } : null, toRoom, exit, dest);
  }

  // ---- loop
  private tick(dt: number) {
    this.t += dt / 1000;
    if (this.tween) {
      this.tween.t += dt;
      const k = Math.min(1, this.tween.t / this.tween.dur);
      const e = 1 - Math.pow(1 - k, 3);
      const { from, to } = this.tween;
      this.view = {
        x: from.x + (to.x - from.x) * e,
        y: from.y + (to.y - from.y) * e,
        s: from.s + (to.s - from.s) * e,
      };
      this.applyView();
      if (k >= 1) this.tween = null;
    }
    let busy = !!this.tween;
    for (const av of this.avatars.values()) {
      const walking = av.step(dt, this.reduced);
      if (walking) busy = true;
      if (!walking && !this.reduced) {
        const a = av.data.activity;
        if (a !== "idle" && av.data.origin !== "roster") busy = true;
      }
      av.animate(this.t, walking, this.reduced);
      if (!walking) {
        const want = av.data;
        if (
          (want.activity === "idle" || want.activity === "finished") &&
          want.origin !== "roster" &&
          av.seatKey &&
          av.destKey.startsWith("seat") &&
          this.t - av.idleSince > 45
        )
          this.place(av, false);
      }
    }
    if (this.t - this.screenClock > 0.2) {
      this.screenClock = this.t;
      this.updateScreens();
    }
    // periodic roster wandering is evaluated here so ghosts stay lively without events
    if (Math.floor(this.t * 2) % 10 === 0)
      for (const av of this.avatars.values())
        if (av.data.origin === "roster" && !av.path.length) this.place(av, false);
    this.app.ticker.maxFPS = busy ? 60 : 12;
    if (this.reduced) this.app.ticker.maxFPS = 12;
  }

  private updateScreens() {
    const occupant = new Map<string, Avatar>();
    for (const av of this.avatars.values())
      if (av.seatKey && av.destKey.startsWith("seat") && !av.path.length) occupant.set(av.seatKey, av);
    for (const d of this.desks) {
      const av = occupant.get(`${d.room.id}:${d.idx}`);
      let mode: ScreenMode = "off";
      if (av) {
        mode =
          av.data.origin === "roster"
            ? "off"
            : av.data.freshness === "stale"
              ? "idle"
              : (ACTIVITY_SCREEN[av.data.activity] ?? "idle");
        if (d.room.id === "video" && mode === "code") mode = "timeline";
      }
      const animated =
        mode === "code" ||
        mode === "timeline" ||
        mode === "tests" ||
        mode === "render" ||
        mode === "alert" ||
        mode === "error";
      if (mode !== d.mode || (animated && !this.reduced)) {
        d.mode = mode;
        drawScreen(d.screen, d.room.seats[d.idx]!, mode, this.reduced ? 0 : this.t, d.seed);
      }
    }
  }

  // ---- introspection for tests and the inspector
  debugState(): {
    agents: DebugAgent[];
    view: { x: number; y: number; scale: number };
    night: boolean;
    paused: boolean;
    reduced: boolean;
    fps: number;
  } {
    return {
      agents: [...this.avatars.values()].map((a) => ({
        id: a.data.agentId,
        x: Math.round(a.pos.x),
        y: Math.round(a.pos.y),
        activity: a.data.activity,
        origin: a.data.origin,
        dept: a.data.departmentId,
        seat: a.seatKey,
        moving: a.path.length > 0,
      })),
      view: {
        x: Math.round(this.view.x),
        y: Math.round(this.view.y),
        scale: Math.round(this.view.s * 100) / 100,
      },
      night: this.night,
      paused: this.paused,
      reduced: this.reduced,
      fps: Math.round(this.app.ticker.FPS),
    };
  }

  screenPosOf(id: string): Pt | null {
    const a = this.avatars.get(id);
    if (!a) return null;
    return { x: a.pos.x * this.view.s + this.view.x, y: (a.pos.y - 30) * this.view.s + this.view.y };
  }

  destroy() {
    this.destroyed = true;
    this.cleanup.forEach((f) => f());
    this.resizeObs?.disconnect();
    if (this.ready) {
      this.app.ticker.stop();
      this.app.destroy(true, { children: true });
    }
  }
}

function hashN(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export const OFFICE_CENTER = CENTER;
