"use strict";

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const uploadView = $("upload-view");
const progressView = $("progress-view");
const resultView = $("result-view");
const errorBox = $("error-box");
const dropzone = $("dropzone");
const fileInput = $("file-input");
const tracksEl = $("tracks");
const playBtn = $("play-btn");

// ---------- 状態 ----------
let audioCtx = null;
let tracks = []; // {name,label,color,isOriginal,chans:[Float32Array],buffer,gainNode,source,muted,solo,volume,...}
let sampleRate = 44100;
let lengthSamples = 0;
let isPlaying = false;
let playOffset = 0; // 秒
let playStartCtxTime = 0;
let rafId = null;
let baseFilename = "audio";

// エディタ状態
let selection = null; // {start, end} 秒
let activeTrackIdx = -1;
let clipboard = null; // {start(サンプル), length, chans: [Float32Array], sourceLabel} 単一トラックの内容
let undoStack = [];
let redoStack = [];
const UNDO_LIMIT = 8;
let editorBusy = false;
const FADE_SAMPLES = 441; // 編集境界のクリックノイズ防止フェード (10ms @44.1kHz)

const duration = () => lengthSamples / sampleRate;

// ============================================================
// アップロード
// ============================================================
dropzone.addEventListener("click", () => fileInput.click());
$("browse-btn").addEventListener("click", (e) => { e.stopPropagation(); fileInput.click(); });
fileInput.addEventListener("change", () => { if (fileInput.files.length) startJob(fileInput.files[0]); });

["dragover", "dragenter"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("dragover"); })
);
["dragleave", "drop"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("dragover"); })
);
dropzone.addEventListener("drop", (e) => {
  if (e.dataTransfer.files.length) startJob(e.dataTransfer.files[0]);
});

async function startJob(file) {
  hideError();
  const quality = document.querySelector('input[name="quality"]:checked').value;
  const mode = document.querySelector('input[name="mode"]:checked').value;
  uploadView.classList.add("hidden");
  progressView.classList.remove("hidden");
  $("progress-filename").textContent = file.name;
  $("progress-message").textContent = "アップロード中...";
  baseFilename = file.name.replace(/\.[^.]+$/, "");

  const form = new FormData();
  form.append("file", file);
  form.append("mode", mode);
  form.append("quality", quality);

  try {
    const res = await fetch("/api/jobs", { method: "POST", body: form });
    if (!res.ok) throw new Error("アップロードに失敗しました (" + res.status + ")");
    const { id } = await res.json();
    pollJob(id, file.name);
  } catch (err) {
    showError(err.message);
    resetToUpload();
  }
}

async function pollJob(id, filename) {
  try {
    const res = await fetch("/api/jobs/" + id);
    if (!res.ok) throw new Error("ジョブ情報の取得に失敗しました");
    const job = await res.json();

    $("progress-message").textContent = job.message || "";
    $("progress-percent").textContent = (job.progress || 0) + "%";
    $("progress-bar").style.width = (job.progress || 0) + "%";

    if (job.status === "error") throw new Error(job.message);
    if (job.status === "done") {
      $("progress-message").textContent = "音声データを読み込み中...";
      await showResult(job, filename);
      return;
    }
    setTimeout(() => pollJob(id, filename), 800);
  } catch (err) {
    showError(err.message);
    resetToUpload();
  }
}

// ============================================================
// 結果表示
// ============================================================
async function showResult(job, filename) {
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();

  const defs = [
    ...job.stems.map((s) => ({ ...s, defaultMuted: false, isOriginal: false })),
    { name: "original", label: "元音源", color: "#94a3b8", url: job.original_url, defaultMuted: true, isOriginal: true },
  ];

  const buffers = await Promise.all(
    defs.map(async (d) => {
      const res = await fetch(d.url);
      const buf = await res.arrayBuffer();
      return audioCtx.decodeAudioData(buf);
    })
  );

  sampleRate = buffers[0].sampleRate;
  lengthSamples = Math.max(...buffers.map((b) => b.length));
  tracks = defs.map((d, i) => makeTrack(d, buffers[i]));

  progressView.classList.add("hidden");
  resultView.classList.remove("hidden");
  $("result-filename").textContent = filename;
  $("time-total").textContent = fmtTime(duration());
  $("time-current").textContent = fmtTime(0);
  updateToolbar();
  updateZipBtn();

  requestAnimationFrame(() => refreshAll());
}

function bufToChans(buffer) {
  const chans = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const src = buffer.getChannelData(c);
    const arr = new Float32Array(lengthSamples);
    arr.set(src.subarray(0, Math.min(src.length, lengthSamples)));
    chans.push(arr);
  }
  if (chans.length === 1) chans.push(new Float32Array(chans[0])); // mono→stereo
  return chans;
}

function makeTrack(def, bufferOrChans) {
  const track = {
    ...def,
    chans: null,
    buffer: null,
    muted: def.defaultMuted,
    solo: false,
    volume: 1,
    source: null,
    gainNode: audioCtx.createGain(),
  };
  track.chans = Array.isArray(bufferOrChans) ? bufferOrChans : bufToChans(bufferOrChans);
  track.gainNode.connect(audioCtx.destination);

  const el = document.createElement("div");
  el.className = "track";
  el.innerHTML = `
    <div class="track-side">
      <div class="track-title">
        <span class="track-dot" style="color:${def.color};background:${def.color}"></span>
        <span>${def.label}</span>
      </div>
      <div class="track-controls">
        <button class="ms-btn btn-m" title="ミュート">M</button>
        <button class="ms-btn btn-s" title="ソロ">S</button>
        <input type="range" class="vol-slider" min="0" max="1.5" step="0.01" value="1" title="音量">
        <label class="exp-chk" title="「選択ステム保存」の対象に含める"><input type="checkbox" class="exp-input"${def.isOriginal ? "" : " checked"}>💾</label>
        <button class="dl-btn" title="このステムをWAV保存 (編集内容を含む)">⬇</button>
        ${def.isOriginal ? "" : '<button class="dl-btn del-btn" title="トラックを削除">✕</button>'}
      </div>
    </div>
    <div class="track-wave">
      <canvas></canvas>
      <div class="selection-overlay hidden"></div>
      <div class="playhead" style="left:0"></div>
    </div>`;
  tracksEl.appendChild(el);

  track.el = el;
  track.waveEl = el.querySelector(".track-wave");
  track.canvas = el.querySelector("canvas");
  track.playheadEl = el.querySelector(".playhead");
  track.selectionEl = el.querySelector(".selection-overlay");
  track.btnM = el.querySelector(".btn-m");
  track.btnS = el.querySelector(".btn-s");

  track.btnM.addEventListener("click", () => { track.muted = !track.muted; applyGains(); });
  track.btnS.addEventListener("click", () => { track.solo = !track.solo; applyGains(); });
  el.querySelector(".vol-slider").addEventListener("input", (e) => {
    track.volume = parseFloat(e.target.value);
    applyGains();
  });
  track.exportChecked = !def.isOriginal;
  el.querySelector(".exp-input").addEventListener("change", (e) => {
    track.exportChecked = e.target.checked;
    updateZipBtn();
  });
  el.querySelector(".dl-btn").addEventListener("click", () => downloadTrack(track));
  const delBtn = el.querySelector(".del-btn");
  if (delBtn) delBtn.addEventListener("click", () => deleteTrack(track));

  // ラベルのダブルクリックでリネーム
  track.labelEl = el.querySelector(".track-title span:last-child");
  track.labelEl.title = "ダブルクリックで名前を変更";
  track.labelEl.addEventListener("dblclick", () => renameTrack(track));

  attachSelectionHandlers(track);
  if (track.muted) syncTrackUI(track);
  return track;
}

// ============================================================
// トラック管理 (追加・リネーム・削除)
// ============================================================
const TRACK_PALETTE = ["#f87171", "#22d3ee", "#a3e635", "#e879f9", "#fdba74", "#93c5fd"];
let customTrackCount = 0;

function addTrack() {
  if (!tracks.length || editorBusy) return;
  customTrackCount++;
  const def = {
    name: `custom${customTrackCount}`,
    label: `新規トラック ${customTrackCount}`,
    color: TRACK_PALETTE[(customTrackCount - 1) % TRACK_PALETTE.length],
    defaultMuted: false,
    isOriginal: false,
    custom: true,
  };
  const chans = [new Float32Array(lengthSamples), new Float32Array(lengthSamples)];
  const track = makeTrack(def, chans);
  // 元音源トラックの上に配置する
  const orig = tracks.find((t) => t.isOriginal);
  if (orig) {
    tracksEl.insertBefore(track.el, orig.el);
    tracks.splice(tracks.indexOf(orig), 0, track);
  } else {
    tracks.push(track);
  }
  // トラック構成の変更で取り消し履歴は無効になる
  undoStack = [];
  redoStack = [];
  setActiveTrack(tracks.indexOf(track));
  layoutTrackCanvas(track);
  refreshAll();
  updateToolbar();
  updateZipBtn();
  flashInfo(`「${track.label}」を追加しました — 移動・貼り付け先に使えます (取り消し履歴はリセット)`);
}

function renameTrack(track) {
  const input = document.createElement("input");
  input.type = "text";
  input.value = track.label;
  input.className = "rename-input";
  input.maxLength = 30;
  track.labelEl.replaceWith(input);
  input.focus();
  input.select();
  const commit = () => {
    const v = input.value.trim();
    if (v) track.label = v;
    track.labelEl.textContent = track.label;
    input.replaceWith(track.labelEl);
    renderSelection();
    updateToolbar();
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") input.blur();
    if (e.key === "Escape") { input.value = track.label; input.blur(); }
  });
}

function deleteTrack(track) {
  if (editorBusy) return;
  if (tracks.filter((t) => !t.isOriginal).length <= 1) { showError("最後のステムトラックは削除できません"); return; }
  if (!confirm(`トラック「${track.label}」を削除しますか？\n(取り消し履歴もリセットされます)`)) return;
  if (isPlaying) pause();
  try { track.gainNode.disconnect(); } catch (e) {}
  track.el.remove();
  tracks.splice(tracks.indexOf(track), 1);
  if (clipboard && clipboard.sourceLabel === track.label) clipboard = null;
  undoStack = [];
  redoStack = [];
  activeTrackIdx = -1;
  tracks.forEach((t) => t.el.classList.remove("active-track"));
  clearSelection();
  refreshAll();
  updateToolbar();
  updateZipBtn();
}

// ============================================================
// 波形描画
// ============================================================
function computePeaks(track, width) {
  const chans = track.chans;
  const spp = lengthSamples / width;
  const peaks = new Float32Array(width * 2);
  for (let x = 0; x < width; x++) {
    let min = 0, max = 0;
    const s0 = Math.floor(x * spp);
    const s1 = Math.min(Math.floor((x + 1) * spp), lengthSamples);
    const step = Math.max(1, Math.floor((s1 - s0) / 200));
    for (const ch of chans) {
      for (let s = s0; s < s1; s += step) {
        const v = ch[s];
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    peaks[x * 2] = min;
    peaks[x * 2 + 1] = max;
  }
  return peaks;
}

function layoutTrackCanvas(track) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = track.waveEl.clientWidth;
  const h = track.waveEl.clientHeight;
  track.canvas.width = Math.round(w * dpr);
  track.canvas.height = Math.round(h * dpr);
  const peaks = computePeaks(track, track.canvas.width);

  const off = document.createElement("canvas");
  off.width = track.canvas.width;
  off.height = track.canvas.height;
  const ctx = off.getContext("2d");
  const H = off.height, mid = H / 2;
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, track.color);
  grad.addColorStop(0.5, shade(track.color, 1.25));
  grad.addColorStop(1, track.color);
  ctx.fillStyle = grad;
  for (let x = 0; x < off.width; x++) {
    const min = peaks[x * 2], max = peaks[x * 2 + 1];
    const y0 = mid + min * mid * 0.92;
    const y1 = mid + max * mid * 0.92;
    ctx.fillRect(x, Math.min(y0, y1), 1, Math.max(1, Math.abs(y1 - y0)));
  }
  ctx.fillStyle = "rgba(255,255,255,0.10)";
  ctx.fillRect(0, mid - 0.5, off.width, 1);
  track.baseCanvas = off;
}

function shade(hex, factor) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.round(((n >> 16) & 255) * factor));
  const g = Math.min(255, Math.round(((n >> 8) & 255) * factor));
  const b = Math.min(255, Math.round((n & 255) * factor));
  return `rgb(${r},${g},${b})`;
}

function drawTrack(track, timeSec) {
  const ctx = track.canvas.getContext("2d");
  const W = track.canvas.width, H = track.canvas.height;
  ctx.clearRect(0, 0, W, H);
  const playedX = Math.round((timeSec / duration()) * W);
  ctx.globalAlpha = 0.38;
  ctx.drawImage(track.baseCanvas, 0, 0);
  if (playedX > 0) {
    ctx.globalAlpha = 1;
    ctx.drawImage(track.baseCanvas, 0, 0, playedX, H, 0, 0, playedX, H);
  }
  ctx.globalAlpha = 1;
  track.playheadEl.style.left = (timeSec / duration()) * 100 + "%";
}

function refreshAll() {
  tracks.forEach((t) => layoutTrackCanvas(t));
  $("time-total").textContent = fmtTime(duration());
  renderSelection();
  render();
}

// ============================================================
// 再生制御
// ============================================================
function currentTime() {
  return isPlaying ? Math.min(playOffset + audioCtx.currentTime - playStartCtxTime, duration()) : playOffset;
}

function applyGains() {
  const anySolo = tracks.some((t) => t.solo);
  tracks.forEach((t) => {
    const silent = t.muted || (anySolo && !t.solo);
    t.gainNode.gain.setTargetAtTime(silent ? 0 : t.volume, audioCtx.currentTime, 0.01);
    syncTrackUI(t, silent);
  });
}

function syncTrackUI(track, silent) {
  if (silent === undefined) silent = track.muted;
  track.btnM.classList.toggle("active-m", track.muted);
  track.btnS.classList.toggle("active-s", track.solo);
  track.el.classList.toggle("inactive", silent);
}

function trackBuffer(track) {
  if (!track.buffer || track.buffer.length !== lengthSamples) {
    const buf = audioCtx.createBuffer(track.chans.length, Math.max(lengthSamples, 1), sampleRate);
    track.chans.forEach((ch, i) => buf.copyToChannel(ch, i));
    track.buffer = buf;
  }
  return track.buffer;
}

function invalidateBuffers() {
  tracks.forEach((t) => { t.buffer = null; });
}

function startSources(offset) {
  tracks.forEach((t) => {
    const src = audioCtx.createBufferSource();
    src.buffer = trackBuffer(t);
    src.connect(t.gainNode);
    if (offset < duration()) src.start(0, offset);
    t.source = src;
  });
}

function stopSources() {
  tracks.forEach((t) => {
    if (t.source) { try { t.source.stop(); } catch (e) {} t.source = null; }
  });
}

async function play() {
  if (editorBusy) return;
  if (audioCtx.state === "suspended") await audioCtx.resume();
  if (playOffset >= duration() - 0.01) playOffset = 0;
  startSources(playOffset);
  playStartCtxTime = audioCtx.currentTime;
  isPlaying = true;
  playBtn.textContent = "⏸";
  applyGains();
  tick();
}

function pause() {
  playOffset = currentTime();
  stopSources();
  isPlaying = false;
  playBtn.textContent = "▶";
  cancelAnimationFrame(rafId);
  render();
}

function seek(t) {
  t = Math.max(0, Math.min(t, duration()));
  if (isPlaying) {
    stopSources();
    playOffset = t;
    startSources(t);
    playStartCtxTime = audioCtx.currentTime;
  } else {
    playOffset = t;
    render();
  }
}

function tick() {
  render();
  if (currentTime() >= duration()) { pause(); playOffset = 0; render(); return; }
  if (isPlaying) rafId = requestAnimationFrame(tick);
}

function render() {
  const t = currentTime();
  $("time-current").textContent = fmtTime(t);
  tracks.forEach((tr) => drawTrack(tr, t));
}

playBtn.addEventListener("click", () => (isPlaying ? pause() : play()));
$("new-btn").addEventListener("click", () => location.reload());

// ============================================================
// 範囲選択
// ============================================================
function attachSelectionHandlers(track) {
  track.waveEl.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const rect = track.waveEl.getBoundingClientRect();
    const t0 = ((e.clientX - rect.left) / rect.width) * duration();
    let moved = false;

    setActiveTrack(tracks.indexOf(track));

    const onMove = (ev) => {
      const t1 = clamp(((ev.clientX - rect.left) / rect.width) * duration(), 0, duration());
      if (Math.abs(ev.clientX - e.clientX) > 4) moved = true;
      if (moved) {
        selection = { start: Math.min(t0, t1), end: Math.max(t0, t1) };
        renderSelection();
        updateToolbar();
      }
    };
    const onUp = (ev) => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      if (!moved) {
        selection = null;
        renderSelection();
        updateToolbar();
        seek(clamp(t0, 0, duration()));
      }
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

function setActiveTrack(idx) {
  activeTrackIdx = idx;
  tracks.forEach((t, i) => t.el.classList.toggle("active-track", i === idx));
  renderSelection();
  updateToolbar();
}

function renderSelection() {
  tracks.forEach((t) => {
    if (!selection) { t.selectionEl.classList.add("hidden"); return; }
    t.selectionEl.classList.remove("hidden");
    t.selectionEl.style.left = (selection.start / duration()) * 100 + "%";
    t.selectionEl.style.width = ((selection.end - selection.start) / duration()) * 100 + "%";
  });
  const info = $("selection-info");
  if (selection) {
    const label = activeTrackIdx >= 0 ? tracks[activeTrackIdx].label : "-";
    info.textContent = `選択: ${fmtTime(selection.start)} 〜 ${fmtTime(selection.end)} (${(selection.end - selection.start).toFixed(2)}秒) / 対象: ${label}`;
  } else if (activeTrackIdx >= 0) {
    info.textContent = `編集対象: ${tracks[activeTrackIdx].label}` + (clipboard ? ` ／ クリップボード: ${clipboard.sourceLabel} ${(clipboard.length / sampleRate).toFixed(2)}秒` : "");
  } else {
    info.textContent = "";
  }
}

function clearSelection() {
  selection = null;
  renderSelection();
  updateToolbar();
}

// ============================================================
// 編集操作
// ============================================================
function pushUndo() {
  undoStack.push(snapshot());
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack = [];
  updateToolbar();
}

function snapshot() {
  return {
    lengthSamples,
    tracks: tracks.map((t) => t.chans.map((c) => new Float32Array(c))),
  };
}

function restore(snap) {
  lengthSamples = snap.lengthSamples;
  tracks.forEach((t, i) => { t.chans = snap.tracks[i].map((c) => new Float32Array(c)); });
  invalidateBuffers();
  if (isPlaying) pause();
  playOffset = Math.min(playOffset, duration());
  clearSelection();
  refreshAll();
}

function undo() {
  if (!undoStack.length || editorBusy) return;
  redoStack.push(snapshot());
  restore(undoStack.pop());
  updateToolbar();
}

function redo() {
  if (!redoStack.length || editorBusy) return;
  undoStack.push(snapshot());
  restore(redoStack.pop());
  updateToolbar();
}

function selSamples() {
  if (!selection) return null;
  const s = Math.floor(selection.start * sampleRate);
  const e = Math.min(Math.ceil(selection.end * sampleRate), lengthSamples);
  return e - s > 0 ? [s, e] : null;
}

function fadeZero(chans, s, e) {
  // [s,e) を無音化。境界に短いフェードを入れてクリックノイズを防ぐ
  const f = Math.min(FADE_SAMPLES, Math.floor((e - s) / 2));
  chans.forEach((c) => {
    for (let i = 0; i < f; i++) {
      c[s + i] *= 1 - (i + 1) / f;      // 先頭: フェードアウト (1→0)
      c[e - 1 - i] *= 1 - (i + 1) / f;  // 末尾: フェードイン (0→1) ※逆順で適用
    }
    c.fill(0, s + f, e - f);
  });
}

function fadeEdges(clipChans) {
  // クリップの端に短いフェードを入れて貼り付け時のクリックノイズを防ぐ
  const len = clipChans[0].length;
  const f = Math.min(FADE_SAMPLES, Math.floor(len / 2));
  clipChans.forEach((c) => {
    for (let i = 0; i < f; i++) {
      const g = (i + 1) / f;
      c[i] *= g;
      c[len - 1 - i] *= g;
    }
  });
}

function grabSelection() {
  // 選択範囲 (アクティブトラック) をクリップボードへ
  const se = selSamples();
  if (!se || activeTrackIdx < 0) return null;
  const [s, e] = se;
  const t = tracks[activeTrackIdx];
  const chans = t.chans.map((c) => c.slice(s, e));
  fadeEdges(chans);
  clipboard = {
    start: s,
    length: e - s,
    chans,
    sourceLabel: t.label,
  };
  return [s, e];
}

function doCut() {
  if (editorBusy) return;
  if (activeTrackIdx < 0) { showError("対象トラックの波形をドラッグして選択してください"); return; }
  if (isPlaying) pause();
  pushUndo();
  const se = grabSelection();
  if (!se) { undoStack.pop(); return; }
  const [s, e] = se;
  fadeZero(tracks[activeTrackIdx].chans, s, e);
  invalidateBuffers();
  refreshAll();
  updateToolbar();
  flashInfo(`${clipboard.sourceLabel} から ${(clipboard.length / sampleRate).toFixed(2)}秒 を切り取りました — 貼り付け先のトラックをクリックして Ctrl+V`);
}

function doCopy() {
  if (activeTrackIdx < 0) { showError("対象トラックの波形をドラッグして選択してください"); return; }
  if (!grabSelection()) return;
  updateToolbar();
  flashInfo(`${clipboard.sourceLabel} から ${(clipboard.length / sampleRate).toFixed(2)}秒 をコピーしました`);
}

function doPaste() {
  if (!clipboard || editorBusy) return;
  if (activeTrackIdx < 0) { showError("貼り付け先のトラックをクリックして選択してください"); return; }
  if (isPlaying) pause();
  pushUndo();
  mixInto(tracks[activeTrackIdx], clipboard);
  const s = Math.min(clipboard.start, Math.max(lengthSamples - 1, 0));
  const e = Math.min(clipboard.start + clipboard.length, lengthSamples);
  invalidateBuffers();
  selection = { start: s / sampleRate, end: e / sampleRate };
  renderSelection();
  refreshAll();
  updateToolbar();
  flashInfo(`${tracks[activeTrackIdx].label} へ同じ時間位置 (${fmtTime(s / sampleRate)}〜) にミックスしました`);
}

function mixInto(track, clip) {
  // クリップ内容を元と同じ時間位置に加算合成する (尺は変えない)
  const s = Math.min(clip.start, Math.max(lengthSamples - 1, 0));
  const n = Math.min(clip.length, lengthSamples - s);
  if (n <= 0) return;
  track.chans.forEach((c, ci) => {
    const src = clip.chans[Math.min(ci, clip.chans.length - 1)];
    for (let i = 0; i < n; i++) c[s + i] += src[i];
  });
}

function doMove(targetIdx) {
  if (editorBusy || targetIdx < 0 || targetIdx === activeTrackIdx) return;
  if (activeTrackIdx < 0) { showError("移動元トラックの波形をドラッグして選択してください"); return; }
  const se = selSamples();
  if (!se) return;
  if (isPlaying) pause();
  pushUndo();
  const [s, e] = se;
  const src = tracks[activeTrackIdx];
  const clipChans = src.chans.map((c) => c.slice(s, e));
  fadeEdges(clipChans);
  const clip = { start: s, length: e - s, chans: clipChans };
  fadeZero(src.chans, s, e);
  mixInto(tracks[targetIdx], clip);
  invalidateBuffers();
  refreshAll();
  updateToolbar();
  flashInfo(`${src.label} → ${tracks[targetIdx].label} へ ${(clip.length / sampleRate).toFixed(2)}秒 を移動しました`);
}

function doRippleDelete() {
  const se = selSamples();
  if (!se || editorBusy) return;
  const [s, e] = se;
  if (e - s >= lengthSamples) { showError("全体を削除することはできません"); return; }
  if (isPlaying) pause();
  pushUndo();
  tracks.forEach((t) => {
    t.chans = t.chans.map((c) => {
      const out = new Float32Array(lengthSamples - (e - s));
      out.set(c.subarray(0, s), 0);
      out.set(c.subarray(e), s);
      return out;
    });
  });
  lengthSamples -= e - s;
  invalidateBuffers();
  playOffset = Math.min(s / sampleRate, duration());
  clearSelection();
  refreshAll();
  flashInfo(`全トラックから ${((e - s) / sampleRate).toFixed(2)}秒 を削除して詰めました`);
}

function doSilence() {
  const se = selSamples();
  if (!se || editorBusy) return;
  if (activeTrackIdx < 0) { showError("無音化するトラックを選択してください (波形をドラッグしたトラックが対象)"); return; }
  const [s, e] = se;
  if (isPlaying) pause();
  pushUndo();
  fadeZero(tracks[activeTrackIdx].chans, s, e);
  invalidateBuffers();
  refreshAll();
  flashInfo(`${tracks[activeTrackIdx].label} の ${((e - s) / sampleRate).toFixed(2)}秒 を除去しました (尺・クリップボードは不変)`);
}

// ---------- 無音カット ----------
function doSilenceCut(thresholdDb, minLenSec, padSec) {
  if (editorBusy) return;
  const thr = Math.pow(10, thresholdDb / 20);
  const win = 1024;
  const minLen = Math.floor(minLenSec * sampleRate);
  const pad = Math.floor(padSec * sampleRate);

  // 元音源トラックがあればそれで判定、なければ全ステムの最大振幅
  const source = tracks.find((t) => t.isOriginal) || null;
  const judgeTracks = source ? [source] : tracks;

  // 窓ごとの最大振幅
  const nWin = Math.ceil(lengthSamples / win);
  const env = new Float32Array(nWin);
  for (const t of judgeTracks) {
    for (const c of t.chans) {
      for (let w = 0; w < nWin; w++) {
        let m = env[w];
        const s0 = w * win, s1 = Math.min(s0 + win, lengthSamples);
        for (let s = s0; s < s1; s += 4) {
          const v = Math.abs(c[s]);
          if (v > m) m = v;
        }
        env[w] = m;
      }
    }
  }

  // 無音区間の検出
  const regions = [];
  let start = -1;
  for (let w = 0; w <= nWin; w++) {
    const silent = w < nWin && env[w] < thr;
    if (silent && start < 0) start = w * win;
    if (!silent && start >= 0) {
      let s = start + pad;
      let e = Math.min(w * win, lengthSamples) - pad;
      if (e - s >= minLen) regions.push([s, e]);
      start = -1;
    }
  }

  if (!regions.length) { showError("条件に合う無音区間が見つかりませんでした"); return; }

  const total = regions.reduce((a, [s, e]) => a + (e - s), 0);
  if (total >= lengthSamples) { showError("全体が無音と判定されました。しきい値を下げてください"); return; }

  if (isPlaying) pause();
  pushUndo();
  // 後ろから順に削除
  for (let i = regions.length - 1; i >= 0; i--) {
    const [s, e] = regions[i];
    tracks.forEach((t) => {
      t.chans = t.chans.map((c) => {
        const out = new Float32Array(c.length - (e - s));
        out.set(c.subarray(0, s), 0);
        out.set(c.subarray(e), s);
        return out;
      });
    });
    lengthSamples -= e - s;
  }
  invalidateBuffers();
  playOffset = 0;
  clearSelection();
  refreshAll();
  flashInfo(`${regions.length}箇所 / 合計 ${(total / sampleRate).toFixed(2)}秒 の無音を削除しました`);
}

// ---------- ノイズ除去 ----------
async function doDenoise(scope, strength) {
  const se = selSamples();
  if (!se) { showError("先にノイズだけが鳴っている区間をドラッグで選択してください"); return; }
  if (editorBusy) return;

  let targets;
  if (scope === "all") {
    targets = tracks.filter((t) => !t.isOriginal);
  } else {
    if (activeTrackIdx < 0) { showError("対象トラックを選択してください"); return; }
    targets = [tracks[activeTrackIdx]];
  }

  if (isPlaying) pause();
  editorBusy = true;
  updateToolbar();
  pushUndo();

  try {
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      flashInfo(`ノイズ除去中 (${t.label})... ${i + 1}/${targets.length}`);
      const wav = encodeWav(t.chans, sampleRate);
      const form = new FormData();
      form.append("file", new Blob([wav], { type: "audio/wav" }), "track.wav");
      form.append("noise_start", String(selection.start));
      form.append("noise_end", String(selection.end));
      form.append("strength", String(strength));
      const res = await fetch("/api/denoise", { method: "POST", body: form });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail.detail || "ノイズ除去に失敗しました");
      }
      const buf = await audioCtx.decodeAudioData(await res.arrayBuffer());
      const chans = [];
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const arr = new Float32Array(lengthSamples);
        arr.set(buf.getChannelData(c).subarray(0, Math.min(buf.length, lengthSamples)));
        chans.push(arr);
      }
      if (chans.length === 1) chans.push(new Float32Array(chans[0]));
      t.chans = chans;
    }
    invalidateBuffers();
    refreshAll();
    flashInfo("ノイズ除去が完了しました");
  } catch (err) {
    showError(err.message);
    // 失敗時は undo で戻せる状態を維持
  } finally {
    editorBusy = false;
    updateToolbar();
  }
}

// ---------- 修復・エフェクト ----------
const REPAIR_NOTES = {
  declick: "短いインパルス性ノイズ (マウスクリック音・リップノイズ・プチ音) を検出して補間します",
  dereverb: "AIモデル (MelBand Roformer, SDR 19.17) で響き・残響を除去します。初回はモデルのダウンロード (約800MB) に時間がかかります",
  dehum: "電源由来のブーンというノイズ (50/60Hzと倍音) をノッチフィルタで除去します",
  fadein: "選択範囲の音量を 0 から徐々に上げます",
  fadeout: "選択範囲の音量を徐々に 0 へ下げます",
  normalize: "選択範囲のピークが -1dB になるよう音量を揃えます",
  loudnorm: "トラック全体を配信プラットフォームの基準ラウドネス (LUFS) に合わせます。範囲選択は不要です (ITU-R BS.1770準拠、クリップ防止付き)",
};

function applyClientEffect(track, s, e, effect) {
  const n = e - s;
  if (effect === "fadein") {
    track.chans.forEach((c) => { for (let i = 0; i < n; i++) c[s + i] *= i / n; });
  } else if (effect === "fadeout") {
    track.chans.forEach((c) => { for (let i = 0; i < n; i++) c[s + i] *= 1 - i / n; });
  } else if (effect === "normalize") {
    let peak = 0;
    track.chans.forEach((c) => { for (let i = s; i < e; i++) peak = Math.max(peak, Math.abs(c[i])); });
    if (peak < 1e-6) return false;
    const g = Math.pow(10, -1 / 20) / peak;
    track.chans.forEach((c) => { for (let i = s; i < e; i++) c[i] *= g; });
  }
  return true;
}

async function applyLoudnorm() {
  if (activeTrackIdx < 0) { showError("対象トラックをクリックして選択してください"); return; }
  if (editorBusy) return;
  const track = tracks[activeTrackIdx];
  const platform = $("rp-platform").value;
  const target = platform === "custom" ? parseFloat($("rp-lufs").value) : parseFloat(platform);
  if (isNaN(target)) { showError("目標LUFSが不正です"); return; }
  if (isPlaying) pause();

  editorBusy = true;
  updateToolbar();
  pushUndo();
  try {
    flashInfo(`${track.label} のラウドネスを測定・調整中...`);
    const form = new FormData();
    form.append("file", new Blob([encodeWav(track.chans, sampleRate)], { type: "audio/wav" }), "track.wav");
    form.append("effect", "loudnorm");
    form.append("target_lufs", String(target));
    const res = await fetch("/api/effect", { method: "POST", body: form });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(detail.detail || "ラウドネス調整に失敗しました");
    }
    const measured = res.headers.get("X-Measured-LUFS");
    const gainDb = res.headers.get("X-Applied-Gain-DB");
    const buf = await audioCtx.decodeAudioData(await res.arrayBuffer());
    const chans = [];
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const arr = new Float32Array(lengthSamples);
      arr.set(buf.getChannelData(c).subarray(0, Math.min(buf.length, lengthSamples)));
      chans.push(arr);
    }
    if (chans.length === 1) chans.push(new Float32Array(chans[0]));
    track.chans = chans;
    invalidateBuffers();
    refreshAll();
    flashInfo(`${track.label}: ${measured} LUFS → 目標 ${target} LUFS (ゲイン ${gainDb > 0 ? "+" : ""}${gainDb}dB)`);
  } catch (err) {
    showError(err.message);
  } finally {
    editorBusy = false;
    updateToolbar();
  }
}

async function applyRepair() {
  const effect = $("rp-effect").value;
  if (effect === "loudnorm") return applyLoudnorm();

  const se = selSamples();
  if (!se) { showError("先に修復したい範囲をドラッグで選択してください"); return; }
  if (activeTrackIdx < 0) { showError("対象トラックの波形をドラッグして選択してください"); return; }
  if (editorBusy) return;

  const mix = parseFloat($("rp-mix").value);
  const track = tracks[activeTrackIdx];
  const [s, e] = se;
  if (isPlaying) pause();

  // クライアントサイドで完結するエフェクト
  if (effect === "fadein" || effect === "fadeout" || effect === "normalize") {
    pushUndo();
    applyClientEffect(track, s, e, effect);
    invalidateBuffers();
    refreshAll();
    flashInfo(`${track.label} に ${$("rp-effect").selectedOptions[0].textContent} を適用しました`);
    return;
  }

  // サーバー処理 (前後にコンテキストを付けて送り、選択範囲だけ書き戻す)
  editorBusy = true;
  updateToolbar();
  pushUndo();
  try {
    const ctx = Math.floor(1.5 * sampleRate);
    const cs = Math.max(0, s - ctx);
    const ce = Math.min(lengthSamples, e + ctx);
    const clip = track.chans.map((c) => c.slice(cs, ce));

    const form = new FormData();
    form.append("file", new Blob([encodeWav(clip, sampleRate)], { type: "audio/wav" }), "clip.wav");
    form.append("effect", effect);
    form.append("sensitivity", $("rp-sensitivity").value);
    form.append("base_freq", $("rp-humfreq").value);

    flashInfo(effect === "dereverb"
      ? "リバーブ除去中... (初回はモデルのダウンロードで数分かかることがあります)"
      : "処理中...");
    const res = await fetch("/api/effect", { method: "POST", body: form });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(detail.detail || "修復処理に失敗しました");
    }
    const buf = await audioCtx.decodeAudioData(await res.arrayBuffer());

    const off = s - cs;
    const n = e - s;
    const f = Math.min(FADE_SAMPLES, Math.floor(n / 2));
    track.chans.forEach((c, ci) => {
      const p = buf.getChannelData(Math.min(ci, buf.numberOfChannels - 1));
      for (let i = 0; i < n; i++) {
        let g = mix;
        if (i < f) g *= (i + 1) / f;
        if (i >= n - f) g *= (n - i) / f;
        c[s + i] = c[s + i] * (1 - g) + p[off + i] * g;
      }
    });
    invalidateBuffers();
    refreshAll();
    flashInfo(`${track.label} の ${(n / sampleRate).toFixed(2)}秒 を修復しました`);
  } catch (err) {
    showError(err.message);
  } finally {
    editorBusy = false;
    updateToolbar();
  }
}

// ============================================================
// ツールバー
// ============================================================
function updateToolbar() {
  const hasSel = !!selection;
  const hasTarget = activeTrackIdx >= 0;
  $("tool-cut").disabled = !hasSel || !hasTarget || editorBusy;
  $("tool-copy").disabled = !hasSel || !hasTarget || editorBusy;
  $("tool-paste").disabled = !clipboard || !hasTarget || editorBusy;
  $("tool-silence").disabled = !hasSel || !hasTarget || editorBusy;
  $("tool-ripple").disabled = !hasSel || editorBusy;
  $("tool-deselect").disabled = !hasSel;
  $("tool-silence-cut").disabled = editorBusy;
  $("tool-denoise").disabled = editorBusy;
  $("tool-repair").disabled = editorBusy;
  $("tool-addtrack").disabled = editorBusy;
  $("tool-undo").disabled = !undoStack.length || editorBusy;
  $("tool-redo").disabled = !redoStack.length || editorBusy;
  updateMoveSelect();
}

function updateMoveSelect() {
  const sel = $("tool-move");
  const hasSel = !!selection && activeTrackIdx >= 0 && !editorBusy;
  sel.disabled = !hasSel;
  let html = '<option value="">➜ 移動先…</option>';
  if (hasSel) {
    tracks.forEach((t, i) => {
      if (i === activeTrackIdx || t.isOriginal) return;
      html += `<option value="${i}">➜ ${t.label} へ移動</option>`;
    });
  }
  if (sel.innerHTML !== html) sel.innerHTML = html;
}

$("tool-cut").addEventListener("click", doCut);
$("tool-copy").addEventListener("click", doCopy);
$("tool-paste").addEventListener("click", doPaste);
$("tool-silence").addEventListener("click", doSilence);
$("tool-ripple").addEventListener("click", doRippleDelete);
$("tool-deselect").addEventListener("click", clearSelection);
$("tool-undo").addEventListener("click", undo);
$("tool-redo").addEventListener("click", redo);
$("tool-move").addEventListener("change", (e) => {
  const idx = parseInt(e.target.value, 10);
  e.target.value = "";
  if (!isNaN(idx)) doMove(idx);
});

function togglePanel(id) {
  ["panel-silence-cut", "panel-denoise", "panel-repair"].forEach((p) => {
    if (p === id) $(p).classList.toggle("hidden");
    else $(p).classList.add("hidden");
  });
}
$("tool-silence-cut").addEventListener("click", () => togglePanel("panel-silence-cut"));
$("tool-denoise").addEventListener("click", () => togglePanel("panel-denoise"));
$("tool-repair").addEventListener("click", () => togglePanel("panel-repair"));
$("tool-addtrack").addEventListener("click", addTrack);

$("rp-effect").addEventListener("change", () => {
  const v = $("rp-effect").value;
  $("rp-sens-row").classList.toggle("hidden", v !== "declick");
  $("rp-hum-row").classList.toggle("hidden", v !== "dehum");
  $("rp-mix-row").classList.toggle("hidden", !["declick", "dereverb", "dehum"].includes(v));
  $("rp-platform-row").classList.toggle("hidden", v !== "loudnorm");
  $("rp-lufs-row").classList.toggle("hidden", v !== "loudnorm" || $("rp-platform").value !== "custom");
  $("rp-note").textContent = REPAIR_NOTES[v] || "";
});
$("rp-platform").addEventListener("change", () => {
  const custom = $("rp-platform").value === "custom";
  $("rp-lufs-row").classList.toggle("hidden", !custom);
  if (!custom) $("rp-lufs").value = $("rp-platform").value;
});
$("rp-sensitivity").addEventListener("input", (e) => {
  $("rp-sens-val").textContent = Math.round(parseFloat(e.target.value) * 100) + "%";
});
$("rp-mix").addEventListener("input", (e) => {
  $("rp-mix-val").textContent = Math.round(parseFloat(e.target.value) * 100) + "%";
});
$("rp-run").addEventListener("click", applyRepair);
document.querySelectorAll(".panel-close").forEach((b) =>
  b.addEventListener("click", (e) => e.target.closest(".panel").classList.add("hidden"))
);

$("sc-run").addEventListener("click", () => {
  const thr = parseFloat($("sc-threshold").value);
  const minLen = parseFloat($("sc-minlen").value);
  const pad = parseFloat($("sc-pad").value);
  if (isNaN(thr) || isNaN(minLen) || isNaN(pad)) return;
  doSilenceCut(thr, minLen, pad);
});

$("dn-strength").addEventListener("input", (e) => {
  $("dn-strength-val").textContent = Math.round(parseFloat(e.target.value) * 100) + "%";
});
$("dn-run").addEventListener("click", () => {
  doDenoise($("dn-scope").value, parseFloat($("dn-strength").value));
});

// ============================================================
// キーボードショートカット
// ============================================================
document.addEventListener("keydown", (e) => {
  if (resultView.classList.contains("hidden")) return;
  const tag = e.target.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;

  if (e.code === "Space") {
    e.preventDefault();
    isPlaying ? pause() : play();
  } else if (e.ctrlKey && e.code === "KeyZ") {
    e.preventDefault(); undo();
  } else if (e.ctrlKey && (e.code === "KeyY" || (e.shiftKey && e.code === "KeyZ"))) {
    e.preventDefault(); redo();
  } else if (e.ctrlKey && e.code === "KeyX") {
    e.preventDefault(); doCut();
  } else if (e.ctrlKey && e.code === "KeyC") {
    e.preventDefault(); doCopy();
  } else if (e.ctrlKey && e.code === "KeyV") {
    e.preventDefault(); doPaste();
  } else if ((e.code === "Delete" || e.code === "Backspace") && e.shiftKey) {
    e.preventDefault(); doRippleDelete();
  } else if (e.code === "Delete" || e.code === "Backspace") {
    e.preventDefault(); doSilence();
  } else if (e.code === "Escape") {
    clearSelection();
    document.querySelectorAll(".panel").forEach((p) => p.classList.add("hidden"));
  }
});

// ============================================================
// 書き出し (編集内容を反映したクライアントサイドエンコード)
// ============================================================
function encodeWav(chans, sr) {
  const nCh = chans.length;
  const n = chans[0].length;
  const bytesPerSample = 2;
  const dataSize = n * nCh * bytesPerSample;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const wstr = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  wstr(0, "RIFF"); v.setUint32(4, 36 + dataSize, true); wstr(8, "WAVE");
  wstr(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, nCh, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * nCh * bytesPerSample, true);
  v.setUint16(32, nCh * bytesPerSample, true); v.setUint16(34, 16, true);
  wstr(36, "data"); v.setUint32(40, dataSize, true);
  let o = 44;
  for (let s = 0; s < n; s++) {
    for (let c = 0; c < nCh; c++) {
      const x = Math.max(-1, Math.min(1, chans[c][s]));
      v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true);
      o += 2;
    }
  }
  return new Uint8Array(buf);
}

function downloadTrack(track) {
  const wav = encodeWav(track.chans, sampleRate);
  const url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${baseFilename}_${track.label}.wav`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function updateZipBtn() {
  const n = tracks.filter((t) => t.exportChecked).length;
  const btn = $("zip-btn");
  btn.textContent = `⬇ 選択ステム保存 (${n})`;
  btn.disabled = n === 0;
  btn.title = n === 1 ? "チェックした1ステムをWAVで保存" : "チェックしたステムをZIPで一括保存 (💾で選択)";
}

$("zip-btn").addEventListener("click", () => {
  const targets = tracks.filter((t) => t.exportChecked);
  if (!targets.length) return;
  if (targets.length === 1) { downloadTrack(targets[0]); return; }
  const files = targets.map((t) => ({ name: `${baseFilename}_${t.label}.wav`, data: encodeWav(t.chans, sampleRate) }));
  const zip = makeZip(files);
  const url = URL.createObjectURL(new Blob([zip], { type: "application/zip" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${baseFilename}_stems.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});

// ---------- 最小ZIPライター (無圧縮 + UTF-8ファイル名) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeZip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const local = new ArrayBuffer(30);
    const v = new DataView(local);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true);
    v.setUint16(6, 0x0800, true); // UTF-8 フラグ
    v.setUint16(8, 0, true); // 無圧縮
    v.setUint32(14, crc, true);
    v.setUint32(18, f.data.length, true);
    v.setUint32(22, f.data.length, true);
    v.setUint16(26, name.length, true);

    const c = new ArrayBuffer(46);
    const cv = new DataView(c);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, f.data.length, true);
    cv.setUint32(24, f.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.push(new Uint8Array(c), name);

    parts.push(new Uint8Array(local), name, f.data);
    offset += 30 + name.length + f.data.length;
  }

  let centralSize = 0;
  central.forEach((p) => (centralSize += p.length));
  const end = new ArrayBuffer(22);
  const ev = new DataView(end);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const totalSize = offset + centralSize + 22;
  const out = new Uint8Array(totalSize);
  let pos = 0;
  for (const p of [...parts, ...central, new Uint8Array(end)]) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

// ============================================================
// util
// ============================================================
let resizeTimer = null;
window.addEventListener("resize", () => {
  if (resultView.classList.contains("hidden")) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => refreshAll(), 150);
});

function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1).padStart(4, "0");
  return `${m}:${s}`;
}

let flashTimer = null;
function flashInfo(msg) {
  const info = $("selection-info");
  info.textContent = msg;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => renderSelection(), 4000);
}

function showError(msg) {
  errorBox.textContent = "⚠ " + msg;
  errorBox.classList.remove("hidden");
  clearTimeout(showError._t);
  showError._t = setTimeout(hideError, 6000);
}
function hideError() { errorBox.classList.add("hidden"); }
function resetToUpload() {
  progressView.classList.add("hidden");
  uploadView.classList.remove("hidden");
  fileInput.value = "";
}
