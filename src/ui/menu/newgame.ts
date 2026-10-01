/** New Game form: town name, seed (with dice), map size, terrain, climate, difficulty, disasters. */
import type { Climate, Difficulty, MapSize, NewGameSettings, TerrainStyle } from '../../core/types';
import { h, setText } from '../dom';
import { CLIMATE_INFO, DIFFICULTY_INFO, ICON, MAP_SIZE_INFO, TERRAIN_INFO } from '../icons';
import { Segmented, Toggle } from '../widgets';

const LAST_KEY = 'exiles.ui.lastNewGame';

const TOWN_NAMES = [
  'Hollowmere', 'Ashford', 'Wrenfield', 'Stonebrook', 'Eldermoor', 'Thornwick', 'Greywater', 'Oakhaven', 'Millbrook',
  'Frostvale', 'Briarwood', 'Ravenhold', 'Kettleby', 'Marrowdale', 'Coldharbour', 'Fernhollow', 'Duskmere', 'Harrowgate',
];

export function randomSeed(): number {
  return Math.floor(Math.random() * 1e9);
}

function loadLast(): Partial<NewGameSettings> {
  try {
    return JSON.parse(localStorage.getItem(LAST_KEY) ?? '{}') as Partial<NewGameSettings>;
  } catch {
    return {};
  }
}

function saveLast(s: NewGameSettings): void {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify({ ...s, seed: undefined }));
  } catch {
    /* ignore */
  }
}

export class NewGameForm {
  readonly el: HTMLElement;
  private name: HTMLInputElement;
  private seed: HTMLInputElement;
  private size: Segmented<MapSize>;
  private terrain: Segmented<TerrainStyle>;
  private climate: Segmented<Climate>;
  private difficulty: Segmented<Difficulty>;
  private disasters: Toggle;
  private settings: NewGameSettings;
  private terrainDesc: HTMLElement;
  private climateDesc: HTMLElement;
  private diffDesc: HTMLElement;

  constructor(private readonly onStart: (s: NewGameSettings) => void) {
    const last = loadLast();
    this.settings = {
      seed: randomSeed(),
      townName: last.townName || TOWN_NAMES[Math.floor(Math.random() * TOWN_NAMES.length)],
      mapSize: last.mapSize ?? 'medium',
      terrain: last.terrain ?? 'valleys',
      climate: last.climate ?? 'fair',
      difficulty: last.difficulty ?? 'medium',
      disasters: last.disasters ?? true,
    };
    const s = this.settings;

    this.name = h('input', {
      class: 'input', type: 'text', maxlength: '24', value: s.townName, 'aria-label': 'Town name', spellcheck: 'false', autocomplete: 'off',
      oninput: () => (this.settings.townName = this.name.value),
    });
    const nameDice = h('button', {
      class: 'ibtn', type: 'button', 'aria-label': 'Random town name', tip: 'Random name',
      onclick: () => {
        const n = TOWN_NAMES[Math.floor(Math.random() * TOWN_NAMES.length)];
        this.name.value = n;
        this.settings.townName = n;
      },
    }, ICON.dice);
    this.seed = h('input', {
      class: 'input mono', type: 'text', inputmode: 'numeric', value: String(s.seed), 'aria-label': 'World seed', maxlength: '10',
      oninput: () => {
        const v = this.seed.value.replace(/[^0-9]/g, '');
        if (v !== this.seed.value) this.seed.value = v;
        this.settings.seed = Number(v) || 0;
      },
    });
    const seedDice = h('button', {
      class: 'ibtn', type: 'button', 'aria-label': 'Random seed', tip: 'Roll a new world',
      onclick: () => {
        this.settings.seed = randomSeed();
        this.seed.value = String(this.settings.seed);
      },
    }, ICON.dice);

    this.size = new Segmented<MapSize>((['small', 'medium', 'large'] as MapSize[]).map((id) => ({ id, label: MAP_SIZE_INFO[id].name, tip: MAP_SIZE_INFO[id].desc })), (id) => {
      this.settings.mapSize = id;
      this.size.set(id);
    }, { label: 'Map size' });
    this.terrainDesc = h('div', { class: 'field-desc' });
    this.terrain = new Segmented<TerrainStyle>((['valleys', 'mountains', 'lakes'] as TerrainStyle[]).map((id) => ({ id, label: TERRAIN_INFO[id].name, icon: TERRAIN_INFO[id].icon })), (id) => {
      this.settings.terrain = id;
      this.syncDescs();
    }, { label: 'Terrain' });
    this.climateDesc = h('div', { class: 'field-desc' });
    this.climate = new Segmented<Climate>((['mild', 'fair', 'harsh'] as Climate[]).map((id) => ({ id, label: CLIMATE_INFO[id].name, icon: CLIMATE_INFO[id].icon })), (id) => {
      this.settings.climate = id;
      this.syncDescs();
    }, { label: 'Climate' });
    this.diffDesc = h('div', { class: 'field-desc' });
    this.difficulty = new Segmented<Difficulty>((['easy', 'medium', 'hard'] as Difficulty[]).map((id) => ({ id, label: DIFFICULTY_INFO[id].name })), (id) => {
      this.settings.difficulty = id;
      this.syncDescs();
    }, { label: 'Difficulty' });
    this.disasters = new Toggle('Disasters', (on) => (this.settings.disasters = on), { desc: 'Fires, tornadoes and disease outbreaks.' });

    const field = (label: string, ...ctl: (Node | null)[]) => h('div', { class: 'field' }, h('label', { class: 'field-l' }, label), h('div', { class: 'field-c' }, ...ctl));
    const form = h('form', {
      class: 'ng-form', autocomplete: 'off',
      onsubmit: (e: Event) => {
        e.preventDefault();
        this.start();
      },
    },
    field('Town name', h('div', { class: 'input-row' }, this.name, nameDice)),
    field('World seed', h('div', { class: 'input-row' }, this.seed, seedDice)),
    field('Map size', this.size.el),
    field('Terrain', this.terrain.el, this.terrainDesc),
    field('Climate', this.climate.el, this.climateDesc),
    field('Difficulty', this.difficulty.el, this.diffDesc),
    field('', this.disasters.el),
    h('div', { class: 'ng-actions' }, h('button', { class: 'btn primary big', type: 'submit' }, 'Begin the journey')));
    this.el = h('div', { class: 'menu-page ng' }, h('h2', { class: 'menu-h' }, 'New Settlement'), form);
    this.syncAll();
  }

  private syncAll(): void {
    const s = this.settings;
    this.size.set(s.mapSize);
    this.disasters.set(s.disasters);
    this.syncDescs();
  }

  private syncDescs(): void {
    const s = this.settings;
    this.terrain.set(s.terrain);
    this.climate.set(s.climate);
    this.difficulty.set(s.difficulty);
    setText(this.terrainDesc, TERRAIN_INFO[s.terrain].desc);
    setText(this.climateDesc, CLIMATE_INFO[s.climate].desc);
    setText(this.diffDesc, DIFFICULTY_INFO[s.difficulty].desc);
  }

  /** Re-roll the seed each time the form is shown. */
  reset(): void {
    this.settings.seed = randomSeed();
    this.seed.value = String(this.settings.seed);
  }

  focus(): void {
    this.name.focus();
    this.name.select();
  }

  private start(): void {
    const s = { ...this.settings };
    s.townName = s.townName.trim().slice(0, 24) || 'Hollowmere';
    s.seed = Math.floor(Math.abs(Number(s.seed) || 0)) % 4294967296;
    saveLast(s);
    this.onStart(s);
  }
}
