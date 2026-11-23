// verbs: ls [kind]   |   render [kind] [id-prefix]   (default kind: item). Read-only; exit 0 always.
const [V, kind = 'item', pre = ''] = process.argv.slice(2);
const es = load(E.WL_TIP).filter(e => e.id), by = new Map(es.map(e => [e.id, e])), sm = supMap(es);
const hs = heads(es), nat = (a, b) => a.id.localeCompare(b.id, 'en', {numeric: true});
const succ = id => { let x = id; while (sm.has(x)) x = sm.get(x)[0]; return x; };          // latest revision of a line
const hist = e => { const o = []; let x = e; while (x.supersedes && by.has(x.supersedes)) { x = by.get(x.supersedes); o.push(x); } return o; };
const cut = (s, n) => (s || '').length > n ? s.slice(0, n - 1) + '~' : (s || '');
if (V === 'ls') {
  for (const e of hs.filter(e => e.kind === kind && e.id.startsWith(pre)).sort(nat)) console.log(`${e.id} ${e.kind} ${e.by} ${e.supersedes ? '(rev) ' : ''}${cut(e.note, 70)}`);
  process.exit(0);
}
const stale = [];  // dependents (`of` = X) of a superseded line X: propagate with the successor's note
for (const z of hs) if (z.of && sm.has(z.of)) { const h = by.get(succ(z.of)); stale.push(`STALE ${z.kind} ${z.id}: of ${z.of}, superseded by ${h.id} (${cut(h.note, 60)})`); }
const stl = new Set(stale.map(s => s.split(' ')[2].replace(':', '')));
console.log(`# ${kind} heads=${hs.filter(e => e.kind === kind).length} superseded=${es.filter(e => sm.has(e.id) && e.kind === kind).length} stale=${stale.length}`);
for (const e of hs.filter(e => e.kind === kind && e.id.startsWith(pre)).sort(nat)) {
  let line;
  if (kind === 'item') {
    const depth = e.id.split('~')[0].split('.').length - 1;
    const ps = hs.filter(p => p.kind === 'proof' && p.of === e.id);
    const kids = hs.filter(k => k.kind === 'item' && k.id !== e.id && k.id.split('~')[0].startsWith(e.id.split('~')[0] + '.') && k.id.split('~')[0].split('.').length === depth + 2);
    const mark = e.criterion ? (ps.length ? `[x]` : (hs.some(p => p.kind === 'proof' && by.get(p.of) && succ(p.of) === e.id) ? '[ ] STALE-PROOF' : '[ ]')) : '[-]';
    line = `${'  '.repeat(depth)}${mark} ${e.id} ${e.criterion ? `${e.criterion} | proof: ${e.proof} | ${e.r}${ps.length ? ` | at ${ps[0].commit}` : ""}` : cut(e.note, 90)}${kids.length ? ` (${kids.length} sub)` : ''}`;
  } else line = `${e.id} ${e.by} ${cut(e.note, 80)}${stl.has(e.id) ? ' STALE' : ''}`;
  console.log(line);
  for (const h of hist(e)) console.log(`${'  '.repeat(kind === 'item' ? e.id.split('~')[0].split('.').length : 1)}<- ${h.id}: ${cut(h.note, 70)}`);
}
for (const s of stale) console.log(s);
