const LIST = /^([•·▪◦‣○■□\-–—*]|\d{1,3}[.)]|[a-z][.)])\s+/;
const TEXT_W = 451;

const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 12; };

export function toLines(items) {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x), lines = [];
  for (const it of sorted) {
    const line = lines.find(l => Math.abs(l.y - it.y) < Math.max(l.size, it.size) * 0.35);
    if (line) { line.items.push(it); line.size = Math.max(line.size, it.size); }
    else lines.push({ y: it.y, size: it.size, items: [it] });
  }
  for (const l of lines) {
    l.items.sort((a, b) => a.x - b.x);
    l.x0 = l.items[0].x;
    l.x1 = Math.max(...l.items.map(i => i.x + i.w));
    l.runs = [];
    l.segs = [];
    let prev = null, seg = null;
    for (const it of l.items) {
      const gap = prev ? it.x - (prev.x + prev.w) : 0;
      if (!seg || gap > l.size * 1.8) { seg = { x: it.x, text: '' }; l.segs.push(seg); }
      const sep = prev && gap > l.size * 0.15 && !/\s$/.test(prev.str) && !/^\s/.test(it.str) ? ' ' : '';
      seg.text += (seg.text ? sep : '') + it.str;
      const last = l.runs[l.runs.length - 1];
      if (last && last.bold === it.bold && last.italic === it.italic && Math.abs(last.size - it.size) < 0.5) last.text += sep + it.str;
      else l.runs.push({ text: (l.runs.length ? sep : '') + it.str, bold: it.bold, italic: it.italic, size: it.size });
      prev = it;
    }
    l.text = l.runs.map(r => r.text).join('');
  }
  return lines.sort((a, b) => a.y - b.y);
}

export function toBlocks(lines, pageW, body = median(lines.flatMap(l => l.items.map(i => i.size)))) {
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let j = i;
    while (j + 1 < lines.length && lines[j + 1].segs.length === l.segs.length && l.segs.length >= 2 &&
      lines[j + 1].segs.every((s, k) => Math.abs(s.x - l.segs[k].x) < l.size * 1.5) && lines[j + 1].y - lines[j].y < l.size * 2.6) j++;
    if (l.segs.length >= 2 && j > i) {
      blocks.push({ type: 'table', y: l.y, rows: lines.slice(i, j + 1).map(r => r.segs.map(s => s.text.trim())), size: l.size });
      i = j;
      continue;
    }
    const heading = l.size >= body * 1.6 ? 1 : l.size >= body * 1.25 ? 2 : 0;
    const list = LIST.test(l.text.trim());
    const center = Math.abs((l.x0 + l.x1) / 2 - pageW / 2) < pageW * 0.04 && l.x1 - l.x0 < pageW * 0.7 && l.x0 > pageW * 0.15;
    const prev = blocks[blocks.length - 1];
    const joins = prev?.type === 'p' && !heading && !prev.heading && !list && !prev.center && !center &&
      Math.abs(prev.size - l.size) < 0.6 && l.y - prev.lastY < l.size * 1.75 && Math.abs(l.x0 - prev.x0) < l.size * 2.5 &&
      !/[:;]$/.test(prev.lastText.trim());
    if (joins) {
      const glue = /-$/.test(prev.lastText) ? '' : ' ';
      if (glue === '') prev.runs[prev.runs.length - 1].text = prev.runs[prev.runs.length - 1].text.replace(/-$/, '');
      const [first, ...rest] = l.runs;
      prev.runs.push({ ...first, text: glue + first.text.trimStart() }, ...rest);
      prev.lastY = l.y;
      prev.lastText = l.text;
    } else {
      blocks.push({ type: 'p', y: l.y, lastY: l.y, x0: l.x0, size: l.size, heading, list, center, runs: l.runs.map(r => ({ ...r })), lastText: l.text, indent: Math.max(0, l.x0 - 72) });
    }
  }
  return blocks;
}

const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
const run = r => `<w:r><w:rPr>${r.bold ? '<w:b/>' : ''}${r.italic ? '<w:i/>' : ''}<w:sz w:val="${Math.round(r.size * 2)}"/></w:rPr><w:t xml:space="preserve">${esc(r.text)}</w:t></w:r>`;

function para(b) {
  const pPr = [
    b.heading ? `<w:pStyle w:val="Heading${b.heading}"/>` : '',
    '<w:spacing w:after="120"/>',
    b.list ? '<w:ind w:left="720" w:hanging="360"/>' : '',
    b.center ? '<w:jc w:val="center"/>' : ''
  ].join('');
  return `<w:p><w:pPr>${pPr}</w:pPr>${b.runs.map(run).join('')}</w:p>`;
}

function table(b) {
  const cols = Math.max(...b.rows.map(r => r.length)), w = Math.floor(TEXT_W * 20 / cols);
  const border = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(s => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="999999"/>`).join('');
  const rows = b.rows.map(r => `<w:tr>${Array.from({ length: cols }, (_, k) =>
    `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/></w:tcPr><w:p>${run({ text: r[k] || '', size: b.size })}</w:p></w:tc>`).join('')}</w:tr>`).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${border}</w:tblBorders></w:tblPr><w:tblGrid>${'<w:gridCol w:w="' + w + '"/>'.repeat(cols)}</w:tblGrid>${rows}</w:tbl><w:p/>`;
}

function image(b, n) {
  const k = Math.min(1, TEXT_W / b.w), cx = Math.round(b.w * k * 12700), cy = Math.round(b.h * k * 12700);
  return `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${n}" name="Immagine ${n}"/>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${n}" name="img${n}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="rIdImg${n}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

export function documentXml(pages) {
  let n = 0;
  const media = [];
  const body = pages.map(blocks => blocks.map(b => {
    if (b.type === 'table') return table(b);
    if (b.type === 'image') { media.push(b.data); return image(b, ++n); }
    return para(b);
  }).join('')).join('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
  const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>' + body +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>';
  return { xml, media };
}

const STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:lang w:val="it-IT"/></w:rPr></w:rPrDefault></w:docDefaults>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>' +
  '</w:styles>';

function crc32(buf) {
  let c, crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xFF;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

export function zip(files) {
  const enc = new TextEncoder(), parts = [], central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = typeof content === 'string' ? enc.encode(content) : content, nm = enc.encode(name), crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
    local.setUint16(10, 0, true); local.setUint16(12, 0x21, true); local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true); local.setUint32(22, data.length, true); local.setUint16(26, nm.length, true);
    parts.push(new Uint8Array(local.buffer), nm, data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true);
    cd.setUint16(14, 0x21, true); cd.setUint32(16, crc, true); cd.setUint32(20, data.length, true); cd.setUint32(24, data.length, true);
    cd.setUint16(28, nm.length, true); cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), nm);
    offset += 30 + nm.length + data.length;
  }
  const size = central.reduce((s, p) => s + p.length, 0), end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, size, true); end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)], out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of all) { out.set(p, o); o += p.length; }
  return out;
}

export function buildDocx(pages) {
  const { xml, media } = documentXml(pages);
  const rels = media.map((_, i) => `<Relationship Id="rIdImg${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${i + 1}.jpeg"/>`).join('');
  return zip([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${rels}</Relationships>`],
    ['word/document.xml', xml],
    ['word/styles.xml', STYLES],
    ...media.map((m, i) => [`word/media/image${i + 1}.jpeg`, m])
  ]);
}
