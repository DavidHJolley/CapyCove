import { Minigame } from '../minigame.js';

// PLACEHOLDER: to be replaced with the full Summit Sprint sled racer.
export class SledGame extends Minigame {
  static id = 'sled';
  static name = 'Summit Sprint';

  mount(root) {
    super.mount(root);
    root.innerHTML = `
      <div class="mg-splash">
        <h1>Summit Sprint</h1>
        <p>Coming soon: placeholder run scores 10.</p>
        <button class="mg-btn" data-a="play">Ride</button>
        <button class="mg-btn ghost" data-a="quit">Leave</button>
      </div>`;
    root.querySelector('[data-a="quit"]').onclick = () => this.quit();
    root.querySelector('[data-a="play"]').onclick = () => {
      this.finish(10);
      this.exitToRoom();
    };
  }

  coinsForScore(s) { return s; }
}
