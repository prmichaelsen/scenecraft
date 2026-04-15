# Task 28: GitHub Extension Search & Install

**Milestone**: M3 - Contribution Points  
**Design Reference**: [Contribution Points](../../design/local.contribution-points.md)  
**Estimated Time**: 6-8 hours  
**Dependencies**: Task 11 (package.yaml schema & validation — needed to validate cloned extensions)  
**Status**: Not Started  

---

## Objective

Allow users to discover scenecraft extensions on GitHub (via the `scenecraft-extension` topic) and install them by cloning the repo, validating the manifest, and copying declared files into the user's local extensions directory.

---

## Context

Extensions are declared via `package.yaml` (Task 11) and discovered locally from `~/.scenecraft/extensions/` (Task 9). This task adds the ability to install extensions from remote GitHub repositories, bridging the gap between "extensions exist locally" and "how do they get there."

GitHub's topic system provides free, decentralized discoverability — any repo tagged `scenecraft-extension` becomes searchable without a custom registry.

---

## Steps

### 1. Define extensions config file

**`~/.scenecraft/extensions.yaml`**:

```yaml
installed:
  - name: "@example/chromatic-aberration"
    version: 1.0.0
    source: "https://github.com/example/scenecraft-chromatic-aberration"
    installed_at: 2026-04-14T12:00:00Z
    path: ~/.scenecraft/extensions/example-chromatic-aberration
```

This file tracks what's installed, where it came from, and when. The backend reads it on startup alongside the local extension scan from Task 9.

### 2. Backend: GitHub search endpoint

**`GET /api/extensions/search?q=<query>`**

- Query GitHub Search API: `GET https://api.github.com/search/repositories?q=topic:scenecraft-extension+<query>`
- Map response to a slim payload:

```python
@app.get("/api/extensions/search")
async def search_extensions(q: str = ""):
    results = github_search_repos(topic="scenecraft-extension", query=q)
    return [
        {
            "name": r["full_name"],
            "description": r["description"],
            "stars": r["stargazers_count"],
            "url": r["html_url"],
            "clone_url": r["clone_url"],
            "updated_at": r["updated_at"],
        }
        for r in results["items"]
    ]
```

- No auth required for public repos (60 requests/hour unauthenticated; consider optional `GITHUB_TOKEN` env var for higher limits)
- Cache results for 5 minutes to avoid rate limiting

### 3. Backend: Install endpoint

**`POST /api/extensions/install`**

Request body:
```json
{
  "clone_url": "https://github.com/example/scenecraft-chromatic-aberration.git"
}
```

Install flow:
1. `git clone --depth 1 <clone_url>` into a temp directory
2. Read `package.yaml` from repo root
3. Validate manifest using Task 11's `validate_plugin_manifest()`
4. If invalid, return 400 with validation errors
5. Determine extension name from manifest `name` field
6. Copy the full extension directory to `~/.scenecraft/extensions/<name>/`
7. Append entry to `~/.scenecraft/extensions.yaml`
8. Clean up temp directory
9. Return 200 with installed extension metadata

```python
@app.post("/api/extensions/install")
async def install_extension(body: InstallRequest):
    with tempfile.TemporaryDirectory() as tmp:
        # Clone
        subprocess.run(
            ["git", "clone", "--depth", "1", body.clone_url, tmp + "/repo"],
            check=True, capture_output=True, timeout=60
        )

        # Read and validate manifest
        manifest_path = os.path.join(tmp, "repo", "package.yaml")
        if not os.path.exists(manifest_path):
            raise HTTPException(400, "No package.yaml found in repository root")

        manifest = yaml.safe_load(open(manifest_path))
        errors = validate_plugin_manifest(manifest)
        if errors:
            raise HTTPException(400, {"errors": errors})

        # Copy to extensions dir
        name = manifest["name"].replace("/", "-").lstrip("@")
        dest = os.path.expanduser(f"~/.scenecraft/extensions/{name}")
        if os.path.exists(dest):
            shutil.rmtree(dest)
        shutil.copytree(tmp + "/repo", dest, ignore=shutil.ignore_patterns(".git"))

        # Update extensions.yaml
        update_extensions_yaml(manifest, body.clone_url, dest)

        return {"installed": manifest["name"], "version": manifest["version"], "path": dest}
```

### 4. Backend: List installed / Uninstall endpoints

**`GET /api/extensions`** — read `~/.scenecraft/extensions.yaml`, return installed list

**`DELETE /api/extensions/<name>`** — remove extension directory and entry from yaml

### 5. Frontend: Extensions panel in Settings

Wire into the existing Settings panel (or a new dockview panel):

- **Installed tab**: List installed extensions from `GET /api/extensions` with name, version, source link, uninstall button
- **Browse tab**: Search input that queries `GET /api/extensions/search?q=...`, displays results with name, description, stars, install button
- Install button triggers `POST /api/extensions/install`, shows progress/success/error
- Uninstall button triggers `DELETE /api/extensions/<name>` with confirmation

### 6. Update Task 9 references

Update `discover_plugins()` in Task 9 to also scan `~/.scenecraft/extensions/` (in addition to any legacy path). Ensure the extensions.yaml config is the source of truth for what's installed.

---

## Security Considerations

- **Arbitrary git clone**: Only clone from `github.com` URLs to limit attack surface. Reject non-GitHub URLs.
- **No code execution on install**: Only copy files — no post-install scripts, no `setup.py`, no `npm install`. Extension code runs only when the contribution point system loads it (Phase 2+).
- **Manifest validation**: Always validate `package.yaml` before copying. Reject extensions with invalid manifests.
- **Path traversal**: Sanitize the extension name — no `../` or absolute paths in the destination.
- **Temp cleanup**: Use `tempfile.TemporaryDirectory` context manager to guarantee cleanup.

---

## Verification

- [ ] `GET /api/extensions/search?q=test` returns results from GitHub (or empty array)
- [ ] `POST /api/extensions/install` clones, validates, and copies a valid extension
- [ ] Install rejects repos without `package.yaml` (400 error)
- [ ] Install rejects repos with invalid `package.yaml` (400 error with details)
- [ ] `~/.scenecraft/extensions.yaml` is created/updated on install
- [ ] `GET /api/extensions` returns installed extensions list
- [ ] `DELETE /api/extensions/<name>` removes extension and updates yaml
- [ ] Frontend browse tab shows GitHub search results
- [ ] Frontend install button works end-to-end
- [ ] Frontend installed tab shows installed extensions with uninstall
- [ ] Non-GitHub clone URLs are rejected
- [ ] Temp directory is cleaned up even on failure

---

## Notes

- GitHub unauthenticated rate limit is 60 req/hour. For higher limits, support optional `GITHUB_TOKEN` env var.
- Extensions are topic-tagged repos — no custom registry needed. Authors just add the `scenecraft-extension` topic to their repo.
- This task does NOT implement extension code loading/execution — that's Phase 2. This only gets files onto disk and registered.
- The `~/.scenecraft/extensions/` path replaces the old `~/.beatlab/plugins/` convention from the original design.

---

**Previous Task**: [task-11-package-yaml-schema](task-11-package-yaml-schema.md)  
**Related Design Docs**: [local.contribution-points](../../design/local.contribution-points.md)  
