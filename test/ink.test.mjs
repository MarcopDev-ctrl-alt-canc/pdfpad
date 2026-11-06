import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { penPath, hlPath, dSeg } from '../ink.js';

const PDFLib = createRequire(import.meta.url)('../lib/pdf-lib.min.js');

assert.equal(dSeg(5, 3, [0, 0], [10, 0]), 3);
assert.equal(dSeg(-4, 3, [0, 0], [10, 0]), 5);
assert.equal(dSeg(1, 1, [0, 0], [0, 0]), Math.SQRT2);

const dot = penPath([[50, 50, 0.5]], 4);
assert.match(dot, /^M .* Z$/);
const nums = dot.match(/-?\d+(\.\d+)?/g).map(Number);
const xs = nums.filter((_, i) => i % 2 === 0), ys = nums.filter((_, i) => i % 2 === 1);
assert.ok(Math.max(...xs) <= 52 && Math.min(...xs) >= 48, 'dot stays within radius');
assert.ok(Math.max(...ys) <= 52 && Math.min(...ys) >= 48, 'dot stays within radius');

const line = [[10, 10, 0.2], [20, 12, 0.5], [30, 15, 0.9], [40, 15, 0.4]];
assert.match(penPath(line, 3), /^M [^Q]+( Q [-\d. ]+)+ Z$/);
assert.equal(hlPath([[1, 2, 0]]), 'M 1 2 L 1.01 2');
assert.equal(hlPath([[0, 0], [10, 0], [20, 10]]), 'M 0 0 Q 10 0 15 5 L 20 10');

const doc = await PDFLib.PDFDocument.create();
const page = doc.addPage([200, 200]);
page.drawSvgPath(penPath(line.map(([x, y, p]) => [x, -y, p]), 3), { x: 0, y: 0, color: PDFLib.rgb(0, 0, 1) });
page.drawSvgPath(hlPath(line.map(([x, y, p]) => [x, -y, p])), {
  x: 0, y: 0, borderColor: PDFLib.rgb(1, 1, 0), borderWidth: 10, borderOpacity: 0.45,
  borderLineCap: PDFLib.LineCapStyle.Round, blendMode: PDFLib.BlendMode.Multiply
});
const out = await doc.save();
assert.ok((await PDFLib.PDFDocument.load(out)).getPageCount() === 1);

console.log('ok');
