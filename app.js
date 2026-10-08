"use strict";

const CONFIG = {
  SEARCH_PROXY: "https://karaoke.iffatadibamusaffa.workers.dev/",
  SEARCH_SUFFIX: "instrumental",
  LRCLIB: "https://lrclib.net/api/search",
  KUROSHIRO_JS: "https://unpkg.com/kuroshiro@1.2.0/dist/kuroshiro.min.js",
  KUROMOJI_ANALYZER_JS: "https://unpkg.com/kuroshiro-analyzer-kuromoji@1.1.0/dist/kuroshiro-analyzer-kuromoji.min.js",
  KUROMOJI_DICT: "./dict/", 
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
  syncRow: $("sync-row"),
  lyricsSelect: $("lyrics-select"),
  estSync: $("est-sync"),
  lyricsForm: $("lyrics-form"),
  lyricsTrack: $("lyrics-track"),
  lyricsArtist: $("lyrics-artist"),
  lyrics: $("lyrics"),
  readingMode: $("reading-mode"),
  readingStatus: $("reading-status"),
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
  lineUnits: [],
  activeIdx: -1,
  delay: 0,
  dragging: false,
  instrumental: true,
  volume: 100,
  lastVolume: 100,
  readingMode: "furigana",
  readings: new Map(),
  readingToken: 0,
};

/* ---------------------------- helpers ---------------------------- */

function setStatus(msg, isError = false) {
  els.status.textContent = msg || "";
  els.status.classList.toggle("error", !!isError);
}

function setReadingStatus(msg, isError = false) {
  els.readingStatus.textContent = msg || "";
  els.readingStatus.classList.toggle("error", !!isError);
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

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
const EMPTY_BRACKETS_RE = /[([{（【]\s*[)\]}）】]/g;

function tidy(s) {
  return s.replace(EMPTY_BRACKETS_RE, " ").replace(/\s{2,}/g, " ").replace(/^[\s\-–—|:~]+|[\s\-–—|:~]+$/g, "").trim();
}

function stripInstrumental(s) {
  return tidy(String(s || "").replace(/[([{（【][^)\]}）】]*\b(?:instrumental|karaoke)\b[^)\]}）】]*[)\]}）】]/gi, " ").replace(/\b(?:instrumental|karaoke)\b/gi, " "));
}

function stripNoise(s) {
  return tidy(String(s || "").replace(/[([{（【][^)\]}）】]*\b(?:karaoke|instrumental|backing|lyrics?|official|audio|video|hd|hq|4k|no vocals?|vocals?|cover|remaster\w*|version|sing[- ]?along|minus one)\b[^)\]}）】]*[)\]}）】]/gi, " ").replace(/\b(?:karaoke|instrumental|backing track|sing[- ]?along|no vocals?|with lyrics|lyrics|official (?:music )?video|official audio|hd|hq|4k)\b/gi, " "));
}

function extractTrackArtist(rawTitle, channelName) {
  let s = rawTitle || "";
  let artist = "";
  
  const perf = s.match(/[([]?\s*(?:originally\s+)?(?:performed|made famous|popularized|sung)\s+by\s+([^)\]\-|]+)[)\]]?/i);
  if (perf) { 
    artist = perf[1].trim(); 
    s = s.replace(perf[0], " "); 
  }
  
  s = stripNoise(s);
  
  if (!artist) {
    const parts = s.split(/\s[-–—|~]\s/);
    if (parts.length >= 2) {
      artist = parts[0].trim();
      s = parts.slice(1).join(" ").trim();
    } else if (channelName) {
      artist = channelName; 
    }
  }
  
  // AGGRESSIVE CLEANUP: Catches standard hyphens, en-dashes (–), and em-dashes (—)
  artist = artist.replace(/\s*[-–—]\s*Topic\b|\s*VEVO\b/gi, "").trim();

  return { track: tidy(s), artist: artist };
}

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
      onStateChange: (e) => { els.play.innerHTML = e.data === 1 ? "&#10074;&#10074;" : "&#9654;"; },
      onError: (e) => {
        const next = state.resultIndex + 1;
        if (next < state.results.length) { setStatus(`Skipped a blocked result. Trying the next one...`, true); loadVideo(next); } 
        else { setStatus(`Can't play this video. Try another search or open it on YouTube.`, true); }
      },
    },
  });
};

function injectYouTubeApi() {
  const s = document.createElement("script");
  s.src = "https://www.youtube.com/iframe_api";
  document.head.appendChild(s);
}

function playerTime() { return ytPlayer && ytPlayer.getCurrentTime ? ytPlayer.getCurrentTime() || 0 : 0; }
function playerDuration() { return ytPlayer && ytPlayer.getDuration ? ytPlayer.getDuration() || 0 : 0; }
function isPlaying() { return ytPlayer && ytPlayer.getPlayerState && ytPlayer.getPlayerState() === 1; }

/* ------------------------------ volume --------------------------- */
const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

function volumeIcon(v) {
  if (v === 0) return "\u{1F507}";
  if (v < 40) return "\u{1F508}";
  if (v < 75) return "\u{1F509}";
  return "\u{1F50A}";
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
els.mute.addEventListener("click", () => setVolume(state.volume > 0 ? 0 : state.lastVolume || 60));

(function initVolume() {
  const saved = parseInt(load("karaoke:volume"), 10);
  state.volume = isFinite(saved) ? Math.max(0, Math.min(100, saved)) : 100;
  state.lastVolume = state.volume || 100;
  renderVolume();
  if (IS_IOS) { els.vol.disabled = true; els.mute.disabled = true; els.volValue.textContent = ""; els.volumeNote.hidden = false; }
})();

/* -------------------- kanji -> hiragana (kuroshiro) -------------------- */
const KANJI_RE = /[㐀-䶿一-鿿豈-﫿々〆〇]/;
const SMALL_KANA_RE = /[ぁぃぅぇぉゃゅょゎァィゥェォャュョヮ]/;
let kuroPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Could not load " + src));
    document.head.appendChild(s);
  });
}

function getKuroshiro() {
  if (kuroPromise) return kuroPromise;
  kuroPromise = (async () => {
    await Promise.all([loadScript(CONFIG.KUROSHIRO_JS), loadScript(CONFIG.KUROMOJI_ANALYZER_JS)]);
    const K = window.Kuroshiro && (window.Kuroshiro.default || window.Kuroshiro);
    const A = window.KuromojiAnalyzer && (window.KuromojiAnalyzer.default || window.KuromojiAnalyzer);
    const k = new K();
    await k.init(new A({ dictPath: CONFIG.KUROMOJI_DICT }));
    return k;
  })();
  kuroPromise.catch(() => { kuroPromise = null; });
  return kuroPromise;
}

function segmentsFromHtml(html) {
  const doc = new DOMParser().parseFromString("<body>" + html + "</body>", "text/html");
  const segs = [];
  doc.body.childNodes.forEach((n) => {
    if (n.nodeType === Node.TEXT_NODE) segs.push(...plainSegments(n.textContent));
    else if (n.nodeName === "RUBY") {
      let base = "", reading = "";
      n.childNodes.forEach((c) => { if (c.nodeName === "RT") reading += c.textContent; else if (c.nodeName !== "RP") base += c.textContent; });
      if (base) segs.push({ base, reading: reading || null });
    } else segs.push(...plainSegments(n.textContent || ""));
  });
  return segs;
}

async function convertLine(k, text, mode) {
  const safe = escapeHtml(text);
  const out = mode === "furigana" ? await k.convert(safe, { mode: "furigana", to: "hiragana" }) : await k.convert(safe, { mode: "normal", to: "hiragana" });
  return segmentsFromHtml(out);
}

async function ensureReadings() {
  const mode = state.readingMode;
  const token = ++state.readingToken;
  const need = [...new Set(state.lines.filter((l) => l.text && KANJI_RE.test(l.text)).map((l) => l.text))].filter((t) => !state.readings.has(mode + "\n" + t));
  if (mode === "off" || !need.length) { setReadingStatus(""); return; }

  setReadingStatus(kuroPromise ? "Reading kanji..." : "Loading the Japanese dictionary...");
  try {
    const k = await getKuroshiro();
    for (const text of need) {
      let segs = null;
      try { segs = await convertLine(k, text, mode); } catch (e) { }
      state.readings.set(mode + "\n" + text, segs);
    }
    if (token !== state.readingToken) return; 
    setReadingStatus("");
    renderLyricsDom();
  } catch (err) {
    if (token === state.readingToken) setReadingStatus("Couldn't load kanji dictionary.", true);
  }
}

els.readingMode.value = ["furigana", "hiragana", "off"].includes(load("karaoke:reading")) ? load("karaoke:reading") : "furigana";
state.readingMode = els.readingMode.value;
els.readingMode.addEventListener("change", () => {
  state.readingMode = els.readingMode.value;
  store("karaoke:reading", state.readingMode);
  renderLyricsDom();
  ensureReadings();
});

/* ----------------------------- lyrics (True Sync Enabled) ---------------------------- */

function parseLRC(text) {
  const out = [];
  const lineRe = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  const wordRe = /<(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?>/g;

  for (const raw of text.split(/\r?\n/)) {
    const times = [];
    let m;
    lineRe.lastIndex = 0;
    let lastLineIdx = 0;
    while ((m = lineRe.exec(raw))) {
      const frac = m[3] ? parseInt(m[3], 10) / Math.pow(10, m[3].length) : 0;
      times.push(parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + frac);
      lastLineIdx = lineRe.lastIndex;
    }
    if (!times.length) continue;

    let lineText = raw.slice(lastLineIdx).trim();
    let words = null;
    
    if (/<(\d{1,3}):/.test(lineText)) {
        words = [];
        let wMatch;
        wordRe.lastIndex = 0;
        let lastWIdx = 0;
        let lastTime = times[0];

        while ((wMatch = wordRe.exec(lineText))) {
            const frac = wMatch[3] ? parseInt(wMatch[3], 10) / Math.pow(10, wMatch[3].length) : 0;
            const t = parseInt(wMatch[1], 10) * 60 + parseInt(wMatch[2], 10) + frac;
            const textBefore = lineText.slice(lastWIdx, wMatch.index);
            if (textBefore) words.push({ text: textBefore, start: lastTime, end: t });

            lastTime = t;
            lastWIdx = wordRe.lastIndex;
        }
        if (lastWIdx < lineText.length) {
            words.push({ text: lineText.slice(lastWIdx), start: lastTime, end: lastTime + 2 }); 
        }
        lineText = lineText.replace(/<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/g, "");
    }

    for (const t of times) out.push({ t, text: lineText, words });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

async function searchLyrics(track, artist) {
  let allCandidates = [];
  
  // 1. Fetch from LRCLIB (Directly from browser, no CORS issues)
  const fetchLRCLIB = async () => {
    try {
      let data = [];
      if (artist) {
        const url = `${CONFIG.LRCLIB}?track_name=${encodeURIComponent(track)}&artist_name=${encodeURIComponent(artist)}`;
        const res = await fetch(url);
        if (res.ok) data = await res.json();
      }
      if (!data.length) {
        const url = `${CONFIG.LRCLIB}?q=${encodeURIComponent(artist ? `${track}${artist}` : track)}`;
        const res = await fetch(url);
        if (res.ok) data = await res.json();
      }
      return Array.isArray(data) ? data.map(d => ({
        ...d,
        source: 'LRCLIB'
      })) : [];
    } catch (e) { return []; }
  };

  // 2. Fetch from your Cloudflare Worker Proxy (Kugou, YouLyPlus, etc.)
// 2. Fetch from your Cloudflare Worker Proxy (Kugou, YouLyPlus, etc.)
  const fetchWorkerAPI = async (provider) => {
    try {
      const url = `${CONFIG.SEARCH_PROXY}lyrics?provider=${provider}&track=${encodeURIComponent(track)}&artist=${encodeURIComponent(artist)}`;
      const res = await fetch(url);
      
      if (res.ok) {
        const data = await res.json();
        
        // If the provider returned empty data, skip it
        if (!data.lrc && !data.syncedLyrics && !data.plain) return [];

        return [{
          id: `${provider}-${Date.now()}`,
          trackName: track,
          artistName: artist,
          albumName: "",
          duration: data.duration || 0,
          instrumental: false,
          syncedLyrics: data.lrc || data.syncedLyrics || null,
          plainLyrics: data.plain || null,
          source: provider.toUpperCase()
        }];
      } else {
        // Log to console so you can see if the private API blocked the Worker
        console.warn(`[${provider.toUpperCase()}] Error ${res.status}:`, await res.text());
        return [];
      }
    } catch (e) { 
      console.error(`[${provider.toUpperCase()}] Fetch failed completely:`, e);
      return []; 
    }
  };

  // Run all API requests concurrently for maximum speed
  const results = await Promise.all([
    fetchLRCLIB(),
    fetchWorkerAPI("kugou"),
    fetchWorkerAPI("youlyplus")
  ]);

  // Flatten the array of arrays into a single list
  allCandidates = results.flat();

  // Filter out invalid lyrics and sort them: True Sync first, Line Sync second, Plain Text last
  return allCandidates
    .filter((d) => !d.instrumental && (d.syncedLyrics || d.plainLyrics))
    .sort((a, b) => {
      const aTrue = a.syncedLyrics && /<\d{1,3}:\d{2}/.test(a.syncedLyrics) ? 1 : 0;
      const bTrue = b.syncedLyrics && /<\d{1,3}:\d{2}/.test(b.syncedLyrics) ? 1 : 0;
      if (aTrue !== bTrue) return bTrue - aTrue;
      return (b.syncedLyrics ? 1 : 0) - (a.syncedLyrics ? 1 : 0);
    });
}

function fillCandidateSelect() {
  els.lyricsSelect.innerHTML = "";
  state.candidates.forEach((c, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    const album = c.albumName ? ` · ${c.albumName}` : "";
    
    let kind = "Plain text";
    if (c.syncedLyrics && /<\d{1,3}:\d{2}/.test(c.syncedLyrics)) kind = "True Sync";
    else if (c.syncedLyrics) kind = "Line Sync";
    
    // Displays: "Song - Artist · 3:45 · True Sync · YOULYPLUS"
    opt.textContent = `${c.trackName} - ${c.artistName}${album} · ${fmt(c.duration)} · ${kind} · ${c.source || 'Unknown'}`;
    els.lyricsSelect.appendChild(opt);
  });
  
  els.lyricsSelect.hidden = state.candidates.length < 2;
  els.syncRow.hidden = state.candidates.length === 0;
}

function showPlaceholder(msg) {
  els.lyrics.innerHTML = "";
  const p = document.createElement("div");
  p.className = "placeholder";
  p.textContent = msg;
  els.lyrics.appendChild(p);
  state.lines = [];
  state.lineEls = [];
  state.lineUnits = [];
  state.activeIdx = -1;
  state.synced = false;
  els.lyrics.classList.remove("plain", "has-ruby");
  els.syncRow.hidden = true;
  setReadingStatus("");
}

function plainSegments(text) {
  const re = /[A-Za-z0-9À-ɏ'’-]+|\s+|[\s\S]/gu;
  return (String(text).match(re) || []).map((base) => ({ base, reading: null }));
}

function weightOf(seg) {
  if (seg.reading) return Math.max(1, Array.from(seg.reading).filter((c) => !SMALL_KANA_RE.test(c)).length);
  const c = seg.base;
  if (/^\s+$/.test(c)) return 0.3;
  if (SMALL_KANA_RE.test(c)) return 0.25;
  if (/^[぀-ヿ]$/.test(c)) return 1;
  if (KANJI_RE.test(c)) return 2;
  if (/[A-Za-z0-9À-ɏ]/.test(c)) return Math.max(0.6, Array.from(c).length * 0.5);
  return 0.2;
}

function buildLine(container, segs, lineData) {
  const units = [];
  let total = 0;
  let ruby = false;
  let charIndex = 0;
  const trueWords = lineData.words;

  for (const seg of segs) {
    const el = document.createElement("span");
    el.className = seg.reading ? "u r" : "u";
    if (seg.reading) {
      ruby = true;
      const r = document.createElement("ruby");
      r.appendChild(document.createTextNode(seg.base));
      const rt = document.createElement("rt");
      rt.textContent = seg.reading;
      r.appendChild(rt);
      el.appendChild(r);
    } else {
      el.textContent = seg.base;
    }
    const w = weightOf(seg);

    let startT = null, endT = null;
    if (trueWords) {
        let wStartIdx = 0;
        for (const w of trueWords) {
            if (charIndex >= wStartIdx && charIndex < wStartIdx + w.text.length) {
                startT = w.start;
                endT = w.end;
                break;
            }
            wStartIdx += w.text.length;
        }
    }

    units.push({ el, a: total, b: total + w, p: -1, startT, endT });
    charIndex += seg.base.length;
    total += w;
    container.appendChild(el);
  }
  const t = total || 1;
  units.forEach((u) => { u.a /= t; u.b /= t; });
  return { units, total, ruby, hasTrueSync: !!trueWords };
}

function renderLyricsDom() {
  if (!state.lines.length) return;
  const keep = state.activeIdx;
  state.activeIdx = -1;
  els.lyrics.innerHTML = "";
  state.lineUnits = [];
  let anyRuby = false;

  state.lineEls = state.lines.map((ln) => {
    const d = document.createElement("div");
    d.className = "line" + (ln.text ? "" : " empty");
    let info = { units: [], total: 0 };
    if (ln.text) {
      const cached = state.readingMode !== "off" ? state.readings.get(state.readingMode + "\n" + ln.text) : null;
      info = buildLine(d, cached || plainSegments(ln.text), ln);
      if (info.ruby) anyRuby = true;
    } else {
      d.textContent = state.synced ? "♪" : " ";
    }
    if (state.synced) d.addEventListener("click", () => seekTo(ln.t + state.delay));
    els.lyrics.appendChild(d);
    state.lineUnits.push(info);
    return d;
  });

  els.lyrics.classList.toggle("has-ruby", anyRuby);
  if (keep >= 0) setActive(keep, true);
}

function applyLyrics(candidate) {
  state.current = candidate;
  state.synced = !!candidate.syncedLyrics;
  state.lines = state.synced
    ? parseLRC(candidate.syncedLyrics)
    : candidate.plainLyrics.split(/\r?\n/).map((text) => ({ t: null, text: text.trim() }));
  state.activeIdx = -1;
  
  const hasTrueWords = state.lines.some(l => l.words && l.words.length > 0);
  let statusStr = "Plain text";
  if (state.synced) statusStr = hasTrueWords ? "True Word Sync" : "Line Sync";
  
  els.lyricsMeta.textContent = `LRCLIB · ${statusStr} · ${candidate.trackName} - ${candidate.artistName}`;
  els.lyrics.classList.toggle("plain", !state.synced);

  renderLyricsDom();
  els.lyrics.scrollTop = 0;
  loadDelay();
  ensureReadings();
}

/* ---------------------------- search ----------------------------- */

async function searchYouTube(q) {
  if (!CONFIG.SEARCH_PROXY) throw new Error("Missing Cloudflare Worker URL in CONFIG.");
  const res = await fetch(`${CONFIG.SEARCH_PROXY}?q=${encodeURIComponent(q)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.error && data.error.message) || `YouTube search failed (${res.status})`);

  return (data.items || []).filter((i) => i.id && i.id.videoId).map((i) => ({
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
      img.src = r.thumb; img.loading = "lazy"; btn.appendChild(img);
    }
    const box = document.createElement("div");
    const t = document.createElement("div"); t.className = "t"; t.textContent = r.title;
    const c = document.createElement("div"); c.className = "c"; c.textContent = r.channel;
    box.append(t, c); btn.appendChild(box);
    btn.addEventListener("click", () => loadVideo(i));
    li.appendChild(btn); els.results.appendChild(li);
  });

  els.results.scrollTop = prevScroll;
  const a = els.results.querySelector("li.active");
  if (a) {
    const top = a.offsetTop, bottom = top + a.offsetHeight;
    if (top < els.results.scrollTop) els.results.scrollTop = top;
    else if (bottom > els.results.scrollTop + els.results.clientHeight) els.results.scrollTop = bottom - els.results.clientHeight;
  }
}

function loadVideo(i) {
  state.resultIndex = i;
  state.videoId = state.results[i].videoId;
  renderResults();
  els.lengthNote.textContent = "";
  loadDelay();
  const id = state.videoId;
  ytReady.then(() => { if (state.videoId === id) { ytPlayer.loadVideoById(id); applyVolume(); } });
}

/* ------------------------- controls + sync ----------------------- */

function seekTo(t) {
  if (!state.videoId || !ytPlayer || !ytPlayer.seekTo) return;
  ytPlayer.seekTo(Math.max(0, t), true);
  tick();
}

function skip(delta) { if (state.videoId) seekTo(playerTime() + delta); }

function togglePlay() {
  if (!state.videoId || !ytPlayer) return;
  if (isPlaying()) ytPlayer.pauseVideo(); else ytPlayer.playVideo();
}

function delayKey() { return state.videoId && state.current ? `delay:${state.videoId}:${state.current.id}` : null; }
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
  renderDelay(); tick();
}
function renderDelay() { els.delayValue.textContent = `${state.delay > 0 ? "+" : ""}${state.delay.toFixed(1)}s`; }

function findActive(t) {
  let lo = 0, hi = state.lines.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (state.lines[mid].t <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

const clock = { v: 0, at: 0, last: 0 };
function smoothTime() {
  const raw = playerTime(), now = performance.now();
  if (raw !== clock.v) { clock.v = raw; clock.at = now; }
  if (!isPlaying()) { clock.last = raw; return raw; }
  const rate = ytPlayer.getPlaybackRate ? ytPlayer.getPlaybackRate() || 1 : 1;
  let est = clock.v + Math.min((now - clock.at) / 1000, 0.6) * rate;
  if (est < clock.last && clock.last - est < 0.3) est = clock.last;
  clock.last = est;
  return est;
}

function lineWindow(i) {
  const ln = state.lines[i], next = state.lines[i + 1], info = state.lineUnits[i];
  const est = Math.max(0.8, (info ? info.total : 8) * 0.26);
  const avail = next ? next.t - ln.t - 0.08 : est + 1.5;
  return Math.max(0.3, avail <= est * 1.8 ? avail : est);
}

function paintLine(idx, f, currentTime) {
  const info = state.lineUnits[idx];
  if (!info) return;
  const useEstimate = els.estSync.checked;

  for (const u of info.units) {
    let p = 0;
    if (info.hasTrueSync && u.startT !== null && u.endT !== null) {
        if (currentTime >= u.endT) p = 100;
        else if (currentTime < u.startT) p = 0;
        else {
            const dur = u.endT - u.startT;
            p = dur > 0 ? ((currentTime - u.startT) / dur) * 100 : 100;
        }
    } else {
        if (useEstimate) p = f <= u.a ? 0 : f >= u.b ? 100 : ((f - u.a) / (u.b - u.a)) * 100;
        else p = 100; 
    }
    p = Math.round(p * 10) / 10;
    if (p !== u.p) { u.p = p; u.el.style.setProperty("--p", String(p)); }
  }
}

function clearPaint(idx) {
  const info = state.lineUnits[idx];
  if (!info) return;
  for (const u of info.units) { u.p = -1; u.el.style.removeProperty("--p"); }
}

function setActive(idx, instant = false) {
  if (idx === state.activeIdx) return;
  if (state.activeIdx >= 0) clearPaint(state.activeIdx); 
  state.activeIdx = idx;
  state.lineEls.forEach((el, i) => {
    el.classList.toggle("active", i === idx);
    el.classList.toggle("past", i < idx);
  });
  const el = state.lineEls[idx];
  if (el) {
    const target = el.offsetTop - els.lyrics.clientHeight / 2 + el.clientHeight / 2;
    els.lyrics.scrollTo({ top: target, behavior: instant ? "auto" : "smooth" });
  }
}

function frame() {
  requestAnimationFrame(frame);
  if (!state.synced || !state.lines.length || !state.videoId || !ytPlayer || !ytPlayer.getCurrentTime) return;

  const t = smoothTime() - state.delay;
  const idx = findActive(t);
  setActive(idx);
  if (idx >= 0) {
    const f = (t - state.lines[idx].t) / lineWindow(idx);
    paintLine(idx, Math.max(0, Math.min(1, f)), t);
  }
}
requestAnimationFrame(frame);

function tick() {
  if (!state.videoId || !ytPlayer || !ytPlayer.getCurrentTime) return;
  const t = playerTime();
  const dur = playerDuration();

  els.timeNow.textContent = fmt(t);
  els.timeTotal.textContent = fmt(dur);
  if (!state.dragging && dur > 0) els.seek.value = String(Math.round((t / dur) * 1000));

  if (dur > 0 && state.current && !els.lengthNote.textContent) {
    const diff = Math.abs(dur - state.current.duration);
    const label = state.instrumental ? "Instrumental" : "Video";
    els.lengthNote.textContent = `Original ${fmt(state.current.duration)} | ${label} ${fmt(dur)}` + (diff > 4 ? " - adjust the lyrics delay if the intro differs." : "");
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

els.estSync.checked = load("karaoke:estSync") !== "0";
els.estSync.addEventListener("change", () => {
  store("karaoke:estSync", els.estSync.checked ? "1" : "0");
  if (state.activeIdx >= 0 && state.synced) {
     const t = smoothTime() - state.delay;
     const f = (t - state.lines[state.activeIdx].t) / lineWindow(state.activeIdx);
     paintLine(state.activeIdx, Math.max(0, Math.min(1, f)), t);
  }
});

/* ------------------- instrumental checkbox (saved) ---------------- */
els.instr.checked = load("karaoke:instrumental") !== "0"; 
els.instr.addEventListener("change", () => { store("karaoke:instrumental", els.instr.checked ? "1" : "0"); });

/* --------------------- title -> lyrics lookup -------------------- */
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
  const original = (rawTrack || "").trim();
  const track = stripNoise(original) || original;
  
  // Clean the artist name again just in case it was manually typed/pasted
  let cleanArtist = (artist || "").trim();
  cleanArtist = cleanArtist.replace(/\s*[-–—]\s*Topic\b|\s*VEVO\b/gi, "").trim();

  els.lyricsTrack.value = track;
  els.lyricsArtist.value = cleanArtist;
  state.candidates = [];
  els.lyricsSelect.hidden = true;
  els.syncRow.hidden = true;
  
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
  const q = wantInstr ? (stripInstrumental(raw) || raw) : raw;
  const ytQuery = wantInstr ? `${q} ${CONFIG.SEARCH_SUFFIX}` : q;
  state.instrumental = wantInstr;

  setStatus(wantInstr ? "Searching for an instrumental version..." : "Searching...");
  try {
    state.results = await searchYouTube(ytQuery);
    if (!state.results.length) {
      state.resultIndex = -1;
      renderResults();
      setStatus(wantInstr ? "No playable instrumental found." : "No playable video found.", true);
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
  state.results = [{ videoId: id, title: "Pasted link", channel: id, thumb: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` }];
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
  setStatus(!found ? "No lyrics found from title." : state.synced ? "" : "No synced lyrics for this song.", !found);
});

els.lyricsForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const track = els.lyricsTrack.value.trim();
  const artist = els.lyricsArtist.value.trim();
  if (!track) return;

  setStatus("Looking up lyrics...");
  const found = await findLyrics(track, artist);
  els.lengthNote.textContent = "";
  setStatus(!found ? "No lyrics found for that search." : state.synced ? "" : "No synced lyrics for this song.", !found);
});

showPlaceholder("Search for a song to get started.");
injectYouTubeApi();
