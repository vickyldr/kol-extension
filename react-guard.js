// 防白屏护栏 —— 必须最早、在「页面主世界」里运行（manifest: world=MAIN, run_at=document_start）
//
// 为什么需要它：
//   Instagram / Gmail / Outlook 都是 React 应用。我们的内联翻译会往 React 管理的
//   消息行里插入译文节点。当页面重新渲染那一行时，React 内部会调用
//   removeChild / insertBefore，却发现真实 DOM 和它的虚拟 DOM 对不上（被我们插的节点扰动了），
//   于是抛 NotFoundError。这个错误一路冒泡，导致整棵 React 树卸载 —— 聊天界面整个白屏。
//
// 修复思路（业界对 Google 翻译类扩展致 React 白屏的通用解法）：
//   给这两个 DOM 原生方法加一层防御 —— 当目标节点其实不归当前父节点管时，
//   安静地跳过/退化，而不是抛错。这样 React 的渲染不会被我们的注入打断，页面不再白屏。
//   注意：内容脚本默认在隔离世界，补 Node.prototype 影响不到页面；故本文件以 world=MAIN 注入。
(function () {
  if (window.__kolReactGuardInstalled) return;
  window.__kolReactGuardInstalled = true;

  try {
    const originalRemoveChild = Node.prototype.removeChild;
    Node.prototype.removeChild = function (child) {
      try {
        if (child && child.parentNode !== this) return child; // 已不在我名下 → 别抛错
        return originalRemoveChild.apply(this, arguments);
      } catch (e) {
        return child; // 原生调用万一还抛(React 内部状态错位)→ 一律吞掉，绝不让它冒泡卸载整棵树
      }
    };

    const originalInsertBefore = Node.prototype.insertBefore;
    Node.prototype.insertBefore = function (newNode, referenceNode) {
      try {
        if (referenceNode && referenceNode.parentNode !== this) {
          return originalInsertBefore.call(this, newNode, null); // 参照节点不在我名下 → 退化成 append
        }
        return originalInsertBefore.apply(this, arguments);
      } catch (e) {
        try { return originalInsertBefore.call(this, newNode, null); } catch (_) { return newNode; }
      }
    };

    // React 18 卸载/重排也会用 replaceChild —— 之前没盖，是残留白屏的口子。一并兜住。
    const originalReplaceChild = Node.prototype.replaceChild;
    Node.prototype.replaceChild = function (newChild, oldChild) {
      try {
        if (oldChild && oldChild.parentNode !== this) {
          // 要替换的旧节点已不在我名下 → 只把新节点 append 进来，别抛错
          if (newChild) { try { originalInsertBefore.call(this, newChild, null); } catch (_) {} }
          return oldChild;
        }
        return originalReplaceChild.apply(this, arguments);
      } catch (e) {
        return oldChild;
      }
    };
  } catch (e) {
    /* 万一某些环境禁止改原型，放弃护栏也别影响页面 */
  }
})();
