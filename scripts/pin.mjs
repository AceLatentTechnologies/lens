// verbs (cwd = the project repo, never the log branch): pin plan [ref] [--snap] | pin rec <seam> <result> [k=v ...] | pin ls
// seams.json {seams:{<id>:{files:[],calls:[]}}}; pin(s) = H(own(files at ref), sorted pin(callees)); green = a `run` head with result=pass at that sum.
const [, sub = 'ls', ...a] = process.argv.slice(2);
const need = () => E.WL_BY || die('set WL_BY=<agent id> (this verb records a line)');
if ((sub === 'plan' && a.includes('--snap')) || sub === 'rec') need();   // before any output or state
const ref = a.find(x => !x.startsWith('-') && sub === 'plan') || 'HEAD';
const sg = () => JSON.parse(raw(['show', `${ref}:seams.json`])).seams;
function pins() {
  const g = sg(), memo = {}, order = [];
  const own = id => sha(g[id].files.slice().sort().map(f => { try { return f + ' ' + git(['rev-parse', `${ref}:${f}`]); } catch { return f + ' -'; } }).join('\n'));
  const pin = id => memo[id] || (order.push(id), memo[id] = sha(own(id) + '\n' + (g[id].calls || []).slice().sort().map(pin).join('\n')));
  Object.keys(g).sort().forEach(pin);
  return {g, memo, order: (() => { const o = [], s = new Set(), v = id => { if (s.has(id)) return; s.add(id); (g[id].calls || []).forEach(v); o.push(id); }; Object.keys(g).sort().forEach(v); return o; })()};
}
const runs = () => heads(load(E.WL_TIP)).filter(e => e.kind === 'run');
if (sub === 'plan') {
  const {g, memo, order} = pins(), rs = runs(), st = {}, lines = [];
  for (const id of order) {
    if (rs.some(r => r.seam === id && r.sum === memo[id] && r.result === 'pass')) st[id] = 'skip';
    else { const bad = (g[id].calls || []).find(c => st[c] !== 'skip' && (st[c].startsWith('blocked') || rs.some(r => r.seam === c && r.sum === memo[c] && r.result === 'fail'))); st[id] = bad ? 'blocked:' + bad : 'run'; }
    lines.push(`${id} ${memo[id].slice(0, 7)} ${st[id]}`);
  }
  console.log(`snap=${git(['rev-parse', `${ref}^{tree}`]).slice(0, 7)} commit=${git(['rev-parse', ref]).slice(0, 7)}`); lines.forEach(l => console.log(l));
  if (a.includes('--snap')) { const c = git(['rev-parse', ref]); console.log(append((es) => ({id: 'snap-' + c.slice(0, 7), at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), kind: 'snap', by: need(), note: 'snapshot ' + c.slice(0, 7), commit: c, sums: order.map(i => `${i}:${memo[i].slice(0, 7)}`).join(',')})).e.id); }
} else if (sub === 'rec') {
  const [seam, result, ...rest] = a, {memo} = pins(); if (!memo[seam]) die('unknown seam ' + seam);
  const c = git(['rev-parse', ref]), extra = kv(rest);
  const o = append((es) => ({id: `run-${c.slice(0, 7)}-${seam}-${es.filter(e => e.kind === 'run').length + 1}`, at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), kind: 'run', by: need(), note: `${seam} ${result}`, seam, sum: memo[seam], commit: c, result, ...extra}));
  console.log(o.e.id + ' ' + result);
} else {
  const last = new Map(); for (const r of runs().sort((x, y) => x.at.localeCompare(y.at) || x.id.localeCompare(y.id))) last.set(r.seam, r);
  for (const [s, r] of last) console.log(`${s} ${r.result} sum=${r.sum.slice(0, 7)} commit=${r.commit.slice(0, 7)}`);
}
