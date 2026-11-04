/*
  Frequency Masking Curves
  Educational, uncalibrated browser experiment. Real measurements are never
  synthesized by this file; demo data is stored in a separate in-memory view.
*/
const SCHEMA_VERSION = 1;
const STORAGE_KEY = "frequency-masking-curves.session.v1";
const DEMO_KEY = "frequency-masking-curves.demo.v1";
const DEFAULT_RATIOS = [0.5, 0.7, 0.85, 0.95, 1, 1.05, 1.2, 1.5, 2];
const MAX_REVERSALS = 8;
const COLORS = ["#087f86", "#ca6a32", "#6d54a8", "#c04f76", "#4477aa", "#5f8d48"];
let session = null;
let demoData = null;
let audioContext = null;
let activeNodes = new Set();
let trialLock = false;
let playbackFinished = false;
let paused = false;

const $ = (id) => document.getElementById(id);
const els = {
  setup: $("setupSection"), experiment: $("experimentSection"), badge: $("sessionBadge"), saveStatus: $("saveStatus"),
  headphoneCheck: $("headphoneCheck"), headphoneButton: $("headphoneButton"), start: $("startSessionButton"), resume: $("resumeButton"),
  maskerFrequencies: $("maskerFrequencies"), maskerLevel: $("maskerLevel"), probeRatios: $("probeRatios"), baseline: $("includeBaseline"), randomize: $("randomizeConditions"),
  startLevel: $("startLevel"), minLevel: $("minLevel"), maxLevel: $("maxLevel"), maxTrials: $("maxTrials"), intervalMs: $("intervalMs"), gapMs: $("gapMs"),
  pause: $("pauseButton"), restart: $("restartConditionButton"), abort: $("abortButton"), play: $("playTrialButton"), stop: $("stopAudioButton"),
  i1: $("interval1Button"), i2: $("interval2Button"), instruction: $("trialInstruction"), response: $("responseMessage"), trialNo: $("trialNumberLabel"), reversals: $("reversalLabel"), level: $("currentLevelLabel"), trialProgress: $("trialProgress"),
  condition: $("conditionLabel"), probe: $("probeFrequencyLabel"), masker: $("maskerFrequencyLabel"), conditionProgress: $("conditionProgressLabel"), progressList: $("sessionProgressList"),
  maskedChart: $("maskedChart"), maskingChart: $("maskingChart"), staircaseChart: $("staircaseChart"), staircaseSubtitle: $("staircaseSubtitle"), summaryBody: $("summaryTable").querySelector("tbody"), rawBody: $("rawTable").querySelector("tbody"),
  demo: $("demoButton"), clearDemo: $("clearDemoButton"), demoNotice: $("demoNotice"), newSession: $("newSessionButton"), exportJson: $("exportJsonButton"), importJson: $("importJsonButton"), importInput: $("importJsonInput"), deleteSession: $("deleteSessionButton"), exportSummary: $("exportSummaryButton"), exportTrials: $("exportTrialsButton"),
  aiPrompt: $("aiPrompt"), aiSuggestion: $("aiSuggestion"), aiDisposition: $("aiDisposition"), aiReason: $("aiReason"), saveAiLog: $("saveAiLogButton"), aiStatus: $("aiLogStatus"), runTests: $("runTestsButton"), testSummary: $("testSummary"), testOutput: $("testOutput")
};

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function uid(prefix = "id") { return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
function roundDisplay(value, digits = 1) { return Number.isFinite(value) ? value.toFixed(digits) : "—"; }
function dbfsToAmplitude(dbfs) { return 10 ** (dbfs / 20); }
function amplitudeToDbfs(amplitude) { return 20 * Math.log10(Math.max(amplitude, 1e-12)); }
function calculateSafeMasterGain(maskerAmp, probeAmp = 0) {
  const summedPeak = Math.max(0, maskerAmp) + Math.max(0, probeAmp);
  return summedPeak > 0.85 ? 0.85 / summedPeak : 0.85;
}
function parseNumberList(value, transform = Number) {
  return String(value).split(",").map((part) => transform(part.trim())).filter((value) => Number.isFinite(value));
}
function parsePlan() {
  const maskers = [...new Set(parseNumberList(els.maskerFrequencies.value))].filter((f) => f >= 20 && f <= 8000);
  const ratios = [...new Set(parseNumberList(els.probeRatios.value))].filter((r) => r > 0);
  const settings = {
    maskerFrequencies: maskers.length ? maskers : [500, 1000, 2000],
    maskerLevelDbfs: clamp(Number(els.maskerLevel.value) || -35, -80, -10),
    ratios: ratios.length ? ratios : DEFAULT_RATIOS,
    includeBaseline: els.baseline.checked,
    randomizeConditions: els.randomize.checked,
    startLevelDbfs: Number(els.startLevel.value) || -25,
    minLevelDbfs: Number(els.minLevel.value) || -80,
    maxLevelDbfs: Number(els.maxLevel.value) || -10,
    maxTrials: clamp(Number(els.maxTrials.value) || 60, 8, 300),
    intervalMs: clamp(Number(els.intervalMs.value) || 600, 200, 2000),
    gapMs: clamp(Number(els.gapMs.value) || 400, 100, 1500),
    rampMs: 20
  };
  settings.minLevelDbfs = Math.min(settings.minLevelDbfs, settings.startLevelDbfs - 1, settings.maxLevelDbfs - 1);
  settings.startLevelDbfs = clamp(settings.startLevelDbfs, settings.minLevelDbfs + 1, settings.maxLevelDbfs - 1);
  return settings;
}
function safeProbeFrequency(masker, ratio) {
  const candidate = Math.round(masker * ratio);
  const sampleRate = audioContext?.sampleRate || 48000;
  return candidate >= 20 && candidate <= 8000 && candidate <= sampleRate * 0.4 ? candidate : null;
}
function initializeStaircase(settings) {
  return { levelDbfs: settings.startLevelDbfs, minLevelDbfs: settings.minLevelDbfs, maxLevelDbfs: settings.maxLevelDbfs, maxTrials: settings.maxTrials || 60, trialCount: 0, correctStreak: 0, previousDirection: null, reversalCount: 0, reversalLevels: [], lastStepSize: 4, lastDirection: null, complete: false, stopReason: null };
}
function determineDirection(state, isCorrect) {
  if (isCorrect) return state.correctStreak + 1 >= 2 ? -1 : null;
  return 1;
}
function detectReversal(previousDirection, nextDirection) {
  return previousDirection !== null && nextDirection !== null && previousDirection !== nextDirection;
}
function scoreResponse(state, isCorrect) {
  const next = structuredClone(state);
  const presentedLevel = next.levelDbfs;
  next.trialCount += 1;
  const direction = determineDirection(next, isCorrect);
  if (isCorrect) next.correctStreak += 1; else next.correctStreak = 0;
  let reversal = false;
  let stepSize = next.reversalCount >= 2 ? 2 : 4;
  if (direction !== null) {
    reversal = detectReversal(next.previousDirection, direction);
    if (reversal) { next.reversalCount += 1; next.reversalLevels.push(presentedLevel); stepSize = next.reversalCount > 2 ? 2 : 4; }
    next.levelDbfs = clamp(next.levelDbfs + direction * stepSize, next.minLevelDbfs, next.maxLevelDbfs);
    next.previousDirection = direction;
    next.lastDirection = direction;
    next.lastStepSize = stepSize;
    next.correctStreak = 0;
  }
  if (next.reversalCount >= MAX_REVERSALS) { next.complete = true; next.stopReason = "eight reversals"; }
  else if (next.trialCount >= next.maxTrials) { next.complete = true; next.stopReason = "maximum trial limit"; }
  return { state: next, direction, reversal, presentedLevel, stepSize };
}
function shouldStop(state, maxTrials) { return state.reversalCount >= MAX_REVERSALS || state.trialCount >= maxTrials; }
function estimateThreshold(state) { return state.reversalLevels.length >= MAX_REVERSALS ? state.reversalLevels.slice(-6).reduce((a, b) => a + b, 0) / 6 : null; }
function calculateMasking(masked, baseline) { return Number.isFinite(masked) && Number.isFinite(baseline) ? masked - baseline : null; }

function createConditions(settings) {
  const conditions = [];
  for (const masker of settings.maskerFrequencies) {
    for (const ratio of settings.ratios) {
      const probe = safeProbeFrequency(masker, ratio);
      if (probe !== null) conditions.push(makeCondition("masked", masker, probe, settings));
    }
  }
  if (settings.includeBaseline) {
    const probes = [...new Set(conditions.map((condition) => condition.probeFrequency))].sort((a, b) => a - b);
    for (const probe of probes) conditions.push(makeCondition("baseline", null, probe, settings));
  }
  if (settings.randomizeConditions) shuffle(conditions);
  return conditions;
}
function makeCondition(type, maskerFrequency, probeFrequency, settings) {
  return { id: uid("condition"), type, maskerFrequency, maskerLevelDbfs: type === "masked" ? settings.maskerLevelDbfs : null, probeFrequency, staircase: initializeStaircase(settings), trials: [], thresholdDbfs: null, completed: false, completionStatus: "not started", stopReason: null, accuracy: null, startedAt: null, completedAt: null };
}
function shuffle(array) { for (let i = array.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [array[i], array[j]] = [array[j], array[i]]; } return array; }

function newSession() {
  const settings = parsePlan();
  session = { schemaVersion: SCHEMA_VERSION, sessionId: uid("session"), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), settings, conditions: createConditions(settings), currentConditionIndex: 0, status: "active", aiLog: { prompt: "", suggestion: "", disposition: "", reason: "" }, demo: false };
  paused = false;
  saveSession();
  showExperiment();
  renderAll();
}
function condition() { return session?.conditions?.[session.currentConditionIndex] || null; }
function currentBaselineMap(data = getAllConditions()) {
  const map = new Map();
  for (const c of data) if (c.type === "baseline" && Number.isFinite(c.thresholdDbfs)) map.set(c.probeFrequency, c.thresholdDbfs);
  return map;
}
function getAllConditions() { return session?.conditions || []; }
function getDataForDashboard() { return [...getAllConditions(), ...(demoData || [])]; }

function saveSession() {
  if (!session) return;
  session.updatedAt = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  els.saveStatus.textContent = `Saved ${new Date(session.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}
function loadSavedSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (validateSession(parsed)) { els.resume.hidden = false; els.resume.textContent = `Resume saved session (${parsed.conditions.length} conditions)`; }
  } catch (error) { console.warn("Could not load saved session", error); }
}
function validateSession(value) {
  return value && value.schemaVersion === SCHEMA_VERSION && typeof value.sessionId === "string" && Array.isArray(value.conditions) && value.conditions.every((c) => c && ["masked", "baseline"].includes(c.type) && Number.isFinite(c.probeFrequency) && Array.isArray(c.trials));
}
function resumeSession() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!validateSession(parsed)) throw new Error("This file is not a valid masking-curve session.");
    session = parsed;
    const next = session.conditions.findIndex((c) => !c.completed);
    if (next >= 0) session.currentConditionIndex = next;
    else session.status = "complete";
    showExperiment();
    saveSession();
    renderAll();
  } catch (error) { alert(error.message); }
}
function deleteSession() {
  if (!session || !confirm("Delete the current session and all saved measurements from this browser? This cannot be undone.")) return;
  stopAllAudio(); localStorage.removeItem(STORAGE_KEY); session = null; paused = false; els.experiment.hidden = true; els.resume.hidden = true; els.badge.textContent = "No active session"; els.badge.classList.remove("active"); els.saveStatus.textContent = "Not saved"; renderAll();
}
function showExperiment() { els.experiment.hidden = false; els.badge.textContent = "Active session"; els.badge.classList.add("active"); els.setup.scrollIntoView({ behavior: "smooth", block: "start" }); }

function ensureAudioContext() {
  if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
  if (audioContext.state === "suspended") return audioContext.resume();
  return Promise.resolve();
}
function createRampedTone(ctx, frequency, amplitude, startTime, duration, rampSeconds, masterGain) {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(frequency, startTime);
  const attackEnd = startTime + rampSeconds;
  const releaseStart = startTime + duration - rampSeconds;
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(amplitude, attackEnd);
  gain.gain.setValueAtTime(amplitude, releaseStart);
  gain.gain.linearRampToValueAtTime(0, startTime + duration);
  oscillator.connect(gain).connect(masterGain);
  oscillator.start(startTime);
  oscillator.stop(startTime + duration + 0.01);
  activeNodes.add(oscillator); activeNodes.add(gain);
  oscillator.addEventListener("ended", () => { activeNodes.delete(oscillator); activeNodes.delete(gain); try { gain.disconnect(); } catch (_) {} });
}
function playInterval(startTime, settings, maskerFrequency, probeFrequency, probeLevel, hasProbe) {
  const maskerAmp = maskerFrequency ? dbfsToAmplitude(settings.maskerLevelDbfs) : 0;
  const probeAmp = hasProbe ? dbfsToAmplitude(probeLevel) : 0;
  const master = audioContext.createGain();
  master.gain.value = calculateSafeMasterGain(maskerAmp, probeAmp);
  master.connect(audioContext.destination); activeNodes.add(master);
  const duration = settings.intervalMs / 1000; const ramp = Math.min(settings.rampMs / 1000, duration / 3);
  if (maskerFrequency) createRampedTone(audioContext, maskerFrequency, maskerAmp, startTime, duration, ramp, master);
  if (hasProbe) createRampedTone(audioContext, probeFrequency, probeAmp, startTime, duration, ramp, master);
  // Cleanup must wait until this interval's scheduled start plus its duration.
  // The second interval starts after the gap; cleaning up after only `duration`
  // would disconnect it before it ever reaches the destination.
  const cleanupDelay = Math.max(0, (startTime - audioContext.currentTime + duration + 0.1) * 1000);
  setTimeout(() => { try { master.disconnect(); } catch (_) {} activeNodes.delete(master); }, cleanupDelay);
}
async function playTwoIntervalTrial() {
  const c = condition(); if (!c || c.completed || trialLock || paused) return;
  await ensureAudioContext();
  trialLock = true; playbackFinished = false; els.play.disabled = true; els.i1.disabled = true; els.i2.disabled = true; els.stop.disabled = false; els.response.textContent = "Playing…"; els.response.className = "response-message";
  const targetInterval = Math.random() < 0.5 ? 1 : 2; const settings = session.settings; const start = audioContext.currentTime + .06; const interval = settings.intervalMs / 1000; const gap = settings.gapMs / 1000;
  playInterval(start, settings, c.maskerFrequency, c.probeFrequency, c.staircase.levelDbfs, targetInterval === 1);
  playInterval(start + interval + gap, settings, c.maskerFrequency, c.probeFrequency, c.staircase.levelDbfs, targetInterval === 2);
  c.pendingTargetInterval = targetInterval; c.pendingPresentedLevel = c.staircase.levelDbfs;
  window.setTimeout(() => { if (!trialLock) return; playbackFinished = true; els.i1.disabled = false; els.i2.disabled = false; els.stop.disabled = false; els.response.textContent = "Which interval contained the probe?"; }, settings.intervalMs * 2 + settings.gapMs + 80);
}
function stopAllAudio() { for (const node of [...activeNodes]) { try { if (typeof node.stop === "function") node.stop(); } catch (_) {} try { node.disconnect(); } catch (_) {} activeNodes.delete(node); } }
function stopPlayback() { stopAllAudio(); if (trialLock && playbackFinished === false) { trialLock = false; playbackFinished = false; els.play.disabled = false; els.i1.disabled = true; els.i2.disabled = true; els.stop.disabled = true; els.response.textContent = "Playback stopped. Press Play trial to try again."; } }

function submitResponse(chosenInterval) {
  const c = condition(); if (!c || !trialLock || !playbackFinished) return;
  const target = c.pendingTargetInterval; const presented = c.pendingPresentedLevel; const correct = chosenInterval === target; const result = scoreResponse(c.staircase, correct); const now = new Date().toISOString();
  c.staircase = result.state;
  c.trials.push({ sessionId: session.sessionId, timestamp: now, conditionType: c.type, maskerFrequency: c.maskerFrequency, maskerLevelDbfs: c.maskerLevelDbfs, probeFrequency: c.probeFrequency, presentedProbeLevelDbfs: presented, targetInterval: target, chosenInterval, correct, stepSize: result.stepSize, staircaseDirection: result.direction, reversal: result.reversal, reversalCount: c.staircase.reversalCount, trialNumber: c.staircase.trialCount });
  delete c.pendingTargetInterval; delete c.pendingPresentedLevel; trialLock = false; playbackFinished = false; stopAllAudio(); els.play.disabled = false; els.i1.disabled = true; els.i2.disabled = true; els.stop.disabled = true;
  if (c.staircase.complete || shouldStop(c.staircase, session.settings.maxTrials)) completeCondition(c);
  els.response.textContent = correct ? "Correct — next trial is ready." : "Incorrect — next trial is ready."; els.response.className = `response-message ${correct ? "good" : "bad"}`;
  saveSession(); renderAll();
  if (c.completed) window.setTimeout(advanceToNextCondition, 700);
}
function completeCondition(c) {
  c.completed = true; c.completedAt = new Date().toISOString(); c.stopReason = c.staircase.stopReason || (c.staircase.reversalCount >= MAX_REVERSALS ? "eight reversals" : "maximum trial limit"); c.completionStatus = c.staircase.reversalCount >= MAX_REVERSALS ? "completed" : "incomplete"; c.thresholdDbfs = estimateThreshold(c.staircase); c.accuracy = c.trials.length ? c.trials.filter((t) => t.correct).length / c.trials.length : null;
  if (session.conditions.every((item) => item.completed)) session.status = "complete";
}
function advanceToNextCondition() { if (!session) return; const next = session.conditions.findIndex((c) => !c.completed); if (next >= 0) session.currentConditionIndex = next; else session.status = "complete"; saveSession(); renderAll(); }
function restartCurrentCondition() {
  const c = condition(); if (!c || !confirm("Restart this condition? Its current trials will be removed from the session.")) return;
  stopAllAudio(); c.staircase = initializeStaircase(session.settings); c.trials = []; c.thresholdDbfs = null; c.completed = false; c.completionStatus = "not started"; c.stopReason = null; c.accuracy = null; delete c.pendingTargetInterval; delete c.pendingPresentedLevel; trialLock = false; paused = false; els.play.disabled = false; saveSession(); renderAll();
}
function abortRun() { if (!session || !confirm("Abort the current run? Raw trials will be kept and the condition will be marked incomplete.")) return; stopAllAudio(); const c = condition(); if (c) { c.staircase.complete = true; c.staircase.stopReason = "aborted by listener"; completeCondition(c); } paused = false; trialLock = false; saveSession(); renderAll(); }
function togglePause() { if (!paused && trialLock) stopPlayback(); paused = !paused; els.pause.textContent = paused ? "Resume" : "Pause"; els.instruction.textContent = paused ? "Paused. Resume when ready; no trial is playing." : "Press “Play trial” to hear two sequential intervals. In a masked condition, both contain the masker and one also contains the probe; the tones may blend into one sound."; updateButtons(); }

function conditionStatus(c) { return c.completionStatus === "DEMO" ? "DEMO" : c.completionStatus === "completed" ? "Completed" : c.completionStatus === "incomplete" ? "Incomplete" : c.trials.length ? "In progress" : "Not started"; }
function baselineFor(c, data = getAllConditions()) { return c.type === "baseline" ? null : currentBaselineMap(data).get(c.probeFrequency); }
function conditionRows(data = getAllConditions()) {
  return data.map((c) => ({ type: c.type, masker: c.maskerFrequency, maskerLevel: c.maskerLevelDbfs, probe: c.probeFrequency, threshold: c.thresholdDbfs, baseline: baselineFor(c, data), masking: calculateMasking(c.thresholdDbfs, baselineFor(c, data)), trials: c.trials.length, reversals: c.staircase.reversalCount, status: conditionStatus(c) }));
}
function renderAll() { renderCurrent(); renderProgress(); renderTables(); renderCharts(); renderAiLog(); updateButtons(); }
function renderCurrent() {
  const c = condition(); if (!session || !c) return;
  els.condition.textContent = c.type === "baseline" ? "No-masker baseline" : "Masked"; els.probe.textContent = `${c.probeFrequency} Hz`; els.masker.textContent = c.maskerFrequency ? `${c.maskerFrequency} Hz · ${c.maskerLevelDbfs} dBFS` : "None"; els.trialNo.textContent = c.staircase.trialCount; els.reversals.textContent = `${c.staircase.reversalCount} / ${MAX_REVERSALS}`; els.level.textContent = `${roundDisplay(c.staircase.levelDbfs)} dBFS`; els.conditionProgress.textContent = `${session.currentConditionIndex + 1} / ${session.conditions.length}`; els.trialProgress.style.width = `${Math.min(100, c.staircase.trialCount / session.settings.maxTrials * 100)}%`;
  if (c.completed) els.instruction.textContent = `${conditionStatus(c)}: ${c.thresholdDbfs === null ? "no valid threshold estimate" : `threshold ${roundDisplay(c.thresholdDbfs)} dBFS`}.`; else if (!paused) els.instruction.textContent = "Press “Play trial” to hear two sequential intervals. In a masked condition, both contain the masker and one also contains the probe; the tones may blend into one sound.";
  els.staircaseSubtitle.textContent = `Selected condition: ${c.type} · ${c.probeFrequency} Hz${c.maskerFrequency ? ` · masker ${c.maskerFrequency} Hz` : ""}`;
}
function renderProgress() { els.progressList.innerHTML = session ? session.conditions.map((c, i) => `<div class="progress-item ${i === session.currentConditionIndex ? "current" : ""} ${c.completed ? "done" : ""}"><span>${c.type === "baseline" ? "Baseline" : `${c.maskerFrequency} Hz`} · ${c.probeFrequency} Hz</span><span>${conditionStatus(c)}</span></div>`).join("") : "<p class='muted small'>Start a session to see condition progress.</p>"; }
function renderTables() {
  const data = getAllConditions(); const rows = conditionRows(data); els.summaryBody.innerHTML = rows.length ? rows.map((r) => `<tr><td>${r.type}</td><td>${r.masker ?? "—"}</td><td>${r.maskerLevel ?? "—"}</td><td>${r.probe}</td><td>${roundDisplay(r.threshold)}</td><td>${roundDisplay(r.baseline)}</td><td>${roundDisplay(r.masking)}</td><td>${r.trials}</td><td>${r.reversals}</td><td>${r.status}</td></tr>`).join("") : `<tr><td colspan="10" class="muted">No measurements yet. Start a session and collect data.</td></tr>`;
  const trials = getAllConditions().flatMap((c) => c.trials.map((t) => ({ ...t, type: c.type }))).slice().reverse(); els.rawBody.innerHTML = trials.length ? trials.map((t) => `<tr><td>${new Date(t.timestamp).toLocaleString()}</td><td>${t.type}</td><td>${t.maskerFrequency ?? "—"}</td><td>${t.probeFrequency}</td><td>${roundDisplay(t.presentedProbeLevelDbfs)}</td><td>${t.targetInterval}</td><td>${t.chosenInterval}</td><td>${t.correct ? "Yes" : "No"}</td><td>${t.stepSize}</td><td>${t.staircaseDirection === -1 ? "Down" : t.staircaseDirection === 1 ? "Up" : "—"}</td><td>${t.reversal ? "Yes" : "No"}</td></tr>`).join("") : `<tr><td colspan="11" class="muted">No raw trials yet.</td></tr>`;
}

function setupCanvas(canvas) { const rect = canvas.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1; const width = Math.max(500, rect.width || canvas.width); const height = Number(canvas.getAttribute("height")) || 400; canvas.width = width * dpr; canvas.height = height * dpr; const ctx = canvas.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); return { ctx, width, height }; }
function drawAxes(ctx, width, height, xMin, xMax, yMin, yMax, xLabel, yLabel, logX = true) {
  const pad = { left: 66, right: 24, top: 22, bottom: 52 }; const x = (value) => pad.left + (logX ? (Math.log10(value) - Math.log10(xMin)) / (Math.log10(xMax) - Math.log10(xMin)) : (value - xMin) / (xMax - xMin)) * (width - pad.left - pad.right); const y = (value) => height - pad.bottom - (value - yMin) / (yMax - yMin) * (height - pad.top - pad.bottom);
  ctx.clearRect(0, 0, width, height); ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, width, height); ctx.strokeStyle = "#dbe2e8"; ctx.lineWidth = 1; ctx.font = "11px system-ui"; ctx.fillStyle = "#687584";
  const xTicks = logX ? [100, 200, 500, 1000, 2000, 5000, 8000].filter((v) => v >= xMin && v <= xMax) : [0, 10, 20, 30, 40, 50, 60].filter((v) => v >= xMin && v <= xMax);
  for (const tick of xTicks) { const px = x(tick); ctx.beginPath(); ctx.moveTo(px, pad.top); ctx.lineTo(px, height - pad.bottom); ctx.stroke(); ctx.fillText(String(tick), px - 12, height - pad.bottom + 18); }
  const yStep = (yMax - yMin) > 60 ? 10 : 10; for (let tick = Math.ceil(yMin / yStep) * yStep; tick <= yMax; tick += yStep) { const py = y(tick); ctx.beginPath(); ctx.moveTo(pad.left, py); ctx.lineTo(width - pad.right, py); ctx.stroke(); ctx.fillText(`${tick}`, 12, py + 4); }
  ctx.strokeStyle = "#71808b"; ctx.beginPath(); ctx.moveTo(pad.left, pad.top); ctx.lineTo(pad.left, height - pad.bottom); ctx.lineTo(width - pad.right, height - pad.bottom); ctx.stroke(); ctx.fillStyle = "#34434e"; ctx.font = "600 12px system-ui"; ctx.fillText(xLabel, width / 2 - 50, height - 13); ctx.save(); ctx.translate(16, height / 2 + 45); ctx.rotate(-Math.PI / 2); ctx.fillText(yLabel, 0, 0); ctx.restore(); return { x, y, pad };
}
function drawEmpty(ctx, width, height, message) { ctx.fillStyle = "#687584"; ctx.font = "14px system-ui"; ctx.textAlign = "center"; ctx.fillText(message, width / 2, height / 2); ctx.textAlign = "start"; }
function drawCurveChart(canvas, mode) {
  const { ctx, width, height } = setupCanvas(canvas);
  const measured = getAllConditions();
  // Keep demo data out of measured plots whenever a saved session is present.
  const data = measured.length ? measured : (demoData || []);
  const completed = data.filter((c) => c.type === "masked" && Number.isFinite(c.thresholdDbfs));
  const xs = completed.map((c) => c.probeFrequency);
  const xMin = Math.max(20, Math.min(...(xs.length ? xs : [100])) * .8);
  const xMax = Math.min(8000, Math.max(...(xs.length ? xs : [8000])) * 1.2);
  const yValues = mode === "masked" ? completed.map((c) => c.thresholdDbfs) : completed.map((c) => calculateMasking(c.thresholdDbfs, baselineFor(c, data))).filter(Number.isFinite);
  const yValueMax = yValues.length ? Math.max(...yValues) : 10;
  let yMin = mode === "masked" ? Math.min(-80, ...(yValues.length ? yValues : [-80])) : Math.min(-10, ...(yValues.length ? yValues : [0]));
  let yMax = mode === "masked" ? Math.max(-5, ...(yValues.length ? yValues : [-5])) : Math.max(10, yValueMax * 1.15);
  if (!Number.isFinite(yMin) || !Number.isFinite(yMax) || yMin === yMax) { yMin = -80; yMax = -5; }
  const axes = drawAxes(ctx, width, height, xMin, xMax, yMin, yMax, "Probe frequency (Hz)", mode === "masked" ? "Threshold (dBFS)" : "Masking amount (dB)");
  if (!completed.length || (mode === "masking" && !yValues.length)) { drawEmpty(ctx, width, height, mode === "masked" ? "Complete masked conditions to display measured thresholds" : "Matching baseline measurements are needed"); return; }
  const groups = new Map(); completed.forEach((c) => { const key = c.type === "baseline" ? "baseline" : c.maskerFrequency; if (!groups.has(key)) groups.set(key, []); const value = mode === "masked" ? c.thresholdDbfs : calculateMasking(c.thresholdDbfs, baselineFor(c, data)); if (mode === "masked" || Number.isFinite(value)) groups.get(key).push({ x: c.probeFrequency, y: value }); });
  let colorIndex = 0; for (const [key, points] of groups) { if (!points.length) continue; points.sort((a, b) => a.x - b.x); const color = key === "baseline" ? "#687584" : COLORS[colorIndex++ % COLORS.length]; ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2; ctx.beginPath(); points.forEach((point, index) => { const px = axes.x(point.x), py = axes.y(point.y); if (index === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); }); ctx.stroke(); for (const point of points) { ctx.beginPath(); ctx.arc(axes.x(point.x), axes.y(point.y), 4, 0, Math.PI * 2); ctx.fill(); } if (mode === "masked" && key !== "baseline") { const px = axes.x(Number(key)); ctx.save(); ctx.setLineDash([5, 4]); ctx.strokeStyle = color; ctx.globalAlpha = .55; ctx.beginPath(); ctx.moveTo(px, axes.pad.top); ctx.lineTo(px, height - axes.pad.bottom); ctx.stroke(); ctx.restore(); } ctx.font = "600 11px system-ui"; ctx.fillText(key === "baseline" ? "Baseline" : `${key} Hz masker`, 76 + (colorIndex - 1) * 110, 17); }
}
function drawStaircase() { const { ctx, width, height } = setupCanvas(els.staircaseChart); const c = condition(); const trialData = c?.trials || []; const axes = drawAxes(ctx, width, height, 0, Math.max(10, session?.settings.maxTrials || 60), -80, -5, "Trial number", "Probe level (dBFS)", false); if (!trialData.length) { drawEmpty(ctx, width, height, "Run a condition to display its staircase"); return; } ctx.strokeStyle = "#087f86"; ctx.fillStyle = "#087f86"; ctx.lineWidth = 2; ctx.beginPath(); trialData.forEach((t, i) => { const px = axes.x(t.trialNumber), py = axes.y(t.presentedProbeLevelDbfs); if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); }); ctx.stroke(); for (const t of trialData) { const px = axes.x(t.trialNumber), py = axes.y(t.presentedProbeLevelDbfs); ctx.fillStyle = t.reversal ? "#ca6a32" : "#087f86"; ctx.beginPath(); ctx.arc(px, py, t.reversal ? 5 : 3, 0, Math.PI * 2); ctx.fill(); } }
function renderCharts() { drawCurveChart(els.maskedChart, "masked"); drawCurveChart(els.maskingChart, "masking"); drawStaircase(); els.demoNotice.hidden = !demoData; els.clearDemo.hidden = !demoData; }
function renderAiLog() { const log = session?.aiLog; if (log) { els.aiPrompt.value = log.prompt || ""; els.aiSuggestion.value = log.suggestion || ""; els.aiDisposition.value = log.disposition || ""; els.aiReason.value = log.reason || ""; } }
function updateButtons() { const active = Boolean(session); const c = condition(); els.pause.disabled = !active || !c || c.completed; els.restart.disabled = !active || !c; els.abort.disabled = !active || !c || c.completed; els.play.disabled = !active || !c || c.completed || paused || trialLock; els.exportJson.disabled = !active; els.exportTrials.disabled = !active; els.exportSummary.disabled = !active; }

function csvEscape(value) { const text = value === null || value === undefined ? "" : String(value); return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
function download(filename, content, type = "text/plain") { const blob = new Blob([content], { type }); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 500); }
function downloadBlob(filename, blob) { const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 500); }
function exportTrials() { if (!session) return; const rows = getAllConditions().flatMap((c) => c.trials); const headers = ["sessionId", "timestamp", "conditionType", "maskerFrequency", "maskerLevelDbfs", "probeFrequency", "presentedProbeLevelDbfs", "targetInterval", "chosenInterval", "correct", "stepSize", "staircaseDirection", "reversal", "reversalCount", "trialNumber"]; download("masking-trials.csv", [headers, ...rows.map((row) => headers.map((h) => row[h]))].map((row) => row.map(csvEscape).join(",")).join("\n"), "text/csv"); }
function exportSummary() { if (!session) return; const headers = ["type", "maskerFrequency", "maskerLevelDbfs", "probeFrequency", "thresholdDbfs", "baselineThresholdDbfs", "maskingAmountDb", "trials", "reversals", "status"]; const rows = conditionRows(getAllConditions()).map((r) => [r.type, r.masker, r.maskerLevel, r.probe, r.threshold, r.baseline, r.masking, r.trials, r.reversals, r.status]); download("masking-threshold-summary.csv", [headers, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n"), "text/csv"); }
function exportJson() { if (session) download(`${session.sessionId}.json`, JSON.stringify(session, null, 2), "application/json"); }
function importJson() { els.importInput.click(); }
function processImport(file) { const reader = new FileReader(); reader.onload = () => { try { const imported = JSON.parse(reader.result); if (!validateSession(imported)) throw new Error("Invalid backup: expected a version 1 masking-curve session."); if (session && !confirm("Replace the current session with this backup?")) return; session = imported; saveSession(); showExperiment(); renderAll(); } catch (error) { alert(error.message); } }; reader.readAsText(file); }
function exportCanvas(id) { const canvas = $(id); canvas.toBlob((blob) => { if (blob) downloadBlob(`${id}.png`, blob); else alert("PNG export failed. Please try again after the chart redraws."); }, "image/png"); }
function loadDemo() { demoData = []; const settings = { maskerFrequencies: [500, 1000, 2000], maskerLevelDbfs: -35 }; for (const masker of settings.maskerFrequencies) for (const ratio of DEFAULT_RATIOS) { const probe = Math.round(masker * ratio); const separation = Math.abs(Math.log2(ratio)); const threshold = -57 + 25 * Math.exp(-(separation * separation) / .18) + (ratio > 1 ? 3 : 0); demoData.push({ type: "masked", maskerFrequency: masker, maskerLevelDbfs: -35, probeFrequency: probe, thresholdDbfs: threshold, trials: Array(40).fill({}), staircase: { reversalCount: 8 }, completed: true, completionStatus: "DEMO" }); } renderAll(); }
function removeDemo() { demoData = null; renderAll(); }
function saveAiLog() { if (!session) { alert("Start or resume a session before saving the AI log."); return; } session.aiLog = { prompt: els.aiPrompt.value, suggestion: els.aiSuggestion.value, disposition: els.aiDisposition.value, reason: els.aiReason.value }; saveSession(); els.aiStatus.textContent = "AI log saved with the session."; setTimeout(() => els.aiStatus.textContent = "", 2500); }

function runDeveloperTests() {
  const tests = []; const test = (name, condition) => { tests.push(`${condition ? "PASS" : "FAIL"}  ${name}`); return condition; }; const testSettings = { startLevelDbfs: -25, minLevelDbfs: -80, maxLevelDbfs: -10, maxTrials: 60 }; const a0 = dbfsToAmplitude(0), a20 = dbfsToAmplitude(-20);
  test("0 dBFS converts to amplitude 1", a0 === 1); test("-20 dBFS is approximately 0.1", Math.abs(a20 - .1) < 1e-12); const safe = calculateSafeMasterGain(dbfsToAmplitude(-10), dbfsToAmplitude(-10)); test("safe combined peak remains below 1", (dbfsToAmplitude(-10) * 2 * safe) < 1);
  let s = initializeStaircase(testSettings); let r = scoreResponse(s, true); test("one correct response does not move level", r.direction === null && r.state.levelDbfs === -25); r = scoreResponse(r.state, true); test("two correct responses cause a downward step", r.direction === -1 && r.state.levelDbfs === -29); r = scoreResponse(r.state, false); test("one incorrect response causes an upward step", r.direction === 1 && r.state.levelDbfs === -25 && r.reversal); test("first movement is not a reversal", !scoreResponse(initializeStaircase(testSettings), false).reversal); test("threshold stays null before eight reversals", estimateThreshold(r.state) === null);
  const complete = initializeStaircase(testSettings); complete.reversalLevels = [-40, -42, -44, -43, -45, -46, -44, -47]; complete.reversalCount = 8; const expected = (-44 - 43 - 45 - 46 - 44 - 47) / 6; test("threshold uses exactly the last six reversal levels", Math.abs(estimateThreshold(complete) - expected) < 1e-12); test("masking subtraction handles negative dBFS", calculateMasking(-38, -55) === 17); test("schema version is explicit", SCHEMA_VERSION === 1);
  els.testOutput.textContent = tests.join("\n"); const passed = tests.filter((line) => line.startsWith("PASS")).length; els.testSummary.textContent = `${passed}/${tests.length} pure-function checks passed.`;
}

els.headphoneCheck.addEventListener("change", () => { els.start.disabled = !els.headphoneCheck.checked; });
els.headphoneButton.addEventListener("click", async () => { await ensureAudioContext(); stopAllAudio(); const master = audioContext.createGain(); master.gain.value = calculateSafeMasterGain(dbfsToAmplitude(-45)); master.connect(audioContext.destination); createRampedTone(audioContext, 440, dbfsToAmplitude(-45), audioContext.currentTime + .02, .6, .02, master); els.headphoneCheck.focus(); });
els.start.addEventListener("click", () => { if (session && !confirm("Start a new session and replace the currently saved session?")) return; newSession(); });
els.resume.addEventListener("click", resumeSession); els.newSession.addEventListener("click", () => { if (!session || confirm("Start a new session and replace the current session?")) newSession(); });
els.play.addEventListener("click", playTwoIntervalTrial); els.stop.addEventListener("click", stopPlayback); els.i1.addEventListener("click", () => submitResponse(1)); els.i2.addEventListener("click", () => submitResponse(2));
document.addEventListener("keydown", (event) => { if (event.key === "1" && !els.i1.disabled) submitResponse(1); if (event.key === "2" && !els.i2.disabled) submitResponse(2); });
els.pause.addEventListener("click", togglePause); els.restart.addEventListener("click", restartCurrentCondition); els.abort.addEventListener("click", abortRun); els.demo.addEventListener("click", loadDemo); els.clearDemo.addEventListener("click", removeDemo); els.deleteSession.addEventListener("click", deleteSession); els.exportJson.addEventListener("click", exportJson); els.importJson.addEventListener("click", importJson); els.importInput.addEventListener("change", () => { if (els.importInput.files[0]) processImport(els.importInput.files[0]); els.importInput.value = ""; }); els.exportTrials.addEventListener("click", exportTrials); els.exportSummary.addEventListener("click", exportSummary); els.saveAiLog.addEventListener("click", saveAiLog); els.runTests.addEventListener("click", runDeveloperTests); document.querySelectorAll("[data-export-chart]").forEach((button) => button.addEventListener("click", () => exportCanvas(button.dataset.exportChart)));
window.addEventListener("resize", () => renderCharts()); window.addEventListener("beforeunload", () => { stopAllAudio(); if (session) saveSession(); });
loadSavedSession(); renderAll();
