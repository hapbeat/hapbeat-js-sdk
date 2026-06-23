/**
 * Ranking board for the arcade games — accumulates every completed run into a
 * per-game leaderboard (localStorage, transient is fine) that keeps growing
 * until リセット. Built for a booth: the board pops out into a separate window
 * (e.g. a second monitor facing visitors) that live-updates as people play, and
 * the data can be saved / loaded as JSON.
 *
 * A game declares its COLUMNS (one or more numeric metrics). The table is
 * SORTABLE by any column (click the header); each row also shows which
 * modalities (👁/👂/✋) were ON for that run as badges.
 *
 *   const rank = createRanking("notice", {
 *     title: "気づけるか",
 *     columns: [
 *       { key: "points", label: "総合", unit: "pt", decimals: 0, lowerIsBetter: false, primary: true },
 *       { key: "rt",     label: "通知平均", unit: "ms", decimals: 0, lowerIsBetter: true },
 *       { key: "rate",   label: "気付き率", unit: "%", decimals: 0, lowerIsBetter: false },
 *       { key: "clear",  label: "時間", unit: "s", decimals: 1, lowerIsBetter: true },
 *     ],
 *   });
 *   rank.record({ name, metrics: { points, rt, rate, clear }, mods: ["visual","haptic"] });
 *   rank.mountPanel(el);   // inline sortable table (auto-refresh)
 *   rank.openPopout();     // booth window (live, sortable, JSON, reset)
 */

const PREFIX = "hapbeat-arcade-rank-v2:";
const key = (gameId) => PREFIX + gameId;
const MOD_EMOJI = { visual: "👁", audio: "👂", haptic: "✋" };

function load(gameId) {
  try {
    const v = JSON.parse(localStorage.getItem(key(gameId)) || "[]");
    return Array.isArray(v) ? v.filter((e) => e && e.metrics && typeof e.metrics === "object") : [];
  } catch {
    return [];
  }
}
function store(gameId, rows) {
  try {
    localStorage.setItem(key(gameId), JSON.stringify(rows));
  } catch {
    /* storage disabled / quota — board just won't persist */
  }
}

/** Sort by a column key (respecting its direction); rows missing it sink. */
function sortRows(rows, columns, sortKey) {
  const col = columns.find((c) => c.key === sortKey) || columns[0];
  const lower = !!col.lowerIsBetter;
  return rows.slice().sort((a, b) => {
    const av = a.metrics[col.key], bv = b.metrics[col.key];
    const af = Number.isFinite(av), bf = Number.isFinite(bv);
    if (!af && !bf) return a.at - b.at;
    if (!af) return 1;
    if (!bf) return -1;
    return (lower ? av - bv : bv - av) || a.at - b.at;
  });
}

const pad2 = (n) => String(n).padStart(2, "0");
function clock(at) {
  const d = new Date(at);
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function createRanking(gameId, meta) {
  const columns = (meta.columns || []).map((c) => ({ decimals: 0, lowerIsBetter: true, unit: "", ...c }));
  const M = { title: gameId, columns, ...meta };
  const defaultSort = (columns.find((c) => c.primary) || columns[0] || { key: "" }).key;
  const fmt = (col, v) =>
    Number.isFinite(v) ? `${Number(v).toFixed(col.decimals)}${col.unit ? " " + col.unit : ""}` : "—";

  const panels = new Set(); // mounted inline panels → auto-refreshed after record()

  function record({ name = "", metrics = {}, mods = [], detail = "" }) {
    const clean = {};
    for (const c of columns) if (Number.isFinite(metrics[c.key])) clean[c.key] = metrics[c.key];
    if (!Object.keys(clean).length) return; // nothing scoreable
    const rows = load(gameId);
    rows.push({
      name: String(name).slice(0, 18),
      metrics: clean,
      mods: Array.isArray(mods) ? mods.filter((m) => MOD_EMOJI[m]) : [],
      detail: String(detail).slice(0, 80),
      at: Date.now(),
    });
    store(gameId, rows);
    for (const r of panels) r(); // same-window: storage events don't fire here
  }
  function list(sortKey = defaultSort) {
    return sortRows(load(gameId), columns, sortKey);
  }
  function clear() {
    store(gameId, []);
  }

  function modBadges(mods) {
    if (!mods || !mods.length) return `<span class="rank-mods none">—</span>`;
    return `<span class="rank-mods">${mods.map((m) => `<span class="rm">${MOD_EMOJI[m]}</span>`).join("")}</span>`;
  }

  function tableHtml(rows, sortKey, topN) {
    const view = topN ? rows.slice(0, topN) : rows;
    const head =
      `<th>#</th><th>名前</th>` +
      columns
        .map(
          (c) =>
            `<th class="r-sort${c.key === sortKey ? " on" : ""}" data-key="${c.key}">${esc(c.label)}${
              c.key === sortKey ? (c.lowerIsBetter ? " ▲" : " ▼") : ""
            }</th>`,
        )
        .join("") +
      `<th>感覚</th><th>日時</th>`;
    if (!view.length)
      return `<table class="rank-table"><thead><tr>${head}</tr></thead></table><p class="rank-empty">まだ記録がありません。プレイすると並びます。</p>`;
    const body = view
      .map((e, i) => {
        const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : i + 1;
        const cells = columns
          .map((c) => `<td class="r-num${c.key === sortKey ? " on" : ""}">${fmt(c, e.metrics[c.key])}</td>`)
          .join("");
        return `<tr${i < 3 ? ' class="top"' : ""}><td class="r-rank">${medal}</td><td class="r-name">${
          esc(e.name) || "—"
        }</td>${cells}<td class="r-mods">${modBadges(e.mods)}</td><td class="r-at">${clock(e.at)}</td></tr>`;
      })
      .join("");
    return `<table class="rank-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  }

  /** Render a live sortable top-N panel into `el`. Returns a dispose fn. */
  function mountPanel(el, topN = 8) {
    let sortKey = defaultSort;
    const refresh = () => {
      const rows = sortRows(load(gameId), columns, sortKey);
      el.innerHTML =
        `<div class="rank-head"><b>🏆 ランキング</b><span class="rank-count">${rows.length} 件</span>` +
        `<span class="spacer"></span>` +
        `<button class="ghost rank-pop">⧉ 別ウィンドウ</button>` +
        `<button class="ghost rank-reset">🗑 リセット</button></div>` +
        tableHtml(rows, sortKey, topN);
      el.querySelector(".rank-pop").onclick = openPopout;
      el.querySelector(".rank-reset").onclick = () => {
        if (confirm(`${M.title} のランキングをリセットしますか？（元に戻せません）`)) {
          clear();
          refresh();
        }
      };
      for (const th of el.querySelectorAll(".r-sort")) {
        th.onclick = () => { sortKey = th.dataset.key; refresh(); };
      }
    };
    const onStorage = (e) => {
      if (e.key === key(gameId) || e.key === null) refresh();
    };
    window.addEventListener("storage", onStorage);
    panels.add(refresh);
    refresh();
    el._rankRefresh = refresh; // (kept for callers; record() also auto-refreshes)
    return () => {
      window.removeEventListener("storage", onStorage);
      panels.delete(refresh);
    };
  }

  function openPopout() {
    const w = window.open("", "hbrank_" + gameId, "width=720,height=780");
    if (!w) {
      alert("ポップアウトがブロックされました。ブラウザのポップアップ許可を確認してください。");
      return;
    }
    w.document.open();
    w.document.write(popoutDoc(gameId, M, defaultSort));
    w.document.close();
    w.focus();
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify({ game: gameId, columns, rows: load(gameId) }, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `hapbeat-rank-${gameId}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  async function importJsonFile(file) {
    const obj = JSON.parse(await file.text());
    const rows = Array.isArray(obj) ? obj : obj.rows;
    if (!Array.isArray(rows)) throw new Error("rows[] が見つかりません");
    store(gameId, rows.filter((e) => e && e.metrics && typeof e.metrics === "object"));
    for (const r of panels) r();
  }

  return { gameId, meta: M, columns, record, list, clear, mountPanel, openPopout, exportJson, importJsonFile, fmt };
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/**
 * Self-contained HTML for the booth window. Reads the SAME localStorage key, so
 * it live-updates via `storage` events whenever the game window records a run.
 * Headers are sortable; modality badges per row. Config injected as JSON.
 */
function popoutDoc(gameId, meta, defaultSort) {
  const cfg = JSON.stringify({ key: PREFIX + gameId, title: meta.title, columns: meta.columns, defaultSort });
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<title>🏆 ${esc(meta.title)} ランキング</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;font-family:system-ui,"Segoe UI",Roboto,sans-serif;background:#0a0d12;color:#e6edf3}
  header{display:flex;align-items:center;gap:12px;padding:16px 22px;background:#11161f;border-bottom:1px solid #2a313c;position:sticky;top:0;z-index:2}
  header h1{margin:0;font-size:22px;letter-spacing:.02em}
  header .count{color:#8b97a6;font-size:13px}
  header .sp{flex:1}
  button{font:inherit;font-size:13px;color:#e6edf3;background:#1f2630;border:1px solid #2a313c;border-radius:8px;padding:7px 12px;cursor:pointer}
  button:hover{background:#283040}
  button.danger{border-color:#6f2a26}
  main{padding:0 0 60px}
  table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
  th,td{padding:11px 16px;text-align:left;border-bottom:1px solid #1c222b}
  th{font-size:12px;color:#8b97a6;font-weight:600;position:sticky;top:60px;background:#0a0d12}
  th.sortable{cursor:pointer;user-select:none}
  th.sortable:hover{color:#cdd6e0}
  th.on{color:#fff}
  td.rank{font-size:22px;font-weight:800;width:60px;text-align:center}
  td.name{font-size:19px;font-weight:600}
  td.num{font-size:18px;font-weight:700;color:#9aa7b4;white-space:nowrap}
  td.num.on{font-size:22px;font-weight:800;color:#2dd4bf}
  tr.top td.num.on{color:#7c5cff}
  tr.top td.name{color:#fff}
  td.mods .rm{font-size:16px;margin-right:1px}
  td.mods .none{color:#5a6677}
  td.at{font-size:12px;color:#5a6677;white-space:nowrap}
  .empty{padding:60px 22px;text-align:center;color:#5a6677;font-size:16px}
  footer{position:fixed;bottom:0;left:0;right:0;display:flex;gap:8px;padding:10px 18px;background:#11161f;border-top:1px solid #2a313c}
</style></head>
<body>
  <header>
    <h1>🏆 ${esc(meta.title)} <span style="font-size:14px;color:#8b97a6">ランキング</span></h1>
    <span class="count" id="count"></span>
    <span class="sp"></span>
  </header>
  <main id="board"></main>
  <footer>
    <button id="save">💾 JSON 保存</button>
    <button id="load">📂 JSON 読込</button>
    <span class="sp" style="flex:1"></span>
    <button id="reset" class="danger">🗑 リセット</button>
    <input type="file" id="file" accept="application/json" style="display:none">
  </footer>
<script>
(function(){
  var CFG = ${cfg};
  var MOD = { visual:"👁", audio:"👂", haptic:"✋" };
  var sortKey = CFG.defaultSort;
  var pad2 = function(n){ return String(n).padStart(2,"0"); };
  function esc(s){ return String(s==null?"":s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c];}); }
  function col(k){ for(var i=0;i<CFG.columns.length;i++) if(CFG.columns[i].key===k) return CFG.columns[i]; return CFG.columns[0]||{}; }
  function fmt(c,v){ return (typeof v==="number"&&isFinite(v)) ? (v.toFixed(c.decimals||0)+(c.unit?" "+c.unit:"")) : "—"; }
  function clock(at){ var d=new Date(at); return pad2(d.getMonth()+1)+"/"+pad2(d.getDate())+" "+pad2(d.getHours())+":"+pad2(d.getMinutes()); }
  function read(){ try{ var v=JSON.parse(localStorage.getItem(CFG.key)||"[]"); return Array.isArray(v)?v.filter(function(e){return e&&e.metrics;}):[]; }catch(e){ return []; } }
  function write(rows){ try{ localStorage.setItem(CFG.key, JSON.stringify(rows)); }catch(e){} }
  function sorted(rows){ var c=col(sortKey), lo=!!c.lowerIsBetter;
    return rows.slice().sort(function(a,b){ var av=a.metrics[c.key], bv=b.metrics[c.key];
      var af=isFinite(av), bf=isFinite(bv); if(!af&&!bf) return a.at-b.at; if(!af) return 1; if(!bf) return -1;
      return (lo?av-bv:bv-av) || a.at-b.at; }); }
  function badges(m){ if(!m||!m.length) return '<span class="none">—</span>';
    return m.map(function(k){ return MOD[k]?('<span class="rm">'+MOD[k]+'</span>'):''; }).join(""); }
  function render(){
    var rows = sorted(read());
    document.getElementById("count").textContent = rows.length + " 件";
    var board = document.getElementById("board");
    var head = '<tr><th>#</th><th>名前</th>' + CFG.columns.map(function(c){
      return '<th class="sortable'+(c.key===sortKey?' on':'')+'" data-key="'+c.key+'">'+esc(c.label)+(c.key===sortKey?(c.lowerIsBetter?' ▲':' ▼'):'')+'</th>';
    }).join("") + '<th>感覚</th><th>日時</th></tr>';
    if(!rows.length){ board.innerHTML = '<table><thead>'+head+'</thead></table><div class="empty">まだ記録がありません。<br>ゲーム側でプレイすると、ここに並びます。</div>'; wireHeads(); return; }
    var body = rows.map(function(e,i){
      var medal = i===0?"🥇":i===1?"🥈":i===2?"🥉":(i+1);
      var cells = CFG.columns.map(function(c){ return '<td class="num'+(c.key===sortKey?' on':'')+'">'+fmt(c,e.metrics[c.key])+'</td>'; }).join("");
      return '<tr'+(i<3?' class="top"':'')+'><td class="rank">'+medal+'</td><td class="name">'+(esc(e.name)||"—")+'</td>'+cells+'<td class="mods">'+badges(e.mods)+'</td><td class="at">'+clock(e.at)+'</td></tr>';
    }).join("");
    board.innerHTML = '<table><thead>'+head+'</thead><tbody>'+body+'</tbody></table>';
    wireHeads();
  }
  function wireHeads(){ var ths=document.querySelectorAll("th.sortable");
    for(var i=0;i<ths.length;i++){ (function(th){ th.onclick=function(){ sortKey=th.dataset.key; render(); }; })(ths[i]); } }
  document.getElementById("reset").onclick = function(){ if(confirm("ランキングをリセットしますか？（元に戻せません）")){ write([]); render(); } };
  document.getElementById("save").onclick = function(){
    var blob = new Blob([JSON.stringify({game:"${gameId}", columns:CFG.columns, rows:read()}, null, 2)], {type:"application/json"});
    var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "hapbeat-rank-${gameId}.json"; a.click();
    setTimeout(function(){ URL.revokeObjectURL(a.href); }, 2000);
  };
  var file = document.getElementById("file");
  document.getElementById("load").onclick = function(){ file.click(); };
  file.onchange = function(){
    var f = file.files[0]; if(!f) return;
    f.text().then(function(t){
      var obj = JSON.parse(t); var rows = Array.isArray(obj)?obj:obj.rows;
      if(!Array.isArray(rows)) throw new Error("rows[] なし");
      write(rows.filter(function(e){return e&&e.metrics;})); render();
    }).catch(function(err){ alert("読込に失敗: "+err.message); });
    file.value = "";
  };
  window.addEventListener("storage", function(e){ if(e.key===CFG.key || e.key===null) render(); });
  setInterval(render, 1500); // fallback for same-window edits / missed events
  render();
})();
</script>
</body></html>`;
}
