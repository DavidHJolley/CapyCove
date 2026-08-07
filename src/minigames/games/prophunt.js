import { Minigame } from '../minigame.js';

// PLACEHOLDER: to be replaced with the full Prop Hunt (wave 6,
// docs/PARTY-GAMES.md).
export class PropHuntGame extends Minigame {
  static id = 'prophunt';
  static name = 'Prop Hunt';

  mount(root) {
    super.mount(root);
    root.innerHTML = `
      <div class="mg-splash">
        <h1>Prop Hunt</h1>
        <p>The hiders are still picking their disguises. Come back soon.</p>
        <button class="mg-btn ghost" data-a="quit">Back to the mine</button>
      </div>`;
    root.querySelector('[data-a="quit"]').onclick = () => this.quit();
  }
}
