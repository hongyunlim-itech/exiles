/**
 * Integration sandbox: a real Game (sim-core) driven by the test bot for N years, rendered by the real GameRenderer,
 * to check building models against real placements (flattening, shore buildings, bridges, construction states).
 * URL: ?seed=123&years=2&size=small&terrain=valleys
 */
import { YEAR_SECONDS } from '../../src/core/constants';
import { GameRenderer } from '../../src/render/renderer';
import { Game } from '../../src/sim/game';
import { Bot } from '../../tests/simcore.bot';

const params = new URLSearchParams(location.search);
const game = Game.create({
  seed: Number(params.get('seed') ?? 4242),
  townName: 'Integration',
  mapSize: (params.get('size') as 'small') ?? 'small',
  terrain: (params.get('terrain') as 'valleys') ?? 'valleys',
  climate: 'fair',
  difficulty: 'easy',
  disasters: false,
});
const bot = new Bot(game);
const years = Number(params.get('years') ?? 1.5);
const steps = Math.round((years * YEAR_SECONDS) / 0.25);
const t0 = performance.now();
for (let i = 0; i < steps && !game.state.gameOver; i++) {
  game.step(0.25);
  if (i % 4 === 0) bot.tick();
}
const simMs = performance.now() - t0;
game.speed = 0;

const container = document.getElementById('app')!;
const renderer = new GameRenderer(container, game);
renderer.resize();
const cc = renderer.cameraController as unknown as { jumpTo(x: number, z: number, d?: number): void; yaw: number; pitch: number; goal: { yaw: number; pitch: number; distance: number } };

function townCenter(): [number, number] {
  const bs = game.state.buildings;
  if (!bs.length) return [game.state.W / 2, game.state.H / 2];
  let x = 0;
  let z = 0;
  for (const b of bs) {
    x += b.x + b.w / 2;
    z += b.z + b.h / 2;
  }
  return [x / bs.length, z / bs.length];
}

const api = {
  view(name: string) {
    const [tx, tz] = townCenter();
    const m = /^(?:b:(\w+)|town)(?::(-?[\d.]+))?(?::([\d.]+))?(?::([\d.]+))?$/.exec(name);
    if (!m) return false;
    let x = tx;
    let z = tz;
    let dist = 45;
    if (m[1]) {
      const b = game.state.buildings.find((bb) => bb.type === m[1]);
      if (!b) return false;
      x = b.x + b.w / 2;
      z = b.z + b.h / 2;
      dist = 14;
    }
    cc.goal.yaw = m[2] ? (Number(m[2]) * Math.PI) / 180 : 0.6;
    cc.goal.pitch = m[3] ? (Number(m[3]) * Math.PI) / 180 : 0.75;
    cc.jumpTo(x, z, m[4] ? Number(m[4]) : dist);
    return true;
  },
  setSnow(v: number) { game.state.weather.snow = v; },
  setDaylight(v: number) { game.state.time.dayTime = 0.25 + 0.25 * v; },
  highlight(t: string | null) {
    const b = t ? game.state.buildings.find((bb) => bb.type === t) : null;
    renderer.buildings.setHighlight(b ? b.id : null);
  },
  setFire() {},
  /** Render one frame and return it as a PNG data URL (avoids compositor screenshots of heavy WebGL pages). */
  capture(): string {
    renderer.render(0.016, 0);
    return renderer.canvas.toDataURL('image/png');
  },
  info() {
    const r = renderer.renderer.info.render;
    const types: Record<string, number> = {};
    for (const b of game.state.buildings) types[`${b.type}:${b.state}`] = (types[`${b.type}:${b.state}`] ?? 0) + 1;
    return { calls: r.calls, tris: r.triangles, buildings: game.state.buildings.length, pop: game.state.citizens.length, simMs: Math.round(simMs), types };
  },
};
(window as unknown as { __sandbox: typeof api }).__sandbox = api;
(window as unknown as { __game: Game }).__game = game;
api.view('town');

let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  renderer.render(dt, 0);
  document.getElementById('hud')!.textContent = `year ${game.state.time.year} pop ${game.state.citizens.length} buildings ${game.state.buildings.length}\ncalls ${renderer.renderer.info.render.calls} tris ${renderer.renderer.info.render.triangles} sim ${Math.round(simMs)}ms`;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
requestAnimationFrame(() => requestAnimationFrame(() => ((window as unknown as { __ready: boolean }).__ready = true)));
