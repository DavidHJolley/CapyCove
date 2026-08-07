import { Minigame } from '../minigame.js';

// PLACEHOLDER: to be replaced with the full Capy Doodles (wave 6,
// docs/PARTY-GAMES.md).
export class DoodleGame extends Minigame {
  static id = 'doodle';
  static name = 'Capy Doodles';

  mount(root) {
    super.mount(root);
    root.innerHTML = `
      <div class="mg-splash">
        <h1>Capy Doodles</h1>
        <p>Doodles the bot is still sharpening her crayons. Come back soon.</p>
        <button class="mg-btn ghost" data-a="quit">Back to the jungle</button>
      </div>`;
    root.querySelector('[data-a="quit"]').onclick = () => this.quit();
  }
}
