import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const skip = /^(\.git|tools|test|precache\.json|sw\.js|.*LICENSE.*|\.nojekyll)$/;
const walk = d => fs.readdirSync(path.join(root, d), { withFileTypes: true })
  .filter(e => !skip.test(e.name))
  .flatMap(e => e.isDirectory() ? walk(path.posix.join(d, e.name)) : [path.posix.join(d, e.name)]);
const files = ['./', ...walk('.').map(f => f.replace(/^\.\//, '')).filter(f => !f.startsWith('lib/tesseract/'))];
fs.writeFileSync(path.join(root, 'precache.json'), JSON.stringify(files));
console.log(files.length, 'files');
