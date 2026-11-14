// Kaiku aurora icon: a real-time northern lights renderer (WebGL fragment shader).
// Model, after real aurora:
//  - a folded curtain with a SHARP, brightest lower edge (green, oxygen 557.7 nm),
//  - vertical rays along the magnetic field that flare and fade at their own pace,
//  - brightness falling off upward, colour going green → teal → cyan → faint violet at the top,
//  - a second, fainter curtain behind, a few stars, a balanced deep-green night sky.
// Usage: mountAurora(canvas) returns stop(); mountWaves(canvas) draws the living waves around it.

const VERT = `attribute vec2 p; varying vec2 uv; void main(){ uv = p; gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAG = `
precision highp float;
varying vec2 uv;
uniform float t;
uniform vec2 res;
uniform float brand;

float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; } return v; }

// lower edge of a curtain: slow S-folds plus a finer ripple that drifts along it
float edgeY(float x, float base, float amp, float speed, float seed){
  return base
    + amp * sin(1.7 * x + 0.35 * t * speed + seed)
    + amp * 0.38 * sin(4.1 * x - 0.6 * t * speed + seed * 2.0)
    + 0.10 * (fbm(vec2(x * 1.3 + seed, t * 0.07 * speed)) - 0.5);
}

// one auroral curtain: returns light (rgb) for this pixel
vec3 curtain(vec2 p, float base, float amp, float speed, float seed, float gain){
  float y0 = edgeY(p.x, base, amp, speed, seed);
  float d = p.y - y0;                                   // height above the lower edge
  // rays: thin, nearly vertical streaks; the field lines lean with the folds
  float lean = 0.18 * sin(1.7 * p.x + 0.35 * t * speed + seed);
  float rx = p.x * 9.0 + lean * d * 5.0 + 1.0 * fbm(vec2(p.x * 1.8 + seed, t * 0.12));
  float rays = fbm(vec2(rx, d * 1.2 - t * 0.35 * speed));
  rays = smoothstep(0.2, 0.9, rays);
  float flare = 0.65 + 0.35 * fbm(vec2(p.x * 3.0 - t * 0.5, seed));       // patches brightening and fading
  // vertical profile: sharp onset at the edge, slow fade upward
  float onset = smoothstep(-0.02, 0.03, d);
  float height = 0.55 + 0.35 * fbm(vec2(p.x * 1.8 + seed, t * 0.05));
  float fall = exp(-max(d, 0.0) / (0.11 * height + 0.035));
  float band = exp(-max(d, 0.0) / 0.07);                                   // the dense, brightest band right above the edge
  float body = onset * (fall * (0.3 + 1.15 * rays) + band * (0.55 + 0.6 * rays)) * flare;
  float glowBelow = exp(min(d, 0.0) * 38.0) * (1.0 - onset) * 0.35;        // faint light just under the edge
  float edgeLine = exp(-abs(d) * 42.0) * (0.7 + 0.6 * rays);              // the brightest, sharp lower border
  // colour by height: green at the base, teal, cyan, a hint of violet at the top
  vec3 green = vec3(0.25, 1.00, 0.52);
  vec3 teal  = vec3(0.10, 0.88, 0.72);
  vec3 cyan  = vec3(0.22, 0.72, 1.00);
  vec3 violet= vec3(0.62, 0.42, 1.00);
  float h = max(d, 0.0);
  vec3 col = mix(green, teal, smoothstep(0.02, 0.18, h));
  col = mix(col, cyan, smoothstep(0.16, 0.42, h));
  col = mix(col, violet, smoothstep(0.38, 0.75, h));
  vec3 light = col * body + green * glowBelow + vec3(0.75, 1.0, 0.86) * edgeLine * 0.75;
  return light * gain;
}


// ground line of the landscape (gentle hills)
float groundY(float x, float lift){ return -0.66 + lift + 0.05 * sin(x * 2.3 + 1.0) + 0.025 * (noise(vec2(x * 5.0, lift * 10.0)) - 0.5); }

// one row of Lapland spruces: narrow cones built from drooping branch tiers, a thin top, a trunk.
// Returns coverage 0..1 (antialiased). Neighbouring cells are checked so trees can overlap.
float spruceRow(vec2 p, float freq, float seed, float lift, float hMin, float hMax, float aa){
  float cell = floor(p.x * freq);
  float cov = 0.0;
  for (int k = -1; k <= 1; k++) {
    float c = cell + float(k);
    float r1 = hash(vec2(c, seed));
    float r2 = hash(vec2(c, seed + 1.7));
    if (r2 < 0.06) continue;                                  // a gap in the forest now and then
    float cx = (c + 0.5 + (r2 - 0.5) * 0.7) / freq;
    float th = mix(hMin, hMax, r1 * r1);
    float base = groundY(cx, lift);
    float ty = (p.y - base) / th;                             // 0 at the foot, 1 at the tip
    if (ty < -0.1 || ty > 1.0) continue;
    float tiers = 7.0 + floor(r1 * 4.0);
    float f = fract(ty * tiers + r2);
    float droop = 0.55 + 0.45 * (1.0 - f) * (1.0 - f);        // each tier widest at its lower tips
    float halfW = th * 0.27 * pow(1.0 - ty, 1.05) * droop + th * 0.008;
    float dx = abs(p.x - cx) + 0.004 * (noise(vec2(p.y * 160.0, c)) - 0.5);   // ragged needles
    float crown = smoothstep(halfW + aa, halfW - aa, dx) * smoothstep(-0.02, 0.02, ty);
    float trunk = smoothstep(th * 0.025 + aa, th * 0.025 - aa, abs(p.x - cx)) * step(-0.1, ty) * step(ty, 0.08);
    cov = max(cov, max(crown, trunk));
  }
  return cov;
}

void main(){
  vec2 p = uv;                                          // -1..1, y up
  float r = length(p);
  // night sky: balanced deep green, a touch lighter near the horizon
  vec3 sky = mix(vec3(0.055, 0.21, 0.18), vec3(0.045, 0.16, 0.17), smoothstep(-0.9, 0.9, p.y));
  // stars
  vec2 g = floor((p + 1.0) * 38.0);
  float s = hash(g);
  float tw = 0.5 + 0.5 * sin(t * (1.0 + s * 3.0) + s * 40.0);
  vec2 f = fract((p + 1.0) * 38.0) - 0.5;
  float star = step(0.986, s) * smoothstep(0.12, 0.0, length(f)) * tw * smoothstep(-0.1, 0.5, p.y);
  vec3 col = sky + vec3(0.8, 1.0, 0.95) * star * 0.8;
  // two curtains: a faint one far behind, the main one in front
  vec3 aur = curtain(p, 0.05, 0.14, 0.8, 4.0, 0.38) + curtain(p, -0.28, 0.20, 1.0, 1.3, 0.78);
  float aa0 = 2.0 / res.x;
  float disc0 = smoothstep(1.0, 1.0 - aa0, r);
  // flat UI palettes: no scene, only the aurora ribbon on the app's own surfaces
  if (brand > 2.5) {
    float L = 1.0 - exp(-dot(aur, vec3(0.3, 0.6, 0.1)) * 1.5);
    L *= smoothstep(1.0, 0.75, r);
    vec3 c;
    if (brand < 3.5) {        // clean: bank green button, white-mint light
      vec3 bg = mix(vec3(0.043, 0.72, 0.353), vec3(0.027, 0.52, 0.25), smoothstep(-1.0, 1.0, p.x - p.y));
      c = mix(bg, vec3(0.88, 1.0, 0.93), L);
    } else if (brand < 4.5) { // ink: the teaser's deep green (--deep #087339), mint light
      vec3 bg = mix(vec3(0.045, 0.52, 0.26), vec3(0.025, 0.40, 0.2), smoothstep(-1.0, 1.0, p.x - p.y));
      c = mix(bg, vec3(0.62, 1.0, 0.78), L);
    } else {                  // light: white card surface, bank green light with visible rays
      vec3 bg = mix(vec3(0.99, 1.0, 0.99), vec3(0.89, 0.965, 0.92), smoothstep(0.9, -0.9, p.y));
      float Ld = 1.0 - exp(-dot(aur, vec3(0.3, 0.6, 0.1)) * 3.0);
      Ld = pow(Ld, 0.72) * smoothstep(1.0, 0.8, r) * 0.92;     // lift the faint rays above the bright edge
      // only the bank's greens: soft mint in the faint rays, the teaser's deep green (#087339) in the folds
      vec3 ink = mix(vec3(0.36, 0.80, 0.55), vec3(0.031, 0.45, 0.224), smoothstep(0.2, 0.95, Ld));
      c = mix(bg, ink, Ld);
    }
    gl_FragColor = vec4(c * disc0, disc0);
    return;
  }
  col += aur;
  // fade the light toward the rim so it sits inside the button
  col = mix(sky, col, smoothstep(1.02, 0.80, r));
  // Lapland landscape: a hazy far row of small spruces, snow lit faintly green by the aurora,
  // and a near row of tall dark spruces standing on it.
  // soft edges: the forest is a calm silhouette, not a sharp cut-out
  float px = 5.0 / res.x;
  // trees take a tint of the sky behind them (aerial perspective), so every row melts into the scene
  vec3 tint = sky + vec3(0.02, 0.07, 0.05);
  float far = spruceRow(p, 26.0, 11.0, 0.07, 0.06, 0.12, px * 1.6);
  col = mix(col, mix(tint, vec3(0.05, 0.16, 0.15), 0.35), far * 0.55);
  float mid = spruceRow(p, 18.0, 7.0, 0.035, 0.08, 0.17, px * 1.3);
  col = mix(col, mix(tint, vec3(0.04, 0.13, 0.12), 0.6), mid * 0.75);
  float snowLine = groundY(p.x, 0.0);
  float snow = smoothstep(snowLine + px * 3.0, snowLine - px * 3.0, p.y);
  vec3 snowCol = mix(vec3(0.07, 0.2, 0.18), vec3(0.05, 0.15, 0.14), smoothstep(snowLine, snowLine - 0.3, p.y));
  snowCol += vec3(0.03, 0.1, 0.07) * (0.6 + 0.4 * sin(p.x * 3.0 + t * 0.3));          // aurora glow on the snow
  col = mix(col, snowCol, snow);
  float near = spruceRow(p, 13.0, 3.0, 0.0, 0.12, 0.27, px);
  col = mix(col, mix(tint, vec3(0.025, 0.085, 0.08), 0.85), near * 0.88);
  // low ground mist softens where trees meet the snow
  float mist = exp(-abs(p.y - snowLine - 0.02) / 0.07);
  col = mix(col, vec3(0.1, 0.3, 0.25), mist * 0.18);
  // gentle tone mapping keeps the bright edge from clipping to flat white
  col = 1.0 - exp(-col * 1.15);
  // round button with a soft antialiased rim and a thin green rim light
  float aa = 2.0 / res.x;
  float disc = smoothstep(1.0, 1.0 - aa, r);
  float rim = smoothstep(0.93, 0.985, r) * disc;
  col += vec3(0.18, 0.85, 0.55) * rim * 0.35;
  // brand palette: re-map the night scene by brightness onto the S-Pankki greens, so the icon
  // reads as part of the bank UI (green card gradient, darker green forest, mint-white light)
  // deep palette: the same real aurora, shifted from teal toward the bank's deep green
  if (brand > 1.5) { col *= vec3(0.9, 1.0, 0.62); }
  else if (brand > 0.5) {
    float lum = dot(col, vec3(0.3, 0.6, 0.1));
    vec3 skyB = mix(vec3(0.05, 0.70, 0.34), vec3(0.02, 0.50, 0.24), smoothstep(-0.9, 0.9, p.x - p.y));
    vec3 b = mix(vec3(0.015, 0.40, 0.20), skyB, smoothstep(0.1, 0.165, lum));
    b = mix(b, vec3(0.55, 1.0, 0.74), smoothstep(0.165, 0.5, lum));
    b = mix(b, vec3(0.96, 1.0, 0.97), smoothstep(0.55, 0.95, lum));
    col = b;
  }
  gl_FragColor = vec4(col * disc, disc);
}`;

export type AuroraPalette = 'night' | 'deep' | 'brand' | 'clean' | 'ink' | 'light';

export function mountAurora(canvas: HTMLCanvasElement, { palette = 'night' }: { palette?: AuroraPalette } = {}): () => void {
  const gl = canvas.getContext('webgl', { premultipliedAlpha: true, antialias: true, alpha: true });
  if (!gl) return () => {};
  const sh = (type: number, src: string): WebGLShader => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader error'); return s; };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const uT = gl.getUniformLocation(prog, 't');
  const uRes = gl.getUniformLocation(prog, 'res');
  gl.uniform1f(gl.getUniformLocation(prog, 'brand'), ({ night: 0, brand: 1, deep: 2, clean: 3, ink: 4, light: 5 } as const)[palette]);
  let raf = 0;
  const t0 = performance.now() - 20000 * Math.random();
  const frame = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, w, h);
    gl.uniform1f(uT, (performance.now() - t0) / 1000);
    gl.uniform2f(uRes, w, h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    raf = requestAnimationFrame(frame);
  };
  frame();
  return () => cancelAnimationFrame(raf);
}

// Living waves around the button: a soft, translucent green glow that grows out of the
// circle's own edge and slowly ripples, the way voice/AI assistants show they are alive.
// 'one': a single wide wave. 'two': two waves drifting against each other. Canvas 2D.
// The canvas should be larger than the button (the button sits in its middle 64%).
export type WaveVariant = 'one' | 'two';
interface WaveLayer { k: number[]; a: number[]; s: number[]; reach: number; fill: number; line: number }

export function mountWaves(canvas: HTMLCanvasElement, { variant = 'two', tone = 'glow' }: { variant?: WaveVariant; tone?: 'glow' | 'light' } = {}): () => void {
  const onLight = tone === 'light';
  const ctx = canvas.getContext('2d');
  if (!ctx) return () => {};
  const ONE: WaveLayer[] = [
    { k: [2, 3, 5], a: [0.05, 0.03, 0.012], s: [0.45, -0.6, 0.9], reach: 0.16, fill: 0.30, line: 0.55 }
  ];
  const TWO: WaveLayer[] = [
    { k: [2, 4, 6], a: [0.045, 0.025, 0.01], s: [0.5, -0.7, 1.0], reach: 0.15, fill: 0.24, line: 0.5 },
    { k: [3, 5, 7], a: [0.04, 0.022, 0.009], s: [-0.4, 0.6, -0.9], reach: 0.11, fill: 0.20, line: 0.4 }
  ];
  const layers = variant === 'one' ? ONE : TWO;
  let raf = 0;
  const t0 = performance.now();
  const frame = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(canvas.clientWidth * dpr), H = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    const t = (performance.now() - t0) / 1000;
    const cx = W / 2, cy = H / 2;
    const R = Math.min(W, H) * 0.32;                       // the button's radius
    ctx.clearRect(0, 0, W, H);
    layers.forEach((L, li) => {
      // outline of the wave: starts right at the circle and ripples outward
      const N = 180;
      const pts: [number, number][] = [];
      for (let i = 0; i <= N; i++) {
        const th = (i / N) * Math.PI * 2;
        let r = 1 + L.reach * (0.55 + 0.45 * Math.sin(t * 0.8 + li * 2.4));
        for (let j = 0; j < 3; j++) r += L.a[j] * Math.sin(L.k[j] * th + t * L.s[j] + li * 1.7);
        pts.push([cx + Math.cos(th) * R * r, cy + Math.sin(th) * R * r]);
      }
      const wave = new Path2D();
      pts.forEach(([x, y], i) => (i ? wave.lineTo(x, y) : wave.moveTo(x, y)));
      wave.closePath();
      // translucent body between the circle and the wave, fading outward
      const ring = new Path2D(wave);
      ring.arc(cx, cy, R * 0.98, 0, Math.PI * 2, true);
      const g = ctx.createRadialGradient(cx, cy, R * 0.98, cx, cy, R * (1 + L.reach + 0.12));
      g.addColorStop(0, onLight ? `rgba(0, 170, 79, ${L.fill * 1.5})` : `rgba(29, 227, 165, ${L.fill})`);
      g.addColorStop(0.55, onLight ? `rgba(8, 115, 57, ${L.fill * 0.6})` : `rgba(0, 170, 79, ${L.fill * 0.55})`);
      g.addColorStop(1, 'rgba(0, 170, 79, 0)');
      ctx.fillStyle = g;
      ctx.fill(ring, 'evenodd');
      // a soft edge line that drifts in colour around the circle
      const c = typeof ctx.createConicGradient === 'function' ? ctx.createConicGradient(t * 0.25 * (li ? -1 : 1), cx, cy) : null;
      if (c) {
        const stops: [number, string][] = onLight
          ? [[0, 'rgba(8, 115, 57, .9)'], [0.33, 'rgba(11, 184, 90, .45)'], [0.66, 'rgba(8, 115, 57, .8)'], [1, 'rgba(8, 115, 57, .9)']]
          : [[0, 'rgba(93, 255, 174, .9)'], [0.33, 'rgba(0, 170, 79, .5)'], [0.66, 'rgba(122, 255, 196, .85)'], [1, 'rgba(93, 255, 174, .9)']];
        stops.forEach(([o, col]) => c.addColorStop(o, col));
      }
      ctx.strokeStyle = c ?? 'rgba(93, 255, 174, .7)';
      ctx.globalAlpha = onLight ? Math.min(1, L.line * 1.5) : L.line;
      ctx.lineWidth = Math.max(1, R * 0.03);
      ctx.shadowColor = onLight ? 'rgba(8, 115, 57, .3)' : 'rgba(45, 255, 168, .6)';
      ctx.shadowBlur = R * 0.12;
      ctx.stroke(wave);
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
    });
    raf = requestAnimationFrame(frame);
  };
  frame();
  return () => cancelAnimationFrame(raf);
}
