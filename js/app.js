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
        ? "已到最小字号"
        : fsScale >= FS_MAX
          ? "已到最大字号"
          : "阅读字号 " + Math.round(fsScale * 100) + "%"
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
function persist() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(S));
  } catch (e) {
    toast("⚠️ 本地存储写入失败");
  }
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
const VIEWS = ["home", "quiz", "result", "bank", "stats"];
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

  const wk = ["日", "一", "二", "三", "四", "五", "六"];
  const now = new Date();
  $("#home-date").textContent = `${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日 · 星期${wk[now.getDay()]}`;

  let progressHtml, mainLabel;
  if (sess) {
    const remaining = sessionRemaining(sess);
    progressHtml = `今日任务进行中 <small>（还剩 ${remaining} 张卡待处理）</small>`;
    mainLabel = "从断点继续";
    $("#btn-more20").hidden = true;
  } else if (day.done >= day.planned) {
    progressHtml = `今日已完成 <span>${day.done}</span> / ${day.planned} 道新题 <small>🎉</small>`;
    mainLabel = unseenNums().length ? "再来 20 题" : "今日题已刷完";
    $("#btn-more20").hidden = false;
  } else {
    progressHtml = `今日已完成 <span>${day.done}</span> / ${day.planned} 道新题`;
    mainLabel = "开始今日 20 题";
    $("#btn-more20").hidden = true;
  }
  $("#home-progress").innerHTML = progressHtml;
  const btn = $("#btn-main-action");
  btn.textContent = mainLabel;
  btn.disabled = mainLabel === "今日题已刷完";

  const due = reviewDueNums();
  const yk = todayKey(new Date(Date.now() - DAY));
  let yWrong = 0;
  Object.keys(S.cards).forEach((n) => {
    const c = S.cards[n];
    if (c.wrongByDay && c.wrongByDay[yk]) yWrong++;
  });
  $("#home-review").innerHTML =
    (due.length
      ? `今天开场需先复习 <b>${due.length}</b> 道到期 / 昨日未掌握的题`
      : "今天没有待复习的题，直接开新题") +
    `（昨日答错未掌握：${yWrong} 道）`;

  const fav = favNums().length;
  const unseen = unseenNums().length;
  $("#home-meta").textContent = `题库共 ${BANK.length} 题 · 未做过 ${unseen} 题 · 收藏 ${fav} 题 · 含 27 道新题（376-402）`;

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
    <div class="stat-row"><span>累计刷过的题</span><b>${touched}</b></div>
    <div class="stat-row"><span>总正确率</span><b>${acc}%</b></div>
    <div class="stat-row"><span>已掌握（7 / 21 天间隔）</span><b>${lv34}</b></div>
    <div class="stat-row"><span>复习中（1 / 3 天间隔）</span><b>${lv12}</b></div>
    <div class="stat-row"><span>未掌握</span><b>${lv0weak}</b></div>`;
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
    cell.title = `${k}：答题 ${act} 次`;
    wrap.appendChild(cell);
  }
  $("#streak-line").innerHTML = `连续打卡 <b>${S.streakCount}</b> 天`;
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
    toast("没有可刷的题了 🎉");
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
  if (!fresh.length) return toast("没有新题可加了 🎉");
  const sess = activeSession();
  if (sess && sess.mode === "daily") {
    sess.queue.push(...fresh);
    sess.total += fresh.length;
    day.planned += fresh.length;
    toast(`已追加 ${fresh.length} 道新题`);
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
  if (!nums.length) return toast("收藏夹是空的，先在答题页或题库页点 ☆ 收藏");
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
      <p style="color:var(--ink-2);font-size:15px;margin-top:12px">错题重弹倒计时…（趁热记住它！）</p>
      <button class="btn btn-outline" id="wait-quit">先退出，稍后再战</button>
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
    `<span class="tag">${s.mode === "fav" ? "收藏夹模式" : "每日任务"}</span>` +
    (cur.cram ? '<span class="tag" style="background:var(--gold);color:#5b3a00">攻坚区</span>' : "");
  $("#quiz-count").textContent = `已彻底完成 ${processed}/${s.total} · 待处理 ${remaining}`;
  $("#quiz-progress").style.width =
    Math.min(100, (processed / Math.max(s.total, 1)) * 100).toFixed(1) + "%";
  $("#btn-fav-toggle").textContent = c.fav ? "★" : "☆";
  $("#btn-fav-toggle").classList.toggle("faved", !!c.fav);

  const area = $("#quiz-area");
  const badges = [];
  if (q.isNew) badges.push('<span class="badge new">402 新题</span>');
  if (isMulti) badges.push('<span class="badge multi">多选</span>');
  if (cur.retry) badges.push('<span class="badge retry">重弹</span>');
  if (c.lv >= 3) badges.push('<span class="badge">已掌握·远期</span>');
  else if (c.lv >= 1) badges.push('<span class="badge">复习中</span>');

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
    ? `<div class="multisubmit"><button id="btn-submit-multi" class="btn btn-primary">提交答案（已选 <span id="picked-n">0</span> 项）</button></div>`
    : "";
  const skipBtn = `<button class="btn btn-ghost" id="btn-skip">跳过，稍后再说</button>`;

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
      if (!cur.picked.size) return toast("先选择至少一个选项");
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
    ? `<details class="pdf-expl"><summary>📄 PDF 原文解析（点开查看）</summary>
        <div class="bbody">${esc(q.explEn)}</div></details>`
    : "";

  const verdict = correct
    ? `<div class="verdict ok">✅ 回答正确 · 你觉得掌握了吗？</div>`
    : `<div class="verdict no">❌ 回答错误 · 正确答案：${q.answer}</div>`;

  let note = "";
  let actions = "";
  if (correct) {
    actions = `
      <button class="btn btn-green" id="btn-mastered">已掌握</button>
      <button class="btn btn-red" id="btn-notmastered">未掌握（1 分钟后重做）</button>`;
  } else if (wrongCntToday >= 3) {
    note = `<div class="requeue-note">本题今天已答错 ${wrongCntToday} 次，移入<b>本轮结束攻坚区</b>集中攻克，不再每分钟硬弹。</div>`;
    actions = `<button class="btn btn-primary" id="btn-nextq">下一题</button>`;
  } else {
    note = `<div class="requeue-note">已加入重弹队列：<b>约 1 分钟后</b>再次出现，直到答对并点「已掌握」。</div>`;
    actions = `<button class="btn btn-primary" id="btn-nextq">下一题</button>`;
  }

  $("#qface-back").innerHTML = `
    <div class="qnum-line">
      <span class="qnum">QUESTION ${q.num} · 答案面</span>
    </div>
    <div class="back-grid">
      <div class="back-col">
        <div class="qstem">${q.stem}</div>
        ${verdict}
        <div class="backsec">
          <h4>答案标注（绿 = 正确答案，红 = 你选错的）</h4>
          ${marked}
        </div>
      </div>
      <div class="back-col">
        ${
          q.zh && q.zh.stem
            ? `<div class="backsec">
          <h4>中文翻译</h4>
          <div class="bbody zho">
            <p style="margin-bottom:6px"><b>题干</b></p>
            ${q.zh.stem}
            <p style="margin:8px 0 4px"><b>选项</b></p>
            ${zhOpts}
          </div>
        </div>`
            : ""
        }
        <div class="backsec">
          <h4>精讲</h4>
          <div class="ex-content">
            ${q.core ? `<div class="core-chip">${q.core}</div>` : ""}
            ${q.ex}
            ${pdfExpl}
            ${q.ref ? `<p style="font-size:12px;color:var(--ink-2)">参考：${esc(q.ref)}</p>` : ""}
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
    ? "收藏夹刷完 🎉"
    : day.done >= day.planned
      ? "今日任务完成 🎉"
      : "本轮刷完";
  $("#result-body").innerHTML = `
    <div class="big-nums">
      <div class="bn"><b>${s.total}</b><span>处理卡片数</span></div>
      <div class="bn ok"><b>${correctToday}</b><span>今日答对</span></div>
      <div class="bn bad"><b>${wrongToday}</b><span>今日答错</span></div>
      <div class="bn"><b>${acc}%</b><span>今日正确率</span></div>
    </div>
    <div class="tomorrow-box">
      <b>明日复习预告</b>：开场将先复习 <b>${dueTomorrow.length}</b> 道到期 / 未掌握的题${
        preview.length ? `（含 Q${preview.join("、Q")}…）` : ""
      }。<br>
      今日答错且最终未掌握的题会<b>明早自动置顶</b>；已掌握的题按 1 / 3 / 7 / 21 天间隔轮回复现。
    </div>
    <p style="color:var(--ink-2);font-size:13px">今日新题额度 ${day.done} / ${day.planned}${
      isFav ? "（收藏夹模式不占额度）" : day.done < day.planned ? " · 剩余进度已保存，随时从断点继续" : " · 额度全部完成 🎉"
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
  persist();
  $("#btn-fav-toggle").textContent = c.fav ? "★" : "☆";
  $("#btn-fav-toggle").classList.toggle("faved", !!c.fav);
  toast(c.fav ? "已收藏 ⭐" : "已取消收藏");
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
  if (!c) return { txt: "未做过", cls: "new" };
  if (c.lv >= 3) return { txt: "已掌握", cls: "lv3" };
  if (c.lv >= 1) return { txt: "复习中", cls: "lv2" };
  if (c.wrongTotal > 0) return { txt: "未掌握", cls: "weak" };
  return { txt: "做过", cls: "lv1" };
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
    list.innerHTML = '<div class="panel">没有符合筛选条件的题目。</div>';
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
          ${q.isNew ? '<span class="bi-status new">新</span>' : ""}
          ${q.multi ? '<span class="bi-status" style="background:#efe7ff;color:#5b3f9e">多选</span>' : ""}
          ${c && c.fav ? '<span class="bi-fav">★</span>' : ""}
          <span style="flex:1"></span>
          <span class="bi-status">答案 ${q.answer}</span>
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
        ${q.isNew ? '<span class="bi-status new">402 新题</span>' : ""}
        ${q.multi ? '<span class="bi-status" style="background:#efe7ff;color:#5b3f9e">多选</span>' : ""}
      </div>
      <div class="back-grid">
        <div class="back-col">
          <div class="qstem">${q.stem}</div>
          <div class="backsec"><h4>答案</h4>${marked}</div>
        </div>
        <div class="back-col">
          ${
            q.zh && q.zh.stem
              ? `<div class="backsec"><h4>中文翻译</h4><div class="bbody zho">${q.zh.stem}<p style="margin:8px 0 4px"><b>选项</b></p>${zhOpts}</div></div>`
              : ""
          }
          <div class="backsec">
            <h4>精讲</h4>
            <div class="ex-content">${q.core ? `<div class="core-chip">${q.core}</div>` : ""}${q.ex}
            ${
              q.explEn
                ? `<details class="pdf-expl"><summary>📄 PDF 原文解析</summary><div class="bbody">${esc(q.explEn)}</div></details>`
                : ""
            }
            ${q.ref ? `<p style="font-size:12px;color:var(--ink-2)">参考：${esc(q.ref)}</p>` : ""}</div>
          </div>
        </div>
      </div>
      <div class="quiz-actions">
        <button class="btn ${c.fav ? "btn-gold" : "btn-outline"}" id="bd-fav"><span class="bigstar">${c.fav ? "★" : "☆"}</span> ${c.fav ? "已收藏" : "收藏"}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
  overlay.querySelector(".bd-close").addEventListener("click", () => overlay.remove());
  overlay.querySelector("#bd-fav").addEventListener("click", () => {
    c.fav = c.fav ? 0 : 1;
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
  toast("进度已导出（可用于换设备恢复）");
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
      toast("进度已导入 ✓");
      renderBank();
      renderHome();
    } catch (err) {
      toast("导入失败：文件格式不对");
    }
  };
  r.readAsText(f);
  e.target.value = "";
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
      <div class="stat-card"><b>${touched}</b><span>已刷过的题</span></div>
      <div class="stat-card"><b>${BANK.length - touched}</b><span>未做过</span></div>
      <div class="stat-card"><b>${acc}%</b><span>总正确率</span></div>
      <div class="stat-card"><b>${correct}</b><span>答对次数</span></div>
      <div class="stat-card"><b>${wrong}</b><span>答错次数</span></div>
      <div class="stat-card"><b>${lv34}</b><span>已掌握（远期）</span></div>
      <div class="stat-card"><b>${lv12}</b><span>复习中（1/3 天）</span></div>
      <div class="stat-card"><b>${weakN}</b><span>未掌握</span></div>
      <div class="stat-card"><b>${favN}</b><span>收藏</span></div>
      <div class="stat-card"><b>${S.streakCount}</b><span>连续打卡天数</span></div>
    </div>
    <div class="panel">
      <h3>未掌握清单（按答错次数排序）</h3>
      <div class="weak-list">${
        weakList.length
          ? weakList
              .slice(0, 30)
              .map(
                (w) =>
                  `<div class="weak-item" data-num="${w.num}"><b style="color:var(--red-wrong)">Q${w.num}</b> · 答错 ${w.wrong} 次 · ${esc(stripTags(byNum[w.num].stem).slice(0, 60))}…</div>`
              )
              .join("")
          : '<div style="color:var(--ink-2);font-size:14px">暂无未掌握的题 👍</div>'
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
ensureDay();
renderHome();
show("home");
