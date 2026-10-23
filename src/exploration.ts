import type * as THREE from 'three';
import { WORLDS } from './worlds';

const storageKey = 'anime-worlds-discoveries-v1';

export class ExplorationUI {
  private readonly toolbar = document.querySelector<HTMLElement>('#world-toolbar')!;
  private readonly markers = document.querySelector<HTMLElement>('#landmark-markers')!;
  private readonly dialog = document.querySelector<HTMLDialogElement>('#explore-dialog')!;
  private readonly entries = document.querySelector<HTMLElement>('#explore-entries')!;
  private readonly action = document.querySelector<HTMLButtonElement>('#world-action')!;
  private readonly notes = document.querySelector<HTMLButtonElement>('#explore-toggle')!;
  private readonly cinema = document.querySelector<HTMLButtonElement>('#cinema-toggle')!;
  private discovered = new Set<string>();
  private world = -1;

  constructor(onAction: () => void, onCinematic: () => void) {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
      if (Array.isArray(saved)) this.discovered = new Set(saved.filter((id): id is string => typeof id === 'string'));
    } catch { /* Private browsing or denied storage must not block exploration. */ }
    this.action.addEventListener('click', onAction);
    this.cinema.addEventListener('click', onCinematic);
    this.notes.addEventListener('click', () => this.openNotes());
    document.querySelector('#explore-close')!.addEventListener('click', () => this.dialog.close());
    this.dialog.addEventListener('click', (event) => {
      const rect = this.dialog.getBoundingClientRect();
      if (event.target === this.dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) this.dialog.close();
    });
  }

  get dialogOpen() { return this.dialog.open; }

  enter(world: number) {
    this.world = world;
    this.toolbar.hidden = this.markers.hidden = false;
    this.markers.replaceChildren();
    WORLDS[world].landmarks.forEach((landmark, index) => {
      const marker = document.createElement('button');
      marker.type = 'button';
      marker.className = 'landmark-marker';
      marker.setAttribute('aria-label', `สำรวจ ${landmark.title}`);
      marker.innerHTML = `<span class="marker-number">${String(index + 1).padStart(2, '0')}</span><span class="marker-label"></span>`;
      marker.querySelector('.marker-label')!.textContent = landmark.title;
      marker.addEventListener('click', () => this.openNotes(index));
      this.markers.append(marker);
    });
    this.setActionBusy(false);
    this.updateProgress();
  }

  leave() {
    if (this.dialog.open) this.dialog.close();
    this.world = -1;
    this.toolbar.hidden = this.markers.hidden = true;
    this.markers.replaceChildren();
  }

  fitMarkers(texture: THREE.Texture) {
    if (this.world < 0) return;
    const nodes = [...this.markers.querySelectorAll<HTMLButtonElement>('button')];
    const panel = document.querySelector('#world-panel')!.getBoundingClientRect();
    WORLDS[this.world].landmarks.forEach((landmark, index) => {
      const x = (landmark.point[0] - texture.offset.x) / texture.repeat.x;
      const y = (landmark.point[1] - (1 - texture.offset.y - texture.repeat.y)) / texture.repeat.y;
      const marker = nodes[index];
      const px = x * window.innerWidth;
      const py = y * window.innerHeight;
      const overPanel = px > panel.left - 24 && px < panel.right + 24 && py > panel.top - 24 && py < panel.bottom + 24;
      marker.hidden = x < 0.04 || x > 0.96 || y < 0.1 || y > 0.83 || overPanel;
      marker.style.left = `${x * 100}%`;
      marker.style.top = `${y * 100}%`;
    });
  }

  setCinematic(enabled: boolean) {
    this.cinema.setAttribute('aria-pressed', String(enabled));
    this.cinema.textContent = enabled ? 'แสดง UI · C' : 'ชมภาพ · C';
    this.action.hidden = this.notes.hidden = enabled;
    this.markers.inert = enabled;
  }

  setActionBusy(busy: boolean) {
    this.action.disabled = busy;
    this.action.textContent = busy ? 'กำลังแสดง…' : this.world >= 0 ? WORLDS[this.world].action : 'เล่นเอฟเฟกต์';
  }

  private openNotes(selected?: number) {
    if (this.world < 0) return;
    const world = WORLDS[this.world];
    if (selected !== undefined) this.discover(selected);
    document.querySelector('#explore-title')!.textContent = world.title;
    this.entries.replaceChildren();
    world.landmarks.forEach((landmark, index) => {
      const article = document.createElement('article');
      const button = document.createElement('button');
      button.className = 'note-choice';
      button.type = 'button';
      button.textContent = `${String(index + 1).padStart(2, '0')}  ${landmark.title}`;
      button.setAttribute('aria-pressed', String(this.discovered.has(`${this.world}:${landmark.id}`)));
      const description = document.createElement('p');
      description.textContent = landmark.description;
      button.addEventListener('click', () => {
        this.discover(index);
        button.setAttribute('aria-pressed', 'true');
      });
      article.append(button, description);
      this.entries.append(article);
    });
    if (!this.dialog.open) this.dialog.showModal();
  }

  private discover(index: number) {
    this.discovered.add(`${this.world}:${WORLDS[this.world].landmarks[index].id}`);
    try { localStorage.setItem(storageKey, JSON.stringify([...this.discovered])); } catch { /* Session-only progress is still useful. */ }
    this.updateProgress();
  }

  private updateProgress() {
    if (this.world < 0) return;
    let count = 0;
    WORLDS[this.world].landmarks.forEach((landmark, index) => {
      const found = this.discovered.has(`${this.world}:${landmark.id}`);
      if (found) count++;
      this.markers.querySelectorAll('button')[index]?.classList.toggle('is-discovered', found);
    });
    const label = `สำรวจ ${count}/${WORLDS[this.world].landmarks.length}`;
    this.notes.textContent = label;
    document.querySelector('#explore-progress')!.textContent = `${label} · แตะชื่อจุดเพื่อบันทึกการค้นพบ`;
  }
}
