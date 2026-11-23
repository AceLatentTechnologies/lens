// verbs: check | check ref <label> [--expect s] [--on branch] | check voice <file> | check summary <dir>
const [, sub, ...a] = process.argv.slice(2);
const fail = [];
if (sub === 'ref') {
  // label = <repo>@<commit>:<path>#<lines>; fetched from the LIVE repo with gh api, never a local clone
  const m = /^([\w.-]+\/[\w.-]+)@([0-9a-f]{7,40}):([^#\s]+)#(\d+)(?:-(\d+))?$/.exec(a[0] || ''); if (!m) { console.log('FAIL label ' + a[0]); process.exit(1); }
  const [, repo, commit, path, l1, l2] = m, ex = a.indexOf('--expect') > -1 ? a[a.indexOf('--expect') + 1] : null, on = a.indexOf('--on') > -1 ? a[a.indexOf('--on') + 1] : null;
  const [gc, ...gp] = (E.WL_TEST === '1' && E.WL_GH || 'gh').split(' '), gh = x => _X(gc, [...gp, ...x], {encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe']});
  try {
    const body = gh(['api', '-H', 'Accept: application/vnd.github.raw+json', `repos/${repo}/contents/${path}?ref=${commit}`]).replace(/\r/g, '').split('\n');   // CR stripped before the slice is hashed or compared
    const sl = body.slice(l1 - 1, (l2 || l1)).join('\n');
    if (!sl) fail.push('lines out of range');
    if (ex && !sl.includes(ex)) fail.push('expect not in lines');
    if (on) { const st = gh(['api', `repos/${repo}/compare/${commit}...${on}`, '--jq', '.status']).trim(); if (!['behind', 'identical'].includes(st)) fail.push(`commit not on ${on} (${st})`); }
    console.log(fail.length ? 'FAIL ' + fail.join('; ') : `ok ${sha(sl).slice(0, 8)} ${commit.slice(0, 7)}`);
  } catch (x) { console.log('FAIL unresolved: ' + String(x.stderr || x.message).trim().split('\n')[0].slice(0, 100)); process.exit(1); }
  process.exit(fail.length ? 1 : 0);
}
if (sub === 'voice') {   // R18: first line `skills: ...`, last line `using (..), to perform (..) in order to (..)`
  const L = readFileSync(a[0], 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
  if (!/^skills: \S/.test(L[0] || '')) fail.push('first line');
  if (!/^using \([^()]+\), to perform \([^()]+\) in order to \([^()]+\)\.?$/.test(L[L.length - 1] || '')) fail.push('last line');
  console.log(fail.length ? 'FAIL voice ' + fail.join(',') : 'ok voice'); process.exit(fail.length ? 1 : 0);
}
if (sub === 'summary') {  // caps from rules.md; files S0,S1,S2 in <dir>
  const rl = rules(E.WL_TIP);
  for (const [f, c] of Object.entries(rl.summary_caps)) {
    let s = ''; try { s = readFileSync(`${a[0]}/${f}`, 'utf8'); } catch { fail.push(f + ' missing'); continue; }
    const n = s.split('\n').filter((l, i, arr) => l || i < arr.length - 1).length;
    if (n > c.lines) fail.push(`${f} ${n}>${c.lines} lines`); if (Buffer.byteLength(s) > c.bytes) fail.push(`${f} ${Buffer.byteLength(s)}>${c.bytes} bytes`);
  }
  console.log(fail.length ? 'FAIL ' + fail.join('; ') : 'ok summary'); process.exit(fail.length ? 1 : 0);
}
// plain `wl check`: log invariants
const tip = E.WL_TIP, rl = rules(tip), es = load(tip), ids = new Set();
for (const e of es) {
  if (e._bad) { fail.push(`bad json log/${e._f}:${e._n}`); continue; }
  const bad = validate(e, rl); if (bad) fail.push(`log/${e._f}:${e._n} ${bad}`);
  if (ids.has(e.id)) fail.push('dup id ' + e.id); ids.add(e.id);
}
const by = new Map(es.filter(e => e.id).map(e => [e.id, e])), sup = supMap(es);
for (const e of heads(es)) { const s = e._bad ? null : semantic(e, es, rl); if (s) fail.push(`log/${e._f}:${e._n} ${s}`); }
for (const e of es) if (e.supersedes) { const t = by.get(e.supersedes); if (!t) fail.push(`${e.id} supersedes missing ${e.supersedes}`); else if (t.kind !== e.kind) fail.push(`${e.id} kind differs from target`); }
for (const [t, s] of sup) if (s.length > 1) fail.push(`fork: ${t} superseded by ${s.join(',')}`);
const cs = git(['rev-list', '--reverse', tip]).split('\n'), pathsOf = c => git(['ls-tree', '-r', c, 'log/']).split('\n').filter(Boolean).map(l => { const [m, p] = l.split('\t'); return [p, m.split(' ')[2]]; });
let admin = 0;
for (let i = 1; i < cs.length; i++) {
  const names = git(['diff-tree', '-r', '--name-only', '--no-commit-id', cs[i - 1], cs[i]]).split('\n').filter(Boolean);
  if (git(['log', '-1', '--format=%s', cs[i]]).startsWith('wl-admin')) { admin++; continue; }
  const odd = names.filter(n => !/^log\/[a-z]+\.jsonl$/.test(n)); if (odd.length) fail.push(`commit ${cs[i].slice(0, 7)} touched ${odd.join(',')} without wl-admin`);
  const prev = new Map(pathsOf(cs[i - 1]));
  for (const [p, h] of pathsOf(cs[i])) if (prev.has(p) && prev.get(p) !== h && !raw(['cat-file', 'blob', h]).startsWith(raw(['cat-file', 'blob', prev.get(p)]))) fail.push(`commit ${cs[i].slice(0, 7)} rewrote ${p} (not append-only)`);
}
const mf = JSON.parse(raw(['show', `${tip}:scripts/manifest.json`]));
for (const [p, h] of Object.entries(mf.blobs)) if (git(['rev-parse', `${tip}:${p}`]) !== h) fail.push('manifest blob mismatch ' + p);
if (E.WL_LOCK_TREE && E.WL_LOCK_TREE !== E.WL_SCRIPTS_TREE) fail.push('scripts tree != wl.lock');
console.log(fail.length ? fail.map(f => 'FAIL ' + f).join('\n') : `ok commits=${cs.length} entries=${es.length} admin=${admin} heads=${heads(es).length}`);
process.exit(fail.length ? 1 : 0);
