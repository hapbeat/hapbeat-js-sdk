# Releasing @hapbeat/sdk (npm)

## 0. Gate — verify on a real device first

Per the project's distribution policy, do not publish before the SDK is
confirmed to drive a physical Hapbeat.

```bash
npm install && npm run build
# Power on a Hapbeat on the same LAN; deploy a kit via Hapbeat Studio.
node examples/node-minimal.mjs   # edit EVENT_ID to a real kit event id
```
- **Node path**: confirm the device buzzes.
- **Browser path**: run `hapbeat-helper` locally, open `examples/browser-minimal.html`
  through a bundler/import-map, confirm connect + play work end-to-end.

Only then proceed.

## 1. One-time setup

1. **Name/scope**: create the `@hapbeat` org on npmjs.com (free for public
   packages). Alternatively rename the package to unscoped `hapbeat` in
   `package.json` (also free as of 2026-06-01) — then `--access public` is not
   required but harmless.
2. **Token**: npmjs.com -> Access Tokens -> Generate **Automation** token.
   Add it to the repo: Settings -> Secrets and variables -> Actions ->
   `NPM_TOKEN`.
3. (Optional) When the GitHub repo is made **public**, add `--provenance` to the
   publish step in `.github/workflows/publish.yml`.

## 2. Release

```bash
# bump "version" in package.json (e.g. 0.1.0)
git commit -am "release: v0.1.0"
git tag v0.1.0
git push origin master
git push origin v0.1.0
```

The tag push runs `publish.yml`: `npm ci` -> build -> `node --test` (gate) ->
`npm publish --access public`. `prepublishOnly` also rebuilds `dist/` so a
manual publish can't ship a stale build.

Push the tag by name, separately from the branch, and never with the `--tags`
option: it sends every local tag, and GitHub creates no push event (so `publish.yml`
does not start) when more than three tags arrive in one push
([GitHub Docs](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#push)).
If the workflow did not start for a tag, run it by hand on that tag:

```bash
gh workflow run publish.yml --repo hapbeat/hapbeat-js-sdk --ref v0.1.0
```

### Manual fallback

```bash
npm run build && npm publish --access public
```

## Notes

- `dist/` is gitignored and built at publish time (`prepublishOnly`); `files`
  in package.json ships only `dist/`, `README.md`, `LICENSE`.
- The browser transport relays through hapbeat-helper; keep its
  `MIN`/compat expectations in sync if the helper WS API changes.
