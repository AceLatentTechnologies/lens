// Generic loader. No target, no project knowledge. The key lives only in the closure below.
// Limits and the owner scope are data (the defaults block in index.html), not constants here; the address hash may only tighten them.
(() => {
  'use strict';
  const API = 'https://api.github.com/';
  const $ = id => document.getElementById(id);
  const REPO = { test: v => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v) && !/(^|\/)\.\.?(\/|$)/.test(v) }, REF = /^[A-Za-z0-9_.\/-]{1,200}$/;
  // scoped to this page's path; session storage is per origin, so this is a name, not a barrier against other pages of the same origin (README)
  const SK = 'lens.key:' + location.pathname;
  const WINDOW_MS = 60000, HOUR_MS = 3600000;    // the units of the per-minute and per-hour budgets
  const SIZE = new Error('size');
  // text that can reorder or hide what the page shows: C0/C1 controls, soft hyphen, zero-width, bidi marks, embeddings, overrides and isolates, line/paragraph separators, BOM
  const BAD = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/;
  let KEY = '', frame = null, timer = 0, gen = 0, cur = null, expectHash = null, flying = 0, confirmed = '', pending = null;
  const stamps = [];

  const say = t => { $('status').textContent = t; };
  const okPath = s => typeof s === 'string' && s.length > 0 && s.length < 400 && !/[\\\u0000-\u001f]/.test(s) && !s.split('/').some(x => x === '' || x === '.' || x === '..');
  const enc = s => s.split('/').map(encodeURIComponent).join('/');

  // ---- data: defaults from index.html (a JSON data block, never executed) ----
  const DEF = (() => { try { return JSON.parse($('defaults').textContent); } catch { return null; } })();
  const defOk = !!DEF && ['pollMin', 'pollMax', 'perMin', 'perHour', 'inflight', 'bytes', 'ownersMax'].every(k => Number.isFinite(Number(DEF[k])) && Number(DEF[k]) > 0) && Number(DEF.pollMax) >= Number(DEF.pollMin) && typeof DEF.owners === 'string';
  const num = v => (v == null || v === '' ? NaN : Number(v));
  // the hash can only tighten: a larger poll floor (finite, within the ceiling), a smaller budget, in-flight cap or size cap. A value that is not finite or out of range is ignored, never applied.
  function limitsOf(p) {
    const L = { pollMin: Number(DEF.pollMin), pollMax: Number(DEF.pollMax), perMin: Number(DEF.perMin), perHour: Number(DEF.perHour), inflight: Number(DEF.inflight), bytes: Number(DEF.bytes) };
    const pm = num(p.get('pollmin')); if (Number.isFinite(pm) && pm > L.pollMin && pm <= L.pollMax) L.pollMin = pm;
    for (const [k, h] of [['perMin', 'permin'], ['perHour', 'perhour'], ['inflight', 'inflight'], ['bytes', 'bytes']]) { const x = num(p.get(h)); if (Number.isFinite(x) && x > 0 && x < L[k]) L[k] = x; }
    return L;
  }
  // owners in scope: the target owner, plus the defaults data (the operator's), plus the hash `owners=a,b` (the link's: shown as widened, confirmed before Load runs)
  function ownersOf(owner, p) {
    const set = new Set([owner.toLowerCase()]), shown = [owner], added = [];
    for (const x of String(DEF.owners || '').split(',').map(s => s.trim()).filter(Boolean)) {
      if (x === 'target' || !/^[A-Za-z0-9_.-]{1,100}$/.test(x) || set.has(x.toLowerCase())) continue;
      set.add(x.toLowerCase()); shown.push(x.toLowerCase());
    }
    const names = String(p.get('owners') || '').split(',').map(s => s.trim()).filter(Boolean);
    if (names.length > Number(DEF.ownersMax)) return { bad: 'rejected: owners names more than ' + Number(DEF.ownersMax) + ' extra owners' };
    for (const x of names) {
      if (x === 'target') continue;
      if (!/^[A-Za-z0-9_.-]{1,100}$/.test(x)) return { bad: 'rejected: an owners name has characters other than letters, digits, dot, dash and underscore' };
      if (set.has(x.toLowerCase())) continue;
      set.add(x.toLowerCase()); shown.push(x.toLowerCase()); added.push(x.toLowerCase());
    }
    return { set, shown, added };
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
  // budget: sliding windows per minute and per hour, in-flight cap
  function admit(lim) {
    const now = Date.now();
    while (stamps.length && now - stamps[0] >= HOUR_MS) stamps.shift();
    if (stamps.length >= lim.perHour) return 'rate';
    let m = 0; for (let i = stamps.length - 1; i >= 0 && now - stamps[i] < WINDOW_MS; i--) m++;
    if (m >= lim.perMin) return 'rate';
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
  // compare/<base>...<head>: either side may name another owner as `owner:branch` (a fork in the same network), so each named owner must be in scope
  function compareOk(path, sc) {
    const seg = String(path).split('?')[0].split('/');
    if (seg[3] !== 'compare') return true;
    let rest; try { rest = decodeURIComponent(seg.slice(4).join('/')); } catch { return false; }
    return rest.split(/\.{2,3}/).every(x => !x.includes(':') || inScope(sc, x.split(':')[0]));
  }
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
      if (!inScope(sc, ownerOfPath(m.read.path)) || !compareOk(m.read.path, sc)) return refuse('owner');
      return guarded(sc, async () => {
        const r = await gh(API + m.read.path);
        let json = null; try { json = JSON.parse(await body(r, sc.lim.bytes)); } catch (e) { if (e === SIZE) throw e; }
        return { ok: r.ok, status: r.status, json };
      });
    }
    return refuse('unknown');
  }

  // ---- the target: from the hash, never run without a click, unless it is the view's own navigation ----
  // returns null (no target), { bad } (a target that is refused, with the reason) or the target
  function target() {
    if (!defOk) return null;
    const p = new URLSearchParams(location.hash.slice(1));
    for (const [k, v] of p) if (BAD.test(k) || BAD.test(v)) return { bad: 'rejected: a hash field holds a control, bidirectional or zero-width character' };
    const [repo, ref] = (p.get('feed') || '').split('@');
    const entry = p.get('entry');
    if (!REPO.test(repo || '') || !(ref == null || ref === '' || REF.test(ref)) || !okPath(entry || '')) return null;
    const params = {}; for (const [k, v] of p) params[k] = v;
    const lim = limitsOf(p), own = ownersOf(repo.split('/')[0], p), want = num(p.get('poll'));
    if (own.bad) return { bad: own.bad };
    let poll = 0, note = '';
    if (p.has('poll')) {
      if (!Number.isFinite(want) || want <= 0) note = 'poll is not a positive finite number: not polling';
      else if (want > lim.pollMax) note = 'poll ' + want + 's is above the maximum ' + lim.pollMax + 's: not polling';
      else if (want < lim.pollMin) { poll = lim.pollMin; note = 'poll ' + want + 's is below the floor, using ' + lim.pollMin + 's'; } else poll = want;
    }
    return { repo, ref: ref || '', entry, params, lim, owners: own.set, shown: own.shown, added: own.added, poll, note };
  }
  const usable = t => !!t && !t.bad;
  // plain text in labelled fields (text nodes only): the person sees what a link points at before it runs, and no field can pose as another
  function fields(box, t, running) {
    const row = (label, value, f, cls) => {
      const d = document.createElement('div'), l = document.createElement('b'), v = document.createElement('span');
      l.textContent = label + ' '; v.setAttribute('data-f', f); v.textContent = value;
      if (cls) d.className = cls;
      d.append(l, v); box.append(d);
    };
    row('repo', t.repo + (t.ref ? '@' + t.ref : ''), 'repo');
    row('entry', t.entry, 'entry');
    row('owners', t.shown.join(', '), 'owners');
    if (t.added.length) row('WIDENED by this link, not by the page', t.added.join(', '), 'widened', 'widened');
    row('limits', t.lim.perMin + ' requests/min, ' + t.lim.perHour + '/hour, ' + t.lim.inflight + ' in flight, ' + t.lim.bytes + ' bytes', 'limits');
    if (t.poll) row('poll', 'every ' + t.poll + 's', 'poll');
    if (t.note) row('note', t.note, 'note');
    if (running !== undefined) row('state', running ? 'running' : 'press Load to run it', 'state');
  }
  function render(t, running) {
    const box = $('target');
    box.textContent = '';
    box.removeAttribute('data-widened');
    if (!t) { box.textContent = defOk ? 'no target in the address hash' : 'defaults missing: nothing will run'; return; }
    if (t.bad) { box.textContent = t.bad; return; }
    if (t.added.length) box.setAttribute('data-widened', 'true');
    fields(box, t, !!running);
  }
  const canon = () => new URLSearchParams(location.hash.slice(1)).toString();

  async function load(t) {
    const my = ++gen;
    if (!KEY) return say('paste a key');
    if (!usable(t)) return say(t && t.bad ? t.bad : 'no target in the address hash');
    const why = admit(t.lim);
    if (why) return say('not loaded: ' + why + ' limit');
    say('loading');
    let text;
    flying++;
    try {
      const r = await gh(contentsUrl(t.repo, t.entry, t.ref), 'application/vnd.github.raw+json');
      if (!r.ok) { if (my === gen) say('HTTP ' + r.status); return; }
      text = await body(r, t.lim.bytes);
    } catch (e) { if (my === gen) say(e === SIZE ? 'too large' : 'failed: ' + (e && e.name)); return; } finally { flying--; }
    if (my !== gen) return;                              // forgotten, or the target changed, while the request was in flight
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
      if (!shapeOk(n, ['ref', 'entry']) || (n.ref != null && (typeof n.ref !== 'string' || !REF.test(n.ref))) || (n.entry != null && (!okPath(n.entry) || BAD.test(n.entry)))) return;
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
    if (usable(t) && t.poll > 0) timer = setInterval(() => load(t), t.poll * 1000);   // poll is finite and at most the ceiling, so the delay never overflows
  }
  const start = t => { arm(t); load(t); };
  const stop = () => { clearInterval(timer); timer = 0; gen++; frame = null; cur = null; $('stage').textContent = ''; hideConfirm(); };
  const remember = () => { try { if ($('remember').checked && KEY) sessionStorage.setItem(SK, KEY); else sessionStorage.removeItem(SK); } catch {} };

  // ---- a link that widens the owners needs a second, explicit confirmation in the page (not a native dialog) ----
  function hideConfirm() { pending = null; $('confirm').hidden = true; }
  function begin(t) {
    if (!usable(t) || !t.added.length || confirmed === t.added.join(',')) return start(t);
    const body = $('confirm-body'); body.textContent = ''; fields(body, t);
    pending = { t, key: t.added.join(',') };
    $('confirm').hidden = false;
    $('confirm-no').focus();
    say('confirm the widened owners, or cancel');
  }
  $('confirm-yes').addEventListener('click', () => {
    const p = pending; hideConfirm();
    if (p) { confirmed = p.key; start(p.t); }
  });
  $('confirm-no').addEventListener('click', () => { hideConfirm(); say('cancelled: nothing was run'); });

  $('load').addEventListener('click', () => {
    const v = $('key').value.trim(); $('key').value = '';
    if (v) KEY = v;
    remember();
    if (!KEY) return say('paste a key');
    begin(target());
  });
  $('remember').addEventListener('change', remember);
  $('key').addEventListener('keydown', e => { if (e.key === 'Enter') $('load').click(); });
  $('refresh').addEventListener('click', () => begin(target()));
  $('forget').addEventListener('click', () => {
    KEY = ''; stop();
    try { sessionStorage.removeItem(SK); } catch {}
    render(target(), false);
    say('forgotten');
  });
  window.addEventListener('hashchange', () => {
    /*[hash-guard]*/
    const h = canon(), t = target();
    if (expectHash !== null && h === expectHash) { expectHash = null; if (KEY && usable(t) && (!t.added.length || confirmed === t.added.join(','))) start(t); return; }
    expectHash = null; stop();
    render(t, false);
    say(t && t.bad ? t.bad : t ? 'target changed: press Load' : 'no target in the address hash');
  });

  if (!defOk) { $('load').disabled = true; render(null); say('defaults missing'); return; }
  render(target(), false);
  try { const k = sessionStorage.getItem(SK); if (k) { KEY = k; $('remember').checked = true; } } catch {}
  /*[init-end]*/
  say(KEY ? (usable(target()) ? 'press Load to run the target' : (target() && target().bad) || 'no target in the address hash') : 'paste a key');
})();
