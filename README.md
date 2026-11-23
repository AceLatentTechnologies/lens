# lens

A generic, static loader. It contains no project knowledge and no default target.

Pages: https://acelatenttechnologies.github.io/lens/ (org AceLatentTechnologies; this repository is public on purpose, Pages on a free plan needs it).

## What this protects, and what it does not
- The sandbox defends the loader's own page and the key: a view cannot read the key, the page, or its storage, and cannot make the page do anything.
- It does not contain the data a view can read. A view receives whatever the key can read inside the owner scope, and a view in a browser can send what it reads to any host (see "Residual risk": a prerender hint makes the browser send a full GET with the data in the address; child frames make unbounded name lookups). The page policy is not a barrier for data. Do not load a view you would not trust with that data.
- The data boundary is the owner scope plus an explicit Load click on a target you can read in full, plus the key itself (a read-only token limited to the repositories needed).

## Use
1. Open the page with a target in the address hash (the hash never leaves the browser):
   `#feed=<owner>/<repo>@<ref>&entry=<path>[&poll=<seconds>][&owners=a,b][&<name>=<value>...]`
   `<ref>` is a branch, tag or commit sha. Extra hash fields are handed to the view unchanged.
2. The page shows the target as labelled plain-text fields: repository and ref, entry, owners in scope, limits, poll. Check them: a link is someone else's text. A hash field that holds a control, bidirectional-formatting or zero-width character is rejected as a whole, and the page says so; nothing can then be loaded.
3. Paste a key (a token that can read the repository) and press Load. Nothing runs before the click: not on first open, not after the hash changes, even with a remembered key (the page then says "press Load"). The one exception is the view moving within its own repository through `lens.nav` (new ref or entry); that goes through the same budget. Refresh reloads at the same ref. `poll` re-runs the view on that interval; omit it for none.
4. If the link widens the owners (`owners=`), the page marks the target as widened and Load asks a second, explicit confirmation in the page (no native dialog) that names the added owners. Confirming once covers the same widening until the owners change.
5. The entry file is fetched with the key over the GitHub contents API and runs in a sandboxed frame (`sandbox="allow-scripts"`, no same-origin), so it cannot read the key or this page.

## Key
Held in memory of the page only. Not in the address, not in cookies, not in local storage. Session storage only if "remember in this tab" is ticked; unticking clears it at once. Sent only as a request header to `https://api.github.com`. Forget clears it, stops the view and ignores any request still in flight.

The session storage name includes this page's path. That is a name, not a barrier: session storage is shared by every page of the same origin (here the organisation's whole Pages host, so its other Pages sites), and a script there could read it. Do not tick "remember" on a shared origin you do not trust, or serve the page from its own origin.

## Owner scope
A view can read whatever the key can read, so by default it may only read repositories of the owner named in the target. More owners are data: the `owners` field of the defaults block in `site/index.html` (default `target`, meaning only the target's owner), or `owners=a,b` in the hash, at most three extra names (more is rejected). Case-insensitive. A refused read answers `{ok:false, refused:'owner'}`. Because the hash can widen the scope, the page shows the owners before anything runs and asks a second confirmation before a widened target loads; a link that widens it is visible and confirmed, not blocked. A `compare` read that names another owner on either side (`owner:branch`) is checked against the scope too. Other endpoints that can return another owner's data without naming it in the path are not inspected.

## Limits
Data, in the defaults block of `site/index.html`, not constants in the script: `pollMin` 5 seconds, `pollMax` 86400 seconds, `perMin` 120 requests in a sliding minute, `perHour` 3000 requests in a sliding hour, `inflight` 6 at once, `bytes` 2000000 per response, `ownersMax` 3. The hash can only tighten them: `pollmin` up (finite, at most `pollMax`), `permin`, `perhour`, `inflight` and `bytes` down. A value that is not a finite number in range is ignored. A poll below the floor is raised to it; a poll that is not finite, not positive or above `pollMax` is not run, and the page says so. Refusals answer `{ok:false, refused:'rate'|'inflight'|'size'}`; a response is refused on its declared length and again while it is read.

## View messages
A view in the frame talks to the page with `postMessage`; `window.lens` wraps it.
- `{id, get: {repo, path, ref}}` -> `{id, ok, status, text}`
- `{id, list: {repo, path, ref}}` -> `{id, ok, status, items}`
- `{id, read: {path}}` -> `{id, ok, status, json}`; `path` starts with `repos/<owner>/<repo>/`, with no empty, `.` or `..` segments; the path that was checked is the path that is fetched
- `{nav: {ref, entry}}` changes the target in the hash and re-runs it (the one change that runs without a click; same repository, same budget)

Only GET requests to `api.github.com` are made, without following redirects (`redirect: 'error'`). A redirect, including one from a renamed repository, fails and the view gets `{ok:false, refused:'error'}`; that is the price of never sending the key to another host. Any other shape or host is refused: `{id, ok: false, refused}`.

## Sandbox model
The frame document (`sandbox.html`) has its own policy: scripts only from its own file plus eval, inline styles, data images; connect, frames, workers, forms, media, fonts and objects are all denied. In tests this stops fetch, XHR, WebSocket, EventSource, beacon, images, audio, forms, ping, speculation rules, CSS imports, prefetch, preload, preconnect, dns-prefetch and window.open from reaching a local sink. The view's inline scripts run through indirect eval, so inline `<script>` blocks work, but top-level `let` and `const` are not shared between blocks, inline event-handler attributes do not run, and `src` or module scripts are skipped. The sandbox script removes `RTCPeerConnection`, `webkitRTCPeerConnection` and `WebTransport` before the view runs: WebRTC resolves host names outside the reach of any page policy. The policy forbids inline script in the document itself on purpose: a child frame made from a string inherits the policy, and if it could run script it could get the removed constructors back.

The policy is a barrier for the key and the page, and for the request channels listed above. It is not a barrier for the data (next section).

Messages from the frame to the page use the page's own origin as target origin, the strictest value. Messages from the page to the frame use `*`, the only target that reaches an opaque-origin frame; the damage this allows is limited because the page sends the source once per frame, replies only to the frame it mounted, and the frame accepts the source once and only from its parent.

## Residual risk (not closed)
- A view can send the data it reads to any host. The sandbox does not contain the data. Tested in Chrome with a local sink: `<link rel=prerender href=...>` (dynamic or in the view's markup) makes the browser send a real GET to that host with the data in the address, despite the policy; creating many child frames makes one connection (name lookup) per frame, so an unbounded number of host names; a meta refresh or frame navigation starts a connection to its target before the policy blocks the request. A MutationObserver that removes such elements does not help: prerender starts when the element is inserted, before the observer runs (tested; none is shipped). Content-Security-Policy `prefetch-src` and `navigate-to`, the `allow` attribute, `credentialless` and `referrerpolicy` had no effect in the same tests, and an iframe `csp` attribute or Trusted Types broke the view. Other browsers and versions were not tested.
- So the data boundary is who you load: the owner scope, the target shown in full before Load, the second confirmation for a widened target, and a read-only token limited to the repositories the view needs. A view is code from the target repository, running with whatever the key can read within the owner scope.
- A phished link can widen the owners and name a hostile target. The page shows both as plain text, rejects text that could disguise them, and waits for Load (and a second confirmation for a widened owner scope); it does not stop a person who loads anyway.
- Session storage is shared by the origin (above).
- Tested in Chromium only; no real GitHub API, no real DNS egress, no Firefox or Safari.

## Status
No build, no dev server. Static files in `site/`, published by the Pages workflow.
