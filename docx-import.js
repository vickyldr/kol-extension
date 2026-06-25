// docx-import.js —— 浏览器端 Word(.docx) 话术导入解析（零依赖）
//
// 作用：管理员在侧边栏上传一份团队话术 Word，本文件在浏览器里当场把它拆成
//   1) 话术条目（每张表格每一行一条，字段按表头），保持与 knowledge-base.json 相同结构；
//   2) 表格里嵌的示例截图（连同所在「产品/语种/场景」一起带出，后续存进物料库）。
//
// 只用浏览器自带能力：DecompressionStream 解压 zip、DOMParser 读 XML。不给服务器/VPS 加任何依赖。
// 入口：globalThis.KOLDocxImport.parse(arrayBuffer) -> Promise<{ records, images, summary }>
(function () {
  "use strict";

  const WORD_NS = {
    P: "w:p",
    TBL: "w:tbl",
    TR: "w:tr",
    TC: "w:tc",
    T: "w:t",
    SZ: "w:sz",
    B: "w:b"
  };

  // ---------- ZIP 读取（按中央目录，sizes 一定准）----------
  function u16(view, off) {
    return view.getUint16(off, true);
  }
  function u32(view, off) {
    return view.getUint32(off, true);
  }

  async function inflateRaw(bytes) {
    const ds = new DecompressionStream("deflate-raw");
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  // 解析 zip，返回 Map(entryName -> { method, compSize, dataStart, raw:Uint8Array(compressed) })
  function readZipEntries(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const view = new DataView(arrayBuffer);
    // 找 EOCD（0x06054b50），从尾部往前扫（comment 一般为空，但稳妥起见扫一段）
    let eocd = -1;
    for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 22 - 65536; i--) {
      if (u32(view, i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error("不是有效的 .docx（找不到 zip 结尾）");
    const total = u16(view, eocd + 10);
    let cd = u32(view, eocd + 16);
    const entries = new Map();
    for (let n = 0; n < total; n++) {
      if (u32(view, cd) !== 0x02014b50) break;
      const method = u16(view, cd + 10);
      const compSize = u32(view, cd + 20);
      const fnLen = u16(view, cd + 28);
      const extraLen = u16(view, cd + 30);
      const commentLen = u16(view, cd + 32);
      const localOff = u32(view, cd + 42);
      const name = new TextDecoder("utf-8").decode(
        bytes.subarray(cd + 46, cd + 46 + fnLen)
      );
      // 读 local header 算真正的数据起点（local 的 extra 长度可能和 central 不同）
      const lFnLen = u16(view, localOff + 26);
      const lExtraLen = u16(view, localOff + 28);
      const dataStart = localOff + 30 + lFnLen + lExtraLen;
      entries.set(name, {
        method,
        compSize,
        raw: bytes.subarray(dataStart, dataStart + compSize)
      });
      cd += 46 + fnLen + extraLen + commentLen;
    }
    return entries;
  }

  async function entryBytes(entry) {
    if (!entry) return null;
    if (entry.method === 0) return entry.raw; // stored
    if (entry.method === 8) return await inflateRaw(entry.raw); // deflate
    throw new Error("不支持的 zip 压缩方式：" + entry.method);
  }

  async function entryText(entry) {
    const b = await entryBytes(entry);
    return b ? new TextDecoder("utf-8").decode(b) : "";
  }

  function bytesToBase64(bytes) {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(
        null,
        bytes.subarray(i, i + chunk)
      );
    }
    return btoa(binary);
  }

  // ---------- 小工具 ----------
  function clean(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  // 收集某节点下所有 <w:t> 文本（用于段落 / 单元格）
  function collectText(el) {
    const ts = el.getElementsByTagName(WORD_NS.T);
    let out = "";
    for (let i = 0; i < ts.length; i++) out += ts[i].textContent || "";
    return out;
  }

  // 段落最大字号（half-points）+ 是否加粗，用来判断标题层级
  function paragraphHeading(p) {
    let maxSz = 0;
    const szs = p.getElementsByTagName(WORD_NS.SZ);
    for (let i = 0; i < szs.length; i++) {
      const v = parseInt(szs[i].getAttribute("w:val") || "0", 10);
      if (v > maxSz) maxSz = v;
    }
    const bold = p.getElementsByTagName(WORD_NS.B).length > 0;
    return { size: maxSz, bold, text: clean(collectText(p)) };
  }

  // 直接子元素里 tagName 命中的
  function directChildren(el, tag) {
    const out = [];
    const kids = el.childNodes;
    for (let i = 0; i < kids.length; i++) {
      if (kids[i].nodeType === 1 && kids[i].tagName === tag) out.push(kids[i]);
    }
    return out;
  }

  // 解析 word/_rels/document.xml.rels：Id -> Target(media/imageN.ext)
  function parseRels(xmlText) {
    const map = new Map();
    if (!xmlText) return map;
    const doc = new DOMParser().parseFromString(xmlText, "application/xml");
    const rels = doc.getElementsByTagName("Relationship");
    for (let i = 0; i < rels.length; i++) {
      const id = rels[i].getAttribute("Id");
      const target = rels[i].getAttribute("Target");
      if (id && target) map.set(id, target.replace(/^\/?word\//, ""));
    }
    return map;
  }

  // 单元格里嵌的图片 -> 关系 Id（a:blip r:embed / v:imagedata r:id）
  function cellImageRels(tc) {
    const ids = [];
    const blips = tc.getElementsByTagName("a:blip");
    for (let i = 0; i < blips.length; i++) {
      const id = blips[i].getAttribute("r:embed") || blips[i].getAttribute("r:link");
      if (id) ids.push(id);
    }
    const vml = tc.getElementsByTagName("v:imagedata");
    for (let i = 0; i < vml.length; i++) {
      const id = vml[i].getAttribute("r:id");
      if (id) ids.push(id);
    }
    return ids;
  }

  // ---------- 主解析 ----------
  async function parse(arrayBuffer) {
    const entries = readZipEntries(arrayBuffer);
    const docXml = await entryText(entries.get("word/document.xml"));
    if (!docXml) throw new Error("这份 Word 里没有正文（word/document.xml）。");
    const relsMap = parseRels(
      await entryText(entries.get("word/_rels/document.xml.rels"))
    );

    const doc = new DOMParser().parseFromString(docXml, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) {
      throw new Error("Word 正文 XML 解析失败，文件可能损坏。");
    }
    const body = doc.getElementsByTagName(WORD_NS.body || "w:body")[0] || doc.documentElement;

    const records = [];
    const images = [];
    const productSet = new Set();
    const regionSet = new Set();
    let tableCount = 0;
    let currentProduct = "";
    let currentRegion = "";

    const kids = body.childNodes;
    for (let i = 0; i < kids.length; i++) {
      const node = kids[i];
      if (node.nodeType !== 1) continue;

      if (node.tagName === WORD_NS.P) {
        const h = paragraphHeading(node);
        if (!h.text) continue;
        // 字号单位是 half-point：文档大标题≈52、产品标题≈36、语种标题≈32。
        // ≥48 视为封面大标题，跳过不当产品；34–47 当产品；28–33 当语种/地区。
        if (h.bold && h.size >= 34 && h.size < 48) {
          currentProduct = h.text;
          currentRegion = "";
          productSet.add(currentProduct);
        } else if (h.bold && h.size >= 28 && h.size < 34) {
          currentRegion = h.text;
          regionSet.add(currentRegion);
        }
        continue;
      }

      if (node.tagName === WORD_NS.TBL) {
        const ti = tableCount++;
        const rows = directChildren(node, WORD_NS.TR);
        if (!rows.length) continue;
        const headerCells = directChildren(rows[0], WORD_NS.TC);
        const headers = headerCells.map(
          (c, idx) => clean(collectText(c)) || `列${idx + 1}`
        );
        for (let r = 1; r < rows.length; r++) {
          const cells = directChildren(rows[r], WORD_NS.TC);
          const fields = {};
          let nonEmpty = false;
          let firstText = "";
          for (let c = 0; c < cells.length; c++) {
            const value = clean(collectText(cells[c]));
            const key = headers[c] || `列${c + 1}`;
            if (value) {
              fields[key] = value;
              nonEmpty = true;
              if (!firstText) firstText = value;
            }
          }
          if (!nonEmpty) continue;
          const scene = (firstText || `表格 ${ti + 1}`).slice(0, 120);
          records.push({
            source: "Word导入",
            stable_id: `${currentProduct || "通用"}/${currentRegion || "默认"}/t${ti}r${r}`,
            product: currentProduct,
            region: currentRegion,
            scene,
            fields
          });
        }

        // 图片单独再走一遍（异步取字节），带上行场景上下文
        for (let r = 1; r < rows.length; r++) {
          const cells = directChildren(rows[r], WORD_NS.TC);
          let rowScene = "";
          for (let c = 0; c < cells.length; c++) {
            if (!rowScene) rowScene = clean(collectText(cells[c]));
          }
          for (let c = 0; c < cells.length; c++) {
            const relIds = cellImageRels(cells[c]);
            for (const rid of relIds) {
              const target = relsMap.get(rid);
              if (!target) continue;
              const entry = entries.get("word/" + target);
              if (!entry) continue;
              const bytes = await entryBytes(entry);
              if (!bytes || !bytes.length) continue;
              const ext = (target.split(".").pop() || "png").toLowerCase();
              images.push({
                product: currentProduct,
                region: currentRegion,
                scene: (rowScene || `表格 ${ti + 1}`).slice(0, 120),
                ext,
                dataBase64: bytesToBase64(bytes)
              });
            }
          }
        }
      }
    }

    const summary = {
      products: Array.from(productSet),
      regions: Array.from(regionSet),
      tableCount,
      recordCount: records.length,
      imageCount: images.length
    };
    return { records, images, summary };
  }

  globalThis.KOLDocxImport = { parse, readZipEntries, bytesToBase64 };
})();
