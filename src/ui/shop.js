import { HATS, BODY_COLORS } from '../../shared/constants.js';

// PLACEHOLDER wardrobe/shop: to be replaced with the full shop UI
// (3D hat previews, buy flow polish). Keep the export signature.
export function openShop(game) {
  let el = document.getElementById('shop-overlay');
  if (el) { el.remove(); return; }
  el = document.createElement('div');
  el.id = 'shop-overlay';
  el.className = 'shop-overlay';

  const colorBtns = BODY_COLORS.map((c) =>
    `<button class="swatch" data-color="${c}" style="background:#${c.toString(16).padStart(6, '0')}"></button>`).join('');

  const hatRows = Object.entries(HATS).map(([id, h]) => {
    const owned = game.state.ownedHats.includes(id);
    const equipped = game.state.hat === id;
    return `<div class="shop-row">
      <span>${h.name}</span>
      <button class="hud-btn" data-hat="${id}">${equipped ? 'Equipped' : owned ? 'Equip' : `${h.price} coins`}</button>
    </div>`;
  }).join('');

  el.innerHTML = `<div class="shop-card">
    <h2>Wardrobe</h2>
    <div class="swatches">${colorBtns}</div>
    <div class="shop-list">${hatRows}</div>
    <button class="hud-btn map-close" id="shop-close">&#10005;</button>
  </div>`;
  document.getElementById('overlay-root').appendChild(el);

  el.querySelector('#shop-close').onclick = () => el.remove();
  el.addEventListener('click', (e) => { if (e.target === el) el.remove(); });
  el.querySelectorAll('.swatch').forEach((b) => {
    b.onclick = () => { game.setColor(parseInt(b.dataset.color, 10)); };
  });
  el.querySelectorAll('[data-hat]').forEach((b) => {
    b.onclick = () => {
      const id = b.dataset.hat;
      if (game.state.ownedHats.includes(id)) game.equipHat(id);
      else {
        const r = game.buyHat(id);
        if (r.ok && !r.pending) game.equipHat(id);
        else if (!r.ok) game.toast(r.msg);
      }
      el.remove();
      openShop(game); // rebuild with fresh state
    };
  });
}
