# Screenshots: what the image can and cannot tell you

## Contents

- [Delivery: the file, not the call](#delivery-the-file-not-the-call)
- [Read `cameraSource` before reading the picture](#read-camerasource-before-reading-the-picture)
- [Which world was captured](#which-world-was-captured)
- [When the frame is not final](#when-the-frame-is-not-final)
- [Exposure runs dark — always](#exposure-runs-dark--always)
- [Overwriting](#overwriting)

## Delivery: the file, not the call

`uebox viewport screenshot --output <path.png>` is finished only when a valid PNG exists at
that path. The command checks the file itself — that it exists, is non-empty, is really a
PNG, and that its dimensions match what the engine reported — before it reports success.
Verification failure always exits non-zero.

So a zero exit code means the file is there. Read it from `artifacts[0].path`, which is an
absolute path. Image bytes are never printed; a compressed preview travels in the
protocol, but the delivered file is the engine's original.

`--output` is required and only accepts `.png` in this version. Relative paths resolve
against the current directory. Missing parent directories are created.

## Read `cameraSource` before reading the picture

`data.cameraSource` says where the camera came from:

| Value | Meaning |
|---|---|
| `viewport` | The user's editor viewport camera — this is the picture they see |
| `player` | The PIE player's view, because the game is running |
| `fallback` | **No perspective viewport was found.** A fixed camera was used instead |
| `null` | An older plugin that does not report this |

On `fallback` the framing is arbitrary and the command emits a warning. **An object missing
from the picture does not mean it is missing from the scene.** Do not draw conclusions;
ask the user to bring a level viewport forward, or to send their own screenshot.

`cameraLocation` is in centimetres and can be compared against actor coordinates from
`ue_get_actor` (via `uebox tools call`) to confirm the camera is pointed where you think.

## Which world was captured

`data.world` is `pie` when a Play-In-Editor session is running and `editor` otherwise;
`data.view` says whether the camera was the player's or the viewport's. This matters: a
picture of the editor world says nothing about what is happening in a running game, and
the two look similar enough to fool a reader who does not check.

Pass `--world editor` to force the editor world while PIE is running — for example to
check level layout rather than gameplay.

## When the frame is not final

The plugin waits for shader and asset compilation and flushes texture streaming before
capturing. What it could not finish comes back as a warning listing pending shaders,
pending assets, or in-flight streaming requests.

When that warning is present the materials may still be grey and the textures blurry.
**Do not diagnose a material or texture problem from that frame.** Wait and take another.

## Brightness depends on the exposure lock

`data.exposure` says which exposure the frame used, and the warnings spell out what follows.

- `manual`: the scene uses manual exposure (an unbound PostProcessVolume, Metering Mode =
  Manual). The capture, the editor viewport and the running game share one brightness, so
  over- and under-exposure can be judged from the image.
- `manual` with `exposureSource: viewport`: locked by the editor viewport only. True in the
  editor; PIE and packaged builds still follow the project's post-process settings.
- `auto`: every view converges on its own brightness and darkened scenes get pulled back up.
  The image has no brightness baseline. Lock exposure first, then tune lights or Exposure
  Compensation.
- `null`: an older box or plugin did not report it. Treat it like `auto`.

Whatever the exposure, the image is reliable for whether an object is present, where it is,
what colour a material is, whether a light is on, shadow direction and composition.

Do not dismiss a "too bright" or "too dark" report as capture bias. With exposure locked, the
capture is what the player sees.

## Overwriting

An existing target file is never replaced silently: without `--overwrite` the command
stops with exit code 2 (`OUTPUT_EXISTS`) before contacting the engine at all, so nothing is
rendered and nothing is lost.

With `--overwrite`, the new image is written to a temporary file in the same directory and
renamed into place. If anything fails along the way the original file is left untouched.
