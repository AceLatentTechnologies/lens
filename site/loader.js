// Generic loader. No target, no project knowledge. The key lives only in the closure below.
(() => {
  'use strict';
  const API = 'https://api.github.com/';
  const $ = id => document.getElementById(id);
  const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, REF = /^[A-Za-z0-9_.\/-]{1,200}$/;
  const SK = 'lens.key';
  let KEY = '', frame = null, timer = 0, gen = 0;

  const say = t => { $('status').textContent = t; };
  const okPath = s => typeof s === 'string' && s.length > 0 && s.length < 400 && !/[\\\u0000-\u001f]/.test(s) && !s.split('/').some(x => x === '' || x === '.' || x === '..');
  const enc = s => s.split('/').map(encodeURIComponent).join('/');

  // the one place the key is used: GET, api.github.com only
  async function gh(url, accept) {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.host !== 'api.github.com') throw new Error('refused');
    return fetch(u.href, {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + KEY, Accept: accept || 'application/vnd.github+json' },
      credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer'
    });
  }
  const contentsUrl = (repo, path, ref) => API + 'repos/' + repo + '/contents/' + enc(path) + (ref ? '?ref=' + encodeURIComponent(ref) : '');
  const shapeOk = (o, keys) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).every(k => keys.includes(k));
  const reqOk = o => shapeOk(o, ['repo', 'path', 'ref']) && REPO.test(o.repo || '') && okPath(o.path) && (o.ref == null || REF.test(o.ref));
  const readOk = o => {
    if (!shapeOk(o, ['path']) || typeof o.path !== 'string' || o.path.length > 600) return false;
    if (/[\\#\u0000-\u001f]|\.\.|%2e|%2f|\/\//i.test(o.path) || !/^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\//.test(o.path)) return false;
    return new URL(API + o.path).href.startsWith(API + 'repos/');
  };

  async function handle(m) {
    const only = k => Object.keys(m).filter(x => x !== 'id').length === 1 && k in m;
    if (only('get')) {
      if (!reqOk(m.get)) return { ok: false, refused: 'shape' };
      const r = await gh(contentsUrl(m.get.repo, m.get.path, m.get.ref), 'application/vnd.github.raw+json');
      return { ok: r.ok, status: r.status, text: r.ok ? await r.text() : '' };
    }
    if (only('list')) {
      if (!reqOk(m.list)) return { ok: false, refused: 'shape' };
      const r = await gh(contentsUrl(m.list.repo, m.list.path, m.list.ref));
      const j = r.ok ? await r.json() : null;
      return { ok: r.ok, status: r.status, items: Array.isArray(j) ? j.map(x => ({ name: x.name, path: x.path, type: x.type, sha: x.sha, size: x.size })) : [] };
    }
    if (only('read')) {
      if (!readOk(m.read)) return { ok: false, refused: 'shape' };
      const r = await gh(API + m.read.path);
      let json = null; try { json = await r.json(); } catch {}
      return { ok: r.ok, status: r.status, json };
    }
    return { ok: false, refused: 'unknown' };
  }

  function target() {
    const p = new URLSearchParams(location.hash.slice(1));
    const [repo, ref] = (p.get('feed') || '').split('@');
    const entry = p.get('entry');
    if (!REPO.test(repo || '') || !(ref == null || ref === '' || REF.test(ref)) || !okPath(entry || '')) return null;
    const params = {}; for (const [k, v] of p) params[k] = v;
    return { repo, ref: ref || '', entry, params };
  }

  async function load() {
    const my = ++gen, t = target();
    if (!KEY) return say('paste a key');
    if (!t) return say('no target in the address hash');
    say('loading');
    let text;
    try {
      const r = await gh(contentsUrl(t.repo, t.entry, t.ref), 'application/vnd.github.raw+json');
      if (!r.ok) return say('HTTP ' + r.status);
      text = await r.text();
    } catch (e) { return say('failed: ' + (e && e.name)); }
    if (my !== gen) return;
    mount(text, t);
    say('loaded ' + t.repo + (t.ref ? '@' + t.ref : ''));
  }

  function mount(text, t) {
    $('stage').textContent = '';
    const f = document.createElement('iframe');
    f.setAttribute('sandbox', 'allow-scripts');          // scripts only: opaque origin, no parent or key access
    f.setAttribute('title', 'view');
    f.addEventListener('load', () => f.contentWindow.postMessage({ run: text, ctx: { repo: t.repo, ref: t.ref, entry: t.entry, params: t.params } }, '*'));
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
      location.hash = p.toString();
      return;
    }
    let out;
    try { out = await handle(m); } catch (err) { out = { ok: false, refused: 'error' }; }
    if (frame && e.source === frame.contentWindow) e.source.postMessage({ id: m.id, ...out }, '*');
  });

  function arm() {
    clearInterval(timer); timer = 0;
    const t = target(), s = t && Number(t.params.poll);
    if (s > 0 && isFinite(s)) timer = setInterval(load, s * 1000);
  }
  const start = () => { arm(); load(); };

  $('load').addEventListener('click', () => {
    const v = $('key').value.trim(); $('key').value = '';
    if (v) KEY = v;
    try { if ($('remember').checked && KEY) sessionStorage.setItem(SK, KEY); } catch {}
    start();
  });
  $('key').addEventListener('keydown', e => { if (e.key === 'Enter') $('load').click(); });
  $('refresh').addEventListener('click', start);
  $('forget').addEventListener('click', () => {
    KEY = ''; gen++; clearInterval(timer); frame = null; $('stage').textContent = '';
    try { sessionStorage.removeItem(SK); } catch {}
    say('forgotten');
  });
  window.addEventListener('hashchange', () => { if (KEY) start(); });
  try { const k = sessionStorage.getItem(SK); if (k) { KEY = k; $('remember').checked = true; start(); } } catch {}
  say(KEY ? '' : 'paste a key');
})();
