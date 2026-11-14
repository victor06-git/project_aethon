// Small 3D renderer for the Financial City (Canvas 2D, no dependencies).
// Real geometry: boxes in world space, perspective camera, back-face culling,
// painter's sort and Lambert shading. Drag to orbit. Heights animate between values.
// The renderer draws numbers it is given; it never computes finance.

import type { CityValues, CityKey } from '../../../../backend/src/domain/types';

type V3 = [number, number, number];
export interface Scene { title?: string; values: CityValues; confidence?: number; maxRef: number }
interface Face { n: V3; p: V3[]; c: V3; color: string; alpha: number; ghost: boolean; h: number }

export const BUILDINGS: { key: CityKey; label: string; short: string; color: string | null }[] = [
  { key: 'mandatory', label: 'Mandatory', short: 'Mandat.', color: '#4f6f8f' },
  { key: 'unexpected', label: 'Unexpected', short: 'Unexp.', color: '#c98a2b' },
  { key: 'small', label: 'Small spending', short: 'Small', color: '#3aa6a0' },
  { key: 'cushion', label: 'Cushion', short: 'Cushion', color: null },
  { key: 'debt', label: 'Debt', short: 'Debt', color: '#5b5f66' }
];

// Cushion: green if it covers the unexpected reserve 3x, yellow at 1x, red below.
export function cushionColor(cushion: number, unexpected: number): string {
  const r = unexpected > 0 ? cushion / unexpected : 3;
  if (r >= 3) return '#00aa4f';
  if (r >= 1) return '#d9a21b';
  return '#c8473a';
}

const v3 = {
  sub: (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  dot: (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  norm: (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
};
const LIGHT = v3.norm([-0.45, 0.85, 0.6]);

function shade(hex: string, k: number, alpha = 1): string {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((x) => Math.round(Math.min(255, x * k)));
  return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
}

const money0 = (n: number) => '€' + Math.round(n).toLocaleString('en-GB');

export class City3D {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  compact: boolean;
  yaw: number;
  pitch: number;
  scenes: Scene[];
  anim: number[][];
  raf: number;
  w = 0;
  h = 0;

  constructor(canvas: HTMLCanvasElement, { compact = false }: { compact?: boolean } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.compact = compact;
    this.yaw = -0.38;
    this.pitch = 0.36;
    this.scenes = [];   // [{ title, values, confidence, maxRef }]
    this.anim = [];     // current animated heights per scene
    this.raf = 0;
    if (!compact) this.bindDrag();
    this.resize();
  }

  bindDrag() {
    let last: [number, number] | null = null;
    const c = this.canvas;
    c.style.touchAction = 'none';
    c.addEventListener('pointerdown', (e) => { last = [e.clientX, e.clientY]; c.setPointerCapture(e.pointerId); });
    c.addEventListener('pointermove', (e) => {
      if (!last) return;
      this.yaw += (e.clientX - last[0]) * 0.01;
      this.pitch = Math.max(0.12, Math.min(1.15, this.pitch + (e.clientY - last[1]) * 0.006));
      last = [e.clientX, e.clientY];
      this.draw();
    });
    const end = () => { last = null; };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
  }

  destroy() { cancelAnimationFrame(this.raf); }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.canvas.clientWidth || 300;
    const h = this.canvas.clientHeight || 200;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = w; this.h = h;
  }

  // scenes: [{ title, values: {mandatory,...}, confidence: 0..1, maxRef }]
  setScenes(scenes: Scene[]) {
    this.scenes = scenes;
    this.anim = scenes.map((s, i) => {
      const prev = this.anim[i];
      return BUILDINGS.map((b, j) => (prev ? prev[j] : this.height(s.values[b.key], s.maxRef) * 0.15));
    });
    this.loop();
  }

  height(v: number, maxRef: number) { return 0.18 + 3.1 * Math.sqrt(Math.max(0, v) / Math.max(1, maxRef)); }

  loop() {
    cancelAnimationFrame(this.raf);
    const step = () => {
      let moving = false;
      this.scenes.forEach((s, i) => BUILDINGS.forEach((b, j) => {
        const target = this.height(s.values[b.key], s.maxRef);
        const cur = this.anim[i][j];
        const next = cur + (target - cur) * 0.18;
        this.anim[i][j] = Math.abs(target - next) < 0.002 ? target : next;
        if (this.anim[i][j] !== target) moving = true;
      }));
      this.draw();
      if (moving) this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  draw() {
    const { ctx, w, h } = this;
    ctx.clearRect(0, 0, w, h);
    const n = Math.max(1, this.scenes.length);
    const vw = w / n;
    this.scenes.forEach((s, i) => this.drawScene(s, this.anim[i], i * vw, vw, h));
    if (n > 1) {
      ctx.strokeStyle = '#d5e3d8'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(vw, 8); ctx.lineTo(vw, h - 8); ctx.stroke();
    }
  }

  drawScene(scene: Scene, heights: number[], ox: number, vw: number, vh: number) {
    const ctx = this.ctx;
    const gap = 1.55, bw = 1, bd = 1;
    const count = BUILDINGS.length;
    const cityW = (count - 1) * gap;
    const maxH = 3.3;
    const target: V3 = [cityW / 2, maxH * 0.32, 0];
    const dist = (cityW + 2) * (this.compact ? 1.3 : 1.3);
    const cam: V3 = [
      target[0] + dist * Math.cos(this.pitch) * Math.sin(this.yaw),
      target[1] + dist * Math.sin(this.pitch),
      target[2] + dist * Math.cos(this.pitch) * Math.cos(this.yaw)
    ];
    const f = v3.norm(v3.sub(target, cam));
    const r = v3.norm(v3.cross(f, [0, 1, 0]));
    const u = v3.cross(r, f);
    const focal = vw * (this.compact ? 1.0 : 1.08);
    const cx = ox + vw / 2, cy = vh * (this.compact ? 0.6 : 0.6);
    const project = (p: V3): V3 => {
      const d = v3.sub(p, cam);
      const z = v3.dot(d, f);
      return [cx + (focal * v3.dot(d, r)) / z, cy - (focal * v3.dot(d, u)) / z, z];
    };

    // Ground plate with a light grid.
    const g = ([[-1.1, 0, -1.3], [cityW + 1.1, 0, -1.3], [cityW + 1.1, 0, 1.4], [-1.1, 0, 1.4]] as V3[]).map(project);
    ctx.fillStyle = '#eef6ef'; ctx.strokeStyle = '#d9e8dc'; ctx.lineWidth = 1;
    poly(ctx, g); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = 'rgba(0,120,60,0.07)';
    for (let x = -1.1 + 0.55; x < cityW + 1.1; x += 0.55) line(ctx, project([x, 0, -1.3]), project([x, 0, 1.4]));

    const ucol = cushionColor(scene.values.cushion, scene.values.unexpected);
    const conf = scene.confidence === undefined ? 1 : scene.confidence;
    const faces: Face[] = [];
    BUILDINGS.forEach((b, i) => {
      const x0 = i * gap - bw / 2, x1 = x0 + bw, z0 = -bd / 2, z1 = bd / 2;
      const hh = heights[i];
      const color = b.color || ucol;
      addBox(faces, [x0, 0, z0], [x1, hh, z1], color, 1, cam);
      // Forecast uncertainty: translucent shell that widens as confidence drops.
      const m = (1 - conf) * 0.32;
      if (m > 0.01) addBox(faces, [x0 - m, 0, z0 - m], [x1 + m, hh * (1 + (1 - conf) * 0.35) + m, z1 + m], color, 0.13, cam, true);
    });
    faces.sort((a, b) => v3.dot(v3.sub(b.c, cam), f) - v3.dot(v3.sub(a.c, cam), f));
    for (const fc of faces) {
      const pts = fc.p.map(project);
      const lum = 0.62 + 0.5 * Math.max(0, v3.dot(fc.n, LIGHT));
      ctx.fillStyle = shade(fc.color, lum, fc.alpha);
      poly(ctx, pts); ctx.fill();
      if (fc.ghost) {
        ctx.setLineDash([3, 3]); ctx.strokeStyle = shade(fc.color, 0.9, 0.45); ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
      } else {
        ctx.strokeStyle = shade(fc.color, 0.72, 0.9); ctx.lineWidth = 0.8; ctx.stroke();
        if (fc.n[1] === 0 && !this.compact) floors(ctx, fc, project);
      }
    }

    if (this.compact) return;
    // Labels: value above each roof, short name at the front of the plot.
    ctx.textAlign = 'center';
    BUILDINGS.forEach((b, i) => {
      const x = i * gap;
      const top = project([x, heights[i] + 0.25, 0]);
      const foot = project([x, 0, 0.95]);
      ctx.font = `700 ${vw < 240 ? 9.5 : 11}px Inter, Arial, sans-serif`;
      ctx.fillStyle = '#202c24';
      ctx.fillText(money0(scene.values[b.key]), top[0], top[1]);
      ctx.font = `600 ${vw < 240 ? 8.5 : 10}px Inter, Arial, sans-serif`;
      ctx.fillStyle = '#5c6d62';
      ctx.fillText(vw < 240 ? b.short : b.label, foot[0], foot[1] + 12);
    });
    if (scene.title) {
      ctx.textAlign = 'left'; ctx.font = '800 12px Inter, Arial, sans-serif'; ctx.fillStyle = '#087339';
      ctx.fillText(scene.title, ox + 10, 18);
    }
  }
}

function addBox(out: Face[], a: V3, b: V3, color: string, alpha: number, cam: V3, ghost = false) {
  const [x0, y0, z0] = a, [x1, y1, z1] = b;
  const quads: { n: V3; p: V3[] }[] = [
    { n: [0, 1, 0], p: [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]] },
    { n: [0, 0, 1], p: [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]] },
    { n: [0, 0, -1], p: [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]] },
    { n: [1, 0, 0], p: [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]] },
    { n: [-1, 0, 0], p: [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]] }
  ];
  for (const q of quads) {
    const c = q.p.reduce<V3>((s, p) => [s[0] + p[0] / 4, s[1] + p[1] / 4, s[2] + p[2] / 4], [0, 0, 0]);
    if (v3.dot(q.n, v3.sub(cam, c)) <= 0) continue; // back face
    out.push({ ...q, c, color, alpha, ghost, h: y1 });
  }
}

// Floor lines on walls: the "windows" that make a box read as a building.
function floors(ctx: CanvasRenderingContext2D, fc: Face, project: (p: V3) => V3) {
  const [a, b] = [fc.p[0], fc.p[1]];
  ctx.strokeStyle = 'rgba(255,255,255,0.28)'; ctx.lineWidth = 1;
  for (let y = 0.32; y < fc.h - 0.1; y += 0.32) {
    const p0 = project([a[0] + (b[0] - a[0]) * 0.12, y, a[2] + (b[2] - a[2]) * 0.12]);
    const p1 = project([a[0] + (b[0] - a[0]) * 0.88, y, a[2] + (b[2] - a[2]) * 0.88]);
    line(ctx, p0, p1);
  }
}

function poly(ctx: CanvasRenderingContext2D, pts: V3[]) {
  ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
}
function line(ctx: CanvasRenderingContext2D, a: V3, b: V3) { ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); }

