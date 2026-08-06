import { Minigame } from '../minigame.js';

// PLACEHOLDER: to be replaced with the full Smoothie Scramble game.
export class SmoothieGame extends Minigame {
  static id = 'smoothie';
  static name = 'Smoothie Scramble';

  mount(root) {
    super.mount(root);
    root.innerHTML = `
      <div class="mg-splash">
        <h1>Smoothie Scramble</h1>
        <p>Coming soon: placeholder run scores 10.</p>
        <button class="mg-btn" data-a="play">Blend</button>
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
