const KEY = "better-tube-v1";

const state = loadState();
let catalog = null;
let searchQuery = "";
let sortMode = "rank";
let player = null;
let poll = null;
let fallbackTimer = null;
let ytReady = false;
let ytStarted = false;
let cursor = 0;
let mountedId = null;
let lastPath = "";

const $ = (sel) => document.querySelector(sel);

function loadState() {
  const blank = {
    progress: {},
    liked: {},
    later: [],
    hidden: {},
    settings: { hideFinished: false, posters: false, autoplay: true },
  };
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "null");
    if (!raw) return blank;
    raw.settings = Object.assign(blank.settings, raw.settings || {});
    raw.progress = raw.progress || {};
    raw.liked = raw.liked || {};
    raw.later = raw.later || [];
    raw.hidden = raw.hidden || {};
    return raw;
  } catch {
    return blank;
  }
}

function saveState() {
  localStorage.setItem(KEY, JSON.stringify(state));
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

function byId(id) {
  return catalog.videos.find((video) => video.id === id) || null;
}

function fraction(id) {
  const progress = state.progress[id];
  if (!progress || !progress.duration) return 0;
  return progress.seconds / progress.duration;
}

function done(id) {
  return fraction(id) >= 0.9;
}

function visible(video) {
  if (state.hidden[video.id]) return false;
  if (state.settings.hideFinished && done(video.id)) return false;
  return true;
}

function route() {
  const path = (location.hash.replace(/^#/, "") || "/").split("?")[0];
  const parts = path.split("/").filter(Boolean);
  return { name: parts[0] || "home", arg: decodeURIComponent(parts[1] || "") };
}

function trackList() {
  return catalog.tracks || [];
}

function trackById(id) {
  return trackList().find((track) => track.id === id) || null;
}

function flatTrack(track) {
  return track.stages.flatMap((stage) => stage.videos);
}

function trackProgress(track) {
  const ids = flatTrack(track).filter((id) => byId(id));
  const finished = ids.filter((id) => done(id)).length;
  const next = ids.map(byId).find((video) => video && !done(video.id)) || null;
  const seconds = ids.reduce((sum, id) => sum + (byId(id).durationSec || 0), 0);
  return { total: ids.length, finished, next, hours: Math.round(seconds / 3600) };
}

function stepInTrack(trackId, video, direction) {
  const track = trackById(trackId);
  if (!track || !video) return null;
  const ids = flatTrack(track);
  const index = ids.indexOf(video.id);
  if (index < 0) return null;
  for (let i = index + direction; i >= 0 && i < ids.length; i += direction) {
    const next = byId(ids[i]);
    if (next) return next;
  }
  return null;
}

function nextInTrack(trackId, video) {
  return stepInTrack(trackId, video, 1);
}

function trackSpots(id) {
  const spots = [];
  for (const track of trackList()) {
    const ids = flatTrack(track);
    const index = ids.indexOf(id);
    if (index >= 0) spots.push({ track, n: index + 1, total: ids.length });
  }
  return spots;
}

function fmt(sec) {
  sec = Math.round(sec || 0);
  if (!sec) return "";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtLong(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h && m) return `${h} hr ${m} min`;
  if (h) return `${h} hr`;
  return `${m} min`;
}

function fmtDate(iso) {
  if (!iso) return "";
  const [year, month, day] = iso.split("-").map(Number);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[month - 1]} ${day}, ${year}`;
}

function seriesOf(video) {
  return video.series ? catalog.series[video.series] : null;
}

function topicOf(id) {
  return catalog.topics.find((topic) => topic.id === id);
}

function kicker(video) {
  const year = (video.published || "").slice(0, 4);
  const series = seriesOf(video);
  if (series) {
    const part = video.part == null ? "" : video.series === "gpumode" ? ` · Lec ${video.part}` : ` · ${video.part}`;
    return `${series.title}${part}${year ? " · " + year : ""}`;
  }
  const topic = topicOf(video.topics[0]);
  return `${topic ? topic.label : video.kind}${year ? " · " + year : ""}`;
}

function thumbChain() {
  return state.settings.posters
    ? ["maxresdefault.jpg", "sddefault.jpg", "hqdefault.jpg"]
    : ["maxres2.jpg", "sd2.jpg", "hq2.jpg"];
}

function thumb(id) {
  return `https://i.ytimg.com/vi/${id}/${thumbChain()[0]}`;
}

function bumpThumb(img) {
  const id = img.dataset.vid;
  if (!id) return;
  const chain = thumbChain();
  const next = Number(img.dataset.step || 0) + 1;
  if (next >= chain.length) return;
  img.dataset.step = String(next);
  img.src = `https://i.ytimg.com/vi/${id}/${chain[next]}`;
}

function episodes(seriesId) {
  return catalog.videos
    .filter((video) => video.series === seriesId)
    .sort((a, b) => a.part - b.part);
}

function nextInSeries(video) {
  if (!video || !video.series || video.part == null) return null;
  return episodes(video.series).find((item) => item.part > video.part) || null;
}

function prevInSeries(video) {
  if (!video || !video.series || video.part == null) return null;
  const list = episodes(video.series).filter((item) => item.part < video.part);
  return list.length ? list[list.length - 1] : null;
}

function continueWatching() {
  return catalog.videos
    .filter((video) => {
      const amount = fraction(video.id);
      return amount > 0.02 && amount < 0.9 && !state.hidden[video.id];
    })
    .sort((a, b) => state.progress[b.id].updated - state.progress[a.id].updated);
}

function upNext() {
  const picks = [];
  for (const seriesId of Object.keys(catalog.series)) {
    const list = episodes(seriesId);
    const started = list.some((video) => fraction(video.id) > 0.02);
    if (!started) continue;
    const next = list.find((video) => !done(video.id) && !state.hidden[video.id]);
    if (next) picks.push(next);
  }
  return picks;
}

function forYou(limit) {
  const affinity = {};
  for (const video of catalog.videos) {
    const weight = (state.liked[video.id] ? 1.2 : 0) + (fraction(video.id) > 0.5 ? 0.8 : 0);
    if (!weight) continue;
    for (const topic of video.topics) affinity[topic] = (affinity[topic] || 0) + weight;
  }
  const started = new Set(upNext().map((video) => video.id));
  const fresh = !Object.keys(state.progress).length && !Object.keys(state.liked).length;
  const intro = fresh ? new Set(catalog.startHere) : new Set();
  const ranked = catalog.videos
    .filter((video) => !state.hidden[video.id] && !done(video.id) && !intro.has(video.id))
    .map((video) => {
      let score = video.rank;
      for (const topic of video.topics) score += Math.min(2.5, affinity[topic] || 0) * 0.35;
      if (started.has(video.id)) score += 1.8;
      return { video, score };
    })
    .sort((a, b) => b.score - a.score);

  const out = [];
  const perChannel = {};
  const perSeries = {};
  for (const item of ranked) {
    const channel = item.video.channel;
    const series = item.video.series;
    if ((perChannel[channel] || 0) >= 2) continue;
    if (series && (perSeries[series] || 0) >= 2) continue;
    out.push(item.video);
    perChannel[channel] = (perChannel[channel] || 0) + 1;
    if (series) perSeries[series] = (perSeries[series] || 0) + 1;
    if (out.length >= limit) break;
  }
  return out;
}

function preview(list, count) {
  const ranked = list
    .filter(visible)
    .slice()
    .sort((a, b) => b.rank - a.rank || (a.part || 0) - (b.part || 0));
  const out = [];
  const perSeries = {};
  for (const video of ranked) {
    const key = video.series || video.id;
    if ((perSeries[key] || 0) >= 3) continue;
    out.push(video);
    perSeries[key] = (perSeries[key] || 0) + 1;
    if (out.length >= count) break;
  }
  return out;
}

function sortVideos(list) {
  const out = list.slice();
  if (sortMode === "new") out.sort((a, b) => (b.published || "").localeCompare(a.published || ""));
  else if (sortMode === "long") out.sort((a, b) => b.durationSec - a.durationSec);
  else if (sortMode === "series") {
    out.sort((a, b) => (a.series || "~").localeCompare(b.series || "~") || (a.part || 0) - (b.part || 0));
  } else out.sort((a, b) => b.rank - a.rank || (b.published || "").localeCompare(a.published || ""));
  return out;
}

function search(query) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return catalog.videos.filter((video) => {
    const series = seriesOf(video);
    const hay = [
      video.label,
      video.title,
      video.channel,
      video.why,
      video.kind,
      ...video.topics,
      series && series.title,
      series && series.place,
    ].join(" ").toLowerCase();
    return terms.every((term) => hay.includes(term));
  });
}

function card(video) {
  const amount = fraction(video.id);
  const finished = done(video.id);
  return `<a class="card${finished ? " is-done" : ""}" href="#/watch/${video.id}" data-id="${video.id}">
    <div class="thumb">
      <img alt="" data-vid="${video.id}" src="${thumb(video.id)}" loading="lazy">
      ${finished ? '<span class="flag">watched</span>' : ""}
      <span class="time">${fmt(video.durationSec)}</span>
      ${amount > 0.02 && !finished ? `<span class="bar"><span style="width:${Math.min(100, amount * 100)}%"></span></span>` : ""}
    </div>
    <div class="kicker">${esc(kicker(video))}</div>
    <div class="label">${esc(video.label)}</div>
    <div class="by">${esc(video.channel)}</div>
  </a>`;
}

function row(title, note, videos, href) {
  if (!videos.length) return "";
  return `<section class="row">
    <header>
      <div>
        <h2>${esc(title)}</h2>
        ${note ? `<p>${esc(note)}</p>` : ""}
      </div>
      ${href ? `<a class="more" href="${href}">All</a>` : ""}
    </header>
    <div class="grid">${videos.map(card).join("")}</div>
  </section>`;
}

function line(video, extra, kickerText) {
  const finished = done(video.id);
  return `<a class="line card${finished ? " is-done" : ""}" href="#/watch/${video.id}" data-id="${video.id}">
    <div class="thumb">
      <img alt="" data-vid="${video.id}" src="${thumb(video.id)}" loading="lazy">
      <span class="time">${fmt(video.durationSec)}</span>
    </div>
    <div>
      <div class="kicker">${esc(kickerText || kicker(video))}</div>
      <div class="label">${esc(video.label)}</div>
      <div class="by">${esc(video.channel)}</div>
    </div>
    <div class="side">${extra || ""}</div>
  </a>`;
}

function pageHead(title, blurb, withSort) {
  return `<div class="page-head">
    <div>
      <h1>${esc(title)}</h1>
      ${blurb ? `<p>${blurb}</p>` : ""}
    </div>
    ${withSort ? `<div class="tools"><select id="sort" aria-label="Sort">
      <option value="rank"${sortMode === "rank" ? " selected" : ""}>Recommended</option>
      <option value="new"${sortMode === "new" ? " selected" : ""}>Newest</option>
      <option value="long"${sortMode === "long" ? " selected" : ""}>Longest</option>
      <option value="series"${sortMode === "series" ? " selected" : ""}>Course order</option>
    </select></div>` : ""}
  </div>`;
}

function renderTrackCards() {
  const tracks = trackList();
  if (!tracks.length) return "";
  const cards = tracks.map((track) => {
    const progress = trackProgress(track);
    const go = !progress.next
      ? "Finished"
      : `${progress.finished ? "Continue" : "Start"} · ${progress.next.label}`;
    return `<a class="track" href="#/track/${track.id}">
      <div class="kicker">${esc(track.level)}</div>
      <strong>${esc(track.title)}</strong>
      <p>${esc(track.blurb)}</p>
      <span class="go">${progress.finished}/${progress.total} · about ${progress.hours} hr · ${esc(go)}</span>
    </a>`;
  }).join("");
  return `<section class="row">
    <header><div><h2>What to study</h2><p>Three ordered paths. Stay in order. The notebooks are linked on each track.</p></div></header>
    <div class="track-grid">${cards}</div>
  </section>`;
}

function renderTrack(id) {
  const track = trackById(id);
  if (!track) return `<p class="empty">That track isn’t on the shelf.</p>`;
  const progress = trackProgress(track);
  const sources = (track.sources || [])
    .map((source) => `<a href="${esc(source.href)}">${esc(source.label)}</a>`)
    .join("");
  const go = progress.next
    ? `<a class="continue" href="#/watch/${progress.next.id}">${progress.finished ? "Continue" : "Start"} · ${esc(progress.next.label)}</a>`
    : `<p class="empty">You have finished this track.</p>`;
  let step = 0;
  const stages = track.stages.map((stage, index) => {
    const videos = stage.videos.map(byId).filter(Boolean);
    const rows = videos.map((video) => {
      step += 1;
      return line(video, done(video.id) ? "watched" : "", `${step}. ${stage.title}`);
    }).join("");
    const site = stage.site ? ` <a href="${esc(stage.site)}">Course site</a>` : "";
    return `<section class="stage">
      <h2>${index + 1}. ${esc(stage.title)}</h2>
      <p>${esc(stage.blurb)}${site}</p>
      <div class="list">${rows}</div>
    </section>`;
  }).join("");
  return `<div data-keep-track="${esc(track.id)}">
    <div class="page-head">
      <div>
        <h1>${esc(track.title)}</h1>
        <p>${esc(track.blurb)} ${progress.finished} of ${progress.total} finished.</p>
        ${sources ? `<p class="sources">${sources}</p>` : ""}
      </div>
    </div>
    ${go}
    ${stages}
  </div>`;
}

function renderHome() {
  const hours = Math.round(catalog.videos.reduce((sum, video) => sum + video.durationSec, 0) / 3600);
  const cont = continueWatching();
  const next = upNext().filter((video) => !cont.some((item) => item.id === video.id));
  const starts = catalog.startHere.map(byId).filter(Boolean);
  let html = `<div class="lede"><h1>For you</h1><p>${catalog.videos.length} videos, about ${hours} hours. Three study tracks if you want a path. The shelf also learns which topics you finish and like. It stays in this browser.</p></div>`;
  html += renderTrackCards();
  html += row("Continue", "", cont.slice(0, 8));
  html += row("Up next", "The next unwatched part of a course you started.", next.slice(0, 4));
  if (!cont.length) html += row("Start here", "Four ways in, depending on how close to the metal you want to be.", starts);
  html += row("Recommended", "Ranked from what you’ve finished and liked. A fresh browser starts from the courses.", forYou(8));
  for (const topic of catalog.topics) {
    const list = catalog.videos.filter((video) => video.topics[0] === topic.id);
    html += row(topic.label, topic.blurb, preview(list, 8), `#/topic/${topic.id}`);
  }
  return html;
}

function renderCollection(title, blurb, videos, withSort) {
  const shown = withSort ? sortVideos(videos.filter(visible)) : videos;
  if (!shown.length) {
    return pageHead(title, blurb, false) + `<p class="empty">Nothing here yet.</p>`;
  }
  return pageHead(title, blurb, withSort) + `<div class="grid">${shown.map(card).join("")}</div>`;
}

function renderLines(title, blurb, videos, extraFor) {
  if (!videos.length) return pageHead(title, blurb, false) + `<p class="empty">Nothing here yet.</p>`;
  return pageHead(title, blurb, false) + `<div class="list">${videos.map((video) => line(video, extraFor ? extraFor(video) : "")).join("")}</div>`;
}

function renderSeries(id) {
  const series = catalog.series[id];
  if (!series) return `<p class="empty">That course isn’t on the shelf.</p>`;
  const list = episodes(id);
  const blurb = `${esc(series.place)}. ${esc(series.blurb)}${series.site ? ` <a href="${esc(series.site)}">Course site</a>` : ""}`;
  return pageHead(series.title, blurb, false) + `<div class="list">${list.map((video) => line(video, video.part != null ? String(video.part) : "")).join("")}</div>`;
}

function renderWatch(id) {
  const video = byId(id);
  if (!video) return `<p class="empty">That video isn’t on the shelf.</p>`;
  const series = seriesOf(video);
  const next = nextInSeries(video);
  const prev = prevInSeries(video);
  const same = video.series ? episodes(video.series).filter((item) => item.id !== video.id) : [];
  const used = new Set([video.id, ...same.map((item) => item.id)]);
  const more = catalog.videos
    .filter((item) => !used.has(item.id) && item.topics.some((topic) => video.topics.includes(topic)) && !state.hidden[item.id])
    .sort((a, b) => b.rank - a.rank)
    .slice(0, 6);

  const pressed = (name) => {
    if (name === "like") return state.liked[video.id] ? ' aria-pressed="true"' : ' aria-pressed="false"';
    if (name === "later") return state.later.includes(video.id) ? ' aria-pressed="true"' : ' aria-pressed="false"';
    return "";
  };

  const following = sessionStorage.getItem("bt-track");
  const trackPrev = following ? stepInTrack(following, video, -1) : null;
  const trackNext = following ? nextInTrack(following, video) : null;
  const stepPrev = trackPrev || prev;
  const stepNext = trackNext || next;
  const keep = following ? ` data-keep-track="${esc(following)}"` : "";
  const spots = trackSpots(video.id)
    .map((spot) => `<a href="#/track/${spot.track.id}">${esc(spot.track.title)} · ${spot.n} of ${spot.total}</a>`)
    .join("");

  return `<div class="watch">
    <div>
      <div class="frame"><div id="player-host"></div></div>
      <h1>${esc(video.label)}</h1>
      ${video.title !== video.label ? `<p class="official">${esc(video.title)}</p>` : ""}
      <div class="facts">
        <span>${esc(video.channel)}</span>
        <span>${fmtDate(video.published)}</span>
        <span>${fmtLong(video.durationSec)}</span>
        ${series ? `<a href="#/series/${video.series}">${esc(series.title)}</a>` : ""}
        ${spots}
        <a href="https://www.youtube.com/watch?v=${video.id}">On YouTube</a>
      </div>
      <p class="why">${esc(video.why)}</p>
      <div class="actions">
        <button data-act="like" data-id="${video.id}"${pressed("like")}>${state.liked[video.id] ? "Liked" : "Like"}</button>
        <button data-act="later" data-id="${video.id}"${pressed("later")}>${state.later.includes(video.id) ? "In later" : "Watch later"}</button>
        <button data-act="watched" data-id="${video.id}">${done(video.id) ? "Mark unwatched" : "Mark watched"}</button>
        <button data-act="hide" data-id="${video.id}">Hide</button>
        ${stepPrev ? `<a class="ghost"${keep} href="#/watch/${stepPrev.id}">Previous</a>` : ""}
        ${stepNext ? `<a class="ghost"${keep} href="#/watch/${stepNext.id}">Next</a>` : ""}
      </div>
      ${next ? `<a class="next-banner" href="#/watch/${next.id}"><span>Next in ${esc(series.title)}<br><strong>${esc(next.label)}</strong></span><span>${fmtLong(next.durationSec)}</span></a>` : ""}
    </div>
    <aside class="related">
      ${same.length ? `<h2>${esc(series.title)}</h2><div class="list">${same.map((item) => line(item)).join("")}</div>` : ""}
      ${more.length ? `<h2>Related</h2><div class="list">${more.map((item) => line(item)).join("")}</div>` : ""}
    </aside>
  </div>`;
}

function renderAbout() {
  const hidden = Object.keys(state.hidden).length;
  return `<article class="about">
    <h1>A shelf, not a feed.</h1>
    <p>better tube is a personal version of <a href="https://karpathy.bearblog.dev/hacker-tube/">HackerTube</a>. That site keeps videos Hacker News recommends. This one keeps a narrower cut: AI engineering. Training, inference, deep learning, agents, demos, talks, and research releases.</p>
    <h2>What gets in</h2>
    <ul>
      <li>Three tracks: applied LLM, LLM researcher, and agentic engineer, each beginner to advanced, with the notebooks linked.</li>
      <li>Courses where you build the thing. CS336, Karpathy’s Zero to Hero, Umar Jamil, a trimmed CS224N, MIT 6.S191, 3Blue1Brown.</li>
      <li>Talks by the people who wrote the system. FlashAttention, vLLM, SGLang, torch.compile, and a cut of GPU MODE.</li>
      <li>Applied work, agentic systems, and harness engineering: the loop, sandbox, and checks around a model.</li>
      <li>RLVR, RL environments, and reinforcement learning for language models, including Prime Intellect.</li>
      <li>Tracks for inference, fine-tuning, architectures, and vision-language models.</li>
      <li>An app-stack track for LangChain, LangGraph, and LlamaIndex.</li>
      <li>Demos from the people who built the tool, and news briefings from named engineers.</li>
      <li>Long interviews where a researcher explains the work. Dwarkesh Patel, Latent Space, AI Engineer.</li>
    </ul>
    <h2>What you see</h2>
    <p>The picture on each card is a high-resolution frame from the middle of the video, not the uploaded poster. Posters are a setting, if you want them back. When a video ends, the next part of the same course can play. Nothing else does.</p>
    <h2>Where it lives</h2>
    <p>There is no account. Likes, watch later, history, and playback position stay in this browser. ${hidden ? hidden + " videos are hidden." : ""}</p>
    <div class="settings">
      <label class="check"><input type="checkbox" data-setting="hideFinished"${state.settings.hideFinished ? " checked" : ""}> Hide finished</label>
      <label class="check"><input type="checkbox" data-setting="posters"${state.settings.posters ? " checked" : ""}> Uploaded posters</label>
      <label class="check"><input type="checkbox" data-setting="autoplay"${state.settings.autoplay ? " checked" : ""}> Play the next one</label>
    </div>
    <div class="actions">
      <button data-act="export">Export library</button>
      <button data-act="unhide">Unhide all</button>
      <button data-act="reset">Reset this browser</button>
    </div>
    <h2>Adding to it</h2>
    <p>The list is <code>data/seed.json</code>. Add a video id, a label, and why it belongs, then run <code>python3 scripts/enrich.py</code>. That fills in the channel, date, and length from YouTube.</p>
  </article>`;
}

function renderMain() {
  const r = route();
  const path = location.hash;
  const pathChanged = path !== lastPath;
  lastPath = path;
  if (pathChanged && searchQuery) {
    searchQuery = "";
    const box = $("#q");
    if (box) box.value = "";
  }
  const searching = searchQuery.trim().length > 0;
  destroyPlayer();

  let html = "";
  if (searching) {
    const found = search(searchQuery).filter(visible);
    html = pageHead(`“${searchQuery.trim()}”`, `${found.length} on the shelf`, true) +
      (found.length ? `<div class="grid">${sortVideos(found).map(card).join("")}</div>` : `<p class="empty">Nothing on the shelf matches.</p>`);
  } else if (r.name === "home") html = renderHome();
  else if (r.name === "topic") {
    const topic = topicOf(r.arg);
    if (!topic) html = `<p class="empty">Unknown shelf.</p>`;
    else html = renderCollection(topic.label, esc(topic.blurb), catalog.videos.filter((video) => video.topics.includes(r.arg)), true);
  } else if (r.name === "series") html = renderSeries(r.arg);
  else if (r.name === "track") html = renderTrack(r.arg);
  else if (r.name === "history") {
    const list = catalog.videos
      .filter((video) => state.progress[video.id])
      .sort((a, b) => state.progress[b.id].updated - state.progress[a.id].updated);
    html = renderLines("History", "Playback position included.", list, (video) => fmt(state.progress[video.id].seconds));
  } else if (r.name === "later") {
    const list = state.later.map(byId).filter(Boolean);
    html = renderLines("Watch later", "", list);
  } else if (r.name === "liked") {
    const list = catalog.videos
      .filter((video) => state.liked[video.id])
      .sort((a, b) => state.liked[b.id] - state.liked[a.id]);
    html = renderLines("Liked", "", list);
  } else if (r.name === "about") html = renderAbout();
  else if (r.name === "watch") html = renderWatch(r.arg);
  else html = renderHome();

  $("#main").innerHTML = html;
  cursor = 0;
  paintNav();
  if (!searching && r.name === "watch" && byId(r.arg)) mountPlayer(byId(r.arg));
  if (pathChanged) window.scrollTo(0, 0);
}

function navKey() {
  const r = route();
  if (searchQuery.trim()) return "";
  if (r.name === "topic") return "topic:" + r.arg;
  if (r.name === "series") return "series:" + r.arg;
  if (r.name === "track") return "track:" + r.arg;
  if (r.name === "watch") {
    const following = sessionStorage.getItem("bt-track");
    if (following && trackById(following)) return "track:" + following;
    const video = byId(r.arg);
    if (video && video.series) return "series:" + video.series;
    if (video) return "topic:" + video.topics[0];
  }
  return r.name === "home" ? "home" : r.name;
}

function renderNav() {
  const shortName = {
    cs336: "CS336",
    z2h: "Zero to Hero",
    cs224n: "CS224N",
    mit: "MIT 6.S191",
    "3b1b": "3Blue1Brown",
    scratch: "From scratch",
    gpumode: "GPU MODE",
    harness: "Harness engineering",
  };
  const courses = Object.entries(catalog.series).map(([id, series]) =>
    `<a data-nav="series:${id}" href="#/series/${id}">${esc(shortName[id] || series.title)}</a>`
  ).join("");
  const topics = catalog.topics.map((topic) =>
    `<a data-nav="topic:${topic.id}" href="#/topic/${topic.id}">${esc(topic.label)}</a>`
  ).join("");
  $("#nav").innerHTML = `
    <div class="brand"><a href="#/">better tube</a><span>AI engineering, kept</span></div>
    <nav>
      <a data-nav="home" href="#/">For you</a>
      <div class="nav-label">Tracks</div>
      ${trackList().map((track) => `<a data-nav="track:${track.id}" href="#/track/${track.id}">${esc(track.title)}</a>`).join("")}
      <div class="nav-label">Courses</div>
      ${courses}
      <div class="nav-label">Shelves</div>
      ${topics}
      <div class="nav-label">Library</div>
      <a data-nav="history" href="#/history">History</a>
      <a data-nav="later" href="#/later">Watch later <span class="count"></span></a>
      <a data-nav="liked" href="#/liked">Liked <span class="count"></span></a>
      <a data-nav="about" href="#/about">About</a>
    </nav>
    <div class="settings">
      <label class="check"><input type="checkbox" data-setting="hideFinished"> Hide finished</label>
      <label class="check"><input type="checkbox" data-setting="posters"> Uploaded posters</label>
      <label class="check"><input type="checkbox" data-setting="autoplay" checked> Play the next one</label>
    </div>
    <p class="hint"><kbd>?</kbd> shortcuts</p>`;
  for (const input of document.querySelectorAll("[data-setting]")) {
    input.checked = !!state.settings[input.dataset.setting];
  }
}

function paintNav() {
  const key = navKey();
  document.querySelectorAll("[data-nav]").forEach((link) => {
    link.classList.toggle("is-on", link.dataset.nav === key);
  });
  const later = document.querySelector('[data-nav="later"] .count');
  const liked = document.querySelector('[data-nav="liked"] .count');
  if (later) later.textContent = state.later.length ? String(state.later.length) : "";
  if (liked) liked.textContent = Object.keys(state.liked).length ? String(Object.keys(state.liked).length) : "";
}

function ensureYouTube() {
  if (ytStarted) return;
  ytStarted = true;
  const tag = document.createElement("script");
  tag.src = "https://www.youtube.com/iframe_api";
  document.head.appendChild(tag);
  window.onYouTubeIframeAPIReady = () => {
    ytReady = true;
  };
}

function destroyPlayer() {
  if (mountedId && player) saveProgress(byId(mountedId));
  clearInterval(poll);
  poll = null;
  clearTimeout(fallbackTimer);
  if (player && player.destroy) {
    try { player.destroy(); } catch (err) { /* already gone */ }
  }
  player = null;
  mountedId = null;
}

function saveProgress(video) {
  if (!video || !player || typeof player.getCurrentTime !== "function") return;
  try {
    const seconds = player.getCurrentTime();
    const duration = player.getDuration() || video.durationSec;
    if (!seconds || !duration) return;
    state.progress[video.id] = { seconds, duration, updated: Date.now() };
    saveState();
  } catch (err) { /* player mid-destroy */ }
}

function mountPlayer(video) {
  mountedId = video.id;
  ensureYouTube();
  const startAt = (() => {
    const amount = fraction(video.id);
    const progress = state.progress[video.id];
    if (!progress || amount < 0.02 || amount > 0.9) return 0;
    return Math.floor(progress.seconds);
  })();

  const begin = () => {
    const host = $("#player-host");
    if (!host || !window.YT || !YT.Player) return false;
    player = new YT.Player("player-host", {
      videoId: video.id,
      playerVars: {
        rel: 0,
        modestbranding: 1,
        playsinline: 1,
        autoplay: sessionStorage.getItem("bt-auto") === video.id ? 1 : 0,
        start: startAt,
        origin: location.origin,
      },
      events: {
        onStateChange: (event) => {
          if (event.data === YT.PlayerState.ENDED) onEnded(video);
          if (event.data === YT.PlayerState.PAUSED) saveProgress(video);
        },
      },
    });
    sessionStorage.removeItem("bt-auto");
    poll = setInterval(() => saveProgress(video), 4000);
    return true;
  };

  if (ytReady && begin()) return;
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    if (ytReady && begin()) clearInterval(timer);
    if (tries > 40) clearInterval(timer);
  }, 150);

  fallbackTimer = setTimeout(() => {
    const host = $("#player-host");
    if (!host || (player && player.getPlayerState)) return;
    const start = startAt ? `?start=${startAt}&rel=0` : "?rel=0";
    host.innerHTML = `<iframe title="${esc(video.label)}" src="https://www.youtube-nocookie.com/embed/${video.id}${start}" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>`;
  }, 7000);
}

function onEnded(video) {
  state.progress[video.id] = {
    seconds: video.durationSec,
    duration: video.durationSec,
    updated: Date.now(),
  };
  saveState();
  const following = sessionStorage.getItem("bt-track");
  const next = (following && nextInTrack(following, video)) || nextInSeries(video);
  if (state.settings.autoplay && next) {
    sessionStorage.setItem("bt-auto", next.id);
    location.hash = `#/watch/${next.id}`;
  }
}

function toggleLike(id) {
  if (state.liked[id]) delete state.liked[id];
  else state.liked[id] = Date.now();
  saveState();
}

function toggleLater(id) {
  const index = state.later.indexOf(id);
  if (index >= 0) state.later.splice(index, 1);
  else state.later.unshift(id);
  saveState();
}

function toggleWatched(id) {
  const video = byId(id);
  if (!video) return;
  if (done(id)) delete state.progress[id];
  else state.progress[id] = { seconds: video.durationSec, duration: video.durationSec, updated: Date.now() };
  saveState();
}

function act(name, id) {
  if (name === "like") toggleLike(id);
  if (name === "later") toggleLater(id);
  if (name === "watched") toggleWatched(id);
  if (name === "hide") {
    state.hidden[id] = true;
    saveState();
    if (route().name === "watch") location.hash = "#/";
    else renderMain();
    return;
  }
  if (name === "export") {
    const blob = new Blob([JSON.stringify({ exported: new Date().toISOString(), state }, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "better-tube-library.json";
    link.click();
    return;
  }
  if (name === "unhide") {
    state.hidden = {};
    saveState();
    renderMain();
    return;
  }
  if (name === "reset") {
    if (!confirm("Clear likes, history, and watch later on this browser?")) return;
    localStorage.removeItem(KEY);
    location.reload();
    return;
  }
  if (route().name === "watch" && byId(route().arg) && route().arg === id) {
    const video = byId(id);
    const bar = $(".actions");
    if (!bar) return;
    const like = bar.querySelector('[data-act="like"]');
    const later = bar.querySelector('[data-act="later"]');
    const watched = bar.querySelector('[data-act="watched"]');
    if (like) {
      like.textContent = state.liked[id] ? "Liked" : "Like";
      like.setAttribute("aria-pressed", state.liked[id] ? "true" : "false");
    }
    if (later) {
      later.textContent = state.later.includes(id) ? "In later" : "Watch later";
      later.setAttribute("aria-pressed", state.later.includes(id) ? "true" : "false");
    }
    if (watched) watched.textContent = done(id) ? "Mark unwatched" : "Mark watched";
    paintNav();
    return;
  }
  renderMain();
}

function showHelp(open) {
  const help = $("#help");
  if (!open) {
    help.hidden = true;
    return;
  }
  help.hidden = false;
  help.innerHTML = `<div class="sheet" role="dialog" aria-label="Shortcuts">
    <h2>Shortcuts</h2>
    <ul>
      <li><span>Search</span><kbd>/</kbd></li>
      <li><span>Move through the shelf</span><kbd>j</kbd> <kbd>k</kbd></li>
      <li><span>Open</span><kbd>enter</kbd></li>
      <li><span>Back, or clear search</span><kbd>esc</kbd></li>
      <li><span>Like, on a video</span><kbd>l</kbd></li>
      <li><span>Watch later, on a video</span><kbd>w</kbd></li>
      <li><span>Next in the course</span><kbd>shift</kbd> + <kbd>n</kbd></li>
      <li><span>Close this</span><kbd>?</kbd></li>
    </ul>
  </div>`;
}

function onKey(event) {
  const typing = event.target.matches("input, textarea, select");
  if (event.key === "/" && !typing) {
    event.preventDefault();
    $("#q").focus();
    return;
  }
  if (event.key === "Escape") {
    if (!$("#help").hidden) {
      showHelp(false);
      return;
    }
    if (typing) {
      event.target.blur();
      return;
    }
    if (searchQuery) {
      searchQuery = "";
      $("#q").value = "";
      renderMain();
      return;
    }
    if (route().name === "watch") location.hash = "#/";
    return;
  }
  if (typing) return;
  if (event.key === "?") {
    showHelp($("#help").hidden);
    return;
  }
  if (event.key === "j" || event.key === "k") {
    const cards = [...document.querySelectorAll("#main a.card")];
    if (!cards.length) return;
    event.preventDefault();
    cursor += event.key === "j" ? 1 : -1;
    if (cursor < 0) cursor = cards.length - 1;
    if (cursor >= cards.length) cursor = 0;
    cards.forEach((el, index) => el.classList.toggle("is-cursor", index === cursor));
    cards[cursor].focus({ preventScroll: true });
    cards[cursor].scrollIntoView({ block: "nearest" });
  }
  const r = route();
  if (r.name === "watch" && byId(r.arg)) {
    if (event.key === "l") act("like", r.arg);
    if (event.key === "w") act("later", r.arg);
    if (event.key === "N" && event.shiftKey) {
      const video = byId(r.arg);
      const following = sessionStorage.getItem("bt-track");
      const next = (following && nextInTrack(following, video)) || nextInSeries(video);
      if (next) location.hash = `#/watch/${next.id}`;
    }
  }
}

function bind() {
  $("#q").addEventListener("input", (event) => {
    searchQuery = event.target.value;
    renderMain();
  });
  document.body.addEventListener("click", (event) => {
    const link = event.target.closest("a[href^='#/watch/']");
    if (link) {
      const keep = event.target.closest("[data-keep-track]");
      if (keep && keep.dataset.keepTrack) sessionStorage.setItem("bt-track", keep.dataset.keepTrack);
      else sessionStorage.removeItem("bt-track");
    }
    const button = event.target.closest("[data-act]");
    if (button) {
      event.preventDefault();
      act(button.dataset.act, button.dataset.id);
    }
    if (event.target.id === "help") showHelp(false);
  });
  document.body.addEventListener("change", (event) => {
    if (event.target.id === "sort") {
      sortMode = event.target.value;
      renderMain();
    }
    if (event.target.dataset.setting) {
      const key = event.target.dataset.setting;
      state.settings[key] = event.target.checked;
      saveState();
      document.querySelectorAll(`[data-setting="${key}"]`).forEach((input) => {
        input.checked = event.target.checked;
      });
      if (key !== "autoplay") renderMain();
    }
  });
  $("#main").addEventListener("error", (event) => {
    const img = event.target;
    if (img.tagName !== "IMG") return;
    bumpThumb(img);
  }, true);
  $("#main").addEventListener("load", (event) => {
    const img = event.target;
    if (img.tagName !== "IMG") return;
    if (img.naturalWidth && img.naturalWidth < 480) bumpThumb(img);
  }, true);
  document.addEventListener("keydown", onKey);
  window.addEventListener("hashchange", renderMain);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && route().name === "watch") saveProgress(byId(route().arg));
  });
}

async function init() {
  bind();
  try {
    const response = await fetch("data/catalog.json");
    if (!response.ok) throw new Error(String(response.status));
    catalog = await response.json();
  } catch (err) {
    $("#main").innerHTML = `<div class="lede"><h1>The shelf didn’t load.</h1><p>Open this folder in a local server so the catalog can be read. From the project directory: <code>python3 -m http.server</code></p></div>`;
    return;
  }
  renderNav();
  renderMain();
}

init();
