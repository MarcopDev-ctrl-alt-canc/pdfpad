import assert from 'node:assert/strict';
import { toLines, toBlocks, documentXml, buildDocx } from '../docx.js';

const it = (str, x, y, size = 11, extra = {}) => ({ str, x, y, w: str.length * size * 0.5, size, bold: false, italic: false, ...extra });
const items = [
  it('Titolo del documento', 150, 60, 22, { bold: true }),
  it('Questa è la prima riga di un paragrafo che', 72, 100),
  it('continua sulla seconda riga.', 72, 114),
  it('Nuovo paragrafo dopo uno spazio.', 72, 150),
  it('• primo punto', 72, 180),
  it('• secondo punto', 72, 194),
  it('Nome', 72, 230), it('Età', 300, 230),
  it('Anna', 72, 245), it('34', 300, 245),
  it('Luca', 72, 260), it('28', 300, 260)
];
const lines = toLines(items);
assert.equal(lines.length, 9);
assert.deepEqual(lines[6].segs.map(s => s.text), ['Nome', 'Età']);

const blocks = toBlocks(lines, 595, 11);
const kinds = blocks.map(b => b.type === 'p' ? (b.heading ? 'h' + b.heading : b.list ? 'li' : 'p') : b.type);
assert.deepEqual(kinds, ['h1', 'p', 'p', 'li', 'li', 'table']);
assert.equal(blocks[1].runs.map(r => r.text).join(''), 'Questa è la prima riga di un paragrafo che continua sulla seconda riga.');
assert.deepEqual(blocks[5].rows, [['Nome', 'Età'], ['Anna', '34'], ['Luca', '28']]);
assert.equal(blocks[0].runs[0].bold, true);

const { xml, media } = documentXml([blocks, [{ type: 'image', y: 0, w: 900, h: 300, data: new Uint8Array([1, 2, 3]) }]]);
assert.equal(media.length, 1);
assert.ok(xml.includes('<w:pStyle w:val="Heading1"/>') && xml.includes('<w:tbl>') && xml.includes('w:type="page"') && xml.includes('r:embed="rIdImg1"'));
assert.ok(xml.includes('cx="5727700"'), 'image capped to text width');

const z = buildDocx([blocks]);
const dv = new DataView(z.buffer), eocd = z.length - 22;
assert.equal(dv.getUint32(eocd, true), 0x06054b50);
assert.equal(dv.getUint16(eocd + 10, true), 5);
assert.equal(dv.getUint32(0, true), 0x04034b50);
console.log('ok');
