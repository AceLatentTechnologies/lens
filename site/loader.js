// Generic loader. No target, no project knowledge. The key lives only in the closure below.
// Limits and the owner scope are data (the defaults block in index.html), not constants here; the address hash may only tighten them.
(() => {
  'use strict';
  const API = 'https://api.github.com/';
  const $ = id => document.getElementById(id);
  const REPO = { test: v => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v) && !/(^|\/)\.\.?(\/|$)/.test(v) }, REF = /^[A-Za-z0-9_.\/-]{1,200}$/;
  // scoped to this page's path; session storage is per origin, so this is a name, not a barrier against other pages of the same origin (README)
  const SK = 'lens.key:' + location.pathname;
  const WINDOW_MS = 60000;                       // the unit of the per-minute budget
  const SIZE = new Error('size');
  let KEY = '', frame = null, timer = 0, gen = 0, cur = null, expectHash = null, flying = 0;
  const stamps = [];

  const say = t => { $('status').textContent = t; };
  const okPath = s => typeof s === 'string' && s.length > 0 && s.length < 400 && !/[\\\u0000-\u001f]/.test(s) && !s.split('/').some(x => x === '' || x === '.' || x === '..');
  const enc = s => s.split('/').map(encodeURIComponent).join('/');

  // ---- data: defaults from index.html (a JSON data block, never executed) ----
  const DEF = (() => { try { return JSON.parse($('defaults').textContent); } catch { return null; } })();
  const defOk = !!DEF && ['pollMin', 'perMin', 'inflight', 'bytes'].every(k => Number(DEF[k]) > 0) && typeof DEF.owners === 'string';
  const num = v => (v == null || v === '' ? NaN : Number(v));
  // the hash can only tighten: a larger poll floor, a smaller budget, in-flight cap or size cap
  function limitsOf(p) {
    const L = { pollMin: Number(DEF.pollMin), perMin: Number(DEF.perMin), inflight: Number(DEF.inflight), bytes: Number(DEF.bytes) };
    const pm = num(p.get('pollmin')); if (pm > L.pollMin) L.pollMin = pm;
    for (const [k, h] of [['perMin', 'permin'], ['inflight', 'inflight'], ['bytes', 'bytes']]) { const x = num(p.get(h)); if (x > 0 && x < L[k]) L[k] = x; }
    return L;
  }
  // owners in scope: the target owner, plus the defaults data, plus the hash `owners=a,b` (case-insensitive)
  function ownersOf(owner, p) {
    const set = new Set([owner.toLowerCase()]), shown = [owner];
    for (const v of [DEF.owners, p.get('owners')]) for (const x of String(v || '').split(',').map(s => s.trim()).filter(Boolean)) {
      if (x === 'target' || !/^[A-Za-z0-9_.-]{1,100}$/.test(x) || set.has(x.toLowerCase())) continue;
      set.add(x.toLowerCase()); shown.push(x.toLowerCase());
    }
    return { set, shown };
  }
  const inScope = (sc, owner) => sc.owners.has(owner.toLowerCase());

  // the one place the key is used: GET, api.github.com only, no redirects followed
  async function gh(url, accept) {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.host !== 'api.github.com') throw new Error('refused');
    return fetch(u.href, {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + KEY, Accept: accept || 'application/vnd.github+json' },
      credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', redirect: 'error'
    });
  }
  // response text with a size cap: refuse on content-length, and again while streaming
  async function body(r, cap) {
    const cl = num(r.headers.get('content-length'));
    if (cl > cap) { try { r.body && r.body.cancel(); } catch {} throw SIZE; }
    if (!r.body) { const t = await r.text(); if (t.length > cap) throw SIZE; return t; }
    const rd = r.body.getReader(), parts = []; let n = 0;
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      n += value.length;
      if (n > cap) { try { rd.cancel(); } catch {} throw SIZE; }
      parts.push(value);
    }
    return new Blob(parts).text();
  }
  // budget: sliding window per minute, in-flight cap
  function admit(lim) {
    const now = Date.now();
    while (stamps.length && now - stamps[0] >= WINDOW_MS) stamps.shift();
    if (stamps.length >= lim.perMin) return 'rate';
    if (flying >= lim.inflight) return 'inflight';
    stamps.push(now);
    return null;
  }
  async function guarded(sc, fn) {
    const why = admit(sc.lim);
    if (why) return { ok: false, refused: why };
    flying++;
    try { return await fn(); } catch (e) { return { ok: false, refused: e === SIZE ? 'size' : 'error' }; } finally { flying--; }
  }

  const contentsUrl = (repo, path, ref) => API + 'repos/' + repo + '/contents/' + enc(path) + (ref ? '?ref=' + encodeURIComponent(ref) : '');
  const shapeOk = (o, keys) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).every(k => keys.includes(k));
  const reqOk = o => shapeOk(o, ['repo', 'path', 'ref']) && REPO.test(o.repo || '') && okPath(o.path) && (o.ref == null || REF.test(o.ref));
  const readOk = o => {
    if (!shapeOk(o, ['path']) || typeof o.path !== 'string' || o.path.length > 600) return false;
    if (/[\\#\u0000-\u001f]|%2e|%2f|%5c/i.test(o.path)) return false;
    const q = o.path.indexOf('?'), pth = q < 0 ? o.path : o.path.slice(0, q), seg = pth.split('/');
    if (seg.some(x => x === '' || x === '.' || x === '..') || seg[0] !== 'repos' || seg.length < 4 || !REPO.test(seg[1] + '/' + seg[2])) return false;
    let u; try { u = new URL(API + o.path); } catch { return false; }
    return u.host === 'api.github.com' && u.pathname === '/' + pth && u.search === (q < 0 ? '' : o.path.slice(q));   // what was checked is what is fetched
  };
  const ownerOfPath = p => String(p).split('?')[0].split('/')[1] || '';
  const refuse = why => ({ ok: false, refused: why });

  async function handle(m, sc) {
    const only = k => Object.keys(m).filter(x => x !== 'id').length === 1 && k in m;
    if (only('get')) {
      if (!reqOk(m.get)) return refuse('shape');
      if (!inScope(sc, m.get.repo.split('/')[0])) return refuse('owner');
      return guarded(sc, async () => {
        const r = await gh(contentsUrl(m.get.repo, m.get.path, m.get.ref), 'application/vnd.github.raw+json');
        return { ok: r.ok, status: r.status, text: r.ok ? await body(r, sc.lim.bytes) : '' };
      });
    }
    if (only('list')) {
      if (!reqOk(m.list)) return refuse('shape');
      if (!inScope(sc, m.list.repo.split('/')[0])) return refuse('owner');
      return guarded(sc, async () => {
        const r = await gh(contentsUrl(m.list.repo, m.list.path, m.list.ref));
        let j = null; if (r.ok) { try { j = JSON.parse(await body(r, sc.lim.bytes)); } catch (e) { if (e === SIZE) throw e; } }
        return { ok: r.ok, status: r.status, items: Array.isArray(j) ? j.map(x => ({ name: x.name, path: x.path, type: x.type, sha: x.sha, size: x.size })) : [] };
      });
    }
    if (only('read')) {
      if (!readOk(m.read)) return refuse('shape');
      if (!inScope(sc, ownerOfPath(m.read.path))) return refuse('owner');
      return guarded(sc, async () => {
        const r = await gh(API + m.read.path);
        let json = null; try { json = JSON.parse(await body(r, sc.lim.bytes)); } catch (e) { if (e === SIZE) throw e; }
        return { ok: r.ok, status: r.status, json };
      });
    }
    return refuse('unknown');
  }

  // ---- the target: from the hash, never run without a click, unless it is the view's own navigation ----
  function target() {
    if (!defOk) return null;
    const p = new URLSearchParams(location.hash.slice(1));
    const [repo, ref] = (p.get('feed') || '').split('@');
    const entry = p.get('entry');
    if (!REPO.test(repo || '') || !(ref == null || ref === '' || REF.test(ref)) || !okPath(entry || '')) return null;
    const params = {}; for (const [k, v] of p) params[k] = v;
    const lim = limitsOf(p), own = ownersOf(repo.split('/')[0], p), want = num(p.get('poll'));
    let poll = 0, note = '';
    if (want > 0 && isFinite(want)) {
      if (want < lim.pollMin) { poll = lim.pollMin; note = 'poll ' + want + 's is below the floor, using ' + lim.pollMin + 's'; } else poll = want;
    }
    return { repo, ref: ref || '', entry, params, lim, owners: own.set, shown: own.shown, poll, note };
  }
  // plain text, so the person sees what a link points at before it runs
  function render(t, running) {
    $('target').textContent = !t ? (defOk ? 'no target in the address hash' : 'defaults missing: nothing will run')
      : 'target ' + t.repo + (t.ref ? '@' + t.ref : '') + ' ' + t.entry + '; owners ' + t.shown.join(', ') +
        '; limits ' + t.lim.perMin + ' requests/min, ' + t.lim.inflight + ' in flight, ' + t.lim.bytes + ' bytes' +
        (t.poll ? '; poll every ' + t.poll + 's' : '') + (t.note ? '; ' + t.note : '') + (running ? '; running' : '; press Load to run it');
  }
  const canon = () => new URLSearchParams(location.hash.slice(1)).toString();

  async function load(t) {
    const my = ++gen;
    if (!KEY) return say('paste a key');
    if (!t) return say('no target in the address hash');
    const why = admit(t.lim);
    if (why) return say('not loaded: ' + why + ' limit');
    say('loading');
    let text;
    flying++;
    try {
      const r = await gh(contentsUrl(t.repo, t.entry, t.ref), 'application/vnd.github.raw+json');
      if (!r.ok) return say('HTTP ' + r.status);
      text = await body(r, t.lim.bytes);
    } catch (e) { return say(e === SIZE ? 'too large' : 'failed: ' + (e && e.name)); } finally { flying--; }
    if (my !== gen) return;
    cur = t;
    mount(text, t);
    render(t, true);
    say('loaded ' + t.repo + (t.ref ? '@' + t.ref : ''));
  }

  function mount(text, t) {
    $('stage').textContent = '';
    const f = document.createElement('iframe');
    f.setAttribute('sandbox', 'allow-scripts');          // scripts only: opaque origin, no parent or key access
    f.setAttribute('title', 'view');
    // '*' is the only targetOrigin that reaches an opaque-origin frame. The source is sent once per mounted frame, to the frame this page created.
    f.addEventListener('load', () => f.contentWindow.postMessage({ run: text, ctx: { repo: t.repo, ref: t.ref, entry: t.entry, params: t.params } }, '*'), { once: true });
    f.src = 'sandbox.html';
    frame = f;
    $('stage').appendChild(f);
  }

  window.addEventListener('message', async e => {
    if (!frame || e.source !== frame.contentWindow) return;
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.nav !== undefined) {
      const n = m.nav, p = new URLSearchParams(location.hash.slice(1));
      if (!shapeOk(n, ['ref', 'entry']) || (n.ref != null && !REF.test(n.ref)) || (n.entry != null && !okPath(n.entry))) return;
      const [repo, ref] = (p.get('feed') || '').split('@');
      if (!repo) return;
      if (n.ref != null) p.set('feed', repo + '@' + n.ref); else if (ref != null) p.set('feed', repo + '@' + ref);
      if (n.entry != null) p.set('entry', n.entry);
      if (p.toString() === canon()) return;
      expectHash = p.toString();                         // the one hash change that may run by itself: this view moving within its own repository
      location.hash = expectHash;
      return;
    }
    const src = e.source, sc = cur;
    if (!sc) return;
    let out;
    try { out = await handle(m, sc); } catch (err) { out = refuse('error'); }
    if (frame && src === frame.contentWindow) src.postMessage({ id: m.id, ...out }, '*');   // replies go only to the frame that asked
  });

  function arm(t) {
    clearInterval(timer); timer = 0;
    if (t && t.poll > 0) timer = setInterval(() => load(t), t.poll * 1000);
  }
  const start = t => { arm(t); load(t); };
  const stop = () => { clearInterval(timer); timer = 0; gen++; frame = null; cur = null; $('stage').textContent = ''; };
  const remember = () => { try { if ($('remember').checked && KEY) sessionStorage.setItem(SK, KEY); else sessionStorage.removeItem(SK); } catch {} };

  $('load').addEventListener('click', () => {
    const v = $('key').value.trim(); $('key').value = '';
    if (v) KEY = v;
    remember();
    start(target());
  });
  $('remember').addEventListener('change', remember);
  $('key').addEventListener('keydown', e => { if (e.key === 'Enter') $('load').click(); });
  $('refresh').addEventListener('click', () => start(target()));
  $('forget').addEventListener('click', () => {
    KEY = ''; stop();
    try { sessionStorage.removeItem(SK); } catch {}
    render(target());
    say('forgotten');
  });
  window.addEventListener('hashchange', () => {
    /*[hash-guard]*/
    const h = canon(), t = target();
    if (expectHash !== null && h === expectHash) { expectHash = null; if (KEY && t) start(t); return; }
    expectHash = null; stop();
    render(t);
    say(t ? 'target changed: press Load' : 'no target in the address hash');
  });

  if (!defOk) { $('load').disabled = true; render(null); say('defaults missing'); return; }
  render(target());
  try { const k = sessionStorage.getItem(SK); if (k) { KEY = k; $('remember').checked = true; } } catch {}
  /*[init-end]*/
  say(KEY ? (target() ? 'press Load to run the target' : 'no target in the address hash') : 'paste a key');
})();
