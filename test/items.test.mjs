import assert from 'node:assert/strict';
import { markRects, bbox, hit, mapItem, shapeLines } from '../items.js';

const words = [
  { str: 'Ciao mondo', x: 10, y: 10, w: 100, h: 12 },
  { str: 'bello', x: 115, y: 10, w: 50, h: 12 },
  { str: 'seconda riga', x: 10, y: 30, w: 120, h: 12 }
];

let m = markRects(words, 12, 15, 160, 15);
assert.deepEqual(m.rects, [[10, 10, 155, 12]]);
assert.equal(m.text, 'Ciao mondo bello');

m = markRects(words, 60, 15, 80, 35);
assert.equal(m.rects.length, 2);
assert.equal(m.text, 'mondo bello\nseconda');

m = markRects(words, 500, 500, 600, 600);
assert.deepEqual(m, { rects: [], text: '' });

const shape = { tool: 'shape', kind: 'rect', x1: 10, y1: 10, x2: 50, y2: 30, w: 2, color: '#000' };
assert.deepEqual(bbox(shape), [9, 9, 51, 31]);
assert.ok(hit(shape, 30, 20, 0));
assert.ok(!hit(shape, 80, 80, 4));
const big = mapItem(shape, ([x, y]) => [10 + (x - 10) * 2, 10 + (y - 10) * 2], 2);
assert.deepEqual([big.x1, big.y1, big.x2, big.y2, big.w], [10, 10, 90, 50, 4]);
assert.equal(shapeLines({ ...shape, kind: 'arrow' }).length, 2);

const line = { tool: 'shape', kind: 'line', x1: 0, y1: 0, x2: 100, y2: 0, w: 2 };
assert.ok(hit(line, 50, 3, 3));
assert.ok(!hit(line, 50, 20, 3));

const stamp = { tool: 'stamp', x: 5, y: 5, w: 40, h: 20 };
assert.deepEqual(mapItem(stamp, ([x, y]) => [x + 1, y + 2], 1), { ...stamp, x: 6, y: 7 });

console.log('ok');
