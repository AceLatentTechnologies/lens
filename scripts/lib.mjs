// prelude: bootstrap prepends this to the verb script and runs it via `node --input-type=module -`.
// No relative imports anywhere (stdin has no base path); only node: builtins at the top.
import {execFileSync as _X} from 'node:child_process';
import {createHash as _H} from 'node:crypto';
import {readFileSync} from 'node:fs';
const E = process.env, R = E.WL_REMOTE || 'origin', BR = E.WL_BRANCH || 'wh-log';
const raw = (a, i, env) => _X('git', a, {input: i, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['pipe', 'pipe', 'pipe'], env: env || E});
const git = (a, i, env) => raw(a, i, env).replace(/\n$/, '');
const die = m => { console.error('wl: ' + m); process.exit(2); };
const sha = s => _H('sha1').update(String(s).replace(/\r/g, '')).digest('hex');
const rules = tip => JSON.parse(raw(['show', `${tip}:rules.md`]).replace(/\r/g, '').match(/```json\n([\s\S]*?)```/)[1]);
const fetchTip = () => { raw(['fetch', '-q', R, `+refs/heads/${BR}:refs/remotes/${R}/${BR}`]); return git(['rev-parse', `refs/remotes/${R}/${BR}`]); };
const lsTree = t => git(['ls-tree', t]).split('\n').filter(Boolean).map(l => { const [m, name] = l.split('\t'); const [mode, type, hash] = m.split(' '); return {mode, type, hash, name, line: l}; });
function load(tip) {
  const out = [];
  let tree; try { tree = git(['rev-parse', `${tip}:log`]); } catch { return out; }
  for (const f of lsTree(tree).filter(f => f.name.endsWith('.jsonl'))) {
    raw(['cat-file', 'blob', f.hash]).split('\n').filter(Boolean).forEach((l, n) => {
      let e; try { e = JSON.parse(l); } catch { e = {_bad: l}; }
      e._f = f.name; e._n = n + 1; out.push(e);
    });
  }
  return out;
}
const supMap = es => { const m = new Map(); for (const e of es) if (e.supersedes) (m.get(e.supersedes) || m.set(e.supersedes, []).get(e.supersedes)).push(e.id); return m; };
const heads = es => { const s = supMap(es); return es.filter(e => e.id && !s.has(e.id)); };
const RESERVED = ['id', 'at', 'kind', 'by', 'supersedes', 'note'];
function validate(e, rl) {
  const spec = rl.kinds[e.kind]; if (!spec) return 'kind ' + e.kind;
  for (const f of ['id', 'at', 'kind', 'by', 'note']) if (!e[f]) return 'missing ' + f;
  for (const f of spec) if (!e[f]) return 'missing ' + f;
  if (!/^[a-z0-9-]{2,32}$/.test(e.by)) return 'by';
  if (e.note.length > rl.note_max) return 'note > ' + rl.note_max;
  for (const [k, v] of Object.entries(e)) {
    if (k[0] === '_') continue;
    if (!/^[a-z][a-z0-9_]*$/.test(k)) return 'field ' + k;
    if (typeof v !== 'string' || v.length > rl.val_max || /[^\x20-\x7e]/.test(v)) return 'value ' + k;
    if (rl.pat[k] && !new RegExp(rl.pat[k]).test(v)) return `pattern ${k}=${v.slice(0, 40)}`;
  }
  if (rl.idpat[e.kind] && !new RegExp(rl.idpat[e.kind]).test(e.id.split('~')[0])) return 'id pattern ' + e.id;
  return null;
}
// semantic rules shared by `add`/`supersede` (refuse up front, exit 2) and `wl check` (FAIL): no self claims, fine items complete
function semantic(e, es, rl) {
  if (e.kind === 'item' && e.id.split('~')[0].includes('.')) for (const f of ['criterion', 'proof', 'r']) if (!String(e[f] || '').trim()) return `fine item needs non-empty ${f}: ${e.id}`;
  if (e.kind === 'proof') {
    if (!(rl.checkers || []).includes(e.by)) return `proof ${e.id}: by=${e.by} is not a checker (${(rl.checkers || []).join(',')}); set WL_BY to a checker`;
    const t = es.find(x => x.id === e.of && x.kind === 'item'); if (!t) return `proof ${e.id}: unknown item of=${e.of} (must name an existing item line)`;
    if (t.by === e.by) return `self claim: proof ${e.id} by ${e.by} proves ${e.of} authored by ${t.by}`;
  }
  return null;
}
// append one entry (built from current state) through plumbing only: hash-object, mktree, commit-tree, push (fast-forward = compare-and-swap).
function append(build) {
  for (let t = 0; t < 4; t++) {
    const tip = t ? fetchTip() : E.WL_TIP, rl = rules(tip), es = load(tip);
    const e = build(es, rl, tip), bad = validate(e, rl); if (bad) die('invalid: ' + bad);
    const sem = semantic(e, es, rl); if (sem) die('refused: ' + sem);
    const root = lsTree(tip), logE = root.find(x => x.name === 'log' && x.type === 'tree');
    if (!logE) die('branch has no log/');
    const logL = lsTree(logE.hash), name = `${e.kind}.jsonl`, old = logL.find(x => x.name === name);
    const prev = old ? raw(['cat-file', 'blob', old.hash]) : '';
    const nb = git(['hash-object', '-w', '--stdin'], prev + JSON.stringify(e) + '\n');
    const nlog = git(['mktree'], logL.filter(x => x.name !== name).map(x => x.line).concat(`100644 blob ${nb}\t${name}`).join('\n') + '\n');
    const nroot = git(['mktree'], root.map(x => x === logE ? `040000 tree ${nlog}\tlog` : x.line).join('\n') + '\n');
    const who = {...E, GIT_AUTHOR_NAME: e.by, GIT_AUTHOR_EMAIL: e.by + '@wl.invalid', GIT_COMMITTER_NAME: e.by, GIT_COMMITTER_EMAIL: e.by + '@wl.invalid'};
    const c = git(['commit-tree', nroot, '-p', tip, '-m', `wl ${e.kind} ${e.id}`], undefined, who);
    // guard: a verb may touch log/<kind>.jsonl and nothing else (scripts/, rules.md stay byte-identical)
    const changed = git(['diff-tree', '-r', '--name-only', '--no-commit-id', tip, c]).split('\n').filter(Boolean);
    if (changed.length !== 1 || changed[0] !== 'log/' + name) die('guard: refused paths ' + changed.join(','));
    try { raw(['push', '-q', R, `${c}:refs/heads/${BR}`]); } catch (x) { if (t === 3) die('push rejected: ' + String(x.stderr).trim().slice(0, 200)); continue; }
    git(['update-ref', `refs/remotes/${R}/${BR}`, c]);
    return {e, c};
  }
}
const kv = a => Object.fromEntries(a.map(s => { const i = s.indexOf('='); if (i < 1) die('bad field ' + s); return [s.slice(0, i), s.slice(i + 1)]; }));
