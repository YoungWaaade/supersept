// Pixel-art bot avatars for agents, in Supersept's art direction: the [SP] pixel mark style
// and the "ember" palette. Drawn on a 16×16 grid, rendered crisp at any size.

export const BOT_COLORS = {
  roux: '#d9602a',
  jaune: '#f2c230',
  ember: '#e07850',
  sable: '#e5c07b',
  sauge: '#7ec699',
  ciel: '#61afef',
  lilas: '#c678dd',
  corail: '#dc6b6b',
  galet: '#a8a5a3',
};
// The team lead (Nami) has her own look: ginger colour, hair tuft and big blue bow. These parts are
// not offered for other agents, nor picked at random.
export const RESERVED = ['roux', 'meche', 'ruban', 'cils', 'ronde'];
export const BOT_SHAPES = ['carree', 'ronde'];
export const PICKABLE_COLORS = Object.keys(BOT_COLORS).filter((c) => !RESERVED.includes(c));
export const BOT_EYES = ['ronds', 'joyeux', 'pixels', 'endormis', 'etoiles', 'cils'];
export const BOT_MOUTHS = ['sourire', 'o', 'neutre', 'langue'];
export const BOT_ANTENNAS = ['boule', 'double', 'eclair', 'aucune', 'meche'];
export const BOT_ACCESSORIES = ['aucun', 'palette', 'loupe', 'plume', 'casque', 'noeud', 'cle', 'ruban'];
export const pickable = (list) => list.filter((x) => !RESERVED.includes(x));
export const BOT_LABELS = {
  ronds: 'Ronds', joyeux: 'Joyeux', pixels: 'Pixels', endormis: 'Endormis', etoiles: 'Étoiles',
  sourire: 'Sourire', o: 'Oh', neutre: 'Neutre', langue: 'Langue',
  boule: 'Boule', double: 'Double', eclair: 'Éclair', aucune: 'Aucune', meche: 'Mèche',
  aucun: 'Aucun', palette: 'Palette', loupe: 'Loupe', plume: 'Plume', casque: 'Casque', noeud: 'Nœud', cle: 'Clé', ruban: 'Grand nœud',
};

const BG = '#151110';
const mix = (hex, to, t) => {
  const a = parseInt(hex.slice(1), 16), b = parseInt(to.slice(1), 16);
  const c = [16, 8, 0].map((s) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t));
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
};

// "ember,joyeux,sourire,boule,loupe" ⇄ object. Unknown or missing parts fall back to a stable pick.
const hash = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
export function parseAvatar(spec, seed = '') {
  const parts = String(spec || '').split(',');
  const h = hash(seed || spec || 'bot');
  const pick = (list, i, val) => (list.includes(val) ? val : list[(h >> (i * 3)) % list.length]);
  return {
    color: Object.keys(BOT_COLORS).includes(parts[0]) ? parts[0] : pick(PICKABLE_COLORS, 0),
    eyes: BOT_EYES.includes(parts[1]) ? parts[1] : pick(pickable(BOT_EYES), 1),
    mouth: pick(BOT_MOUTHS, 2, parts[2]),
    antenna: BOT_ANTENNAS.includes(parts[3]) ? parts[3] : pick(pickable(BOT_ANTENNAS), 3),
    accessory: parts[4] && BOT_ACCESSORIES.includes(parts[4]) ? parts[4] : 'aucun',
    shape: BOT_SHAPES.includes(parts[5]) ? parts[5] : 'carree',
  };
}
export const avatarSpec = (a) => [a.color, a.eyes, a.mouth, a.antenna, a.accessory, ...(a.shape && a.shape !== 'carree' ? [a.shape] : [])].join(',');
export function randomAvatar() {
  const r = (l) => l[Math.floor(Math.random() * l.length)];
  return { color: r(PICKABLE_COLORS), eyes: r(BOT_EYES), mouth: r(BOT_MOUTHS), antenna: r(pickable(BOT_ANTENNAS)), accessory: r(pickable(BOT_ACCESSORIES)) };
}

function draw(a) {
  const base = BOT_COLORS[a.color] || BOT_COLORS.ember;
  const P = { D: mix(base, BG, 0.55), B: base, L: mix(base, '#ffffff', 0.38), S: '#2a1f1c', E: mix(base, '#ffffff', 0.72), F: mix(base, '#fff6ee', 0.82), W: '#ffffff', C: '#f4a0a0', K: '#eae8e6', G: '#5c5856', H: mix(base, '#7a2a0c', 0.35), U: '#61afef', V: '#3a7fc4', Y: '#a9d6fa' };
  const px = new Map();
  const set = (x, y, c) => { if (x >= 0 && x < 16 && y >= 0 && y < 16) px.set(`${x},${y}`, c); };
  const rect = (x0, y0, x1, y1, c) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, c); };
  const dots = (list, c) => list.forEach(([x, y]) => set(x, y, c));

  // Antenna (drawn first, the head overlaps its base).
  if (a.antenna === 'boule') { rect(7, 1, 8, 2, 'D'); rect(7, 0, 8, 0, 'L'); }
  if (a.antenna === 'double') { dots([[5, 2], [10, 2], [4, 1], [11, 1]], 'D'); dots([[4, 0], [11, 0]], 'L'); }
  if (a.antenna === 'eclair') { dots([[8, 0], [7, 1], [8, 1], [8, 2]], 'L'); dots([[7, 2]], 'D'); }
  // Hair tuft: a little ginger curl falling over the top of the head.
  if (a.antenna === 'meche') { dots([[6, 1], [7, 0], [8, 0], [9, 1], [7, 1], [8, 1], [5, 2], [6, 2], [7, 2]], 'H'); dots([[8, 1], [6, 2]], 'D'); }

  const round = a.shape === 'ronde';
  if (round) {
    // Round head (Nami): a soft circle-ish outline instead of a box, small ears.
    const rows = { 3: [4, 11], 4: [3, 12], 5: [2, 13], 6: [2, 13], 7: [2, 13], 8: [2, 13], 9: [2, 13], 10: [2, 13], 11: [3, 12], 12: [4, 11] };
    const inside = (x, y) => rows[y] && x >= rows[y][0] && x <= rows[y][1];
    for (const y of Object.keys(rows).map(Number)) for (let x = rows[y][0]; x <= rows[y][1]; x++) {
      const edge = !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1);
      set(x, y, edge ? 'D' : 'B');
    }
    rect(5, 4, 7, 4, 'L'); set(4, 5, 'L');
    rect(1, 7, 1, 8, 'D'); rect(14, 7, 14, 8, 'D');
  } else {
    // Head: rounded box with outline, highlight and ears.
    rect(2, 3, 13, 12, 'D');
    rect(3, 4, 12, 11, 'B');
    [[2, 3], [13, 3], [2, 12], [13, 12]].forEach(([x, y]) => px.delete(`${x},${y}`));
    rect(4, 4, 6, 4, 'L');
    set(3, 5, 'L');
    rect(0, 6, 1, 9, 'D'); rect(1, 7, 1, 8, 'B');
    rect(14, 6, 15, 9, 'D'); rect(14, 7, 14, 8, 'B');
  }

  // Face: a soft cream plate with dark eyes and a sparkle, like a little kawaii robot.
  rect(4, 5, 11, 10, 'F');
  [[4, 5], [11, 5], [4, 10], [11, 10]].forEach(([x, y]) => set(x, y, 'B'));
  if (round) { rect(3, 6, 3, 9, 'F'); rect(12, 6, 12, 9, 'F'); }

  // Eyes.
  if (a.eyes === 'ronds') { rect(5, 6, 6, 7, 'S'); rect(9, 6, 10, 7, 'S'); dots([[5, 6], [9, 6]], 'W'); }
  if (a.eyes === 'pixels') { rect(6, 6, 6, 7, 'S'); rect(9, 6, 9, 7, 'S'); }
  if (a.eyes === 'joyeux') { dots([[5, 7], [6, 6], [7, 7], [8, 7], [9, 6], [10, 7]], 'S'); }
  if (a.eyes === 'endormis') { rect(5, 7, 6, 7, 'S'); rect(9, 7, 10, 7, 'S'); }
  // Big eyes with a sparkle and a lash on the outer corner.
  if (a.eyes === 'cils' && round) {
    // Big, tall, wide-set eyes (2×3) with a sparkle on top and a lash flicking outwards.
    rect(4, 6, 5, 8, 'S'); rect(10, 6, 11, 8, 'S'); dots([[4, 6], [10, 6]], 'W'); dots([[3, 6], [12, 6]], 'S');
  } else if (a.eyes === 'cils') { rect(5, 6, 6, 7, 'S'); rect(9, 6, 10, 7, 'S'); dots([[5, 6], [9, 6]], 'W'); dots([[4, 6], [11, 6]], 'S'); }
  if (a.eyes === 'etoiles') { dots([[6, 6], [5, 7], [7, 7], [6, 8], [9, 6], [8, 7], [10, 7], [9, 8]], 'B'); dots([[6, 7], [9, 7]], 'W'); }

  // Mouth.
  if (a.mouth === 'sourire') dots([[6, 9], [7, 10], [8, 10], [9, 9]], 'S');
  if (a.mouth === 'o') rect(7, 9, 8, 10, 'S');
  if (a.mouth === 'neutre') rect(7, 9, 8, 9, 'S');
  if (a.mouth === 'langue') { dots([[6, 9], [9, 9]], 'S'); rect(7, 9, 8, 9, 'S'); rect(7, 10, 8, 10, 'C'); }
  // Cheeks: always a little blush, it's what makes them cute.
  dots([[4, 9], [11, 9]], 'C');
  if (round) { px.delete('4,9'); px.delete('11,9'); dots([[3, 9], [4, 9], [11, 9], [12, 9]], 'C'); }

  // Neck + tiny body (rounded shoulders for the round shape).
  rect(7, 13, 8, 13, 'D');
  if (round) {
    rect(5, 14, 10, 14, 'D'); rect(4, 15, 11, 15, 'D'); rect(6, 14, 9, 15, 'B'); set(7, 15, 'L');
  } else {
    rect(4, 14, 11, 15, 'D');
    rect(5, 14, 10, 15, 'B');
    set(7, 15, 'L');
  }

  // Accessories.
  if (a.accessory === 'palette') {
    rect(11, 11, 15, 14, 'K'); [[11, 11], [15, 11], [15, 14]].forEach(([x, y]) => px.delete(`${x},${y}`));
    set(12, 12, 'C'); set(14, 12, 'L'); set(13, 13, '#61afef'); set(12, 14, 'D');
  }
  if (a.accessory === 'loupe') {
    dots([[12, 10], [13, 10], [11, 11], [14, 11], [11, 12], [14, 12], [12, 13], [13, 13]], 'K');
    rect(12, 11, 13, 12, 'E'); dots([[14, 14], [15, 15]], 'G');
  }
  if (a.accessory === 'plume') { dots([[15, 9], [14, 10], [15, 10], [13, 11], [14, 11], [12, 12], [13, 12]], 'K'); dots([[11, 13], [10, 14]], 'G'); }
  if (a.accessory === 'casque') { rect(3, 2, 12, 2, 'G'); dots([[2, 3], [13, 3]], 'G'); rect(0, 5, 1, 10, 'G'); rect(14, 5, 15, 10, 'G'); }
  if (a.accessory === 'noeud') { dots([[10, 2], [11, 1], [11, 2], [11, 3], [13, 1], [13, 2], [13, 3], [14, 2]], 'C'); set(12, 2, 'L'); }
  // Big blue bow on the side of the head.
  if (a.accessory === 'ruban') {
    dots([[9, 1], [10, 1], [9, 2], [10, 2], [11, 2], [9, 3], [10, 3]], 'U');
    dots([[13, 1], [14, 1], [12, 2], [13, 2], [14, 2], [13, 3], [14, 3]], 'U');
    set(12, 2, 'V'); set(11, 2, 'V'); dots([[9, 1], [14, 1]], 'Y');
  }
  if (a.accessory === 'cle') { rect(12, 11, 14, 13, 'sable'); set(13, 12, 'S'); rect(13, 14, 13, 15, 'sable'); set(14, 15, 'sable'); }

  return [...px].map(([k, c]) => { const [x, y] = k.split(',').map(Number); return { x, y, fill: P[c] || BOT_COLORS[c] || c }; });
}

export default function BotAvatar({ spec, seed, size = 16, className = '' }) {
  const a = typeof spec === 'object' && spec ? spec : parseAvatar(spec, seed);
  return (
    <svg className={`bot-avatar ${className}`} width={size} height={size} viewBox="0 0 16 16" shapeRendering="crispEdges" aria-hidden="true">
      {draw(a).map(({ x, y, fill }) => <rect key={`${x},${y}`} x={x} y={y} width="1.02" height="1.02" fill={fill} />)}
    </svg>
  );
}
