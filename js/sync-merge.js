/* 跨设备同步 · 状态合并（纯函数，便于单独测试）
 *
 * 合并原则：以「每道题的最后操作时间 lastAt」为准，新记录覆盖旧记录；
 * 错题次数与按天错题记录取并集 / 最大值，避免任何一台设备的作答历史丢失；
 * 会话（当前刷题断点）、连续打卡等整体字段跟随「整体更新时间 updatedAt 较新」的那份。
 */
(function () {
  "use strict";

  function num(v) {
    const n = Number(v);
    return isFinite(n) ? n : 0;
  }
  function clone(v) {
    return v == null ? v : JSON.parse(JSON.stringify(v));
  }
  function pickNewer(a, b) {
    return num(b && b.lastAt) >= num(a && a.lastAt) ? b : a;
  }
  function mergeWrongByDay(a, b) {
    const out = {};
    [a, b].forEach(function (m) {
      if (!m) return;
      Object.keys(m).forEach(function (k) {
        out[k] = Math.max(num(out[k]), num(m[k]));
      });
    });
    return out;
  }
  function mergeCard(a, b) {
    if (!a) return clone(b);
    if (!b) return clone(a);
    const base = pickNewer(a, b);
    const other = base === a ? b : a;
    const out = Object.assign({}, base);
    out.lv = num(base.lv);
    out.due = num(base.due);
    // 标记类字段（收藏 / 错题本）：以较新的一份为准；若较新的一份根本没有该字段
    // （旧版本存档），则沿用另一份的值，避免升级后标记被抹掉
    out.fav = base.fav === undefined ? (num(other.fav) ? 1 : 0) : num(base.fav) ? 1 : 0;
    out.mb = base.mb === undefined ? (num(other.mb) ? 1 : 0) : num(base.mb) ? 1 : 0;
    out.lastAt = Math.max(num(a.lastAt), num(b.lastAt));
    out.wrongTotal = Math.max(num(a.wrongTotal), num(b.wrongTotal));
    out.wrongByDay = mergeWrongByDay(a.wrongByDay, b.wrongByDay);
    // 「作答过 / 展示过」是单向事实，只会从 0 变 1，取并集。
    // 否则在另一台设备点了收藏（记录较新但没有 seen）会把它覆盖回「没做过」，
    // 结果 +20 又把已经做过的题发一遍。
    out.seen = num(a.seen) || num(b.seen) ? 1 : 0;
    out.shown = num(a.shown) || num(b.shown) ? 1 : 0;
    // 若较旧的一份记录了「今天已掌握」的降级状态，保留较高的 due 以免复习被提前
    if (num(other.due) > out.due && num(base.lv) >= num(other.lv)) out.due = num(other.due);
    return out;
  }
  function mergeCards(a, b) {
    a = a || {};
    b = b || {};
    const out = {};
    const keys = Object.keys(a).concat(Object.keys(b));
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (out[k]) continue;
      out[k] = mergeCard(a[k], b[k]);
    }
    return out;
  }
  function mergeDays(a, b) {
    a = a || {};
    b = b || {};
    const out = {};
    const keys = Object.keys(a).concat(Object.keys(b));
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (out[k]) continue;
      const x = a[k] || {};
      const y = b[k] || {};
      out[k] = {
        planned: Math.max(num(x.planned), num(y.planned)),
        done: Math.max(num(x.done), num(y.done)),
        correct: Math.max(num(x.correct), num(y.correct)),
        wrong: Math.max(num(x.wrong), num(y.wrong)),
        act: Math.max(num(x.act), num(y.act)),
      };
    }
    return out;
  }

  function mergeStates(local, remote) {
    if (!local) return clone(remote);
    if (!remote) return clone(local);
    const newer = num(remote.updatedAt) >= num(local.updatedAt) ? remote : local;
    const out = clone(newer);
    out.cards = mergeCards(local.cards, remote.cards);
    out.days = mergeDays(local.days, remote.days);
    out.session = newer.session ? clone(newer.session) : null;
    out.dailyBackup = newer.dailyBackup ? clone(newer.dailyBackup) : null;
    out.streakLast = newer.streakLast || "";
    out.streakCount = num(newer.streakCount);
    out.corrVer = Math.max(num(local.corrVer), num(remote.corrVer));
    out.updatedAt = Math.max(num(local.updatedAt), num(remote.updatedAt));
    return out;
  }

  window.PMLE_MERGE = { mergeStates: mergeStates };
})();
