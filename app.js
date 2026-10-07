"use strict";

const CONFIG = {
  // Your Cloudflare Worker URL (search proxy only)
  SEARCH_PROXY: "https://karaoke.iffatadibamusaffa.workers.dev/",
  SEARCH_SUFFIX: "instrumental",
  LRCLIB: "https://lrclib.net/api/search",
};

const $ = (id) => document.getElementById(id);
const els = {
  form: $("search-form"),
  query: $("query"),
  instr: $("instr"),
  status: $("status"),
  seek: $("seek"),
  timeNow: $("time-now"),
  timeTotal: $("time-total"),
  back: $("btn-back"),
  play: $("btn-play"),
  fwd: $("btn-fwd"),
  mute: $("btn-mute"),
  vol: $("vol"),
  volValue: $("vol-value"),
  volumeNote: $("volume-note"),
  delayValue: $("delay-value"),
  delayReset: $("delay-reset"),
  lengthNote: $("length-note"),
  results: $("results"),
  linkForm: $("link-form"),
  link: $("link"),
  lyricsMeta: $("lyrics-meta"),
  lyricsSelect: $("lyrics-select"),
  lyricsForm: $("lyrics-form"),
  lyricsTrack: $("lyrics-track"),
  lyricsArtist: $("lyrics-artist"),
  lyrics: $("lyrics"),
};

const state = {
  videoId: null,
  results: [],
  resultIndex: -1,
  candidates: [],
  current: null,
  synced: false,
  lines: [],
  lineEls: [],
  activeIdx: -1,
  delay: 0,
  dragging: false,
  instrumental: true, // was the current search an instrumental search?
  volume: 100,
  lastVolume: 100,
};

/* ---------------------------- helpers ---------------------------- */

function setStatus(msg, isError = false) {
  els.status.textContent = msg || "";
  els.status.classList.toggle("error", !!isError);
}

function fmt(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function decodeEntities(s) {
  const t = document.createElement("textarea");
  t.innerHTML = s;
  return t.value;
}

function extractVideoId(input) {
  const s = input.trim();
  const m = s.match(/(?:v=|youtu\.be\/|embed\/|shorts\/|live\/)([\w-]{11})/);
  if (m) return m[1];
  return /^[\w-]{11}$/.test(s) ? s : null;
}

function store(key, value) { try { localStorage.setItem(key, value); } catch (_) {} }
function load(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }

/* --------------------------- title cleaning ---------------------------- */
/* text-cleaning-start */

// Empty brackets left behind after a word was removed, e.g. "Song ()"
const EMPTY_BRACKETS_RE = /[\(\[\{（【]\s*[\)\]\}）】]/g;

// Tidy a string: drop empty brackets, collapse spaces, trim stray separators
function tidy(s) {
  return s
    .replace(EMPTY_BRACKETS_RE, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s\-–—|:~]+|[\s\-–—|:~]+$/g, "")
    .trim();
}

// Removes only "instrumental" / "karaoke", including the whole bracket they sit in:
// "Song (Instrumental)" -> "Song", "Song [Karaoke Version]" -> "Song"
function stripInstrumental(s) {
  return tidy(
    String(s || "")
      .replace(/[\(\[\{（【][^\)\]\}）】]*\b(?:instrumental|karaoke)\b[^\)\]\}）】]*[\)\]\}）】]/gi, " ")
      .replace(/\b(?:instrumental|karaoke)\b/gi, " ")
  );
}

// Removes all the usual video-title noise (brackets with tags, bare tag words)
function stripNoise(s) {
  return tidy(
    String(s || "")
      .replace(/[\(\[\{（【][^\)\]\}）】]*\b(?:karaoke|instrumental|backing|lyrics?|official|audio|video|hd|hq|4k|no vocals?|vocals?|cover|remaster\w*|version|sing[- ]?along|minus one)\b[^\)\]\}）】]*[\)\]\}）】]/gi, " ")
      .replace(/\b(?:karaoke|instrumental|backing track|sing[- ]?along|no vocals?|with lyrics|lyrics|official (?:music )?video|official audio|hd|hq|4k)\b/gi, " ")
  );
}

function extractTrackArtist(rawTitle, channelName) {
  let s = rawTitle || "";
  let artist = "";

  const perf = s.match(/[\(\[]?\s*(?:originally\s+)?(?:performed|made famous|popularized|sung)\s+by\s+([^\)\]\-|]+)[\)\]]?/i);
  if (perf) { artist = perf[1].trim(); s = s.replace(perf[0], " "); }

  // Clean first (this also trims stray separators), then split "Artist - Song"
  s = stripNoise(s);

  if (!artist) {
    const parts = s.split(/\s[-–—|~]\s/);
    if (parts.length >= 2) {
      artist = parts[0].trim();
      s = parts.slice(1).join(" ").trim();
    } else if (channelName) {
      artist = channelName.replace(/\s*-\s*Topic$|VEVO$/i, "").trim();
    }
  }

  return { track: tidy(s), artist: artist };
}
/* text-cleaning-end */

/* ------------------------ YouTube IFrame player ------------------ */

let ytPlayer = null;
let ytReadyResolve;
const ytReady = new Promise((resolve) => { ytReadyResolve = resolve; });

window.onYouTubeIframeAPIReady = () => {
  ytPlayer = new YT.Player("yt-player", {
    width: "100%",
    height: "100%",
    playerVars: { controls: 0, disablekb: 1, rel: 0, playsinline: 1, modestbranding: 1 },
    events: {
      onReady: (e) => { ytReadyResolve(); e.target.setVolume(state.volume); },
      onStateChange: onPlayerState,
      onError: onPlayerError,
    },
  });
};

function injectYouTubeApi() {
  const s = document.createElement("script");
  s.src = "https://www.youtube.com/iframe_api";
  document.head.appendChild(s);
}

function onPlayerState(e) {
  els.play.innerHTML = e.data === 1 ? "&#10074;&#10074;" : "&#9654;"; // 1 = playing
}

// Codes: 2 invalid id, 5 HTML5 error, 100 not found/private,
// 101 and 150 = embedding blocked (owner setting, age/region/licensing),
// 153 = player config / referrer problem.
function onPlayerError(e) {
  const code = e.data;
  const reason =
    code === 101 || code === 150 ? "it can't be embedded here"
    : code === 153 ? "the player couldn't verify this site"
    : code === 100 ? "video not found or private"
    : "it can't be played here";
  const next = state.resultIndex + 1;
  if (next < state.results.length) {
    setStatus(`Skipped a result (${reason}). Trying the next one...`, true);
    loadVideo(next);
  } else {
    const id = state.videoId;
    setStatus(`Can't play this one (${reason}). Try another search or open it on YouTube: https://www.youtube.com/watch?v=${id}`, true);
  }
}

function playerTime() {
  return ytPlayer && ytPlayer.getCurrentTime ? ytPlayer.getCurrentTime() || 0 : 0;
}
function playerDuration() {
  return ytPlayer && ytPlayer.getDuration ? ytPlayer.getDuration() || 0 : 0;
}
function isPlaying() {
  return ytPlayer && ytPlayer.getPlayerState && ytPlayer.getPlayerState() === 1;
}

/* ------------------------------ volume --------------------------- */

// iPhones/iPads ignore setVolume on embedded YouTube; hardware buttons only.
const IS_IOS =
  /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

function volumeIcon(v) {
  if (v === 0) return "\u{1F507}";  // muted
  if (v < 40) return "\u{1F508}";   // low
  if (v < 75) return "\u{1F509}";   // medium
  return "\u{1F50A}";               // high
}

function applyVolume() {
  if (!ytPlayer || !ytPlayer.setVolume) return;
  ytPlayer.setVolume(state.volume);
  if (state.volume > 0 && ytPlayer.isMuted && ytPlayer.isMuted()) ytPlayer.unMute();
}

function renderVolume() {
  els.vol.value = String(state.volume);
  els.volValue.textContent = String(state.volume);
  els.mute.textContent = volumeIcon(state.volume);
}

function setVolume(v) {
  state.volume = Math.max(0, Math.min(100, Math.round(v)));
  if (state.volume > 0) state.lastVolume = state.volume;
  store("karaoke:volume", String(state.volume));
  renderVolume();
  applyVolume();
}

els.vol.addEventListener("input", () => setVolume(Number(els.vol.value)));
els.mute.addEventListener("click", () => {
  setVolume(state.volume > 0 ? 0 : state.lastVolume || 60);
});

(function initVolume() {
  const saved = parseInt(load("karaoke:volume"), 10);
  state.volume = isFinite(saved) ? Math.max(0, Math.min(100, saved)) : 100;
  state.lastVolume = state.volume || 100;
  renderVolume();
  if (IS_IOS) {
    els.vol.disabled = true;
    els.mute.disabled = true;
    els.volValue.textContent = "";
    els.volumeNote.hidden = false;
  }
})();

/* ----------------------------- lyrics ---------------------------- */

function parseLRC(text) {
  const out = [];
  const tagRe = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  for (const raw of text.split(/\r?\n/)) {
    const times = [];
    let last = 0;
    let m;
    tagRe.lastIndex = 0;
    while ((m = tagRe.exec(raw))) {
      const frac = m[3] ? parseInt(m[3], 10) / Math.pow(10, m[3].length) : 0;
      times.push(parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + frac);
      last = tagRe.lastIndex;
    }
    if (!times.length) continue;
    const line = raw.slice(last).trim();
    for (const t of times) out.push({ t, text: line });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

async function searchLyrics(track, artist) {
  let data = [];
  if (artist) {
    const url = `${CONFIG.LRCLIB}?track_name=${encodeURIComponent(track)}&artist_name=${encodeURIComponent(artist)}`;
    const res = await fetch(url);
    if (res.ok) {
      data = await res.json();
      if (!Array.isArray(data)) data = [];
    }
  }

  if (!data.length) {
    const qStr = artist ? `${track} ${artist}` : track;
    const url = `${CONFIG.LRCLIB}?q=${encodeURIComponent(qStr)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Lyrics search failed (${res.status})`);
    data = await res.json();
    if (!Array.isArray(data)) data = [];
  }

  return data
    .filter((d) => !d.instrumental && (d.syncedLyrics || d.plainLyrics))
    .sort((a, b) => (b.syncedLyrics ? 1 : 0) - (a.syncedLyrics ? 1 : 0));
}

function fillCandidateSelect() {
  els.lyricsSelect.innerHTML = "";
  state.candidates.forEach((c, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    const album = c.albumName ? ` · ${c.albumName}` : "";
    const kind = c.syncedLyrics ? "Synced" : "Plain text";
    opt.textContent = `${c.trackName} - ${c.artistName}${album} · ${fmt(c.duration)} · ${kind}`;
    els.lyricsSelect.appendChild(opt);
  });
  els.lyricsSelect.hidden = state.candidates.length < 2;
}

function showPlaceholder(msg) {
  els.lyrics.innerHTML = "";
  const p = document.createElement("div");
  p.className = "placeholder";
  p.textContent = msg;
  els.lyrics.appendChild(p);
  state.lines = [];
  state.lineEls = [];
  state.activeIdx = -1;
  state.synced = false;
  els.lyrics.classList.remove("plain");
}

function applyLyrics(candidate) {
  state.current = candidate;
  state.synced = !!candidate.syncedLyrics;
  state.lines = state.synced
    ? parseLRC(candidate.syncedLyrics)
    : candidate.plainLyrics.split(/\r?\n/).map((text) => ({ t: null, text: text.trim() }));
  state.activeIdx = -1;
  els.lyricsMeta.textContent = `LRCLIB \u00B7 ${state.synced ? "Synced" : "Plain"} \u00B7 ${candidate.trackName} - ${candidate.artistName}`;
  els.lyrics.classList.toggle("plain", !state.synced);

  els.lyrics.innerHTML = "";
  state.lineEls = state.lines.map((ln) => {
    const d = document.createElement("div");
    d.className = "line" + (ln.text ? "" : " empty");
    d.textContent = ln.text || (state.synced ? "\u266A" : "\u00A0");
    if (state.synced) d.addEventListener("click", () => seekTo(ln.t + state.delay));
    els.lyrics.appendChild(d);
    return d;
  });
  els.lyrics.scrollTop = 0;
  loadDelay();
}

/* ---------------------------- search ----------------------------- */

async function searchYouTube(q) {
  if (!CONFIG.SEARCH_PROXY) throw new Error("Missing Cloudflare Worker URL in CONFIG.");

  const res = await fetch(`${CONFIG.SEARCH_PROXY}?q=${encodeURIComponent(q)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.error && data.error.message) || `YouTube search failed (${res.status})`);

  return (data.items || [])
    .filter((i) => i.id && i.id.videoId)
    .map((i) => ({
      videoId: i.id.videoId,
      title: decodeEntities(i.snippet.title),
      channel: decodeEntities(i.snippet.channelTitle || ""),
      thumb: (i.snippet.thumbnails && (i.snippet.thumbnails.high || i.snippet.thumbnails.medium) || {}).url || "",
    }));
}

function renderResults() {
  const prevScroll = els.results.scrollTop;
  els.results.innerHTML = "";
  state.results.forEach((r, i) => {
    const li = document.createElement("li");
    li.dataset.i = String(i);
    if (i === state.resultIndex) li.className = "active";

    const btn = document.createElement("button");
    btn.type = "button";
    if (r.thumb) {
      const img = document.createElement("img");
      img.src = r.thumb;
      img.loading = "lazy";
      btn.appendChild(img);
    }
    const box = document.createElement("div");
    const t = document.createElement("div");
    t.className = "t";
    t.textContent = r.title;
    const c = document.createElement("div");
    c.className = "c";
    c.textContent = r.channel;
    box.append(t, c);
    btn.appendChild(box);
    btn.addEventListener("click", () => loadVideo(i));
    li.appendChild(btn);
    els.results.appendChild(li);
  });

  // keep the list where it was, then make sure the active row is visible
  els.results.scrollTop = prevScroll;
  const a = els.results.querySelector("li.active");
  if (a) {
    const top = a.offsetTop;
    const bottom = top + a.offsetHeight;
    if (top < els.results.scrollTop) els.results.scrollTop = top;
    else if (bottom > els.results.scrollTop + els.results.clientHeight) {
      els.results.scrollTop = bottom - els.results.clientHeight;
    }
  }
}

function loadVideo(i) {
  state.resultIndex = i;
  state.videoId = state.results[i].videoId;
  renderResults();
  els.lengthNote.textContent = "";
  loadDelay();

  const id = state.videoId;
  ytReady.then(() => {
    if (state.videoId === id) {
      ytPlayer.loadVideoById(id);
      applyVolume();
    }
  });
}

/* ------------------------- controls + sync ----------------------- */

function seekTo(t) {
  if (!state.videoId || !ytPlayer || !ytPlayer.seekTo) return;
  ytPlayer.seekTo(Math.max(0, t), true);
  tick();
}

function skip(delta) {
  if (!state.videoId) return;
  seekTo(playerTime() + delta);
}

function togglePlay() {
  if (!state.videoId || !ytPlayer) return;
  if (isPlaying()) ytPlayer.pauseVideo();
  else ytPlayer.playVideo();
}

function delayKey() {
  if (!state.videoId || !state.current) return null;
  return `delay:${state.videoId}:${state.current.id}`;
}

function loadDelay() {
  const key = delayKey();
  const saved = key ? parseFloat(load(key)) : NaN;
  state.delay = isFinite(saved) ? saved : 0;
  renderDelay();
}

function setDelay(v) {
  state.delay = Math.round(v * 10) / 10;
  const key = delayKey();
  if (key) store(key, String(state.delay));
  renderDelay();
  tick();
}

function renderDelay() {
  const sign = state.delay > 0 ? "+" : "";
  els.delayValue.textContent = `${sign}${state.delay.toFixed(1)}s`;
}

function findActive(t) {
  let lo = 0, hi = state.lines.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (state.lines[mid].t <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

function setActive(idx) {
  if (idx === state.activeIdx) return;
  state.activeIdx = idx;
  state.lineEls.forEach((el, i) => {
    el.classList.toggle("active", i === idx);
    el.classList.toggle("past", i < idx);
  });
  const el = state.lineEls[idx];
  if (el) {
    const target = el.offsetTop - els.lyrics.clientHeight / 2 + el.clientHeight / 2;
    els.lyrics.scrollTo({ top: target, behavior: "smooth" });
  }
}

function tick() {
  if (!state.videoId || !ytPlayer || !ytPlayer.getCurrentTime) return;
  const t = playerTime();
  const dur = playerDuration();

  els.timeNow.textContent = fmt(t);
  els.timeTotal.textContent = fmt(dur);
  if (!state.dragging && dur > 0) els.seek.value = String(Math.round((t / dur) * 1000));

  if (state.synced && state.lines.length) setActive(findActive(t - state.delay));

  if (dur > 0 && state.current && !els.lengthNote.textContent) {
    const diff = Math.abs(dur - state.current.duration);
    const label = state.instrumental ? "Instrumental" : "Video";
    els.lengthNote.textContent =
      `Original ${fmt(state.current.duration)} | ${label} ${fmt(dur)}` +
      (diff > 4 ? " - adjust the lyrics delay if the intro differs." : "");
  }
}
setInterval(tick, 120);

els.back.addEventListener("click", () => skip(-10));
els.fwd.addEventListener("click", () => skip(10));
els.play.addEventListener("click", togglePlay);

els.seek.addEventListener("input", () => {
  state.dragging = true;
  els.timeNow.textContent = fmt((els.seek.value / 1000) * playerDuration());
});
els.seek.addEventListener("change", () => {
  state.dragging = false;
  seekTo((els.seek.value / 1000) * playerDuration());
});

document.querySelectorAll(".delay button[data-step]").forEach((b) => {
  b.addEventListener("click", () => setDelay(state.delay + parseFloat(b.dataset.step)));
});
els.delayReset.addEventListener("click", () => setDelay(0));

document.addEventListener("keydown", (e) => {
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "select" || tag === "textarea") return;
  if (e.key === " ") { e.preventDefault(); togglePlay(); }
  else if (e.key === "ArrowLeft") skip(-10);
  else if (e.key === "ArrowRight") skip(10);
});

els.lyricsSelect.addEventListener("change", () => {
  const c = state.candidates[parseInt(els.lyricsSelect.value, 10)];
  if (c) { applyLyrics(c); els.lengthNote.textContent = ""; }
});

/* ------------------- instrumental checkbox (saved) ---------------- */

els.instr.checked = load("karaoke:instrumental") !== "0"; // default: on
els.instr.addEventListener("change", () => {
  store("karaoke:instrumental", els.instr.checked ? "1" : "0");
});

/* --------------------- title -> lyrics lookup -------------------- */

// Public oEmbed gives the full, untruncated title without needing an API key
async function fetchVideoInfo(id) {
  try {
    const url = "https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent(`https://www.youtube.com/watch?v=${id}`);
    const res = await fetch(url);
    if (res.ok) {
      const j = await res.json();
      if (j.title) return { title: j.title, author: j.author_name || "" };
    }
  } catch (_) { }
  return { title: "Unknown Song", author: "" };
}

async function findLyrics(rawTrack, artist) {
  // Always clean the name here, so it also covers text typed into the lyrics box:
  // "Song Title (Instrumental)" -> "Song Title"
  const original = (rawTrack || "").trim();
  const track = stripNoise(original) || original;
  const cleanArtist = (artist || "").trim();

  els.lyricsTrack.value = track;
  els.lyricsArtist.value = cleanArtist;
  state.candidates = [];
  els.lyricsSelect.hidden = true;
  try {
    state.candidates = await searchLyrics(track, cleanArtist);
  } catch (err) {
    setStatus(err.message, true);
  }
  state.current = null;
  if (state.candidates.length) {
    fillCandidateSelect();
    applyLyrics(state.candidates[0]);
    return state.candidates[0];
  }
  els.lyricsMeta.textContent = "No lyrics found";
  showPlaceholder("No lyrics found for this search. Try adjusting the song name or artist box above.");
  return null;
}

/* ------------------------------ flow ----------------------------- */

els.form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const raw = els.query.value.trim();
  if (!raw) return;

  const wantInstr = els.instr.checked;
  // With the box ticked, drop any "instrumental" the user typed so it isn't doubled
  const q = wantInstr ? (stripInstrumental(raw) || raw) : raw;
  const ytQuery = wantInstr ? `${q} ${CONFIG.SEARCH_SUFFIX}` : q;
  state.instrumental = wantInstr;

  setStatus(wantInstr ? "Searching for an instrumental version..." : "Searching...");
  try {
    state.results = await searchYouTube(ytQuery);
    if (!state.results.length) {
      state.resultIndex = -1;
      renderResults();
      setStatus(wantInstr ? "No playable instrumental found. Try a different search." : "No playable video found. Try a different search.", true);
      return;
    }

    loadVideo(0);

    const info = await fetchVideoInfo(state.results[0].videoId);
    const title = info.title && info.title !== "Unknown Song" ? info.title : state.results[0].title;
    const channel = info.author || state.results[0].channel;
    const parsed = extractTrackArtist(title, channel);

    setStatus(`Looking up lyrics for "${parsed.track}"...`);
    const best = await findLyrics(parsed.track, parsed.artist);

    setStatus(!best ? "Lyrics not found, but the video is ready." : state.synced ? "" : "No synced lyrics for this song, showing plain text.");
  } catch (err) {
    setStatus(err.message, true);
  }
});

els.linkForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = extractVideoId(els.link.value);
  if (!id) return setStatus("That doesn't look like a YouTube link.", true);

  state.instrumental = true;
  state.results = [{
    videoId: id,
    title: "Pasted link",
    channel: id,
    thumb: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
  }];

  setStatus("Loading video...");
  loadVideo(0);

  const info = await fetchVideoInfo(id);
  state.results[0].title = info.title;
  state.results[0].channel = info.author || id;
  renderResults();

  const parsed = extractTrackArtist(info.title, info.author || id);
  setStatus(`Looking up lyrics for "${parsed.track}"...`);

  let found = await findLyrics(parsed.track, parsed.artist);
  if (!found && parsed.track !== info.title) found = await findLyrics(info.title, "");

  els.lengthNote.textContent = "";
  setStatus(!found ? "No lyrics found from title. Edit the names in the lyrics boxes above and press Find." : state.synced ? "" : "No synced lyrics for this song, showing plain text.", !found);
});

els.lyricsForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const track = els.lyricsTrack.value.trim();
  const artist = els.lyricsArtist.value.trim();
  if (!track) return;

  setStatus("Looking up lyrics...");
  const found = await findLyrics(track, artist);
  els.lengthNote.textContent = "";
  setStatus(!found ? "No lyrics found for that search. Try adjusting the title or artist." : state.synced ? "" : "No synced lyrics for this song, showing plain text.", !found);
});

showPlaceholder("Search for a song to get started.");
injectYouTubeApi();