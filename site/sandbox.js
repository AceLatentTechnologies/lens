// Runs inside the sandboxed frame (opaque origin). It is a file, not an inline script, so the document policy can forbid inline script.
// Site mode: script, img and font also allow blob: (no unsafe-inline). A child srcdoc frame inherits that policy, but it cannot run a blob script
// of this frame: Chromium refuses the cross-origin blob load. That is browser behaviour pinned by a test, not a property of the CSP.
// Site mode (R41): when the host passes ctx.site (data: floor, dir, depth, mimes; the caps themselves are enforced by the host),
// the entry is served as a virtual origin. Every file comes through the host `file` verb; this frame has no network of its own.
(() => {
  'use strict';
  if (window.lens) return;
  /*[shim]*/
  // WebRTC resolves hostnames (STUN/TURN) outside the reach of CSP: a DNS side channel. Remove it before any view code runs.
  for (const k of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'WebTransport']) {
    try { Object.defineProperty(window, k, { value: undefined, writable: false, configurable: false }); } catch { /* already fixed */ }
  }
  /*[/shim]*/
  const P = window.parent, HOST = new URL(location.href).origin, pend = new Map(), SR = globalThis.SiteResolve;
  let n = 0, ran = false;
  // to the host: the strictest origin that is correct (this document's own origin, which is the host's)
  const call = (k, v) => new Promise(res => { const id = ++n; pend.set(id, res); P.postMessage({ id, [k]: v }, HOST); });
  const nav = o => P.postMessage({ nav: o }, HOST);
  window.lens = {
    ctx: null,
    get: (repo, path, ref) => call('get', { repo, path, ref }),
    getBytes: (repo, path, ref) => call('get', { repo, path, ref, bin: true }),
    list: (repo, path, ref) => call('list', { repo, path, ref }),
    read: path => call('read', { path }),
    nav
  };
  const JS = ['', 'text/javascript', 'application/javascript'];

  // ---- single-file mode (no ctx.site): inline classic scripts only; src and module scripts are dropped, not run ----
  function insert(d, code) {
    for (const x of [...d.head.childNodes]) document.head.appendChild(document.importNode(x, true));
    for (const x of [...d.body.childNodes]) document.body.appendChild(document.importNode(x, true));
    for (const c of code) { try { (0, eval)(c); } catch (err) { console.error(err); } }
  }
  function mount(html) {
    const d = new DOMParser().parseFromString(html, 'text/html'), code = [];
    for (const s of [...d.querySelectorAll('script')]) {
      if (!s.hasAttribute('src') && JS.includes((s.getAttribute('type') || '').trim().toLowerCase())) code.push(s.textContent);
      s.remove();
    }
    insert(d, code);
  }

  // ---- site mode ----
  class Fail { constructor(reason, what) { this.reason = reason; this.what = what; } }
  const fail = (reason, what) => new Fail(reason, what);
  const isRef = r => typeof r === 'string' && r !== '' && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(r) && !r.startsWith('//');
  const dirOf = p => p.slice(0, Math.max(0, p.lastIndexOf('/')));
  const extOf = p => { const b = p.slice(p.lastIndexOf('/') + 1), i = b.lastIndexOf('.'); return i < 0 ? '' : b.slice(i + 1).toLowerCase(); };
  const dec = b => new TextDecoder().decode(b);

  function site(S) {
    const cache = new Map(), blobs = new Map(), mods = new Map(), native = { fetch: window.fetch.bind(window), XHR: window.XMLHttpRequest };
    let tail = Promise.resolve(), stuck = '';
    // one file at a time, in document order: the host counts files and bytes before and after a read, so a parallel burst could pass the byte cap
    const queue = f => { const p = tail.then(f); tail = p.then(() => {}, () => {}); return p; };
    // a visible refusal: data attributes carry the reason code, the text carries what was refused
    function note(reason, what) {
      const m = document.createElement('div');
      m.setAttribute('data-site', 'msg'); m.setAttribute('data-reason', reason);
      m.setAttribute('style', 'border:solid;padding:.5em;margin:.5em;font:small monospace');
      m.textContent = reason + ': ' + what;
      (document.body || document.documentElement).appendChild(m);
    }
    const give = (e, what) => note(e instanceof Fail ? e.reason : 'error', e instanceof Fail ? e.what : what);
    const where = (ref, from) => {
      if (!isRef(ref)) return { ok: false, why: 'path' };
      const r = SR.resolve(ref, from, S.floor, S.ref);
      return r.ok ? r : { ok: false, why: r.why === 'length' ? 'length' : 'path' };
    };
    // the host answers with a refusal reason; once the files or bytes budget is spent, nothing more is asked
    function fileOf(path) {
      if (!cache.has(path)) cache.set(path, queue(async () => {
        if (stuck) return { ok: false, why: stuck };
        const r = await call('file', { path, bin: true });
        if (r.refused) { const why = r.refused === 'size' ? 'bytes' : r.refused; if (r.refused === 'files' || r.refused === 'bytes') stuck = why; return { ok: false, why }; }
        if (!r.ok) return { ok: false, why: 'status', status: r.status };
        return { ok: true, status: r.status, bytes: r.bytes, type: r.type };
      }));
      return cache.get(path);
    }
    const need = async path => { const r = await fileOf(path); if (!r.ok) throw fail(r.why, path); return r; };
    const blobUrl = path => {
      if (!blobs.has(path)) blobs.set(path, need(path).then(r => URL.createObjectURL(new Blob([r.bytes], { type: r.type }))));
      return blobs.get(path);
    };

    // ---- css: @import inlined (depth capped, cycles refused), url() to blob urls ----
    const CSS = /@import\s*(?:url\(\s*(["']?)([^"')]+)\1\s*\)|(["'])([^"']+)\3)[^;]*;|url\(\s*(["']?)([^"')]*)\5\s*\)/g;
    async function rewriteCss(text, dir, depth, stack) {
      let out = '', at = 0;
      for (const m of [...text.matchAll(CSS)]) {
        out += text.slice(at, m.index); at = m.index + m[0].length;
        const imp = m[2] || m[4], ref = imp || m[6];
        if (ref === '' || /^(data:|#)/i.test(ref) || (!imp && !isRef(ref))) { out += imp ? '' : m[0]; if (imp && !/^data:/i.test(ref)) note('path', ref); continue; }
        const w = where(ref, dir);
        if (!w.ok) { note(w.why, ref); out += imp ? '' : 'url("")'; continue; }
        try {
          out += imp ? await css(w.path, depth + 1, stack) : 'url("' + await blobUrl(w.path) + '")';
        } catch (e) { give(e, ref); out += imp ? '' : 'url("")'; }
      }
      return out + text.slice(at);
    }
    async function css(path, depth, stack) {
      if (depth > S.depth) throw fail('depth', path);
      if (stack.includes(path)) throw fail('cycle', path);
      const r = await need(path);
      return rewriteCss(dec(r.bytes), dirOf(path), depth, [...stack, path]);
    }

    // ---- modules: a static scan of relative specifiers, one blob per module, specifiers rewritten to the blobs (no inline import map: the policy has no 'unsafe-inline') ----
    // scan returns {hits: [{from, to, spec}], dyn}: hits are string literals right after `from`, `import` and `import(`; comments and the insides of other strings are skipped.
    // dyn is true when an `import(` takes anything but one string literal. null means the scanner lost sync (a raw newline in a quote string, an unterminated string,
    // template or comment): the module is then refused, never guessed at. Regular expression literals and nested templates are read, not guessed.
    const AFTER = /^(?:return|typeof|case|do|else|in|of|instanceof|new|delete|void|throw|yield|await)$/;
    function scan(s) {
      const hits = [], tpl = []; let code = '', i = 0, prev = '', dyn = false;
      const blank = t => t.replace(/[^\n]/g, ' ');
      const skip = j => {                              // past white space and comments
        for (;;) {
          while (j < s.length && /\s/.test(s[j])) j++;
          if (s[j] === '/' && s[j + 1] === '/') { const e = s.indexOf('\n', j); j = e < 0 ? s.length : e; }
          else if (s[j] === '/' && s[j + 1] === '*') { const e = s.indexOf('*/', j + 2); if (e < 0) return s.length; j = e + 2; }
          else return j;
        }
      };
      const str = j => {                               // index after the closing quote of the quote string at j, or -1
        const q = s[j]; j++;
        while (j < s.length && s[j] !== q) { if (s[j] === '\n' || s[j] === '\r') return -1; j += s[j] === '\\' ? 2 : 1; }
        return j < s.length ? j + 1 : -1;
      };
      const regex = j => {                             // index after the regular expression literal at j, or -1 (the slash is then a division)
        let k = j + 1, cls = false;
        for (; k < s.length; k++) {
          const c = s[k];
          if (c === '\n' || c === '\r') return -1;
          if (c === '\\') k++;
          else if (c === '[') cls = true;
          else if (c === ']') cls = false;
          else if (c === '/' && !cls) { k++; while (/[A-Za-z]/.test(s[k] || '')) k++; return k; }
        }
        return -1;
      };
      const tail = () => {                             // inside a template: to the closing backtick (true) or the next ${ (false); null at the end of the source
        while (i < s.length) {
          const c = s[i];
          if (c === '\\') { code += blank(s.slice(i, i + 2)); i += 2; }
          else if (c === '`') { code += c; i++; prev = c; return true; }
          else if (c === '$' && s[i + 1] === '{') { code += '${'; i += 2; tpl.push(0); prev = '{'; return false; }
          else { code += c === '\n' ? c : ' '; i++; }
        }
        return null;
      };
      while (i < s.length) {
        const c = s[i], d = s[i + 1];
        if (c === '/' && d === '/') { const j = s.indexOf('\n', i), e = j < 0 ? s.length : j; code += ' '.repeat(e - i); i = e; }
        else if (c === '/' && d === '*') { const j = s.indexOf('*/', i + 2); if (j < 0) return null; code += blank(s.slice(i, j + 2)); i = j + 2; }
        else if (c === '"' || c === "'") {
          const j = str(i); if (j < 0) return null;
          if (/(?:\bfrom|\bimport|\bimport\s*\()\s*$/.test(code)) hits.push({ from: i + 1, to: j - 1, spec: s.slice(i + 1, j - 1) });
          code += c + ' '.repeat(j - i - 2) + c; i = j; prev = c;
        } else if (c === '`') { code += c; i++; if (tail() === null) return null; }
        else if (c === '/' && (prev === '' || /^[(,=:[!&|?{};+\-*%<>~^]$/.test(prev) || AFTER.test(prev))) {
          const j = regex(i);
          if (j < 0) { code += c; i++; prev = c; } else { code += ' '.repeat(j - i); i = j; prev = 'x'; }
        } else if (/[A-Za-z_$]/.test(c)) {
          let j = i + 1; while (j < s.length && /[\w$]/.test(s[j])) j++;
          const w = s.slice(i, j);
          if (w === 'import' && !/\.\s*$/.test(code)) {
            const k = skip(j);
            if (s[k] === '(') {
              const m = skip(k + 1), q = s[m];
              if (q !== '"' && q !== "'") dyn = true;
              else { const e = str(m); if (e < 0) return null; const n = skip(e); if (s[n] !== ')' && s[n] !== ',') dyn = true; }
            }
          }
          code += w; i = j; prev = w;
        } else if (c === '{' && tpl.length) { tpl[tpl.length - 1]++; code += c; i++; prev = c; }
        else if (c === '}' && tpl.length) {
          if (tpl[tpl.length - 1] > 0) { tpl[tpl.length - 1]--; code += c; i++; prev = c; }
          else { tpl.pop(); code += c; i++; if (tail() === null) return null; }
        } else { code += c; i++; if (!/\s/.test(c)) prev = /\d/.test(c) ? 'x' : c; }
      }
      return tpl.length ? null : { hits, dyn };
    }
    async function link(src, dir, depth, stack, name) {
      const sc = scan(src);
      if (!sc) throw fail('scan', name + ' (the import scanner cannot read this module reliably)');
      if (sc.dyn) throw fail('dynamic', name + ' (import() with a computed specifier is not followed)');
      const hits = sc.hits;
      for (const h of hits) {                       // refuse before any dependency is requested
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(h.spec) || h.spec.startsWith('//')) throw fail('path', h.spec);
        if (!/^(\.\.?\/|\/)/.test(h.spec)) throw fail('bare', h.spec);
      }
      const urls = new Map();
      for (const h of hits) {
        if (urls.has(h.spec)) continue;
        const w = where(h.spec, dir);
        if (!w.ok) throw fail(w.why, h.spec);
        urls.set(h.spec, await mod(w.path, depth + 1, stack));
      }
      let out = '', at = 0;
      for (const h of hits) { out += src.slice(at, h.from) + urls.get(h.spec); at = h.to; }
      return URL.createObjectURL(new Blob([out + src.slice(at)], { type: 'text/javascript' }));
    }
    function mod(path, depth, stack) {
      if (stack.includes(path)) return Promise.reject(fail('cycle', path));
      if (depth > S.depth) return Promise.reject(fail('depth', path));
      if (!mods.has(path)) mods.set(path, need(path).then(r => link(dec(r.bytes), dirOf(path), depth, [...stack, path], path)));
      return mods.get(path);
    }

    // ---- fetch and XMLHttpRequest with a relative url go to the host; anything else is left to the page policy (connect-src 'none') ----
    const READ = ['GET', 'HEAD'];
    async function answer(ref, method) {
      if (!READ.includes(String(method || READ[0]).toUpperCase())) throw new TypeError('lens: the site is read-only');
      const w = where(ref, S.dir);
      if (!w.ok) { note(w.why, ref); throw new TypeError('lens: refused path'); }
      const r = await fileOf(w.path);
      if (!r.ok && r.why !== 'status') { note(r.why, w.path); throw new TypeError('lens: refused ' + r.why); }
      return r;
    }
    window.fetch = function (input, init) {
      if (typeof input !== 'string' || !isRef(input)) return native.fetch.apply(window, arguments);
      return answer(input, init && init.method).then(r => r.ok ? new Response(r.bytes, { status: r.status, headers: { 'content-type': r.type } }) : new Response(null, { status: r.status }));
    };
    window.XMLHttpRequest = class extends native.XHR {
      #q = null; #s = 0; #r = null; #t = null;
      open(m, u, ...a) { if (isRef(String(u))) { this.#q = { m, u: String(u) }; this.#set(1); } else { this.#q = null; super.open(m, u, ...a); } }
      #set(s) { this.#s = s; this.dispatchEvent(new Event('readystatechange')); }
      get readyState() { return this.#q ? this.#s : super.readyState; }
      get status() { return this.#q ? (this.#r ? this.#r.status : 0) : super.status; }
      get statusText() { return this.#q ? '' : super.statusText; }
      get responseURL() { return this.#q ? '' : super.responseURL; }
      get responseText() { return this.#q ? (this.#t ??= this.#r ? dec(this.#r.bytes) : '') : super.responseText; }
      get response() {
        if (!this.#q) return super.response;
        if (!this.#r) return null;
        const t = this.responseType;
        if (t === 'arraybuffer') return this.#r.bytes;
        if (t === 'blob') return new Blob([this.#r.bytes], { type: this.#r.type });
        if (t === 'json') { try { return JSON.parse(this.responseText); } catch { return null; } }
        return this.responseText;
      }
      getResponseHeader(h) { return this.#q ? (String(h).toLowerCase() === 'content-type' && this.#r ? this.#r.type : null) : super.getResponseHeader(h); }
      getAllResponseHeaders() { return this.#q ? (this.#r ? 'content-type: ' + this.#r.type + '\r\n' : '') : super.getAllResponseHeaders(); }
      setRequestHeader(k, v) { if (!this.#q) super.setRequestHeader(k, v); }
      abort() { if (this.#q) this.#q = null; else super.abort(); }
      send(b) {
        if (!this.#q) return super.send(b);
        const q = this.#q;
        answer(q.u, q.m).then(r => { if (this.#q !== q) return; this.#r = r.ok ? r : { status: r.status, bytes: new ArrayBuffer(0), type: '' }; this.#set(4); this.dispatchEvent(new ProgressEvent('load')); }, () => { if (this.#q !== q) return; this.#set(4); this.dispatchEvent(new ProgressEvent('error')); }).then(() => { if (this.#q === q) this.dispatchEvent(new ProgressEvent('loadend')); });
      }
    };

    // ---- a click on a link to another page of the site is a nav message (the entry changes in the hash); the frame itself never navigates ----
    document.addEventListener('click', e => {
      const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a) return;
      const h = a.getAttribute('href');
      if (h.startsWith('#')) return;
      e.preventDefault();
      const w = where(h, S.dir);
      if (!w.ok) return note(w.why, h);
      if (S.mimes[extOf(w.path)] !== 'text/html') return note('mime', w.path);
      nav({ entry: w.path });
    }, true);

    // ---- the entry document ----
    return async function (html) {
      const d = new DOMParser().parseFromString(html, 'text/html'), runs = [];
      for (const el of [...d.querySelectorAll('link[rel~=stylesheet][href], style, img[src], script')]) {
        const tag = el.localName;
        try {
          if (tag === 'link' || tag === 'style') {
            const st = document.createElement('style');
            if (tag === 'style') st.textContent = await rewriteCss(el.textContent, S.dir, 1, []);
            else {
              const ref = el.getAttribute('href'), w = where(ref, S.dir);
              if (!w.ok) throw fail(w.why, ref);
              st.textContent = await css(w.path, 1, []);
            }
            el.replaceWith(st);
          } else if (tag === 'img') {
            const ref = el.getAttribute('src');
            if (!isRef(ref) || /^data:/i.test(ref)) continue;       // data and absolute urls are left to the page policy
            const w = where(ref, S.dir);
            if (!w.ok) throw fail(w.why, ref);
            el.setAttribute('src', await blobUrl(w.path));
          } else {
            const type = (el.getAttribute('type') || '').trim().toLowerCase(), src = el.getAttribute('src');
            const kind = type === 'module' ? 'module' : JS.includes(type) ? 'classic' : type === 'importmap' ? 'map' : null;
            if (!kind) continue;                                    // a data block (json, template) stays in the page and does not run
            el.remove();
            if (kind === 'map') throw fail('bare', 'an import map is not supported: vendor the dependencies and import them by relative path');
            if (src === null) runs.push(kind === 'classic' ? { code: el.textContent } : { url: await link(el.textContent, S.dir, 1, [], 'an inline module of the entry page') });
            else {
              if (!isRef(src)) throw fail('path', src);
              const w = where(src, S.dir);
              if (!w.ok) throw fail(w.why, src);
              runs.push(kind === 'classic' ? { code: dec((await need(w.path)).bytes) } : { url: await mod(w.path, 1, []) });
            }
          }
        } catch (e) {
          give(e, 'unexpected failure');
          if (tag === 'link') el.remove();
        }
      }
      for (const x of [...d.head.childNodes]) document.head.appendChild(document.importNode(x, true));
      for (const x of [...d.body.childNodes]) document.body.appendChild(document.importNode(x, true));
      for (const r of runs) if (r.code !== undefined) { try { (0, eval)(r.code); } catch (err) { console.error(err); } }
      for (const r of runs) if (r.url) { const s = document.createElement('script'); s.type = 'module'; s.src = r.url; document.head.appendChild(s); }
    };
  }

  addEventListener('message', e => {
    if (e.source !== P || e.origin !== HOST) return;
    const m = e.data || {};
    if (typeof m.run === 'string') {
      if (ran) return;                 // the source is accepted once per frame document
      ran = true; window.lens.ctx = m.ctx;
      const S = m.ctx && m.ctx.site;
      if (S && SR) site(S)(m.run).catch(err => console.error(err)); else mount(m.run);
    } else if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  });
})();
