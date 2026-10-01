/** Settings page: graphics, audio, controls and interface options (AppContext.updateSettings). */
import type { AppSettings } from '../../core/app';
import type { UIContext } from '../context';
import { h, setText } from '../dom';
import { Segmented, Toggle } from '../widgets';

interface Slider {
  el: HTMLElement;
  input: HTMLInputElement;
  value: HTMLElement;
}

export class SettingsPage {
  readonly el: HTMLElement;
  private shadows: Toggle;
  private quality: Segmented<AppSettings['quality']>;
  private fpsCap: Segmented<AppSettings['fpsCap']>;
  private edge: Toggle;
  private autosave: Toggle;
  private fps: Toggle;
  private sliders: Record<'masterVolume' | 'sfxVolume' | 'ambientVolume', Slider>;

  constructor(private readonly ui: UIContext) {
    const set = (patch: Partial<AppSettings>) => this.ui.app.updateSettings(patch);
    this.shadows = new Toggle('Shadows', (on) => set({ shadows: on }), { desc: 'Soft sun shadows. Turn off for more speed.' });
    this.quality = new Segmented<AppSettings['quality']>([
      { id: 'auto', label: 'Auto', tip: 'Picks a level for your graphics chip and lowers the resolution a little when frames get slow.' },
      { id: 'high', label: 'High' }, { id: 'medium', label: 'Medium' },
      { id: 'low', label: 'Low', tip: 'Lowest detail, no shadows. Anti-aliasing turns off after a reload.' },
    ], (id) => {
      set({ quality: id });
      this.quality.set(id);
    }, { label: 'Graphics quality' });
    this.fpsCap = new Segmented<AppSettings['fpsCap']>([
      { id: 30, label: '30' }, { id: 60, label: '60' }, { id: 0, label: 'Unlimited', tip: 'Match the display refresh rate (uses more power).' },
    ], (id) => {
      set({ fpsCap: id });
      this.fpsCap.set(id);
    }, { label: 'Frame rate limit' });
    this.edge = new Toggle('Edge scrolling', (on) => set({ edgeScroll: on }), { desc: 'Move the camera when the pointer touches the screen edge.' });
    this.autosave = new Toggle('Autosave', (on) => set({ autosave: on }), { desc: 'Save automatically at the start of every year.' });
    this.fps = new Toggle('Show FPS', (on) => set({ showFps: on }), { desc: 'Display the frame rate, render scale, draw calls and triangles in the corner.' });
    const slider = (key: 'masterVolume' | 'sfxVolume' | 'ambientVolume', label: string): Slider => {
      const value = h('span', { class: 'slider-v' });
      const input = h('input', {
        class: 'slider', type: 'range', min: '0', max: '100', step: '1', 'aria-label': label,
        oninput: () => {
          setText(value, `${input.value}%`);
          set({ [key]: Number(input.value) / 100 } as Partial<AppSettings>);
        },
      });
      return { el: h('div', { class: 'field' }, h('label', { class: 'field-l' }, label), h('div', { class: 'field-c slider-row' }, input, value)), input, value };
    };
    this.sliders = {
      masterVolume: slider('masterVolume', 'Master volume'),
      sfxVolume: slider('sfxVolume', 'Effects'),
      ambientVolume: slider('ambientVolume', 'Ambience'),
    };
    const group = (title: string, ...children: Node[]) => h('div', { class: 'set-group' }, h('h4', { class: 'sec-h' }, title), ...children);
    this.el = h('div', { class: 'menu-page settings' },
      h('h2', { class: 'menu-h' }, 'Settings'),
      group('Graphics',
        h('div', { class: 'field' }, h('label', { class: 'field-l' }, 'Quality'), h('div', { class: 'field-c' }, this.quality.el)),
        h('div', { class: 'field' }, h('label', { class: 'field-l' }, 'Frame rate'), h('div', { class: 'field-c' }, this.fpsCap.el)),
        this.shadows.el, this.fps.el),
      group('Audio', this.sliders.masterVolume.el, this.sliders.sfxVolume.el, this.sliders.ambientVolume.el),
      group('Game', this.edge.el, this.autosave.el));
    this.sync(ui.app.settings);
  }

  sync(s: AppSettings): void {
    this.shadows.set(s.shadows);
    this.quality.set(s.quality);
    this.fpsCap.set(s.fpsCap ?? 60);
    this.edge.set(s.edgeScroll);
    this.autosave.set(s.autosave);
    this.fps.set(s.showFps);
    for (const k of ['masterVolume', 'sfxVolume', 'ambientVolume'] as const) {
      const sl = this.sliders[k];
      const v = String(Math.round((s[k] ?? 0) * 100));
      if (document.activeElement !== sl.input && sl.input.value !== v) sl.input.value = v;
      setText(sl.value, `${sl.input.value}%`);
    }
  }
}
