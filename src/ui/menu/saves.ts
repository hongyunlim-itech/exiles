/** Load and Save pages of the main menu (save slots from AppContext.listSaves). */
import type { SaveSlotInfo } from '../../core/app';
import type { UIContext } from '../context';
import { h, setText } from '../dom';
import { fmtInt, fmtRelTime, monthName } from '../format';
import { ICON } from '../icons';

function slotRow(main: HTMLElement, ...actions: HTMLElement[]): HTMLElement {
  return h('div', { class: 'save-row' },
    main,
    h('div', { class: 'save-actions' }, ...actions));
}

function slotMain(info: SaveSlotInfo, onClick?: () => void): HTMLElement {
  const content = [
    h('span', { class: 'save-name' }, info.townName, info.slot === 'autosave' ? h('span', { class: 'tag' }, 'autosave') : info.slot !== info.townName ? h('span', { class: 'tag dim' }, info.slot) : null),
    h('span', { class: 'save-meta' }, `Year ${info.year}, ${monthName(info.month)} · ${fmtInt(info.population)} people · ${fmtRelTime(info.savedAt)}`),
  ];
  return onClick
    ? h('button', { class: 'save-main', type: 'button', onclick: onClick }, ...content)
    : h('div', { class: 'save-main' }, ...content);
}

export class LoadPage {
  readonly el: HTMLElement;
  private list: HTMLElement;

  constructor(private readonly ui: UIContext, private readonly onLoad: (slot: string) => void) {
    this.list = h('div', { class: 'save-list' });
    this.el = h('div', { class: 'menu-page' }, h('h2', { class: 'menu-h' }, 'Load Game'), this.list);
  }

  render(): void {
    const saves = this.ui.app.listSaves();
    this.list.replaceChildren();
    if (!saves.length) {
      this.list.appendChild(h('p', { class: 'menu-empty' }, 'No saved settlements yet. Games are saved from the in-game menu, and autosaved every new year.'));
      return;
    }
    for (const s of saves) {
      const load = h('button', { class: 'btn small primary', type: 'button', onclick: () => this.onLoad(s.slot) }, 'Load');
      const del = h('button', {
        class: 'ibtn danger', type: 'button', 'aria-label': `Delete save ${s.townName}`, tip: 'Delete save',
        onclick: async () => {
          const ok = await this.ui.confirm(`Delete the save "${s.townName}" (${s.slot})? This cannot be undone.`, 'Delete', { danger: true, title: 'Delete save' });
          if (!ok) return;
          this.ui.app.deleteSave(s.slot);
          this.render();
        },
      }, ICON.trash);
      this.list.appendChild(slotRow(slotMain(s, () => this.onLoad(s.slot)), load, del));
    }
  }
}

export class SavePage {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private name: HTMLInputElement;
  private status: HTMLElement;

  constructor(private readonly ui: UIContext) {
    this.name = h('input', { class: 'input', type: 'text', maxlength: '32', 'aria-label': 'Save name', spellcheck: 'false', autocomplete: 'off' });
    this.status = h('div', { class: 'save-status', role: 'status' });
    const form = h('form', {
      class: 'input-row save-form',
      onsubmit: (e: Event) => {
        e.preventDefault();
        void this.save(this.name.value);
      },
    }, this.name, h('button', { class: 'btn primary', type: 'submit' }, `${ICON.save} Save`));
    this.list = h('div', { class: 'save-list' });
    this.el = h('div', { class: 'menu-page' }, h('h2', { class: 'menu-h' }, 'Save Game'),
      h('p', { class: 'menu-p' }, 'Name your save, or choose an existing one to overwrite it.'), form, this.status, this.list);
  }

  render(): void {
    const s = this.ui.game.state;
    this.name.value = s.settings.townName;
    setText(this.status, '');
    this.renderList();
  }

  focus(): void {
    this.name.focus();
    this.name.select();
  }

  private renderList(): void {
    const saves = this.ui.app.listSaves().filter((x) => x.slot !== 'autosave');
    this.list.replaceChildren();
    for (const s of saves) {
      const over = h('button', { class: 'btn small', type: 'button', onclick: () => void this.save(s.slot) }, 'Overwrite');
      this.list.appendChild(slotRow(slotMain(s, () => (this.name.value = s.slot)), over));
    }
  }

  private async save(raw: string): Promise<void> {
    const slot = raw.trim().replace(/[^\w\- ']/g, '').slice(0, 32) || this.ui.game.state.settings.townName;
    if (slot === 'autosave') {
      setText(this.status, 'That name is reserved for autosaves.');
      return;
    }
    const exists = this.ui.app.listSaves().some((x) => x.slot === slot);
    if (exists) {
      const ok = await this.ui.confirm(`Overwrite the save "${slot}"?`, 'Overwrite', { title: 'Overwrite save' });
      if (!ok) return;
    }
    if (this.ui.app.saveGame(slot)) {
      setText(this.status, `Saved as "${slot}".`);
      this.ui.toast(`Game saved: ${slot}`, 'good', { silent: true });
      this.renderList();
    } else setText(this.status, 'Saving failed — browser storage may be full.');
  }
}
