import * as THREE from 'three';
import { Room } from '../room.js';
import { makeToon, makeGlow, canvasTexture } from '../../core/materials.js';
import { ROOM_INFO } from '../../../shared/constants.js';

// ---------------------------------------------------------------------------
// The Smoothie Shack: a tropical juice bar interior. Floor + three walls, the
// south side is open to the camera. Everything is procedural: canvas textures
// for planks / chalkboard / painted sea views, InstancedMesh batches for the
// hundreds of little props so the room stays around ~35 draw calls.
// ---------------------------------------------------------------------------

const PAL = {
  wall: 0xf6e2b8,
  wainscot: 0xdca063,
  wood: 0x7a4e2a,
  woodMid: 0xa9703c,
  woodLight: 0xd39a5c,
  cream: 0xfdf0d5,
  coral: 0xe8657a,
  sky: 0x4fb3e8,
  leaf: 0x7ac74f,
  leafDark: 0x4d8c39,
  gold: 0xf2b64a,
  straw: 0xe0b46a,
  steel: 0xbcc6cd,
  terracotta: 0xcf7649,
  sand: 0xf0d9a4,
  mango: 0xf2a541,
  banana: 0xf6dc55,
  berry: 0x9b5fd0,
  kiwi: 0x8fd14f,
};

// room shell
const HW = 10;          // half width in x
const ZN = -8;          // north wall (inner face)
const ZS = 8;           // south edge of the interior floor
const WALL_H = 6.2;
const RAFT_Y = 5.25;
const BAY = 3.7;        // open central ceiling bay: keeps the menu board readable
const CNT_Z = -5.7;     // service counter centre
const CNT_TOP = 1.26;   // counter working surface

const MENU = [
  ['Mango Monsoon', '12'],
  ['Berry Belly Flop', '14'],
  ['Kiwi Kerfuffle', '11'],
  ['Coco Loco Float', '15'],
  ['Papaya Pow-Wow', '13'],
];

const CHALK_FONT = '"Comic Sans MS", "Segoe Print", "Bradley Hand", cursive';

// ---------------------------------------------------------------------------
// tiny deterministic rng so the clutter is identical every visit
// ---------------------------------------------------------------------------
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// instanced batch: one draw call for every prop sharing a primitive
// ---------------------------------------------------------------------------
class Batch {
  constructor(geo, mat) {
    this.geo = geo;
    this.mat = mat;
    this.rows = [];
  }

  add(color, x, y, z, sx, sy, sz, rx = 0, ry = 0, rz = 0) {
    this.rows.push([color, x, y, z, sx, sy, sz, rx, ry, rz]);
  }

  build(parent, cast = true, receive = true) {
    if (!this.rows.length) return null;
    const mesh = new THREE.InstancedMesh(this.geo, this.mat, this.rows.length);
    const d = new THREE.Object3D();
    const c = new THREE.Color();
    for (let i = 0; i < this.rows.length; i++) {
      const r = this.rows[i];
      d.position.set(r[1], r[2], r[3]);
      d.scale.set(r[4], r[5], r[6]);
      d.rotation.set(r[7], r[8], r[9]);
      d.updateMatrix();
      mesh.setMatrixAt(i, d.matrix);
      mesh.setColorAt(i, c.set(r[0]));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    parent.add(mesh);
    return mesh;
  }
}

// ---------------------------------------------------------------------------
// canvas texture painters
// ---------------------------------------------------------------------------
function texPlanks() {
  const t = canvasTexture(256, 256, (g, w, h) => {
    const rows = 6;
    const rh = h / rows;
    const tones = ['#d8a877', '#cd9d6e', '#e0b283', '#c9976a', '#d4a375', '#d09f71'];
    g.fillStyle = '#c08d5f';
    g.fillRect(0, 0, w, h);
    for (let r = 0; r < rows; r++) {
      const y = r * rh;
      g.fillStyle = tones[r % tones.length];
      g.fillRect(0, y + 1.5, w, rh - 3);
      g.strokeStyle = 'rgba(140,96,56,0.24)';
      g.lineWidth = 1;
      for (let i = 0; i < 6; i++) {
        const gy = y + 4 + ((i * 9 + r * 6) % (rh - 8));
        g.beginPath();
        g.moveTo(0, gy);
        g.bezierCurveTo(w * 0.3, gy - 2.5, w * 0.65, gy + 2.5, w, gy);
        g.stroke();
      }
      const jx = ((r * 91) % 190) + 30;
      g.fillStyle = 'rgba(88,54,24,0.6)';
      g.fillRect(jx, y + 1.5, 2, rh - 3);
      g.fillStyle = 'rgba(90,60,30,0.45)';
      for (const [nx, ny] of [[jx - 9, 0.3], [jx + 11, 0.72]]) {
        g.beginPath();
        g.arc(nx, y + rh * ny, 1.7, 0, 7);
        g.fill();
      }
    }
    g.fillStyle = 'rgba(78,46,20,0.65)';
    for (let r = 0; r <= rows; r++) g.fillRect(0, r * rh - 1, w, 2);
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(5, 4);
  return t;
}

function texDeck() {
  const t = canvasTexture(128, 128, (g, w, h) => {
    g.fillStyle = '#dcb98d';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 5; i++) {
      g.fillStyle = i % 2 ? '#e6c69c' : '#d9b489';
      g.fillRect(0, (i * h) / 5 + 2, w, h / 5 - 4);
      g.strokeStyle = 'rgba(140,102,66,0.3)';
      g.beginPath();
      g.moveTo(0, (i * h) / 5 + h / 10);
      g.lineTo(w, (i * h) / 5 + h / 10 + 2);
      g.stroke();
    }
    g.fillStyle = 'rgba(120,84,50,0.55)';
    for (let i = 0; i <= 5; i++) g.fillRect(0, (i * h) / 5 - 1, w, 2);
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(6, 2);
  return t;
}

function texView(flip) {
  return canvasTexture(512, 256, (g, w, h) => {
    const sky = g.createLinearGradient(0, 0, 0, h * 0.55);
    sky.addColorStop(0, '#7ec8ef');
    sky.addColorStop(0.6, '#b6e4f6');
    sky.addColorStop(1, '#f6e6c0');
    g.fillStyle = sky;
    g.fillRect(0, 0, w, h * 0.56);

    const sx = flip ? w * 0.24 : w * 0.76;
    const sun = g.createRadialGradient(sx, h * 0.2, 4, sx, h * 0.2, 64);
    sun.addColorStop(0, 'rgba(255,246,214,0.95)');
    sun.addColorStop(1, 'rgba(255,240,190,0)');
    g.fillStyle = sun;
    g.fillRect(sx - 70, h * 0.2 - 70, 140, 140);

    g.fillStyle = 'rgba(255,255,255,0.85)';
    for (const [cx, cy, s] of [[70, 40, 1], [190, 26, 0.7], [380, 52, 0.85], [300, 30, 0.55]]) {
      const x = flip ? w - cx : cx;
      g.beginPath();
      g.arc(x, cy, 16 * s, 0, 7);
      g.arc(x + 18 * s, cy + 4 * s, 12 * s, 0, 7);
      g.arc(x - 17 * s, cy + 5 * s, 11 * s, 0, 7);
      g.fill();
    }

    // headland with palms
    g.fillStyle = '#6fa85c';
    g.beginPath();
    const hx = flip ? w * 0.85 : w * 0.15;
    g.moveTo(hx - 110, h * 0.56);
    g.quadraticCurveTo(hx, h * 0.36, hx + 110, h * 0.56);
    g.fill();
    for (let i = 0; i < 3; i++) {
      const px = hx - 46 + i * 46;
      const py = h * 0.5 - i * 6;
      g.strokeStyle = '#5c4a2e';
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(px, py);
      g.quadraticCurveTo(px + 4, py - 20, px + 10, py - 34);
      g.stroke();
      g.fillStyle = '#4f8f3c';
      for (let f = 0; f < 5; f++) {
        const a = -Math.PI + (f / 4) * Math.PI;
        g.beginPath();
        g.moveTo(px + 10, py - 34);
        g.quadraticCurveTo(px + 10 + Math.cos(a) * 14, py - 40 + Math.sin(a) * 8, px + 10 + Math.cos(a) * 24, py - 30 + Math.sin(a) * 12);
        g.lineTo(px + 10, py - 32);
        g.fill();
      }
    }

    // sea
    const sea = g.createLinearGradient(0, h * 0.54, 0, h * 0.8);
    sea.addColorStop(0, '#3f9fd8');
    sea.addColorStop(1, '#63c8e6');
    g.fillStyle = sea;
    g.fillRect(0, h * 0.55, w, h * 0.26);
    g.strokeStyle = 'rgba(255,255,255,0.75)';
    g.lineWidth = 3;
    for (let i = 0; i < 26; i++) {
      const y = h * 0.585 + (i % 7) * 8;
      const x = ((i * 97) % w);
      g.beginPath();
      g.moveTo(x, y);
      g.quadraticCurveTo(x + 10, y - 4, x + 22, y);
      g.stroke();
    }

    // sailboat
    const bx = flip ? w * 0.34 : w * 0.62;
    g.fillStyle = '#fdf6e6';
    g.beginPath();
    g.moveTo(bx, h * 0.52);
    g.lineTo(bx + 20, h * 0.63);
    g.lineTo(bx - 4, h * 0.63);
    g.fill();
    g.fillStyle = '#e8657a';
    g.fillRect(bx - 12, h * 0.63, 38, 7);

    // sand + surf line
    g.fillStyle = '#f4dda8';
    g.fillRect(0, h * 0.79, w, h * 0.21);
    g.fillStyle = 'rgba(255,255,255,0.9)';
    g.beginPath();
    g.moveTo(0, h * 0.8);
    for (let x = 0; x <= w; x += 32) g.quadraticCurveTo(x + 16, h * 0.8 + (x % 64 ? 9 : -5), x + 32, h * 0.8 + 3);
    g.lineTo(w, h * 0.76);
    g.lineTo(0, h * 0.76);
    g.fill();
    g.fillStyle = 'rgba(214,178,120,0.5)';
    for (let i = 0; i < 40; i++) {
      const x = (i * 131) % w;
      const y = h * 0.83 + ((i * 47) % Math.round(h * 0.15));
      g.fillRect(x, y, 3, 2);
    }
  });
}

function texGarden() {
  return canvasTexture(256, 256, (g, w, h) => {
    const sky = g.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#8fd3f2');
    sky.addColorStop(0.7, '#dff2d5');
    sky.addColorStop(1, '#9ec96f');
    g.fillStyle = sky;
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#5d9a44';
    for (let i = 0; i < 9; i++) {
      const x = 12 + i * 28;
      const y = h - 10 - ((i * 37) % 60);
      g.beginPath();
      g.ellipse(x, y, 22, 52, (i % 3) - 1, 0, 7);
      g.fill();
    }
    g.fillStyle = '#7ac74f';
    for (let i = 0; i < 7; i++) {
      const x = 24 + i * 34;
      g.beginPath();
      g.ellipse(x, h - 30, 16, 40, ((i % 5) - 2) * 0.4, 0, 7);
      g.fill();
    }
    for (const [x, y, c] of [[60, 120, '#e8657a'], [150, 90, '#f2b64a'], [200, 140, '#e8657a'], [96, 66, '#ffffff']]) {
      g.fillStyle = c;
      for (let p = 0; p < 5; p++) {
        const a = (p / 5) * Math.PI * 2;
        g.beginPath();
        g.ellipse(x + Math.cos(a) * 7, y + Math.sin(a) * 7, 5, 5, 0, 0, 7);
        g.fill();
      }
      g.fillStyle = '#ffe9a8';
      g.beginPath();
      g.arc(x, y, 4, 0, 7);
      g.fill();
    }
  });
}

function texChalk() {
  return canvasTexture(768, 320, (g, w, h) => {
    g.fillStyle = '#2b3a33';
    g.fillRect(0, 0, w, h);
    // chalk dust smears
    for (let i = 0; i < 220; i++) {
      g.fillStyle = `rgba(233,240,228,${0.02 + (i % 5) * 0.008})`;
      const x = (i * 173) % w;
      const y = (i * 97) % h;
      g.fillRect(x, y, 14 + (i % 20), 6);
    }
    g.strokeStyle = 'rgba(240,246,232,0.75)';
    g.lineWidth = 3;
    g.strokeRect(16, 14, w - 32, h - 28);
    g.lineWidth = 1.5;
    g.strokeRect(24, 22, w - 48, h - 44);

    g.fillStyle = '#f4f8ec';
    g.textAlign = 'center';
    g.font = `bold 44px ${CHALK_FONT}`;
    g.fillText("TODAY'S BLENDS", w / 2, 78);
    g.strokeStyle = 'rgba(244,248,236,0.7)';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(w / 2 - 190, 92);
    g.quadraticCurveTo(w / 2, 100, w / 2 + 190, 92);
    g.stroke();

    g.textAlign = 'left';
    g.font = `30px ${CHALK_FONT}`;
    MENU.forEach(([name, price], i) => {
      const y = 138 + i * 34;
      g.fillStyle = i % 2 ? '#ffe8b8' : '#f4f8ec';
      g.fillText(name, 74, y + (i % 2 ? 1 : -1));
      g.fillText('.'.repeat(Math.max(2, 26 - name.length)), 74 + 250, y);
      g.fillStyle = '#a8e3c0';
      g.textAlign = 'right';
      g.fillText(`${price}c`, w - 78, y);
      g.textAlign = 'left';
    });

    g.fillStyle = '#ffd7e0';
    g.font = `italic 24px ${CHALK_FONT}`;
    g.textAlign = 'center';
    g.fillText('free refill for the top Scramble score!', w / 2, h - 34);

    // doodled smoothie glass
    g.strokeStyle = 'rgba(244,248,236,0.85)';
    g.lineWidth = 2.5;
    g.beginPath();
    g.moveTo(64, 244);
    g.lineTo(74, 292);
    g.lineTo(100, 292);
    g.lineTo(110, 244);
    g.closePath();
    g.stroke();
    g.beginPath();
    g.moveTo(96, 240);
    g.lineTo(112, 214);
    g.stroke();
    g.beginPath();
    g.arc(87, 236, 9, Math.PI, 0);
    g.stroke();

    g.strokeStyle = 'rgba(244,248,236,0.85)';
    g.beginPath();
    g.arc(w - 96, 258, 22, 0.4, 5.6);
    g.stroke();
    g.beginPath();
    g.moveTo(w - 96, 236);
    g.lineTo(w - 90, 222);
    g.stroke();
  });
}

function texStripe() {
  const t = canvasTexture(256, 128, (g, w, h) => {
    g.fillStyle = '#fdf0d5';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 8; i++) {
      g.fillStyle = i % 2 ? '#e8657a' : '#fdf0d5';
      g.fillRect((i * w) / 8, 0, w / 8, h);
    }
    g.fillStyle = 'rgba(122,78,42,0.18)';
    g.fillRect(0, h - 10, w, 10);
    g.fillStyle = '#f2b64a';
    g.fillRect(0, 0, w, 9);
    // scalloped valance under the lip
    g.fillStyle = '#f2b64a';
    for (let i = 0; i < 16; i++) {
      g.beginPath();
      g.arc((i + 0.5) * (w / 16), 9, w / 32, 0, Math.PI);
      g.fill();
    }
  });
  t.wrapS = THREE.RepeatWrapping;
  t.repeat.set(3, 1);
  return t;
}

function texTableTop() {
  return canvasTexture(256, 256, (g, w, h) => {
    const c = w / 2;
    g.fillStyle = '#fdf0d5';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 12; i++) {
      g.fillStyle = i % 2 ? '#f2b64a' : '#fdf0d5';
      g.beginPath();
      g.moveTo(c, c);
      g.arc(c, c, c - 6, (i / 12) * Math.PI * 2, ((i + 1) / 12) * Math.PI * 2);
      g.fill();
    }
    g.fillStyle = '#e8657a';
    g.beginPath();
    g.arc(c, c, 46, 0, 7);
    g.fill();
    g.fillStyle = '#fdf0d5';
    g.beginPath();
    g.arc(c, c, 30, 0, 7);
    g.fill();
    g.strokeStyle = '#7a4e2a';
    g.lineWidth = 8;
    g.beginPath();
    g.arc(c, c, c - 8, 0, 7);
    g.stroke();
  });
}

function texCrate() {
  return canvasTexture(128, 128, (g, w, h) => {
    g.fillStyle = '#c08a52';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#a9743f';
    for (let i = 0; i < 4; i++) g.fillRect(0, i * 32 + 26, w, 6);
    g.fillStyle = '#b8824a';
    g.fillRect(0, 0, 12, h);
    g.fillRect(w - 12, 0, 12, h);
    g.fillStyle = 'rgba(232,101,122,0.85)';
    g.beginPath();
    g.arc(w / 2, h / 2, 26, 0, 7);
    g.fill();
    g.fillStyle = '#fdf0d5';
    g.font = 'bold 15px system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText('COVE', w / 2, h / 2 - 2);
    g.fillText('FRUIT', w / 2, h / 2 + 14);
  });
}

function texRug() {
  return canvasTexture(256, 128, (g, w, h) => {
    g.fillStyle = '#e0b46a';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 10; i++) {
      g.fillStyle = ['#e8657a', '#f2b64a', '#4fb3e8', '#7ac74f'][i % 4];
      g.globalAlpha = 0.75;
      g.fillRect(0, i * 13 + 6, w, 6);
      g.globalAlpha = 1;
    }
    g.strokeStyle = 'rgba(122,78,42,0.35)';
    g.lineWidth = 1;
    for (let x = 0; x < w; x += 6) {
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, h);
      g.stroke();
    }
    g.fillStyle = '#c99553';
    g.fillRect(0, 0, w, 8);
    g.fillRect(0, h - 8, w, 8);
  });
}

function texSky() {
  return canvasTexture(256, 256, (g, w, h) => {
    const sky = g.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#4fa8e0');
    sky.addColorStop(0.45, '#9ed8f2');
    sky.addColorStop(0.72, '#ffe6bb');
    sky.addColorStop(1, '#ffd79a');
    g.fillStyle = sky;
    g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(255,255,255,0.8)';
    for (let i = 0; i < 10; i++) {
      const x = (i * 79) % w;
      const y = 40 + ((i * 53) % 90);
      const s = 0.6 + (i % 4) * 0.28;
      g.beginPath();
      g.arc(x, y, 20 * s, 0, 7);
      g.arc(x + 22 * s, y + 5 * s, 15 * s, 0, 7);
      g.arc(x - 20 * s, y + 6 * s, 13 * s, 0, 7);
      g.fill();
    }
  });
}

function texSign(title, sub, bg, fg) {
  return canvasTexture(512, 160, (g, w, h) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(0,0,0,0.22)';
    g.lineWidth = 10;
    g.strokeRect(5, 5, w - 10, h - 10);
    g.fillStyle = 'rgba(255,255,255,0.16)';
    g.fillRect(0, 0, w, 16);
    g.fillStyle = fg;
    g.textAlign = 'center';
    g.font = `bold ${sub ? 56 : 68}px system-ui, "Segoe UI", sans-serif`;
    g.fillText(title, w / 2, sub ? 74 : 100);
    if (sub) {
      g.font = `italic 30px ${CHALK_FONT}`;
      g.fillText(sub, w / 2, 122);
    }
  });
}

function texAFrame() {
  return canvasTexture(384, 512, (g, w, h) => {
    g.fillStyle = '#2b3a33';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 140; i++) {
      g.fillStyle = `rgba(233,240,228,${0.02 + (i % 4) * 0.01})`;
      g.fillRect((i * 137) % w, (i * 89) % h, 18, 5);
    }
    g.strokeStyle = 'rgba(240,246,232,0.8)';
    g.lineWidth = 4;
    g.strokeRect(16, 16, w - 32, h - 32);
    g.fillStyle = '#f4f8ec';
    g.textAlign = 'center';
    g.font = `bold 44px ${CHALK_FONT}`;
    g.fillText('THE', w / 2, 96);
    g.font = `bold 52px ${CHALK_FONT}`;
    g.fillStyle = '#ffd7e0';
    g.fillText('SMOOTHIE', w / 2, 154);
    g.fillText('SHACK', w / 2, 210);
    g.fillStyle = '#a8e3c0';
    g.font = `italic 27px ${CHALK_FONT}`;
    g.fillText(ROOM_INFO.cafe.desc, w / 2, 262);
    // glass doodle
    g.strokeStyle = 'rgba(244,248,236,0.9)';
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(140, 306);
    g.lineTo(158, 430);
    g.lineTo(226, 430);
    g.lineTo(244, 306);
    g.closePath();
    g.stroke();
    g.fillStyle = 'rgba(232,101,122,0.55)';
    g.fillRect(150, 352, 84, 76);
    g.beginPath();
    g.moveTo(222, 300);
    g.lineTo(258, 250);
    g.stroke();
    g.fillStyle = '#f2b64a';
    g.beginPath();
    g.arc(192, 300, 20, Math.PI, 0);
    g.fill();
    g.fillStyle = '#ffe8b8';
    g.font = `26px ${CHALK_FONT}`;
    g.fillText('open till sundown', w / 2, 478);
  });
}

function texPoster() {
  return canvasTexture(256, 352, (g, w, h) => {
    const sky = g.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#f2b64a');
    sky.addColorStop(0.55, '#e8657a');
    sky.addColorStop(1, '#4b3a6b');
    g.fillStyle = sky;
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#ffe6a8';
    g.beginPath();
    g.arc(w / 2, h * 0.42, 58, 0, 7);
    g.fill();
    g.fillStyle = 'rgba(75,58,107,0.85)';
    g.beginPath();
    g.moveTo(0, h * 0.62);
    for (let x = 0; x <= w; x += 24) g.quadraticCurveTo(x + 12, h * 0.62 - 14, x + 24, h * 0.62);
    g.lineTo(w, h);
    g.lineTo(0, h);
    g.fill();
    g.fillStyle = '#2b2440';
    g.beginPath();
    g.ellipse(w / 2 - 10, h * 0.7, 8, 30, 0.5, 0, 7);
    g.fill();
    g.fillStyle = '#fdf0d5';
    g.textAlign = 'center';
    g.font = 'bold 30px system-ui, sans-serif';
    g.fillText('COVE SURF', w / 2, 46);
    g.font = 'bold 22px system-ui, sans-serif';
    g.fillText('CLASSIC', w / 2, 72);
    g.font = `italic 20px ${CHALK_FONT}`;
    g.fillText('ride, blend, repeat', w / 2, h - 26);
  });
}

function texClock() {
  return canvasTexture(128, 128, (g, w, h) => {
    g.fillStyle = '#fdf0d5';
    g.beginPath();
    g.arc(64, 64, 62, 0, 7);
    g.fill();
    g.strokeStyle = '#7a4e2a';
    g.lineWidth = 7;
    g.beginPath();
    g.arc(64, 64, 58, 0, 7);
    g.stroke();
    g.fillStyle = '#7a4e2a';
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      g.beginPath();
      g.arc(64 + Math.sin(a) * 46, 64 - Math.cos(a) * 46, i % 3 ? 2.5 : 4, 0, 7);
      g.fill();
    }
    g.fillStyle = '#e8657a';
    g.beginPath();
    g.arc(64, 64, 5, 0, 7);
    g.fill();
    g.strokeStyle = '#4a3524';
    g.lineWidth = 5;
    g.beginPath();
    g.moveTo(64, 64);
    g.lineTo(64 + 20, 64 - 20);
    g.stroke();
    g.lineWidth = 3.5;
    g.beginPath();
    g.moveTo(64, 64);
    g.lineTo(64 - 6, 64 - 38);
    g.stroke();
  });
}

function texZ() {
  return canvasTexture(64, 64, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#ffffff';
    g.font = 'bold 52px system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText('z', 32, 48);
  });
}

// ---------------------------------------------------------------------------
export class CafeRoom extends Room {
  id = 'cafe';
  name = 'The Smoothie Shack';

  build(scene) {
    this.t = 0;
    this._dummy = new THREE.Object3D();
    this._col = new THREE.Color();
    const rand = rng(9137);
    const grad = makeToon(0xffffff).gradientMap;
    const toonMap = (map, color = 0xffffff, extra = {}) =>
      new THREE.MeshToonMaterial({ color, map, gradientMap: grad, ...extra });
    const flat = (map, extra = {}) => new THREE.MeshBasicMaterial({ map, ...extra });

    scene.background = new THREE.Color(0x9fd8f0);

    // --- instanced batches --------------------------------------------------
    const white = () => makeToon(0xffffff, { unique: true });
    const box = new Batch(new THREE.BoxGeometry(1, 1, 1), white());
    const boxFlat = new Batch(new THREE.BoxGeometry(1, 1, 1), white()); // no shadow casting
    const cyl = new Batch(new THREE.CylinderGeometry(0.5, 0.5, 1, 14), white());
    const pot = new Batch(new THREE.CylinderGeometry(0.5, 0.31, 1, 12), white());
    const ball = new Batch(new THREE.SphereGeometry(0.5, 12, 9), white());
    const bead = new Batch(new THREE.SphereGeometry(0.5, 8, 6), white());
    this._batches = [box, boxFlat, cyl, pot, ball, bead];

    this._buildShell(scene, box, boxFlat, ball, toonMap, flat);
    this._buildLights(scene);
    this._buildCeiling(scene, boxFlat);
    this._buildCounter(scene, box, boxFlat, cyl, pot, ball, bead, toonMap, flat, rand);
    this._buildSeating(scene, box, cyl, pot, ball, bead, toonMap);
    this._buildGreenery(scene, box, cyl, pot, ball, rand);
    this._buildDecor(scene, box, boxFlat, cyl, pot, ball, bead, flat);
    this._buildEntrance(scene, box, boxFlat, ball, toonMap, flat);

    for (const b of this._batches) b.build(scene, b !== boxFlat, true);

    // --- navigation ---------------------------------------------------------
    // both sit clear of the exit-plaza hotspot at (0,7) r=2.2, so arriving (or
    // jumping here from the map) does not pop the "go back" prompt over you
    this.spawnPoints = {
      default: new THREE.Vector3(0, 0, 4.3),
      from_plaza: new THREE.Vector3(0, 0, 4.3),
    };
    this.cameraHint = { offset: new THREE.Vector3(0, 10, 13), lookHeight: 1 };
    this.hotspots.push(
      {
        id: 'play-smoothie',
        position: new THREE.Vector3(0, 0, -4),
        radius: 2.6,
        label: 'Play Smoothie Scramble',
        action: (g) => g.startMinigame('smoothie'),
      },
      {
        id: 'exit-plaza',
        position: new THREE.Vector3(0, 0, 7),
        radius: 2.2,
        label: 'Back to Sunny Plaza',
        action: (g) => g.goToRoom('plaza', 'cafe'),
      },
    );
  }

  // -------------------------------------------------------------------------
  // floor, porch, exterior, walls + windows
  // -------------------------------------------------------------------------
  _buildShell(scene, box, boxFlat, ball, toonMap, flat) {
    // sky dome + sand so peeks over the walls show a beach, never the void
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(90, 16, 10),
      flat(texSky(), { side: THREE.BackSide, fog: false }),
    );
    scene.add(sky);

    const sand = new THREE.Mesh(new THREE.PlaneGeometry(140, 140), makeToon(PAL.sand));
    sand.rotation.x = -Math.PI / 2;
    sand.position.y = -0.08;
    scene.add(sand);

    // distant sea band to the north-west, just enough to read as coastline
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(140, 60), makeToon(PAL.sky));
    sea.rotation.x = -Math.PI / 2;
    sea.position.set(0, -0.04, -62);
    scene.add(sea);

    // interior plank floor (the only walkable surface)
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(2 * HW, ZS - ZN), toonMap(texPlanks()));
    floor.rotation.x = -Math.PI / 2;
    floor.position.z = (ZN + ZS) / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    this.groundMeshes = [floor];

    // covered porch out front: visual only, fills the bottom of the frame
    const porch = new THREE.Mesh(new THREE.PlaneGeometry(2 * HW + 2, 8), toonMap(texDeck()));
    porch.rotation.x = -Math.PI / 2;
    porch.position.set(0, 0.005, ZS + 4);
    porch.receiveShadow = true;
    scene.add(porch);
    box.add(PAL.wood, 0, 0.06, ZS + 0.12, 2 * HW + 2, 0.14, 0.5);

    // woven mat by the door
    const rug = new THREE.Mesh(new THREE.PlaneGeometry(5.2, 2.6), toonMap(texRug()));
    rug.rotation.x = -Math.PI / 2;
    rug.position.set(0, 0.014, 6.3);
    rug.receiveShadow = true;
    scene.add(rug);

    // --- walls with punched window openings --------------------------------
    const wallMat = makeToon(PAL.wall);
    const mkWall = (width, holes) => {
      const s = new THREE.Shape();
      s.moveTo(-width / 2, 0);
      s.lineTo(width / 2, 0);
      s.lineTo(width / 2, WALL_H);
      s.lineTo(-width / 2, WALL_H);
      s.closePath();
      for (const [x0, y0, x1, y1] of holes) {
        const p = new THREE.Path();
        p.moveTo(x0, y0);
        p.lineTo(x1, y0);
        p.lineTo(x1, y1);
        p.lineTo(x0, y1);
        p.closePath();
        s.holes.push(p);
      }
      const geo = new THREE.ExtrudeGeometry(s, { depth: 0.34, bevelEnabled: false });
      geo.translate(0, 0, -0.34);
      const m = new THREE.Mesh(geo, wallMat);
      m.receiveShadow = true;
      scene.add(m);
      return m;
    };

    // north: two tall slot windows either side of the chalkboard
    const north = mkWall(2 * HW + 1, [[-7.2, 2.5, -5.7, 4.4], [5.7, 2.5, 7.2, 4.4]]);
    north.position.z = ZN;

    // side walls: local +x maps to -z (west) / +z (east)
    const west = mkWall(ZS - ZN + 0.7, [[-3.4, 1.35, 1.6, 3.7]]);
    west.rotation.y = Math.PI / 2;
    west.position.set(-HW, 0, 0);
    const east = mkWall(ZS - ZN + 0.7, [[-1.6, 1.35, 3.4, 3.7]]);
    east.rotation.y = -Math.PI / 2;
    east.position.set(HW, 0, 0);

    // painted views hung just outside each wall
    const vw = new THREE.Mesh(new THREE.PlaneGeometry(8.4, 4.6), flat(texView(false)));
    vw.rotation.y = Math.PI / 2;
    vw.position.set(-HW - 0.5, 2.5, 0.9);
    scene.add(vw);
    const ve = new THREE.Mesh(new THREE.PlaneGeometry(8.4, 4.6), flat(texView(true)));
    ve.rotation.y = -Math.PI / 2;
    ve.position.set(HW + 0.5, 2.5, 0.9);
    scene.add(ve);
    const vn = new THREE.Mesh(new THREE.PlaneGeometry(20, 4.4), flat(texGarden()));
    vn.position.set(0, 3.4, ZN - 0.5);
    scene.add(vn);

    // wainscot band + chair rail + top plate on all three walls
    const rails = [
      [0, ZN + 0.08, 2 * HW, 0.16],
      [-HW + 0.08, 0, 0.16, ZS - ZN],
      [HW - 0.08, 0, 0.16, ZS - ZN],
    ];
    for (const [x, z, sx, sz] of rails) {
      boxFlat.add(PAL.wainscot, x, 0.55, z, sx, 1.1, sz);
      boxFlat.add(PAL.wood, x, 1.16, z, sx + 0.06, 0.14, sz + 0.06);
      boxFlat.add(PAL.wood, x, WALL_H - 0.2, z, sx + 0.06, 0.3, sz + 0.06);
      boxFlat.add(PAL.coral, x, 3.95, z, sx, 0.12, sz);
    }
    // corner posts
    for (const sx of [-1, 1]) {
      box.add(PAL.wood, sx * (HW - 0.16), WALL_H / 2, ZN + 0.16, 0.32, WALL_H, 0.32);
      box.add(PAL.wood, sx * (HW - 0.16), WALL_H / 2, ZS - 0.2, 0.32, WALL_H, 0.32);
    }

    // window frames, sills and planter boxes
    const frame = (cx, cy, cz, w, h, along) => {
      const t = 0.14;
      const sx = along === 'x' ? w : 0.3;
      const sz = along === 'x' ? 0.3 : w;
      boxFlat.add(PAL.cream, cx, cy + h / 2, cz, along === 'x' ? w + 0.3 : t + 0.16, t, along === 'x' ? t + 0.16 : w + 0.3);
      boxFlat.add(PAL.cream, cx, cy - h / 2, cz, along === 'x' ? w + 0.3 : t + 0.16, t, along === 'x' ? t + 0.16 : w + 0.3);
      boxFlat.add(PAL.cream, cx - (along === 'x' ? w / 2 : 0), cy, cz - (along === 'x' ? 0 : w / 2), along === 'x' ? t : t + 0.16, h, along === 'x' ? t + 0.16 : t);
      boxFlat.add(PAL.cream, cx + (along === 'x' ? w / 2 : 0), cy, cz + (along === 'x' ? 0 : w / 2), along === 'x' ? t : t + 0.16, h, along === 'x' ? t + 0.16 : t);
      boxFlat.add(PAL.cream, cx, cy, cz, along === 'x' ? 0.1 : t + 0.12, h, along === 'x' ? t + 0.12 : 0.1);
      boxFlat.add(PAL.cream, cx, cy, cz, sx, 0.1, sz);
    };
    // big side windows (world z -1.6 .. 3.4, y 1.35 .. 3.7)
    for (const s of [-1, 1]) {
      frame(s * (HW - 0.1), 2.52, 0.9, 5.0, 2.35, 'z');
      // sill + planter with blooms
      box.add(PAL.woodLight, s * (HW - 0.26), 1.28, 0.9, 0.5, 0.12, 5.3);
      box.add(PAL.terracotta, s * (HW - 0.34), 1.52, 0.9, 0.38, 0.36, 2.2);
      for (let i = 0; i < 9; i++) {
        const z = 0.9 - 0.95 + (i / 8) * 1.9;
        ball.add(i % 3 === 0 ? PAL.coral : i % 3 === 1 ? PAL.gold : PAL.leaf,
          s * (HW - 0.34), 1.74 + (i % 2) * 0.06, z, 0.3, 0.26, 0.3);
      }
    }
    // north slot windows
    for (const s of [-1, 1]) {
      frame(s * 6.45, 3.45, ZN + 0.1, 1.5, 1.9, 'x');
    }
  }

  // -------------------------------------------------------------------------
  _buildLights(scene) {
    scene.add(new THREE.HemisphereLight(0xffe9c8, 0x6b4a2e, 0.42));
    scene.add(new THREE.AmbientLight(0xfff0d6, 0.2));

    for (const [x, y, z, col, i, d] of [
      [0, 3.9, -4.6, 0xffd8ac, 15, 16],
      [-6.6, 3.8, 2.2, 0xffd2a4, 13, 15],
      [6.6, 3.8, 2.2, 0xffdcb4, 13, 15],
    ]) {
      const p = new THREE.PointLight(col, i, d, 2);
      p.position.set(x, y, z);
      scene.add(p);
    }

    // one soft sun raking in through the west window
    const sun = new THREE.DirectionalLight(0xffe7c4, 0.8);
    sun.position.set(-15, 17, 13);
    sun.target.position.set(0, 0, -1);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -15;
    sun.shadow.camera.right = 15;
    sun.shadow.camera.top = 14;
    sun.shadow.camera.bottom = -12;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 55;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.03;
    scene.add(sun);
    scene.add(sun.target);
  }

  // -------------------------------------------------------------------------
  // rafters, thatch eave, ceiling fan, string lights, bunting
  // -------------------------------------------------------------------------
  _buildCeiling(scene, boxFlat) {
    // Open truss over the two side bays. The central bay is deliberately left
    // open: every beam there would cut across the menu board from some angle.
    const segW = HW - BAY;
    for (const z of [-7.2, -5.4, -3.6, -1.8, 0, 1.2]) {
      for (const s of [-1, 1]) {
        boxFlat.add(PAL.woodMid, s * (BAY + segW / 2), RAFT_Y, z, segW + 0.2, 0.18, 0.28);
      }
    }
    for (const s of [-1, 1]) {
      boxFlat.add(PAL.wood, s * BAY, RAFT_Y + 0.22, -3.3, 0.24, 0.3, 9.6);
      boxFlat.add(PAL.wood, s * (HW - 0.2), RAFT_Y + 0.22, -3.3, 0.24, 0.3, 9.6);
    }
    // corbels where beams meet the walls
    for (const z of [-7.2, -3.6, 0]) {
      for (const s of [-1, 1]) {
        boxFlat.add(PAL.wood, s * (HW - 0.45), RAFT_Y - 0.3, z, 0.9, 0.34, 0.22, 0, 0, s * 0.25);
      }
    }

    // thatch eave over the bar (well above every sight line to the chalkboard)
    for (let i = 0; i < 12; i++) {
      const z = ZN - 0.3 + i * 0.24;
      const y = 6.28 - i * 0.06;
      boxFlat.add(i % 2 ? PAL.straw : 0xd0a355, 0, y, z, 2 * HW + 0.8, 0.22, 0.3, -0.24, 0, 0);
    }
    boxFlat.add(PAL.wood, 0, 6.36, ZN - 0.35, 2 * HW + 1, 0.2, 0.34);

    // --- twin ceiling fans over the side bays -------------------------------
    const d = new THREE.Object3D();
    const hubGeo = new THREE.CylinderGeometry(0.24, 0.28, 0.22, 12);
    const bladeGeo = new THREE.BoxGeometry(1.4, 0.05, 0.4);
    const globeGeo = new THREE.SphereGeometry(0.24, 12, 9);
    const hubMat = makeToon(PAL.gold);
    const bladeMat = makeToon(PAL.woodMid);
    const globeMat = makeGlow(0xffe6b0);
    this._fans = [];
    for (const fx of [-5.5, 5.5]) {
      const fanRoot = new THREE.Group();
      fanRoot.position.set(fx, 4.2, 0);
      scene.add(fanRoot);
      boxFlat.add(PAL.wood, fx, 4.68, 0, 0.12, 0.8, 0.12);
      fanRoot.add(new THREE.Mesh(hubGeo, hubMat));
      const blades = new THREE.InstancedMesh(bladeGeo, bladeMat, 4);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2;
        d.position.set(Math.cos(a) * 0.9, -0.02, Math.sin(a) * 0.9);
        d.rotation.set(0, -a, 0.14);
        d.scale.setScalar(1);
        d.updateMatrix();
        blades.setMatrixAt(i, d.matrix);
      }
      blades.instanceMatrix.needsUpdate = true;
      fanRoot.add(blades);
      const globe = new THREE.Mesh(globeGeo, globeMat);
      globe.position.y = -0.22;
      fanRoot.add(globe);
      this._fans.push(fanRoot);
    }

    // --- string lights around the perimeter --------------------------------
    const strands = [
      [new THREE.Vector3(-9.4, 5.15, -7.2), new THREE.Vector3(9.4, 5.15, -7.2)],
      [new THREE.Vector3(-9.4, 5.15, 7.4), new THREE.Vector3(9.4, 5.15, 7.4)],
      [new THREE.Vector3(-9.5, 5.15, -7.3), new THREE.Vector3(-9.5, 5.15, 7.3)],
      [new THREE.Vector3(9.5, 5.15, -7.3), new THREE.Vector3(9.5, 5.15, 7.3)],
    ];
    const bulbGeo = new THREE.SphereGeometry(0.085, 8, 6);
    const bulbMat = makeGlow(0xffffff, { unique: true });
    const bulbPos = [];
    const cordMat = makeToon(0x4a3a2c);
    for (const [a, b] of strands) {
      const pts = [];
      for (let i = 0; i <= 16; i++) {
        const t = i / 16;
        const p = a.clone().lerp(b, t);
        p.y -= 0.85 * (1 - (2 * t - 1) ** 2);
        pts.push(p);
      }
      const cord = new THREE.Mesh(
        new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 22, 0.022, 4, false),
        cordMat,
      );
      scene.add(cord);
      for (let i = 1; i < 16; i++) {
        const t = i / 16;
        const p = a.clone().lerp(b, t);
        p.y -= 0.85 * (1 - (2 * t - 1) ** 2) + 0.13;
        bulbPos.push(p);
      }
    }
    const bulbs = new THREE.InstancedMesh(bulbGeo, bulbMat, bulbPos.length);
    for (let i = 0; i < bulbPos.length; i++) {
      d.position.copy(bulbPos[i]);
      d.rotation.set(0, 0, 0);
      d.scale.setScalar(1);
      d.updateMatrix();
      bulbs.setMatrixAt(i, d.matrix);
      bulbs.setColorAt(i, this._col.setHex(0xffe0a0));
    }
    bulbs.instanceMatrix.needsUpdate = true;
    bulbs.instanceColor.needsUpdate = true;
    scene.add(bulbs);
    this._bulbs = bulbs;
    this._bulbSeed = bulbPos.map((_, i) => (i * 1.7) % 6.283);
    // little cord hangers
    for (const p of [[-9.4, -7.2], [9.4, -7.2], [-9.4, 7.4], [9.4, 7.4]]) {
      boxFlat.add(PAL.wood, p[0], 5.3, p[1], 0.16, 0.4, 0.16);
    }

    // --- bunting draped along the front planter wall ------------------------
    // (kept low: anything strung overhead would sit on top of players)
    const cols = [PAL.coral, PAL.gold, PAL.sky, PAL.leaf, PAL.cream];
    this._flagData = [];
    const slots = [];
    for (let i = 0; i <= 22; i++) {
      const t = i / 22;
      const x = -9.5 + t * 19;
      if (Math.abs(x) < 2.5) continue;
      slots.push([x, 1.1 - 0.16 * (1 - (2 * ((Math.abs(x) - 2.5) / 7) - 1) ** 2)]);
    }
    const flags = new THREE.InstancedMesh(
      new THREE.ConeGeometry(0.26, 0.54, 3), makeToon(0xffffff, { unique: true }), slots.length,
    );
    slots.forEach(([x, y], i) => {
      this._flagData.push({ x, y, z: 8.2, ph: i * 0.7 });
      d.position.set(x, y - 0.27, 8.2);
      d.rotation.set(0, 0, Math.PI);
      d.scale.setScalar(1);
      d.updateMatrix();
      flags.setMatrixAt(i, d.matrix);
      flags.setColorAt(i, this._col.setHex(cols[i % cols.length]));
    });
    flags.instanceMatrix.needsUpdate = true;
    flags.instanceColor.needsUpdate = true;
    flags.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(flags);
    this._flags = flags;
    for (const s of [-1, 1]) {
      const bpts = [];
      for (let i = 0; i <= 10; i++) {
        const t = i / 10;
        bpts.push(new THREE.Vector3(s * (2.4 + t * 7.2), 1.16 - 0.16 * (1 - (2 * t - 1) ** 2), 8.2));
      }
      scene.add(new THREE.Mesh(
        new THREE.TubeGeometry(new THREE.CatmullRomCurve3(bpts), 14, 0.02, 4, false),
        cordMat,
      ));
    }
  }

  // -------------------------------------------------------------------------
  // service counter, appliances, back bar, menu board
  // -------------------------------------------------------------------------
  _buildCounter(scene, box, boxFlat, cyl, pot, ball, bead, toonMap, flat, rand) {
    const CW = 13.2;
    box.add(PAL.cream, 0, 0.55, CNT_Z, CW, 1.1, 1.7);
    box.add(PAL.woodLight, 0, 1.17, CNT_Z - 0.05, CW + 0.6, 0.18, 2.0);
    box.add(PAL.wood, 0, 1.06, CNT_Z - 0.05, CW + 0.66, 0.08, 2.06);
    box.add(PAL.wood, 0, 0.07, CNT_Z, CW - 0.5, 0.14, 1.55);
    for (const s of [-1, 1]) box.add(PAL.wood, s * (CW / 2 - 0.16), 0.62, CNT_Z, 0.34, 1.24, 1.86);

    // striped front panel
    const front = new THREE.Mesh(new THREE.PlaneGeometry(CW - 0.7, 1.02), toonMap(texStripe()));
    front.position.set(0, 0.56, CNT_Z + 0.86);
    scene.add(front);

    // back bar cabinet
    box.add(PAL.cream, 0, 0.5, -7.5, CW + 0.6, 1.0, 0.8);
    box.add(PAL.woodLight, 0, 1.06, -7.5, CW + 0.9, 0.14, 0.96);
    for (const x of [-4.2, 0, 4.2]) box.add(PAL.wainscot, x, 0.5, -7.06, 3.6, 0.9, 0.08);

    // bottles + syrup jars along the back bar
    const bottleCols = [PAL.coral, PAL.gold, PAL.leaf, PAL.sky, PAL.berry, PAL.mango, PAL.kiwi];
    for (let i = 0; i < 16; i++) {
      const x = -6.4 + i * 0.85 + (i % 3) * 0.06;
      const h = 0.34 + (i % 4) * 0.09;
      cyl.add(bottleCols[i % bottleCols.length], x, 1.13 + h / 2, -7.5, 0.22, h, 0.22);
      cyl.add(PAL.cream, x, 1.13 + h + 0.05, -7.5, 0.09, 0.12, 0.09);
    }

    // --- menu chalkboard ----------------------------------------------------
    const board = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 2.2), toonMap(texChalk()));
    board.position.set(0, 2.75, ZN + 0.06);
    scene.add(board);
    boxFlat.add(PAL.wood, 0, 2.75, ZN + 0.02, 6.9, 2.7, 0.1);
    boxFlat.add(PAL.woodLight, 0, 1.55, ZN + 0.14, 6.9, 0.14, 0.24); // chalk ledge
    for (let i = 0; i < 3; i++) {
      cyl.add([0xfdf0d5, 0xffd7e0, 0xa8e3c0][i], -1 + i * 0.5, 1.66, ZN + 0.2, 0.07, 0.22, 0.07, 0, 0, Math.PI / 2);
    }

    // hanging carved sign, off to the side so it never covers the menu
    const hang = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.78), flat(texSign('FRESH BLENDS', '', '#e8657a', '#fff6df')));
    hang.position.set(-5.3, 2.9, -4.92);
    scene.add(hang);
    boxFlat.add(PAL.wood, -5.3, 2.9, -4.98, 2.8, 0.96, 0.08);
    for (const s of [-1, 1]) boxFlat.add(0x4a3a2c, -5.3 + s * 1.1, 4.0, -4.98, 0.04, 2.2, 0.04);

    // --- wall shelves behind the bar ---------------------------------------
    for (const s of [-1, 1]) {
      for (const y of [2.45, 3.45]) {
        boxFlat.add(PAL.woodLight, s * 8.6, y, ZN + 0.28, 2.1, 0.11, 0.56);
        for (const bx of [-0.6, 0.6]) {
          boxFlat.add(PAL.wood, s * 8.6 + bx, y - 0.2, ZN + 0.2, 0.09, 0.3, 0.36, 0, 0, 0);
        }
      }
      // stacked cups and glass jars
      for (let i = 0; i < 4; i++) {
        pot.add(PAL.cream, s * 8.6 - 0.7 + i * 0.46, 2.62, ZN + 0.28, 0.3, 0.22, 0.3);
        pot.add(PAL.cream, s * 8.6 - 0.7 + i * 0.46, 2.8, ZN + 0.28, 0.3, 0.22, 0.3);
      }
      for (let i = 0; i < 3; i++) {
        const c = [PAL.mango, PAL.berry, PAL.kiwi][i];
        cyl.add(PAL.cream, s * 8.6 - 0.6 + i * 0.6, 3.68, ZN + 0.28, 0.34, 0.35, 0.34);
        cyl.add(c, s * 8.6 - 0.6 + i * 0.6, 3.62, ZN + 0.28, 0.3, 0.2, 0.3);
        cyl.add(PAL.gold, s * 8.6 - 0.6 + i * 0.6, 3.88, ZN + 0.28, 0.36, 0.06, 0.36);
      }
    }

    // --- blender ------------------------------------------------------------
    const bx = 2.1;
    box.add(PAL.steel, bx, CNT_TOP + 0.17, CNT_Z - 0.1, 0.5, 0.34, 0.46);
    box.add(0x8e9aa3, bx, CNT_TOP + 0.02, CNT_Z - 0.1, 0.56, 0.06, 0.52);
    cyl.add(PAL.coral, bx + 0.16, CNT_TOP + 0.16, CNT_Z + 0.14, 0.13, 0.06, 0.13, Math.PI / 2, 0, 0);
    cyl.add(PAL.cream, bx - 0.1, CNT_TOP + 0.16, CNT_Z + 0.14, 0.09, 0.05, 0.09, Math.PI / 2, 0, 0);

    const jarY = CNT_TOP + 0.34 + 0.35;
    const jar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.23, 0.19, 0.7, 14, 1, true),
      new THREE.MeshToonMaterial({
        color: 0xdff2fb, gradientMap: makeToon(0xffffff).gradientMap,
        transparent: true, opacity: 0.42, side: THREE.DoubleSide, depthWrite: false,
      }),
    );
    jar.position.set(bx, jarY, CNT_Z - 0.1);
    scene.add(jar);
    this._jar = jar;
    this._jarX = bx;

    const juice = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.17, 0.42, 12), makeToon(PAL.coral));
    juice.position.set(bx, jarY - 0.13, CNT_Z - 0.1);
    scene.add(juice);
    this._juice = juice;
    cyl.add(PAL.gold, bx, jarY + 0.38, CNT_Z - 0.1, 0.5, 0.1, 0.5);
    cyl.add(PAL.steel, bx, jarY + 0.45, CNT_Z - 0.1, 0.14, 0.06, 0.14);

    // bubbles inside the jar + steam puffs above it
    const puffGeo = new THREE.SphereGeometry(0.5, 8, 6);
    const puffMat = new THREE.MeshBasicMaterial({
      color: 0xfff6e4, transparent: true, opacity: 0.5, depthWrite: false,
    });
    const puffs = new THREE.InstancedMesh(puffGeo, puffMat, 18);
    puffs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(puffs);
    this._puffs = puffs;
    this._puffData = [];
    for (let i = 0; i < 18; i++) {
      this._puffData.push({
        jarBubble: i < 8,
        t: rand(),
        sp: 0.35 + rand() * 0.4,
        ph: rand() * 6.283,
        s: 0.05 + rand() * 0.07,
      });
    }
    this._puffOrigin = new THREE.Vector3(bx, jarY - 0.3, CNT_Z - 0.1);

    // --- citrus press + till + odds and ends --------------------------------
    box.add(PAL.gold, -2.6, CNT_TOP + 0.11, CNT_Z - 0.1, 0.34, 0.22, 0.34);
    cyl.add(PAL.gold, -2.6, CNT_TOP + 0.36, CNT_Z - 0.1, 0.26, 0.28, 0.26);
    cyl.add(PAL.cream, -2.6, CNT_TOP + 0.56, CNT_Z - 0.1, 0.42, 0.12, 0.42);
    box.add(PAL.coral, -2.6, CNT_TOP + 0.72, CNT_Z - 0.32, 0.1, 0.4, 0.5, 0.5, 0, 0);

    box.add(PAL.cream, -4.6, CNT_TOP + 0.2, CNT_Z - 0.1, 0.8, 0.4, 0.6);
    box.add(PAL.wood, -4.6, CNT_TOP + 0.44, CNT_Z - 0.16, 0.7, 0.1, 0.44, 0.4, 0, 0);
    for (let i = 0; i < 6; i++) {
      bead.add(i % 2 ? PAL.gold : PAL.cream, -4.9 + (i % 3) * 0.2, CNT_TOP + 0.44, CNT_Z + 0.06 - Math.floor(i / 3) * 0.14, 0.1, 0.1, 0.1);
    }

    // service bell right at the order spot
    ball.add(PAL.gold, 0.9, CNT_TOP + 0.11, CNT_Z + 0.42, 0.3, 0.3, 0.3);
    cyl.add(PAL.wood, 0.9, CNT_TOP + 0.02, CNT_Z + 0.42, 0.34, 0.05, 0.34);
    bead.add(PAL.cream, 0.9, CNT_TOP + 0.26, CNT_Z + 0.42, 0.07, 0.07, 0.07);

    // order-here tent card sitting on the counter
    const card = new THREE.Mesh(new THREE.PlaneGeometry(1.15, 0.46), flat(texSign('ORDER HERE', '', '#f2b64a', '#4a3018')));
    card.position.set(0, CNT_TOP + 0.26, CNT_Z + 0.6);
    card.rotation.x = -0.16;
    scene.add(card);
    boxFlat.add(PAL.cream, 0, CNT_TOP + 0.26, CNT_Z + 0.64, 1.2, 0.5, 0.05, -0.16, 0, 0);

    // straw jar + napkins
    cyl.add(PAL.cream, 4.4, CNT_TOP + 0.2, CNT_Z - 0.1, 0.3, 0.4, 0.3);
    for (let i = 0; i < 7; i++) {
      cyl.add([PAL.coral, PAL.sky, PAL.leaf, PAL.gold][i % 4],
        4.4 + (rand() - 0.5) * 0.16, CNT_TOP + 0.5, CNT_Z - 0.1 + (rand() - 0.5) * 0.16,
        0.045, 0.42, 0.045, (rand() - 0.5) * 0.3, 0, (rand() - 0.5) * 0.3);
    }
    box.add(PAL.cream, 5.3, CNT_TOP + 0.06, CNT_Z - 0.1, 0.5, 0.12, 0.5);
    box.add(PAL.coral, 5.3, CNT_TOP + 0.14, CNT_Z - 0.1, 0.36, 0.06, 0.36);

    // fruit bowl on the counter
    pot.add(PAL.cream, -0.9, CNT_TOP + 0.14, CNT_Z - 0.1, 0.66, 0.28, 0.66);
    this._fruitPile(ball, bead, -0.9, CNT_TOP + 0.26, CNT_Z - 0.1, 0.24, 9, rand);

    // --- fruit crates on the floor -----------------------------------------
    const crateMat = toonMap(texCrate());
    const crateGeo = new THREE.BoxGeometry(1.1, 0.72, 1.1);
    for (const [cx, cy, cz, ry] of [
      [-8.5, 0.36, -6.4, 0.2], [-8.5, 1.08, -6.4, -0.14], [-8.3, 0.36, -4.9, 0.5],
      [8.4, 0.36, -6.5, -0.3],
    ]) {
      const c = new THREE.Mesh(crateGeo, crateMat);
      c.position.set(cx, cy, cz);
      c.rotation.y = ry;
      c.castShadow = true;
      c.receiveShadow = true;
      scene.add(c);
    }
    this._fruitPile(ball, bead, -8.5, 1.5, -6.4, 0.42, 11, rand);
    this._fruitPile(ball, bead, -8.3, 0.78, -4.9, 0.4, 9, rand);
    this._fruitPile(ball, bead, 8.4, 0.78, -6.5, 0.4, 10, rand);

    this.obstacles.push(
      { x: -8.5, z: -6.4, r: 1.0 }, { x: -8.3, z: -4.9, r: 0.9 }, { x: 8.4, z: -6.5, r: 0.95 },
    );
    for (let x = -6.5; x <= 6.5; x += 1.3) this.obstacles.push({ x, z: CNT_Z, r: 1.25 });
  }

  // -------------------------------------------------------------------------
  // tables, stools, drinks, bench, cooler
  // -------------------------------------------------------------------------
  _buildSeating(scene, box, cyl, pot, ball, bead, toonMap) {
    const shells = [];
    const glass = (x, y, z, color) => {
      cyl.add(color, x, y + 0.11, z, 0.19, 0.22, 0.19);
      cyl.add([PAL.coral, PAL.sky, PAL.leaf, PAL.gold][shells.length % 4],
        x + 0.05, y + 0.34, z - 0.02, 0.035, 0.4, 0.035, 0.3, 0, 0.28);
      bead.add(PAL.coral, x - 0.09, y + 0.28, z + 0.04, 0.12, 0.12, 0.12);
      bead.add(PAL.leaf, x + 0.02, y + 0.3, z + 0.09, 0.16, 0.06, 0.16, 0.4, 0, 0.3);
      shells.push([x, y + 0.15, z]);
    };

    // --- three round tables -------------------------------------------------
    const tables = [[-6.7, 0.6], [6.7, 0.6], [-6.3, 5.2]];
    const topGeo = new THREE.CylinderGeometry(1.02, 1.02, 0.13, 20);
    const tops = new THREE.InstancedMesh(topGeo, toonMap(texTableTop()), tables.length);
    const d = this._dummy;
    tables.forEach(([x, z], i) => {
      d.position.set(x, 0.95, z);
      d.rotation.set(0, i * 0.7, 0);
      d.scale.setScalar(1);
      d.updateMatrix();
      tops.setMatrixAt(i, d.matrix);
      pot.add(PAL.cream, x, 0.5, z, 0.34, 0.82, 0.34, 0, 0, Math.PI);
      cyl.add(PAL.wood, x, 0.06, z, 0.95, 0.12, 0.95);
      cyl.add(PAL.woodLight, x, 0.87, z, 0.5, 0.1, 0.5);
      this.obstacles.push({ x, z, r: 1.15 });

      // stools around it
      for (let s = 0; s < 3; s++) {
        const a = (s / 3) * Math.PI * 2 + i * 0.5;
        const sx = x + Math.cos(a) * 1.8;
        const sz = z + Math.sin(a) * 1.8;
        this._stool(cyl, ball, sx, sz, 0.55, s % 2 ? PAL.coral : PAL.sky);
        this.obstacles.push({ x: sx, z: sz, r: 0.42 });
      }

      // table dressing: flower vase, menu card, drinks
      pot.add(PAL.sky, x + 0.42, 1.13, z - 0.28, 0.18, 0.24, 0.18, 0, 0, Math.PI);
      cyl.add(PAL.leafDark, x + 0.42, 1.32, z - 0.28, 0.04, 0.3, 0.04);
      for (let p = 0; p < 5; p++) {
        const pa = (p / 5) * 6.283;
        bead.add(i === 1 ? PAL.coral : PAL.gold,
          x + 0.42 + Math.cos(pa) * 0.09, 1.48, z - 0.28 + Math.sin(pa) * 0.09, 0.13, 0.09, 0.13);
      }
      bead.add(PAL.cream, x + 0.42, 1.5, z - 0.28, 0.1, 0.1, 0.1);
      glass(x - 0.3, 1.01, z + 0.2, [PAL.mango, PAL.berry, PAL.kiwi][i]);
      if (i !== 1) glass(x + 0.16, 1.01, z + 0.42, PAL.coral);
      box.add(PAL.cream, x - 0.5, 1.02, z - 0.34, 0.34, 0.02, 0.34, 0, 0.4, 0);
    });
    tops.instanceMatrix.needsUpdate = true;
    tops.castShadow = true;
    tops.receiveShadow = true;
    scene.add(tops);

    // --- bar stools at the counter -----------------------------------------
    for (const x of [-4.7, -2.9, 2.9, 4.7]) {
      this._stool(cyl, ball, x, -3.75, 0.78, x < 0 ? PAL.gold : PAL.coral);
      this.obstacles.push({ x, z: -3.75, r: 0.46 });
    }
    for (let i = 0; i < 3; i++) glass(-0.6 + i * 0.9, CNT_TOP, CNT_Z + 0.5, [PAL.mango, PAL.kiwi, PAL.berry][i]);

    // --- glass shells (one transparent draw call) ---------------------------
    const shellMesh = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.115, 0.088, 0.32, 10, 1, true),
      new THREE.MeshToonMaterial({
        color: 0xeaf7ff, gradientMap: makeToon(0xffffff).gradientMap,
        transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false,
      }),
      shells.length,
    );
    shells.forEach(([x, y, z], i) => {
      d.position.set(x, y, z);
      d.rotation.set(0, 0, 0);
      d.scale.setScalar(1);
      d.updateMatrix();
      shellMesh.setMatrixAt(i, d.matrix);
    });
    shellMesh.instanceMatrix.needsUpdate = true;
    scene.add(shellMesh);

    // --- bench by the entrance ---------------------------------------------
    box.add(PAL.woodLight, 8.7, 0.5, 6.4, 1.0, 0.14, 2.6);
    box.add(PAL.woodLight, 9.25, 0.9, 6.4, 0.14, 0.7, 2.6, 0, 0, 0.12);
    for (const z of [5.4, 7.4]) {
      box.add(PAL.wood, 8.7, 0.25, z, 0.7, 0.5, 0.16);
    }
    this.obstacles.push({ x: 8.75, z: 6.4, r: 1.35 });

    // --- retro drinks cooler on the east wall -------------------------------
    box.add(PAL.sky, 9.15, 0.95, -3.4, 1.4, 1.9, 1.0);
    box.add(PAL.cream, 9.15, 1.95, -3.4, 1.52, 0.14, 1.1);
    box.add(0x2a4658, 8.48, 1.05, -3.4, 0.06, 1.3, 0.78);
    for (let i = 0; i < 8; i++) {
      cyl.add([PAL.coral, PAL.gold, PAL.leaf, PAL.berry][i % 4],
        8.7 + (i % 2) * 0.3, 0.62 + Math.floor(i / 4) * 0.56, -3.72 + (i % 4) * 0.21, 0.18, 0.34, 0.18);
    }
    box.add(PAL.cream, 9.15, 0.28, -3.4, 1.2, 0.1, 1.02);
    this.obstacles.push({ x: 9.15, z: -3.4, r: 1.15 });
  }

  // -------------------------------------------------------------------------
  // potted palms (animated fronds), hanging planters, vines
  // -------------------------------------------------------------------------
  _buildGreenery(scene, box, cyl, pot, ball, rand) {
    this._fronds = [];
    const frondData = [];

    const palm = (x, z, scale, potted) => {
      const h = 2.0 * scale;
      if (potted) {
        pot.add(PAL.terracotta, x, 0.3 * scale, z, 0.95 * scale, 0.62 * scale, 0.95 * scale);
        cyl.add(0xe08b5c, x, 0.62 * scale, z, 1.02 * scale, 0.12 * scale, 1.02 * scale);
        cyl.add(0x6b4a30, x, 0.63 * scale, z, 0.8 * scale, 0.06 * scale, 0.8 * scale);
      }
      const base = potted ? 0.6 * scale : 0;
      const lean = (rand() - 0.5) * 0.16;
      for (let s = 0; s < 3; s++) {
        const sy = base + (s + 0.5) * (h / 3);
        cyl.add(s % 2 ? 0x9a7247 : 0x8a6540,
          x + lean * s * 0.4, sy, z + lean * s * 0.2,
          (0.34 - s * 0.05) * scale, (h / 3) * 1.02, (0.34 - s * 0.05) * scale,
          0, 0, lean * 0.5);
      }
      const cx = x + lean * 1.2;
      const cy = base + h;
      const cz = z + lean * 0.6;
      cyl.add(0x8a6540, cx, cy - 0.05, cz, 0.4 * scale, 0.2 * scale, 0.4 * scale);
      for (let c = 0; c < 3; c++) {
        const a = (c / 3) * 6.283;
        ball.add(0x7a5a3a, cx + Math.cos(a) * 0.18 * scale, cy - 0.12, cz + Math.sin(a) * 0.18 * scale,
          0.24 * scale, 0.24 * scale, 0.24 * scale);
      }
      const n = 7;
      for (let f = 0; f < n; f++) {
        const az = (f / n) * 6.283 + rand() * 0.3;
        const tilt = 1.0 + rand() * 0.35;
        const len = (1.5 + rand() * 0.5) * scale;
        frondData.push({
          cx, cy, cz, az, tilt, len,
          w: (0.5 + rand() * 0.2) * scale,
          ph: rand() * 6.283,
          col: f % 3 === 0 ? PAL.leafDark : PAL.leaf,
        });
      }
    };

    // indoor palms
    for (const [x, z, s] of [[-9.0, 6.5, 1.0], [9.0, 6.5, 1.05], [-9.2, 3.9, 0.85], [8.9, 2.4, 0.8]]) {
      palm(x, z, s, true);
      this.obstacles.push({ x, z, r: 0.5 + 0.35 * s });
    }
    // porch palms, well clear of the doorway sight line
    palm(-6.6, 10.6, 1.15, true);
    palm(6.6, 10.6, 1.1, true);
    // distant palms outside the walls
    for (const [x, z, s] of [[-15.5, 1.5, 1.5], [15.8, -2.5, 1.4], [-17, -7, 1.2], [16.5, 7.5, 1.35], [-13, 13, 1.1]]) {
      palm(x, z, s, false);
    }

    const frondMesh = new THREE.InstancedMesh(
      new THREE.ConeGeometry(0.5, 1, 4),
      makeToon(0xffffff, { unique: true }),
      frondData.length,
    );
    frondMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    frondMesh.castShadow = true;
    const d = this._dummy;
    frondData.forEach((f, i) => {
      frondMesh.setColorAt(i, this._col.setHex(f.col));
      this._writeFrond(d, frondMesh, i, f, 0);
    });
    frondMesh.instanceMatrix.needsUpdate = true;
    frondMesh.instanceColor.needsUpdate = true;
    scene.add(frondMesh);
    this._frondMesh = frondMesh;
    this._fronds = frondData;

    // wall-bracket hanging planters with trailing vines
    for (const s of [-1, 1]) {
      const hx = s * (HW - 0.95);
      const hz = 4.6;
      box.add(PAL.wood, s * (HW - 0.16), 4.0, hz, 0.22, 0.5, 0.14);
      box.add(PAL.wood, s * (HW - 0.55), 4.22, hz, 0.86, 0.11, 0.11);
      box.add(0x4a3a2c, hx, 3.95, hz, 0.03, 0.62, 0.03);
      pot.add(PAL.terracotta, hx, 3.5, hz, 0.72, 0.46, 0.72);
      for (let v = 0; v < 13; v++) {
        const a = rand() * 6.283;
        const r = 0.16 + rand() * 0.2;
        ball.add(v % 3 ? PAL.leaf : PAL.leafDark,
          hx + Math.cos(a) * r, 3.3 - rand() * 0.8, hz + Math.sin(a) * r,
          0.28, 0.15, 0.28, 0, a, 0.4);
      }
    }
  }

  // -------------------------------------------------------------------------
  // wall decor: surfboard, poster, clock, shelf with the sleepy plush
  // -------------------------------------------------------------------------
  _buildDecor(scene, box, boxFlat, cyl, pot, ball, bead, flat) {
    // --- surfboard mounted on the west wall --------------------------------
    ball.add(PAL.cream, -9.66, 2.72, -4.0, 0.26, 0.98, 3.7);
    ball.add(PAL.coral, -9.6, 2.72, -4.0, 0.16, 0.42, 3.4);
    ball.add(PAL.gold, -9.58, 2.72, -4.0, 0.13, 0.14, 3.2);
    box.add(PAL.sky, -9.62, 2.3, -5.4, 0.1, 0.42, 0.3, 0.5, 0, 0);
    for (const z of [-5.1, -2.9]) boxFlat.add(PAL.wood, -9.85, 2.72, z, 0.34, 0.16, 0.5);

    // life ring by the corner
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * 6.283;
      bead.add(i % 2 ? PAL.coral : PAL.cream,
        -9.78, 3.5 + Math.sin(a) * 0.42, -6.7 + Math.cos(a) * 0.42, 0.2, 0.24, 0.24);
    }

    // --- surf poster + clock on the east wall ------------------------------
    const poster = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 2.06), flat(texPoster()));
    poster.rotation.y = -Math.PI / 2;
    poster.position.set(HW - 0.08, 3.3, -3.4);
    scene.add(poster);
    boxFlat.add(PAL.wood, HW - 0.04, 3.3, -3.4, 0.06, 2.24, 1.68);

    const clock = new THREE.Mesh(new THREE.CircleGeometry(0.42, 20), flat(texClock()));
    clock.rotation.y = -Math.PI / 2;
    clock.position.set(HW - 0.08, 3.9, -6.6);
    scene.add(clock);
    cyl.add(PAL.wood, HW - 0.03, 3.9, -6.6, 0.94, 0.1, 0.94, 0, 0, Math.PI / 2);
    const hand = new THREE.Group();
    hand.rotation.y = -Math.PI / 2;
    hand.position.set(HW - 0.12, 3.9, -6.6);
    const handGeo = new THREE.BoxGeometry(0.022, 0.34, 0.022);
    handGeo.translate(0, 0.17, 0);
    hand.add(new THREE.Mesh(handGeo, makeToon(PAL.coral)));
    scene.add(hand);
    this._clockHand = hand;

    // --- shelf with the sleepy capybara plush ------------------------------
    boxFlat.add(PAL.woodLight, HW - 0.34, 2.42, 5.2, 0.6, 0.12, 2.2);
    for (const z of [4.4, 6.0]) boxFlat.add(PAL.wood, HW - 0.2, 2.24, z, 0.3, 0.34, 0.1, 0, 0, 0.4);
    // shelf clutter
    pot.add(PAL.leaf, HW - 0.36, 2.62, 4.5, 0.34, 0.28, 0.34);
    for (let i = 0; i < 5; i++) {
      ball.add(i % 2 ? PAL.leaf : PAL.leafDark, HW - 0.36 + (i % 2) * 0.06, 2.82, 4.5 + (i - 2) * 0.06, 0.26, 0.2, 0.26);
    }
    cyl.add(PAL.cream, HW - 0.36, 2.62, 5.95, 0.3, 0.28, 0.3);
    cyl.add(PAL.mango, HW - 0.36, 2.6, 5.95, 0.26, 0.2, 0.26);

    const plush = new THREE.Group();
    plush.position.set(HW - 0.42, 2.48, 5.25);
    plush.rotation.y = -Math.PI / 2 - 0.25;
    scene.add(plush);
    const parts = [
      [0xb08a5a, 0, 0.2, 0, 0.86, 0.66, 0.7],
      [0xb08a5a, 0, 0.5, 0.06, 0.6, 0.55, 0.58],
      [0xc9a06b, 0, 0.44, 0.24, 0.4, 0.3, 0.32],
      [0xb08a5a, -0.16, 0.66, -0.02, 0.2, 0.17, 0.1],
      [0xb08a5a, 0.16, 0.66, -0.02, 0.2, 0.17, 0.1],
      [0x241a12, -0.13, 0.52, 0.27, 0.13, 0.035, 0.05],
      [0x241a12, 0.13, 0.52, 0.27, 0.13, 0.035, 0.05],
      [0x3a2a1c, 0, 0.47, 0.4, 0.12, 0.07, 0.05],
      [0xb08a5a, -0.2, 0.06, 0.24, 0.24, 0.2, 0.3],
      [0xb08a5a, 0.2, 0.06, 0.24, 0.24, 0.2, 0.3],
      [0xb08a5a, -0.42, 0.24, 0.06, 0.22, 0.34, 0.22, 0, 0, 0.4],
      [0xb08a5a, 0.42, 0.24, 0.06, 0.22, 0.34, 0.22, 0, 0, -0.4],
    ];
    const plushMesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.5, 12, 9), makeToon(0xffffff, { unique: true }), parts.length,
    );
    const d = this._dummy;
    parts.forEach((p, i) => {
      d.position.set(p[1], p[2], p[3]);
      d.scale.set(p[4], p[5], p[6]);
      d.rotation.set(p[7] || 0, p[8] || 0, p[9] || 0);
      d.updateMatrix();
      plushMesh.setMatrixAt(i, d.matrix);
      plushMesh.setColorAt(i, this._col.setHex(p[0]));
    });
    plushMesh.instanceMatrix.needsUpdate = true;
    plushMesh.instanceColor.needsUpdate = true;
    plush.add(plushMesh);
    this._plush = plush;

    // floating sleep z's
    const zMat = flat(texZ(), { transparent: true, depthWrite: false, color: 0xfff3d0 });
    this._zs = [];
    for (let i = 0; i < 2; i++) {
      const z = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.3), zMat);
      z.position.set(HW - 0.8, 3.1, 5.0);
      scene.add(z);
      this._zs.push(z);
    }

    // a couple of framed snapshots beside the plush shelf
    for (const [zz, col] of [[7.0, PAL.coral], [7.0, PAL.sky]]) {
      boxFlat.add(col, HW - 0.1, 3.3 + (col === PAL.sky ? -0.7 : 0), zz, 0.08, 0.5, 0.62);
      boxFlat.add(PAL.cream, HW - 0.15, 3.3 + (col === PAL.sky ? -0.7 : 0), zz, 0.02, 0.36, 0.48);
    }
  }

  // -------------------------------------------------------------------------
  // open south front: planter railing, doorway, signage, hotspot markers
  // -------------------------------------------------------------------------
  _buildEntrance(scene, box, boxFlat, ball, toonMap, flat) {
    const rand = rng(4471);

    // low planter wall either side of the doorway
    for (const s of [-1, 1]) {
      const x0 = s * 2.1;
      const x1 = s * HW;
      const cx = (x0 + x1) / 2;
      const w = Math.abs(x1 - x0);
      box.add(PAL.wainscot, cx, 0.5, 7.75, w, 1.0, 0.7);
      box.add(PAL.woodLight, cx, 1.06, 7.75, w + 0.16, 0.14, 0.86);
      box.add(PAL.coral, cx, 0.62, 7.42, w - 0.3, 0.3, 0.06);
      // trailing greenery along the top
      for (let i = 0; i < 9; i++) {
        const x = x0 + ((i + 0.5) / 9) * (x1 - x0);
        ball.add(i % 3 ? PAL.leaf : PAL.leafDark, x, 1.2, 7.72, 0.62, 0.34, 0.6, 0, rand() * 3, 0.2);
        if (i % 3 === 1) {
          ball.add(i % 2 ? PAL.coral : PAL.gold, x + 0.14, 1.34, 7.66, 0.22, 0.2, 0.22);
        }
      }
      for (let x = x0 + s * 0.7; Math.abs(x) < HW - 0.3; x += s * 1.4) {
        this.obstacles.push({ x, z: 7.85, r: 0.85 });
      }
    }

    // doorway posts (no lintel: nothing crosses the walkway sight lines)
    for (const s of [-1, 1]) {
      box.add(PAL.wood, s * 2.05, 1.5, 7.4, 0.34, 3.0, 0.34);
      box.add(PAL.woodLight, s * 2.05, 3.06, 7.4, 0.48, 0.16, 0.48);
      ball.add(PAL.gold, s * 2.05, 3.24, 7.4, 0.3, 0.34, 0.3);
      // carved tiki bands
      for (let i = 0; i < 3; i++) {
        box.add(i % 2 ? PAL.coral : PAL.gold, s * 2.05, 0.55 + i * 0.75, 7.4, 0.38, 0.1, 0.38);
      }
      this.obstacles.push({ x: s * 2.05, z: 7.4, r: 0.5 });
    }

    const exitSign = new THREE.Mesh(
      new THREE.PlaneGeometry(1.5, 0.47),
      flat(texSign('SUNNY PLAZA', '', '#4fb3e8', '#fff6df')),
    );
    exitSign.position.set(-2.05, 2.42, 7.24);
    exitSign.rotation.y = 0.16;
    scene.add(exitSign);
    boxFlat.add(PAL.cream, -2.05, 2.42, 7.28, 1.6, 0.57, 0.06, 0, 0.16, 0);

    // lantern on the other post
    const lantern = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8), makeGlow(0xffd489));
    lantern.position.set(2.05, 2.5, 7.4);
    scene.add(lantern);
    this._lantern = lantern;
    boxFlat.add(0x4a3a2c, 2.05, 2.72, 7.4, 0.05, 0.35, 0.05);

    // chalk A-frame board welcoming people in
    const aTex = texAFrame();
    for (const s of [-1, 1]) {
      const bd = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 1.3), toonMap(aTex));
      bd.position.set(-3.8 + s * 0.12, 0.78, 6.5 + s * 0.14);
      bd.rotation.set(s * 0.2, s > 0 ? 0 : Math.PI, 0);
      scene.add(bd);
      boxFlat.add(PAL.wood, -3.8 + s * 0.16, 0.78, 6.5 + s * 0.18, 1.05, 1.4, 0.06, s * 0.2, 0, 0);
    }
    box.add(PAL.wood, -3.8, 0.06, 6.5, 1.1, 0.12, 0.7);
    this.obstacles.push({ x: -3.8, z: 6.5, r: 0.75 });

    // --- glowing floor markers for the two hotspots ------------------------
    const ringGeo = new THREE.RingGeometry(0.95, 1.3, 26);
    this._rings = [];
    for (const [x, z, col] of [[0, -4.0, 0xffd489], [0, 7.0, 0x8fd9ff]]) {
      const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
        color: col, transparent: true, opacity: 0.5, depthWrite: false,
      }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(x, 0.02, z);
      scene.add(ring);
      this._rings.push(ring);
    }
    // painted arrow leading to the counter
    for (let i = 0; i < 3; i++) {
      boxFlat.add(PAL.cream, 0, 0.018, -1.6 - i * 0.7, 0.7 - i * 0.14, 0.02, 0.18);
    }
  }

  // -------------------------------------------------------------------------
  update(dt) {
    const t = (this.t += dt);
    const d = this._dummy;

    // ceiling fans + clock
    this._fans[0].rotation.y += dt * 2.4;
    this._fans[1].rotation.y -= dt * 2.1;
    this._clockHand.rotation.z = -Math.floor(t * 2) * 0.1047;

    // blender runs in bursts
    const phase = t % 8;
    const running = phase < 4.2;
    const steam = running ? 1 : Math.max(0, 1 - (phase - 4.2) * 1.3);
    this._juice.rotation.y += dt * (running ? 20 : 1.4);
    this._juice.scale.set(1, 1 + Math.sin(t * 24) * (running ? 0.07 : 0.012), 1);
    this._jar.position.x = this._jarX + (running ? Math.sin(t * 54) * 0.011 : 0);

    // bubbles in the jar + steam curling off the top
    const o = this._puffOrigin;
    for (let i = 0; i < this._puffData.length; i++) {
      const p = this._puffData[i];
      p.t += dt * p.sp * (running ? 1 : 0.3);
      if (p.t > 1) p.t -= 1;
      if (p.jarBubble) {
        d.position.set(
          o.x + Math.sin(p.ph + p.t * 7) * 0.08,
          o.y + 0.06 + p.t * 0.46,
          o.z + Math.cos(p.ph + p.t * 6) * 0.07,
        );
        d.scale.setScalar(p.s * (0.7 + p.t * 0.5) * (running ? 1 : 0.6));
      } else {
        d.position.set(
          o.x + Math.sin(p.ph + p.t * 3) * 0.3 * p.t,
          o.y + 0.95 + p.t * 1.45,
          o.z + Math.cos(p.ph + p.t * 2.4) * 0.22 * p.t,
        );
        d.scale.setScalar(p.s * (1 + p.t * 3.6) * Math.max(0, 1 - p.t) * 1.7 * steam);
      }
      d.updateMatrix();
      this._puffs.setMatrixAt(i, d.matrix);
    }
    this._puffs.instanceMatrix.needsUpdate = true;

    // string lights twinkle
    for (let i = 0; i < this._bulbSeed.length; i++) {
      const k = 0.68 + 0.32 * Math.sin(t * 2.1 + this._bulbSeed[i]);
      this._bulbs.setColorAt(i, this._col.setRGB(k, k * 0.88, k * 0.62));
    }
    this._bulbs.instanceColor.needsUpdate = true;
    this._lantern.scale.setScalar(1 + Math.sin(t * 1.7) * 0.06);

    // bunting flutter
    for (let i = 0; i < this._flagData.length; i++) {
      const f = this._flagData[i];
      d.position.set(f.x, f.y - 0.27 + Math.sin(t * 3 + f.ph) * 0.02, f.z);
      d.rotation.set(Math.sin(t * 3.4 + f.ph) * 0.22, Math.sin(t * 2.1 + f.ph) * 0.3, Math.PI);
      d.scale.setScalar(1);
      d.updateMatrix();
      this._flags.setMatrixAt(i, d.matrix);
    }
    this._flags.instanceMatrix.needsUpdate = true;

    // palm fronds sway
    for (let i = 0; i < this._fronds.length; i++) {
      const f = this._fronds[i];
      const sway = Math.sin(t * 1.05 + f.ph) * 0.05 + Math.sin(t * 0.41 + f.ph * 0.5) * 0.03;
      this._writeFrond(d, this._frondMesh, i, f, sway);
    }
    this._frondMesh.instanceMatrix.needsUpdate = true;

    // hotspot markers breathe
    for (let i = 0; i < this._rings.length; i++) {
      const p = Math.sin(t * 2.3 + i * 1.6);
      this._rings[i].material.opacity = 0.38 + p * 0.2;
      this._rings[i].scale.setScalar(1 + p * 0.07);
    }

    // sleepy plush
    this._plush.scale.y = 1 + Math.sin(t * 1.4) * 0.035;
    this._plush.position.y = 2.48 + Math.sin(t * 1.4) * 0.012;
    for (let i = 0; i < this._zs.length; i++) {
      const k = ((t * 0.32 + i * 0.5) % 1);
      const z = this._zs[i];
      z.position.set(HW - 0.78 - k * 0.3, 3.02 + k * 0.85, 5.02 + Math.sin(k * 6.283) * 0.12);
      z.scale.setScalar(0.5 + k * 0.9);
    }
  }

  dispose() {
    this._fans = null;
    this._jar = null;
    this._juice = null;
    this._puffs = null;
    this._puffData = null;
    this._bulbs = null;
    this._flags = null;
    this._flagData = null;
    this._frondMesh = null;
    this._fronds = null;
    this._rings = null;
    this._plush = null;
    this._zs = null;
    this._clockHand = null;
    this._lantern = null;
    this._batches = null;
  }

  _writeFrond(d, mesh, i, f, sway) {
    const az = f.az + sway * 0.35;
    const tilt = f.tilt + sway;
    const dirX = Math.sin(tilt) * Math.cos(az);
    const dirY = Math.cos(tilt);
    const dirZ = Math.sin(tilt) * Math.sin(az);
    d.position.set(f.cx + dirX * f.len * 0.5, f.cy + dirY * f.len * 0.5, f.cz + dirZ * f.len * 0.5);
    d.rotation.set(0, -az, tilt);
    d.scale.set(f.w, f.len, f.w * 0.2);
    d.updateMatrix();
    mesh.setMatrixAt(i, d.matrix);
  }

  /** three-legged stool with a padded seat */
  _stool(cyl, ball, x, z, h, cushion) {
    cyl.add(PAL.woodLight, x, h, z, 0.66, 0.11, 0.66);
    ball.add(cushion, x, h + 0.09, z, 0.6, 0.16, 0.6);
    for (let l = 0; l < 3; l++) {
      const a = (l / 3) * Math.PI * 2 + 0.5;
      cyl.add(PAL.wood, x + Math.cos(a) * 0.16, h / 2, z + Math.sin(a) * 0.16, 0.08, h, 0.08,
        Math.sin(a) * 0.18, 0, -Math.cos(a) * 0.18);
    }
    cyl.add(PAL.wood, x, h * 0.35, z, 0.62, 0.05, 0.62);
  }

  /** mixed pile of mangoes, bananas and berries on a surface */
  _fruitPile(ball, bead, x, y, z, r, n, rand) {
    for (let i = 0; i < n; i++) {
      const a = rand() * 6.283;
      const d = Math.sqrt(rand()) * r;
      const px = x + Math.cos(a) * d;
      const pz = z + Math.sin(a) * d;
      const py = y + (i % 3) * 0.08;
      const kind = i % 3;
      if (kind === 0) {
        ball.add(PAL.mango, px, py + 0.13, pz, 0.3, 0.26, 0.24, 0, a, 0.3);
      } else if (kind === 1) {
        for (let b = 0; b < 3; b++) {
          bead.add(PAL.banana, px + b * 0.05, py + 0.1 + b * 0.02, pz, 0.11, 0.1, 0.34, 0, a + b * 0.2, 0.4);
        }
      } else {
        for (let b = 0; b < 4; b++) {
          bead.add(b % 2 ? PAL.berry : 0x6f3fa8, px + (rand() - 0.5) * 0.24, py + 0.08, pz + (rand() - 0.5) * 0.24, 0.15, 0.15, 0.15);
        }
      }
    }
  }
}
