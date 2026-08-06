/**
 * Base class for minigames. Subclasses live in src/minigames/games/<id>.js and
 * are registered in src/minigames/index.js.
 *
 * Lifecycle (all driven by the engine):
 *   const mg = new SomeGame(game);
 *   mg.mount(rootEl);   // rootEl is the fullscreen #minigame-root div, empty
 *   ... minigame runs its own requestAnimationFrame loop and UI ...
 *   mg.finish(score)    // call this yourself when the run ends
 *   mg.dispose()        // engine calls after finish/quit: cancel RAF, free GL
 *
 * Rules (see CONTRACT.md):
 *  - Own everything inside rootEl: your own <canvas>, UI, styles (may inject a
 *    <style> tag or import a css file; prefix classes with mg-<id>-).
 *  - You MAY create your own THREE.WebGLRenderer, or render 2D canvas. Dispose
 *    renderer + geometries + materials in dispose().
 *  - Show an instructions splash first; start on click/keypress. Include a
 *    quit button (calls this.quit()).
 *  - Report the run with this.finish(score). Convert score to coins with your
 *    coinsForScore(score); the SERVER clamps rewards, so keep it honest.
 *  - Save best score with game.setBest(id, score) (auto-persists).
 */
export class Minigame {
  static id = 'minigame';
  static name = 'Minigame';

  constructor(game) {
    this.game = game;
    this.root = null;
    this._done = false;
  }

  mount(rootEl) { this.root = rootEl; }

  /** Convert final score to a coin payout. Override per game. */
  coinsForScore(score) { return Math.floor(score); }

  /** Call when the run ends. Shows nothing itself: show your own results UI,
   *  then call this.exitToRoom() from your "Done" button. */
  finish(score) {
    if (this._done) return;
    this._done = true;
    const id = this.constructor.id;
    this.game.reportMinigame(id, score, this.coinsForScore(score));
  }

  /** Quit without a payout (from the quit button on the splash/pause). */
  quit() { this.game.endMinigame(); }

  /** Leave back to the room (call from your results screen). */
  exitToRoom() { this.game.endMinigame(); }

  dispose() {}
}
