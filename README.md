# Frequency Masking Curves

This is a self-contained browser app for the MUE 510 frequency-masking experiment. It uses the Web Audio API to present a masker and probe, collects a listener’s two-interval forced-choice responses, estimates thresholds with an adaptive staircase, and plots the measurements.

## Run locally on macOS

Open **Terminal**, clone the repository, change into the cloned folder, and start a local static server. The `python3` command is already available on many Macs with Python installed:

```bash
git clone https://github.com/vohenry111-dotcom/masking-curves.git
cd masking-curves
python3 -m http.server 8000
```

Keep that Terminal window open while using the app. Then open <http://localhost:8000> in Safari, Chrome, Firefox, or Edge on your Mac. Press **Control-C** in Terminal when you are finished to stop the server.

If macOS reports that `python3` is not found, install Python 3 from the official Python installer or use an existing Python installation, then rerun the command. On Windows or Linux, use the equivalent terminal and `cd` command. The app does not require microphone access, an account, a database, a cloud service, a build system, or an external chart library.

For the experiment, use headphones connected to the Mac, set the Mac volume low before the headphone check, and avoid changing the Mac’s system volume during a session. Safari and Chrome are recommended if another browser has Web Audio timing issues.

## Measurement method

The app uses Method C from the assignment: randomized two-interval forced choice (2IFC). Each trial contains two equal-duration intervals. Both intervals contain the same masker when a masked condition is running. Exactly one interval also contains the probe. The target interval is randomized and hidden until the listener submits an answer.

The masker and probe are played at the same time within the target interval, so they may sound like one combined tone rather than two clearly separated beeps. When probe and masker frequencies are equal, they naturally fuse into one louder tone. In a no-masker baseline condition, one interval contains only the probe and the other interval is silent.

The staircase is 2-down, 1-up:

- After two consecutive correct responses, the probe decreases.
- After one incorrect response, the probe increases.
- The first nonzero movement is not a reversal.
- A reversal is a change from an upward movement to a downward movement, or vice versa. A response that does not change the level cannot create a reversal.
- The step is 4 dB through the first two reversals and 2 dB afterward.
- A condition stops after eight reversals or the maximum trial limit.
- A valid threshold is the arithmetic mean of the last six reversal levels. A run that reaches its trial limit without eight reversals is stored as incomplete and has no threshold estimate.

The default masker centers are 500, 1000, and 2000 Hz. The ratio-based probe grid includes frequencies below, at, and above each masker. The app also supports no-masker baseline conditions. When the same probe frequency has both estimates:

```text
masking amount (dB) = masked threshold (dBFS) - baseline threshold (dBFS)
```

For example, -38 dBFS minus -55 dBFS is +17 dB. Missing baselines remain missing; they are never fabricated.

## Audio and level handling

The displayed stimulus settings are digital dBFS values, not dB SPL. The conversion is:

```text
linearAmplitude = 10 ** (dBFS / 20)
```

Masker and probe oscillators use short equal raised-cosine-style attack and release ramps to reduce clicks. A conservative master gain is calculated from the sum of the individual linear amplitudes. This keeps the summed waveform below 1 while preserving the intended masker-to-probe ratio. The display continues to show the intended pre-master-gain dBFS values.

Use headphones in a quiet room, begin with a low system volume, and listen only at a comfortable level. Do not change the operating-system volume during a session. Stop immediately if the sound is uncomfortable. This is an educational experiment, not a hearing test or clinical evaluation.

## Workflow

1. Complete the safety statement and play the headphone check.
2. Choose masker centers, masker level, probe ratios, and whether to include baselines.
3. Start a session.
4. Press **Play trial**, then choose Interval 1 or Interval 2 after playback ends. Keyboard keys 1 and 2 are also available only after playback.
5. The app autosaves after every response. Pause, restart the current condition, or abort when necessary.
6. Inspect the masked-threshold chart, masking-amount chart, staircase diagnostic, summary table, and raw-trial table.
7. Export trial CSV, threshold-summary CSV, and a JSON backup. PNG buttons export the three charts.
8. Save your AI prompt, suggestion, disposition, and reason in the engineering log.

## Stored data

The versioned session is saved in `localStorage`. Each trial stores the session ID, ISO timestamp, condition type, masker and probe settings, presented level, target interval, chosen interval, correctness, step size, staircase direction, reversal status/count, and trial number. Each condition stores its threshold when valid, reversal levels, completion status, stopping reason, trial count, accuracy, and settings. A JSON backup contains the same session data and can be validated and imported later.

The app intentionally keeps demo data separate from measured data. The **Load demo data** button exists only to test chart layout and is marked **DEMO, NOT MEASURED**. It does not enter the session’s raw measurements or exports.

## Interpretation and limitations

Before collecting data, the dashboard states this qualitative hypothesis: masking should be strongest near the masker, decline with frequency separation, may be asymmetric above versus below the masker, and may become broader in Hz at higher center frequencies. The student must compare this hypothesis with their own measurements after collection.

Relate the final curves to critical-band behavior and auditory filtering, but do not claim a result before inspecting the data. Important limitations include:

- no acoustic calibration, so results are dBFS rather than dB SPL;
- headphone frequency-response variation;
- operating-system and browser gain differences;
- ambient noise, attention, fatigue, practice, and order effects;
- limited reversal count and frequency sampling;
- individual hearing differences;
- possible clicks, distortion, clipping, or timing cues if an audio implementation fails;
- pure-tone masker/probe beats when frequencies are close;
- changing system volume invalidates within-session comparisons.

## Report-outline template

Fill this in only after personally collecting and inspecting the data:

1. **Measurement method:** describe the 2IFC staircase, masker settings, probe grid, stopping rule, and baseline procedure.
2. **AI prediction:** state the qualitative prediction made before measurement.
3. **Results:** insert exported curves and describe observed thresholds without inventing missing values.
4. **Critical-band behavior:** discuss concentration and width of masking around each masker.
5. **Masking asymmetry:** compare the measured sides above and below the masker where data support it.
6. **Differences among masker frequencies:** compare curves and possible bandwidth changes.
7. **Experimental limitations:** discuss calibration, equipment, fatigue, sampling, beats, order, and other relevant issues.
8. **AI prompts and responses:** include selected prompts and responses.
9. **Corrected/rejected suggestion:** document what was changed and why. The prefilled example in the app is only a draft; do not claim it as your own decision until you review and adopt it.

## Validation

The developer panel tests pure functions for dBFS conversion, safe gain, 2-down/1-up movement, reversal rules, incomplete thresholds, last-six reversal averaging, negative-dBFS subtraction, and schema versioning. The manual checklist covers headphone playback, equal intervals, response locking, autosave/resume, exports, imports, and chart inspection. Browser timing, audible clicks, listening comfort, and actual headphone behavior still require human verification.

## Rubric coverage

- Interactive controls, playback, response collection, and saved measurements: setup, experiment, localStorage, and raw table.
- At least three masker frequencies and curves: default 500/1000/2000 Hz plan and masked-threshold chart.
- Threshold or masking amount with masker marking: both charts, logarithmic frequency axis, and masker guide lines.
- Appropriate psychoacoustic method: randomized 2IFC with explainable adaptive staircase.
- Baseline correction: optional no-masker conditions and explicit matching-frequency subtraction.
- Safety and units: dBFS labels, master safety gain, ramps, warnings, and no dB SPL claims.
- AI requirement: prediction panel, editable engineering log, and report template.
- Deliverables: CSV/JSON exports, PNG chart exports, raw data, summary table, and documentation.
