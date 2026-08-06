import { Minigame } from '../minigame.js';

// PLACEHOLDER: to be replaced with the full Reel Rush fishing game.
export class FishingGame extends Minigame {
  static id = 'fishing';
  static name = 'Reel Rush';

  mount(root) {
    super.mount(root);
    root.innerHTML = `
      <div class="mg-splash">
        <h1>Reel Rush</h1>
        <p>Coming soon: placeholder run scores 10.</p>
        <button class="mg-btn" data-a="play">Cast off</button>
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
