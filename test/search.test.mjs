import assert from 'node:assert/strict';
import { fold, pageIndex, findRects } from '../search.js';

assert.equal(fold('Perché È'), 'perche e');
const words = [
  { str: 'La città è bella', x: 0, y: 0, w: 160, h: 10 },
  { str: 'Città nuova', x: 0, y: 20, w: 110, h: 10 }
];
const idx = pageIndex(words);
const hits = findRects(words, idx, 'citta');
assert.equal(hits.length, 2);
assert.deepEqual(hits[0], [[30, 0, 50, 10]]);
assert.deepEqual(hits[1], [[0, 20, 50, 10]]);
assert.equal(findRects(words, idx, 'bella citta').length, 1);
assert.equal(findRects(words, idx, 'bella citta')[0].length, 2);
assert.deepEqual(findRects(words, idx, '   '), []);
console.log('ok');
