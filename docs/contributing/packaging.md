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

For daily development, use `node scripts/build-all-plugins.mjs --only 5.5`.
Once all plugin packages are ready, build the official installer:

```bash
pnpm build:win      # Windows
pnpm build:mac      # macOS
pnpm build:linux    # Linux
```

Run Mac builds on macOS; they produce architecture-labelled DMG and ZIP files. Setting
`updateGithubRepo` also generates GitHub update metadata; leaving it empty embeds no feed.
The build command does not upload artifacts.

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
