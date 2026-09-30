# Packaging, releasing and the native module

中文：[packaging.zh-CN.md](packaging.zh-CN.md)

You don't need this page for day-to-day work — `pnpm install`, `pnpm dev` and
`pnpm verify` are enough, see the [README](../../README.en.md). Read this when you
need to produce an installer, cut a release, or get stuck on the `better-sqlite3`
ABI.

---

## Node version for development

Development uses [Node.js 24.21.0](https://nodejs.org/) and pnpm 10.28.2 (`npm i -g pnpm@10.28.2`).
The project configures pnpm to download and use the pinned Node version automatically; an existing
Node installation that can run pnpm is enough to get started. Check the project runtime with
`pnpm exec node --version`; `pnpm dev`, tests, and packaging all use it.

The first `pnpm install` compiles native modules and takes a few minutes.

---

## Packaging

Run `pnpm verify --with-build` to check desktop packaging and startup.
Official installers also require all **nine UE 5.0–5.8** plugin packages to be
present and match the source; a lone 5.5 package is insufficient. Install the
corresponding engines and C++ build tools, then run:

```bash
node scripts/build-all-plugins.mjs
```

For daily development, pick one target version and build it, for example
`pnpm plugin:build --engine 5.7 --project <uproject-path>`. To inspect an existing package:

```bash
pnpm plugin:check --engine 5.7   # only that package; needs no Unreal installation
pnpm plugin:check --all          # release check: the complete UE 5.0–5.8 set
```

There is no default version, and a missing package is never replaced by another version.
The package-format contract (supported versions, exclusion rules, zip naming, build stamp, source
fingerprint) lives in `scripts/plugin-package-format.mjs`; the check itself is
`scripts/plugin-check.mjs`.

### The everyday gate

`pnpm verify`, `verify:changed` and `verify:fast` run `pnpm verify:plugin`. It inspects a package
only when your change touches a **packaged input** — a file covered by the source fingerprint:
`plugin/UnrealAgentLink/{Source,Config,Content,Resources}/` and `UnrealAgentLink.uplugin`. Select
the target first — PowerShell `$env:VERIFY_PLUGIN_ENGINE = '5.7'`, bash
`export VERIFY_PLUGIN_ENGINE=5.7` — or override once with `pnpm verify:plugin --engine 5.7`.

Without Unreal installed you cannot produce a package: set `VERIFY_PLUGIN_ENGINE` to `none`. The
step reports `NOT RUN (declared: no Unreal on this machine)` and passes; state in the PR that the
plugin change was not compiled. `none` is rejected when an installed engine is detected. Detection
is only ever used to reject `none`, never to pass a check, so a misdetection costs at most a
false alarm.

Known limits:

- `LICENSE` and the packaging scripts (`build-plugin.mjs`, `plugin-package-format.mjs`, …) also
  affect the zip, but the stamp records only the source fingerprint, so no package can prove they
  were rebuilt. Unit tests and the full rebuild before `plugin:check:all` cover them.
- Scope is relative to your branch (`VERIFY_BASE` → `origin/main` → `main` → `HEAD`). After pulling
  someone else's plugin changes your local package may be stale and the gate will not say so —
  run `pnpm plugin:check --engine <version>` or rebuild before testing against Unreal.
- Conversely, a base that is behind attributes other people's plugin changes to you. The usual
  cause is a fork whose `main` was never synced with upstream: if the failure lists files you did
  not touch, sync your fork's `main` on GitHub (then `git fetch origin`), or set
  `VERIFY_BASE=<target branch>`, e.g. `VERIFY_BASE=upstream/main`.
- A passing package check means the zip matches the source. It does not mean the plugin compiles
  or works in the editor.
- CI (`pnpm verify --ci`) does not run this step and lists it as NOT RUN: the runner has neither
  Unreal nor packages.

### Official installers

Once all plugin packages are ready, build the official installer:

```bash
pnpm build:win      # Windows
pnpm build:mac      # macOS
pnpm build:linux    # Linux
```

Run Mac builds on macOS; they produce architecture-labelled DMG and ZIP files. Setting
`updateGithubRepo` also generates GitHub update metadata; leaving it empty embeds no feed.
The build command does not upload artifacts.

These commands run `pnpm plugin:check:all` first: the complete UE 5.0–5.8 set must be present and
fresh, and every other ZIP for the platform must pass too, whether or not Unreal is installed and
regardless of `VERIFY_PLUGIN_ENGINE` or `VERIFY_BASE`.

---

## Releasing

Uploading is a separate step. "Check for updates" reads the GitHub Releases of whichever
repository `updateGithubRepo` points at:

```bash
pnpm release:app              # dry run: prints what would ship, touches no network
pnpm release:app --publish    # actually publish
```

It uploads only the three files an update needs (installer, `.blockmap`, `latest.yml`), and
before publishing it checks that all three came from the same build, that the version matches
`package.json`, and that the source has been pushed. With `updateGithubRepo` unset it refuses
to run — such a build never checks for updates in the first place.

### Mac signing and notarization

Signing, notarization and an actual upgrade still
need validation before a Mac auto-update release; producing an installer does not prove them.

For a notarized release, configure a Developer ID Application signing identity and Apple
credentials following the [electron-builder notarization guide](https://www.electron.build/docs/notarization/)
(prefer `APPLE_KEYCHAIN_PROFILE` to reference credentials stored in Keychain). Run
`UEBOX_MAC_NOTARIZE=1 pnpm build:mac` to require signing and submit the app to Apple for notarization.
Missing credentials or a signing identity fail this mode. Ordinary builds do not submit to Apple;
uploading a release to GitHub remains a separate operation.

---

## About the better-sqlite3 native module

`better-sqlite3` is a native module, and Node and Electron need different ABIs;
the script reads the actual ABI from each current runtime. Both artifacts are
cached side by side instead of one being rebuilt over the other:

- the copy in `node_modules` stays on the **Electron** ABI, for `pnpm dev`
- tests read the **Node** ABI copy from the cache through a vitest alias
  (see `vitest.config.ts`)

So **you can run the tests while the app is open** — no switching, no rebuild.

```bash
node scripts/better-sqlite3-abi.mjs status
```

shows the cache. If the Node copy is missing, `ensure node` fetches it — it
prefers the official prebuilt binary and never writes into `node_modules`,
so it works with the app running.
