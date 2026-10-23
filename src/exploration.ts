import { WORLDS } from './worlds';
import { STORIES } from './immersive/catalog';
import { journal } from './journal';

export class ExplorationUI {
  private readonly toolbar = document.querySelector<HTMLElement>('#world-toolbar')!;
  private readonly markers = document.querySelector<HTMLElement>('#landmark-markers')!;
  private readonly dialog = document.querySelector<HTMLDialogElement>('#explore-dialog')!;
  private readonly entries = document.querySelector<HTMLElement>('#explore-entries')!;
  private readonly action = document.querySelector<HTMLButtonElement>('#world-action')!;
  private readonly notes = document.querySelector<HTMLButtonElement>('#explore-toggle')!;
  private readonly cinema = document.querySelector<HTMLButtonElement>('#cinema-toggle')!;
  private world = -1;
  private scene = 0;

  constructor(onAction: () => void, onCinematic: () => void, private onTravel: (scene: number) => void) {
    this.action.addEventListener('click',onAction);
    this.cinema.addEventListener('click',onCinematic);
    this.notes.addEventListener('click',()=>this.openNotes());
    document.querySelector('#explore-close')!.addEventListener('click',()=>this.dialog.close());
    this.dialog.addEventListener('click',event=>{const r=this.dialog.getBoundingClientRect();if(event.target===this.dialog&&(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom))this.dialog.close();});
    journal.addEventListener('change',()=>this.updateProgress());
  }
  get dialogOpen() { return this.dialog.open; }
  enter(world: number) {
    this.world=world;this.toolbar.hidden=this.markers.hidden=false;this.setScene(0);this.setActionBusy(false);
  }
  setScene(scene: number) {
    this.scene=scene;if(this.world<0)return;
    this.markers.replaceChildren(...STORIES[this.world][scene].landmarks.map((landmark,index)=>{
      const marker=document.createElement('button');marker.type='button';marker.className='landmark-marker';marker.setAttribute('aria-label',`สำรวจ ${landmark.title}`);
      marker.innerHTML=`<span class="marker-number">${String(index+1).padStart(2,'0')}</span><span class="marker-label"></span>`;
      marker.querySelector('.marker-label')!.textContent=landmark.title;
      marker.addEventListener('click',()=>{journal.discover(this.world,landmark.id);this.openNotes();});return marker;
    }));this.updateProgress();
  }
  leave() { if(this.dialog.open)this.dialog.close();this.world=-1;this.toolbar.hidden=this.markers.hidden=true;this.markers.replaceChildren(); }
  setCinematic(enabled: boolean) {
    this.cinema.setAttribute('aria-pressed',String(enabled));this.cinema.textContent=enabled?'แสดงเมนู · C':'ชมภาพ · C';this.action.hidden=this.notes.hidden=enabled;this.markers.inert=enabled;
    this.toolbar.querySelectorAll<HTMLElement>('[data-hide-cinema]').forEach(button=>{button.hidden=enabled;});
  }
  setActionBusy(busy: boolean) { this.action.disabled=busy;this.action.textContent=busy?'กำลังแสดง…':this.world>=0?WORLDS[this.world].action:'เล่นเอฟเฟกต์'; }
  private openNotes() {
    if(this.world<0)return;
    document.querySelector('#explore-title')!.textContent=WORLDS[this.world].title;
    this.entries.replaceChildren();
    STORIES[this.world].forEach((story,scene)=>{
      const section=document.createElement('section');section.className='journal-scene';
      const heading=document.createElement('div');heading.className='journal-scene-heading';
      const title=document.createElement('h3');title.textContent=`0${scene+1} / ${story.mood.split(' / ')[1]}`;
      const travel=document.createElement('button');travel.type='button';travel.className='journal-travel';travel.textContent=scene===this.scene?'กำลังสำรวจ':'ไปที่ซีนนี้';travel.disabled=scene===this.scene;
      travel.addEventListener('click',()=>{this.dialog.close();this.onTravel(scene);});heading.append(title,travel);section.append(heading);
      story.landmarks.forEach((landmark,index)=>{
        const article=document.createElement('article'),button=document.createElement('button'),description=document.createElement('p');
        button.className='note-choice';button.type='button';button.dataset.discovery=landmark.id;button.textContent=`0${index+1}  ${landmark.title}`;button.setAttribute('aria-pressed',String(journal.has(this.world,landmark.id)));
        description.textContent=landmark.description;button.addEventListener('click',()=>journal.discover(this.world,landmark.id));article.append(button,description);section.append(article);
      });this.entries.append(section);
    });this.updateProgress();if(!this.dialog.open)this.dialog.showModal();
  }
  private updateProgress() {
    if(this.world<0)return;
    const story=STORIES[this.world][this.scene];
    this.markers.querySelectorAll('button').forEach((marker,i)=>marker.classList.toggle('is-discovered',journal.has(this.world,story.landmarks[i].id)));
    this.entries.querySelectorAll<HTMLElement>('[data-discovery]').forEach(button=>button.setAttribute('aria-pressed',String(journal.has(this.world,button.dataset.discovery!))));
    const count=journal.count(this.world);this.notes.textContent=`สมุดสำรวจ ${count}/6`;
    document.querySelector('#explore-progress')!.textContent=`ค้นพบ ${count}/6 จุด · ซีนนี้ ${journal.count(this.world,this.scene)}/2 · บันทึกไว้บนอุปกรณ์`;
  }
}
