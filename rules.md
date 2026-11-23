# wh-log rules (orphan branch; never a cwd; read and write only through `wl`)
## Directives
- Never check this branch out, clone it as a worktree, or edit it by hand. Use `wl add|supersede|render|ls|check|pin`.
- Append only. A change is a new line with `supersedes: <id>` (`wl supersede`); old lines stay. Latest revision wins.
- A line is flat: string values only, ASCII, `note` <= 200 chars. No secrets, no message text.
- Every claim carries `ref` = `<repo>@<commit>:<path>#<lines>` (LIVE repo, resolved by `wl check ref`). No ref, no claim.
- A `proof` line is written by a checker (`checkers` below), never by the author of the work: `proof.by` must be a checker and differ from the `by` of the item it proves; `proof.of` must name an existing item line. `by` = your agent id (`WL_BY`).
- A fine item (id with a dot, `C1.1`) must carry non-empty `criterion`, `proof`, `r`. `wl add`/`supersede` refuse violations (exit 2); `wl check` FAILs them.
- Scripts under `scripts/` are committed blobs pinned by `wl.lock` in the project repo; verbs cannot touch them. Changing them is `wl-admin`, outside the entrypoint.
## Layout
`rules.md`, `scripts/{manifest.json,lib.mjs,add.mjs,render.mjs,check.mjs,pin.mjs}`, `log/<kind>.jsonl`.
## Entry
`{id, at, kind, by, supersedes?, note, ...fields}`; `at` = UTC time of the line; `id` unique (checklist ids `C1.1`; revisions `C1.1~2`; others 6 letters).
Kinds and required fields below; `pat` = value patterns; `idpat` = id pattern per kind.
```json
{"v":1,"note_max":200,"val_max":400,"checkers":["critic","judge"],
 "kinds":{"item":[],"proof":["of","ref","commit"],"claim":["ref","expect"],"finding":["of","ref"],"decision":[],"note":[],"snap":["commit","sums"],"run":["seam","sum","commit","result"],"summary":[]},
 "pat":{"r":"^R[0-9]+(,R[0-9]+)*$","commit":"^[0-9a-f]{7,40}$","ref":"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+@[0-9a-f]{7,40}:[^#\\s]+#[0-9]+(-[0-9]+)?$","result":"^(pass|fail|skip|pending)$"},
 "idpat":{"item":"^C[0-9]+(\\.[0-9]+)*$"},
 "summary_caps":{"S0.md":{"lines":40,"bytes":4096},"S1.md":{"lines":30,"bytes":3072},"S2.md":{"lines":10,"bytes":1024}}}
```
