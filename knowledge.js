const KOL_SCENARIOS = [
  {
    id: "asks-price",
    stage: "触达与询价",
    intent: "红人询问预算或希望品牌先报价",
    keywords: ["budget", "rate", "rates", "price", "pricing", "how much", "offer"],
    interpretation: "对方有合作意向，但希望先确认预算或报价条件。不要直接承诺未确认的价格。",
    replyEn: "Thanks for getting back to us! Before confirming the budget, I’d love to share the campaign details and a reference with you. Could you also let us know your rate for this collaboration?",
    replyZh: "谢谢你的回复！在确认预算前，我想先把本次合作详情和参考内容发给你。也想请你告知这次合作的报价。",
    risk: "如内部已有预算上限，可填入；没有则继续询价，不要由 AI 编造金额。"
  },
  {
    id: "interested-no-rate",
    stage: "触达与询价",
    intent: "红人表示感兴趣，但没有提供报价",
    keywords: ["interested", "sounds good", "love to", "happy to collaborate", "open to"],
    interpretation: "对方原则上愿意合作，下一步应发送 Brief/参考视频并询价。",
    replyEn: "Great, thank you! I’ll send you the campaign brief and a reference video first. After reviewing them, could you please share your rate and availability with us?",
    replyZh: "太好了，谢谢！我会先发送本次合作的 Brief 和参考视频。查看后，请告诉我们你的报价和档期。",
    risk: "发送前确认内容形式、视频时长、发布平台和广告授权条件。"
  },
  {
    id: "app-free",
    stage: "合作确认",
    intent: "红人询问 App 是否免费或是否需要订阅",
    keywords: ["free", "subscription", "subscribe", "trial", "pay for the app"],
    interpretation: "对方在确认拍摄前是否会产生 App 使用费用。",
    replyEn: "You can search for “Recco” in the App Store or Google Play. The app has a free plan, so you can use it directly. Please don’t start a paid subscription or trial.",
    replyZh: "你可以在 App Store 或 Google Play 搜索“Recco”。应用有免费套餐，可以直接使用，请不要开启付费订阅或试用。",
    risk: "如该项目需要临时会员，应改用对应项目话术，不要发送免费版说明。"
  },
  {
    id: "usage-rights",
    stage: "授权与合同",
    intent: "红人询问广告授权、二次使用或使用期限",
    keywords: ["usage", "usage rights", "ads", "whitelisting", "authorization", "license", "spark ads", "paid media"],
    interpretation: "对方在确认品牌能否投放、转载或编辑视频，以及授权持续多久。",
    replyEn: "The usage right allows our team to use the final video for paid advertising and promotional purposes. Before we proceed, we’ll confirm the platforms, usage period, and whether minor edits or multilingual versions are included in writing.",
    replyZh: "该使用权允许我们将最终视频用于付费广告和品牌推广。推进合作前，我们会书面确认使用平台、授权期限，以及是否包含轻微剪辑或多语言版本。",
    risk: "这是高风险商务条件。必须由运营确认期限、平台和编辑权限，不能默认写成永久或无限使用。"
  },
  {
    id: "payment-method",
    stage: "支付",
    intent: "红人询问付款方式或到账时间",
    keywords: ["payment", "paypal", "bank transfer", "wise", "payoneer", "when will i get paid", "paid"],
    interpretation: "对方需要确认付款渠道、付款节点或预计到账时间。",
    replyEn: "We usually recommend PayPal, but a bank transfer may also be possible. Once all agreed deliverables are completed, I’ll submit the payment request and share the payment confirmation with you.",
    replyZh: "我们通常建议使用 PayPal，也可以视情况使用银行转账。约定的交付内容全部完成后，我会提交付款申请，并向你发送付款凭证。",
    risk: "具体到账日期必须按工作日、财务安排和合同约定填写。"
  },
  {
    id: "draft-deadline",
    stage: "制作与催稿",
    intent: "红人询问初稿时间，或尚未提交初稿",
    keywords: ["draft", "deadline", "deliver", "delivery", "when do you need", "extension", "delay"],
    interpretation: "需要确认明确的初稿日期，或礼貌推进已经延迟的交付。",
    replyEn: "Could you please confirm when you’ll be able to send the first draft? Once we have a clear date, we can arrange the review and keep the campaign schedule on track.",
    replyZh: "请确认一下你预计什么时候可以发送初稿。确定日期后，我们可以安排审核，并确保项目按计划推进。",
    risk: "如果已经约定 DDL，应在回复中写明原定日期；不要把未确认的日期当成承诺。"
  },
  {
    id: "copyright-music",
    stage: "发布后处理",
    intent: "视频包含版权音乐，需要下架修改后重发",
    keywords: ["copyright", "copyrighted music", "bgm", "music rights", "audio issue"],
    interpretation: "当前视频可能无法进行广告投放，需要移除有版权风险的音乐并重新发布。",
    replyEn: "Hi! We noticed that the video contains copyrighted music, which prevents us from running ads. Could you please remove the background music and re-upload the video? Once it’s live again, please send us the new link and ad authorization code. Thank you!",
    replyZh: "你好！我们发现视频包含版权音乐，因此无法进行广告投放。请移除背景音乐并重新上传。重新发布后，请把新链接和广告授权码发给我们，谢谢！",
    risk: "下架重发会影响红人账号内容，发送前应确认确实无法投放。"
  }
];

function normalizeMessage(text) {
  return String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function detectLanguage(text) {
  if (/[\u3040-\u30ff]/.test(text)) return "日语";
  if (/[\uac00-\ud7af]/.test(text)) return "韩语";
  if (/[\u4e00-\u9fff]/.test(text)) return "中文";
  if (/[¿¡]|\b(gracias|precio|colaboración|tarifa)\b/i.test(text)) return "西语";
  if (/\b(obrigad[oa]|preço|parceria|pagamento)\b/i.test(text)) return "葡语";
  return "英语或其他";
}

function matchScenario(text) {
  const normalized = normalizeMessage(text);
  const ranked = KOL_SCENARIOS.map((scenario) => ({
    scenario,
    score: scenario.keywords.reduce(
      (total, keyword) => total + (normalized.includes(keyword) ? 1 : 0),
      0
    )
  })).sort((a, b) => b.score - a.score);

  return ranked[0]?.score > 0 ? ranked[0].scenario : null;
}

globalThis.KOLKnowledge = { scenarios: KOL_SCENARIOS, detectLanguage, matchScenario };
