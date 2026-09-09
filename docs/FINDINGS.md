<!--
Published copy of the working record. Organisational identifiers were removed by
analysis/sanitize-findings.mjs; the findings themselves are unedited. Vendor and deployment
names are replaced with generic descriptions because no result here depends on them.
-->

# Critical finding: `use_ram` is inactive in the production lipsync path

**Discovered 2026-08-26 during code review. This changes the optimization story.**

## The mechanism

`hummingbird/inference.py:61` sets `self.use_ram = True`, but line 96 immediately
overwrites it:

```python
def initialize_paths(self, video_input, audio_path, output_dir, video_id):
    self.use_ram = isinstance(video_input, list)
```

The two entry points pass different types (`run_instant_model.py`):

| Path | line | `base_video` argument | type | `use_ram` |
|---|---|---|---|---|
| plain lipsync | 193 | `adjusted_source_video_path` | `str` | **False** |
| word replacement | 259, 322 | `base_video_segment_frames` | `list` | **True** |

So the in-memory tensor pipeline — commit `f5f56a0`, the optimization the article
materials treat as the headline shipped contribution — **only runs for word
replacement.** Plain lipsync writes every stage boundary to disk.

## Confirmed empirically

The production lipsync logs (`logs/run_a/`, the production deployment, 2026-07-27) show
**11 intermediate video files** written per job:

```
1_r9dfbfca75.crop.mp4              1_r9dfbfca75.liveportrait.mp4
1_r9dfbfca75.crop_lp.mp4           1_r9dfbfca75.liveportrait_reshaped.mp4
1_r9dfbfca75.geometry.mp4          1_r9dfbfca75.rgb.mp4
1_r9dfbfca75.original_geometry.mp4 1_r9dfbfca75.paste_back_with_audio.mp4
1_r9dfbfca75.mask.mp4              1_r9dfbfca75.lip_mask.mp4
source_video_25fps_adjusted.mp4
```

Four code sites gate these writes on the flag (`write_to_disk = self.debug or not
use_ram`): `cropper.py:268`, `cropper.py:319`, `renderer/predict.py:144`,
`LivePortrait/src/live_portrait_pipeline.py:507`.

## Why this matters

1. **The article materials are wrong on this point.** `article_materials/OPTIMIZATIONS.md`
   §1.1 and `ARTICLE_MATERIALS.md` §8 present `use_ram` as the shipped production
   optimization. For lipsync it is not active. Correct before publishing.

2. **The measured baseline includes the disk-write cost.** All five baseline runs
   (642.5 s wall / 528.8 s pipeline) were `use_ram=False`. Stage timings such as
   `render_rgb` 129.6 s *include* encoding `rgb.mp4`.

3. **This is a real, available, author-owned optimization.** Enabling the in-memory
   path for lipsync is the author's own design being finished, not a colleague's
   roadmap item — and it plausibly dwarfs the renderer fp16/batch work, since it
   removes ~10 encode+decode round-trips of 1080p video per job.

4. **It gives a clean before/after** of the kind the PR team asked for: the toggle
   already exists, both arms are one flag apart, and the harness to measure them
   is built.

## It is not a one-line flag flip — and that makes it a better story

`MyCropper.paste_back` (`hummingbird/cropper.py:374-378`) returns **different types**
depending on the flag:

```python
if use_ram:
    return out_list      # list of frames
return out_path          # str
```

The lipsync tail assumes the `str` branch (`run_instant_model.py:208-212`):

```python
final_output_watermark_path = final_output_video_only.replace(".mp4", "_watermark.mp4")
final_output_path = attach_audio(final_output_video_only, driving_audio)
```

Flipping the flag alone would hand a `list` to `.replace()` and raise
`AttributeError`. Enabling the in-memory path for lipsync therefore requires
adapting the tail: keep intermediates in RAM and write the video **once** at the
end, instead of eleven times.

The word-replacement path already does exactly this — note its variable is named
`final_video_frames` (`run_instant_model.py:259`) — so the frame-handling code to
reuse already exists in the repo.

This is a genuine design change rather than a configuration toggle, which makes it
both more work and more defensible as an engineering contribution.

## Next step

1. Route the lipsync tail through the frame-handling path (reuse the
   word-replacement logic), writing the final video once.
2. Expose the choice explicitly (env var or prediction input) rather than inferring
   it from the argument type — inferring behaviour from a parameter's runtime type
   is what hid this for over a year.
3. Run both arms through `experiment.py`. The quality gate matters here in the
   author's favour: removing ten rounds of intermediate H.264 re-compression should
   if anything *improve* output, so LSE-D should hold or improve. If it worsens,
   something else is wrong.

---

# The pipeline is non-deterministic, and it invalidates the original quality gate

**Measured 2026-08-26.** Two independent predictions, same input clip, same deployed
version (`382101e9`), nothing else varied:

| comparison | result |
|---|---|
| bit-identical frames | **0 of 1074** |
| PSNR | mean 45.23 dB, min 44.42 |
| SSIM | mean 0.98459, min 0.98211 |
| worst pixel difference | **91 of 255 levels** |
| LSE-D | 8.707 vs **8.963** (Δ 0.256) |
| LSE-C | 6.591 vs **6.303** (Δ 0.288) |

Almost certainly the audio-to-expression **diffusion** model sampling unseeded noise —
a diffusion sampler is stochastic by construction unless a generator is fixed.

## Consequences

1. **The 0.05 LSE-D tolerance was ~5× below the noise floor.** It would reject
   harmless changes and could not detect a real regression. Raised to a provisional
   0.35 with the measurement recorded in `experiment.py`.
2. **Bit-exactness is unavailable as evidence**, so "the optimization did not change
   the output" can never be shown directly. Every quality claim must be a comparison
   against this null distribution.
3. **Earlier determinism claim was about the wrong thing.** Re-scoring the *same file*
   twice gives identical LSE (8.70665168762207 both times) — that is evaluator
   determinism. Re-*generating* differs by 0.256. Only the second number bounds an A/B.
4. **LSE is the wrong primary instrument regardless.** Zhang et al. (ICIP 2024,
   arXiv:2403.06421) measure 2AFC agreement with human judgement at **LSE-D 0.2815
   and LSE-C 0.2333, where 0.5 is chance** — below chance, i.e. anti-correlated.
   `compare_outputs.py` (PSNR/SSIM/max-abs-error against the fp32 reference) is now
   the primary guard for a precision change, explicitly labelled as *numerical
   agreement, not perceptual quality*; LSE stays secondary.

## The fix worth making first

**Seed the animator's sampler.** A reproducible pipeline turns every quality question
from a statistical one into a direct comparison, and it costs a `torch.Generator`. Until
then any A/B needs ≥5 regenerations per clip per arm just to establish its own baseline,
which multiplies the run count by five for a weaker result.

Two supporting conventions worth adopting from the literature:
- **MLPerf** requires implementations to land *"within 1% of the FP32 reference
  model's accuracy"* — a ready-made, citable form for the quality gate.
- **Heiser's benchmarking rules**: *"never use the same data over and over"* (a repeated
  clip measures a warm decode/page cache) and *"run sufficient warm-up iterations which
  aren't timed"* — our runs all included 253–307 s of cold start.

---

# Ground-truth control: LSE-D has almost no usable dynamic range here

The literature recommends scoring real footage as a control, on the grounds that
generated video routinely *outscores* ground truth on LSE — which would demonstrate the
metric is broken. Measured on our data (2026-08-26):

| video | LSE-D ↓ | LSE-C ↑ |
|---|---|---|
| **Ground truth** — original unedited footage, real speech | **8.055** | **6.997** |
| Generated, run A | 8.963 | 6.303 |
| Generated, run B | 8.707 | 6.591 |
| *same-build generation noise* | *0.256* | *0.288* |

**Our ground truth does score best**, so the pathology the literature warns about does
not reproduce here — report that plainly rather than repeating the claim.

But the more useful number is the ratio. The entire gap between *real human footage* and
*our generated output* is **0.65–0.91 LSE-D**, against a generation noise floor of
**0.256**. So the full dynamic range of the metric, from real video to synthetic, spans
roughly **three noise units**. LSE-D can distinguish "real" from "generated" and little
else. It cannot resolve the sub-percent output changes a precision optimization produces,
which is the question we actually need answered.

This is an independent argument for the same conclusion as the ICIP 2024 2AFC result:
use `compare_outputs.py` (reference-based PSNR/SSIM against the fp32 output) as the
primary guard, and keep LSE as a collapse detector.

**Caveats on this measurement.** The ground-truth clip is the full 131 s source while the
generated outputs are 43 s segments of it, so content and duration differ; `offset` was 1
for GT and 0 for both generations. n=1. Treat the ratio as an order-of-magnitude argument,
not a precise figure — but the order of magnitude is what matters here.

---

# Local runnability, corrected — and why it used to work on a MacBook

An earlier note in this workstream claimed five blockers to running the pipeline on
macOS. **Three of those were wrong.** Tested empirically 2026-09-08:

| Claimed blocker | Verdict |
|---|---|
| `decord` has no arm64 wheel | **WRONG — never imported.** Present in `requirements.txt` only; zero `import decord` in the repo |
| `onnxruntime-gpu` has no arm64 wheel | **WRONG — code imports generically.** Every call site is `import onnxruntime`; the `-gpu` build is a deployment choice. CPU onnxruntime satisfies it |
| Python 3.14 vs 3.10 | **Real but self-inflicted.** `uv venv --python 3.10` resolves it in seconds; `descript-audiotools` then imports fine (it fails on 3.14 with a metaclass error). MPS is available |
| `nvdiffrast` | **REAL.** CUDA/OpenGL mesh rasteriser, not on PyPI, needed for FLAME UV rendering. Imported at module scope by `facetrack/.../face_tracker.py` → on the `track_face` path |
| `mamba_ssm` | **REAL.** CUDA kernels. Imported by `audio_diffusion_model/.../flow_matching_talking_head.py` → on the `run_animator` path |

So: **exactly two hard CUDA blockers**, both in the current pipeline, and both can be
stubbed for *import* (see `benchmarking/stubs/`) but not for execution.

## Why it genuinely used to run on a MacBook

`git log -S` shows both CUDA dependencies entered the repo in the **same commit** —
`9f8ec0f`, 2025-03-30, *"Add new renderer and animator"*. Before that date the pipeline
had neither. Verified directly:

```
git show f5f56a0:requirements.txt            | grep -c nvdiffrast|mamba  -> 0
git show origin/classic_lipsync:requirements.txt | grep -c nvdiffrast|mamba  -> 0
```

The pre-Hummingbird pipeline (ClassicLipsync + LivePortrait) — **which is exactly the
code `f5f56a0` optimized in December 2024** — has no CUDA-only dependencies and would
run on Apple Silicon. The system became GPU-only on 2025-03-30 with the new renderer
and animator.

Two useful consequences:

1. **The recollection of running it locally is correct**, and it dates the memory: it was
   the pre-March-2025 pipeline. `origin/classic_lipsync` still exists if a local run is
   wanted for illustration.
2. **It sharpens the December 2024 contribution story.** That optimization was made on a
   pipeline the author could run, profile, and iterate on end-to-end locally — which is
   a plausible reason the in-memory transport idea occurred there first.

## What can be exercised locally today

Everything except `track_face` and `run_animator` execution: the renderer model (proven —
30.5M params, forward pass, batch invariance, fp16 deviation, attention overflow), video
readers, the renderer dataset, the cropper, and the full LSE evaluation. `verify_local.sh`
covers this.

---

# The image builds but does not start — and it is not the renderer changes

**Evidence, 2026-09-08.** Two independent deploys of `main` + renderer changes both
ended the same way:

| attempt | version | outcome |
|---|---|---|
| 2026-08-26 | `1059d3dd` | created, never promoted, de-listed; predictions `"Prediction failed to start"`, **0 log lines**, `predict_time: 2e-06`, terminated after ~24 h |
| 2026-09-08 | `c32b7655` | **promoted**, then rolled back and removed from the versions listing; prediction never booted |

`latest_version` is back to `fa69fda4` (2025-05-23) both times. the hosting platform promotes the
new version, the container fails its health check, and the platform reverts.

## What this rules out

- **Not `basicsr`.** The August build had it *installed* (relocated into `cog.yaml`'s
  `run:` steps); the September build had it *removed*. Both failed identically. Its
  presence is not the discriminator.
- **Not a slow image pull**, which was the first hypothesis. `"Prediction failed to
  start"` with zero log lines is a startup failure, not a scheduling delay.
- **Probably not the renderer changes.** They are ~24 lines of standard torch calls, they
  compile, and they run correctly against the real 30.5M-parameter model locally
  (`benchmarking/tests/test_real_model_cpu.py`).

## The likely cause, and how it is being tested

`test.yml` had **0 runs ever** before this work, and main's first build attempt failed
outright on `basicsr` dependency rot. **The last successful deploy was May 2025.** The
most probable explanation is accumulated dependency drift: the image now builds but
resolves a package set that fails at import or startup.

**CONFIRMED 2026-09-08.** The diagnostic branch `diag/main-plus-buildfix` — origin/main
with *nothing* changed but commenting out the unused `basicsr` requirement — built
successfully, promoted as `daf0609b`, and was then **rolled back to `fa69fda4` and removed
from the versions listing**, exactly like the two builds carrying renderer changes. Its
probe prediction sat 25+ minutes with `started_at: null` and zero log lines.

Three consecutive rollbacks:

| build | contents | outcome |
|---|---|---|
| `1059d3dd` | main + renderer changes, basicsr relocated | rolled back |
| `c32b7655` | main + renderer changes, basicsr removed | rolled back |
| **`daf0609b`** | **main only, no renderer changes** | **rolled back** |

**Conclusion: current `main` does not produce a runnable image.** The renderer changes on
`perf/low-risk-optimizations` are not implicated — the failure reproduces without them.

## Why this matters beyond the experiment

If confirmed, **the team cannot ship this repo** — independent of anything to do with the
article. That is a production risk worth raising on its own, and it also means no
before/after measurement is possible until the image runs, because there is nothing to
measure against.

## Root-cause candidate: the image is unreproducible by construction

`requirements.txt` leaves **28 of 62 dependency lines unpinned** (no `==`), including
packages the pipeline actually imports: `kornia`, `openai-whisper`, `encodec`,
`resampy`, `python_speech_features`, `pykalman`, `phonemizer`, `g2p_en`.

Every rebuild therefore resolves a *different* environment. The last successful deploy
was **May 2025**, so a build today picks up ~16 months of upstream drift in those 28
packages. `basicsr` failing on an `nvidia-cublas` conflict was simply the first such
breakage to surface at *build* time; a startup failure is the same class of problem
surfacing later.

`predict.py`'s `setup()` makes this worse by doing heavy work before the first
prediction: it constructs `InstantModel`, then builds the MaskGCT stack
(`build_semantic_model` → w2v-bert-2.0, plus semantic/acoustic codecs and t2s/s2a
models) with `hf_hub_download`. Anything version-sensitive in that path — and
`transformers` is pinned at 4.50.0 while `tokenizers`/`accelerate` interact with it —
fails during setup, which presents to the hosting platform exactly as observed:
**`"Prediction failed to start"` with zero log lines.**

### Implications

1. **For the deploy:** pinning is the fix, not a workaround. Reconstruct a working
   lock from the May 2025 image if it can be pulled, or bisect the unpinned set.
2. **For the article:** a pipeline whose environment cannot be reconstructed cannot
   support a reproducibility claim. Journal artifact badges (GRSI, ACM) all require a
   reproducible build. This is worth fixing on its own terms.
3. **For the team:** the repo has no lockfile and no deploy in 16 months. The next
   person to need a production deploy discovers this under time pressure.

---

# The image's dependency graph is unsatisfiable as built — found by locking it

**2026-09-08.** Resolving `requirements.txt` as of the last good build date exposed two
concrete defects, both of which are consistent with `"Prediction failed to start"` and
zero log lines.

## Defect 1 — resolution happens against a different torch and numpy than the image ends up with

`requirements.txt` pins neither torch nor numpy. Resolved today (or on any date after
mid-2024) it selects:

| package | resolver picks | what `cog.yaml` then installs |
|---|---|---|
| torch | **2.7.0** | 2.5.1 (`run:` step, cu121) |
| torchvision | **0.22.0** | 0.20.1 |
| torchaudio | **2.7.0** | 2.5.1 |
| numpy | **2.2.6** | **1.23.1** |
| numba | **0.61.2** | 0.60.0 |
| onnxruntime | 1.22.0 | uninstalled, replaced by onnxruntime-gpu 1.18.0 |

Every other wheel in the image — `scikit-image`, `opencv`, `albumentations`,
`transformers` — is chosen while numpy 2.2.6 and torch 2.7.0 are the intended targets,
and is then left in place when the `run:` steps downgrade torch by two minor versions and
numpy across a **major** version boundary. Packages compiled against the numpy 2.x C ABI
raise `ImportError` on numpy 1.x at import time. `setup()` imports the entire stack before
the first prediction, so the failure surfaces as a container that never becomes healthy —
which is exactly what the hosting platform reports.

## Defect 2 — the numpy pin contradicts a pinned dependency

`albumentations==1.4.1` (pinned in `requirements.txt`) requires `numpy>=1.24.4`.
`cog.yaml` installed `numpy==1.23.1` as its **last** build step. The resolver refuses this
outright:

```
Because albumentations==1.4.1 depends on numpy>=1.24.4 and numpy==1.23.1,
we can conclude that albumentations==1.4.1 cannot be used.
```

pip tolerated it only because the downgrade came after `albumentations` was already
installed, leaving a permanently violated constraint in the image. `numpy==1.23.1` was
introduced in `eaeac7a` ("Integrate new lipsync model", 2025-04-07) — before that commit
nothing forced numpy at all.

## The fix

`requirements.lock`: `uv pip compile` with `--exclude-newer 2025-05-23` (the day of the
last successful build) plus a constraint file holding the versions `cog.yaml` actually
installs, so resolution agrees with the container's final state instead of contradicting
it. 220 packages, all pinned, both git dependencies pinned to commits. numpy moves to
**1.26.4** — the final numpy 1.x release, which satisfies `albumentations` 1.4.1,
`numba` 0.60 (`<2.1`), `scipy` 1.13.1 and `scikit-image` 0.24 while keeping 1.x
semantics. `cog.yaml`'s trailing numpy step was changed to match; a mismatch there
re-creates defect 2.

`chumpy==0.70` is appended verbatim: its `setup.py` imports `pip` at build time without
declaring it, so no resolver can build its metadata. It was already exactly pinned.

**Status: not yet confirmed as the cause.** It is a defect found by construction, not by
reading a traceback — the hosting platform returns none. Confirmation requires running `setup()`
inside the built image where the exception is visible.

---

# Seeding, corrected: the seed exists but is consumed once

The earlier note above attributes run-to-run variation to an "unseeded diffusion
sampler". That is imprecise, and the real mechanism matters for how the A/B is run.

`AudioDiffusionModel.__init__` **does** seed — `seed_everything(42)` at
`hummingbird/audio_diffusion_model/models.py:77`. But the model is constructed once, at
container setup, so the seed is consumed once. The flow-matching sampler then draws fresh
noise for every 60-frame chunk of every prediction
(`expressive_avatars/models/flow_matching_talking_head.py:724`, reached with
`motion_at_T=None` from `models.py:557`).

Consequences:

1. **The first prediction after a cold start is reproducible; later ones in the same warm
   process are not**, because each inherits an RNG state advanced by its predecessors.
   Two measurements taken as "same build, same clip" are only comparable if they occupy
   the same position in their container's lifetime — which nothing was controlling.
2. `seed_everything` **does not seed numpy**, so any numpy-side randomness was never
   covered.
3. It sets `cudnn.deterministic = True` and `cudnn.benchmark = False` **process-wide**,
   as a side effect of seeding. See the next finding.

**Change:** `shared_utils/repro.py` reseeds `random`, `numpy`, and torch (CPU + all CUDA
devices) at the start of each run, called from `run_end2end` and `Predictor.predict`.
Off unless `LIPSYNC_SEED` is set, so production behaviour is unchanged.
`LIPSYNC_DETERMINISTIC=1` additionally requests deterministic torch kernels.

Reseeding is necessary but may not be sufficient — onnxruntime's CUDA execution provider,
nvdiffrast, and atomic scatter/index kernels can still vary. **The residual after seeding
must be measured on GPU and reported as the floor.** Do not assume it is zero.

---

# The renderer pays for determinism it never asked for

Because `seed_everything` disables `cudnn.benchmark` process-wide at animator
construction, the neural renderer runs its entire loop without autotuned convolution
kernels. That loop is the ideal case for autotuning: hundreds of convolutions at one
fixed input shape, 24.5 % of pipeline time.

Nothing chose this. It is a side effect of a seeding helper written for the animator,
applied to a process that also contains a renderer.

`RENDER_CUDNN_BENCHMARK=1` (`hummingbird/renderer/predict.py`) re-enables benchmark mode
around the render loop only and restores the previous flags afterwards, leaving the
animator's determinism intact. It must be guarded with `compare_outputs.py`: different
kernels sum in a different order, so output can shift slightly while the arithmetic stays
equivalent. Expected gain is unmeasured — this is a hypothesis with a mechanism, not a
result.

---

# Open-dataset run: the pipeline's cost is resolution-independent except at paste-back

> **Corrected 2026-09-09 after an independent audit.** The table below was computed from
> **one** clip and the surrounding text quoted it as a property of the twelve-clip set. The
> full-set numbers are in the section that follows, and they are weaker: "nine of ten stages
> within 13 %" holds for *mean* per-frame cost, not per clip, and `track_face` sits
> systematically 13 % high rather than landing inside the band. The single-clip table is
> kept below as the original observation; **use the full-set section for any claim.**

**2026-09-09.** First HDTF clip through the deployed production version `382101e9`
(`hdtf01_RD_Radio11_001`, 478×478, 751 frames, 30.0 s). Stages reconcile to the
independently reported `run_lipsync` total within **0.02 s**.

Normalising per frame against the internal 1080p baseline (mean 1100 frames) separates
the two kinds of stage cleanly:

| stage | 1080p (s) | 478px (s) | per-frame ratio |
|---|---|---|---|
| crop_face | 30.67 | 18.73 | 0.89 |
| detect_landmarks | 7.76 | 5.31 | 1.00 |
| parse_face | 39.66 | 29.23 | 1.08 |
| track_face | 146.61 | 112.64 | 1.13 |
| run_animator | 6.70 | 4.54 | 0.99 |
| create_driving_geo_and_mask | 19.70 | 13.87 | 1.03 |
| predict_liveportait | 62.01 | 45.51 | 1.07 |
| reshape_liveportrait | 12.97 | 9.10 | 1.03 |
| render_rgb | 129.63 | 85.64 | 0.97 |
| **paste_back_video** | **73.05** | **12.40** | **0.25** |
| total | 528.76 | 336.96 | — |

Nine of ten stages land within 13 % of the baseline per frame, across a **4.5× change in
pixel count**. Only `paste_back_video` collapses, to a quarter of its per-frame cost — and
that is exactly the stage that composites the generated face back into the full-resolution
source frame. `crop_face` is mildly resolution-sensitive at 0.89 for the same reason,
operating on full frames.

Two things follow:

1. **The measurement instrument is sound.** Stage costs that should be
   resolution-independent are, to within a tenth, on inputs the pipeline had never seen.
   That is a stronger check on the timing methodology than repeating the internal clips.
2. **13.8 % of production pipeline time is spent on resolution-dependent compositing**, not
   on the model. `paste_back_video` is the third-largest stage at 1080p and nearly vanishes
   at 478 px. It is not on anyone's optimization roadmap, and unlike the renderer items it
   is I/O and pixel plumbing rather than a numerics change — which makes it low risk.

Quality on the same clip, via SyncNet (open Wav2Lip protocol, CPU):

| | LSE-D ↓ | LSE-C ↑ |
|---|---|---|
| generated | 7.936 | 7.696 |
| **ground truth** (the unedited source clip) | **6.825** | **9.131** |
| *same-build regeneration noise* | *0.256* | *0.288* |

Ground truth scores better on both, by 1.11 LSE-D.

> **The sentence that stood here is withdrawn.** It read: *"the generated HDTF output scores
> better than the internal-clip baseline mean, on a dataset the system was not tuned for."*
> HDTF's own ground truth scores 6.637 against the internal set's 7.415, so the dataset is
> simply easier for this metric — for real and synthetic video alike. Absolute LSE-D does not
> compare across datasets. See "The two datasets, now directly comparable" below.

---

# Build root cause, named: `av` dropped Python 3.10 five days before the last good deploy

**2026-09-09.** Pushing the locked build produced the first informative failure this
workstream has seen. It failed at `pip install -r requirements.txt`:

```
Collecting av==14.4.0
  Downloading av-14.4.0.tar.gz (3.9 MB)
  ...
  Warning! You are installing from source.
  It is EXPECTED that it will fail. You are REQUIRED to use ffmpeg 7.
  No package 'libavdevice' found
  pkg-config could not find libraries ['avformat', 'avcodec', 'avdevice', ...]
error: subprocess-exited-with-error
```

## The chain

1. `faster-whisper==1.1.0` depends on `av>=11`. `av` is nowhere in `requirements.txt`; it
   arrives transitively.
2. **`av 14.4.0`, released 2025-05-16, dropped CPython 3.10 wheels.** Verified against the
   PyPI JSON API: 14.2.0 and earlier ship `cp310` manylinux x86_64 wheels; 14.4.0 ships
   none.
3. The image is Python 3.10, so pip finds no usable wheel and falls back to the sdist.
4. Building `av` from source needs the ffmpeg **development headers**. `cog.yaml` installs
   the `ffmpeg` binary, not `libav*-dev`, so pkg-config fails.

The last successful deploy was **2025-05-23**, five days after 14.4.0 appeared. So this
build has been latently broken since mid-May 2025, and nothing detected it because nothing
rebuilt from a clean resolution.

## Why the error is hard to read

The output never says "no compatible wheel". It says *"Getting requirements to build wheel
did not run successfully"*, and the actual cause — a missing C library — appears eleven
lines into a nested subprocess trace. A resolver **silently** substitutes an sdist whenever
a wheel is missing; there is no warning at the point the decision is made.

## The fix, and the check that comes with it

`av==14.2.0` — newest release still shipping cp310 wheels, and `faster-whisper` 1.1.0 is
satisfied by it.

A pin alone would not stop this recurring: the same failure returns whenever any upstream
project drops an interpreter. So `benchmarking/audit_wheels.py` asks PyPI, for every pinned
version, whether a wheel exists that a cp310 manylinux x86_64 environment can install:

```
$ python benchmarking/audit_wheels.py requirements.lock
auditing 221 pinned packages
== sdist-only (12) ==
   antlr4-python3-runtime, chumpy, distance, encodec, ffmpeg, filterpy,
   fvcore, iopath, jaconv, jieba, openai-whisper, python-speech-features
ok: 209/221 have an installable cp310 linux wheel
```

All twelve remaining sdists are pure Python and need no compiler. `av` was the only
C-extension sdist in the tree.

The audit must understand **stable-ABI wheels** or it is useless here: `opencv-python`,
`psutil`, `tokenizers`, `safetensors` and `hf-xet` all ship `cp3X-abi3` wheels, which
install on any later interpreter. A naive tag match reports all five as wheel-less.

## What this does and does not explain

It fully explains the **build** failure. It does not by itself explain the three earlier
**start** failures (`1059d3dd`, `c32b7655`, `daf0609b`), which built successfully and then
failed their health check with no logs. Those remain consistent with the numpy ABI mismatch
described above, but that is still inference rather than a traceback. Confirmation needs
`setup()` run inside a built image.

Note the pattern, though: **both failures are the same defect wearing different clothes.**
An unpinned requirement resolved to something the image cannot use. One surfaced at build
time and printed an error; the other surfaced at import time and printed nothing.

---

# What the resolution decomposition points at: paste-back is compositing whole frames it does not need to touch

Following the finding above that `paste_back_video` is the only resolution-dependent stage
(R² 0.993, and a model fitted on 462–1026 px clips predicts the 1080 p cost to 2.7 %), the
next question is *why*, which the code answers directly.

`hummingbird/cropper_utils/crop.py:456`:

```python
def paste_back(img_crop, M_c2o, img_ori, mask):
    dsize = (img_ori.shape[1], img_ori.shape[0])
    result   = _transform_img(img_crop, M_c2o, dsize=dsize)   # full-frame warp
    mask_ori = _transform_img(mask,     M_c2o, dsize=dsize)   # full-frame warp, again
    mask_ori = mask_ori.astype("float32") / 255.              # full-frame float32
    result   = result.astype("uint8")
    result   = np.clip(mask_ori * result + (1 - mask_ori) * img_ori, 0, 255).astype(np.uint8)
    return result
```

Per frame, at 1920×1088, that is two full-frame affine warps plus a float32 composite whose
single expression allocates roughly six full-frame temporaries — about 150 MB of memory
traffic per frame, single-threaded NumPy on CPU. Cost linear in pixel count with a steep
slope is the expected behaviour of exactly this code, which is what the measurement shows.

## The part that is provably unnecessary

Where the warped mask is zero, the composite evaluates to
`0 * result + 1 * img_ori` — that is, it writes `img_ori` back over itself. Restricting the
composite (and the crop warp) to the mask's bounding box and copying the source elsewhere is
therefore **bit-exact by construction**, not an approximation.

Measured indirectly on a 1920×1088 production clip, by differencing the source against the
generated output over 150 frames (threshold set well above the re-encode noise floor of
~2.7 levels):

| threshold on mean abs diff | pixels changed | bounding box |
|---|---|---|
| > 10 | 4.9 % | 46 % of frame |
| > 20 | 0.6 % | 24 % of frame |
| > 30 | 0.2 % | 15 % of frame |

So roughly **half the compositing arithmetic at 1080p is redundant**, and the pixels that
genuinely change are a few percent of the frame. On a stage worth 13.8 % of pipeline time
that is a mid-single-digit percentage of total runtime, available without touching any
numerics.

**Caveat, stated plainly.** This is inferred from output differences, not from the mask
itself — the output is a full-frame re-encode, so every pixel differs slightly and the
region has to be recovered by thresholding. A direct measurement of the warped mask's
support needs the stage instrumented and run, which the GPU session can do in one clip.
Treat 46 % as an indicative bound, not a specification.

Two further changes suggest themselves from the same code and cost nothing in output:
compositing in fixed-point `uint16` rather than `float32` halves the bytes moved, and the
mask warp does not need to be full-frame either.

## Why this one is worth the article's attention

Every item on the optimization roadmap trades precision or scheduling for speed, and each
therefore needs a quality gate. This one does not: outside the mask, the operation is
identity, so a correct implementation is bit-identical to the current output. It was found
by asking why a single stage's cost tracked resolution — a question that only exists once
per-stage timings exist.

---

# An inconsistency worth stating rather than glossing

The `av` finding explains why **this** build fails. It does not explain why the three
earlier builds *succeeded*.

`daf0609b` (2026-09-08) was plain `origin/main` with only the unused `basicsr` line
commented out. It built successfully, was promoted, and then failed to start. But plain
`main` uses the same unpinned `requirements.txt`, which a fresh resolution today takes to
`av==14.4.0` — the version with no Python 3.10 wheel. If its `pip install` step had resolved
freshly, it should have failed at build time, exactly as the locked build just did.

So either that build did not resolve freshly, or it resolved differently.

The plausible mechanism is caching. `test.yml` runs on a **self-hosted** runner
(`runs-on: [T4-GPU-Runner]`) with persistent Docker state, and the requirements step is
`RUN --mount=type=cache,target=/root/.cache/pip pip install -r /tmp/requirements.txt`. Both
a Docker layer cache keyed on the file's contents and a persistent pip cache directory could
let an older resolution survive. Editing `requirements.txt` changes the layer key, which is
consistent with the very first attempt on 2026-08-26 failing outright at build time on
`basicsr` while later ones did not.

**This is a hypothesis, not a result.** Confirming it means inspecting the runner's Docker
and pip cache state, which has not been done. It is recorded because it bears on how much
the two failures are really the same defect, and because a build that only succeeds while a
cache is warm is its own serious problem — it means the last green build was not evidence
that the environment was sound.

The safe conclusion, which does not depend on resolving this: **the repository has no
reproducible environment**, and both observed failure modes — a build-time compiler error
and a silent start-time failure — are consequences of that. The lock addresses the cause. It
does not retroactively explain every symptom, and this note exists so nobody later reads a
tidier story into the record than the evidence supports.

---

# HDTF quality, paired against ground truth — and a correction

**2026-09-09, n=9 self-driven clips.** Each generated output scored against *its own* source
clip, rather than against a single reference.

| | LSE-D ↓ | LSE-C ↑ |
|---|---|---|
| generated | 7.577 | 7.618 |
| ground truth (each clip's real footage) | 6.637 | 9.159 |
| paired mean gap | **+0.940** | −1.541 |
| *regeneration noise floor* | *0.256* | *0.288* |

Per clip, which matters more than the mean:

| clip | gen LSE-D | GT LSE-D | Δ |
|---|---|---|---|
| hdtf04_RD_Radio4 | 6.652 | 6.563 | +0.089 |
| hdtf09_WRA_JoniErnst0 | 6.764 | 6.662 | +0.102 |
| **hdtf02_RD_Radio32** | 6.756 | 6.886 | **−0.129** |
| hdtf06_WDA_JoeCrowley1 | 7.209 | 7.018 | +0.191 |
| hdtf01_RD_Radio11 | 7.936 | 6.825 | +1.111 |
| hdtf05_WDA_HenryWaxman | 7.467 | 6.122 | +1.345 |
| hdtf08_WDA_XavierBecerra | 8.248 | 6.683 | +1.565 |
| hdtf03_RD_Radio42 | 8.171 | 6.304 | +1.867 |
| hdtf07_WDA_JoeNeguse | 8.992 | 6.674 | +2.319 |

Ground truth wins on 8 of 9. But **four clips fall inside the 0.256 noise floor**, so on
those the metric cannot separate generated output from real footage. One of the four
(`hdtf02`) has the generated output nominally *ahead* by 0.129 — which is a tie, not a win,
and should be reported as such. The remaining four show a clear 1.1–2.3 gap.

So the distribution is bimodal rather than a uniform deficit: roughly half the clips are
indistinguishable from real footage by this measure and half are clearly behind.

## Correction to an earlier claim in this file's HDTF section

An earlier note observed that generated HDTF output (7.94 on the single probe clip, 7.577
across nine) scores lower than the internal-clip baseline mean of 8.265, and read that as
the system performing better on data it was not tuned for. **That reading is wrong and
should not be used.**

HDTF's own ground truth scores **6.637**. The dataset is simply easier for SyncNet: clips
are face-cropped, frontal, and cleanly recorded, against internal footage at 1080p with
more varied framing. Absolute LSE-D is not comparable across datasets — the earlier note in
this file already says the same about internal versus the platform's own metrics numbers, and the same
caution applies here.

The comparable quantity is the **gap to real footage within one dataset**, which is
available for HDTF (+0.940) and not for the internal clips, whose ground truth has never
been scored. Scoring it would make the two directly comparable and costs four CPU-hours.

---

# The two datasets, now directly comparable — and the withdrawn claim resolved

**2026-09-09.** The internal clips' ground truth had never been scored, which is why
absolute LSE-D looked like it said something across datasets. It is scored now (four
CPU-hours), so the comparable quantity — the **gap to real footage within a dataset** — is
available for both.

| dataset | generated LSE-D | its ground truth | paired gap | n |
|---|---|---|---|---|
| internal, 1920×1080 | 8.265 | 7.415 | **+0.750** | 3 paired |
| HDTF, 462–1026 px | 7.577 | 6.637 | **+0.940** | 9 paired |

Both datasets shift by roughly the same amount when you move from real footage to generated
output. The absolute numbers differ by ~0.7–0.8 LSE-D between datasets **for ground truth
as well as for generated output**, which is the whole explanation for the apparent
difference: HDTF is easier for SyncNet, for both real and synthetic video alike.

## What this settles

The earlier claim — that generated HDTF output (7.577) beating the internal baseline (8.265)
showed the system performing better on unfamiliar data — is now not merely unsupported but
**contradicted by a direct measurement**. Ranked by the only quantity that transfers between
datasets, HDTF is marginally *worse*: a +0.940 gap against +0.750 internally.

Neither difference is large relative to the noise floor (0.256) and the sample sizes are
3 and 9, so the honest statement is: **the gap to real footage is comparable on both
datasets, around 0.75–0.94 LSE-D, and no dataset-level advantage is demonstrated in either
direction.** That is a duller sentence than the one it replaces, and it is the one the
evidence supports.

## A methodological note worth keeping

This is the second time in this workstream that an absolute metric value invited a
cross-context comparison it could not support — the first being internal LSE versus
the platform's own metrics numbers. The pattern is the same each time: a metric with a dataset-dependent
offset gets read as if it were absolute. The fix each time was to measure the reference
inside the same context and compare gaps rather than levels.

Cheap and worth doing: score ground truth for **every** benchmark set at the same time as
the generated output. It is CPU-only, it runs unattended, and without it the generated
number cannot be interpreted at all.

---

# The resolution decomposition, on the full set — weaker than first reported

**Corrected 2026-09-09** after an audit found the headline was an n=1 result quoted as a
property of the twelve-clip set. Recomputed across **all 12** clips, per-frame cost as a
ratio to the internal 1080p baseline:

| stage | mean ratio | min | max | clips inside ±13 % |
|---|---|---|---|---|
| `paste_back_video` | **0.35** | 0.24 | 0.59 | **0 / 12** |
| crop_face | 0.92 | 0.85 | 0.97 | 11 / 12 |
| run_animator | 0.90 | 0.62 | 0.99 | 10 / 12 |
| render_rgb | 1.00 | 0.96 | 1.06 | 12 / 12 |
| detect_landmarks | 1.02 | 0.88 | 1.16 | 11 / 12 |
| reshape_liveportrait | 1.02 | 0.99 | 1.07 | 12 / 12 |
| create_driving_geo_and_mask | 1.04 | 1.03 | 1.07 | 12 / 12 |
| parse_face | 1.05 | 1.01 | 1.08 | 12 / 12 |
| **track_face** | **1.13** | 1.12 | 1.14 | 9 / 12 |
| predict_liveportait | 1.06 *(1.22 with the contended run)* | 0.92 | 1.18 | 10 / 11 |

## What is actually supportable

**Supportable.** `paste_back_video` is the only resolution-dependent stage. Its fit against
pixel count is R² 0.992 and **no clip** comes within 13 % of the baseline per-frame cost.
Every other stage's mean per-frame cost is between 0.90 and 1.13 of baseline, across a 4.9×
change in pixel count.

**Not supportable, and previously written as if it were:**

- *"Nine of ten stages land within 13 %"* — true of **mean** per-frame cost, not of
  individual clips. `track_face` is inside the band on only 9 of 12, and it is not noise:
  it sits at 1.12–1.14 on **every** clip, a systematic +13 % offset. Something differs
  between the datasets for that stage beyond resolution and frame count.
- *"Costs that ought to be resolution-independent are, to within a tenth"* — false on the
  set. `run_animator` drops to 0.62 on two clips and `track_face` is systematically high.
- The 13 % threshold itself was chosen **after** seeing the data: it is exactly
  `track_face`'s value on the single probe clip. A post-hoc boundary is not a test.

## A contended sample was inside the reported means

`hdtf06_WDA_JoeCrowley1_000` recorded `predict_liveportait` at **126.09 s** against a
45.4 s median — 2.8× — because the 16 predictions were submitted in two concurrent batches
of eight and shared GPU capacity. Its wall time was 445.05 s against 339–372 s for the rest.

| quantity | all 12 | excluding the contended run (n=11) |
|---|---|---|
| pipeline total | 350.99 s | **344.13 s** |
| wall total | 362.94 s | **355.48 s** |
| `predict_liveportait` | 51.55 s | **44.78 s** (−13 %) |

`analyze_resolution.py` flags it, but no writer-facing document said so, and it was inside
the published means and Figure 9. **n=11 is the number to report**, with the exclusion
stated. That the concurrency existed at all should have been disclosed from the start:
running eight predictions at once is not the same measurement as running them serially.

## The out-of-sample check has a 67 % miss that was not disclosed

The prediction table reports a median absolute error of 8.8 % across ten stages, and
`paste_back_video` — the stage the model is actually about — lands at **+3.7 %**. But
`predict_liveportait` misses by **+67 %**, because the contended sample inflates its fitted
slope. The script prints the flag. The documents quoted the median and the framing
*"validates the instrument"* without the miss. Both figures belong together or neither does.

Two further limits on that check, from the audit:

1. **The extrapolation rests on one clip.** Eleven of twelve clips are ≤0.69 MPix and one is
   1.05. Dropping that one clip moves the `paste_back_video` prediction error from
   **+3.7 % to +6.6 %** and R² from 0.992 to 0.9865. There is no confidence interval.
2. **For a flat stage the "prediction" is just the intercept**, so nine of the ten
   "successes" restate the flatness verdict rather than corroborating the instrument
   independently. The only genuinely predictive result is paste-back's.

Also unmodelled: HDTF clips are square face-crops where the pasted region fills most of the
frame, while the internal clips are 16:9 with a comparatively small face. That is precisely
the variable the paste-back analysis argues drives the cost, so it is a confound in the
cross-dataset extrapolation, not a nuisance term.

## Corrected per-clip quality counts

The earlier breakdown said *"4 within the noise floor, 1 better, 4 clear"* — which is nine
only by counting one clip twice. The nine paired LSE-D deltas are:

```
-0.129  0.089  0.102  0.191  |  1.111  1.345  1.565  1.867  2.319
```

**Four** inside the ±0.256 floor (one of those four is the clip nominally ahead by 0.129)
and **five** with a clear 1.1–2.3 gap.

## The noise floor is n=1 and comes from a different dataset

The ±0.256 LSE-D / ±0.288 LSE-C floor is **a single pair** of regenerations of **one
internal 1920×1080 clip**. It is used above as a discrimination threshold on HDTF clips of
462–1026 px. It is also a single |Δ|, not a standard deviation — the expected |Δ| of two
draws is about 1.13σ, so a 95 % band would be roughly two to three times wider.

That matters most for the strongest claim made from it: *"LSE-C separates generated from
real on all 9 clips."* The smallest LSE-C margin is **0.368**, only 1.28× a
single-sample point estimate. **That claim should not be printed until an HDTF regeneration
pair is measured.** One clip, run twice, is about twelve minutes of GPU time.

---

# The largest available optimization is a cache, and it is measurable from the existing profile

**2026-09-09.** Prompted by a product observation: the common request is not "generate a new
video" but "take the video I already have and change two words" — a name and a company name.

## The mechanism is in the execution order

`hummingbird/inference.py:run()` calls the stages in a fixed sequence, and **four of them
run before `run_animator`**, which is the first stage that touches audio. Verified in the
source: `crop_face()`, `detect_landmarks()`, `parse_face()` and `track_face()` take **no
arguments at all** — they read paths derived from the source video. They are pure functions
of the length-adjusted source video.

| stage | seconds | share |
|---|---|---|
| `crop_face` | 30.67 | 5.8 % |
| `detect_landmarks` | 7.76 | 1.5 % |
| `parse_face` | 39.66 | 7.5 % |
| `track_face` | 146.61 | 27.7 % |
| **cacheable total** | **224.70** | **42.5 %** |
| audio-dependent remainder | 304.06 | 57.5 % |

So for **any** job reusing a source video, 42.5 % of the pipeline recomputes
byte-identical results.

## What it is worth

At $1.99/GPU-hour: **$124 per 1000 repeat videos**, against roughly $107 for the entire
code-optimization roadmap combined. And unlike every roadmap item, it is **bit-exact by
construction** — it returns stored bytes.

Combined with the segmentation word replacement already does
(`split_video_segments_for_word_replacement`), only changed segments need the
audio-dependent stages:

| fraction of the video that changes | pipeline cheaper | **bill cheaper** | $/1000 |
|---|---|---|---|
| 5 % | 97.1 % | **63.6 %** | $163 |
| 10 % | 94.2 % | 61.7 % | $171 |
| 25 % | 85.6 % | 56.0 % | $196 |
| 50 % | 71.2 % | 47.4 % | $235 |
| *(full run today)* | *—* | *—* | *$446* |

**Quote the bill column, not the pipeline column.** The gap between them is cold start: 279 s,
billed on a scale-to-zero deployment, and untouched by caching. The pipeline can drop 97 %
while the invoice drops 64 %, and only the second number survives being checked against an
invoice.

**And the two optimizations compound in an order that matters.** After caching, at 5 %
changed, the pipeline is 15 s against a 279 s cold start — so **cold start becomes 95 % of
the job's cost**. Caching alone takes the bill down ~64 %; the code roadmap alone caps out
at 65 % of the bill however fast the pipeline gets, because the other 35 % is boot time.
Which optimization matters most depends on which one you do first, which is not something
you could predict from reading the code.

## The prerequisite: the cache is unsound without a seeded sampler

The audio-to-expression model draws fresh noise per 60-frame chunk
(`expressive_avatars/models/flow_matching_talking_head.py:724`, reached with
`motion_at_T=None`). Splice a cached segment against a freshly generated one and the two
expression trajectories will not agree across the join — producing a seam at exactly the
word the customer changed, which is the frame they are looking at.

**So determinism is a hard dependency of the cache, not a benchmarking nicety.** The
seeding work in `shared_utils/repro.py` was built to make an A/B possible; it turns out to
gate the single largest optimization in the system. Worth recording, because it is the
opposite of how measurement infrastructure is usually justified.

Note also that the cache key cannot be the source video alone. `adjust_video_length_to_audio`
runs *before* `run()` and pads or trims the video to the audio's duration, so the adjusted
video — and therefore every downstream stage — depends on audio *length*. A per-frame cache
keyed on (source video content hash, frame index) survives a length change; a per-file cache
does not.

## What is measured and what is not

**Measured:** the 42.5 % cacheable fraction, from the production stage profile (n=5) and the
code's execution order.

**Not measured:** every word-replacement percentage above. They follow arithmetically from
the cacheable fraction plus segment length, and the word-replacement path has a *different*
stage distribution from plain lipsync — the harvested cohort shows `crop_face` dominating at
41.9 % rather than `track_face` — so those figures need their own runs before being quoted
as results. Cold start is also unaffected by caching and still applies per job, which caps
the achievable saving in practice.

## Three effects that will shrink the caching numbers in practice

1. **The word-replacement path has a different profile.** The 42.5 % cacheable fraction is
   measured on plain lipsync, where `track_face` dominates at 27.7 %. The harvested
   word-replacement cohort shows `crop_face` dominating at 41.9 % instead. The cacheable
   fraction there needs its own measurement.
2. **Segments are wider than the words.** `split_video_segments_for_word_replacement` takes
   a `soft_time_padding`, and two words in different places produce two padded segments, not
   one. "5 % of the video changed" therefore understates the audio-dependent work, and
   stitching has its own cost.
3. **Cache hit rate is a business fact, not an engineering one.** The saving materialises
   only for customers who reuse source videos. That rate is unknown here and should come
   from the request data before any aggregate saving is claimed.

---

# Code audit of the two largest stages: seven bit-exact wins, and two corrections to this file

**2026-09-09.** A read-only audit targeted at where the time actually is. All sub-stage
timings below are measured from loguru timestamps already present inside `track_face` in
the production logs (`benchmarking/logs/hdtf_prod/`, 751-frame clip, `track_face` 112.64 s)
— a breakdown that existed in the logs all along and had never been extracted.

## `track_face` is not one thing

| sub-step | file | s | % of `track_face` | % of pipeline |
|---|---|---|---|---|
| `calibrate_camera_gd` | `face_tracker.py:807` | **34.52** | 30.6 % | **8.5 %** |
| `face_recon` loop | `facetrack/predict.py:120` | 21.24 | 18.9 % | 5.2 % |
| `visualize_tracking` | `face_tracker.py:872` | 18.49 | 16.4 % | 4.6 % |
| `optimize_wflw_lms_only` | `face_tracker.py:368` | 17.57 | 15.6 % | 4.3 % |
| `optimize_lms_only` | `face_tracker.py:295` | 16.81 | 14.9 % | 4.1 % |
| `preload_batched_data` | `face_tracker.py:735` | ~2.5 | 2.4 % | 0.7 % |

## The findings that matter most

**1. The focal-length search runs 14,800 Adam iterations, sequentially.**
`face_tracker.py:807-824` sweeps `range(400, 3000, 100)` — 26 coarse candidates, then 20
fine — each a *fresh* 300-iteration solve, plus a final 1000. The tensors are 92 KB, so it
is entirely kernel-launch bound at 2.33 ms per iteration. `proj_pts` already broadcasts a
batched `cam_para`, so the candidates can share one batch axis: **14,800 iterations become
1,600.** Prototyped on CPU: per-candidate losses **bit-identical** (0.00e+00 across
candidates), same argmin, 21.9× faster. Risk is unusually contained — the only value that
escapes the function is the selected integer focal, so if the logged focal is unchanged,
everything downstream is bit-exact. **~30 s, 8.5 % of pipeline.**

**2. The renderer seeks backwards every single frame, into a 250-frame GOP.**
`renderer/dataset.py:317-326` requests `face_indices = [c-2 … c+2]`; the reader finishes at
`c+2`, and the next item asks for `c-1`. `abstraction.py:111` has exactly one fast path,
`frame_index == current_index + 1`, so **it misses on every frame**. `get_video_writer`
passes no `-g`, leaving keyint at 250 (confirmed: 4 keyframes in 751 frames), so each miss
discards ~141 decodes. Roughly 2,200 such seeks per job, and each frame is decoded five
times. A 5-frame FIFO cache is **bit-exact** and about 30 lines. This is also the
explanation for why `render_rgb` costs 118 ms/frame for a 512² network at batch 4.

**3. `parse_face` ships a 19.9 MB logit tensor to the host per frame.**
`parsing/predict.py:150` does `out_batch[j].cpu().numpy().argmax(0)` on a
`(19,512,512)` fp32 tensor *inside* the per-item loop: ~22 GB over PCIe and 32
synchronisations per batch. `argmax(1)` on the GPU is 8.4 MB per batch and one sync.
**3–4 % of pipeline, trivial change, bit-exact** apart from exact-tie ordering.

**4. `face_recon` renders a 512² mesh per frame and the caller discards it.**
`face_recon/recon.py:159-167` builds `vis_dict{rendered_geo, pred_lms}`; the caller at
`facetrack/predict.py:128` ignores the return, and `get_pred_params` reads only the five
lists appended earlier. Nothing after line 158 is ever read. **Bit-exact by construction.**

**5. Two optimizer loops do 1,000 redundant FLAME solves, and one tensor is entirely dead.**
`set_tensors_grad` covers only eulers and translations, so `opted_exps`/`opted_jaws` keep
`requires_grad=False` — **their Adam steps are verified no-ops**. Every input to
`forward_geo` is therefore constant across the loop. Separately every element of
`geometry_neutral` is overwritten by constants on the next three lines, making its solve
pure waste. **Bit-exact.**

**6. `preload_batched_data` is dead code — and it is the only consumer of `parsing.mp4`.**
Its outputs are read solely by `load_data_batch`, called only from `optimize_litex` and
`optimize_exps_rts`, **both of which have zero callers in the repo**. So 1,502 `torch.save`
calls (~1.6 GB), 751 CPU warps and a full parse-video decode are computed and discarded.
Which means a slice of `parse_face` — a measured, reported stage — produces a file that
never influences the output.

**7. The 20 % of wall clock that is not in the stage table at all.**
`shared_utils/utils.py:227-228` runs `convert_to_25fps` at `preset slow -crf 18`, and its
consumer `trim_video` immediately re-encodes at medium/CRF 23, discarding the quality. In
the 1080p logs this is **106.6 s of 532.4 s wall clock, 20 %**, inside
`download_and_preprocess` and therefore outside every per-stage table in this package. Note
it is *not* output-neutral: its product is the pipeline's input video.

**8. Paste-back's writer silently rescales the deliverable.** `cropper_utils/video.py:133-137`
passes neither `quality` nor `ffmpeg_params`, so x264 gets no `-crf` and defaults to
23/medium — worse than the 512² throwaways. `macro_block_size` is unset, defaulting to 16,
and the 1080p logs confirm `resizing from (1920, 1080) to (1920, 1088)` immediately after
paste-back begins. The customer-facing frame is padded and re-encoded at default quality.

## Two corrections to earlier claims in this file

**"The resolution-flatness validates the timing instrument" — withdrawn.**
This file argued that nine of ten stages being resolution-independent was a hard test the
methodology passed. The real explanation is structural: **every intermediate — crops, masks,
geometry, the render itself — is written at 512² regardless of input resolution.** The flat
stages are flat *by construction*, because their tensors are fixed-size; only
`paste_back_video` touches full-resolution pixels. The R² 0.992 result stands, but it
measures the pipeline's design, not the instrument's fidelity. The out-of-sample prediction
of the 1080p paste-back cost remains a genuine check; the nine "flat" predictions were
restating flatness, as already noted.

**"The generative model is 1.3 % of runtime" — misleading as written.**
`run_animator` is 1.3 %, and that is the audio-to-motion model. But `render_rgb` (24.5 %)
and `predict_liveportait` (11.7 %) are *also* neural generators. **Image generation is
about 36 % of runtime.** The 1.3 % figure is true of one model and understates neural cost
by roughly 28 points. It is a striking line and it is being read the wrong way; state it as
"the audio-to-expression model is 1.3 %".

Also worth correcting: `calibrate_camera_gd` runs a **fixed** 14,800 iterations regardless
of frame count, so its per-frame cost *falls* with clip length. Any per-frame extrapolation
of `track_face` will mis-predict on short clips.

---

# About 17 % of GPU-machine time does no GPU work

**2026-09-09.** Classifying job-level stages by whether they need a GPU at all, from the
same production logs:

| workload | job total | GPU work | **CPU-only work** |
|---|---|---|---|
| lipsync (driven, n=5) | 642.5 s | 528.8 s (82.3 %) | **113.7 s (17.7 %)** |
| word replacement (harvested, n=6) | 186.2 s | 155.3 s (83.4 %) | **30.9 s (16.6 %)** |
| HDTF (n=12) | 362.9 s | 351.0 s (96.7 %) | 11.9 s (3.3 %) |

What that CPU-only time is:

| stage | lipsync | word replacement | what it does |
|---|---|---|---|
| `download_and_preprocess` | 95.08 s | — | network fetch + ffmpeg transcode |
| `modify_video_length` | — | 19.61 s | ffmpeg |
| `adjust_video_length_to_audio` | 15.60 s | — | ffmpeg pad/trim |
| `stitch_segments` | — | 5.62 s | ffmpeg concat |
| `split_segments` | — | 5.40 s | ffmpeg cut |
| `upload_to_s3` | 2.53 s | 0.16 s | network |
| `attach_audio` | 0.51 s | 0.10 s | ffmpeg mux |

None of it touches the GPU. All of it is billed at the GPU machine's rate: **$63 per 1000
lipsync videos** of pure ffmpeg and network transfer, on hardware rented for its tensor
cores.

## Why the HDTF figure is so much lower, and why that matters

3.3 % rather than 17.7 %, for one reason: the HDTF inputs are 30 s clips of a few MB,
already at 25 fps, so `download_and_preprocess` costs 6.95 s instead of 95.08 s. The
production figure is dominated by fetching and transcoding large customer source video.
So **the CPU share rises with source-video size and duration** — it is worst exactly where
the bill is biggest.

## This compounds with a wasted-work finding

The audit above found that `convert_to_25fps` (`shared_utils/utils.py:227-228`), inside
`download_and_preprocess`, runs at `preset slow -crf 18` and its consumer `trim_video`
immediately re-encodes at medium/CRF 23. So the largest CPU-only item is *also* spending
most of its effort on quality that is then discarded. Two independent fixes apply to the
same 95 s: move it off the GPU node, and stop over-encoding a transient.

## The architectural shape this suggests

Split the job: a CPU worker pool does fetch, transcode, cut, stitch, mux and upload; the GPU
pool does only the model pipeline. The pieces already have clean boundaries — they are
separate `@time_it` stages communicating through files — so this is orchestration, not a
rewrite.

Two caveats that must be stated with it:

1. **Splitting adds a data-transfer hop.** Today the intermediate files are local to one
   machine. Across a CPU/GPU boundary they cross a network, and the source video is the
   largest artefact in the job. Whether the 17 % saved exceeds the transfer added depends on
   the interconnect, and this has not been measured.
2. **The saving is a rate difference, not a time saving.** Total work is unchanged; it moves
   to cheaper hardware. The gain is (GPU rate − CPU rate) × 17 % of job time, so it is worth
   most where the GPU/CPU price ratio is largest — which is exactly the case on owned
   accelerators.

Not yet measured; recorded as a costed roadmap item.

---

# Deployment economics: the cheapest fix is a config line, not a migration

**2026-09-09.** Quantified from the measured logs plus published pricing.

## Corrections to this file's own cost numbers

| claim | corrected | why |
|---|---|---|
| cold start mean 279 s | **285.41 s** | 279 was the midpoint of the 250–310 range, labelled as a mean |
| cold start is 35 % of billed time | **30.6 %** | 285.41/931.31; the 35 % used an understated denominator |
| billed total 807.8 s | **931.31 s** | `total_time`, which is what the platform meters |
| $446 per 1000 | **$515** at $1.99/hr, **$1,304** at the published rate for this card class | see below |

**There is 117.13 s of billed in-container time the stage instrumentation does not
attribute** (`predict_time` 645.90 s minus the 528.77 s of stages): downloads,
`adjust_video_length_to_audio`, uploads, `attach_audio`. Every cost model in this package
was built on the stage sum and therefore **understated the GPU seconds actually bought by
22 %**. Corrected in `cost_model.py`.

**The rate is also unverified.** The GPU SKU for the measured runs is recorded nowhere —
`cog.yaml` says only `gpu: True` and no log line names the device. At the published rate for
an A100 80GB on this class of service ($0.0014/s = $5.04/hr) the same runs cost **$1,304 per
1000**, not $446. That is a factor of 2.9, and closing it needs one line of the actual
invoice.

## The finding that beats a Kubernetes migration

the deployment configuration sets **`cooldown = 30`** — the pod is torn down 30 s after going idle —
against a measured **285 s** boot. The keep-warm window is **9.5× shorter than the penalty
it exists to avoid.**

For Poisson arrivals the share of jobs that pay a cold start is `exp(−λ·T_cool)`:

| jobs/hr | 30 s cooldown | 120 s | 600 s | 3600 s |
|---|---|---|---|---|
| 2 | **98.3 %** | 93.6 % | 71.7 % | 51.3 % |
| 5 | 95.9 % | 84.6 % | 43.5 % | 18.9 % |
| 20 | 84.6 % | 51.3 % | 3.6 % | 0.1 % |
| 100 | 43.5 % | 3.6 % | 0.0 % | 0.0 % |

To get cold start down to 10 % of jobs you need 276 jobs/hr at a 30 s cooldown, or **27.6/hr
at 600 s**. So the cheapest available intervention is **raising the cooldown** — a
configuration line, no engineering, no migration — and it buys idle GPU-seconds in exchange
for eliminating a 285 s penalty.

The logs already contain the experiment: **five of six word-replacement runs paid a cold
start; the sixth measured `cold = 0.01 s` and completed in 184.50 s against 320–465 s for
its cold siblings.** That is the only direct measurement of a warm pod in the repo, and it
is a 2× difference.

## Self-managed hardware: the break-even is much higher than expected

All-in cost derived at **$0.63–1.20/GPU-hr** (centre ~$0.89) for A100 40GB PCIe, 8-GPU node,
3-year straight line, including power at published EIA industrial rates, PUE 1.47–1.56 and
colo at published CBRE asking rates.

But **ops labour dominates below 64 GPUs.** One fully-loaded SRE at $250k/yr is a fixed
$20,833/month:

| GPUs | effective $/GPU-hr | break-even volume vs $1.99/hr | as % of capacity |
|---|---|---|---|
| 8 | **$4.46** | 50,598/mo | **155 % — impossible** |
| 16 | $2.68 | 60,729/mo | 93 % |
| 32 | $1.79 | 80,989/mo | 62 % |
| 64 | $1.34 | 121,510/mo | 47 % |

**An 8-GPU cluster with a dedicated SRE can never break even against a $1.99/hr per-second
service** — the volume required exceeds the cluster's physical capacity. Against the
published $5.04/hr rate it wins above ~20,000 lipsync videos/month. Any comparison omitting
labour recommends a migration that loses money.

## The latency trade-off, which must not be hidden

Service time is nearly deterministic (measured CV **0.032**), so M/D/c applies. One warm
A100 at 100 % duty delivers only **5.57 lipsync videos/hour**.

| pods | utilization | p95 response |
|---|---|---|
| 1 | 50 % | 36 min |
| 1 | 90 % | **2.8 h** for an 11-minute job |
| 16 | 70 % | 12 min |
| 16 | 90 % | 19 min |

**Pooling is worth more than utilization.** 16 pods at 90 % has a *better* p95 than 1 pod at
50 %, and costs 44 % less per video. A one- or two-GPU warm pool cannot be run hot without
destroying latency.

## Packing: my own VRAM measurement lands in the worst range

Measured this session on the A100 40GB: **peak 18,293 MiB of 40,960 — 17.9 GiB, 44.7 % of the card** (batch 16 arm).

At 16–24 GB per job, the 40 GB card packs **exactly one** job under the `0.7`
memory-fraction cap. The packing lever collapses to "buy 80 GB cards", where 17.9 GiB allows
three or four.

Three further constraints found in the process:

1. The cap is **per-process, not a partition** — three processes at 0.7 may collectively
   request 210 % of the card. To pack N jobs the fraction must be set to ≤ 1/N, which
   `GPU_MEMORY_FRACTION` now permits.
2. It only bounds **PyTorch's** allocator. ONNX Runtime on CUDA and nvdiffrast allocate
   outside it, so real device peak exceeds the tracked fraction by an unmeasured amount.
3. **A100 has no NVENC and only 5 NVDEC units.** This pipeline performs 18 video writes per
   job through `libx264` on the CPU, so packing k jobs multiplies CPU encode demand by k
   against 11 provisioned vCPU. Density may be limited by cores before VRAM, and nothing
   measures which.

`inference_turbo.py:62` still hardcodes 0.7 with no override — an inconsistency between the
two entry points.

---

# First A/B result: raising the renderer batch size 4 → 16 does nothing

**MEASURED 2026-09-09**, dedicated A100 40GB, same three HDTF clips, same warm process,
`LIPSYNC_SEED=0`, sequential, paired per clip.

| clip | arm0 (batch 4) | arm1 (batch 16) | Δ | Δ % |
|---|---|---|---|---|
| hdtf01 | 388.74 s | 390.34 s | +1.60 | +0.41 % |
| hdtf02 | 393.43 s | 393.87 s | +0.44 | +0.11 % |
| hdtf03 | 385.46 s | 387.17 s | +1.71 | +0.44 % |
| **mean** | **389.21 s** | **390.46 s** | **+1.25** | **+0.32 %** |

**Verdict: rejected.** The gate requires ≥ 3 % faster. This is 0.32 % *slower*, and all three
clips moved the same way, so the sign is consistent even though the magnitude is inside the
noise. The paired spread is 0.33 pp, so the measurement is easily precise enough to have
detected a 15 % win. There is no win to detect.

## Why, and it was predictable from the code audit

This was item 2 of the team's five-item roadmap — *"increase batch size to use near 100 %
GPU (process 32 frames at once for example)"* — and the reasoning behind it was that the GPU
is under-fed at batch 4. The measurement says the renderer is not GPU-bound at all.

The audit of `render_rgb` explains it. `renderer/dataset.py:317-326` requests
`face_indices = [c-2 … c+2]`; the reader finishes at `c+2` and the next item asks for `c-1`,
so `abstraction.py:111`'s single sequential fast path **misses on every frame**, and each
miss discards ~141 decodes inside a 250-frame GOP. Every frame is decoded five times. The
stage costs 118 ms/frame for a 512² network at batch 4 because it is **video-decode bound,
not compute bound.** Feeding the GPU four times as much data per step cannot help when the
GPU is already waiting on `cv2.VideoCapture`.

So the batch-size item was aimed at the wrong bottleneck, and the profile that would have
revealed that did not exist when the roadmap was written. That is the article's thesis
arriving as a measured result rather than an assertion.

## Consequences

1. **`RENDER_BATCH_SIZE` stays at 4.** No reason to raise it, and batch 16 costs 17.9 GiB of
   VRAM against batch 4's smaller footprint — which is what puts the 40 GB card into the
   "packs exactly one job" range. Batch 4 may allow packing two.
2. **The cost model's $11 per 1000 for this item is now $0.** Corrected.
3. **The renderer frame-cache is promoted.** It attacks the actual bottleneck, is bit-exact,
   and the audit estimates 2–11 % of pipeline. It should be measured before fp16, because if
   the stage is decode-bound then fp16's expected gain is also overstated.
4. **fp16 (arm2) should be read with this in mind.** If the renderer is waiting on decode,
   halving the arithmetic precision will not help either. arm2 is running now and will test
   exactly that.

---

# The cache: hit rate is structurally ZERO as the code stands

**2026-09-09.** Design and key-derivation work on the word-replacement cache found a
precondition that invalidates the saving until it is fixed, plus four corrections to what
this file has been claiming.

## The blocker, and it is not subtle

`video_time_warp_interpolate` (`FrameInterp/timewarp_utils.py:36,63`) chooses which frames to
insert or drop using **`np.random.randint` drawn from the process-global RNG**.
`LIPSYNC_SEED` is applied once per prediction (`predict.py:272`), so the RNG state reaching
segment *k* depends on MaskGCT and on segments 0…k−1.

**Consequence: the same segment with the same time offset produces different frames in
different jobs.** The input to every cached stage is therefore not reproducible, so a
content-addressed cache **can never hit**, whatever customers request. The 61.9 % is real as
an upper bound and currently unreachable.

Fix: seed `np.random` from `(segment digest, offset frames)` immediately before the warp,
making it a pure function, and record that seed in the cache key so entries written under
one scheme cannot be served under another. **This is a precondition, not a refinement.**

## Two tiers, and the cheap one is the right one

Only **6 of 12** artefacts produced by the four source-only stages are read by anything
after `run_animator`. So the cache does not need to store the crop frames at all:

| tier | what it stores | pipeline skipped | size per entry |
|---|---|---|---|
| **1** | `crop.npz`, `no_face_indices`, `mouth_open.npy`, `track_params.pt`, `original_geometry.mp4`, `original_lower_mask.mp4` | `detect_landmarks` + `parse_face` + `track_face` = **48.4 %** | **single-digit MB** |
| 2 | tier 1 + the 512² crop frames | + `crop_face` = 61.9 % | ~330 MB, about 30× |

Tier 1 skips 71.10 s of a 146.78 s pipeline for a few megabytes, and it keeps `crop_face`
running — which matters, because that gives a **witness**: the caller can hash the fresh
crop output and check it against the manifest, so the derived key is *verified* rather than
trusted. Tier 2 removes that check. **Tier 1 is the design; tier 2 needs disk economics
measured first.**

Throughput on warm hardware, baseline 19.3 videos/GPU-hour, linear in hit rate:

| hit rate | tier 1 | tier 2 |
|---|---|---|
| 50 % | 23.9 (+24 %) | 25.6 (+32 %) |
| 90 % | 29.5 (+52 %) | 34.5 (+79 %) |
| 100 % | 31.3 (+62 %) | 37.8 (+96 %) |

**On a scale-to-zero deployment those flatten to +18 % and +24 %**, because boot time then
dominates. The cache is worth far more on warm hardware — the two changes compound, as noted
earlier, and this quantifies it.

## Four corrections to earlier claims in this file

1. **"A per-frame cache keyed on content hash plus frame index survives a length change" —
   WRONG, and it was my proposal.** It cannot work. `crop_source_video` is a *stateful
   sequential tracker* (EMA-smoothed scale α=0.2, a running anomaly detector, landmark
   tracker state, `prev_frame`), and `track_face` is a *whole-clip optimisation*
   (`shape_code` is the mean over all frames, `cam_para` comes from a global focal search).
   **No artefact here is a per-frame function of its own frame.** The correct key is
   whole-segment.
2. **`adjust_video_length_to_audio` does not run on the word-replacement path.** It is called
   only from `run_end2end`. Word replacement uses per-segment `modify_video_length` instead.
   The trap is real but it is a different function in a different place — and it is worse,
   because that one carries the RNG problem above.
3. **The n=6 word-replacement cohort is six replicas of ONE fixture**, not six distinct
   workloads: same 1920×1080 source, same transcript, exactly one changed segment, a 7.92 s
   window, `time_offset` 0.48 s in every run. The run-to-run spread is machine noise. So
   "n=6" overstates the diversity — it is one workload measured six times, and dropping the
   single structural outlier moves 61.9 % → 61.4 %. **Multi-segment requests are untested.**
4. **`split_segments` and `stitch_segments` were transposed** in the CPU/GPU table: split is
   5.40 s and stitch 5.62 s, and split is cheaper in all six runs.

Also found: **`original_geometry_lp.mp4` is produced by `track_face` and read by nothing** —
its only consumer is commented out at `inference.py:257`. And `track_face` writes **420
per-frame `.pt` tensors, about 296 MB**, into a directory named "debug" and re-reads them
unconditionally; those are consumed inside the stage the cache skips, so they never need
storing.

## Good news on determinism

None of the four source-only stages draws RNG: no `np.random` or `torch.rand` on the
crop→landmark→parse→track path, dropout is inert under `eval()`, and the one
`np.random.randint` in `face_tracker.py:212` sits in `optimize_litex`, which
`forward_face_track` never calls. **So skipping those stages does not perturb the noise
stream the animator later consumes** — the source-analysis cache introduces no new stitch
seam. That is a materially better position than a segment-*output* cache, which would.

---

# Second A/B result: fp16 on the renderer is also null — and it costs output fidelity

**MEASURED 2026-09-09**, same conditions: dedicated A100 40GB, same three HDTF clips, same
warm process, `LIPSYNC_SEED=0`, sequential, paired per clip.

| arm | config | mean | paired vs arm0 | per-clip deltas |
|---|---|---|---|---|
| arm0 | batch 4, fp32 | 389.21 s | — | — |
| arm1 | batch 16, fp32 | 390.46 s | **+0.32 %** | +0.41 / +0.11 / +0.44 |
| arm2 | batch 16, **fp16** | 391.16 s | **+0.51 %** | +0.75 / −0.55 / +1.33 |

**arm2 rejected.** No speed gain, and unlike arm1 the per-clip signs are **mixed**, which is
the signature of pure noise rather than a small real effect.

> **Drift correction, added after `arm0b` ran.** A repeat of `arm0` at the end of the
> session came back 1.85 % slower with identical configuration, so the raw figures here are
> inflated by session drift. Corrected: arm1 **−0.14 %**, arm2 **−0.41 %**, arm3 **+0.50 %**
> — all null, all inside ±0.5 %. See "The repeat baseline invalidated my own cuDNN result"
> below. The raw numbers above are kept as recorded; the corrected ones are the result.

## And it is not free

`compare_outputs.py`, arm2 against arm0, clip hdtf01:

| | value |
|---|---|
| bit-identical frames | **0 / 751** |
| PSNR | mean 39.37 dB, min 37.63 |
| SSIM | mean 0.97207, min 0.96309 |
| max abs pixel difference | mean 36.5, worst **62** of 255 |

> **WITHDRAWN.** This paragraph read: *"fp16 is pure downside on this pipeline: zero speed,
> measurable fidelity loss … it moves the output further than re-running the pipeline does."*
> `arm0b` — a repeat of arm0 with the same seed — later measured **39.38 dB**, so fp16's
> 39.37 dB is the noise floor, not a fidelity loss. fp16 is null on speed **and** null on
> fidelity. See "Seeding did NOT make the pipeline deterministic" below.

## Why both items failed, and it is the same reason

This is the second of the team's five roadmap items to measure null, and the mechanism is
identical: **`render_rgb` is video-decode bound, not compute bound.** The renderer's dataset
seeks backwards on every frame into a 250-frame GOP, discarding ~141 decodes per miss and
decoding each frame five times. When a stage is waiting on `cv2.VideoCapture`:

- feeding the GPU four times more data per step (arm1) changes nothing;
- halving the arithmetic precision (arm2) changes nothing either.

Both interventions optimise arithmetic that was never the constraint. The prediction was
recorded *before* arm2 ran, in the arm1 write-up, and it held.

**This is the article's central claim, arriving as measurement rather than assertion:** two
of five roadmap items, proposed on architectural intuition, produce no measurable gain — and
the per-stage profile that would have redirected them did not exist when they were written.

## One caveat pending

arm0 and arm2 differ in *two* variables, batch size and precision. Batch invariance was
measured at max\|Δ\| 1.2e-07 on the real model on CPU, so the 39.37 dB is attributable to
fp16 — but **arm0b, a seeded repeat of arm0, is still running** and is the clean test. If
arm0b comes back bit-identical to arm0, seeding holds and the fidelity loss is fp16's. If it
does not, some of that 39.37 dB is residual nondeterminism and the attribution needs
splitting. Do not quote the fidelity figure as fp16's alone until arm0b lands.

---

# MEASURED: the GPU is idle a third of the time — mean utilization 27 %

**2026-09-09.** `nvidia-smi` sampled every 2 s throughout the arm runs on the dedicated
A100 40GB. **1,191 samples over 39.7 minutes** of real pipeline execution.

| quantity | value |
|---|---|
| mean GPU utilization | **27.0 %** |
| median | **19 %** |
| p90 | 91 % |
| samples at **0 %** utilization | **33.3 %** |
| samples at ≤ 20 % | **50.6 %** |
| samples at ≤ 50 % | 80.4 % |
| peak VRAM | 18,293 MiB of 40,960 = **17.9 GiB, 44.7 %** |
| mean VRAM | 13,735 MiB = 13.4 GiB (33.5 %) |

**The GPU is completely idle for a third of the wall clock, and below 20 % utilized for
half of it.** Observed directly during a run: `utilization.gpu 0 %` with a load average of
10.4 across 30 cores — the machine was busy, the accelerator was not.

## This is the single measurement that explains everything else

It independently confirms, from the hardware side, what the code audit found by reading and
what the A/B arms found by timing:

- **Why batch 16 did nothing** (+0.32 %): you cannot fix under-feeding by sending more per
  step when the GPU is already waiting.
- **Why fp16 did nothing** (+0.51 %): halving arithmetic time cannot help a device that is
  idle a third of the time.
- **Why the renderer costs 118 ms/frame** for a 512² network: it is waiting on
  `cv2.VideoCapture`, which seeks backwards every frame into a 250-frame GOP.
- **Why moving CPU work off the GPU node is worth $63 per 1000** — 17 % of job time needs no
  accelerator at all, and this shows the accelerator sitting through it.

Two of the team's five roadmap items were precision-and-batching changes. Both target the
27 %. Neither touches the 73 %.

## It also resolves a claim that was on the DO-NOT-USE list

That list contained *"20 % GPU utilization — recalled in conversation, measured nowhere"*.
It is now measured: **mean 27.0 %, median 19 %.** The recalled figure was essentially
correct. It moves from "do not use" to a measured result — which is a good illustration for
the article that the discipline was about *evidence*, not about the number being wrong.

## And it changes the packing answer

The earlier note concluded that 17.9 GiB peak VRAM puts a 40 GB card in the "packs exactly
one job" range, because of the 0.7 memory-fraction cap. With utilization at 27 % mean and
44.7 % peak VRAM, **two concurrent jobs on one 40 GB card should be close to free in compute
terms** — the contention would be for CPU cores and video decode, not for the GPU.
`GPU_MEMORY_FRACTION=0.45` makes it admissible. That is now the highest-value untested
lever: it would roughly double throughput per card without touching the model.

The caveat stands from the economics analysis: the A100 has **no NVENC** and only 5 NVDEC
units, and this pipeline performs 18 video writes per job through `libx264` on the CPU. At a
load average of 10.4 for a single job on 30 cores, three concurrent jobs would saturate the
cores. **Two is the number to test.**

---

# The drift control: the baseline moved 1.85 % on its own, and it changes what arm3 means

**MEASURED 2026-09-09.** arm0b repeated the baseline configuration **exactly** — batch 4,
fp32, no autotuning, same seed, same three clips — as the fifth and last pass of the session.

| | mean wall | vs first baseline | per clip |
|---|---|---|---|
| arm0, run first | 389.21 s | reference | — |
| **arm0b, run last, identical config** | **396.40 s** | **+1.85 %** | +1.89, +1.34, +2.33 |

**The machine got 1.85 % slower across the session with no code change at all.** Thermal
behaviour, accumulated allocator state, or host neighbours — the cause is not identified, and
for the purpose of reading the arms it does not need to be.

## What this does to the three results

Run order was arm0, arm1, arm2, arm3, arm0b. Interpolating the baseline linearly to each
arm's own slot:

| arm | vs first baseline | vs drift-adjusted baseline |
|---|---|---|
| arm1, batch 16 | +0.32 % | **−0.14 %** |
| arm2, + fp16 | +0.51 % | **−0.41 %** |
| arm3, cuDNN autotuning | +1.89 % | **+0.50 %** |

**No verdict changes.** All three remain far from the −3 % gate, so all three are still
rejected, and the nulls are in fact *tighter* than the raw numbers suggested: every effect
lands within about half a percent of zero.

**But one stated reason is now unsupported and is withdrawn.** The write-up said arm3 was
"the clearest rejection of the three: consistently slower on every clip, because the kernel
search is paid for and the stage it would accelerate is not the bottleneck." Its +1.89 % is
**indistinguishable from the +1.85 % drift.** The consistency across clips, which looked like
evidence of a real effect, is what a monotonic drift produces. Corrected on the published
page.

## The methodological finding, which is the more useful one

**A baseline run once is not a control.** This design ran it first and last, which bounded
the drift after the fact and was just enough to catch the error. The correct design
**interleaves a baseline between every arm**, so drift is measured continuously rather than
reconstructed.

The verdicts here survive only because every effect was far from the gate. A study looking
for a 2 % win with this design would have found one that was not there — which is precisely
what nearly happened to arm3, in the opposite direction.

Worth stating plainly for the article: the run that produced no new information about any
optimization is the run that saved the analysis. It cost twenty minutes of GPU time.

---

# The repeat baseline invalidated my own cuDNN result — drift exceeded every effect

**MEASURED 2026-09-09.** All five arms complete. The last arm, `arm0b`, was a **repeat of
`arm0` with identical configuration**, run at the end of the session for exactly this
purpose.

| clip | arm0 (first) | arm0b (last) | Δ |
|---|---|---|---|
| hdtf01 | 388.74 s | 396.07 s | +1.89 % |
| hdtf02 | 393.43 s | 398.69 s | +1.34 % |
| hdtf03 | 385.46 s | 394.45 s | +2.33 % |
| **mean** | **389.21 s** | **396.40 s** | **+1.85 %** |

**The same code, same clips, same box, same seed, ran 1.85 % slower two hours later.** That
is larger than every treatment effect measured in the entire session.

## What this does to the results

Interpolating the baseline linearly between the two measurements (0.46 % per arm slot):

| arm | raw vs arm0 | drift-corrected | verdict |
|---|---|---|---|
| arm1 — batch 16 | +0.32 % | **−0.14 %** | null |
| arm2 — batch 16 + fp16 | +0.51 % | **−0.41 %** | null |
| arm3 — cuDNN autotuning | +1.89 % | **+0.50 %** | null |

**The conclusion survives — all three arms are null — but my arm3 write-up was wrong.** I
reported cuDNN autotuning as *"consistently 1.9 % slower"* and offered a mechanism for it
(autotune benchmarking cost, shape changes on the partial batch). That mechanism may exist,
but the data do not show it: **1.89 % of the 1.89 % is drift.** After correction all three
arms sit inside ±0.5 %, which is the honest result.

Corrected in place. The earlier claim should not be quoted.

## Why this is the most important methodological result here

Without `arm0b`, three of the numbers in this file would be wrong, and one of them — cuDNN —
would have been reported as a real negative effect with a plausible-sounding explanation
attached. **A confounder larger than every effect was invisible in a well-controlled paired
A/B**: same machine, same clips, same warm process, sequential runs, fixed seed, 0.33 pp
paired spread.

The paired design was necessary and insufficient. What caught it was running the control
**twice, at the two ends of the session**. That is cheap — one extra arm — and it is the
difference between a result and a story.

## Cause: not established, and thermal is ruled out

- **Not thermal.** `nvidia-smi` reports 35 °C, and every slowdown flag is inactive: HW
  Slowdown, HW Thermal, HW Power Brake, SW Thermal all `Not Active`, with 0 µs accumulated.
- **Most likely I/O.** The output directory grew from empty to **18 GB** over the session
  (each arm writes ~3.5 GB of intermediates; the pipeline performs 18 video writes per job).
  Disk went 79 GB → 119 GB used. Since the pipeline **reads back the intermediates it just
  wrote**, a growing working set degrades page-cache hit rate, and this is a stage already
  established as I/O bound rather than compute bound. That is a coherent mechanism but it is
  **inference, not measurement.**

Testing it costs one arm: clear `out/` and re-run `arm0`. If it returns to ~389 s the cause
is the accumulated output; if it stays at ~396 s it is something else about elapsed session
time.

## Consequence for how the remaining work is measured

1. **Every future A/B must bracket its treatments with two baselines**, not one. Added to
   `GPU_SESSION.md`.
2. **The 3 % acceptance gate is now clearly right, not conservative.** A gate at 1 % would
   have passed drift as a result.
3. **Clear the output directory between arms**, or write to a tmpfs, until the cause is
   known.

---

# The output noise floor, measured — and the fp16 fidelity claim is withdrawn

**MEASURED 2026-09-09.** With arm0b complete, the baseline configuration has been run twice
with the same seed, which finally gives a *measured* floor for output comparison on this
hardware rather than one carried from a different dataset.

| compared with the baseline arm | PSNR mean | PSNR min | SSIM | worst pixel /255 | bit-identical frames |
|---|---|---|---|---|---|
| **arm0b — same config, same seed, re-run** | **40.37 dB** | 39.38 | 0.97689 | **96** | **0 / 2253** |
| arm1, batch 16 | 40.26 | 39.45 | 0.97665 | 78 | 0 |
| arm2, batch 16 + fp16 | 40.34 | 39.37 | 0.97691 | 81 | 0 |
| arm3, cuDNN autotuning | 40.16 | 39.35 | 0.97648 | 101 | 0 |

**Every arm is within 0.21 dB of the floor**, and two of the three have a *smaller* worst
pixel than doing nothing at all.

## The claim being withdrawn

An earlier entry in this file, and the published page, said:

> fp16 gave zero of 751 frames identical, 39.37 dB PSNR and a worst pixel off by 62 of 255
> levels — further from the baseline than simply re-running the pipeline is. So it is
> measurable fidelity loss for no speed.

**That is exactly backwards.** Re-running the identical configuration gives 40.37 dB and a
worst pixel of 96. fp16 gave 40.34 dB and 81. The comparison it was measured against was the
*unseeded, cross-container* regeneration figure of 45.23 dB, which is not the right
reference for a same-machine A/B. Against the correct floor, fp16 changed nothing detectable.

fp16 is still rejected — it produced no speed gain — but **not for costing fidelity.**

## Seeding is necessary and not sufficient, now measured rather than suspected

**Zero of 2,253 frames were bit-identical** between two runs of one configuration with one
seed, in one warm process, on one machine. Earlier notes listed CUDA-level nondeterminism as
a possible residual after seeding. It is now measured, and it is the whole of the residual:
`LIPSYNC_SEED` makes an A/B comparable and does not make the pipeline reproducible.

Two consequences worth carrying:

1. **Bit-exactness is unavailable as evidence for any change on this pipeline.** Every
   quality claim has to be a comparison against this floor.
2. **The source-analysis cache can only promise the bytes it stored**, never that a cached
   run equals a fresh one. The design already words it that way; this is the measurement
   behind that wording.

---

# A defect in my own build guard: it could never have passed

The `scripts/check_torch_stack.py` guard added to `cog.yaml` **fails every build**, with
`No such file or directory`. cog runs the `run:` steps *before* `COPY . /src`, so no
repository file exists at that point in the image.

It was never exercised because the treatment image predates it; the control build was the
first to run it, and it died there. An earlier entry in this file claimed the guard "fails
the BUILD if the three disagree" — it fails the build unconditionally, which is not the same
thing and is not useful.

Fixed by inlining the check into the run step so it is self-contained. The lesson is narrow
and worth keeping: **a guard placed where its dependencies do not exist is worse than no
guard**, because it converts a real signal into a build that always fails for the wrong
reason.

## What the failed build did confirm

The CUDA fix works, and the log shows the mechanism directly:

```
Attempting uninstall: torchaudio   Found existing installation: torchaudio 2.11.0
Attempting uninstall: torchvision  Found existing installation: torchvision 0.21.0
Attempting uninstall: torch        Found existing installation: torch 2.6.0
Successfully installed torch-2.5.1+cu121 torchaudio-2.5.1+cu121 torchvision-0.20.1+cu121
```

The requirements step had installed torch 2.6.0 and friends; the pinned cu121 step replaced
all three consistently, which is exactly what `--force-reinstall --no-deps` was added to
guarantee.

---

# Seeding did NOT make the pipeline deterministic — and that withdraws the fp16 fidelity claim

**MEASURED 2026-09-09.** `arm0b` was a repeat of `arm0` with **identical configuration and
`LIPSYNC_SEED=0` on both**. Comparing their outputs frame by frame:

| comparison | bit-identical | PSNR | worst pixel |
|---|---|---|---|
| **arm0 vs arm0b — same code, same seed** | **0 / 751** | **39.38 dB** | **96 / 255** |
| arm0 vs arm2 (fp16) | 0 / 751 | 39.37 dB | 62 / 255 |
| arm0 vs control (main's code) | 0 / 751 | 39.40 dB | 86 / 255 |
| arm0 vs arm3 (cuDNN autotune) | 0 / 751 | 39.59 dB | 80 / 255 |

**Every one of those is the same number.** The seeded run-to-run noise floor is 39.38 dB, and
no treatment moved the output further than a plain repeat of the baseline did.

## The fp16 fidelity claim is withdrawn

I wrote: *"fp16 is pure downside on this pipeline: zero speed, measurable fidelity loss …
PSNR 39.37 dB … it moves the output further than re-running the pipeline does."*

**That is wrong.** A repeat of the *same* build gives 39.38 dB. fp16's 39.37 dB is
indistinguishable from it, and fp16's worst pixel (62) is in fact **lower** than the
baseline repeat's (96) — the fp16 output is *closer* to arm0 than a second arm0 run is.

The correct statement: **fp16 produced no measurable speed gain and no measurable fidelity
change.** It is null on both axes, not harmful. I flagged exactly this caveat before arm0b
ran — *"do not quote the fidelity figure as fp16's alone until arm0b lands"* — and the
caveat was right.

## Why seeding was insufficient

`LIPSYNC_SEED` was set; **`LIPSYNC_DETERMINISTIC` was not.** So `repro.py` reseeded
`random`, `numpy` and torch, but never called `torch.use_deterministic_algorithms`. Seeding
fixes which random numbers get drawn. It does nothing about kernel-level nondeterminism:

- ONNX Runtime's CUDA execution provider in the face detector and landmark runner,
- `nvdiffrast` rasterisation with atomic accumulation,
- non-deterministic cuDNN algorithm selection and atomic scatter/index reductions,
- TF32 reduction order.

`repro.py`'s own docstring predicted this — *"reseeding is necessary but may not be
sufficient … treat whatever difference survives seeding as the measured floor, not as
zero"* — and the measurement confirms it. **Necessary, and not sufficient.**

## Note on the earlier noise-floor figure

The previously recorded floor was **45.23 dB**, measured between two *unseeded* production
runs on the May 2025 build. The seeded floor on this newly built image is **39.38 dB** —
*worse*, despite the seed. The builds differ (torch 2.5.1+cu121, a different cuDNN), so the
floor is **build-specific and must be re-measured per build.** It is not a property of the
pipeline.

## What this means for the results

1. **All four output comparisons this session are at the noise floor.** No treatment changed
   the output measurably. Combined with the timing result, all three arms are null on
   *both* axes.
2. **The quality gate could not have detected a real regression** at this floor, since a
   worst-pixel deviation of 96/255 is inside it. `compare_outputs.py` was the right primary
   instrument and its thresholds need setting from the per-build floor.
3. **Next step to get real determinism:** run one clip twice with
   `LIPSYNC_DETERMINISTIC=1`, which enables `torch.use_deterministic_algorithms(warn_only=True)`
   and sets `CUBLAS_WORKSPACE_CONFIG`. If that still is not bit-identical, the residual is in
   ONNX Runtime and nvdiffrast, and bit-exactness is unavailable without changing those —
   which the caching work needs to know, since it was relying on reproducibility.

---

# The control: the branch is performance-neutral, so the arms measured what they claimed

**MEASURED 2026-09-09.** The control runs the **unmodified branch's runtime code** with only
the build fixes it needs to run at all, on the same three clips. It is the comparison that
separates the effect of the code changes from the effect of rebuilding the environment.

Run order was arm0, arm1, arm2, arm3, arm0b, control. **The control ran immediately after the
repeated baseline**, so those two are adjacent in time and the drift between them is
negligible. That is the pairing to read.

| comparison | slots | paired | per-clip | signs |
|---|---|---|---|---|
| **unmodified branch vs our code** | 6 vs 5, adjacent | **−0.47 %** | +0.46, −0.64, −1.23 | **mixed** |
| unmodified branch vs first baseline | 6 vs 1 | +1.38 % | +2.36, +0.69, +1.08 | consistent (drift) |

**The branch is performance-neutral.** −0.47 % with mixed per-clip signs is noise, not an
effect. So the always-on changes the branch carries — asynchronous host-to-device copies and
the restructured render loop — do not move wall-clock either way, and **the arms measured the
switches they were testing rather than incidental differences between branch and trunk.**

Output agreement is inside the floor too: 39.40, 41.12 and 40.41 dB against the baseline,
with worst pixels of 86, 79 and 81 — the same range as re-running the baseline (40.37 dB,
worst 96). All three control videos pass the sanity checks.

## The A/B is now complete, and here is the whole of it

Six passes, 18 runs, one machine, same clips, seeded, sequential.

| pass | change | paired vs adjacent baseline | verdict |
|---|---|---|---|
| arm0 | baseline, batch 4 fp32 | reference | — |
| arm1 | renderer batch 4 → 16 | −0.14 % (drift-adjusted) | rejected |
| arm2 | batch 16 + fp16 autocast | −0.41 % (drift-adjusted) | rejected |
| arm3 | cuDNN autotuning in the render loop | +0.50 % (drift-adjusted) | rejected |
| arm0b | baseline repeated | +1.85 % vs arm0 — **pure drift** | drift control |
| control | unmodified branch's code | −0.47 % vs arm0b | performance-neutral |

Every candidate lands within about half a percent of zero once drift is removed, against a
gate of 3 %. Every one is inside the output noise floor. **Nothing was kept.**

The two runs that produced no information about any optimization — the repeated baseline and
the control — are the two that made the other four interpretable. Between them they caught a
1.85 % machine drift that had been read as a real effect, and disproved a fidelity claim.
They cost about forty minutes of GPU time.

---

# The stage-level result is cleaner than the wall clock, and it is the whole story

**MEASURED 2026-09-09.** All six runs recorded in `experiments.tsv`. `render_rgb` is the
stage the batch-size and fp16 arms were specifically aimed at:

| arm | `render_rgb` | vs arm0 | what changed |
|---|---|---|---|
| arm0 | 89.80 s | — | baseline |
| arm1 | 89.90 s | **+0.11 %** | batch 4 → 16 |
| arm2 | 89.10 s | **−0.78 %** | batch 16 + fp16 |
| arm3 | 91.90 s | +2.34 % | cuDNN autotuning |
| **arm0b** | **91.30 s** | **+1.67 %** | **nothing — a repeat of arm0** |
| control | 92.70 s | +3.23 % | main's code |

**The stage moved less under both treatments than it did under no treatment at all.**
Quadrupling the batch changed the targeted stage by 0.11 %; a repeat of the baseline changed
it by 1.67 %.

This is the tightest form of the result. Wall clock includes download, transcode and upload,
which add variance; `render_rgb` is the isolated 24.5 % of the pipeline that both arms were
designed to accelerate, and it did not move.

## The complete A/B result, in one table

| item | timing | output vs arm0 | verdict |
|---|---|---|---|
| batch 4 → 16 | −0.14 % (drift-corrected) | 39.37 dB = floor | **null** |
| batch 16 + fp16 | −0.41 % (drift-corrected) | 39.37 dB = floor | **null** |
| cuDNN autotuning | +0.50 % (drift-corrected) | 39.59 dB = floor | **null** |
| our whole branch vs main | −0.47 % | 39.40 dB = floor | **null** |
| *session drift, same code* | *+1.85 %* | *39.38 dB* | *the confounder* |

Three of the team's five roadmap items are measured. **All three are null on speed and null
on output.** Our branch as a whole, with every knob at its production default, is
indistinguishable from `main`.

## Why this is a result and not a failure

The measurement is precise enough to have found a win. The paired spread within an arm is
0.33 pp; the arms differ from the baseline by less than the baseline differs from itself.
What the session established, in order of confidence:

1. **The GPU is idle 33 % of the time and 27 % utilized on average** — measured directly,
   1,191 samples.
2. **Both arithmetic-side optimizations target the 27 %, and neither touches the 73 %** —
   the reason they are null, stated as a mechanism, not a guess.
3. **The renderer is video-decode bound**, and the code path that makes it so is identified:
   a backward seek per frame into a 250-frame GOP, each frame decoded five times.
4. **Session drift, at 1.85 %, exceeded every effect** — caught only by running the control
   twice.
5. **Seeding does not deliver determinism on this build**, so the output floor is 39.38 dB,
   and it is build-specific.

Every one of those five is a measured fact that did not exist at the start of the day, and
each one redirects effort away from the roadmap and toward the structural items — cold
start, caching, CPU/GPU separation, and the decode path.

## The whole-session VRAM and utilisation record

Recomputed from all 6,298 samples of the session monitor rather than the batch-16 window
alone, so this supersedes the per-arm figures above for any statement about the session.

| quantity | value |
|---|---|
| samples with memory in use | 3,075 |
| peak VRAM | 17.9 GiB of 40.0 (45 % of the card) |
| mean VRAM | 11.3 GiB |
| mean GPU utilisation while a job was resident | 28 % |
| samples at 0 % utilisation | 822, or 27 % of the time |

**These are not in conflict with the 27 % / 33.3 % figures above, and neither supersedes
the other — they are different windows.** The section above samples 1,191 points across the
*arm runs only*, which is the right window for explaining the arm results. This one samples
all 3,075 points where a job held memory across the *whole session*, including the
determinism pairs and the cleared-directory baseline, which is the right window for a
statement about the session. Idle share falls from 33.3 % to 27 % because the later passes
included deterministic runs, which spend more time in GPU kernels. Quote the arm window
when explaining the arms; quote this one when characterising the machine.

**Unit correction.** Earlier notes restated 18,293 MiB as "18.3 GB". 18,293 MiB is 17.9 GiB.
The 44.7 % share was right; only the gigabyte restatement was wrong, and it is fixed
throughout. No conclusion changes: the peak is still under half the card, so two concurrent
jobs still fit in memory, and the packing lever still depends on cores rather than VRAM.

**The utilisation figure is the one that matters.** A job holds the card for its whole
duration but leaves it idle 27 % of the time and averages 28 % when resident. That is the
headroom the rejected arms were trying to reach, and it explains why they could not: the
gap is decode and host-side work, not arithmetic the GPU was too slow to finish.

## Deterministic kernels: measured, and they buy nothing here

One clip (hdtf01_RD_Radio11_001, 751 frames) run twice with `LIPSYNC_SEED=0` and
`LIPSYNC_DETERMINISTIC=1`, which sets `torch.use_deterministic_algorithms(True,
warn_only=True)` and `CUBLAS_WORKSPACE_CONFIG=:4096:8` on top of the full reseed.

| quantity | det1 vs det2 | seeded only (arm0 vs arm0b) |
|---|---|---|
| bit-identical frames | **0 of 751** | 0 of 751 |
| PSNR mean | 39.62 dB | 40.37 dB |
| SSIM mean | 0.97333 | — |
| worst pixel | 90 of 255 | 96 of 255 |

**The floor does not move.** Asking torch for deterministic kernels leaves the
run-to-run difference where seeding alone left it. Two runs of one clip at one seed
still share zero identical frames.

### What it costs

| baseline for this clip | wall | determinism mean 440.25 s |
|---|---|---|
| arm0, first pass | 388.74 s | **+13.25 %** |
| arm0b, last pass | 396.07 s | **+11.15 %** |
| control, unmodified code | 397.91 s | **+10.64 %** |

So it is a 10-13 % tax for no reproducibility gain. `LIPSYNC_DETERMINISTIC` stays off,
and it should not be offered as a route to reproducible output.

### Why, and what it means for the cache

`repro.py`'s own docstring predicted this and the measurement confirms it: the
nondeterminism is not in torch. The pipeline runs face detection and landmarks through
onnxruntime's CUDA execution provider and rasterises through nvdiffrast, neither of which
`torch.use_deterministic_algorithms` reaches. `warn_only=True` also lets any torch kernel
without a deterministic implementation proceed rather than raise.

**This settles the caching design.** A cache cannot be validated by recomputing a segment
and checking it matches — recomputation does not reproduce bytes, with or without
deterministic mode. A word-replacement cache must **store and return the bytes it
computed**, and its correctness argument has to rest on key derivation, not on
recomputation agreeing.

### A second, unplanned result: the noise floor on wall-clock

det1 and det2 are the same code, same clip, same seed, same flags, run back to back.

    det1 445.26 s · det2 435.23 s · difference 10.03 s = 2.28 %

> **SUPERSEDED — see "Correction: the repeat spread was quoted from two samples" below.**
> A second pair came in at 0.23 %. The figure to use is the four-run CV, **0.95 %**. The
> conclusion drawn here survives; the number quoted for it does not.

**Two identical configurations differ by 2.28 %.** Every candidate this session measured
came in under 0.5 %. That gap is the honest summary of the whole A/B: at n=1 per
configuration this rig cannot resolve the effects the roadmap proposed, and the 3 % gate is
only just above its own noise. The arms were rejected on the drift-adjusted paired
comparison, which is stronger than this single pair, but nothing here would have detected a
true 1 % win.

## A production correctness bug, found by reading the stage I was optimising

While instrumenting `paste_back` for the bbox work, its no-face branch turned out to be
wrong in the arm that serves lipsync.

```python
if i in no_face_indices:
    out_list.append(video_reader.seek(i))   # RAM arm gets the frame
    continue                                # the writer never sees it
```

`paste_back` maintains two outputs. `out_list` feeds the in-memory return and the
`VideoWriter` feeds the encoded file. On a frame where face detection failed there is
nothing to composite, so the original frame passes through — but only into the list.

**The arm that was broken is the one lipsync uses.** `hummingbird/inference.py` derives the
choice from the input type:

| workload | input | `use_ram` | arm taken | result |
|---|---|---|---|---|
| word replacement | list of frames | True | RAM | correct |
| **lipsync** | **video path** | **False** | **disk writer** | **short output** |

The encoded file came out short by exactly `len(no_face_indices)` frames. Audio is attached
afterwards against a frame count that no longer matches, so everything after the first
failed frame sits early against the audio and the drift persists to the end of the clip.

### Measured before the fix

`benchmarking/tests/test_paste_back_no_face.py`, CPU only, stubbed readers and writer:

| no-face frames | frames in | RAM out | disk out | lost |
|---:|---:|---:|---:|---:|
| 0 | 12 | 12 | 12 | 0 |
| 1 | 12 | 12 | 11 | 1 |
| 2 | 12 | 12 | 10 | 2 |
| 5 | 40 | 40 | 35 | 5 |
| 17 | 40 | 40 | 23 | 17 |

Exactly the no-face count, every time, disk arm only.

### Why it survived: the condition is invisible in the logs

`no_face_indices` was logged in exactly one place, and only for **total** failure:

```python
if len(no_face_indices) == len(out_list):
    logger.info(f"Num no faces ... Exiting...")
```

A *partial* failure — the case where the bug fires — produced no log line at all. A job
that silently dropped frames looked identical to a clean one. That also means the
production logs cannot tell us how often this fired: **this work supplies no rate**, only
the mechanism and the fix.

### Fixed, in two parts

1. The no-face frame is handed to both outputs, the same frame at the same loop position,
   so no re-indexing is involved and the RAM arm is untouched. The `out_list` append is now
   also conditional on `use_ram`, which stops the disk path building a frame list it throws
   away.
2. A partial failure now logs a warning with the count, the share of frames and the first
   twenty indices, so the condition is visible and its rate becomes measurable from here on.

The turbo pipeline is unaffected: it does not pass `no_face_indices` into `paste_back` and
reconciles bad frames afterwards through `handle_bad_frames`.

19 checks, wired in as gate 5 of `verify_local.sh`.

**This is the most consequential thing in this file.** Every performance result here came
back null. A silent correctness defect on the shipping path did not.

## The drift has a partial, avoidable cause

`arm0b` measured a +1.85 % session drift with no code change, which is larger than every
effect under test and is what withdrew arm3. So the baseline was run a **third** time,
`arm0c`, with one change: the accumulated output directory cleared first. The pipeline
writes 18 intermediate videos per job into it and it had reached 20 GB.

**Free space is not the mechanism.** The volume stayed 39 % full throughout, so anything
here comes from directory contents, not from running out of room.

| clip | arm0 first | arm0b last | arm0c cleared | vs arm0 | vs arm0b |
|---|---:|---:|---:|---:|---:|
| hdtf01 | 388.74 | 396.07 | 395.04 | +1.62 % | −0.26 % |
| hdtf02 | 393.43 | 398.69 | 394.73 | +0.33 % | −0.99 % |
| hdtf03 | 385.46 | 394.45 | 388.82 | +0.87 % | −1.43 % |
| **mean** | **389.21** | **396.40** | **392.86** | **+0.94 %** | **−0.89 %** |

Clearing recovered **0.91 of the 1.85 points**, about half. The sign is consistent: all
three clips beat the uncleared baseline, and all three were still slower than the first.

### How far this goes, stated plainly

The effect is 0.91 points. The repeat spread over four identical runs is **0.95 % CV**
(see the correction below). **The effect is about the size of the noise it is measured
against**, at n=1 per configuration. Note
also the confound that cuts the other way: `arm0c` ran *later* than `arm0b`, so pure
time-ordered drift would have predicted it slower, and it was faster on every clip. That
strengthens the direction without fixing the magnitude.

What this earns is procedure, not a number:

1. **Clear the output directory between arms.** Free, and removes a confound.
2. **Interleave a baseline between every arm.** This session's whole correction exercise
   exists because that was not done.
3. **Do not quote the explained/unexplained split as a result.** It is inside the noise.

### Why it was worth spending the GPU time on a pass that tests nothing

`arm0c`, like `arm0b` and the branch control, measures no optimization at all. Three of the
six passes this session were controls, and they produced every conclusion that survived:
the drift correction, the withdrawal of two of my own claims, the confirmation that the
branch is performance-neutral, and now a partial cause for the drift. The three passes that
tested actual optimizations all returned null.

---

# Determinism is unreachable through torch flags — and attempting it costs 13 %

**MEASURED 2026-09-09.** Two runs of one clip with **both** `LIPSYNC_SEED=0` **and**
`LIPSYNC_DETERMINISTIC=1`, which calls `torch.use_deterministic_algorithms(True,
warn_only=True)` and sets `CUBLAS_WORKSPACE_CONFIG=:4096:8`.

| comparison | bit-identical | PSNR | worst pixel |
|---|---|---|---|
| seeded only (arm0 vs arm0b) | 0 / 751 | 39.38 dB | 96 / 255 |
| **seeded + deterministic kernels (detA vs detB)** | **0 / 751** | **39.27 dB** | **109 / 255** |

**Deterministic kernels did not help at all.** The output floor is unchanged, and the worst
pixel deviation is slightly *larger*. Meanwhile:

| run | wall clock | vs baseline |
|---|---|---|
| arm0 baseline | 389.21 s | — |
| det (first attempt) | 445.31 / 435.28 s | +14.4 % / +11.9 % |
| detA / detB (rerun) | 441.14 / 442.17 s | **+13.4 %** |

**Requesting determinism costs 13 % and delivers none of it.** That is the largest single
effect measured in the entire session — an order of magnitude bigger than anything the three
roadmap arms produced — and it is a pure cost.

## Where the residual must live

`torch.use_deterministic_algorithms` governs PyTorch kernels only. The remaining
nondeterminism is therefore outside PyTorch:

- **ONNX Runtime's CUDA execution provider** — the face detector and landmark runner
  (`LivePortrait/src/utils/human_landmark_runner.py`, `cropper.py`). Torch flags cannot
  reach it; it needs its own session options.
- **nvdiffrast** — rasterisation with atomic accumulation, no deterministic mode.
- Anything else allocating and reducing outside the torch allocator.

## What this does and does not do to the caching plan

This is a distinction worth getting right, because the earlier note in this file overstated
it.

**It does NOT make the source-analysis cache unsound.** That cache stores the artefacts of a
real analysis run and hands them back. Those artefacts are valid — they *are* the output of
crop, landmark, parse and track on that video. The animator still runs fresh on the new
audio, so no stitch seam is created. Determinism is not required for the cache to be
*correct*.

**It does make the cache unverifiable.** You can never assert "restored equals freshly
computed", because two fresh runs do not equal each other either. The design's answer — a
witness digest over the frames actually analysed, with `crop_face` still running on a hit —
becomes the only available check, and it verifies *the key*, not the bytes. That was the
right design decision and this measurement is why.

**It does rule out a segment-output cache.** Splicing a cached generated segment against a
fresh one needs the two motion trajectories to agree at the join, and they cannot.

**And it removes the 13 % option.** Buying determinism to make caching verifiable is not
available at any price, because the price does not buy the thing.

## Correction to an earlier entry in this file

An earlier section said the cache "is only sound if the sampler is seeded". That conflated
two caches. Precisely:

- **Source-analysis cache** (the one proposed): needs the *inputs* to be reproducible so the
  key can match — which is the time-warp RNG problem, fixable by seeding that one call. It
  does **not** need the pipeline to be bit-reproducible.
- **Segment-output cache** (not proposed): would need full determinism, which is now
  measured to be unavailable.

## Consequence for every quality gate in this package

`compare_outputs.py` can never assert bit-exactness for any change on this build. Its
thresholds must be set from the measured per-build floor — **39.3 dB PSNR, worst pixel ~109**
— and any change whose deviation sits inside that is simply unmeasurable, not verified as
safe. The three arms all sat inside it.

## Correction: the repeat spread was quoted from two samples

A second independent pair of deterministic runs was measured on the same clip, same seed,
same flags, after the output directory had been cleared.

| pair | machine state | mean | range | range % |
|---|---|---:|---:|---:|
| det1 / det2 | ~20 GB accumulated | 440.25 s | 10.03 s | 2.28 % |
| detA / detB | cleared | 441.61 s | 1.03 s | **0.23 %** |
| all four | — | 440.93 s | 10.03 s | 2.27 % |

**Four-run stdev 4.19 s, CV 0.95 %.**

### What I got wrong

Earlier in this file I wrote *"Two identical configurations differ by 2.28 %"* and then used
that figure as **the** repeat spread to bound every other claim, including the drift result.
A range taken from two samples is an unstable estimate of variance, and the second pair
demonstrates it: ten times tighter, while the two pairs' *means* differ by only 0.31 %.

**Use the four-run CV, 0.95 %.** Every conclusion that rested on the old figure survives,
because the candidates came in at 0.14, 0.41 and 0.50 % and all three sit inside 0.95 % too.
What changes is one sentence in the drift section: 0.91 points is *about the size of* the
noise, not comfortably smaller than it.

### What I am not claiming

The tempting story is that clearing the directory cut the variance tenfold, which would
corroborate the drift finding by a second route. Two pairs cannot support that, and the
tighter pair also ran later in the session, so it is confounded with exactly the thing
under test. It stays an observation.

### The determinism verdict is firmer, not weaker

detA vs detB: **0 of 751 frames identical**, 39.27 dB, worst pixel 109 of 255. Two
independent pairs, zero reproduced frames in both. The cache still has to store its bytes.

---

# `pip freeze` cannot detect the defect that broke the deploy

Noticed while archiving the environment record. `pip freeze` from inside the working image
reports:

```
torch==2.5.1
torchaudio==2.5.1+cu121
torchvision==0.20.1+cu121
```

**`torch` appears without its local version tag** while the other two keep theirs. The
installed artefact is `torch-2.5.1+cu121` — the install log says so explicitly, and
`torch.__version__` returns `2.5.1+cu121`. Only `pip freeze`'s rendering drops it.

That is exactly the field that distinguished the working image from the broken one. The
broken image had `torch 2.5.1` built against CUDA 12.4 beside `torchaudio 2.5.1+cu121`, and
**`pip freeze` would have rendered that as `torch==2.5.1` too** — indistinguishable from
correct.

So the standard tool for capturing a Python environment is blind to the discriminating
field, which is part of why the defect survived. `scripts/check_torch_stack.py` catches it
because it reads `torch.__version__` and `torch.version.cuda` directly and compares the
local tags across all three packages.

Worth stating in the article: the lockfile could not express the build variant, and the
environment-capture tool could not display it. Two layers of standard tooling, both blind to
the same field.
