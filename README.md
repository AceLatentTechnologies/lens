# lens

A generic, static loader. It contains no project knowledge and no default target.

Pages: https://acelatenttechnologies.github.io/lens/ (org AceLatentTechnologies; this repository is public on purpose, Pages on a free plan needs it).

## Use
1. Open the page with a target in the address hash (the hash never leaves the browser):
   `#feed=<owner>/<repo>@<ref>&entry=<path>[&poll=<seconds>][&owners=a,b][&<name>=<value>...]`
   `<ref>` is a branch, tag or commit sha. Extra hash fields are handed to the view unchanged.
2. The page shows the target, the owners in scope and the limits as plain text. Check them: a link is someone else's text.
3. Paste a key (a token that can read the repository) and press Load. Nothing runs before the click: not on first open, not after the hash changes, even with a remembered key (the page then says "press Load"). The one exception is the view moving within its own repository through `lens.nav` (new ref or entry). Refresh reloads at the same ref. `poll` re-runs the view on that interval; omit it for none.
4. The entry file is fetched with the key over the GitHub contents API and runs in a sandboxed frame (`sandbox="allow-scripts"`, no same-origin), so it cannot read the key or this page.

## Key
Held in memory of the page only. Not in the address, not in cookies, not in local storage. Session storage only if "remember in this tab" is ticked; unticking clears it at once. Sent only as a request header to `https://api.github.com`. Forget clears it.

The session storage name includes this page's path. That is a name, not a barrier: session storage is shared by every page of the same origin (`acelatenttechnologies.github.io`, so the organisation's other Pages sites), and a script there could read it. Do not tick "remember" on a shared origin you do not trust, or serve the page from its own origin.

## Owner scope
A view can read whatever the key can read, so by default it may only read repositories of the owner named in the target. More owners are data: the `owners` field of the defaults block in `site/index.html` (default `target`, meaning only the target's owner), or `owners=a,b` in the hash. Case-insensitive. A refused read answers `{ok:false, refused:'owner'}`. Because the hash can widen the scope, the page shows the owners before anything runs; a link that widens it is visible, not blocked.

## Limits
Data, in the defaults block of `site/index.html`, not constants in the script: `pollMin` 5 seconds, `perMin` 120 requests in a sliding minute, `inflight` 6 at once, `bytes` 2000000 per response. The hash can only tighten them: `pollmin` up, `permin`, `inflight` and `bytes` down. A poll below the floor is raised to it and the page says so. Refusals answer `{ok:false, refused:'rate'|'inflight'|'size'}`; a response is refused on its declared length and again while it is read.

## View messages
A view in the frame talks to the page with `postMessage`; `window.lens` wraps it.
- `{id, get: {repo, path, ref}}` -> `{id, ok, status, text}`
- `{id, list: {repo, path, ref}}` -> `{id, ok, status, items}`
- `{id, read: {path}}` -> `{id, ok, status, json}`; `path` starts with `repos/<owner>/<repo>/`, with no empty, `.` or `..` segments; the path that was checked is the path that is fetched
- `{nav: {ref, entry}}` changes the target in the hash and re-runs it (the one change that runs without a click)

Only GET requests to `api.github.com` are made, without following redirects (`redirect: 'error'`). A redirect, including one from a renamed repository, fails and the view gets `{ok:false, refused:'error'}`; that is the price of never sending the key to another host. Any other shape or host is refused: `{id, ok: false, refused}`.

## Sandbox model
The frame document (`sandbox.html`) has its own policy: scripts only from its own file plus eval, inline styles, data images; connect, frames, workers, forms, media, fonts and objects are all denied. The view's inline scripts run through indirect eval, so inline `<script>` blocks work, but top-level `let` and `const` are not shared between blocks, inline event-handler attributes do not run, and `src` or module scripts are skipped. The sandbox script removes `RTCPeerConnection`, `webkitRTCPeerConnection` and `WebTransport` before the view runs: WebRTC resolves host names outside the reach of any page policy. The policy forbids inline script in the document itself on purpose: a child frame made from a string inherits the policy, and if it could run script it could get the removed constructors back.

Messages from the frame to the page use the page's own origin as target origin, the strictest value. Messages from the page to the frame use `*`, the only target that reaches an opaque-origin frame; the damage this allows is limited because the page sends the source once per frame, replies only to the frame it mounted, and the frame accepts the source once and only from its parent.

## Residual risk (not closed)
- Name lookups. The browser starts a connection (a name lookup) at the beginning of a navigation, before the page policy blocks it. A view can navigate its own frame to `https://<data>.example/`, and no request is made, but the name may be resolved. Likewise, a hostile view can still reach DNS through browser behaviour the policy does not cover (prefetch hints are blocked by the policy in current browsers, which is tested; other engines and versions were not tested). Data can leave a few bits at a time through host names.
- A view is code from the target repository, running with whatever the key can read within the owner scope. Scoping the key (a read-only token limited to the repositories needed) is the real control.
- A phished link can widen the owners and name a hostile target. The page shows both and waits for Load; it does not stop a person who loads anyway.
- Session storage is shared by the origin (above).
- Tested in Chromium only; no real GitHub API, no real DNS egress, no Firefox or Safari.

## Status
No build, no dev server. Static files in `site/`, published by the Pages workflow.
