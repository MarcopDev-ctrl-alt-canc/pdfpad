import assert from 'node:assert/strict';
import { homography, filter } from '../scanmath.js';

const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
const sq = homography([[10, 20], [110, 20], [110, 220], [10, 220]]);
assert.ok(near(sq(0, 0), [10, 20]) && near(sq(1, 1), [110, 220]) && near(sq(0.5, 0.5), [60, 120]));
const quad = [[0, 0], [100, 10], [90, 120], [5, 100]];
const H = homography(quad);
for (const [u, v, p] of [[0, 0, quad[0]], [1, 0, quad[1]], [1, 1, quad[2]], [0, 1, quad[3]]]) assert.ok(near(H(u, v), p));

const img = { data: new Uint8ClampedArray([200, 200, 200, 255, 30, 30, 30, 255, 120, 60, 0, 255, 255, 255, 255, 255]) };
filter(img, 'gray');
assert.deepEqual([...img.data.slice(8, 12)], [71, 71, 71, 255]);
assert.equal(filter(img, 'color'), img);
console.log('ok');
