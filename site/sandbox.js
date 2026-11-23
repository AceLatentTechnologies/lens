// Runs inside the sandboxed frame (opaque origin). It is a file, not an inline script, so the document policy can forbid inline script:
// a srcdoc child frame inherits that policy and then cannot run anything, so it cannot recover the constructors removed below.
(() => {
  'use strict';
  if (window.lens) return;
  /*[shim]*/
  // WebRTC resolves hostnames (STUN/TURN) outside the reach of CSP: a DNS side channel. Remove it before any view code runs.
  for (const k of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'WebTransport']) {
    try { Object.defineProperty(window, k, { value: undefined, writable: false, configurable: false }); } catch { /* already fixed */ }
  }
  /*[/shim]*/
  const P = window.parent, HOST = new URL(location.href).origin, pend = new Map();
  let n = 0, ran = false;
  // to the host: the strictest origin that is correct (this document's own origin, which is the host's)
  const call = (k, v) => new Promise(res => { const id = ++n; pend.set(id, res); P.postMessage({ id, [k]: v }, HOST); });
  window.lens = {
    ctx: null,
    get: (repo, path, ref) => call('get', { repo, path, ref }),
    list: (repo, path, ref) => call('list', { repo, path, ref }),
    read: path => call('read', { path }),
    nav: o => P.postMessage({ nav: o }, HOST)
  };
  const JS = ['', 'text/javascript', 'application/javascript'];
  function mount(html) {
    const d = new DOMParser().parseFromString(html, 'text/html'), code = [];
    // classic inline scripts run below by indirect eval; src, module and other script types are dropped, not run
    for (const s of [...d.querySelectorAll('script')]) {
      if (!s.hasAttribute('src') && JS.includes((s.getAttribute('type') || '').trim().toLowerCase())) code.push(s.textContent);
      s.remove();
    }
    for (const x of [...d.head.childNodes]) document.head.appendChild(document.importNode(x, true));
    for (const x of [...d.body.childNodes]) document.body.appendChild(document.importNode(x, true));
    for (const c of code) { try { (0, eval)(c); } catch (err) { console.error(err); } }
  }
  addEventListener('message', e => {
    if (e.source !== P || e.origin !== HOST) return;
    const m = e.data || {};
    if (typeof m.run === 'string') {
      if (ran) return;                 // the source is accepted once per frame document
      ran = true; window.lens.ctx = m.ctx; mount(m.run);
    } else if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  });
})();
