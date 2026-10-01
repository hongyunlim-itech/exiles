/**
 * Input/audio sandbox: real InputManager + AudioManager on a generated world with a minimal renderer and a fake
 * AppContext. Exposes window.__sb for Playwright-driven screenshots (dev/input/shoot.mjs).
 */
import { AudioManager } from '../../src/audio/audio';
import { DEFAULT_SETTINGS, type AppContext, type AppEvents, type Selection, type Tool } from '../../src/core/app';
import { EventBus } from '../../src/core/events';
import type { GameSpeed } from '../../src/core/types';
import { heightAt } from '../../src/core/world';
import { InputManager } from '../../src/input/input';
import { FakeGame } from './fakeGame';
import { SandboxRenderer } from './scene';

const game = new FakeGame();
const renderer = new SandboxRenderer(document.getElementById('app')!, game);
const hud = document.getElementById('hud')!;
const toasts = document.getElementById('toasts')!;
const log: string[] = [];

const ui = {
  isPointerOverUI: () => false,
  toast(text: string, severity = 'info') {
    log.push(`toast:${severity}:${text}`);
    const el = document.createElement('div');
    el.textContent = text;
    el.style.cssText = 'background:rgba(28,22,16,.9);padding:4px 8px;margin:4px;border:1px solid #c9a45c';
    toasts.appendChild(el);
    setTimeout(() => el.remove(), 2500);
  },
  confirm(message: string) {
    log.push(`confirm:${message}`);
    return Promise.resolve(true);
  },
  showMainMenu() {},
  hideMainMenu() {},
  update() {},
  onGameChanged() {},
  dispose() {},
};

const audio = new AudioManager();
const events = new EventBus<AppEvents>();
let hoverText: string | null = null;
events.on('hoverInfo', ({ text }) => { hoverText = text; });

const app = {
  game,
  renderer,
  ui,
  audio,
  events,
  settings: { ...DEFAULT_SETTINGS },
  selection: null as Selection,
  inMenu: false,
  input: undefined as unknown as InputManager,
  newGame() {},
  saveGame: () => true,
  loadGame: () => true,
  listSaves: () => [],
  deleteSave() {},
  setTool(tool: Tool) {
    app.input.setTool(tool);
    events.emit('toolChanged', { tool });
  },
  select(sel: Selection) {
    app.selection = sel;
    events.emit('selectionChanged', { selection: sel });
  },
  setSpeed(speed: GameSpeed) {
    game.speed = speed;
    events.emit('speedChanged', { speed });
  },
  focusOn(x: number, z: number) {
    renderer.focusOn(x, z);
  },
  updateSettings() {},
  openMenu() {
    log.push('openMenu');
  },
  closeMenu() {},
};

const input = new InputManager(app as unknown as AppContext, renderer.canvas);
app.input = input;
audio.attach(game as never);
window.addEventListener('pointerdown', () => audio.unlock());
window.addEventListener('resize', () => renderer.resize());

let last = performance.now();
let frozen = false;
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!frozen) step(dt);
  requestAnimationFrame(frame);
}
function step(dt: number): void {
  input.update(dt);
  renderer.render();
  const c = renderer.cameraController;
  audio.update(dt, c.target.x, c.target.z, c.distance);
  hud.textContent = `tool: ${JSON.stringify(input.tool)}  speed: ${game.speed}\nhover: ${hoverText ?? '-'}\nselection: ${JSON.stringify(app.selection)}`;
}
requestAnimationFrame(frame);

/** Screen position of a tile centre (for Playwright). */
function tileToScreen(x: number, z: number): { x: number; y: number } {
  const s = game.state;
  const p = renderer.worldToScreen(x + 0.5, heightAt(s, x + 0.5, z + 0.5), z + 0.5);
  return { x: p.x, y: p.y };
}

(window as unknown as Record<string, unknown>).__sb = {
  app, game, renderer, input, audio, log, tileToScreen,
  get hover() { return hoverText; },
  /** Stop the rAF loop (after one final frame) so headless screenshots don't compete with rendering. */
  freeze(on: boolean) {
    if (on) step(0.016);
    frozen = on;
  },
  ready: true,
};
