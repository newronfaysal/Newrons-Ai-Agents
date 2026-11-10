import { Container, Graphics, Rectangle, Text } from "pixi.js";
import type { AgentSnapshot } from "@ai-office/shared";
import { shade } from "./decor";
import type { Pt } from "./layout";

const SKIN = [0xf1c9a5, 0xd9a577, 0xb97c50, 0x8a5a3a, 0xf7d9bf];
const HAIR = [0x2b1d14, 0x5a3a22, 0xd9a441, 0x1b1b1b, 0xa33b2b, 0x7a7a8a];
const SHIRT = [0x4f86c6, 0xd95d39, 0x7bc67e, 0xf2b94b, 0xb084ff, 0x38c98b, 0xef6f9c, 0x5ec8ff];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export const ORIGIN_COLOR: Record<string, number> = {
  observed: 0x4ade80,
  orchestrated: 0x4ade80,
  manual: 0x7dd3fc,
  demo: 0xfbbf24,
  roster: 0x8a93a8,
};
export const ORIGIN_TAG: Record<string, string> = {
  observed: "LIVE",
  orchestrated: "LIVE",
  manual: "MANUAL",
  demo: "SIM",
  roster: "ROSTER",
};

const BUBBLE: Record<string, { text: string; color: number }> = {
  reading: { text: "reading", color: 0x7dd3fc },
  researching: { text: "researching", color: 0x7dd3fc },
  coding: { text: "working", color: 0x4ade80 },
  testing: { text: "testing", color: 0xfbbf24 },
  rendering: { text: "ffmpeg…", color: 0xb084ff },
  meeting: { text: "meeting", color: 0xf2b94b },
  thinking: { text: "thinking…", color: 0x9aa3ba },
  needs_attention: { text: "needs you!", color: 0xf87171 },
  finished: { text: "done", color: 0x4ade80 },
  error: { text: "error", color: 0xf87171 },
};

export class Avatar {
  readonly root = new Container();
  readonly body = new Container();
  data: AgentSnapshot;
  pos: Pt = { x: 0, y: 0 };
  path: Pt[] = [];
  destKey = "";
  seatKey: string | null = null;
  seated = false;
  idleSince = 0;
  private legL = new Graphics();
  private legR = new Graphics();
  private armL = new Container();
  private armR = new Container();
  private head = new Container();
  private ring = new Graphics();
  private bubble = new Container();
  private bubbleBg = new Graphics();
  private bubbleText: Text;
  private nameText: Text;
  private tagBg = new Graphics();
  private tagText: Text;
  private phase = Math.random() * 6;
  private seed: number;
  private lastBubble = "";
  private lastOrigin = "";

  constructor(snap: AgentSnapshot) {
    this.data = snap;
    this.seed = hash(snap.agentId);
    const shirt = SHIRT[this.seed % SHIRT.length]!;
    const skin = SKIN[(this.seed >> 3) % SKIN.length]!;
    const hair = HAIR[(this.seed >> 6) % HAIR.length]!;
    const R = (g: Graphics, x: number, y: number, w: number, h: number, c: number) =>
      g.rect(x, y, w, h).fill(c);

    const shadow = new Graphics().ellipse(0, 0, 10, 3).fill({ color: 0x000000, alpha: 0.25 });
    R(this.legL, -5, -9, 4, 9, shade(shirt, 0.5));
    R(this.legR, 1, -9, 4, 9, shade(shirt, 0.5));
    R(this.legL, -5, -2, 4, 2, 0x20242e);
    R(this.legR, 1, -2, 4, 2, 0x20242e);
    const torso = new Graphics();
    R(torso, -6, -21, 12, 13, shirt);
    R(torso, -6, -21, 12, 3, shade(shirt, 1.25));
    const armGfx = (c: Container, x: number) => {
      const a = new Graphics();
      R(a, -1.5, 0, 3, 9, shade(shirt, 0.85));
      R(a, -1.5, 8, 3, 3, skin);
      c.addChild(a);
      c.position.set(x, -20);
    };
    armGfx(this.armL, -8);
    armGfx(this.armR, 8);
    const headG = new Graphics();
    R(headG, -5, -11, 10, 10, skin);
    R(headG, -5, -12, 10, 4, hair);
    R(headG, -6, -10, 2, 5, hair);
    R(headG, 4, -10, 2, 5, hair);
    R(headG, -3, -6, 2, 2, 0x1b1b1b);
    R(headG, 1, -6, 2, 2, 0x1b1b1b);
    this.head.addChild(headG);
    this.head.position.set(0, -21);
    this.body.addChild(this.legL, this.legR, torso, this.armL, this.armR, this.head);

    this.bubbleText = new Text({
      text: "",
      style: { fontFamily: "Consolas, monospace", fontSize: 10, fontWeight: "700", fill: 0xffffff },
    });
    this.bubbleText.anchor.set(0.5);
    this.bubbleText.resolution = 2;
    this.bubble.addChild(this.bubbleBg, this.bubbleText);
    this.bubble.position.set(0, -58);
    this.nameText = new Text({
      text: snap.displayName,
      style: {
        fontFamily: "Segoe UI, sans-serif",
        fontSize: 9,
        fontWeight: "700",
        fill: 0xffffff,
        stroke: { color: 0x10131c, width: 3 },
      },
    });
    this.nameText.anchor.set(0.5);
    this.nameText.position.set(0, -44);
    this.nameText.resolution = 2;
    this.tagText = new Text({
      text: "",
      style: { fontFamily: "Consolas, monospace", fontSize: 8, fontWeight: "700", fill: 0xffffff },
    });
    this.tagText.anchor.set(0.5);
    this.tagText.position.set(0, -34);
    this.tagText.resolution = 2;
    this.tagBg.position.set(0, -34);

    this.root.addChild(shadow, this.ring, this.body, this.tagBg, this.tagText, this.nameText, this.bubble);
    this.root.scale.set(1.35);
    this.root.eventMode = "static";
    this.root.cursor = "pointer";
    this.root.hitArea = new Rectangle(-14, -56, 28, 60);
    this.apply(snap);
  }

  get label(): string {
    return this.data.displayName;
  }

  apply(snap: AgentSnapshot) {
    this.data = snap;
    const stale = snap.freshness === "stale";
    this.nameText.text =
      snap.displayName.length > 18 ? snap.displayName.slice(0, 17) + "…" : snap.displayName;
    const ghost = snap.origin === "roster";
    this.body.alpha = ghost ? 0.5 : stale ? 0.55 : snap.origin === "demo" ? 0.92 : 1;
    this.nameText.alpha = ghost ? 0.65 : 1;
    if (snap.origin !== this.lastOrigin) {
      this.lastOrigin = snap.origin;
      const col = ORIGIN_COLOR[snap.origin] ?? 0x8a93a8;
      this.ring.clear();
      const dashed = snap.origin === "demo" || snap.origin === "roster";
      for (let i = 0; i < 16; i++) {
        if (dashed && i % 2) continue;
        const a0 = (i / 16) * Math.PI * 2;
        const a1 = ((i + 1) / 16) * Math.PI * 2;
        this.ring.moveTo(Math.cos(a0) * 13, Math.sin(a0) * 4.5).lineTo(Math.cos(a1) * 13, Math.sin(a1) * 4.5);
      }
      this.ring.stroke({ width: 2, color: col, alpha: ghost ? 0.6 : 1 });
      const tag = ORIGIN_TAG[snap.origin] ?? "";
      this.tagText.text = tag;
      this.tagText.style.fill = col;
      const w = tag.length * 5.4 + 8;
      this.tagBg
        .clear()
        .roundRect(-w / 2, -6, w, 12, 3)
        .fill({ color: 0x10131c, alpha: 0.85 })
        .stroke({ width: 1, color: col, alpha: 0.9 });
      if (snap.origin === "demo") this.tagText.text = "SIMULATED";
    }
    const b = this.bubbleFor(snap);
    const key = b ? `${b.text}|${b.color}` : "";
    if (key !== this.lastBubble) {
      this.lastBubble = key;
      this.bubble.visible = !!b;
      if (b) {
        this.bubbleText.text = b.text;
        this.bubbleText.style.fill = 0xffffff;
        const w = b.text.length * 6 + 14;
        this.bubbleBg
          .clear()
          .roundRect(-w / 2, -9, w, 18, 6)
          .fill({ color: 0x10131c, alpha: 0.92 })
          .stroke({ width: 1.5, color: b.color })
          .poly([-4, 9, 4, 9, 0, 14])
          .fill({ color: b.color });
      }
    }
  }

  private bubbleFor(s: AgentSnapshot): { text: string; color: number } | null {
    if (s.origin === "roster") return null;
    if (s.freshness === "stale") return { text: "no signal", color: 0x8a93a8 };
    return BUBBLE[s.activity] ?? null;
  }

  /** Advance movement. Returns true while walking. */
  step(dtMs: number, reduced: boolean): boolean {
    if (!this.path.length) return false;
    if (reduced) {
      this.pos = { ...this.path[this.path.length - 1]! };
      this.path = [];
      return false;
    }
    let budget = (dtMs / 1000) * 110;
    while (budget > 0 && this.path.length) {
      const t = this.path[0]!;
      const dx = t.x - this.pos.x;
      const dy = t.y - this.pos.y;
      const d = Math.hypot(dx, dy);
      if (d <= budget) {
        this.pos = { ...t };
        this.path.shift();
        budget -= d;
      } else {
        this.pos = { x: this.pos.x + (dx / d) * budget, y: this.pos.y + (dy / d) * budget };
        this.faceX = dx;
        budget = 0;
      }
    }
    return this.path.length > 0;
  }
  private faceX = 0;

  animate(t: number, walking: boolean, reduced: boolean) {
    this.root.position.set(Math.round(this.pos.x), Math.round(this.pos.y));
    this.root.zIndex = this.pos.y;
    const act = this.data.activity;
    const ghost = this.data.origin === "roster";
    this.legL.visible = this.legR.visible = !this.seated || walking;
    if (reduced) {
      this.armL.rotation = this.armR.rotation = 0;
      this.body.y = 0;
      this.bubble.y = -58;
      this.bubble.scale.set(1);
      return;
    }
    const p = t + this.phase;
    if (walking) {
      const s = Math.sin(p * 14);
      this.legL.y = s * 1.5;
      this.legR.y = -s * 1.5;
      this.armL.rotation = s * 0.7;
      this.armR.rotation = -s * 0.7;
      this.body.y = Math.abs(s) * -1.5;
      this.body.scale.x = this.faceX < 0 ? -1 : 1;
    } else {
      this.legL.y = this.legR.y = 0;
      this.body.y = 0;
      this.body.scale.x = 1;
      const typing =
        !ghost &&
        (act === "coding" || act === "testing" || act === "researching") &&
        this.data.freshness === "live";
      if (typing) {
        this.armL.rotation = 0.5 + Math.sin(p * 18) * 0.3;
        this.armR.rotation = -0.5 + Math.cos(p * 18) * 0.3;
      } else if (act === "needs_attention" && !ghost) {
        this.armR.rotation = 2.6 + Math.sin(p * 8) * 0.4;
        this.armL.rotation = 0;
        this.body.y = Math.abs(Math.sin(p * 6)) * -2;
      } else if (act === "finished" && !ghost) {
        this.armL.rotation = -2.6;
        this.armR.rotation = 2.6;
      } else {
        this.armL.rotation = Math.sin(p * 1.2) * 0.05;
        this.armR.rotation = -Math.sin(p * 1.2) * 0.05;
      }
      this.head.rotation =
        act === "reading" && !ghost
          ? Math.sin(p * 1.5) * 0.12
          : act === "thinking" && !ghost
            ? Math.sin(p * 0.9) * 0.06
            : 0;
    }
    const pulse = act === "needs_attention" && !ghost ? 1 + Math.sin(t * 8) * 0.06 : 1;
    this.bubble.scale.set(pulse);
    this.bubble.y = -58 + (this.bubble.visible ? Math.sin(p * 2) * 0.8 : 0);
    // indeterminate spinner for rendering state (never a fake percentage)
    if (act === "rendering" && !ghost)
      this.bubbleText.text = "ffmpeg" + ".".repeat(1 + (Math.floor(t * 3) % 3));
  }
}
