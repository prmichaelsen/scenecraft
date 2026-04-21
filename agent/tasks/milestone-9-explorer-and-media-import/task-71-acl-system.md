# Task 71: ACL System (Rules Table + Evaluator + CLI)

**Milestone**: [M9 — Explorer and Media Import](../../milestones/milestone-9-explorer-and-media-import.md)
**Design Reference**: [local.explorer-and-media-import](../../design/local.explorer-and-media-import.md)
**Estimated Time**: 6 hours
**Dependencies**: Task 70 (schema foundation)
**Status**: Not Started

---

## Objective

Build the server-level ACL that gates every filesystem-touching endpoint in M9: `acl_rules` table, longest-match-wins evaluator, CLI for grant/revoke/list, and first-user admin bootstrap. Default-deny. Project dirs implicitly allowed.

---

## Context

Before any endpoint browses the server filesystem, it must check: "is the requesting user allowed to see this path?" The ACL model is server-level (not per-project), per-user (no roles yet), and path-prefix based. Longest-match wins; on ties, `deny` beats `allow`.

Project directories — the on-disk dir of every project the user owns — are **implicitly allowed** without an ACL row. Everything else defaults to deny.

First user to connect bootstraps as admin with `allow / (root)`, recursive. Admin manages rules via the `scenecraft` CLI.

---

## Steps

1. **Schema** in `scenecraft-engine/src/scenecraft/vcs/bootstrap.py` (or wherever server-level DB lives; the `vcs/` dir is the existing server-level surface):
   ```sql
   CREATE TABLE IF NOT EXISTS acl_rules (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     path_prefix TEXT NOT NULL,          -- absolute, normalized, with trailing /
     effect TEXT NOT NULL,               -- 'allow' | 'deny'
     recursive INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL,
     created_by TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_acl_rules_user ON acl_rules(user_id);
   ```
   If server-level DB doesn't exist yet, create it as `.scenecraft/server.db` per the M6 VCS work; otherwise use the existing server DB.

2. **Path normalization helper** (`scenecraft-engine/src/scenecraft/acl.py` — new module):
   ```python
   def normalize_path(p: str) -> str:
       # Resolve symlinks, make absolute, strip trailing /, re-add consistent trailing /
       resolved = Path(p).resolve()
       return str(resolved).rstrip('/') + '/'
   ```
   Reject `..` traversal that would escape the input path. Reject symlinks pointing outside the resolved root.

3. **Evaluator** in `scenecraft-engine/src/scenecraft/acl.py`:
   ```python
   def check_access(user_id: str, path: str) -> bool:
       normalized = normalize_path(path)
       # 1. Implicit project-dir allow
       if _is_user_project_dir(user_id, normalized):
           return True
       # 2. Query rules for user whose path_prefix is a prefix of normalized
       rules = _get_matching_rules(user_id, normalized)
       # 3. Sort by len(path_prefix) desc
       rules.sort(key=lambda r: len(r['path_prefix']), reverse=True)
       # 4. On tie, deny wins
       if not rules:
           return False  # default deny
       longest = rules[0]['path_prefix']
       tied = [r for r in rules if r['path_prefix'] == longest]
       for r in tied:
           if r['effect'] == 'deny':
               return False
       return tied[0]['effect'] == 'allow'
   ```

4. **Admin bootstrap** — on server start:
   - Check `SELECT COUNT(*) FROM acl_rules`.
   - If 0 and there is at least one authenticated user row, seed the first user as admin with `allow / (root)` recursive. Log the seed event.
   - Otherwise no-op.

5. **CLI subcommands** in `scenecraft-engine/src/scenecraft/cli.py`:
   - `scenecraft acl grant <user> <path> [--deny] [--no-recursive]` — normalize path, insert rule, log.
   - `scenecraft acl revoke <user> <path>` — delete matching rule (exact path match).
   - `scenecraft acl list [--user <user>]` — print rules, sorted by user then path.
   - All commands require admin authentication (re-use M6 auth system).

6. **Helper**: `_is_user_project_dir(user_id, path)` — checks if `path` is under any project directory owned by `user_id`. Look up projects via the existing project index.

7. **Tests** (`scenecraft-engine/tests/test_acl.py`):
   - Default-deny: empty rules → `check_access('u1', '/tmp') == False`.
   - Longest-match-wins: `allow /a` + `deny /a/b` → access to `/a/b/c` is denied.
   - Tie + deny wins: `allow /a` + `deny /a` → denied.
   - Recursive=0: `allow /a` (non-recursive) allows `/a/` but not `/a/b`.
   - Implicit project-dir: create project `proj1` for `u1`; `check_access('u1', proj_dir) == True` without any rule.
   - Traversal: path with `..` that escapes an allowed root → denied after resolve.
   - Symlink: symlink inside allowed dir pointing outside → denied after resolve.
   - Admin bootstrap: fresh DB + 1 user → admin rule seeded.
   - CLI: `acl grant` inserts correctly; `acl revoke` removes; `acl list` prints expected format.

---

## Verification

- [ ] `acl_rules` table created with indexes.
- [ ] `normalize_path` resolves symlinks and rejects escaping traversal.
- [ ] `check_access` returns False by default (empty rules, no project dir).
- [ ] Longest-match wins; deny beats allow on tie.
- [ ] Recursive vs non-recursive rules behave per spec.
- [ ] Project dirs implicitly allowed.
- [ ] Admin bootstrap fires on first-user scenario.
- [ ] CLI subcommands work (`grant`, `revoke`, `list`).
- [ ] All tests in `test_acl.py` pass.

---

**Next Task**: [Task 72: Media classifier + streaming hasher](task-72-media-classifier-and-hasher.md)
