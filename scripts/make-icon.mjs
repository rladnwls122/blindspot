import zlib from 'node:zlib';
import fs from 'node:fs';

// 128x128 marketplace icon, generated rather than committed as an opaque blob:
// a review gutter where the unread band is the only thing with colour in it.
const S = 128;
const px = Buffer.alloc(S * S * 3);
const set = (x, y, [r, g, b]) => {
  const i = (y * S + x) * 3;
  px[i] = r; px[i + 1] = g; px[i + 2] = b;
};

const BG = [0x0d, 0x11, 0x17];
const READ = [0x30, 0x3a, 0x46];
const UNREAD = [0xf9, 0x73, 0x16];

// Code lines of varying length, the middle band unread.
const rows = [];
for (let i = 0; i < 9; i++) rows.push({ y: 20 + i * 10, w: [56, 74, 40, 66, 84, 48, 70, 38, 60][i], unread: i >= 3 && i <= 5 });

for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) set(x, y, BG);

for (const r of rows) {
  const colour = r.unread ? UNREAD : READ;
  for (let dy = 0; dy < 6; dy++) {
    for (let x = 34; x < 34 + r.w; x++) set(x, r.y + dy, colour);
  }
  // Gutter marker: only unread lines get one.
  if (r.unread) for (let dy = 0; dy < 6; dy++) for (let x = 22; x < 27; x++) set(x, r.y + dy, UNREAD);
}

const raw = Buffer.alloc(S * (S * 3 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 3 + 1)] = 0;
  px.copy(raw, y * (S * 3 + 1) + 1, y * S * 3, (y + 1) * S * 3);
}

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
};

let table;
function crc32(buf) {
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = -1;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 2;

fs.writeFileSync('media/icon.png', Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]));
console.log('wrote media/icon.png');
