// site mode: pure path resolver (no DOM, no network). Shared by the host and the view helper.
(function () {
  var BS = String.fromCharCode(92);
  var BAD = new RegExp('[' + [[0, 31], [127, 159], [173, 173], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff]].map(function (r) { var h = function (n) { return BS + 'u' + ('0000' + n.toString(16)).slice(-4); }; return h(r[0]) + '-' + h(r[1]); }).join('') + ']');
  function dirOf(p) { var i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }
  function floorOf(entry, root) { var d = dirOf(entry), s = d ? d.split('/') : []; return s.slice(0, Math.max(0, s.length - root)).join('/'); }
  function chk(t) { if (BAD.test(t)) return 'control'; if (t.indexOf(BS) >= 0) return 'backslash'; if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(t)) return 'scheme'; if (/^\/\//.test(t)) return 'authority'; return null; }
  function resolve(ref, from, floor, maxLen) {
    if (typeof ref !== 'string') return { ok: false, why: 'type' };
    if (!Number.isInteger(maxLen) || maxLen < 1 || ref.length < 1 || ref.length > maxLen) return { ok: false, why: 'length' };
    var t = ref.split('#')[0].split('?')[0];
    if (!t) return { ok: false, why: 'fragment' };
    var w = chk(t); if (w) return { ok: false, why: w };
    if (/%(2e|2f|5c|[01][0-9a-f])/i.test(t)) return { ok: false, why: 'encoded' };
    try { t = decodeURIComponent(t); } catch (e) { return { ok: false, why: 'encoded' }; }
    w = chk(t); if (w) return { ok: false, why: w };
    if (/%(2e|2f|5c|[01][0-9a-f])/i.test(t)) return { ok: false, why: "encoded" };
    var rootRel = t[0] === '/', dir = t[t.length - 1] === '/';
    var base = rootRel ? floor : from, segs = base ? base.split('/') : [];
    var parts = (rootRel ? t.slice(1) : t).split('/'); if (dir) parts.pop();
    for (var i = 0; i < parts.length; i++) { var s = parts[i];
      if (s === '') return { ok: false, why: 'empty' }; if (s === '.') continue;
      if (s === '..') { if (!segs.length) return { ok: false, why: 'above' }; segs.pop(); continue; } segs.push(s); }
    var fl = floor ? floor.split('/') : [];
    if (segs.length < fl.length || fl.some(function (x, k) { return segs[k] !== x; })) return { ok: false, why: 'above' };
    if (dir) segs.push('index.html'); if (!segs.length) return { ok: false, why: 'empty' };
    return { ok: true, path: segs.join('/') };
  }
  globalThis.SiteResolve = { resolve: resolve, floorOf: floorOf, dirOf: dirOf };
})();
