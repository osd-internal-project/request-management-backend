// Static companion to the runtime TenantGuard (libs/share/src/modules/prisma/tenant-guard.ts):
// lists `<client>.<model>.<read|bulk-write>(...)` calls on company-owned models
// whose argument text never mentions companyId. Run: node scripts/tenant-scan.js
const fs = require('fs');
const path = require('path');
const { Prisma } = require('@prisma/client');

const GUARDED = ['findMany', 'findFirst', 'findFirstOrThrow', 'count', 'aggregate', 'groupBy', 'updateMany', 'deleteMany'];
const scoped = new Set(
  Prisma.dmmf.datamodel.models
    .filter((m) => m.fields.some((f) => f.name === 'companyId'))
    .map((m) => m.name[0].toLowerCase() + m.name.slice(1)),
);

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'dist' ? [] : files(p);
    return p.endsWith('.ts') && !p.endsWith('.spec.ts') && !p.endsWith('.e2e-spec.ts') ? [p] : [];
  });
}

/** The argument text of the call opened at `start` (index of '('), by paren depth. */
function argsAt(src, start) {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(start + 1, i);
  }
  return '';
}

const call = new RegExp(`\\.([a-z][A-Za-z]+)\\.(${GUARDED.join('|')})\\(`, 'g');
const root = path.resolve(__dirname, '..');
const hits = [];
for (const file of ['services', 'libs/share/src'].flatMap((d) => files(path.join(root, d)))) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(call)) {
    if (!scoped.has(m[1])) continue;
    const args = argsAt(src, m.index + m[0].length - 1);
    if (args.includes('companyId')) continue;
    const line = src.slice(0, m.index).split('\n').length;
    hits.push({ where: `${path.relative(root, file)}:${line}`, call: `${m[1]}.${m[2]}`, module: path.relative(root, file).split('/').slice(0, 4).join('/') });
  }
}

const byModule = {};
for (const h of hits) byModule[h.module] = (byModule[h.module] ?? 0) + 1;
console.log(`candidates: ${hits.length}`);
for (const [mod, n] of Object.entries(byModule).sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(4)}  ${mod}`);
if (process.argv.includes('--list')) for (const h of hits) console.log(`${h.where}  ${h.call}`);
