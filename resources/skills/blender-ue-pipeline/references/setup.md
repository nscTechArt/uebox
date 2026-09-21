# Official Blender Lab MCP setup

## Contents

1. The one-click path — try this first
2. Platform support and macOS prerequisites
3. Windows prerequisites
4. Installing the official add-on
5. Two prerequisites that hide: online access and port conflicts
6. Four layers, one error message
7. The MCP Python component
8. Wiring the server into Box
9. How Box launches Blender, and what needs no Blender at all

## The one-click path

Box installs this itself: **Preferences → MCP → Connect Blender**. It checks Blender, Git and
Python first and names whichever is missing, runs the same setup script this document describes,
then writes the server entry into Box's MCP settings and reconnects. Nothing below has to be done
by hand when that button succeeds, and pressing it again repairs an install whose add-on step
failed. Tell the user to press it rather than walking them through the manual steps; the rest of
this document is the manual fallback and the explanation of what the button did.

Box does not install Git or Python — those are the user's machine and the user's choice. The
button names the missing one and where to get it.

## Platform support

Windows uses `setup_mcp.ps1`; macOS uses `setup_mcp.py`. Linux setup is not covered.
The Mac installer and process identification have automated tests, but a successful installation,
bridge query, and UE exchange on the actual target machine are still required for acceptance.

### macOS prerequisites and setup

Use an installed Python 3.11+ interpreter and Git. Run as the normal user, without `sudo`.
The installer fetches the same pinned official revision as Windows and installs its Python
dependencies; run it only for the requested integration setup, with network access available.

```sh
python3 /absolute/path/to/scripts/setup_mcp.py --blender-path '/Applications/Blender.app'
```

The script accepts either `.app` or `Contents/MacOS/Blender`, checks Blender 5.1+, and writes
the real executable path to `BLENDER_PATH`. It uses `venv/bin/blender-mcp` in
`~/Library/Application Support/UnrealBox/BlenderMcp/4309a396`; no PowerShell is needed.
Override with an absolute `--install-directory` when needed. An interrupted environment setup
is preserved and refused on retry: choose a new directory instead of deleting unknown files.
A completed environment can be reused to retry the add-on installation and enablement steps.
Restart an already open Blender so it loads the add-on, then verify the bridge as described below.

## Windows prerequisites

- Run it as `powershell -NoProfile -ExecutionPolicy Bypass -File setup_mcp.ps1 ...`. The default
  execution policy on Windows client blocks a plain `.\setup_mcp.ps1`.
- If the skill files arrived inside a downloaded archive they carry the Internet zone mark and are
  blocked even under RemoteSigned. Clear it with `Unblock-File`.
- `git` and a Python 3.11+ interpreter must be on PATH; the script reports a bare
  `Command failed: git` when they are not. The install also fetches a pinned revision from
  `projects.blender.org`, so it needs network access to that host.
- **Do not run it elevated.** The virtual environment and the Blender add-on install into the
  invoking user's profile; run it as Administrator and Box, running as the normal user, will not
  find either of them.
- A Blender that is already open does not pick up the add-on. Restart it, or let Box launch it.
- The install directory keeps a revision record. A first run interrupted halfway leaves a
  directory without that record, and later runs refuse it on purpose rather than deleting
  someone's files; remove that directory by hand before retrying.

## Installing the official add-on

Use the [official project](https://projects.blender.org/lab/blender_mcp), linked from
[Blender Lab](https://www.blender.org/lab/mcp-server/). The similarly named community
`blender-mcp` package is not a substitute for this add-on.

The official add-on requires Blender 5.1 or newer. Both setup scripts install and enable it for
you and verifies both; installing by hand from the Blender Lab extensions repository
(`https://lab.blender.org/`) works too. Bind to `127.0.0.1`; the default Blender add-on port is
9876. This does not require an official Box account.

## Two prerequisites that hide

**The add-on refuses to open its port unless Blender's online access is on**, because it treats
the local socket as going online. That setting is off by default, so a Blender the user opened by
double-clicking usually has no bridge no matter how correct the rest of the setup is. Box passes
`--online-mode` whenever it launches Blender, which is why leaving the launching to Box works
without changing any Blender setting; enabling Preferences → System → Network → Allow Online
Access once makes a hand-opened Blender work as well.

A port conflict looks the same from the outside: if anything else already holds 9876, the add-on
cannot bind it, and opening Blender will not help. Box detects this by handshaking with whatever
is on the port instead of only checking that the port is open, and asks for a different
`BLENDER_MCP_PORT` — which has to be changed in the add-on preferences too.

## Four layers, one error message

Four things have to hold for a bridge call to succeed, and **all four fail with the same single
message**, `Cannot connect to Blender at 127.0.0.1:9876`: the `blender-mcp` process is running,
Blender itself is running, the add-on is installed and enabled, and the bridge server is
listening. "Connected" in Box's MCP settings only means the first of those — it is the stdio
handshake with the bridge process, not proof that Blender is reachable. Confirm reachability by
reading `bpy.app.version_string` and `bpy.data.filepath`, not by trusting that status.

## The MCP Python component

Install the MCP Python component in its own environment using Python 3.11 or newer.
The current official source imports `mcp.server.fastmcp`, which MCP Python 2.x removed.
Install with the **`mcp[cli]>=1.2,<2` constraint** until the upstream server migrates.
Keep the chosen upstream revision and dependencies recorded; do not fetch updates during
ordinary Agent startup or substitute an unverified PyPI package with the same name.

## Wiring the server into Box

In Box, open Preferences → MCP → third-party servers. Add a stdio server named
`blender` pointing at the installed environment's **absolute `blender-mcp` executable**.
Box also needs file access to the Blender install directory and the temporary directory;
the default privacy scope only covers Unreal-related paths.
Arguments: `--transport stdio`. Fill the **Environment** box on that same row:

```
BLENDER_MCP_HOST=127.0.0.1
BLENDER_MCP_PORT=9876
BLENDER_PATH=ABSOLUTE_PATH_TO_YOUR_BLENDER_EXECUTABLE
```

The field also accepts a pasted JSON object with the same three keys, so the block
either setup script writes under the entry's `env` in `mcp-entry.json` can go in verbatim. A line it cannot read blocks
saving with the offending line quoted, rather than being dropped.

**`BLENDER_PATH` is not optional.** Without it Box cannot identify the server as a local Blender,
so it never launches one, and the official server falls back to whatever `blender` is on `PATH` —
which a Steam or portable install is not. Both the bridge tools and the background `*_for_cli`
family fail, and they fail the same way whether Blender is running or not.

Use the actual installed paths and configured port. Preserve existing MCP entries.
The current Box MCP client accepts stdio and Streamable HTTP; stdio avoids another HTTP listener.

Useful official tools include:

- `execute_blender_code`, returning a dict assigned to `result`.
- `get_objects_summary`, `get_object_detail_summary`, `get_blendfile_summary_path_info`.
- `get_python_api_docs`, `search_api_docs`, `search_manual_docs`.
- `get_screenshot_of_area_as_image`, `get_screenshot_of_window_as_image`.

Refresh and enumerate the actual tools rather than assuming a cached list. Test an actual
read of Blender's version and current file. A connected MCP server can still have an offline
Blender add-on. The official tools execute unrestricted Blender Python; keep them within
the Box's existing tool approval policy and use a dedicated modeling document.

## How Box launches Blender

Box starts Blender itself when a bridge tool is called and the configured port refuses the
connection: it runs `BLENDER_PATH` with `--online-mode`, waits for the add-on's auto-started
bridge, then repeats that one call and reports the automatic start in the result. Only a refused
connection does this. A timeout does not, because the code may already be executing. When Blender
is already open with its bridge stopped, Box does not open a second window; it reports that the
server has to be started in preferences. The `*_for_cli` tools and the `get_blendfile_summary_*`
family never need any of this — the official server runs its own `blender --background` from
`BLENDER_PATH`, so batch work needs no running Blender, no window and no bridge.

The Box client currently has a 120-second tool deadline. Keep the first prop operations
small; split expensive work and inspect completion after a timeout. Do not label a timeout
as cancellation of the Blender operation, or retry a paid generation/geometry mutation blindly.

The connection and scripts run locally after installation. External image-to-3D providers
are a separate, explicitly chosen generation path.
