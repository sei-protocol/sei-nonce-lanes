// Generates assets/how-it-works.svg — a hand-drawn explainer of the parallel-nonce design.
// Run: npm run diagram

import rough from 'roughjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const gen = rough.generator();

const W = 1640;
const H = 1240;

const PAPER = '#fdfbf6';
const INK = '#241f1d';
const MAROON = '#600014';
const RED = '#b3261e';
const GREEN = '#2e7d32';
const AMBER = '#a86a00';
const GREY = '#6b625c';

const TINT_RED = '#fbe9e7';
const TINT_GREEN = '#e8f5e9';
const TINT_AMBER = '#fdf3e0';
const TINT_MAROON = '#f7ecee';
const TINT_BLUE = '#eaf1f7';

const FONT = "'Comic Sans MS','Comic Sans','Chalkboard SE',Chalkboard,'Bradley Hand',cursive";

let seed = 1;
const nextSeed = () => seed++;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const out = [];
const push = (s) => out.push(s);

/** Convert a roughjs drawable into SVG <path> elements. */
function draw(drawable) {
  return gen
    .toPaths(drawable)
    .map((p) => {
      const fill = p.fill && p.fill !== 'none' ? p.fill : 'none';
      const stroke = p.stroke && p.stroke !== 'none' ? p.stroke : 'none';
      return `<path d="${p.d}" stroke="${stroke}" stroke-width="${p.strokeWidth ?? 1}" fill="${fill}" stroke-linecap="round" stroke-linejoin="round"/>`;
    })
    .join('');
}

function box(x, y, w, h, { stroke = INK, fill = null, width = 2.2, roughness = 1.5, dash = false } = {}) {
  return draw(
    gen.rectangle(x, y, w, h, {
      stroke,
      strokeWidth: width,
      roughness,
      seed: nextSeed(),
      fill: fill ?? undefined,
      fillStyle: 'solid',
      strokeLineDash: dash ? [10, 8] : undefined,
    }),
  );
}

function text(x, y, s, { size = 17, fill = INK, anchor = 'start', weight = 'normal', italic = false } = {}) {
  return (
    `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" fill="${fill}" ` +
    `text-anchor="${anchor}" font-weight="${weight}"${italic ? ' font-style="italic"' : ''}>${esc(s)}</text>`
  );
}

function arrow(x1, y1, x2, y2, { stroke = INK, width = 2.3, head = 15, roughness = 1.2 } = {}) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const parts = [
    gen.line(x1, y1, x2, y2, { stroke, strokeWidth: width, roughness, seed: nextSeed() }),
    gen.line(x2, y2, x2 - head * Math.cos(angle - 0.45), y2 - head * Math.sin(angle - 0.45), {
      stroke,
      strokeWidth: width,
      roughness: 0.8,
      seed: nextSeed(),
    }),
    gen.line(x2, y2, x2 - head * Math.cos(angle + 0.45), y2 - head * Math.sin(angle + 0.45), {
      stroke,
      strokeWidth: width,
      roughness: 0.8,
      seed: nextSeed(),
    }),
  ];
  return parts.map(draw).join('');
}

/** A titled card with body lines. */
function card(x, y, w, h, { title, lines = [], stroke = INK, fill = null, titleSize = 21, lineSize = 15, titleFill }) {
  push(box(x, y, w, h, { stroke, fill }));
  push(text(x + w / 2, y + 34, title, { size: titleSize, anchor: 'middle', weight: 'bold', fill: titleFill ?? stroke }));
  lines.forEach((line, i) => {
    if (!line) return;
    push(text(x + w / 2, y + 64 + i * 24, line, { size: lineSize, anchor: 'middle', fill: INK }));
  });
}

/* ------------------------------------------------------------------ header */

push(`<rect width="${W}" height="${H}" fill="${PAPER}"/>`);
push(text(60, 58, 'One account. Many transactions. No queue.', { size: 36, weight: 'bold', fill: MAROON }));
push(
  text(60, 92, 'EIP-7702 keeps your address  ·  ERC-4337 gives you parallel nonce lanes  ·  live on Sei EntryPoint v0.8', {
    size: 17,
    fill: GREY,
  }),
);

/* --------------------------------------------------------------- panel one */

push(text(60, 150, 'THE PROBLEM:  one account is one queue', { size: 23, weight: 'bold', fill: RED }));

const p1 = [
  { n: 'nonce 5', s: 'landed  ✓', stroke: GREEN, fill: TINT_GREEN, dash: false },
  { n: 'nonce 6', s: 'DROPPED  ✗', stroke: RED, fill: TINT_RED, dash: false },
  { n: 'nonce 7', s: 'stranded', stroke: AMBER, fill: TINT_AMBER, dash: true },
  { n: 'nonce 8', s: 'stranded', stroke: AMBER, fill: TINT_AMBER, dash: true },
];
p1.forEach((b, i) => {
  const x = 60 + i * 202;
  push(box(x, 178, 170, 80, { stroke: b.stroke, fill: b.fill, dash: b.dash }));
  push(text(x + 85, 210, b.n, { size: 19, anchor: 'middle', weight: 'bold', fill: INK }));
  push(text(x + 85, 236, b.s, { size: 15, anchor: 'middle', fill: b.stroke }));
  if (i < p1.length - 1) push(arrow(x + 176, 218, x + 196, 218, { stroke: GREY, width: 2, head: 11 }));
});

push(text(890, 200, 'one gap freezes everything behind it', { size: 19, weight: 'bold', fill: RED }));
push(text(890, 228, "Sei's Autobahn mempool rejects a nonce gap outright with `bad nonce`,", { size: 14.5, fill: GREY }));
push(text(890, 250, 'and pending-nonce queries just return the confirmed value, so there is', { size: 14.5, fill: GREY }));
push(text(890, 272, 'no queue to inspect. Hence the usual fleet of funded hot wallets.', { size: 14.5, fill: GREY }));

/* --------------------------------------------------------------- panel two */

push(text(60, 348, 'THE FIX:  one funded account, many independent lanes', { size: 23, weight: 'bold', fill: MAROON }));

card(60, 380, 280, 200, {
  title: 'TRADING EOA',
  titleFill: MAROON,
  stroke: MAROON,
  fill: TINT_MAROON,
  lines: ['0xf39F…2266', 'holds ALL inventory', 'delegated once via 7702', '', 'EVM nonce: FROZEN'],
});
push(text(200, 604, 'code = 0xef0100 ‖ LaneAccount', { size: 13.5, anchor: 'middle', fill: GREY, italic: true }));
push(text(200, 626, 'same address · same balance · same approvals', { size: 13.5, anchor: 'middle', fill: GREY, italic: true }));

push(arrow(346, 478, 434, 478));
push(text(390, 440, 'signs 24', { size: 14, anchor: 'middle', weight: 'bold', fill: INK }));
push(text(390, 458, 'intents', { size: 14, anchor: 'middle', weight: 'bold', fill: INK }));
push(text(390, 504, '52ms', { size: 13, anchor: 'middle', fill: GREY }));
push(text(390, 522, '0 RPC', { size: 13, anchor: 'middle', fill: GREY }));

card(440, 380, 250, 200, {
  title: 'PRIVATE MEMPOOL',
  stroke: INK,
  fill: TINT_BLUE,
  lines: ['in-process queue', '', 'no 4-op sender cap', 'no ERC-7562 rules', '(nobody else to protect)'],
});

// Fan out to the relayer stack.
const relayerY = [400, 466, 532, 598];
relayerY.forEach((y) => push(arrow(696, 470, 786, y + 29, { stroke: GREY, width: 2, head: 12 })));

relayerY.forEach((y, i) => {
  push(box(790, y, 240, 58, { stroke: INK, fill: '#ffffff', width: 2 }));
  push(text(910, y + 26, `relayer ${i}`, { size: 16, anchor: 'middle', weight: 'bold', fill: INK }));
  push(text(910, y + 46, 'gas only · no inventory', { size: 12.5, anchor: 'middle', fill: GREY }));
});
push(text(910, 690, 'each burns its OWN sequential nonce,', { size: 13.5, anchor: 'middle', fill: GREY, italic: true }));
push(text(910, 710, 'one tx in flight  →  the queue moved HERE', { size: 13.5, anchor: 'middle', fill: GREY, italic: true }));

// Converge on the EntryPoint.
relayerY.forEach((y) => push(arrow(1034, y + 29, 1122, 490, { stroke: GREY, width: 2, head: 12 })));

card(1126, 395, 260, 190, {
  title: 'EntryPoint v0.8',
  stroke: INK,
  fill: '#ffffff',
  lines: ['0x4337…f108', 'already on Sei', '', 'handleOps(ops[], me)'],
});
push(text(1256, 556, 'nonce = key<<64 | seq', { size: 15, anchor: 'middle', weight: 'bold', fill: MAROON }));

push(arrow(1392, 490, 1452, 490));
push(box(1456, 440, 130, 100, { stroke: INK, fill: TINT_GREEN }));
push(text(1521, 480, 'VENUE', { size: 18, anchor: 'middle', weight: 'bold', fill: GREEN }));
push(text(1521, 506, 'place(…)', { size: 13.5, anchor: 'middle', fill: GREY }));

push(text(1126, 640, 'msg.sender at the venue is still', { size: 13.5, fill: GREY, italic: true }));
push(text(1126, 660, 'the funded EOA, not a proxy.', { size: 13.5, fill: GREY, italic: true }));

/* ------------------------------------------------------------- panel three */

push(text(60, 790, 'THE RESULT:  a failure lands alone', { size: 23, weight: 'bold', fill: GREEN }));

const lanes = [
  { lane: 'lane 29', seq: 'seq 0', res: 'filled  ✓', stroke: GREEN, fill: TINT_GREEN },
  { lane: 'lane 30', seq: 'seq 0', res: 'REVERTED  ✗', stroke: RED, fill: TINT_RED, note: 'limit under mark' },
  { lane: 'lane 31', seq: 'seq 0', res: 'filled  ✓', stroke: GREEN, fill: TINT_GREEN },
  { lane: 'lane 32', seq: 'seq 0', res: 'filled  ✓', stroke: GREEN, fill: TINT_GREEN },
];
lanes.forEach((l, i) => {
  const x = 60 + i * 248;
  push(box(x, 820, 224, 104, { stroke: l.stroke, fill: l.fill }));
  push(text(x + 112, 852, l.lane, { size: 19, anchor: 'middle', weight: 'bold', fill: INK }));
  push(text(x + 112, 876, l.seq, { size: 13.5, anchor: 'middle', fill: GREY }));
  push(text(x + 112, 903, l.res, { size: 16, anchor: 'middle', weight: 'bold', fill: l.stroke }));
  if (l.note) push(text(x + 112, 944, l.note, { size: 12.5, anchor: 'middle', fill: RED, italic: true }));
});

push(box(60, 956, 968, 44, { stroke: GREY, fill: null, width: 1.6, dash: true }));
push(text(544, 984, 'all four in the SAME bundle, in the SAME block', { size: 15.5, anchor: 'middle', fill: GREY }));

push(box(1064, 820, 516, 180, { stroke: MAROON, fill: TINT_MAROON }));
push(text(1090, 856, 'Why they cannot block each other', { size: 18, weight: 'bold', fill: MAROON }));
push(text(1090, 888, 'The EntryPoint keeps one seq counter PER key.', { size: 15 }));
push(text(1090, 914, 'A new key starts at seq 0 at any time.', { size: 15 }));
push(text(1090, 946, 'So an op that reverts, or never lands at all,', { size: 15 }));
push(text(1090, 972, 'advances only its own lane. Nothing waits.', { size: 15, weight: 'bold', fill: MAROON }));

/* ------------------------------------------------------------------ footer */

push(box(60, 1032, 1520, 82, { stroke: INK, fill: '#ffffff', width: 2.4 }));
push(text(88, 1070, '24 submitted', { size: 20, weight: 'bold', fill: INK }));
push(text(88, 1096, 'in one run', { size: 13, fill: GREY }));
push(text(330, 1070, '24 landed', { size: 20, weight: 'bold', fill: GREEN }));
push(text(330, 1096, 'none stranded', { size: 13, fill: GREY }));
push(text(560, 1070, '1 reverted', { size: 20, weight: 'bold', fill: RED }));
push(text(560, 1096, 'alone, on its own lane', { size: 13, fill: GREY }));
push(text(860, 1070, 'trader EVM nonce  89 → 89', { size: 20, weight: 'bold', fill: MAROON }));
push(text(860, 1096, 'the trading key never entered a queue', { size: 13, fill: GREY }));
push(text(1330, 1070, '4 relayers', { size: 20, weight: 'bold', fill: INK }));
push(text(1330, 1096, 'gas only, disposable', { size: 13, fill: GREY }));

push(text(60, 1160, 'forge test  ·  12 passing, including "a dropped op strands nothing behind it"', { size: 14.5, fill: GREY, italic: true }));
push(text(60, 1186, 'Independent nonces remove the submission bottleneck. Disjoint state is what buys parallel execution.', { size: 14.5, fill: GREY, italic: true }));

/* ------------------------------------------------------------------- write */

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
${out.join('\n')}
</svg>
`;

const target = resolve(dirname(fileURLToPath(import.meta.url)), '../../assets/how-it-works.svg');
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, svg);
console.log(`wrote ${target} (${(svg.length / 1024).toFixed(1)} KB)`);
