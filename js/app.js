/* ================= PMLE 闪卡应用逻辑 ================= */
"use strict";

/* ---------- 基础工具 ---------- */
const BANK = window.PMLE_BANK;
const LS_KEY = "pmle_flashcards_state_v1";
const FS_KEY = "pmle_flashcards_fs";
const DAY = 86400000;
const REQUEUE_MS = 60000; // 错题 1 分钟后重弹

/* ---------- 字号调节（只缩放阅读内容 --fs，按钮/导航/布局不受影响） ---------- */
const FS_MIN = 0.8,
  FS_MAX = 1.5,
  FS_STEP = 0.1;
let fsScale = 1;
try {
  const v = parseFloat(localStorage.getItem(FS_KEY));
  if (v >= FS_MIN && v <= FS_MAX) fsScale = v;
} catch (e) {}
function applyFs(showTip) {
  document.documentElement.style.setProperty("--fs", fsScale.toFixed(2));
  try {
    localStorage.setItem(FS_KEY, String(fsScale));
  } catch (e) {}
  const label = $("#fs-label");
  if (label) label.textContent = Math.round(fsScale * 100) + "%";
  if (showTip)
    toast(
      fsScale <= FS_MIN
        ? "Minimum font size reached"
        : fsScale >= FS_MAX
          ? "Maximum font size reached"
          : "Reading size " + Math.round(fsScale * 100) + "%"
    );
}
function fsChange(dir) {
  const next = Math.round((fsScale + dir * FS_STEP) * 10) / 10;
  fsScale = Math.min(FS_MAX, Math.max(FS_MIN, next));
  applyFs(true);
}

const $ = (s) => document.querySelector(s);
const byNum = {};
BANK.forEach((q) => (byNum[q.num] = q));

function todayKey(d) {
  const dt = d || new Date();
  const p = (n) => String(n).padStart(2, "0");
  return dt.getFullYear() + "-" + p(dt.getMonth() + 1) + "-" + p(dt.getDate());
}
function dayStart(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
}
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function stripTags(html) {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div.textContent || "";
}
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.hidden = true), 1900);
}

/* ---------- 状态 ---------- */
let S = loadState();

function defaultState() {
  return {
    cards: {}, // num -> {lv, due, wrongTotal, wrongByDay:{}, fav, lastAt}
    days: {}, // day -> {planned, done, correct, wrong, act}
    session: null,
    dailyBackup: null, // 每日任务被收藏夹会话临时顶替时的备份
    streakLast: "",
    streakCount: 0,
    corrVer: 0, // 答案修正版本号：升级后重置相关题目的旧判题记录
    updatedAt: 0, // 整体更新时间，用于跨设备合并时判断哪份更新
  };
}
function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return Object.assign(defaultState(), JSON.parse(raw));
  } catch (e) {
    console.warn("state load failed", e);
  }
  return defaultState();
}
function persist(opts) {
  S.updatedAt = Date.now();
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(S));
  } catch (e) {
    toast("⚠️ Failed to save progress locally");
  }
  if (!opts || !opts.noSync) schedulePush();
}

/* 答案修正迁移：修正过的题目，之前的判题记录是按旧答案产生的，作废重来 */
const CORR_VER = 2;
function migrateCorrections() {
  if (S.corrVer === CORR_VER) return;
  const fixedNums = BANK.filter((q) => q.fixed).map((q) => q.num);
  let touched = 0;
  fixedNums.forEach((n) => {
    const c = S.cards[n];
    if (!c) return;
    c.lv = 0;
    c.due = 0; // 立即到期 → 下次开场进入复习
    c.wrongTotal = 0;
    c.wrongByDay = {};
    touched++;
  });
  S.corrVer = CORR_VER;
  persist();
  if (touched) toast(`Reset stale records for ${touched} corrected question(s)`);
}
function card(num) {
  if (!S.cards[num])
    S.cards[num] = {
      lv: 0,
      due: 0,
      wrongTotal: 0,
      wrongByDay: {},
      fav: 0,
      lastAt: 0,
    };
  return S.cards[num];
}
function ensureDay(key) {
  const k = key || todayKey();
  if (!S.days[k])
    S.days[k] = { planned: 20, done: 0, correct: 0, wrong: 0, act: 0 };
  return S.days[k];
}
function updateStreak() {
  const t = todayKey();
  if (S.streakLast === t) return;
  const y = todayKey(new Date(Date.now() - DAY));
  S.streakCount = S.streakLast === y ? S.streakCount + 1 : 1;
  S.streakLast = t;
}

/* ---------- SM-2 简化间隔：已掌握后 1d → 3d → 7d → 21d ---------- */
const INTERVALS = [1, 3, 7, 21];
function masteredDue(lv) {
  const i = Math.min(Math.max(lv, 1), INTERVALS.length) - 1;
  return Date.now() + INTERVALS[i] * DAY;
}

/* ---------- 视图切换 ---------- */
const VIEWS = ["home", "quiz", "result", "bank", "stats", "sync"];
let currentView = "home";
function show(view) {
  currentView = view;
  VIEWS.forEach((v) => {
    $("#view-" + v).hidden = v !== view;
  });
  document.querySelectorAll(".nav-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === view);
  });
  window.scrollTo(0, 0);
}
document.querySelectorAll(".nav-btn").forEach((b) => {
  b.addEventListener("click", () => {
    if (b.dataset.view === "home") renderHome();
    if (b.dataset.view === "bank") renderBank();
    if (b.dataset.view === "stats") renderStats();
    if (b.dataset.view === "sync") {
      renderSyncView();
      if (sync.token && sync.auto && !sync.busy) syncNow({ silent: true });
    }
    show(b.dataset.view);
  });
});

/* ---------- 首页 ---------- */
function reviewDueNums() {
  const now = Date.now();
  return BANK.filter((q) => {
    const c = S.cards[q.num];
    return c && c.due > 0 && c.due <= now;
  }).map((q) => q.num);
}
function unseenNums() {
  return BANK.filter((q) => !S.cards[q.num]).map((q) => q.num);
}
function favNums() {
  return BANK.filter((q) => S.cards[q.num] && S.cards[q.num].fav).map(
    (q) => q.num
  );
}
function activeSession() {
  return S.session && S.session.date === todayKey() ? S.session : null;
}

function renderHome() {
  const t = todayKey();
  const day = ensureDay();
  const sess = activeSession();

  const now = new Date();
  $("#home-date").textContent = now.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  let progressHtml, mainLabel;
  if (sess) {
    const remaining = sessionRemaining(sess);
    progressHtml = `Daily session in progress <small>(${remaining} cards left)</small>`;
    mainLabel = "Resume session";
    $("#btn-more20").hidden = true;
  } else if (day.done >= day.planned) {
    progressHtml = `Today: <span>${day.done}</span> / ${day.planned} new questions done <small>🎉</small>`;
    mainLabel = unseenNums().length ? "20 more questions" : "All caught up today";
    $("#btn-more20").hidden = false;
  } else {
    progressHtml = `Today: <span>${day.done}</span> / ${day.planned} new questions done`;
    mainLabel = "Start today's 20";
    $("#btn-more20").hidden = true;
  }
  $("#home-progress").innerHTML = progressHtml;
  const btn = $("#btn-main-action");
  btn.textContent = mainLabel;
  btn.disabled = mainLabel === "All caught up today";

  const due = reviewDueNums();
  const yk = todayKey(new Date(Date.now() - DAY));
  let yWrong = 0;
  Object.keys(S.cards).forEach((n) => {
    const c = S.cards[n];
    if (c.wrongByDay && c.wrongByDay[yk]) yWrong++;
  });
  $("#home-review").innerHTML =
    (due.length
      ? `Warm-up first: <b>${due.length}</b> due / yesterday's unmastered questions`
      : "No reviews due today — straight to new questions") +
    ` (missed yesterday: ${yWrong})`;

  renderHomeMeta();

  renderHeatmap();
  renderHomeStats();
}

function sessionRemaining(s) {
  return s.queue.length - s.pos + s.requeue.length + s.cram.length;
}

function renderHomeStats() {
  let lv0weak = 0,
    lv12 = 0,
    lv34 = 0,
    correct = 0,
    wrong = 0,
    touched = 0;
  Object.keys(S.cards).forEach((n) => {
    touched++;
    const c = S.cards[n];
    if (c.lv >= 3) lv34++;
    else if (c.lv >= 1) lv12++;
    else if (c.wrongTotal > 0) lv0weak++;
  });
  Object.values(S.days).forEach((d) => {
    correct += d.correct || 0;
    wrong += d.wrong || 0;
  });
  const acc = correct + wrong ? Math.round((correct / (correct + wrong)) * 100) : 0;
  $("#home-stats").innerHTML = `
    <div class="stat-row"><span>Questions attempted</span><b>${touched}</b></div>
    <div class="stat-row"><span>Overall accuracy</span><b>${acc}%</b></div>
    <div class="stat-row"><span>Mastered (7/21-day intervals)</span><b>${lv34}</b></div>
    <div class="stat-row"><span>Reviewing (1/3-day intervals)</span><b>${lv12}</b></div>
    <div class="stat-row"><span>Not mastered</span><b>${lv0weak}</b></div>`;
}

function renderHeatmap() {
  const wrap = $("#heatmap");
  wrap.innerHTML = "";
  const today = new Date();
  const start = new Date(today.getTime() - 83 * DAY);
  start.setDate(start.getDate() - start.getDay()); // 对齐周日
  const tKey = todayKey();
  for (let d = new Date(start); d <= today; d = new Date(d.getTime() + DAY)) {
    const k = todayKey(d);
    const cell = document.createElement("div");
    cell.className = "hm-cell";
    const dd = S.days[k];
    const act = dd ? dd.correct + dd.wrong : 0;
    if (act >= 40) cell.classList.add("hm-l4");
    else if (act >= 20) cell.classList.add("hm-l3");
    else if (act >= 5) cell.classList.add("hm-l2");
    else if (act >= 1) cell.classList.add("hm-l1");
    if (k === tKey) cell.classList.add("hm-today");
    cell.title = `${k}: ${act} answer${act === 1 ? "" : "s"}`;
    wrap.appendChild(cell);
  }
  $("#streak-line").innerHTML = `Current streak: <b>${S.streakCount}</b> day${S.streakCount === 1 ? "" : "s"}`;
}

/* ---------- 会话构建 ---------- */
function startDailySession() {
  const t = todayKey();
  const day = ensureDay();
  const sess = activeSession();
  if (sess) {
    show("quiz");
    renderCurrent();
    return;
  }
  const review = reviewDueNums();
  const remaining = day.planned - day.done;
  let fresh = [];
  if (remaining > 0) fresh = unseenNums().slice(0, remaining);
  const queue = review.concat(fresh);
  if (!queue.length) {
    toast("Nothing left to practice 🎉");
    return;
  }
  S.session = {
    date: t,
    mode: "daily",
    queue,
    pos: 0,
    requeue: [], // {num, at}
    cram: [], // 3 次以上答错的攻坚区
    total: queue.length,
    resolved: [],
    startTs: Date.now(),
  };
  S.dailyBackup = null;
  persist();
  show("quiz");
  renderCurrent();
}

function addTwentyMore() {
  const t = todayKey();
  const day = ensureDay();
  const fresh = unseenNums().slice(0, 20);
  if (!fresh.length) return toast("No more new questions to add 🎉");
  const sess = activeSession();
  if (sess && sess.mode === "daily") {
    sess.queue.push(...fresh);
    sess.total += fresh.length;
    day.planned += fresh.length;
    toast(`Added ${fresh.length} new questions`);
    persist();
    if (currentView === "quiz") renderCurrent();
  } else {
    day.planned += fresh.length;
    S.session = {
      date: t,
      mode: "daily",
      queue: fresh,
      pos: 0,
      requeue: [],
      cram: [],
      total: fresh.length,
      resolved: [],
    startTs: Date.now(),
    };
    S.dailyBackup = null;
    persist();
    show("quiz");
    renderCurrent();
  }
}

function startFavSession() {
  const nums = favNums();
  if (!nums.length) return toast("No bookmarks yet — tap ☆ in a quiz or the bank first");
  const sess = activeSession();
  if (sess && sess.mode === "daily") S.dailyBackup = sess; // 暂存每日任务
  S.session = {
    date: todayKey(),
    mode: "fav",
    queue: nums.slice(),
    pos: 0,
    requeue: [],
    cram: [],
    total: nums.length,
    resolved: [],
    startTs: Date.now(),
  };
  persist();
  show("quiz");
  renderCurrent();
}

/* ---------- 答题渲染 ---------- */
let cur = null; // {num, fromQueue, retry, cram, firstTouch, flipped, picked:Set, answered, wasCorrect}

function sessionCurrent() {
  const s = S.session;
  if (!s) return null;
  const now = Date.now();
  // 跳过本轮已彻底解决的队列题（重弹解决过的不再重复出现）
  while (
    s.pos < s.queue.length &&
    s.resolved &&
    s.resolved.includes(s.queue[s.pos])
  )
    s.pos++;
  const dueIdx = s.requeue.findIndex((r) => r.at <= now);
  if (dueIdx >= 0) {
    const r = s.requeue.splice(dueIdx, 1)[0];
    return { num: r.num, fromQueue: false, retry: true };
  }
  if (s.pos < s.queue.length)
    return { num: s.queue[s.pos], fromQueue: true, retry: false };
  if (s.requeue.length)
    return { wait: Math.min(...s.requeue.map((r) => r.at)) - now };
  if (s.cram.length)
    return { num: s.cram.shift(), fromQueue: false, retry: true, cram: true };
  return null;
}

function resolveCard(num) {
  const s = S.session;
  if (s) {
    if (!s.resolved) s.resolved = [];
    if (!s.resolved.includes(num)) s.resolved.push(num);
  }
}

let waitTimer = null;
function renderCurrent() {
  const s = S.session;
  if (!s) return show("home");
  const item = sessionCurrent();
  if (!item) return finishSession();
  if (item.wait !== undefined) {
    renderWait(item.wait);
    return;
  }
  const firstTouch = !S.cards[item.num];
  cur = {
    num: item.num,
    fromQueue: !!item.fromQueue,
    retry: !!item.retry,
    cram: !!item.cram,
    firstTouch,
    picked: new Set(),
    answered: false,
    wasCorrect: false,
  };
  renderCard();
}

function renderWait(ms) {
  const area = $("#quiz-area");
  const sec = Math.ceil(ms / 1000);
  area.innerHTML = `
    <div class="qface" style="text-align:center;padding:60px 20px">
      <div style="font-size:46px;font-weight:800;color:var(--pri-d)">${sec}</div>
      <p style="color:var(--ink-2);font-size:15px;margin-top:12px">Missed cards will reappear soon… (lock them in!)</p>
      <button class="btn btn-outline" id="wait-quit">Exit for now</button>
    </div>`;
  $("#wait-quit").addEventListener("click", () => {
    show("home");
    renderHome();
  });
  clearTimeout(waitTimer);
  waitTimer = setTimeout(renderCurrent, Math.min(Math.max(ms, 500), 3000));
}

function renderCard() {
  const q = byNum[cur.num];
  const c = card(cur.num); // 注意：card() 会创建条目，firstTouch 已提前捕获
  const s = S.session;
  const isMulti = !!q.multi;
  const remaining = sessionRemaining(s);
  const processed = s.total - remaining;

  $("#quiz-mode-label").innerHTML =
    `<span class="tag">${s.mode === "fav" ? "Bookmarks" : "Daily set"}</span>` +
    (cur.cram ? '<span class="tag" style="background:var(--gold);color:#5b3a00">Cram zone</span>' : "");
  $("#quiz-count").textContent = `Done ${processed}/${s.total} · ${remaining} left`;
  $("#quiz-progress").style.width =
    Math.min(100, (processed / Math.max(s.total, 1)) * 100).toFixed(1) + "%";
  $("#btn-fav-toggle").textContent = c.fav ? "★" : "☆";
  $("#btn-fav-toggle").classList.toggle("faved", !!c.fav);

  const area = $("#quiz-area");
  const badges = [];
  if (q.isNew) badges.push('<span class="badge new">New (402)</span>');
  if (q.fixed) badges.push('<span class="badge fixed">Answer corrected</span>');
  if (isMulti) badges.push('<span class="badge multi">Multi-select</span>');
  if (cur.retry) badges.push('<span class="badge retry">Retry</span>');
  if (c.lv >= 3) badges.push('<span class="badge">Mastered</span>');
  else if (c.lv >= 1) badges.push('<span class="badge">Reviewing</span>');

  const optsFront = q.opts
    .map(
      (o) => `
      <button class="qoptbtn" data-lt="${o.letter}">
        <span class="lt">${o.letter}</span>
        <span class="otext">${o.html}</span>
      </button>`
    )
    .join("");

  const frontActions = isMulti
    ? `<div class="multisubmit"><button id="btn-submit-multi" class="btn btn-primary">Submit answer (<span id="picked-n">0</span> selected)</button></div>`
    : "";
  const skipBtn = `<button class="btn btn-ghost" id="btn-skip">Skip for now</button>`;

  area.innerHTML = `
    <div class="flip-wrap">
      <div class="qcard" id="qcard">
        <div class="qface qface-front">
          <div class="qnum-line">
            <span class="qnum">QUESTION ${q.num}</span>
            <span class="badges">${badges.join("")}</span>
          </div>
          <div class="qstem">${q.stem}</div>
          <div class="opts" id="opts-front">${optsFront}</div>
          ${frontActions}
          <div class="quiz-actions">${skipBtn}</div>
        </div>
        <div class="qface qface-back" id="qface-back"></div>
      </div>
    </div>`;

  $("#btn-skip").addEventListener("click", () => {
    if (!cur.answered) {
      // 未作答跳过：放回队尾
      S.session.queue.push(cur.num);
      persist();
      advance(false);
    } else {
      appSkipAnswered();
    }
  });

  if (isMulti) {
    area.querySelectorAll(".qoptbtn").forEach((b) => {
      b.addEventListener("click", () => {
        const lt = b.dataset.lt;
        if (cur.picked.has(lt)) {
          cur.picked.delete(lt);
          b.classList.remove("picked");
        } else {
          cur.picked.add(lt);
          b.classList.add("picked");
        }
        const pn = $("#picked-n");
        if (pn) pn.textContent = cur.picked.size;
      });
    });
    $("#btn-submit-multi").addEventListener("click", () => {
      if (!cur.picked.size) return toast("Pick at least one option first");
      submitAnswer([...cur.picked]);
    });
  } else {
    area.querySelectorAll(".qoptbtn").forEach((b) => {
      b.addEventListener("click", () => submitAnswer([b.dataset.lt]));
    });
  }
}

function submitAnswer(picks) {
  const q = byNum[cur.num];
  const c = card(cur.num);
  const s = S.session;
  const t = todayKey();
  const day = ensureDay();

  const ansSet = new Set(q.answer.split(""));
  const pickSet = new Set(picks);
  let correct = true;
  ansSet.forEach((a) => {
    if (!pickSet.has(a)) correct = false;
  });
  pickSet.forEach((a) => {
    if (!ansSet.has(a)) correct = false;
  });

  cur.answered = true;
  cur.wasCorrect = correct;
  cur.picked = pickSet;

  // 统计
  day.act++;
  if (s.mode === "daily") {
    if (correct) day.correct++;
    else day.wrong++;
    if (cur.firstTouch) day.done++; // 新题额度：首次作答即消耗
  }
  if (!correct) {
    c.wrongTotal++;
    c.wrongByDay[t] = (c.wrongByDay[t] || 0) + 1;
    c.lv = 0;
  }
  c.lastAt = Date.now();
  updateStreak();
  persist();
  renderBack(correct);
}

function renderBack(correct) {
  const q = byNum[cur.num];
  const day = ensureDay();
  const wrongCntToday = card(cur.num).wrongByDay[todayKey()] || 0;

  const marked = q.opts
    .map((o) => {
      const isAns = q.answer.includes(o.letter);
      const isPick = cur.picked.has(o.letter);
      let cls = "";
      let mark = "";
      if (isAns) {
        cls = "correct";
        mark = "✓";
      }
      if (isPick && !isAns) {
        cls = "wrongpick";
        mark = "✗";
      }
      return `<div class="qopt-marked ${cls}">
        <span class="lt">${o.letter}</span>
        <span class="otext">${o.html}</span><span class="mark">${mark}</span>
      </div>`;
    })
    .join("");

  const zhOpts = (q.zh && q.zh.opts ? q.zh.opts : [])
    .map((o) => `<p class="zopt"><span class="zlt">${o.letter}.</span>${o.html}</p>`)
    .join("");

  const pdfExpl = q.explEn
    ? `<details class="pdf-expl"><summary>📄 Original PDF explanation (tap to expand)</summary>
        <div class="bbody">${esc(q.explEn)}</div></details>`
    : "";

  const verdict = correct
    ? `<div class="verdict ok">✅ Correct — do you know it cold?</div>`
    : `<div class="verdict no">❌ Wrong · Correct answer: ${q.answer}</div>`;

  let note = "";
  let actions = "";
  if (correct) {
    actions = `
      <button class="btn btn-green" id="btn-mastered">Mastered</button>
      <button class="btn btn-red" id="btn-notmastered">Not mastered (retry in 1 min)</button>`;
  } else if (wrongCntToday >= 3) {
    note = `<div class="requeue-note">Missed ${wrongCntToday} times today — moved to the <b>end-of-round cram zone</b> instead of re-popping every minute.</div>`;
    actions = `<button class="btn btn-primary" id="btn-nextq">Next question</button>`;
  } else {
    note = `<div class="requeue-note">Queued for retry: reappears <b>in about 1 minute</b> until you answer it right and tap "Mastered".</div>`;
    actions = `<button class="btn btn-primary" id="btn-nextq">Next question</button>`;
  }

  $("#qface-back").innerHTML = `
    <div class="qnum-line">
      <span class="qnum">QUESTION ${q.num} · Answer</span>
    </div>
    <div class="back-grid">
      <div class="back-col">
        <div class="qstem">${q.stem}</div>
        ${verdict}
        <div class="backsec">
          <h4>Answer key (green = correct, red = your wrong pick)</h4>
          ${marked}
        </div>
      </div>
      <div class="back-col">
        ${
          q.zh && q.zh.stem
            ? `<div class="backsec">
          <h4>Chinese Translation 中文翻译</h4>
          <div class="bbody zho">
            <p style="margin-bottom:6px"><b>Question 题干</b></p>
            ${q.zh.stem}
            <p style="margin:8px 0 4px"><b>Options 选项</b></p>
            ${zhOpts}
          </div>
        </div>`
            : ""
        }
        <div class="backsec">
          <h4>Explanation 精讲</h4>
          <div class="ex-content">
            ${q.core ? `<div class="core-chip">${q.core}</div>` : ""}
            ${q.ex}
            ${pdfExpl}
            ${q.ref ? `<p style="font-size:12px;color:var(--ink-2)">Reference: ${esc(q.ref)}</p>` : ""}
          </div>
        </div>
      </div>
    </div>
    ${note}
    <div class="quiz-actions">${actions}</div>`;

  $("#qcard").classList.add("flipped");

  if (correct) {
    $("#btn-mastered").addEventListener("click", () => mastered(true));
    $("#btn-notmastered").addEventListener("click", () => mastered(false));
  } else {
    $("#btn-nextq").addEventListener("click", registerWrong);
  }
  $("#qface-back").scrollTop = 0;
}

/* ---------- 判定后的流转 ---------- */
function registerWrong() {
  const s = S.session;
  const num = cur.num;
  const wrongCntToday = card(num).wrongByDay[todayKey()] || 0;
  if (cur.cram) {
    // 攻坚区里仍答错：移出本轮，置顶明日复习（保证会话可收尾）
    card(num).due = dayStart(todayKey()) + DAY + 5 * 60000;
    resolveCard(num);
  } else if (wrongCntToday >= 3) {
    // 同一题今天第 3 次答错：不再 1 分钟硬弹，放入本轮结束攻坚区
    s.cram.push(num);
  } else {
    s.requeue.push({ num, at: Date.now() + REQUEUE_MS });
  }
  persist();
  advance(cur.fromQueue);
}

function mastered(ok) {
  const s = S.session;
  const num = cur.num;
  const c = card(num);
  if (ok) {
    c.lv = Math.min(c.lv + 1, 4);
    c.due = masteredDue(c.lv); // 1d → 3d → 7d → 21d
    delete c.wrongByDay[todayKey()]; // 今日最终掌握：撤出明日复习队列
    resolveCard(num);
  } else {
    c.lv = 0;
    c.wrongByDay[todayKey()] = Math.max(c.wrongByDay[todayKey()] || 0, 1);
    s.requeue.push({ num, at: Date.now() + REQUEUE_MS });
  }
  c.lastAt = Date.now();
  persist();
  advance(cur.fromQueue);
}

function appSkipAnswered() {
  // 已作答但没点已掌握/下一题就跳过
  if (cur.wasCorrect) {
    mastered(true); // 视为已掌握
  } else {
    registerWrong();
  }
}

function advance(fromQueue) {
  const s = S.session;
  if (fromQueue) s.pos++;
  persist();
  renderCurrent();
}

/* ---------- 会话结束 ---------- */
function finishSession() {
  const s = S.session;
  const t = todayKey();
  const day = ensureDay();

  // 收尾：今日答错且最终未掌握的题 → 明天 00:05 置顶复习
  Object.keys(S.cards).forEach((n) => {
    const c = S.cards[n];
    if (c.wrongByDay && c.wrongByDay[t]) {
      c.due = dayStart(t) + DAY + 5 * 60000;
    }
  });

  const isFav = s.mode === "fav";
  S.session = isFav ? S.dailyBackup || null : null;
  if (!isFav) S.dailyBackup = null;
  persist();

  const correctToday = day.correct;
  const wrongToday = day.wrong;
  const acc =
    correctToday + wrongToday
      ? Math.round((correctToday / (correctToday + wrongToday)) * 100)
      : 0;

  const dueTomorrow = Object.keys(S.cards).filter((n) => {
    const c = S.cards[n];
    return c.due > 0 && c.due <= dayStart(t) + 2 * DAY;
  });
  const preview = dueTomorrow.slice(0, 6);

  $("#result-title").textContent = isFav
    ? "Bookmarks cleared 🎉"
    : day.done >= day.planned
      ? "Daily goal complete 🎉"
      : "Round complete";
  $("#result-body").innerHTML = `
    <div class="big-nums">
      <div class="bn"><b>${s.total}</b><span>Cards handled</span></div>
      <div class="bn ok"><b>${correctToday}</b><span>Correct today</span></div>
      <div class="bn bad"><b>${wrongToday}</b><span>Missed today</span></div>
      <div class="bn"><b>${acc}%</b><span>Accuracy today</span></div>
    </div>
    <div class="tomorrow-box">
      <b>Tomorrow's warm-up</b>: <b>${dueTomorrow.length}</b> due / unmastered questions first${
        preview.length ? ` (incl. Q${preview.join(", Q")}…)` : ""
      }.<br>
      Questions missed and still unmastered get <b>pinned tomorrow morning</b>; mastered ones cycle back at 1 / 3 / 7 / 21-day intervals.
    </div>
    <p style="color:var(--ink-2);font-size:13px">Today's new-question quota ${day.done} / ${day.planned}${
      isFav ? " (bookmarks don't use quota)" : day.done < day.planned ? " · progress saved — resume anytime" : " · quota complete 🎉"
    }</p>`;

  $("#btn-result-more20").hidden = isFav;
  show("result");
}

/* ---------- 事件绑定 ---------- */
$("#quiz-exit").addEventListener("click", () => {
  // 中途退出：进度实时保存（断点记忆），可随时继续
  show("home");
  renderHome();
});
$("#btn-main-action").addEventListener("click", () => {
  const day = ensureDay();
  if (activeSession()) startDailySession();
  else if (day.done >= day.planned) addTwentyMore();
  else startDailySession();
});
$("#btn-more20").addEventListener("click", addTwentyMore);
$("#btn-result-more20").addEventListener("click", addTwentyMore);
$("#btn-result-home").addEventListener("click", () => {
  renderHome();
  show("home");
});
$("#btn-fav-run").addEventListener("click", startFavSession);
  $("#btn-fav-toggle").addEventListener("click", () => {
  if (!cur) return;
  const c = card(cur.num);
  c.fav = c.fav ? 0 : 1;
  c.lastAt = Date.now(); // 让收藏/取消收藏参与跨设备合并的"谁更新"判断
  persist();
  $("#btn-fav-toggle").textContent = c.fav ? "★" : "☆";
  $("#btn-fav-toggle").classList.toggle("faved", !!c.fav);
  toast(c.fav ? "Bookmarked ⭐" : "Bookmark removed");
});

/* ---------- 键盘快捷键（电脑端） ---------- */
document.addEventListener("keydown", (e) => {
  if (currentView !== "quiz" || !cur) return;
  if (e.target.tagName === "INPUT") return;
  if (!cur.answered) {
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= 6) {
      const letter = "ABCDEF"[n - 1];
      const btn = document.querySelector(`.qoptbtn[data-lt="${letter}"]`);
      if (btn) btn.click();
    }
    if (e.key === "Enter" && byNum[cur.num].multi) {
      const b = $("#btn-submit-multi");
      if (b) b.click();
    }
    if (e.key.toLowerCase() === "s") $("#btn-skip")?.click();
  } else if (cur.wasCorrect) {
    if (e.key.toLowerCase() === "m") $("#btn-mastered")?.click();
    if (e.key.toLowerCase() === "x") $("#btn-notmastered")?.click();
    if (e.key === "Enter" || e.key === " ") $("#btn-mastered")?.click();
  } else {
    if (e.key === "Enter" || e.key === " ") $("#btn-nextq")?.click();
  }
});

/* ---------- 题库页 ---------- */
let bankFilter = "all";
let bankSearch = "";

function statusOf(num) {
  const c = S.cards[num];
  if (!c) return { txt: "Unseen", cls: "new" };
  if (c.lv >= 3) return { txt: "Mastered", cls: "lv3" };
  if (c.lv >= 1) return { txt: "Reviewing", cls: "lv2" };
  if (c.wrongTotal > 0) return { txt: "Weak", cls: "weak" };
  return { txt: "Seen", cls: "lv1" };
}

function renderBank() {
  const list = $("#bank-list");
  const now = Date.now();
  const items = BANK.filter((q) => {
    const c = S.cards[q.num];
    switch (bankFilter) {
      case "unseen":
        return !c;
      case "weak":
        return c && c.lv === 0 && c.wrongTotal > 0;
      case "due":
        return c && c.due > 0 && c.due <= now;
      case "fav":
        return c && c.fav;
      case "new":
        return !!q.isNew;
      case "img":
        return !!q.hasImg;
      default:
        return true;
    }
  }).filter((q) => {
    if (!bankSearch) return true;
    const k = bankSearch.toLowerCase();
    const hay = (
      q.stem +
      q.opts.map((o) => o.html).join(" ") +
      (q.zh ? q.zh.stem + q.zh.opts.map((o) => o.html).join(" ") : "") +
      (q.core || "") +
      stripTags(q.ex)
    ).toLowerCase();
    return hay.includes(k) || String(q.num) === k;
  });

  if (!items.length) {
    list.innerHTML = '<div class="panel">No questions match this filter.</div>';
    return;
  }
  list.innerHTML = items
    .map((q) => {
      const st = statusOf(q.num);
      const c = S.cards[q.num];
      return `<div class="bank-item" data-num="${q.num}">
        <div class="bi-top">
          <span class="bi-num">Q${q.num}</span>
          <span class="bi-status ${st.cls}">${st.txt}</span>
          ${q.isNew ? '<span class="bi-status new">New</span>' : ""}
          ${q.multi ? '<span class="bi-status" style="background:#efe7ff;color:#5b3f9e">Multi</span>' : ""}
          ${c && c.fav ? '<span class="bi-fav">★</span>' : ""}
          <span style="flex:1"></span>
          <span class="bi-status">Answer ${q.answer}</span>
        </div>
        <div class="bi-stem">${esc(stripTags(q.stem).slice(0, 90))}…</div>
      </div>`;
    })
    .join("");
  list.querySelectorAll(".bank-item").forEach((el) => {
    el.addEventListener("click", () => openBankDetail(Number(el.dataset.num)));
  });
}

function openBankDetail(num) {
  document.querySelector(".bank-detail")?.remove();
  const q = byNum[num];
  const c = card(num);
  const st = statusOf(num);
  const marked = q.opts
    .map((o) => {
      const isAns = q.answer.includes(o.letter);
      return `<div class="qopt-marked ${isAns ? "correct" : ""}">
        <span class="lt">${o.letter}</span>
        <span class="otext">${o.html}</span>
        <span class="mark">${isAns ? "✓" : ""}</span>
      </div>`;
    })
    .join("");
  const zhOpts = (q.zh && q.zh.opts ? q.zh.opts : [])
    .map((o) => `<p class="zopt"><span class="zlt">${o.letter}.</span>${o.html}</p>`)
    .join("");
  const overlay = document.createElement("div");
  overlay.className = "bank-detail";
  overlay.innerHTML = `
    <div class="bd-card">
      <button class="bd-close">✕</button>
      <div class="qnum-line">
        <span class="qnum">QUESTION ${q.num}</span>
        <span class="bi-status ${st.cls}">${st.txt}</span>
        ${q.isNew ? '<span class="bi-status new">New (402)</span>' : ""}
        ${q.fixed ? '<span class="bi-status fixed">Answer corrected</span>' : ""}
        ${q.multi ? '<span class="bi-status" style="background:#efe7ff;color:#5b3f9e">Multi</span>' : ""}
      </div>
      <div class="back-grid">
        <div class="back-col">
          <div class="qstem">${q.stem}</div>
          <div class="backsec"><h4>Answer</h4>${marked}</div>
        </div>
        <div class="back-col">
          ${
            q.zh && q.zh.stem
              ? `<div class="backsec"><h4>Chinese Translation 中文翻译</h4><div class="bbody zho">${q.zh.stem}<p style="margin:8px 0 4px"><b>Options 选项</b></p>${zhOpts}</div></div>`
              : ""
          }
          <div class="backsec">
            <h4>Explanation 精讲</h4>
            <div class="ex-content">${q.core ? `<div class="core-chip">${q.core}</div>` : ""}${q.ex}
            ${
              q.explEn
                ? `<details class="pdf-expl"><summary>📄 Original PDF explanation</summary><div class="bbody">${esc(q.explEn)}</div></details>`
                : ""
            }
            ${q.ref ? `<p style="font-size:12px;color:var(--ink-2)">Reference: ${esc(q.ref)}</p>` : ""}</div>
          </div>
        </div>
      </div>
      <div class="quiz-actions">
        <button class="btn ${c.fav ? "btn-gold" : "btn-outline"}" id="bd-fav"><span class="bigstar">${c.fav ? "★" : "☆"}</span> ${c.fav ? "Bookmarked" : "Bookmark"}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
  overlay.querySelector(".bd-close").addEventListener("click", () => overlay.remove());
  overlay.querySelector("#bd-fav").addEventListener("click", () => {
    c.fav = c.fav ? 0 : 1;
    c.lastAt = Date.now();
    persist();
    renderBank();
    overlay.remove();
    openBankDetail(num);
  });
}

$("#bank-search").addEventListener("input", (e) => {
  bankSearch = e.target.value.trim();
  renderBank();
});
document.querySelectorAll("#bank-filters .chip").forEach((b) => {
  b.addEventListener("click", () => {
    document
      .querySelectorAll("#bank-filters .chip")
      .forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    bankFilter = b.dataset.filter;
    renderBank();
  });
});

/* ---------- 导入导出 ---------- */
$("#btn-export").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(S)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `pmle-flashcards-progress-${todayKey()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast("Progress exported (use it to restore on another device)");
});
$("#btn-import").addEventListener("click", () => $("#import-file").click());
$("#import-file").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const data = JSON.parse(r.result);
      if (!data.cards || !data.days) throw new Error("bad format");
      S = Object.assign(defaultState(), data);
      persist();
      toast("Progress imported ✓");
      renderBank();
      renderHome();
    } catch (err) {
      toast("Import failed: invalid file format");
    }
  };
  r.readAsText(f);
  e.target.value = "";
});

/* ---------- 跨设备同步（GitHub 私密 Gist） ---------- */
const SYNC_TOKEN_KEY = "pmle_flashcards_gh_token_v1";
const SYNC_GIST_KEY = "pmle_flashcards_gist_id_v1";
const SYNC_AUTO_KEY = "pmle_flashcards_sync_auto_v1";
const GIST_FILE = "pmle-progress.json";
const GIST_DESC = "PMLE-FLASHCARDS-SYNC (private progress)";
const GH_API = "https://api.github.com";

const sync = {
  token: "",
  gistId: "",
  auto: true,
  busy: false,
  lastSync: 0,
  pulledAt: 0, // 本会话成功拉取云端状态的时间；为 0 时禁止上传，避免旧数据覆盖云端
  lastError: "",
  remoteInfo: null, // 最近一次同步时云端存档的快照 {cards, favs, updatedAt}；null 表示云端尚无存档
};
try {
  sync.token = localStorage.getItem(SYNC_TOKEN_KEY) || "";
  sync.gistId = localStorage.getItem(SYNC_GIST_KEY) || "";
  const a = localStorage.getItem(SYNC_AUTO_KEY);
  sync.auto = a === null ? true : a === "1";
} catch (e) {}

function ghFetch(path, opts) {
  const o = opts || {};
  const headers = Object.assign(
    {
      Accept: "application/vnd.github+json",
      Authorization: "Bearer " + sync.token,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    o.body ? { "Content-Type": "application/json" } : {},
    o.headers || {}
  );
  return fetch(GH_API + path, {
    method: o.method || "GET",
    headers,
    body: o.body,
    cache: "no-store",
  }).then((res) => {
    if (res.ok) return res.json();
    const map = {
      401: "Token invalid or expired (401)",
      403: "Permission denied or rate-limited (403) — make sure the token has the gist scope",
      404: "Cloud archive not found (404)",
    };
    const err = new Error(map[res.status] || res.status + " " + res.statusText);
    err.status = res.status;
    throw err;
  });
}

async function locateGist() {
  if (sync.gistId) {
    try {
      return await ghFetch("/gists/" + sync.gistId);
    } catch (e) {
      if (e.status !== 404) throw e;
      sync.gistId = "";
      localStorage.removeItem(SYNC_GIST_KEY);
    }
  }
  const list = await ghFetch("/gists?per_page=100");
  const found = (list || []).find(
    (g) => g.description === GIST_DESC || (g.files && g.files[GIST_FILE])
  );
  if (found) {
    sync.gistId = found.id;
    localStorage.setItem(SYNC_GIST_KEY, found.id);
    return found;
  }
  return null;
}

async function readGistState(g) {
  const f = g && g.files && g.files[GIST_FILE];
  if (!f) return null;
  let content = f.content;
  if (f.truncated && f.raw_url) {
    const r = await fetch(f.raw_url, {
      headers: { Authorization: "Bearer " + sync.token, Accept: "application/vnd.github.raw" },
      cache: "no-store",
    });
    if (r.ok) content = await r.text();
  }
  try {
    const d = JSON.parse(content);
    return d && d.state ? d.state : d;
  } catch (e) {
    return null;
  }
}

function gistPayload() {
  return JSON.stringify({ v: 2, savedAt: Date.now(), state: S });
}

async function pushState() {
  const g = await locateGist();
  if (!g) {
    const created = await ghFetch("/gists", {
      method: "POST",
      body: JSON.stringify({
        description: GIST_DESC,
        public: false,
        files: { [GIST_FILE]: { content: gistPayload() } },
      }),
    });
    sync.gistId = created.id;
    localStorage.setItem(SYNC_GIST_KEY, created.id);
    return;
  }
  await ghFetch("/gists/" + sync.gistId, {
    method: "PATCH",
    body: JSON.stringify({ files: { [GIST_FILE]: { content: gistPayload() } } }),
  });
}

let pushTimer = null;
function schedulePush() {
  if (!sync.token || !sync.auto) return;
  // 必须先成功拉取过一次云端状态，才允许上传：
  // 否则一台设备用旧进度覆盖云端，会把另一台设备的进度冲掉。
  if (!sync.pulledAt) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushState()
      .then(() => {
        sync.lastSync = Date.now();
        sync.lastError = "";
        refreshSyncIndicators();
      })
      .catch((e) => {
        sync.lastError = e.message || String(e);
        refreshSyncIndicators();
      });
  }, 2500);
}

async function syncNow(opts) {
  const o = opts || {};
  if (!sync.token || sync.busy) return false;
  sync.busy = true;
  renderSyncView();
  try {
    const g = await locateGist();
    const remote = g ? await readGistState(g) : null;
    sync.remoteInfo = remote
      ? {
          cards: Object.keys(remote.cards || {}).length,
          favs: Object.values(remote.cards || {}).filter((c) => c && c.fav).length,
          updatedAt: Number(remote.updatedAt) || 0,
        }
      : null;
    sync.pulledAt = Date.now();
    const merger = window.PMLE_MERGE && window.PMLE_MERGE.mergeStates;
    const merged = remote && merger ? merger(S, remote) : S;
    S = Object.assign(defaultState(), merged);
    S.updatedAt = Date.now();
    persist({ noSync: true });
    await pushState();
    sync.lastSync = Date.now();
    sync.lastError = "";
    if (o.silent !== true) toast("Synced with the cloud ✓");
    if (currentView !== "quiz") {
      if (currentView === "bank") renderBank();
      else if (currentView === "stats") renderStats();
      else if (currentView === "home") renderHome();
    }
    return true;
  } catch (e) {
    sync.lastError = e.message || String(e);
    if (o.silent !== true) toast("Sync failed: " + sync.lastError);
    return false;
  } finally {
    sync.busy = false;
    renderSyncView();
    refreshSyncIndicators();
  }
}

function fmtSyncTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function syncSummary() {
  if (!sync.token) return "☁️ Cloud sync off";
  if (sync.busy) return "☁️ Syncing…";
  if (sync.lastError) return "☁️ Sync error";
  if (!sync.lastSync) return "☁️ Connected, pending sync";
  return `☁️ Synced ${fmtSyncTime(sync.lastSync)}`;
}

function refreshSyncIndicators() {
  const dot = $("#sync-dot");
  if (dot) dot.hidden = !sync.token;
  const meta = $("#home-meta");
  if (meta && currentView === "home") renderHomeMeta();
}

function renderHomeMeta() {
  const fav = favNums().length;
  const unseen = unseenNums().length;
  const bmeta = window.PMLE_BANK_META || {};
  const stamp = bmeta.build
    ? ` · bank built ${bmeta.build}${bmeta.fixed ? ` (${bmeta.fixed} answers corrected)` : ""}`
    : "";
  $("#home-meta").textContent = `${BANK.length} questions · ${unseen} unseen · ${fav} bookmarked · 27 new (376-402)${stamp} · ${syncSummary()}`;
}

function renderSyncView() {
  const badge = $("#sync-badge");
  if (!badge) return;
  if (!sync.token) {
    badge.className = "sync-badge off";
    badge.textContent = "Not connected";
  } else if (sync.lastError) {
    badge.className = "sync-badge err";
    badge.textContent = "Sync error";
  } else {
    badge.className = "sync-badge on";
    badge.textContent = sync.busy ? "Syncing" : "Connected";
  }

  const st = $("#sync-state");
  if (!st) return;
  if (!sync.token) {
    st.className = "sync-state";
    st.innerHTML =
      'Not connected. Paste your token and click "Connect & sync" — local progress merges with the cloud, nothing is lost.';
  } else if (sync.lastError) {
    st.className = "sync-state err";
    st.innerHTML = `Sync error: ${esc(sync.lastError)}<br>Local progress is safe. Fix the issue and click "Sync now" to retry.`;
  } else {
    st.className = "sync-state ok";
    const counts = `Local: ${Object.keys(S.cards).length} attempted · ${favNums().length} bookmarked`;
    const ri = sync.remoteInfo;
    const cloudLine = ri
      ? `Cloud: ${ri.cards} attempted · ${ri.favs} bookmarked${
          ri.updatedAt ? ` · cloud updated ${fmtSyncTime(ri.updatedAt)}` : ""
        }`
      : "Cloud: empty before connecting — archive created from local progress";
    const gistLink = sync.gistId
      ? ` · <a href="https://gist.github.com/${esc(sync.gistId)}" target="_blank" rel="noopener">Open cloud archive</a>`
      : "";
    st.innerHTML = `Connected${sync.gistId ? ` · archive <code>${esc(sync.gistId.slice(0, 8))}</code>` : ""}${
      sync.lastSync ? ` · last sync ${fmtSyncTime(sync.lastSync)}` : ""
    }${gistLink}<br>${counts}<br>${cloudLine}`;
  }

  const input = $("#sync-token");
  if (input) {
    input.value = "";
    input.placeholder = sync.token
      ? "Token saved (paste a new one to replace it)"
      : "ghp_… (classic token, gist scope)";
  }
  const auto = $("#sync-auto");
  if (auto) auto.checked = sync.auto;
  const btnNow = $("#btn-sync-now");
  if (btnNow) btnNow.disabled = !sync.token || sync.busy;
  const btnDisc = $("#btn-sync-disconnect");
  if (btnDisc) btnDisc.disabled = !sync.token;
}

/* 同步页交互 */
$("#btn-sync-connect").addEventListener("click", async () => {
  const val = ($("#sync-token").value || "").trim();
  if (val) {
    sync.token = val;
    sync.gistId = "";
    localStorage.setItem(SYNC_TOKEN_KEY, val);
    localStorage.removeItem(SYNC_GIST_KEY);
  }
  if (!sync.token) {
    toast("Paste your GitHub token first");
    return;
  }
  sync.lastError = "";
  const ok = await syncNow();
  if (ok) renderSyncView();
});
$("#btn-sync-now").addEventListener("click", () => syncNow());
$("#btn-sync-disconnect").addEventListener("click", () => {
  sync.token = "";
  sync.gistId = "";
  sync.lastSync = 0;
  sync.lastError = "";
  localStorage.removeItem(SYNC_TOKEN_KEY);
  localStorage.removeItem(SYNC_GIST_KEY);
  refreshSyncIndicators();
  renderSyncView();
  toast("Disconnected on this device (cloud archive kept)");
});
$("#sync-auto").addEventListener("change", (e) => {
  sync.auto = e.target.checked;
  localStorage.setItem(SYNC_AUTO_KEY, sync.auto ? "1" : "0");
  if (sync.auto && sync.token) syncNow({ silent: true });
});
$("#sync-token").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("#btn-sync-connect").click();
});

/* 切回页面时自动拉取（答题中不打扰） */
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (!sync.token || !sync.auto || sync.busy) return;
  if (currentView === "quiz") return;
  if (Date.now() - sync.lastSync < 60000) return;
  syncNow({ silent: true });
});

/* ---------- 统计页 ---------- */
function renderStats() {
  let touched = 0,
    correct = 0,
    wrong = 0,
    lv34 = 0,
    lv12 = 0,
    weakN = 0,
    favN = 0;
  const weakList = [];
  Object.keys(S.cards).forEach((n) => {
    const c = S.cards[n];
    touched++;
    if (c.fav) favN++;
    if (c.lv >= 3) lv34++;
    else if (c.lv >= 1) lv12++;
    else if (c.wrongTotal > 0) {
      weakN++;
      weakList.push({ num: Number(n), wrong: c.wrongTotal });
    }
  });
  Object.values(S.days).forEach((d) => {
    correct += d.correct || 0;
    wrong += d.wrong || 0;
  });
  const acc = correct + wrong ? Math.round((correct / (correct + wrong)) * 100) : 0;
  weakList.sort((a, b) => b.wrong - a.wrong);

  $("#stats-body").innerHTML = `
    <div class="stats-grid">
      <div class="stat-card"><b>${touched}</b><span>Attempted</span></div>
      <div class="stat-card"><b>${BANK.length - touched}</b><span>Unseen</span></div>
      <div class="stat-card"><b>${acc}%</b><span>Overall accuracy</span></div>
      <div class="stat-card"><b>${correct}</b><span>Correct answers</span></div>
      <div class="stat-card"><b>${wrong}</b><span>Wrong answers</span></div>
      <div class="stat-card"><b>${lv34}</b><span>Mastered (long-term)</span></div>
      <div class="stat-card"><b>${lv12}</b><span>Reviewing (1/3-day)</span></div>
      <div class="stat-card"><b>${weakN}</b><span>Not mastered</span></div>
      <div class="stat-card"><b>${favN}</b><span>Bookmarked</span></div>
      <div class="stat-card"><b>${S.streakCount}</b><span>Day streak</span></div>
    </div>
    <div class="panel">
      <h3>Not mastered (sorted by misses)</h3>
      <div class="weak-list">${
        weakList.length
          ? weakList
              .slice(0, 30)
              .map(
                (w) =>
                  `<div class="weak-item" data-num="${w.num}"><b style="color:var(--red-wrong)">Q${w.num}</b> · missed ${w.wrong}x · ${esc(stripTags(byNum[w.num].stem).slice(0, 60))}…</div>`
              )
              .join("")
          : '<div style="color:var(--ink-2);font-size:14px">No weak questions 👍</div>'
      }</div>
    </div>`;
  document.querySelectorAll(".weak-item").forEach((el) => {
    el.addEventListener("click", () => openBankDetail(Number(el.dataset.num)));
  });
}

/* ---------- 跨天清理 ---------- */
function rolloverCheck() {
  const t = todayKey();
  if (S.session && S.session.date !== t) {
    const oldDay = S.session.date;
    Object.keys(S.cards).forEach((n) => {
      const c = S.cards[n];
      if (c.wrongByDay && c.wrongByDay[oldDay]) {
        c.due = Math.min(c.due || Infinity, Date.now());
      }
    });
    S.session = null;
    S.dailyBackup = null;
    persist();
  }
}

/* ---------- 启动 ---------- */
$("#fs-minus").addEventListener("click", () => fsChange(-1));
$("#fs-plus").addEventListener("click", () => fsChange(1));
applyFs();
rolloverCheck();
migrateCorrections();
ensureDay();
renderHome();
renderSyncView();
refreshSyncIndicators();

/* 启动时若已配置同步：先拉云端再合并，静默进行 */
if (sync.token && sync.auto) {
  setTimeout(() => {
    if (currentView !== "quiz") syncNow({ silent: true });
  }, 600);
}
show("home");
