# macOS desktop app

The desktop app packages the existing viewer with Tauri 2 and an official Node
runtime. Installed apps do not need Node, pnpm, a shell profile, or this checkout.
macOS 13.5 or newer is required by the bundled Node 24 runtime.

## Build and run

Build prerequisites: macOS, full Xcode 26 or newer, current stable Rust (at
least 1.88), Node >=22.13, and the pnpm version pinned in `package.json`.

```sh
pnpm install
pnpm desktop:dev
pnpm desktop:build
```

`desktop:dev` prepares the production web/server assets and starts a debug native
app. Rust changes reload through Tauri; after web or server edits, restart the
command to rebuild those assets. Use `pnpm dev` for the existing fast browser/HMR
workflow. The desktop commands do not require a separately running API or Vite.

`desktop:build` produces `.app` and `.dmg` bundles under
`src-tauri/target/release/bundle/`. The default target is the build machine's
architecture. Explicit per-architecture builds are also supported:

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
pnpm desktop:build --target aarch64-apple-darwin
pnpm desktop:build --target x86_64-apple-darwin
```

Explicit-target output is under `src-tauri/target/<target>/release/bundle/`.
Universal, Windows, Linux, updater, and App Store builds are not implemented.
An Intel artifact still needs validation on Intel hardware before distribution.

## Architecture

| Component | Responsibility |
| --- | --- |
| `src-tauri/src/main.rs` | Compose the app and enforce a single desktop instance |
| `src-tauri/src/window.rs` | Native window, external links, startup/failure presentation |
| `src-tauri/src/desktop.rs` | Connect service readiness and failures to the window |
| `src-tauri/src/server.rs` | Spawn, own, monitor, and reap the Node child |
| `apps/server/src/desktop.ts` | Private launch handshake, HTTP authentication, parent-pipe shutdown |
| `apps/server/tsdown.desktop.config.ts` | Bundle server dependencies without changing the npm CLI bundle |
| `scripts/desktop/prepare.mjs` | Assemble web/server resources and verified Node runtime |

The window first shows a bundled startup page. Node binds to `127.0.0.1:43187`
and announces readiness over stdout; Rust then navigates to the local viewer.
This separate, stable desktop port keeps browser-stored preferences across app
restarts and leaves the CLI's default port 5170 available. A port conflict is a
startup failure, not a silent connection to someone else's server. The private
`--desktop --port 0` combination exists for isolated process tests.

A random launch secret is exchanged for an HttpOnly, SameSite=Lax cookie, then
removed from the URL. All desktop HTTP requests, including static files and SSE,
require that cookie. The renderer has no Tauri command capabilities. Navigation
stays on the viewer's origin; external HTTP(S) links open in the default browser.
Session parsing, search, and context folding stay in their existing packages.

Closing the app closes the parent's stdin pipe to Node. Node uses the ordinary
shutdown path to close its stores. The parent allows five seconds before killing
and reaping an unresponsive child. Pipe EOF also shuts down Node when the native
parent crashes. Startup has a 30-second deadline; startup errors and later child
exits are shown in the window with the server log location.

Harness roots remain read-only. Server settings and search/listing caches retain
their existing locations and environment overrides. Browser and desktop have
separate UI preferences but share server settings by default. Finder does not
load shell profiles; custom root overrides must be present in the app's launch
environment. Server logs are stored at
`~/Library/Logs/com.harnesstrajectory.desktop/server.log` and replaced each launch.

## Runtime and packaging

The prepare script downloads Node **24.21.0** from `nodejs.org`, verifies the
architecture-specific SHA-256 pinned in source, and caches the archive in
`.desktop-cache/`. Updating Node requires updating both hashes from that
release's `SHASUMS256.txt`. Homebrew Node is deliberately not copied because it
can depend on dynamic libraries outside the application bundle.

Tauri embeds Node through `externalBin`; server JavaScript, web assets, and license
notices are resources. Generated resources, runtime binaries, and Cargo build
output are ignored by Git. `Cargo.lock` and the source icon assets are tracked.
Icons are derived from `apps/web/src/assets/brand-icon.png`.
`src-tauri/icons/Trajectory.icon` is the editable Icon Composer document for
macOS 26. Its image layer is an unchanged copy of that source; the scale maps
the 1254-pixel image onto Icon Composer's 1024-point canvas. An opaque navy fill
covers the transparent corners, while glass and translucency are disabled to
preserve the artwork. `scripts/desktop/prepare-icons.mjs` compiles the document
into the ignored `icons/generated/Assets.car`; Tauri copies it and sets
`CFBundleIconName`. The existing `.icns` remains bundled for older macOS.
Shipping only `.icns` makes Tahoe shrink this artwork into a white compatibility
frame. When changing the brand source, update the Icon Composer image layer as
well as the fallback icon sizes. Full Xcode 26+ is checked before preparation so
an older asset compiler cannot silently restore that frame.
The icon compiler runs with a valid stdin and an isolated worker to avoid
[Tauri's direct `.icon` compilation failure](https://github.com/tauri-apps/tauri/issues/15315).
To regenerate just the native icon, run `node scripts/desktop/prepare-icons.mjs`.

Local builds do not configure Developer ID signing or notarization. Public
distribution needs the appropriate Apple credentials and the normal Tauri
signing/notarization flow. `Entitlements.plist` enables JIT for the embedded V8
runtime; validate the signed sidecar on the target macOS versions before release.

References: [Tauri external binaries](https://v2.tauri.app/develop/sidecar/),
[macOS signing](https://v2.tauri.app/distribute/sign/macos/), and
[Node 24 platform requirements](https://github.com/nodejs/node/blob/v24.21.0/BUILDING.md).
The Tauri layout also follows the sibling `cc-switch` project's separation of
native configuration, Rust entry point, build hooks, and application icons.

## Verification

```sh
pnpm typecheck
pnpm test
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml
pnpm desktop:build
pnpm desktop:smoke
pnpm desktop:smoke "src-tauri/target/release/bundle/macos/Harness Trajectory.app"
```

The smoke check runs the actual bundled runtime from a temporary working
directory, with synthetic transcript roots and a separate cache. It exercises
authentication, production HTML/JavaScript, APIs, SSE replay, SQLite, and stdin-EOF shutdown.
It does not prove WebKit rendering or notarization; open the `.app` to check the
native window, navigation, and normal quit behavior.
