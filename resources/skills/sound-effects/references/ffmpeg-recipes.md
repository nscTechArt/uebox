# FFmpeg sound-effect recipes

## Contents

- Setup
- One-shots: click, confirm beep, coin pickup, laser, whoosh, footstep, explosion
- Seamless loop
- Normalize
- Measure

All recipes were run as written with FFmpeg 7.1 in Git Bash. They write mono 16-bit 48 kHz WAV.

## Setup

`run_shell_command` is bash. Put the path from `generate_sound_effect` in single quotes with
forward slashes, and keep filter graphs in double quotes:

```bash
FF='C:/ffmpeg/bin/ffmpeg.exe'
OUT='C:/Users/me/Music/UnrealBox/sfx'
O="-ar 48000 -ac 1 -c:a pcm_s16le -loglevel error"
```

Name files after the sound, not the recipe: `SFX_UI_Click.wav`, `SFX_Footstep_Wood_01.wav`.
Add `-n` instead of `-y` so an existing file is never overwritten.

## One-shots

Change the numbers to shape the sound: frequency (Hz) sets pitch, the `exp(-k*t)` factor sets
how fast it dies away (bigger k = shorter), lowpass `f` darkens, highpass `f` thins.

UI click (0.08 s):

```bash
"$FF" -n -f lavfi -i "aevalsrc='sin(2*PI*2000*t)*exp(-60*t)':s=48000:d=0.08" $O "$OUT/SFX_UI_Click.wav"
```

Confirm beep, two rising tones (0.25 s):

```bash
"$FF" -n -f lavfi -i "aevalsrc='0.6*sin(2*PI*if(lt(t,0.08),880,1320)*t)*exp(-8*t)':s=48000:d=0.25" $O "$OUT/SFX_UI_Confirm.wav"
```

Retro coin pickup, square wave (0.35 s):

```bash
"$FF" -n -f lavfi -i "aevalsrc='sgn(sin(2*PI*if(lt(t,0.07),988,1319)*t))*0.5*if(lt(t,0.07),1,exp(-10*(t-0.07)))':s=48000:d=0.35" -af "lowpass=f=6000" $O "$OUT/SFX_Pickup_Coin.wav"
```

Laser, falling pitch sweep (0.3 s). Pitch starts at 1500 Hz and falls by 5000 Hz per second:

```bash
"$FF" -n -f lavfi -i "aevalsrc='sin(2*PI*(1500*t-2500*t*t))*exp(-6*t)':s=48000:d=0.3" $O "$OUT/SFX_Weapon_Laser.wav"
```

Whoosh, band-passed pink noise swelling in and out (0.6 s):

```bash
"$FF" -n -f lavfi -i "anoisesrc=color=pink:d=0.6:seed=3:r=48000" -af "bandpass=f=1200:width_type=o:w=2,afade=t=in:d=0.3:curve=qsin,afade=t=out:st=0.3:d=0.3:curve=qsin" $O "$OUT/SFX_Whoosh.wav"
```

Footstep, four variants. Only `seed` changes, so they sound like the same surface:

```bash
for s in 1 2 3 4; do
  "$FF" -n -f lavfi -i "anoisesrc=color=brown:d=0.18:seed=$s:r=48000" -af "highpass=f=60,lowpass=f=900,afade=t=in:d=0.004,afade=t=out:st=0.01:d=0.17:curve=exp" $O "$OUT/SFX_Footstep_0$s.wav"
done
```

Explosion: low rumble plus a falling sub thump (2 s):

```bash
"$FF" -n -f lavfi -i "anoisesrc=color=brown:d=2:seed=7:r=48000" -f lavfi -i "aevalsrc='sin(2*PI*(60*t-10*t*t))*exp(-3*t)':s=48000:d=2" -filter_complex "[0]lowpass=f=500,afade=t=out:st=0.05:d=1.95:curve=exp[n];[n][1]amix=inputs=2:normalize=0,afade=t=in:d=0.005" $O "$OUT/SFX_Explosion.wav"
```

## Seamless loop

Generate L+F seconds, then crossfade the last F seconds over the first F (equal-power fades),
so the end flows into the start. L=10, F=2 gives a 10 s loop. Wind:

```bash
L=10; F=2
"$FF" -n -f lavfi -i "anoisesrc=color=pink:d=$((L+F)):seed=5:r=48000" -filter_complex "[0]lowpass=f=500,tremolo=f=0.2:d=0.5,asplit[a][b];[a]atrim=0:$L,asetpts=PTS-STARTPTS,afade=t=in:d=$F:curve=qsin[h];[b]atrim=$L:$((L+F)),asetpts=PTS-STARTPTS,afade=t=out:d=$F:curve=qsin[t];[h][t]amix=inputs=2:duration=first:normalize=0" $O "$OUT/SFX_Amb_Wind_Loop.wav"
```

Machine hum: replace the source and first filter with
`aevalsrc='0.4*sin(2*PI*55*t)+0.2*sin(2*PI*110*t)+0.05*(2*random(0)-1)':s=48000:d=$((L+F))`
and `lowpass=f=800`. Keep loop lengths so periodic tones complete whole cycles (55 Hz × 10 s does).

## Normalize

Peak-normalize to -1 dBFS in two passes: measure, then apply the difference.

```bash
f="$OUT/SFX_UI_Click.wav"
m=$("$FF" -i "$f" -af volumedetect -f null - 2>&1 | sed -n 's/.*max_volume: \(-\?[0-9.]*\) dB/\1/p')
"$FF" -y -i "$f" -af "volume=$(awk "BEGIN{print -1-($m)}")dB" $O "${f%.wav}_n.wav" && mv "${f%.wav}_n.wav" "$f"
```

For a variant set (footsteps), measure all files and apply **one** gain based on the loudest,
so the natural level differences between variants survive.

## Measure

```bash
"$FF" -i "$f" -af astats=measure_perchannel=0:measure_overall=Peak_level+RMS_level -f null - 2>&1 | grep -E "Duration|Peak level|RMS level"
```

Read Duration, Peak level (dBFS) and RMS level (dBFS) and compare against the checks in SKILL.md.
