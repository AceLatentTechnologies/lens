// verbs: add <kind> "<note>" [k=v ...]   |   supersede <id> "<note>" [k=v ...]   (supersede copies the target's fields forward)
const [V, a1, note, ...rest] = process.argv.slice(2);
const by = E.WL_BY; if (!by) die('set WL_BY=<agent id>');
if (!a1 || !note) die(`usage: wl ${V} <${V === 'add' ? 'kind' : 'id'}> "<note>" [k=v ...]`);
const extra = kv(rest);
for (const k of RESERVED) if (k in extra && !(k === 'id' && V === 'add')) die('reserved field ' + k);
const at = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const rid = es => { let i; do i = Array.from({length: 6}, () => 'abcdefghijklmnopqrstuvwxyz'[Math.random() * 26 | 0]).join(''); while (es.some(e => e.id === i)); return i; };
const out = append((es, rl) => {
  if (V === 'add') {
    const {id: given, ...fields} = extra, id = given || rid(es);
    if (es.some(e => e.id && e.id.split('~')[0] === id.split('~')[0])) die('id exists (use supersede): ' + id);
    return {id, at, kind: a1, by, note, ...fields};
  }
  const t = es.find(e => e.id === a1); if (!t) die('no such id ' + a1);
  if (!heads(es).some(e => e.id === a1)) die(`${a1} is already superseded; supersede its head`);
  const {_f, _n, id: _i, at: _a, by: _b, note: _no, supersedes: _s, ...keep} = t;
  const [base, n] = a1.split('~');
  return {id: `${base}~${(+n || 1) + 1}`, at, kind: t.kind, by, supersedes: a1, note, ...keep, ...extra};
});
console.log(`${out.e.id} ${out.e.kind} ${E.WL_BRANCH || 'wh-log'}@${out.c.slice(0, 7)}`);
