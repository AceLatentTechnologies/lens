# lens

A generic, static loader. It contains no project knowledge and no default target.

Pages: https://acelatenttechnologies.github.io/lens/ (org AceLatentTechnologies; this repository is public on purpose, Pages on a free plan needs it).

## Use
1. Open the page with a target in the address hash (the hash never leaves the browser):
   `#feed=<owner>/<repo>@<ref>&entry=<path>[&poll=<seconds>][&<name>=<value>...]`
   `<ref>` is a branch, tag or commit sha. Extra hash fields are handed to the view unchanged.
2. Paste a key (a token that can read the repository) and press Load. Refresh reloads at the same ref. `poll` re-runs the view on that interval; omit it for none.
3. The entry file is fetched with the key over the GitHub contents API and runs in a sandboxed frame (`sandbox="allow-scripts"`, no same-origin), so it cannot read the key or this page.

## Key
Held in memory of the page only. Not in the address, not in cookies, not in local storage. Session storage only if "remember in this tab" is ticked. Sent only as a request header to `https://api.github.com`. Forget clears it.

## View messages
A view in the frame talks to the page with `postMessage`; `window.lens` wraps it.
- `{id, get: {repo, path, ref}}` -> `{id, ok, status, text}`
- `{id, list: {repo, path, ref}}` -> `{id, ok, status, items}`
- `{id, read: {path}}` -> `{id, ok, status, json}`; `path` starts with `repos/<owner>/<repo>/`
- `{nav: {ref, entry}}` changes the target in the hash

Only GET requests to `api.github.com` are made. Any other shape or host is refused: `{id, ok: false, refused}`.

## Status
No build, no dev server. Static files in `site/`, published by the Pages workflow.
