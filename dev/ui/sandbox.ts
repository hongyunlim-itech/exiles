/**
 * UI sandbox: mounts the real UIManager on a mock AppContext + fake Game so every panel/window/dialog/menu can be
 * opened without the renderer or simulation. Scenes via ?scene=... (see SCENES) — used by dev/ui/shoot.mjs.
 */
import { DEFAULT_SETTINGS, type AppContext, type AppEvents, type AppSettings, type SaveSlotInfo, type Selection, type Tool } from '../../src/core/app';
import { EventBus } from '../../src/core/events';
import type { GameSpeed, NewGameSettings } from '../../src/core/types';
import { UIManager } from '../../src/ui/ui';
import { overrideSimBridge } from '../../src/ui/sim-bridge';
import { MockGame, asGame } from './mockgame';

// ---- painted backdrop so panels are judged against something scene-like ----
function paintScene(): void {
  const c = document.getElementById('scene') as HTMLCanvasElement;
  const w = (c.width = innerWidth);
  const h = (c.height = innerHeight);
  const g = c.getContext('2d')!;
  const sky = g.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#8fa9b4');
  sky.addColorStop(0.22, '#a9b7a0');
  sky.addColorStop(0.3, '#6f8f45');
  sky.addColorStop(1, '#4f6a33');
  g.fillStyle = sky;
  g.fillRect(0, 0, w, h);
  let s = 7;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 900; i++) {
    const x = r() * w;
    const y = h * 0.3 + r() * h * 0.7;
    const sz = 4 + r() * 10 * (y / h);
    g.fillStyle = r() > 0.5 ? '#3d5a2a' : '#2f4a22';
    g.beginPath();
    g.moveTo(x, y - sz * 2.2);
    g.lineTo(x - sz, y);
    g.lineTo(x + sz, y);
    g.fill();
  }
  g.fillStyle = '#4f7f86';
  g.beginPath();
  g.ellipse(w * 0.62, h * 0.62, w * 0.18, h * 0.07, -0.2, 0, Math.PI * 2);
  g.fill();
  for (let i = 0; i < 14; i++) {
    const x = w * 0.3 + (i % 5) * 60 + r() * 20;
    const y = h * 0.45 + Math.floor(i / 5) * 60;
    g.fillStyle = '#d8cfb8';
    g.fillRect(x, y, 34, 22);
    g.fillStyle = '#9c7d45';
    g.beginPath();
    g.moveTo(x - 4, y);
    g.lineTo(x + 17, y - 16);
    g.lineTo(x + 38, y);
    g.fill();
  }
}
paintScene();

// ---- mock app ----
const mock = new MockGame();
const saves: SaveSlotInfo[] = [
  { slot: 'autosave', townName: 'Hollowmere', year: 5, month: 0, population: 41, savedAt: Date.now() - 1000 * 60 * 12 },
  { slot: 'Hollowmere', townName: 'Hollowmere', year: 4, month: 8, population: 38, savedAt: Date.now() - 1000 * 60 * 60 * 5 },
  { slot: 'Ashford winter', townName: 'Ashford', year: 12, month: 10, population: 164, savedAt: Date.now() - 1000 * 60 * 60 * 24 * 3 },
];

class MockApp implements Partial<AppContext> {
  game = asGame(mock);
  readonly events = new EventBus<AppEvents>();
  settings: AppSettings = { ...DEFAULT_SETTINGS, showFps: true };
  selection: Selection = null;
  inMenu = false;
  ui!: UIManager;
  input = { tool: { kind: 'select' } as Tool };
  audio = { playUi: (cue: string) => console.debug('[sfx]', cue) };
  renderer = {};

  newGame(s: NewGameSettings): void {
    console.log('[app] newGame', s);
    mock.state.settings = s;
    this.ui.onGameChanged();
    this.closeMenu();
  }
  saveGame(slot: string): boolean {
    saves.push({ slot, townName: mock.state.settings.townName, year: 5, month: 7, population: mock.state.citizens.length, savedAt: Date.now() });
    return true;
  }
  loadGame(slot: string): boolean {
    console.log('[app] load', slot);
    this.closeMenu();
    return true;
  }
  listSaves(): SaveSlotInfo[] {
    return saves.slice().sort((a, b) => b.savedAt - a.savedAt);
  }
  deleteSave(slot: string): void {
    const i = saves.findIndex((s) => s.slot === slot);
    if (i >= 0) saves.splice(i, 1);
  }
  setTool(tool: Tool): void {
    this.input.tool = tool;
    this.events.emit('toolChanged', { tool });
  }
  select(sel: Selection): void {
    this.selection = sel;
    this.events.emit('selectionChanged', { selection: sel });
  }
  setSpeed(speed: GameSpeed): void {
    mock.speed = speed;
    this.events.emit('speedChanged', { speed });
  }
  focusOn(x: number, z: number): void {
    console.debug('[app] focusOn', x.toFixed(1), z.toFixed(1));
  }
  updateSettings(patch: Partial<AppSettings>): void {
    this.settings = { ...this.settings, ...patch };
    this.events.emit('settingsChanged', { settings: this.settings });
  }
  openMenu(): void {
    this.inMenu = true;
    this.ui.showMainMenu(true);
  }
  closeMenu(): void {
    this.inMenu = false;
    this.ui.hideMainMenu();
  }
}

overrideSimBridge({
  happinessFactors: (_g, c) => [
    { label: 'Base', value: 50 },
    { label: 'Chapel nearby', value: 15 },
    { label: 'Varied diet', value: 7.5 },
    { label: 'Has a coat', value: c.coatWear > 0 ? 5 : 0 },
    { label: 'Grief', value: -c.grief * 0.3 },
    { label: 'No tavern', value: 0 },
  ].filter((f) => f.value !== 0),
  healthFactors: (_g, c) => [
    { label: 'Base', value: 70 },
    { label: 'Diet variety (3 groups)', value: 10 },
    { label: 'Herbs at home', value: 8 },
    { label: 'Well nearby', value: 5 },
    ...(c.age >= 60 ? [{ label: 'Elderly', value: -10 }] : []),
    ...(c.sick > 0 ? [{ label: 'Sick', value: -22 }] : []),
  ],
});

const app = new MockApp();
const ui = new UIManager(document.getElementById('ui')!, app as unknown as AppContext);
app.ui = ui;
Object.assign(window, { __app: app, __ui: ui, __game: mock });

let last = performance.now();
function frame(now: number): void {
  ui.update(Math.min(0.1, (now - last) / 1000));
  last = now;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---- scenes ----
const params = new URLSearchParams(location.search);
const scene = params.get('scene') ?? 'game';
const b = (type: string) => mock.state.buildings.find((x) => x.type === type)!;
if (scene !== 'nomads' && scene !== 'game') mock.state.nomads = null;

function run(): void {
  switch (scene) {
    case 'title':
      app.inMenu = true;
      ui.showMainMenu(false);
      break;
    case 'pause':
      app.openMenu();
      break;
    case 'newgame':
      app.inMenu = true;
      ui.showMainMenu(false);
      (document.querySelectorAll('.menu-btn')[3] as HTMLButtonElement).click();
      break;
    case 'load':
      app.inMenu = true;
      ui.showMainMenu(false);
      (document.querySelectorAll('.menu-btn')[4] as HTMLButtonElement).click();
      break;
    case 'save':
      app.openMenu();
      (document.querySelectorAll('.menu-btn')[2] as HTMLButtonElement).click();
      break;
    case 'settings':
      app.openMenu();
      (document.querySelectorAll('.menu-btn')[5] as HTMLButtonElement).click();
      break;
    case 'controls':
      app.openMenu();
      (document.querySelectorAll('.menu-btn')[6] as HTMLButtonElement).click();
      break;
    case 'house':
      app.select({ kind: 'building', id: b('woodenHouse').id });
      break;
    case 'field':
      app.select({ kind: 'building', id: b('cropField').id });
      break;
    case 'workshop':
      app.select({ kind: 'building', id: b('tailor').id });
      break;
    case 'construction':
      app.select({ kind: 'building', id: mock.state.buildings.find((x) => x.state === 'construction')!.id });
      break;
    case 'clearing':
      app.select({ kind: 'building', id: b('boardingHouse').id });
      break;
    case 'storage':
      app.select({ kind: 'building', id: b('storageBarn').id });
      break;
    case 'stockpile':
      app.select({ kind: 'building', id: b('stockpile').id });
      break;
    case 'pasture':
      app.select({ kind: 'building', id: b('pasture').id });
      break;
    case 'orchard':
      app.select({ kind: 'building', id: b('orchard').id });
      break;
    case 'fire':
      app.select({ kind: 'building', id: b('hunterCabin').id });
      break;
    case 'post':
      app.select({ kind: 'building', id: b('tradingPost').id });
      break;
    case 'cemetery':
      app.select({ kind: 'building', id: b('cemetery').id });
      break;
    case 'ruin':
      app.select({ kind: 'building', id: b('brewery').id });
      break;
    case 'gatherer':
      app.select({ kind: 'building', id: b('gathererHut').id });
      break;
    case 'citizen':
      app.select({ kind: 'citizen', id: mock.state.citizens[0].id });
      break;
    case 'elder':
      app.select({ kind: 'citizen', id: mock.state.citizens.find((c) => c.sick > 0)!.id });
      break;
    case 'professions':
    case 'overview':
    case 'citizens':
    case 'log':
    case 'stats':
    case 'trade':
    case 'nomads':
    case 'help':
      ui.openWindow(scene);
      break;
    case 'flyout':
      (document.querySelectorAll('.tool-btn')[Number(params.get('i') ?? 4)] as HTMLButtonElement).click();
      break;
    case 'tool':
      app.setTool({ kind: 'build', type: 'woodenHouse' });
      break;
    case 'confirm':
      app.select({ kind: 'building', id: b('woodenHouse').id });
      void ui.confirm('Demolish this Wooden House? Half of its materials will be returned. 4 residents will lose their home.', 'Demolish', { danger: true, title: 'Demolish' });
      break;
    case 'gameover':
      mock.state.gameOver = true;
      break;
    case 'toasts':
      mock.addMessage('A child was born: Edith Marsh.', 'good', { kind: 'citizen', id: mock.state.citizens[4].id });
      mock.addMessage('Firewood is running low before winter!', 'warning');
      mock.addMessage('Fire! The Hunting Cabin is burning!', 'danger', { kind: 'building', id: b('hunterCabin').id });
      mock.addMessage('Autumn has arrived.', 'info');
      mock.addMessage('Autumn has arrived.', 'info');
      break;
    case 'hover':
      app.events.emit('hoverInfo', { text: 'Grass\nTree (mature, 4 logs)\nMarked for clearing' });
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 700, clientY: 420 }));
      break;
    case 'game':
    default:
      break;
  }
  if (params.get('paused')) app.setSpeed(0);
}
setTimeout(run, 50);
