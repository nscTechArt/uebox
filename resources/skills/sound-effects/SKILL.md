---
name: sound-effects
description: Produces game sound effects as UE-ready WAV files, either with the bound ElevenLabs sound-effect model or by synthesizing them locally with FFmpeg. Use when the user asks for 音效、做个脚步声、按钮点击声、爆炸声、枪声、拾取金币的声音、风声循环、UI 提示音 or sound variants for randomized playback. Do not use for background music (generate_task_music), dialogue or narration (generate_speech), or for editing Sound Cues and MetaSounds inside the engine.
---

# Sound effects

## Quick start

Always call `generate_sound_effect` first. It decides the route:

- `mode: "cloud"` — the user bound ElevenLabs. The WAV files are already made and saved to the
  asset library under AIGC/音效. Go straight to **Check the result**.
- `mode: "local"` — nothing is bound. The result gives `ffmpeg` (the executable path) and
  `outputDir`. Synthesize with `run_shell_command` using
  [references/ffmpeg-recipes.md](references/ffmpeg-recipes.md).
- `ffmpeg` is null — tell the user the two options in one sentence: install FFmpeg, or bind
  ElevenLabs under 偏好设置 → 模型来源 → 音效生成. Do not try other tools.

## Workflow

1. **Pin down the request.** One sound per call. Write the prompt as source + material + action +
   space: `"footstep, leather boot on wet stone, single step, close, dry"`. For several
   different sounds, make separate calls; `variants` is only for versions of the *same* sound.
2. **Pick the length.** One-shots (click, hit, footstep): leave `seconds` empty in the cloud route;
   0.05–0.4 s locally. Impacts and explosions: 1–3 s. Loops: `loop: true`, 5–15 s.
3. **Pick the route honestly.** Local synthesis is good at UI clicks, beeps, retro pickups,
   lasers, whooshes, noise-based impacts and wind or hum loops. It cannot make realistic
   recorded-sounding material (gravel steps, glass, voices, creatures). When the user wants
   those and only the local route is available, say so before synthesizing, and offer
   binding ElevenLabs.
4. **Make variants for repeated sounds.** Footsteps, gunshots and impacts play many times in
   a row; deliver 3–4 variants (`variants: 4` in the cloud route, different `seed` locally)
   so the user can randomize them in a Sound Cue or MetaSound.
5. **Check the result** (see below), then give every file as a local audio link.
6. **Import on request.** Pass the paths to `ue_content_import`. Mention that loops need
   Looping enabled on the Sound Wave, and that 3D positioned sounds should stay mono.

## Check the result

A successful tool call only proves a file exists. Measure each file with FFmpeg before
delivering (command in the recipes reference):

- Duration matches what you intended.
- Peak is about -1 dBFS: not clipping (0 dBFS) and not inaudibly quiet (below -20 dBFS).
- Not silent: RMS above -40 dBFS.

These numbers say nothing about whether it sounds right. You cannot hear the file: say that
plainly and ask the user to listen. For loops, ask them to preview with looping on and listen
for a click at the seam.

## Constraints

- Cost: in the cloud route every variant is billed separately. Default to 1 unless the sound
  repeats in game. Identical parameters reuse the existing file at no cost.
- Do not change the prompt and retry after a cloud failure until the cause is known; quote the
  error. If the error says a previous submission is unconfirmed, tell the user; do not delete
  the receipt yourself.
- Never overwrite a file the user already has; write new names into `outputDir`.
- Output format is fixed: WAV, 16-bit PCM, mono, 48 kHz locally. UE does not import MP3.

## Failure handling

- FFmpeg filter error: read the stderr line naming the filter, fix that filter only.
- The shell tool is missing (no Git Bash on the machine): the local route is unavailable; offer
  ElevenLabs instead.
- Cloud request rejected (HTTP 4xx): nothing was charged; report the provider's message.

## Escalation

Ask the user when the request mixes music and effects ("给这段加点音效和配乐"), when they want
a specific licensed sound library, or when a realistic sound is required but only local
synthesis is available.

Trigger and non-trigger examples: [references/trigger-examples.md](references/trigger-examples.md).
