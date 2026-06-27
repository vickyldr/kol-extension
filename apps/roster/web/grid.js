// 飞书式可分组 / 排序 / 筛选的表格组件（资源库 + 看板共用）
// 用法：const grid = createGrid({ mount, columns, groupBy, sortKey, sortDir, onRowClick, onVisible, rowKey });
//        grid.setData(items)
// columns: [{ key, label, val(it)→标量或数组, cell(it)→html, groupable, sortable(默认true), filterable }]
(function () {
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  // 注入一次样式
  if (!document.getElementById("grid-css")) {
    const st = document.createElement("style");
    st.id = "grid-css";
    st.textContent = `
      .g-tools { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; padding: 9px 22px; background: #fff; border-bottom: 1px solid #f0f1f3; font-size: 12px; color: #5e6470; }
      .g-tools select { font-size: 12px; padding: 3px 6px; border: 1px solid #d9dce1; border-radius: 6px; background: #fff; }
      .g-tools .g-dir { border: 1px solid #d9dce1; border-radius: 6px; background: #fff; cursor: pointer; padding: 2px 8px; }
      .g-chips { display: flex; gap: 6px; flex-wrap: wrap; }
      .gchip { background: #eef2ff; color: #1456f0; border-radius: 14px; padding: 3px 10px; font-size: 12px; }
      .gchip b { cursor: pointer; margin-left: 4px; }
      .g-wrap { overflow-x: auto; max-width: 100vw; }
      .g-table { width: 100%; border-collapse: collapse; background: #fff; min-width: 760px; }
      .g-table th { text-align: left; padding: 9px 14px; background: #fafbfc; color: #8f959e; font-weight: 600; font-size: 12px; border-bottom: 1px solid #e7e9ed; white-space: nowrap; }
      .g-table th.g-sortable { cursor: pointer; user-select: none; }
      .g-table th.g-sortable:hover { color: #1456f0; }
      .g-table td { padding: 10px 14px; border-bottom: 1px solid #f0f1f3; vertical-align: top; }
      .g-row:hover td { background: #fafcff; cursor: pointer; }
      .g-grp td { background: #f2f6ff; font-weight: 700; padding: 7px 14px; color: #1f2329; cursor: pointer; }
      .g-grp .g-caret { display: inline-block; width: 13px; color: #8f959e; }
      .g-grp .g-cnt { color: #8f959e; font-weight: 500; margin-left: 8px; }
      .g-empty { padding: 36px; text-align: center; color: #9aa6b2; }
    `;
    document.head.appendChild(st);
  }

  window.createGrid = function (opts) {
    const cols = opts.columns;
    const st = { groupBy: opts.groupBy || "", sortKey: opts.sortKey || "", sortDir: opts.sortDir || "desc", filters: [], collapsed: new Set() };
    let data = [];
    const colBy = (k) => cols.find((c) => c.key === k);
    const valOf = (c, it) => (c.val ? c.val(it) : it[c.key]);

    function distinct(c) {
      const s = new Set();
      data.forEach((it) => {
        const v = valOf(c, it);
        if (Array.isArray(v)) v.forEach((x) => x !== "" && x != null && s.add(x));
        else if (v !== "" && v != null) s.add(v);
      });
      return [...s].sort((a, b) => (typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b))));
    }
    function pass(it) {
      return st.filters.every((f) => {
        const v = valOf(colBy(f.key), it);
        if (Array.isArray(v)) return v.map(String).includes(String(f.val));
        return String(v) === String(f.val);
      });
    }
    function visible() {
      let list = data.filter(pass);
      if (st.sortKey) {
        const c = colBy(st.sortKey), dir = st.sortDir === "desc" ? -1 : 1;
        list = list.slice().sort((a, b) => {
          let va = valOf(c, a), vb = valOf(c, b);
          if (Array.isArray(va)) va = va.join(); if (Array.isArray(vb)) vb = vb.join();
          if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
          return String(va == null ? "" : va).localeCompare(String(vb == null ? "" : vb)) * dir;
        });
      }
      return list;
    }
    function groupKeyOf(it) {
      const c = colBy(st.groupBy); let v = valOf(c, it);
      if (Array.isArray(v)) v = v.length ? v.join("/") : "（空）";
      return v === "" || v == null ? "（空）" : String(v);
    }

    function toolbar() {
      const g = (arr, sel) => arr.map((c) => `<option value="${c.key}" ${sel === c.key ? "selected" : ""}>${esc(c.label)}</option>`).join("");
      const gOpts = '<option value="">不分组</option>' + g(cols.filter((c) => c.groupable), st.groupBy);
      const sOpts = '<option value="">默认</option>' + g(cols.filter((c) => c.sortable !== false), st.sortKey);
      const fOpts = '<option value="">+ 选字段</option>' + g(cols.filter((c) => c.filterable), "");
      const chips = st.filters.map((f, i) => `<span class="gchip">${esc(colBy(f.key).label)}=${esc(f.val)} <b data-rmf="${i}">✕</b></span>`).join("");
      return `<div class="g-tools">
        <span>🗂️ 分组 <select class="g-group">${gOpts}</select></span>
        <span>↕ 排序 <select class="g-sort">${sOpts}</select> <button class="g-dir">${st.sortDir === "desc" ? "↓" : "↑"}</button></span>
        <span>🔽 筛选 <select class="g-ffield">${fOpts}</select> <select class="g-fval" style="display:none"></select></span>
        <span class="g-chips">${chips}</span>
      </div>`;
    }
    function rowHtml(it) {
      const tds = cols.map((c) => `<td>${c.cell ? c.cell(it) : esc(valOf(c, it))}</td>`).join("");
      return `<tr class="g-row" data-rk="${esc(opts.rowKey ? opts.rowKey(it) : "")}">${tds}</tr>`;
    }
    function render() {
      const list = visible();
      if (opts.onVisible) opts.onVisible(list);
      const ths = cols.map((c) => `<th class="${c.sortable !== false ? "g-sortable" : ""}" data-sk="${c.key}">${esc(c.label)}${st.sortKey === c.key ? (st.sortDir === "desc" ? " ↓" : " ↑") : ""}</th>`).join("");
      let body;
      if (!list.length) {
        body = `<tr><td class="g-empty" colspan="${cols.length}">没有匹配的记录</td></tr>`;
      } else if (st.groupBy) {
        const groups = {};
        list.forEach((it) => { const k = groupKeyOf(it); (groups[k] = groups[k] || []).push(it); });
        body = "";
        for (const [gk, items] of Object.entries(groups)) {
          const col = st.collapsed.has(gk);
          body += `<tr class="g-grp" data-g="${esc(gk)}"><td colspan="${cols.length}"><span class="g-caret">${col ? "▶" : "▼"}</span>${esc(gk)}<span class="g-cnt">${items.length}</span></td></tr>`;
          if (!col) body += items.map(rowHtml).join("");
        }
      } else {
        body = list.map(rowHtml).join("");
      }
      opts.mount.innerHTML = toolbar() + `<div class="g-wrap"><table class="g-table"><thead><tr>${ths}</tr></thead><tbody>${body}</tbody></table></div>`;
      wire();
    }
    function wire() {
      const m = opts.mount;
      m.querySelector(".g-group").onchange = (e) => { st.groupBy = e.target.value; render(); };
      m.querySelector(".g-sort").onchange = (e) => { st.sortKey = e.target.value; render(); };
      m.querySelector(".g-dir").onclick = () => { st.sortDir = st.sortDir === "desc" ? "asc" : "desc"; render(); };
      const ff = m.querySelector(".g-ffield"), fv = m.querySelector(".g-fval");
      ff.onchange = () => {
        if (!ff.value) { fv.style.display = "none"; return; }
        fv.innerHTML = '<option value="">选值…</option>' + distinct(colBy(ff.value)).map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join("");
        fv.style.display = "";
      };
      fv.onchange = () => { if (ff.value && fv.value) { st.filters.push({ key: ff.value, val: fv.value }); ff.value = ""; fv.style.display = "none"; render(); } };
      m.querySelectorAll("[data-rmf]").forEach((b) => b.onclick = () => { st.filters.splice(+b.dataset.rmf, 1); render(); });
      m.querySelectorAll("th.g-sortable").forEach((th) => th.onclick = () => {
        const k = th.dataset.sk;
        if (st.sortKey === k) st.sortDir = st.sortDir === "desc" ? "asc" : "desc"; else { st.sortKey = k; st.sortDir = "desc"; }
        render();
      });
      m.querySelectorAll(".g-grp").forEach((h) => h.onclick = () => { const g = h.dataset.g; st.collapsed.has(g) ? st.collapsed.delete(g) : st.collapsed.add(g); render(); });
      if (opts.onRowClick) m.querySelectorAll(".g-row").forEach((r) => r.onclick = () => opts.onRowClick(r.dataset.rk));
    }
    return { setData(d) { data = d; render(); }, getVisible: visible };
  };
})();
