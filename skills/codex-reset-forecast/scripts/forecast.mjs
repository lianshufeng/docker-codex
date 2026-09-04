#!/usr/bin/env node

import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const OUTPUT_NAME = "codex-reset-forecast.json";
const HTML_NAME = "codex.html";
const HTML_TEMPLATE = new URL("../assets/codex.html", import.meta.url);
const LOCAL_SERVER_NAME = "codex-local-server.mjs";
const LOCAL_SERVER_TEMPLATE = new URL(`../assets/${LOCAL_SERVER_NAME}`, import.meta.url);
const LOCAL_LAUNCHER_NAME = "open-codex.cmd";
const LOCAL_LAUNCHER_TEMPLATE = new URL(`../assets/${LOCAL_LAUNCHER_NAME}`, import.meta.url);
const BASELINE_HISTORY_TEMPLATE = new URL("../assets/baseline.bin", import.meta.url);
const HORIZONS = [2, 4, 8, 12, 24, 72];
const LAMBDAS = [0.01, 0.1, 1, 10, 100];
const DECAYS = [12, 24, 48, 72];
const DEFAULT_WORK_TIMEZONE = "America/Los_Angeles";
const SIGNAL_PRIOR_STRENGTH = 1;
const SCHEMA_VERSION = "1.12.0";
const MODEL_VERSION = "3.2.1";
const CLASSIFICATION_VERSION = "2.0.0";
const POST_TYPES = new Set(["reset_signal", "codex", "limits", "release", "other"]);
const RESET_MEANING_LEVELS = new Map([["none", 0], ["weak", 1], ["directional", 2], ["explicit_future", 3], ["completed", 4]]);
const MIN_RECENT_POSTS = 10;
const MAX_RECENT_POSTS = 30;
const X_EPOCH_MS = 1_288_834_974_657n;
const POST_TIME_TOLERANCE_MS = 60_000;
const REUSE_MAX_AGE_MINUTES = 20;
const FULL_REFRESH_MAX_AGE_HOURS = 24;
const LIVE_COLLECTION_MAX_AGE_MINUTES = 20;
const MIN_VISIBLE_X_POSTS = 3;
const TIBO_X_URL = "https://x.com/thsottiaux";
const TIBO_X_TRANSPORT_URL = "https://proxy.jpy.wang/x.com/thsottiaux";
const TIBO_FEED_URL = "https://codex-reset.com/api/feed";
const DEFAULT_STATE_PATH = "/workspace/codex-reset-forecast.json";
const DEFAULT_LIVE_COLLECTION_PATH = "/tmp/codex-reset-live.json";
const KNOWN_LATEST_POST_FLOOR = { post_id: "2086353229894529148", published_at_utc: "2026-08-09T07:25:47.232Z", url: "https://x.com/thsottiaux/status/2086353229894529148" };
const COOLDOWN_HOUR_CANDIDATES = [6, 12, 24];
const PROMISE_GRACE_HOURS = 2;
const EXPLICIT_SIGNAL_FALLBACK_HOURS = 24;
const KNOWN_POST_TEXT_REPAIRS = new Map(Object.entries({
  "2084738022650892544": { text_zh: "我在 OpenAI 的职位是什么？", classification_evidence: "询问在 OpenAI 的职位，与重置信号无关" },
  "2084483765158719542": { text_zh: "从我最近看到的一些结果来看，Codex 显然是一个很好的执行框架。", classification_evidence: "评价 Codex 执行框架，与重置信号无关" },
  "2084196918071357707": { text_zh: "OpenAI 很神奇：你只要打开笔记本电脑，让 Codex 创建一个 PR，就能把改进发布给 10 亿用户。", signal_level: 0, reset_meaning: "none", classification_evidence: "描述产品开发体验，与重置信号无关" },
  "2083596911060324570": { text_zh: "基本上就是 ChatGPT 发布前一年的样子。当时叫 LMChat，后来又换了一个代号。DeepMind 当时被阻止发布产品。", classification_evidence: "回顾产品历史，与重置信号无关" },
  "2083395449814229287": { text_zh: "为了庆祝高效的一周，也让你这个周末运行 10 万个 Luna 线程……没错……等着瞧……我已经重置了 Codex 和 ChatGPT Work 的使用额度。尽情享受吧。", classification_evidence: "明确表示已重置 Codex 与 ChatGPT Work 的使用额度" },
  "2086188036493344823": { text_zh: "没错，GPT-5.6 Sol 很棒，几乎可以在任何地方使用，包括 CC harness。为了庆祝这一点，也因为我不会离开，我已经为所有 ChatGPT Work 和 Codex 付费用户重置了使用额度。大家玩得开心！", post_type: "reset_signal", signal_level: 4, reset_meaning: "completed", classification_evidence: "明确表示已为所有 ChatGPT Work 和 Codex 付费用户重置额度" },
  "2083024093037953322": { text_zh: "@brandon_galang 小模型也能大有作为。", classification_evidence: "评价小模型，与重置信号无关" },
  "2082883636177916306": { text_zh: "我们一直忙于 GPT-5.6 Sol，它在很多任务上表现很好。此次更新包括：Luna 价格降低 80%、Terra 价格降低 20%、GPT-5.6 Sol 的 /fast 模式更快，以及应用内自动批准模式便宜约 10 倍。", signal_level: 0, reset_meaning: "none", classification_evidence: "产品发布与价格更新，不是重置信号" },
  "2082317452755751098": { text_zh: "Sol 的用户们，大家好！我已经为所有 ChatGPT Work 和 Codex 用户重置了使用额度。同时简单更新一下 GPT-5.6 Sol 的额度情况：过去几周，很多人反馈 Sol 消耗 Codex 额度的速度比预期更快。", classification_evidence: "明确表示已为所有 ChatGPT Work 和 Codex 用户重置额度" },
  "2081940052154933696": { text_zh: "我回到电脑前了。所有 Codex 和 ChatGPT Work 付费用户的使用额度都已重置。太棒了，今天真不错！", classification_evidence: "明确表示已为所有 Codex 和 ChatGPT Work 付费用户重置额度" },
  "2081899343091843463": { text_original: "We're celebrating the fast adoption of ChatGPT Work and all the incredible effort that went into it today. I'm feeling like a limit reset. Hold on tight to your ultra and /fast and see you in a few hours when I'm back at the laptop!", text_zh: "我们正在庆祝 ChatGPT Work 的快速普及，以及今天为此付出的所有努力。我感觉该重置额度了。请留意你的 ultra 和 /fast，几小时后我回到电脑前再见！", classification_evidence: "明确表达将在几小时后进行额度重置" },
  "2081839118531834176": { text_zh: "在 OpenAI 办公室看到 Codex 交到了新朋友。", classification_evidence: "办公动态，与重置信号无关" },
}));
const FEATURE_KEYS = [
  "log_hours_since_last_reset",
  "post_reset_cooldown",
  "decayed_tibo_signal",
  "recent_incident",
  "recent_release_or_milestone",
  "utc_hour_sin",
  "utc_hour_cos",
];

function parseArgs(argv) {
  const args = { input: null, inputOnce: null, inputBase64: null, inputEnv: null, baseHistory: null, state: null, startLive: null, collectLive: null, liveCollection: null, validateInput: null, validateInputBase64: null, probeBase64: null, probePostId: null, probePostAt: null, probePostUrl: null, probeSourceUrl: null, probeCheckedAt: null, existing: null, backtest: null, output: path.resolve(process.cwd(), OUTPUT_NAME), renderExisting: null, report: null, printReport: false, postUrl: null, postToken: null, selfTest: false, smokeTest: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--input") args.input = argv[++i];
    else if (argv[i] === "--input-once") args.inputOnce = argv[++i];
    else if (argv[i] === "--input-base64") args.inputBase64 = argv[++i];
    else if (argv[i] === "--input-env") args.inputEnv = argv[++i];
    else if (argv[i] === "--base-history") args.baseHistory = path.resolve(argv[++i]);
    else if (argv[i] === "--state") args.state = path.resolve(argv[++i]);
    else if (argv[i] === "--start-live") args.startLive = path.resolve(argv[++i]);
    else if (argv[i] === "--collect-live") args.collectLive = path.resolve(argv[++i]);
    else if (argv[i] === "--live-collection") args.liveCollection = path.resolve(argv[++i]);
    else if (argv[i] === "--validate-input") args.validateInput = argv[++i];
    else if (argv[i] === "--validate-input-base64") args.validateInputBase64 = argv[++i];
    else if (argv[i] === "--probe-base64") args.probeBase64 = argv[++i];
    else if (argv[i] === "--probe-post-id") args.probePostId = argv[++i];
    else if (argv[i] === "--probe-post-at") args.probePostAt = argv[++i];
    else if (argv[i] === "--probe-post-url") args.probePostUrl = argv[++i];
    else if (argv[i] === "--probe-source-url") args.probeSourceUrl = argv[++i];
    else if (argv[i] === "--probe-checked-at") args.probeCheckedAt = argv[++i];
    else if (argv[i] === "--existing") args.existing = path.resolve(argv[++i]);
    else if (argv[i] === "--backtest") args.backtest = argv[++i];
    else if (argv[i] === "--output") args.output = path.resolve(argv[++i]);
    else if (argv[i] === "--render-existing") args.renderExisting = path.resolve(argv[++i]);
    else if (argv[i] === "--report") args.report = path.resolve(argv[++i]);
    else if (argv[i] === "--print-report") args.printReport = true;
    else if (argv[i] === "--post-url") args.postUrl = argv[++i];
    else if (argv[i] === "--post-token") args.postToken = argv[++i];
    else if (argv[i] === "--self-test") args.selfTest = true;
    else if (argv[i] === "--smoke-test") args.smokeTest = true;
    else if (argv[i] === "--help" || argv[i] === "-h") args.help = true;
    else throw new Error(`未知参数：${argv[i]}`);
  }
  return args;
}

function usage() {
  return [
    "Codex Reset Forecast 3.18.1",
    "",
    "紧凑增量（推荐）：node scripts/forecast.mjs --input-once .codex-reset-input.json --base-history <existing.json> --print-report [--output <json>]",
    "读取紧凑状态：node scripts/forecast.mjs --state <existing.json>",
    "安全实时入口：node scripts/forecast.mjs --start-live <snapshot.json> --state <existing.json>",
    "实时完整性清单：node scripts/forecast.mjs --collect-live <snapshot.json> --state <existing.json>",
    "文件增量（兼容）：node scripts/forecast.mjs --input <delta.json> --base-history <existing.json> --print-report [--output <json>]",
    "完整历史重建：node scripts/forecast.mjs --input <snapshot.json> --print-report [--output <json>]",
    "完整刷新（兼容）：node scripts/forecast.mjs --input-base64 <base64|-> [--output <json>]",
    "诊断预检：node scripts/forecast.mjs --validate-input <snapshot.json>",
    "快速门禁：node scripts/forecast.mjs --probe-base64 <base64> --existing <json>",
    "生成对话报告：node scripts/forecast.mjs --report <codex-reset-forecast.json>",
    "快速自检：node scripts/forecast.mjs --smoke-test",
    "完整自检：node scripts/forecast.mjs --self-test",
  ].join("\n");
}

function readInputText(inputPath, base64Source = null, inputEnv = null) {
  if (inputEnv != null) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(inputEnv)) throw new Error("--input-env 名称无效");
    if (process.env[inputEnv] == null) throw new Error(`环境变量 ${inputEnv} 不存在`);
    return process.env[inputEnv];
  }
  if (base64Source != null) {
    const encoded = base64Source === "-" ? fs.readFileSync(0, "ascii").trim() : base64Source;
    return Buffer.from(encoded, "base64").toString("utf8");
  }
  return inputPath === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(path.resolve(inputPath), "utf8");
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function iso(value, field) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) throw new Error(`${field} 不是有效的 ISO 8601 时间`);
  return date.toISOString();
}

function beijingIso(value) {
  const date = new Date(value);
  const local = new Date(date.getTime() + 8 * 3600_000).toISOString().replace("Z", "+08:00");
  return local;
}

function readInputOnce(inputPath) {
  const resolved = path.resolve(inputPath);
  if (!/^\.?codex-reset-input(?:-[A-Za-z0-9_-]+)?\.json$/.test(path.basename(resolved))) throw new Error("--input-once 只允许使用专用 codex-reset-input JSON 文件");
  try {
    return fs.readFileSync(resolved, "utf8");
  } finally {
    if (fs.existsSync(resolved)) fs.rmSync(resolved);
  }
}

function hasEncodingCorruption(value) {
  return /[\uFFFD\uE000-\uF8FF]|\?{3,}/u.test(JSON.stringify(value));
}

function repairKnownPostText(post) {
  const repair = KNOWN_POST_TEXT_REPAIRS.get(String(post?.post_id ?? ""));
  return repair ? { ...post, ...repair, translation_method: "chatgpt" } : post;
}

function assertLiveAsOf(rawInput) {
  const expanded = expandCompactInput(rawInput);
  const value = expanded?.current?.as_of_utc;
  const timestamp = new Date(value).getTime();
  const skewMinutes = Math.abs(Date.now() - timestamp) / 60_000;
  if (!Number.isFinite(timestamp) || skewMinutes > 20) throw new Error("as_of_utc 必须使用本次 probe 返回的 checked_at_utc 或当前 UTC，且距系统时间不超过 20 分钟");
  return expanded;
}

function mergeByKey(baseItems, newItems, key) {
  const merged = new Map();
  for (const item of [...baseItems, ...newItems]) if (item && item[key] != null) merged.set(String(item[key]), item);
  return [...merged.values()];
}

function mergeRecentPosts(baseItems, newItems) {
  const merged = new Map(baseItems.filter(Boolean).map((item) => [String(item.post_id), item]));
  if (newItems.some((item) => item?.is_latest_overall === true)) {
    for (const [key, item] of merged) merged.set(key, { ...item, is_latest_overall: false });
  }
  for (const item of newItems.filter(Boolean)) {
    const key = String(item.post_id ?? "");
    if (item.exclude === true) {
      merged.delete(key);
      continue;
    }
    if (!merged.has(key) || item.correction === true) merged.set(key, item);
  }
  return [...merged.values()];
}

function inferredResetMeaning(post) {
  const level = Number(post?.signal_level ?? 0);
  if (post?.post_type !== "reset_signal") return "none";
  return [...RESET_MEANING_LEVELS].find(([, expectedLevel]) => expectedLevel === level)?.[0] ?? "none";
}

function hasExplicitCompletedResetMeaning(text) {
  const value = String(text).replace(/[’]/g, "'").replace(/\s+/g, " ");
  return [
    /\b(?:i|we)(?:'ve| have)\s+(?:just\s+|now\s+)?reset\b/i,
    /\b(?:usage\s+)?limits?\s+(?:have|has)\s+been\s+reset\b/i,
    /\b(?:usage\s+)?limits?\s+(?:were|are)\s+(?:now\s+)?reset\b/i,
    /\breset\s+(?:is|has been)\s+(?:done|complete|completed)\b/i,
    /\bresets?\s+(?:are|is)\s+(?:now\s+)?(?:live|done|complete|completed)\b/i,
  ].some((pattern) => pattern.test(value));
}

function inferredPromisedWindowEndAt(post) {
  if (post?.promised_window_end_at_utc || post?.window_end) return iso(post.promised_window_end_at_utc ?? post.window_end, "post.promised_window_end_at_utc");
  const publishedAtMs = new Date(post?.published_at_utc ?? post?.at).getTime();
  if (!Number.isFinite(publishedAtMs)) return null;
  const text = String(post?.text_original ?? post?.text ?? "").replace(/[’]/g, "'").replace(/\s+/g, " ");
  let hours = null;
  const numericHours = text.match(/\b(?:in\s+)?(?:the\s+)?next\s+(\d+(?:\.\d+)?)\s+hours?\b/i);
  if (numericHours) hours = Number(numericHours[1]);
  else if (/\bnext\s+hour\s+or\s+so\b/i.test(text)) hours = 2;
  else if (/\b(?:in\s+)?(?:the\s+)?next\s+hour\b|\bin\s+an\s+hour\b/i.test(text)) hours = 1;
  else if (/\b(?:in\s+)?a\s+few\s+hours\b|\bin\s+few\s+hours\b/i.test(text)) hours = 6;
  else if (/\btomorrow\b/i.test(text)) hours = 36;
  return Number.isFinite(hours) && hours > 0 ? new Date(publishedAtMs + hours * 3600_000).toISOString() : null;
}

function historicalSignalsFromRecentPosts(posts, asOf) {
  return (Array.isArray(posts) ? posts : []).filter((post) => post?.exclude !== true).map((post) => {
    const normalized = normalizeRecentPost(post);
    if (normalized.post_type !== "reset_signal" || normalized.signal_level <= 0 || normalized.signal_level >= 4) return null;
    return {
      post_id: normalized.post_id,
      published_at_utc: normalized.published_at_utc,
      url: normalized.url,
      text: normalized.text_original,
      signal_level: normalized.signal_level,
      intent_class: normalized.reset_meaning === "explicit_future" ? "explicit_commitment" : normalized.reset_meaning === "directional" ? "directional_reset" : "weak_mention",
      has_explicit_timing: normalized.reset_meaning === "explicit_future",
      promised_window_end_at_utc: inferredPromisedWindowEndAt(post),
      outcome_status: "not_observed",
      outcome_time_kind: "right_censored",
      reset_at_utc: null,
      latency_lower_hours: null,
      latency_upper_hours: null,
      observation_end_at_utc: asOf,
      confidence: 1,
      classification_evidence: normalized.classification_evidence,
      matched_reset_event_id: null,
      hours_to_reset: null,
      reset_within_4h: false,
      reset_within_24h: false,
      reset_within_72h: false,
    };
  }).filter(Boolean);
}

function compactObservedResetEvents(rawInput) {
  if (!Array.isArray(rawInput?.reset_events)) return [];
  const sourceByRef = new Map((rawInput.sources ?? []).map((source) => [String(source.ref ?? source.url ?? ""), source]));
  return rawInput.reset_events.map((event, index) => {
    const label = `reset_events[${index}]`;
    const sourceRefs = Array.isArray(event?.source_refs) ? [...new Set(event.source_refs.map(String))] : [];
    const supportingSources = sourceRefs.map((ref) => sourceByRef.get(ref));
    const groups = new Set(supportingSources.map((source) => String(source?.group ?? "")).filter(Boolean));
    if (!String(event?.id ?? "").trim() || !event?.at || !String(event?.url ?? "").trim()) throw new Error(`${label} 缺少 id、at 或 url`);
    if (sourceRefs.length < 2 || supportingSources.some((source) => !source) || groups.size < 2 || supportingSources.some((source) => !(source.scopes ?? []).includes("reset_history"))) throw new Error(`${label} 必须由两个不同 group 且声明 reset_history 的来源共同核验`);
    const eventAt = iso(event.at, `${label}.at`);
    const effectiveAt = event.effective_at ? iso(event.effective_at, `${label}.effective_at`) : eventAt;
    if (new Date(eventAt).getTime() > new Date(rawInput.as_of_utc).getTime()) throw new Error(`${label}.at 不能晚于 as_of_utc`);
    if (new Date(effectiveAt).getTime() > new Date(rawInput.as_of_utc).getTime()) throw new Error(`${label}.effective_at 不能晚于 as_of_utc`);
    const confidence = Number(event.confidence ?? 0.9);
    if (!Number.isFinite(confidence) || confidence < 0.7 || confidence > 1) throw new Error(`${label}.confidence 必须为 0.7—1`);
    return {
      event_id: `reset-observed-${String(event.id)}`, event_type: "confirmed_reset", announced_at_utc: eventAt,
      effective_at_utc: effectiveAt,
      post_id: null, source_url: String(event.url), confidence,
      reason_tags: ["silent_reset_observation", ...sourceRefs.map((ref) => `source:${ref}`)], included_in_training: true, exclusion_reason: null,
    };
  });
}

function assertCompactPostClassifications(rawInput) {
  if (rawInput?.classification_version !== CLASSIFICATION_VERSION) throw new Error(`classification_version 必须为 ${CLASSIFICATION_VERSION}，旧分类不得复用`);
  rawInput.posts.forEach((post, index) => {
    if (post?.exclude === true) return;
    const label = `posts[${index}]${post?.id ? `(${post.id})` : ""}`;
    const type = String(post?.type ?? "");
    const meaning = String(post?.reset_meaning ?? "");
    const level = Number(post?.level);
    if (!POST_TYPES.has(type)) throw new Error(`${label}.type 无效，只能使用 reset_signal、codex、limits、release、other`);
    if (!RESET_MEANING_LEVELS.has(meaning)) throw new Error(`${label}.reset_meaning 无效，只能使用 none、weak、directional、explicit_future、completed`);
    if (!Number.isInteger(level) || level !== RESET_MEANING_LEVELS.get(meaning)) throw new Error(`${label}.level 与 reset_meaning 不一致`);
    if (meaning === "none" ? type === "reset_signal" : type !== "reset_signal") throw new Error(`${label}.type 与 reset_meaning 不一致`);
    if (typeof post?.confirmed_event !== "boolean") throw new Error(`${label}.confirmed_event 必须显式填写布尔值`);
    if (post.confirmed_event && meaning !== "completed") throw new Error(`${label} 只有 completed/Lv.4 可设置 confirmed_event:true`);
    if (!String(post?.zh ?? "").trim() || !String(post?.evidence ?? "").trim()) throw new Error(`${label} 缺少 LLM 中文翻译或逐条语义分类依据`);
    if (meaning === "completed" && !hasExplicitCompletedResetMeaning(post?.text)) throw new Error(`${label} 原文没有明确的已完成重置语义，禁止标为 completed/Lv.4`);
  });
}

function expandCompactInput(rawInput) {
  if (rawInput?.current || !Array.isArray(rawInput?.posts) || !Array.isArray(rawInput?.sources)) return rawInput;
  assertCompactPostClassifications(rawInput);
  const posts = rawInput.posts.map((post) => ({
    post_id: String(post.id ?? ""),
    published_at_utc: post.at,
    url: String(post.url ?? ""),
    text_original: String(post.text ?? ""),
    ...(post.zh ? { text_zh: String(post.zh), translation_method: "chatgpt" } : {}),
    post_type: String(post.type ?? "other"),
    signal_level: Number(post.level ?? 0),
    reset_meaning: String(post.reset_meaning ?? "none"),
    ...(post.window_end ? { promised_window_end_at_utc: post.window_end } : {}),
    ...(post.evidence ? { classification_evidence: String(post.evidence) } : {}),
    ...(post.correction === true ? { correction: true } : {}),
    ...(post.exclude === true ? { exclude: true } : {}),
    confirmed_event: post.confirmed_event === true,
    ...(typeof post.latest === "boolean" ? { is_latest_overall: post.latest } : {}),
  }));
  const postsById = new Map(posts.map((post) => [post.post_id, post]));
  const completedResetEvents = posts.filter((post) => post.exclude !== true && post.confirmed_event === true && post.reset_meaning === "completed" && post.post_type === "reset_signal" && post.signal_level === 4).map((post) => ({
    event_id: `reset-${post.post_id}`, event_type: "confirmed_reset", announced_at_utc: post.published_at_utc,
    effective_at_utc: null, post_id: post.post_id, source_url: post.url, confidence: 1,
    reason_tags: ["tibo_announcement"], included_in_training: true, exclusion_reason: null,
  })).concat(compactObservedResetEvents(rawInput));
  const currentSignals = historicalSignalsFromRecentPosts(posts, rawInput.as_of_utc);
  return {
    classification_version: rawInput.classification_version,
    current: { as_of_utc: rawInput.as_of_utc, cross_source_consistent: rawInput.cross_source_consistent !== false, tibo_work_timezone: rawInput.tibo_work_timezone ?? DEFAULT_WORK_TIMEZONE, recent_tibo_posts: posts },
    sources: rawInput.sources.map((source) => {
      const scopes = Array.isArray(source.scopes) ? source.scopes.map(String) : [];
      const observed = scopes.includes("latest_overall") ? postsById.get(String(source.post_id ?? "")) : null;
      return {
        source_id: String(source.id ?? ""), name: String(source.name ?? source.id ?? "remote source"), url: String(source.url ?? ""),
        retrieved_at_utc: rawInput.as_of_utc, source_reported_fetched_at_utc: source.fetched_at ?? null,
        independence_group: String(source.group ?? ""), evidence_scopes: scopes,
        retrieval_method: "chatgpt_remote_web_search", status: String(source.status ?? "ok"), evidence_ref: String(source.ref ?? source.url ?? ""),
        observed_post_id: observed?.post_id ?? null, observed_post_at_utc: observed?.published_at_utc ?? null, observed_post_url: observed?.url ?? null,
      };
    }),
    refresh: { checked_at_utc: rawInput.as_of_utc, last_full_refresh_at_utc: rawInput.as_of_utc, status_indicator: rawInput.status_indicator ?? "unknown", active_incident_id: rawInput.active_incident_id ?? null },
    reasoning_context: rawInput.reasoning_context ?? {}, historical_events: completedResetEvents, historical_signals: currentSignals, historical_contexts: [],
  };
}

function mergeBaseHistory(rawInput, baseHistoryPath) {
  rawInput = expandCompactInput(rawInput);
  const baseSource = baseHistoryPath && fs.existsSync(baseHistoryPath) ? baseHistoryPath : BASELINE_HISTORY_TEMPLATE;
  const base = JSON.parse(baseSource === BASELINE_HISTORY_TEMPLATE ? readBundledBaseline() : readUtf8NoBom(baseSource));
  if (!Array.isArray(base.history?.events) || !Array.isArray(base.history?.signals) || !Array.isArray(base.history?.contexts)) throw new Error("--base-history 缺少可复用的 history 数组");
  return {
    ...rawInput,
    refresh: { ...rawInput.refresh, cached_history_verified: true },
    current: {
      ...base.current,
      ...rawInput.current,
      latest_overall_post: rawInput.current?.latest_overall_post ?? null,
      latest_reset_signal: rawInput.current?.latest_reset_signal ?? null,
      recent_tibo_posts: mergeRecentPosts(base.current?.recent_tibo_posts ?? [], rawInput.current?.recent_tibo_posts ?? []),
    },
    historical_events: mergeByKey(base.history.events, rawInput.historical_events ?? [], "event_id"),
    historical_signals: mergeByKey(base.history.signals, [...historicalSignalsFromRecentPosts(base.current?.recent_tibo_posts ?? [], rawInput.current?.as_of_utc), ...(rawInput.historical_signals ?? [])], "post_id"),
    historical_contexts: mergeByKey(base.history.contexts, rawInput.historical_contexts ?? [], "context_id"),
  };
}

function optionalIso(value, field) {
  return value == null || value === "" ? null : iso(value, field);
}

function urlHost(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isOfficialOpenAIUrl(value) {
  const host = urlHost(value);
  return host === "openai.com" || host.endsWith(".openai.com");
}

function sourceEffectiveRetrievedAt(source) {
  const retrieved = new Date(source.retrieved_at_utc).getTime();
  const reported = source.source_reported_fetched_at_utc == null ? retrieved : new Date(source.source_reported_fetched_at_utc).getTime();
  return new Date(Math.min(retrieved, reported)).toISOString();
}

function normalizeSource(source, asOf, label = "source") {
  const retrievedAt = iso(source?.retrieved_at_utc, `${label}.retrieved_at_utc`);
  const reportedAt = optionalIso(source?.source_reported_fetched_at_utc, `${label}.source_reported_fetched_at_utc`);
  const normalized = {
    source_id: String(source?.source_id ?? ""),
    name: String(source?.name ?? ""),
    url: String(source?.url ?? ""),
    retrieved_at_utc: retrievedAt,
    source_reported_fetched_at_utc: reportedAt,
    effective_retrieved_at_utc: null,
    independence_group: String(source?.independence_group ?? ""),
    evidence_scopes: Array.isArray(source?.evidence_scopes) ? [...new Set(source.evidence_scopes.map(String))] : [],
    observed_post_id: source?.observed_post_id == null ? null : String(source.observed_post_id),
    observed_post_at_utc: optionalIso(source?.observed_post_at_utc, `${label}.observed_post_at_utc`),
    observed_post_url: source?.observed_post_url == null ? null : String(source.observed_post_url),
    retrieval_method: String(source?.retrieval_method ?? ""),
    status: String(source?.status ?? "failed"),
    fresh: false,
    evidence_ref: String(source?.evidence_ref ?? ""),
  };
  normalized.effective_retrieved_at_utc = sourceEffectiveRetrievedAt(normalized);
  const ageMinutes = (new Date(asOf) - new Date(normalized.effective_retrieved_at_utc)) / 60_000;
  normalized.fresh = normalized.status !== "failed" && ageMinutes >= -5 && ageMinutes <= 20;
  return normalized;
}

function snowflakeTimestampMs(postId) {
  if (!/^\d+$/.test(String(postId ?? ""))) return null;
  const timestamp = (BigInt(postId) >> 22n) + X_EPOCH_MS;
  return timestamp <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(timestamp) : null;
}

function compareRecentPosts(a, b) {
  const timeDifference = new Date(b.published_at_utc) - new Date(a.published_at_utc);
  if (timeDifference) return timeDifference;
  if (/^\d+$/.test(a.post_id) && /^\d+$/.test(b.post_id)) return BigInt(b.post_id) > BigInt(a.post_id) ? 1 : BigInt(b.post_id) < BigInt(a.post_id) ? -1 : 0;
  return String(b.post_id).localeCompare(String(a.post_id));
}

function maxRecentPostById(posts) {
  return (Array.isArray(posts) ? posts : []).filter((post) => /^\d+$/.test(String(post?.post_id ?? ""))).reduce((latest, post) => !latest || BigInt(post.post_id) > BigInt(latest.post_id) ? post : latest, null);
}

async function fetchLiveText(url, label) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    let response;
    try {
      response = await fetch(url, {
        headers: { Accept: "text/html,application/json", "User-Agent": "Mozilla/5.0 CodexResetForecast/3.16" },
        redirect: "follow",
        signal: controller.signal,
      });
    } catch (error) {
      throw new Error(`${label}抓取失败：${error?.cause?.message ?? error.message}`, { cause: error });
    }
    if (!response.ok) throw new Error(`${label}抓取失败：HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function xPostIdsFromHtml(xHtml) {
  const ids = [...String(xHtml).matchAll(/\/thsottiaux\/status\/(\d{15,22})/g)].map((match) => match[1]);
  return [...new Set(ids)].sort((a, b) => BigInt(a) > BigInt(b) ? -1 : BigInt(a) < BigInt(b) ? 1 : 0);
}

function classifyVisibleXPostIds(xHtml, feedTweets) {
  const tweetsById = new Map((Array.isArray(feedTweets) ? feedTweets : []).map((tweet) => [String(tweet?.id ?? ""), tweet]));
  const eligible = xPostIdsFromHtml(xHtml).filter((id) => {
    const tweet = tweetsById.get(id);
    return tweet?.is_reply !== true || String(tweet?.replying_to ?? "").toLowerCase() === "thsottiaux";
  });
  const selfThreadIds = new Set([...tweetsById].filter(([, tweet]) => tweet?.is_reply === true && String(tweet?.replying_to ?? "").toLowerCase() === "thsottiaux").map(([id]) => id));
  return { eligible, topLevel: eligible.filter((id) => !selfThreadIds.has(id)) };
}

function readLiveCollection(collectionPath) {
  if (!collectionPath) throw new Error("缺少 --live-collection 完整性清单");
  const collection = JSON.parse(readUtf8NoBom(collectionPath));
  const checkedAt = iso(collection.checked_at_utc, "live_collection.checked_at_utc");
  const ageMinutes = (Date.now() - new Date(checkedAt).getTime()) / 60_000;
  if (collection.schema_version !== 1 || ageMinutes < -5 || ageMinutes > LIVE_COLLECTION_MAX_AGE_MINUTES) throw new Error("实时完整性清单无效或已超过 20 分钟");
  if (!Array.isArray(collection.required_posts) || !collection.required_posts.length) throw new Error("实时完整性清单没有帖子记录");
  return collection;
}

function collectionGaps(collection, posts) {
  const knownIds = new Set((Array.isArray(posts) ? posts : []).map((post) => String(post?.post_id ?? "")));
  return collection.required_posts.map((post) => String(post?.post_id ?? "")).filter((id) => /^\d+$/.test(id) && !knownIds.has(id));
}

function collectionMismatches(collection, posts) {
  const postsById = new Map((Array.isArray(posts) ? posts : []).map((post) => [String(post?.post_id ?? ""), post]));
  return collection.required_posts.filter((required) => {
    const existing = postsById.get(String(required.post_id));
    return existing && required.text_original && comparableXText(existing.text_original ?? existing.text ?? "") !== comparableXText(required.text_original);
  }).map((post) => String(post.post_id));
}

function assertLiveCollectionComplete(rawInput, collectionPath) {
  const collection = readLiveCollection(collectionPath);
  const asOf = iso(rawInput?.current?.as_of_utc, "current.as_of_utc");
  if (asOf !== iso(collection.checked_at_utc, "live_collection.checked_at_utc")) throw new Error("as_of_utc 必须与实时完整性清单 checked_at_utc 完全一致");
  const posts = rawInput?.current?.recent_tibo_posts ?? [];
  const gaps = collectionGaps(collection, posts);
  if (gaps.length) throw new Error(`实时完整性校验失败，仍缺少帖子：${gaps.join(",")}`);
  const postsById = new Map(posts.map((post) => [String(post?.post_id ?? ""), post]));
  const latestOverallId = String(collection.latest_overall_post?.post_id ?? "");
  for (const post of posts) post.is_latest_overall = String(post?.post_id ?? "") === latestOverallId;
  if (!postsById.has(latestOverallId)) throw new Error("实时完整性清单中的 X Posts 顶部主帖不在合并时间线中");
  for (const required of collection.required_posts) {
    const post = postsById.get(String(required.post_id));
    post.published_at_utc = required.published_at_utc;
    post.url = required.url;
    if (required.text_original) post.text_original = required.text_original;
  }
  return collection;
}

function decodeHtmlEntities(value) {
  return String(value).replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function comparableXText(value) {
  return decodeHtmlEntities(decodeHtmlEntities(String(value))).replace(/\s*https:\/\/t\.co\/\S+/g, "").replace(/\s+/g, " ").trim();
}

function xStatusTransportUrl(postId) {
  return `${TIBO_X_TRANSPORT_URL}/status/${postId}`;
}

function textFromXStatusHtml(raw, postId) {
  const html = String(raw);
  const title = html.match(/<title>Tibo on X: &quot;([\s\S]*?) \/ X<\/title>/i)?.[1];
  if (!title) throw new Error(`X 代理未返回帖子 ${postId} 的标题正文`);
  const titleText = decodeHtmlEntities(decodeHtmlEntities(title)).replace(/"$/, "").trim();
  const noteTexts = [...html.matchAll(/__typename:"NoteTweet",text:"((?:\\.|[^"\\])*)"/g)].map((match) => {
    try { return decodeHtmlEntities(decodeHtmlEntities(JSON.parse(`"${match[1]}"`))).trim(); } catch { return ""; }
  }).filter(Boolean);
  const titlePrefix = titleText.replace(/\s*(?:…|\.\.\.)$/, "").trimEnd();
  const matchingNote = noteTexts.filter((text) => text.startsWith(titlePrefix)).sort((a, b) => b.length - a.length)[0];
  return matchingNote ?? titleText;
}

async function collectLiveSnapshot(statePath, collectionPath) {
  if (!statePath) throw new Error("--collect-live 必须同时提供 --state");
  const usingSeed = !fs.existsSync(statePath);
  const existing = JSON.parse(usingSeed ? readBundledBaseline() : readUtf8NoBom(statePath));
  const existingPosts = existing.current?.recent_tibo_posts ?? [];
  const existingIds = new Set(existingPosts.map((post) => String(post?.post_id ?? "")));
  const floorPost = maxRecentPostById(existingPosts) ?? KNOWN_LATEST_POST_FLOOR;
  const [xHtml, feedText] = await Promise.all([
    fetchLiveText(TIBO_X_TRANSPORT_URL, "Tibo X Posts 代理"),
    fetchLiveText(TIBO_FEED_URL, "Tibo feed"),
  ]);
  const feed = JSON.parse(feedText);
  const feedFetchedAt = iso(feed.fetched_at, "feed.fetched_at");
  const feedAgeMinutes = (Date.now() - new Date(feedFetchedAt).getTime()) / 60_000;
  if (feed.stale !== false || feedAgeMinutes < -5 || feedAgeMinutes > LIVE_COLLECTION_MAX_AGE_MINUTES) throw new Error("Tibo feed 已过期，无法建立完整性清单");

  const feedTweets = Array.isArray(feed.tweets) ? feed.tweets : [];
  const { eligible: xPostIds, topLevel: xTopLevelPostIds } = classifyVisibleXPostIds(xHtml, feedTweets);
  if (xTopLevelPostIds.length < MIN_VISIBLE_X_POSTS) throw new Error(`X Posts 页面只返回 ${xTopLevelPostIds.length} 条可验证的 Tibo 主帖，少于最近 ${MIN_VISIBLE_X_POSTS} 条完整性窗口`);
  const visibleFloorId = xPostIds.reduce((lowest, id) => BigInt(id) < BigInt(lowest) ? id : lowest, xPostIds[0]);
  const required = new Map(xPostIds.map((id) => [id, {
    post_id: id,
    published_at_utc: new Date(snowflakeTimestampMs(id)).toISOString(),
    url: `${TIBO_X_URL}/status/${id}`,
    discovered_by: ["x_posts"],
  }]));
  for (const tweet of feedTweets) {
    const id = String(tweet?.id ?? "");
    const eligible = tweet?.is_reply !== true || String(tweet?.replying_to ?? "").toLowerCase() === "thsottiaux";
    if (!eligible || !/^\d+$/.test(id) || BigInt(id) < BigInt(visibleFloorId)) continue;
    const prior = required.get(id);
    required.set(id, {
      post_id: id,
      published_at_utc: iso(tweet.at ?? new Date(snowflakeTimestampMs(id)).toISOString(), `feed.tweets.${id}.at`),
      url: String(tweet.url ?? `${TIBO_X_URL}/status/${id}`),
      discovered_by: [...new Set([...(prior?.discovered_by ?? []), tweet.is_reply === true ? "feed_self_thread" : "feed_top_level"])],
    });
  }
  const statusTexts = await Promise.all([...required.keys()].map(async (id) => [id, textFromXStatusHtml(await fetchLiveText(xStatusTransportUrl(id), `X 代理帖子 ${id}`), id)]));
  for (const [id, textOriginal] of statusTexts) required.get(id).text_original = textOriginal;
  const requiredPosts = [...required.values()].sort((a, b) => BigInt(a.post_id) < BigInt(b.post_id) ? -1 : 1);
  const probePost = [...requiredPosts, floorPost].reduce((latest, post) => BigInt(post.post_id) > BigInt(latest.post_id) ? post : latest);
  const snapshot = {
    schema_version: 1,
    checked_at_utc: new Date().toISOString(),
    state_path: path.resolve(statePath),
    state_source: usingSeed ? "bundled_seed" : "existing_output",
    state_probe_floor_post_id: String(floorPost.post_id),
    latest_overall_post: required.get(xTopLevelPostIds[0]),
    probe_post: probePost,
    visible_x_post_ids: xPostIds,
    visible_x_top_level_post_ids: xTopLevelPostIds,
    x_transport_url: TIBO_X_TRANSPORT_URL,
    required_posts: requiredPosts,
    missing_from_state: requiredPosts.filter((post) => !existingIds.has(post.post_id)).map((post) => post.post_id),
    mismatched_in_state: collectionMismatches({ required_posts: requiredPosts }, existingPosts),
    feed_fetched_at_utc: feedFetchedAt,
  };
  fs.mkdirSync(path.dirname(collectionPath), { recursive: true });
  const temporary = `${collectionPath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, collectionPath);
  return snapshot;
}

function localTimeParts(value, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(value)).map((part) => [part.type, part.value]));
  return { hour: Number(parts.hour), minute: Number(parts.minute), weekday: parts.weekday };
}

function sigmoid(value) {
  if (value >= 0) return 1 / (1 + Math.exp(-Math.min(value, 40)));
  const exp = Math.exp(Math.max(value, -40));
  return exp / (1 + exp);
}

function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

function solveLinear(matrix, vector) {
  const n = vector.length;
  const a = matrix.map((row, i) => [...row, vector[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) < 1e-10) a[pivot][col] += 1e-8;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const divisor = a[col][col];
    for (let j = col; j <= n; j += 1) a[col][j] /= divisor;
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = a[row][col];
      for (let j = col; j <= n; j += 1) a[row][j] -= factor * a[col][j];
    }
  }
  return a.map((row) => row[n]);
}

function fitLogistic(rawRows, featureKeys, lambda) {
  const means = featureKeys.map((key) => rawRows.reduce((sum, row) => sum + row.features[key], 0) / rawRows.length);
  const scales = featureKeys.map((key, index) => {
    const variance = rawRows.reduce((sum, row) => sum + (row.features[key] - means[index]) ** 2, 0) / rawRows.length;
    return Math.sqrt(variance) > 1e-8 ? Math.sqrt(variance) : 1;
  });
  const rows = rawRows.map((row) => ({
    x: [1, ...featureKeys.map((key, index) => (row.features[key] - means[index]) / scales[index])],
    y: row.y,
  }));
  let beta = Array(featureKeys.length + 1).fill(0);
  const eventRate = Math.min(0.99, Math.max(0.0001, rows.reduce((sum, row) => sum + row.y, 0) / rows.length));
  beta[0] = Math.log(eventRate / (1 - eventRate));
  let converged = false;
  for (let iteration = 0; iteration < 120; iteration += 1) {
    const gradient = Array(beta.length).fill(0);
    const hessian = Array.from({ length: beta.length }, () => Array(beta.length).fill(0));
    for (const row of rows) {
      const probability = Math.min(1 - 1e-8, Math.max(1e-8, sigmoid(dot(beta, row.x))));
      const weight = probability * (1 - probability);
      for (let i = 0; i < beta.length; i += 1) {
        gradient[i] += row.x[i] * (row.y - probability);
        for (let j = 0; j < beta.length; j += 1) hessian[i][j] += row.x[i] * weight * row.x[j];
      }
    }
    for (let i = 0; i < beta.length; i += 1) {
      const penalty = i === 0 ? 1e-4 : lambda;
      gradient[i] -= penalty * beta[i];
      hessian[i][i] += penalty;
    }
    const delta = solveLinear(hessian, gradient);
    const maxDelta = Math.max(...delta.map(Math.abs));
    const step = maxDelta > 2 ? 2 / maxDelta : 1;
    beta = beta.map((value, index) => value + step * delta[index]);
    if (step * maxDelta < 1e-6) {
      converged = true;
      break;
    }
  }
  return { beta, means, scales, featureKeys, lambda, converged };
}

function predictHazard(model, features) {
  const x = [1, ...model.featureKeys.map((key, index) => (features[key] - model.means[index]) / model.scales[index])];
  return sigmoid(dot(model.beta, x));
}

function normalizePost(post) {
  if (!post) return null;
  return {
    post_id: String(post.post_id ?? ""),
    published_at_utc: iso(post.published_at_utc, "post.published_at_utc"),
    url: String(post.url ?? ""),
    text: String(post.text ?? ""),
    signal_level: Number.isInteger(post.signal_level) ? post.signal_level : 0,
    classification_evidence: String(post.classification_evidence ?? ""),
  };
}

function normalizeRecentPost(post) {
  post = repairKnownPostText(post);
  const textOriginal = String(post?.text_original ?? post?.text ?? "");
  const rawPostType = String(post?.post_type ?? "other");
  const postType = rawPostType === "confirmed_reset" ? "reset_signal" : new Set(["noise", "general", "status", "non_reset"]).has(rawPostType) ? "other" : rawPostType;
  const signalLevel = Math.min(4, Math.max(0, Number(post?.signal_level ?? 0)));
  const resetMeaning = String(post?.reset_meaning ?? inferredResetMeaning({ post_type: postType, signal_level: signalLevel }));
  const textZh = String(post?.text_zh ?? "");
  const classificationEvidence = String(post?.classification_evidence ?? "");
  const predictionRelevant = postType === "reset_signal" || signalLevel >= 2;
  return {
    post_id: String(post?.post_id ?? ""),
    published_at_utc: iso(post?.published_at_utc, "recent_tibo_post.published_at_utc"),
    url: String(post?.url ?? ""),
    text_original: textOriginal,
    text_zh: textZh || (predictionRelevant ? "" : "（非重置信号，保留英文原文）"),
    translation_method: textZh ? String(post?.translation_method ?? "chatgpt") : predictionRelevant ? "chatgpt" : "script_fallback",
    post_type: postType,
    signal_level: signalLevel,
    reset_meaning: resetMeaning,
    classification_evidence: classificationEvidence || (predictionRelevant ? "" : `脚本回退：${postType}，signal_level=${signalLevel}`),
    is_latest_overall: Boolean(post?.is_latest_overall),
    is_latest_reset_signal: Boolean(post?.is_latest_reset_signal),
  };
}

function postFromRecent(post) {
  if (!post) return null;
  return {
    post_id: post.post_id,
    published_at_utc: post.published_at_utc,
    url: post.url,
    text: post.text_original,
    signal_level: post.signal_level,
    classification_evidence: post.classification_evidence,
  };
}

function samePost(left, right) {
  if (!left || !right) return left === right;
  return left.post_id === right.post_id && left.published_at_utc === right.published_at_utc && left.url === right.url && left.text === right.text && left.signal_level === right.signal_level && left.classification_evidence === right.classification_evidence;
}

function recentPostIntegrityReasons(current, requireCount = true) {
  const reasons = [];
  const posts = Array.isArray(current?.recent_tibo_posts) ? current.recent_tibo_posts : [];
  if (requireCount && (posts.length < MIN_RECENT_POSTS || posts.length > MAX_RECENT_POSTS)) reasons.push(`近期 Tibo 总体动态必须保留本次抓取的 ${MIN_RECENT_POSTS}—${MAX_RECENT_POSTS} 条`);
  const seenIds = new Set();
  let latestOverallFlags = 0;
  let latestResetFlags = 0;
  posts.forEach((post, index) => {
    const label = `近期 Tibo 动态第 ${index + 1} 条`;
    const id = String(post?.post_id ?? "");
    if (!/^\d+$/.test(id)) reasons.push(`${label}缺少有效数字帖子 ID`);
    else {
      if (seenIds.has(id)) reasons.push(`${label}帖子 ID 重复`);
      seenIds.add(id);
      const encodedTime = snowflakeTimestampMs(id);
      const publishedTime = new Date(post.published_at_utc).getTime();
      if (!Number.isFinite(publishedTime) || encodedTime == null || Math.abs(publishedTime - encodedTime) > POST_TIME_TOLERANCE_MS) reasons.push(`${label}发布时间与 Snowflake ID 不一致`);
      if (!String(post.url ?? "").includes(`/status/${id}`)) reasons.push(`${label}URL 与帖子 ID 不一致`);
    }
    if (!String(post.text_original ?? "").trim()) reasons.push(`${label}缺少英文原文`);
    const predictionRelevant = post.post_type === "reset_signal" || post.signal_level >= 2;
    if (predictionRelevant && (!String(post.text_zh ?? "").trim() || post.translation_method !== "chatgpt")) reasons.push(`${label}属于预测相关动态但缺少中文翻译或 ChatGPT 翻译标记`);
    if (predictionRelevant && !String(post.classification_evidence ?? "").trim()) reasons.push(`${label}属于预测相关动态但缺少分类依据`);
    if (!Number.isInteger(post.signal_level) || post.signal_level < 0 || post.signal_level > 4) reasons.push(`${label}信号等级必须为 0—4 的整数`);
    if (!POST_TYPES.has(post.post_type)) reasons.push(`${label}类型无效`);
    if (!RESET_MEANING_LEVELS.has(post.reset_meaning) || RESET_MEANING_LEVELS.get(post.reset_meaning) !== post.signal_level) reasons.push(`${label}重置语义与信号等级不一致`);
    if (post.reset_meaning === "none" ? post.post_type === "reset_signal" : post.post_type !== "reset_signal") reasons.push(`${label}重置语义与帖子类型不一致`);
    if (post.reset_meaning === "completed" && !hasExplicitCompletedResetMeaning(post.text_original)) reasons.push(`${label}缺少明确的已完成重置语义，不能标为 Lv.4`);
    if (post.is_latest_overall) latestOverallFlags += 1;
    if (post.is_latest_reset_signal) latestResetFlags += 1;
    if (index > 1 && compareRecentPosts(posts[index - 1], post) > 0) reasons.push("近期 Tibo 动态除顶部帖子串主帖外，未按发布时间和帖子 ID 严格倒序排列");
  });
  if (posts.length && (latestOverallFlags !== 1 || !posts[0]?.is_latest_overall)) reasons.push("近期 Tibo 动态必须且只能将首条标记为最新总体动态");
  const latestOverall = current?.latest_overall_post;
  const first = posts[0];
  if (!latestOverall || !first || latestOverall.post_id !== first.post_id || latestOverall.published_at_utc !== first.published_at_utc || latestOverall.url !== first.url || latestOverall.text !== first.text_original) reasons.push("近期 Tibo 动态首条与最新总体动态的 ID、时间、URL 或原文不一致");
  const latestReset = current?.latest_reset_signal;
  if (latestReset) {
    const resetPost = posts.find((post) => post.is_latest_reset_signal);
    if (latestResetFlags !== 1 || !resetPost || latestReset.post_id !== resetPost.post_id || latestReset.published_at_utc !== resetPost.published_at_utc || latestReset.url !== resetPost.url || latestReset.text !== resetPost.text_original || latestReset.signal_level !== resetPost.signal_level || latestReset.classification_evidence !== resetPost.classification_evidence) reasons.push("最新重置相关动态与近期时间线的 ID、时间、URL、原文或分类不一致");
  } else if (latestResetFlags) reasons.push("缺少最新重置相关动态对象，但近期时间线存在对应标记");
  return [...new Set(reasons)];
}

function normalizeHorizonReasoning(item) {
  const allowedKeys = ["horizon_hours", "llm_evidence_summary", "supporting_factors", "counter_factors", "uncertainty", "evidence_refs"];
  const extraKeys = Object.keys(item ?? {}).filter((key) => !allowedKeys.includes(key));
  if (extraKeys.length) throw new Error(`LLM 证据解读包含禁止字段：${extraKeys.join(", ")}`);
  return {
    horizon_hours: Number(item?.horizon_hours),
    llm_evidence_summary: String(item?.llm_evidence_summary ?? ""),
    supporting_factors: Array.isArray(item?.supporting_factors) ? item.supporting_factors.map(String) : [],
    counter_factors: Array.isArray(item?.counter_factors) ? item.counter_factors.map(String) : [],
    uncertainty: String(item?.uncertainty ?? ""),
    evidence_refs: Array.isArray(item?.evidence_refs) ? item.evidence_refs.map(String) : [],
  };
}

function normalizeInput(input) {
  if (!input || typeof input !== "object") throw new Error("输入必须是 JSON 对象");
  if (input.classification_version !== CLASSIFICATION_VERSION) throw new Error(`classification_version 必须为 ${CLASSIFICATION_VERSION}`);
  const asOf = iso(input.current?.as_of_utc, "current.as_of_utc");
  const sources = Array.isArray(input.sources) ? input.sources.map((source, index) => normalizeSource(source, asOf, `sources[${index}]`)) : [];
  const events = (Array.isArray(input.historical_events) ? input.historical_events : []).map((event) => ({
    event_id: String(event.event_id ?? ""),
    event_type: String(event.event_type ?? "unknown"),
    announced_at_utc: iso(event.announced_at_utc, "event.announced_at_utc"),
    effective_at_utc: event.effective_at_utc ? iso(event.effective_at_utc, "event.effective_at_utc") : null,
    post_id: event.post_id == null ? null : String(event.post_id),
    source_url: String(event.source_url ?? ""),
    confidence: Math.min(1, Math.max(0, Number(event.confidence ?? 0))),
    reason_tags: Array.isArray(event.reason_tags) ? event.reason_tags.map(String) : [],
    included_in_training: Boolean(event.included_in_training),
    exclusion_reason: event.exclusion_reason == null ? null : String(event.exclusion_reason),
  })).sort((a, b) => new Date(a.announced_at_utc) - new Date(b.announced_at_utc));
  const signals = reconcileSignalsWithEvents((Array.isArray(input.historical_signals) ? input.historical_signals : []).map((signal) => ({
    post_id: String(signal.post_id ?? ""),
    published_at_utc: iso(signal.published_at_utc, "signal.published_at_utc"),
    url: String(signal.url ?? ""),
    text: String(signal.text ?? ""),
    signal_level: Math.min(3, Math.max(0, Number(signal.signal_level ?? 0))),
    intent_class: String(signal.intent_class ?? "weak_mention"),
    has_explicit_timing: Boolean(signal.has_explicit_timing),
    promised_window_end_at_utc: signal.promised_window_end_at_utc ? iso(signal.promised_window_end_at_utc, "signal.promised_window_end_at_utc") : null,
    outcome_status: String(signal.outcome_status ?? (signal.matched_reset_event_id ? "confirmed_exact" : "not_observed")),
    outcome_time_kind: String(signal.outcome_time_kind ?? (signal.hours_to_reset == null ? "right_censored" : "exact")),
    reset_at_utc: signal.reset_at_utc ? iso(signal.reset_at_utc, "signal.reset_at_utc") : null,
    latency_lower_hours: signal.latency_lower_hours == null ? (signal.hours_to_reset == null ? null : Number(signal.hours_to_reset)) : Number(signal.latency_lower_hours),
    latency_upper_hours: signal.latency_upper_hours == null ? (signal.hours_to_reset == null ? null : Number(signal.hours_to_reset)) : Number(signal.latency_upper_hours),
    observation_end_at_utc: signal.observation_end_at_utc ? iso(signal.observation_end_at_utc, "signal.observation_end_at_utc") : asOf,
    confidence: Math.min(1, Math.max(0, Number(signal.confidence ?? 1))),
    classification_evidence: String(signal.classification_evidence ?? ""),
    matched_reset_event_id: signal.matched_reset_event_id == null ? null : String(signal.matched_reset_event_id),
    hours_to_reset: signal.hours_to_reset == null ? null : Number(signal.hours_to_reset),
    reset_within_4h: Boolean(signal.reset_within_4h),
    reset_within_24h: Boolean(signal.reset_within_24h),
    reset_within_72h: Boolean(signal.reset_within_72h),
  })).filter((signal) => !isLegacyCompletedAnnouncementSignal(signal, events)).sort((a, b) => new Date(a.published_at_utc) - new Date(b.published_at_utc)), events);
  const contexts = (Array.isArray(input.historical_contexts) ? input.historical_contexts : []).map((context) => ({
    context_id: String(context.context_id ?? ""),
    context_type: String(context.context_type ?? ""),
    occurred_at_utc: iso(context.occurred_at_utc, "context.occurred_at_utc"),
    source_url: String(context.source_url ?? ""),
  })).sort((a, b) => new Date(a.occurred_at_utc) - new Date(b.occurred_at_utc));
  const chronologicalPosts = (Array.isArray(input.current?.recent_tibo_posts) ? input.current.recent_tibo_posts : [])
    .map(normalizeRecentPost)
    .sort(compareRecentPosts)
    .slice(0, MAX_RECENT_POSTS);
  const submittedLatestOverall = normalizePost(input.current?.latest_overall_post);
  const submittedLatestReset = normalizePost(input.current?.latest_reset_signal);
  const explicitLatestOverallIndex = chronologicalPosts.findIndex((post) => post.is_latest_overall);
  const latestOverallPost = chronologicalPosts[explicitLatestOverallIndex >= 0 ? explicitLatestOverallIndex : 0];
  const latestResetPost = chronologicalPosts.find((post) => post.post_type === "reset_signal" || post.is_latest_reset_signal);
  const recentPosts = latestOverallPost && explicitLatestOverallIndex > 0 ? [latestOverallPost, ...chronologicalPosts.filter((post) => post.post_id !== latestOverallPost.post_id)] : chronologicalPosts;
  recentPosts.forEach((post) => {
    post.is_latest_overall = post.post_id === latestOverallPost?.post_id;
    post.is_latest_reset_signal = post.post_id === latestResetPost?.post_id;
  });
  const derivedLatestOverall = postFromRecent(latestOverallPost);
  const derivedLatestReset = postFromRecent(latestResetPost);
  const timelineConsistent = (!submittedLatestOverall || samePost(submittedLatestOverall, derivedLatestOverall)) && (!submittedLatestReset || samePost(submittedLatestReset, derivedLatestReset));
  const horizonReasoning = normalizeReasoningContext(input.reasoning_context, sources);
  return {
    asOf,
    sources,
    events,
    signals,
    contexts,
    horizonReasoning,
    refresh: {
      mode: "full_refresh",
      checked_at_utc: input.refresh?.checked_at_utc ? iso(input.refresh.checked_at_utc, "refresh.checked_at_utc") : asOf,
      last_full_refresh_at_utc: input.refresh?.last_full_refresh_at_utc ? iso(input.refresh.last_full_refresh_at_utc, "refresh.last_full_refresh_at_utc") : asOf,
      status_indicator: input.refresh?.status_indicator == null ? null : String(input.refresh.status_indicator),
      active_incident_id: input.refresh?.active_incident_id == null ? null : String(input.refresh.active_incident_id),
      cached_history_verified: Boolean(input.refresh?.cached_history_verified),
    },
    current: {
      cross_source_consistent: Boolean(input.current?.cross_source_consistent) && timelineConsistent,
      tibo_work_timezone: String(input.current?.tibo_work_timezone ?? DEFAULT_WORK_TIMEZONE),
      latest_overall_post: derivedLatestOverall,
      latest_reset_signal: derivedLatestReset,
      recent_tibo_posts: recentPosts,
    },
  };
}

function confirmedEvents(data) {
  const seen = new Set();
  return data.events.filter((event) => {
    const accepted = event.event_type === "confirmed_reset" && event.included_in_training && event.confidence >= 0.7;
    if (!accepted || seen.has(event.event_id)) return false;
    seen.add(event.event_id);
    return true;
  });
}

function signalResolutionDeadlineMs(signal) {
  const publishedAtMs = new Date(signal?.published_at_utc).getTime();
  if (!Number.isFinite(publishedAtMs)) return NaN;
  const promisedEndAt = signal?.promised_window_end_at_utc ?? inferredPromisedWindowEndAt(signal);
  if (promisedEndAt) return new Date(promisedEndAt).getTime() + PROMISE_GRACE_HOURS * 3600_000;
  const fallbackHours = signal?.intent_class === "directional_reset" ? 72 : signal?.intent_class === "weak_mention" ? 24 : EXPLICIT_SIGNAL_FALLBACK_HOURS;
  return publishedAtMs + fallbackHours * 3600_000;
}

function firstConfirmedEventAfter(signal, events) {
  const signalAtMs = new Date(signal?.published_at_utc).getTime();
  return events.find((event) => new Date(event.effective_at_utc ?? event.announced_at_utc).getTime() >= signalAtMs) ?? null;
}

function reconcileSignalsWithEvents(signals, events) {
  return signals.map((signal) => {
    if (signal.matched_reset_event_id || signal.outcome_time_kind !== "right_censored") return signal;
    const deadlineMs = signalResolutionDeadlineMs(signal);
    const signalAtMs = new Date(signal.published_at_utc).getTime();
    const event = events.find((item) => {
      const eventAtMs = new Date(item.effective_at_utc ?? item.announced_at_utc).getTime();
      return eventAtMs >= signalAtMs && eventAtMs <= deadlineMs;
    }) ?? null;
    if (!event) return signal;
    const resetAt = event.effective_at_utc ?? event.announced_at_utc;
    const hours = Math.max(0, (new Date(resetAt).getTime() - new Date(signal.published_at_utc).getTime()) / 3600_000);
    return {
      ...signal,
      outcome_status: "confirmed_exact",
      outcome_time_kind: "exact",
      reset_at_utc: resetAt,
      latency_lower_hours: hours,
      latency_upper_hours: hours,
      matched_reset_event_id: event.event_id,
      hours_to_reset: hours,
      reset_within_4h: hours <= 4,
      reset_within_24h: hours <= 24,
      reset_within_72h: hours <= 72,
    };
  });
}

function isLegacyCompletedAnnouncementSignal(signal, events) {
  if (signal.outcome_time_kind !== "exact" || signal.latency_lower_hours !== 0 || signal.latency_upper_hours !== 0) return false;
  return events.some((event) => event.post_id === signal.post_id || event.event_id === signal.matched_reset_event_id);
}

function resolveCurrentSignal(data, events, asOfMs) {
  const candidate = data.signals.find((signal) => signal.post_id === data.current.latest_reset_signal?.post_id) ?? null;
  if (!candidate || candidate.matched_reset_event_id || candidate.outcome_time_kind !== "right_censored") return { signal: null, expiredUnresolved: null };
  if (firstConfirmedEventAfter(candidate, events)) return { signal: null, expiredUnresolved: null };
  const expired = asOfMs > signalResolutionDeadlineMs(candidate);
  if (!expired) return { signal: candidate, expiredUnresolved: null };
  return { signal: null, expiredUnresolved: candidate.intent_class === "explicit_commitment" ? candidate : null };
}

function refreshFingerprintPayload({ latestOverallPost, latestResetSignal, lastResetEventId, lastResetAt, statusIndicator, activeIncidentId }) {
  return {
    schema_version: SCHEMA_VERSION,
    classification_version: CLASSIFICATION_VERSION,
    model_version: MODEL_VERSION,
    latest_overall_post_id: latestOverallPost?.post_id ?? null,
    latest_overall_post_at_utc: latestOverallPost?.published_at_utc ?? null,
    latest_reset_signal_id: latestResetSignal?.post_id ?? null,
    latest_reset_signal_at_utc: latestResetSignal?.published_at_utc ?? null,
    latest_reset_signal_level: latestResetSignal?.signal_level ?? null,
    last_confirmed_reset_event_id: lastResetEventId ?? null,
    last_confirmed_reset_at_utc: lastResetAt ?? null,
    status_indicator: statusIndicator ?? null,
    active_incident_id: activeIncidentId ?? null,
  };
}

function hashRefreshPayload(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function buildRefreshOutput(data, events) {
  const lastReset = events.at(-1) ?? null;
  const payload = refreshFingerprintPayload({
    latestOverallPost: data.current.latest_overall_post,
    latestResetSignal: data.current.latest_reset_signal,
    lastResetEventId: lastReset?.event_id,
    lastResetAt: lastReset?.announced_at_utc,
    statusIndicator: data.refresh.status_indicator,
    activeIncidentId: data.refresh.active_incident_id,
  });
  return {
    mode: data.refresh.mode,
    data_fingerprint: hashRefreshPayload(payload),
    checked_at_utc: data.refresh.checked_at_utc,
    last_full_refresh_at_utc: data.refresh.mode === "full_refresh" ? data.asOf : data.refresh.last_full_refresh_at_utc,
    status_indicator: data.refresh.status_indicator,
    active_incident_id: data.refresh.active_incident_id,
    last_confirmed_reset_event_id: lastReset?.event_id ?? null,
    last_confirmed_reset_at_utc: lastReset?.announced_at_utc ?? null,
    cached_history_verified: data.refresh.cached_history_verified,
    reuse_max_age_minutes: REUSE_MAX_AGE_MINUTES,
    full_refresh_max_age_hours: FULL_REFRESH_MAX_AGE_HOURS,
  };
}

function latestBefore(items, time, field) {
  const limit = new Date(time).getTime();
  let latest = null;
  for (const item of items) {
    const itemTime = new Date(item[field]).getTime();
    if (itemTime <= limit && (!latest || itemTime > new Date(latest[field]).getTime())) latest = item;
  }
  return latest;
}

function featureVector(timeMs, lastResetMs, data, decayHours, cooldownHours = 12) {
  const hoursSinceReset = Math.max(0, (timeMs - lastResetMs) / 3600_000);
  const signal = latestBefore(data.signals.filter((item) => item.signal_level > 0), timeMs, "published_at_utc");
  const signalAge = signal ? Math.max(0, (timeMs - new Date(signal.published_at_utc).getTime()) / 3600_000) : Infinity;
  const recentContexts = data.contexts.filter((item) => {
    const age = (timeMs - new Date(item.occurred_at_utc).getTime()) / 3600_000;
    return age >= 0 && age <= 72;
  });
  const hour = new Date(timeMs).getUTCHours();
  return {
    log_hours_since_last_reset: Math.log1p(hoursSinceReset),
    post_reset_cooldown: Math.exp(-hoursSinceReset / cooldownHours),
    decayed_tibo_signal: signal ? signal.signal_level * Math.exp(-signalAge / decayHours) : 0,
    recent_incident: recentContexts.some((item) => item.context_type === "incident") ? 1 : 0,
    recent_release_or_milestone: recentContexts.some((item) => ["release", "milestone"].includes(item.context_type)) ? 1 : 0,
    utc_hour_sin: Math.sin((2 * Math.PI * hour) / 24),
    utc_hour_cos: Math.cos((2 * Math.PI * hour) / 24),
  };
}

function buildRows(events, data, decayHours, endAtMs = null, cooldownHours = 12) {
  const rows = [];
  for (let index = 0; index < events.length - 1; index += 1) {
    const startMs = new Date(events[index].announced_at_utc).getTime();
    const eventMs = new Date(events[index + 1].announced_at_utc).getTime();
    const stopMs = endAtMs == null ? eventMs : Math.min(eventMs, endAtMs);
    for (let timeMs = startMs + 3600_000; timeMs < stopMs; timeMs += 3600_000) {
      rows.push({
        timeMs,
        features: featureVector(timeMs, startMs, data, decayHours, cooldownHours),
        y: 0,
      });
    }
    if (stopMs === eventMs) rows.push({ timeMs: eventMs, features: featureVector(eventMs, startMs, data, decayHours, cooldownHours), y: 1 });
  }
  return rows;
}

function buildIntervals(events) {
  return events.slice(0, -1).map((event, index) => {
    const next = events[index + 1];
    const duration = (new Date(next.announced_at_utc) - new Date(event.announced_at_utc)) / 3600_000;
    return {
      interval_id: `${event.event_id}:${next.event_id}`,
      start_at_utc: event.announced_at_utc,
      end_at_utc: next.announced_at_utc,
      duration_hours: Number(duration.toFixed(3)),
      event_observed: true,
      event_id: next.event_id,
    };
  });
}

function cumulativeForecast(model, data, lastResetMs, asOfMs, maxHours = 72) {
  let survival = 1;
  const points = [];
  const hourly = [];
  for (let hour = 1; hour <= maxHours; hour += 1) {
    const timeMs = asOfMs + hour * 3600_000;
    const features = featureVector(timeMs, lastResetMs, data, model.decayHours ?? 24, model.cooldownHours ?? 12);
    const hazard = Math.min(0.999, Math.max(0.000001, predictHazard(model, features)));
    const before = survival;
    survival *= 1 - hazard;
    hourly.push({ hour, timeMs, hazard, windowProbability: before * hazard });
    if (HORIZONS.includes(hour)) points.push({ hour, timeMs, probability: 1 - survival });
  }
  return { points, hourly };
}

function signalSimilarity(signal, currentSignal, targetAge = null) {
  const levelWeight = Math.exp(-0.45 * Math.abs(signal.signal_level - currentSignal.signal_level));
  let classWeight = 1;
  if (signal.intent_class !== currentSignal.intent_class) {
    if (currentSignal.intent_class === "weak_mention") classWeight = 0.08;
    else if (signal.intent_class === "weak_mention") classWeight = 0.25;
    else classWeight = currentSignal.intent_class === "directional_reset" && Number.isFinite(targetAge) && targetAge <= 4 ? 0.15 : 0.65;
  }
  return levelWeight * classWeight * signal.confidence;
}

function bayesianSignalAdjustment(points, data, currentSignal, asOfMs) {
  const priorStrength = SIGNAL_PRIOR_STRENGTH;
  const currentAge = Math.max(0, (asOfMs - new Date(currentSignal.published_at_utc).getTime()) / 3600_000);
  let previous = 0;
  return points.map((point) => {
    let successWeight = 0;
    let failureWeight = 0;
    let exactCount = 0;
    let intervalCount = 0;
    let unavailableCount = 0;
    for (const signal of data.signals) {
      if (signal.post_id === currentSignal.post_id || signal.signal_level <= 0) continue;
      const lower = signal.latency_lower_hours;
      const upper = signal.latency_upper_hours;
      const targetAge = currentAge + point.hour;
      const weight = signalSimilarity(signal, currentSignal, targetAge);
      if (Number.isFinite(upper)) {
        if (upper <= currentAge) {
          unavailableCount += 1;
        } else if (upper <= targetAge) {
          successWeight += weight;
          if (signal.outcome_time_kind === "exact") exactCount += 1;
          else intervalCount += 1;
        } else if (Number.isFinite(lower) && lower > targetAge) failureWeight += weight;
        else unavailableCount += 1;
        continue;
      }
      const observedHours = (new Date(signal.observation_end_at_utc).getTime() - new Date(signal.published_at_utc).getTime()) / 3600_000;
      if (observedHours < currentAge) unavailableCount += 1;
      else if (observedHours >= targetAge) failureWeight += weight;
      else unavailableCount += 1;
    }
    const base = point.probability;
    const alpha = Math.max(0.001, priorStrength * base) + successWeight;
    const beta = Math.max(0.001, priorStrength * (1 - base)) + failureWeight;
    const posterior = alpha / (alpha + beta);
    const adjusted = Math.max(previous, Math.min(0.999999, posterior));
    previous = adjusted;
    const standardError = Math.sqrt((alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1)));
    return {
      ...point,
      baselineProbability: base,
      probability: adjusted,
      signalDelta: adjusted - base,
      confidenceLower: Math.max(0, adjusted - 1.96 * standardError),
      confidenceUpper: Math.min(1, adjusted + 1.96 * standardError),
      posterior: {
        alpha: Number(alpha.toFixed(6)), beta: Number(beta.toFixed(6)),
        effective_sample_count: Number((successWeight + failureWeight).toFixed(6)),
        weighted_successes: Number(successWeight.toFixed(6)), weighted_failures: Number(failureWeight.toFixed(6)),
        exact_outcome_count: exactCount, interval_censored_count: intervalCount,
        unavailable_outcome_count: unavailableCount,
      },
    };
  });
}

function circularHourDistance(a, b) {
  const direct = Math.abs(a - b);
  return Math.min(direct, 24 - direct);
}

function outcomeTimes(data) {
  const values = confirmedEvents(data).map((event) => event.effective_at_utc ?? event.announced_at_utc);
  for (const signal of data.signals) {
    if (signal.outcome_time_kind === "exact" && signal.reset_at_utc) values.push(signal.reset_at_utc);
  }
  return [...new Set(values)];
}

function workWindowMultiplier(value, data) {
  const timeZone = data.current.tibo_work_timezone;
  const parts = localTimeParts(value, timeZone);
  const workingPrior = parts.hour >= 8 && parts.hour < 19 ? 1.35 : 0.65;
  const weekend = new Set(["Sat", "Sun"]).has(parts.weekday) ? 0.9 : 1;
  const hours = outcomeTimes(data).map((item) => localTimeParts(item, timeZone).hour);
  if (!hours.length) return workingPrior * weekend;
  const density = hours.reduce((sum, hour) => sum + Math.exp(-0.5 * (circularHourDistance(parts.hour, hour) / 3) ** 2), 0) / hours.length;
  const reference = Array.from({ length: 24 }, (_, hour) => hours.reduce((sum, sample) => sum + Math.exp(-0.5 * (circularHourDistance(hour, sample) / 3) ** 2), 0) / hours.length)
    .reduce((sum, item) => sum + item, 0) / 24;
  return weekend * (0.45 * workingPrior + 0.55 * Math.max(0.35, density / Math.max(reference, 1e-6)));
}

function signalLatencyWeight(ageHours, data, currentSignal) {
  let density = ageHours <= 72 ? 0.08 : 0.01;
  for (const signal of data.signals) {
    if (signal.post_id === currentSignal.post_id || !Number.isFinite(signal.latency_upper_hours)) continue;
    const lower = Number.isFinite(signal.latency_lower_hours) ? signal.latency_lower_hours : 0;
    const midpoint = (lower + signal.latency_upper_hours) / 2;
    const bandwidth = Math.max(3, (signal.latency_upper_hours - lower) / 2 + 2);
    density += signalSimilarity(signal, currentSignal) * Math.exp(-0.5 * ((ageHours - midpoint) / bandwidth) ** 2);
  }
  return density;
}

function adjustedHourlyForecast(baseHourly, adjustedPoints, data, currentSignal, asOfMs) {
  const output = [];
  let previousHour = 0;
  let previousProbability = 0;
  const signalStartMs = new Date(currentSignal.published_at_utc).getTime();
  for (const point of adjustedPoints) {
    const segment = baseHourly.filter((item) => item.hour > previousHour && item.hour <= point.hour);
    const segmentProbability = Math.max(0, point.probability - previousProbability);
    const weights = segment.map((item) => {
      const latency = (item.timeMs - signalStartMs) / 3600_000;
      return Math.max(1e-9, (item.windowProbability + 0.0001) * workWindowMultiplier(item.timeMs, data) * signalLatencyWeight(latency, data, currentSignal));
    });
    const totalWeight = weights.reduce((sum, value) => sum + value, 0);
    segment.forEach((item, index) => output.push({ ...item, windowProbability: segmentProbability * weights[index] / totalWeight }));
    previousHour = point.hour;
    previousProbability = point.probability;
  }
  return output;
}

function worktimeHourlyForecast(baseHourly, points, data) {
  const output = [];
  let previousHour = 0;
  let previousProbability = 0;
  for (const point of points) {
    const segment = baseHourly.filter((item) => item.hour > previousHour && item.hour <= point.hour);
    const segmentProbability = Math.max(0, point.probability - previousProbability);
    const weights = segment.map((item) => Math.max(1e-9, (item.windowProbability + 0.0001) * workWindowMultiplier(item.timeMs, data)));
    const totalWeight = weights.reduce((sum, value) => sum + value, 0);
    segment.forEach((item, index) => output.push({ ...item, windowProbability: segmentProbability * weights[index] / totalWeight }));
    previousHour = point.hour;
    previousProbability = point.probability;
  }
  return output;
}

function baselineAdjustedPoints(points) {
  return points.map((point) => ({
    ...point,
    baselineProbability: point.probability,
    signalDelta: 0,
    confidenceLower: 0,
    confidenceUpper: 1,
    posterior: {
      alpha: null, beta: null, effective_sample_count: 0, weighted_successes: 0, weighted_failures: 0,
      exact_outcome_count: 0, interval_censored_count: 0, unavailable_outcome_count: 0,
    },
  }));
}

function brier(values) {
  if (!values.length) return null;
  return values.reduce((sum, item) => sum + (item.prediction - item.actual) ** 2, 0) / values.length;
}

function signalOutcomeAt(signal, horizon) {
  if (Number.isFinite(signal.latency_upper_hours) && signal.latency_upper_hours <= horizon) return 1;
  if (Number.isFinite(signal.latency_lower_hours) && signal.latency_lower_hours > horizon) return 0;
  if (signal.outcome_time_kind === "right_censored") {
    const observed = (new Date(signal.observation_end_at_utc) - new Date(signal.published_at_utc)) / 3600_000;
    if (observed >= horizon) return 0;
  }
  return null;
}

function signalWalkForwardValidation(events, data) {
  const signalScores = Object.fromEntries([4, 24, 72].map((horizon) => [horizon, []]));
  const baselineScores = Object.fromEntries([4, 24, 72].map((horizon) => [horizon, []]));
  const folds = [];
  const ordered = data.signals.filter((signal) => signal.signal_level > 0).sort((a, b) => new Date(a.published_at_utc) - new Date(b.published_at_utc));
  for (let index = 3; index < ordered.length; index += 1) {
    const currentSignal = ordered[index];
    const asOfMs = new Date(currentSignal.published_at_utc).getTime();
    const priorEvents = events.filter((event) => new Date(event.announced_at_utc).getTime() <= asOfMs);
    if (priorEvents.length < 10) continue;
    const foldData = { ...data, signals: ordered.slice(0, index) };
    const { model: foldModel } = selectModel(priorEvents, foldData, false);
    if (!foldModel.converged) continue;
    const lastReset = priorEvents.at(-1);
    const base = cumulativeForecast(foldModel, foldData, new Date(lastReset.announced_at_utc).getTime(), asOfMs);
    const adjusted = bayesianSignalAdjustment(base.points, foldData, currentSignal, asOfMs);
    const predictions = {};
    const actuals = {};
    for (const horizon of [4, 24, 72]) {
      const actual = signalOutcomeAt(currentSignal, horizon);
      if (actual == null) continue;
      const signalPoint = adjusted.find((point) => point.hour === horizon);
      const baselinePoint = base.points.find((point) => point.hour === horizon);
      signalScores[horizon].push({ prediction: signalPoint.probability, actual });
      baselineScores[horizon].push({ prediction: baselinePoint.probability, actual });
      predictions[horizon] = Number(signalPoint.probability.toFixed(6));
      actuals[horizon] = actual;
    }
    if (Object.keys(actuals).length) folds.push({ post_id: currentSignal.post_id, published_at_utc: currentSignal.published_at_utc, predictions, actuals });
  }
  const signalMetrics = Object.fromEntries(Object.entries(signalScores).map(([key, values]) => [key, brier(values)]));
  const baselineMetrics = Object.fromEntries(Object.entries(baselineScores).map(([key, values]) => [key, brier(values)]));
  const latestHoldout = folds.at(-1) ?? null;
  const comparable24 = Number.isFinite(signalMetrics[24]) && Number.isFinite(baselineMetrics[24]);
  return {
    method: "signal_origin_expanding_window",
    folds: folds.length,
    metrics: signalMetrics,
    baselineMetrics,
    passed: folds.length >= 3 && comparable24 && signalMetrics[24] <= baselineMetrics[24],
    latestHoldout,
    fold_details: folds,
  };
}

function validateCandidate(events, data, featureKeys, lambda, decayHours, cooldownHours) {
  const scores = Object.fromEntries([4, 24, 72].map((horizon) => [horizon, []]));
  const startIndex = Math.max(9, Math.floor(events.length * 0.5));
  let folds = 0;
  for (let origin = startIndex; origin < events.length - 1; origin += 1) {
    const trainingEvents = events.slice(0, origin + 1);
    const rows = buildRows(trainingEvents, data, decayHours, null, cooldownHours);
    if (!rows.some((row) => row.y === 1)) continue;
    const model = fitLogistic(rows, featureKeys, lambda);
    model.decayHours = decayHours;
    model.cooldownHours = cooldownHours;
    const originMs = new Date(events[origin].announced_at_utc).getTime();
    const nextMs = new Date(events[origin + 1].announced_at_utc).getTime();
    const forecast = cumulativeForecast(model, data, originMs, originMs, 72);
    for (const horizon of [4, 24, 72]) {
      const point = forecast.points.find((item) => item.hour === horizon);
      scores[horizon].push({ prediction: point.probability, actual: nextMs - originMs <= horizon * 3600_000 ? 1 : 0 });
    }
    folds += 1;
  }
  const metrics = Object.fromEntries(Object.entries(scores).map(([key, values]) => [key, brier(values)]));
  const objectiveValues = [metrics[4], metrics[24], metrics[72]].filter(Number.isFinite);
  return { folds, metrics, objective: objectiveValues.reduce((sum, value) => sum + value, 0) / Math.max(1, objectiveValues.length) };
}

function selectModel(events, data, fullEligible) {
  const baselineKeys = ["log_hours_since_last_reset", "post_reset_cooldown"];
  const fullKeys = FEATURE_KEYS;
  let best = null;
  const candidates = [];
  for (const variant of fullEligible ? ["baseline", "full"] : ["baseline"]) {
    for (const lambda of LAMBDAS) {
      for (const decayHours of variant === "full" ? DECAYS : [24]) {
        for (const cooldownHours of COOLDOWN_HOUR_CANDIDATES) {
          const featureKeys = variant === "full" ? fullKeys : baselineKeys;
          const validation = validateCandidate(events, data, featureKeys, lambda, decayHours, cooldownHours);
          const candidate = { variant, lambda, decayHours, cooldownHours, featureKeys, validation };
          candidates.push(candidate);
          if (!best || validation.objective < best.validation.objective) best = candidate;
        }
      }
    }
  }
  const baselineBest = candidates.filter((item) => item.variant === "baseline").sort((a, b) => a.validation.objective - b.validation.objective)[0];
  const fullBest = candidates.filter((item) => item.variant === "full").sort((a, b) => a.validation.objective - b.validation.objective)[0] ?? null;
  if (fullBest && fullBest.validation.objective <= baselineBest.validation.objective) best = fullBest;
  else best = baselineBest;
  const rows = buildRows(events, data, best.decayHours, null, best.cooldownHours);
  const model = fitLogistic(rows, best.featureKeys, best.lambda);
  model.decayHours = best.decayHours;
  model.cooldownHours = best.cooldownHours;
  return { best, baselineBest, model, rows };
}

function fixedCoefficients(model) {
  const result = {
    intercept: finiteOrNull(model?.beta?.[0]),
    log_hours_since_last_reset: null,
    post_reset_cooldown: null,
    decayed_tibo_signal: null,
    recent_incident: null,
    recent_release_or_milestone: null,
    utc_hour_sin: null,
    utc_hour_cos: null,
  };
  if (!model) return result;
  model.featureKeys.forEach((key, index) => { result[key] = finiteOrNull(model.beta[index + 1]); });
  return result;
}

function explanationFactors(model, features, data) {
  if (!model) return [];
  const sourceRefs = data.sources.filter((source) => source.status === "ok").map((source) => source.evidence_ref);
  return model.featureKeys.map((key, index) => {
    const standardized = (features[key] - model.means[index]) / model.scales[index];
    const contribution = model.beta[index + 1] * standardized;
    return {
      feature_key: key,
      feature_value: Number(features[key].toFixed(6)),
      direction: Math.abs(contribution) < 1e-6 ? "neutral" : contribution > 0 ? "increase" : "decrease",
      contribution_log_odds: Number(contribution.toFixed(6)),
      evidence_refs: sourceRefs,
      explanation: `${key} 对当前小时风险的标准化对数优势贡献为 ${contribution.toFixed(3)}。`,
    };
  });
}

function likelyWindows(hourly) {
  const candidates = [];
  for (let start = 0; start <= hourly.length - 4; start += 1) {
    const probability = hourly.slice(start, start + 4).reduce((sum, item) => sum + item.windowProbability, 0);
    candidates.push({ start, probability });
  }
  candidates.sort((a, b) => b.probability - a.probability);
  const selected = [];
  for (const candidate of candidates) {
    if (selected.every((item) => Math.abs(item.start - candidate.start) >= 4)) selected.push(candidate);
    if (selected.length === 3) break;
  }
  return selected.map((item, index) => ({
    start_at_beijing: beijingIso(hourly[item.start].timeMs),
    end_at_beijing: beijingIso(hourly[item.start + 3].timeMs + 3600_000),
    window_probability: Number(item.probability.toFixed(6)),
    rank: index + 1,
  }));
}

function blockedConclusion(reasons) {
  return {
    headline: "当前无法生成可靠的重置预测",
    summary: reasons.length ? `预测被数据或模型门禁阻断：${reasons.join("；")}` : "当前数据不足，无法生成预测。",
    primary_horizon_hours: null,
    primary_deadline_beijing: null,
    primary_probability: null,
    primary_probability_percent: null,
    most_likely_window_start_beijing: null,
    most_likely_window_end_beijing: null,
    most_likely_window_probability: null,
    confidence_level: "unavailable",
    confidence_explanation: "模型门禁未通过，本次不展示概率结论。",
    reason_keys: [],
  };
}

function buildConclusion(status, horizons, windows, factors, historyCount, hasActiveSignal = true, sourceConsistent = true) {
  const primary = horizons.find((item) => item.cumulative_probability >= 0.5) ?? horizons.at(-1);
  const topWindow = windows[0] ?? null;
  const probability = primary.cumulative_probability;
  const summary = probability >= 0.7
    ? "模型判断该时间范围内重置可能性较高，但这不是官方时间安排。"
    : probability >= 0.4
      ? "模型判断该时间范围内存在中等重置可能性，仍需结合最新动态观察。"
      : "模型判断该时间范围内重置可能性有限，当前没有足够证据断言会发生重置。";
  const confidenceLevel = status === "ok" ? (historyCount >= 50 ? "high" : "medium") : "low";
  return {
    headline: `未来 ${primary.horizon_hours} 小时内重置概率为 ${primary.display_probability_percent}%`,
    summary,
    primary_horizon_hours: primary.horizon_hours,
    primary_deadline_beijing: primary.deadline_beijing,
    primary_probability: primary.cumulative_probability,
    primary_probability_percent: primary.display_probability_percent,
    most_likely_window_start_beijing: topWindow?.start_at_beijing ?? null,
    most_likely_window_end_beijing: topWindow?.end_at_beijing ?? null,
    most_likely_window_probability: topWindow?.window_probability ?? null,
    confidence_level: confidenceLevel,
    confidence_explanation: !sourceConsistent
      ? "最新总体动态未通过独立第二来源一致性核验；模型已继续计算，但结果按低置信度展示，无法精确定位的新摘要未作为当前信号。"
      : status === "ok"
      ? `Tibo 信号延迟模型已通过信号起点滚动回测，并基于 ${historyCount} 次确认重置及意图—结果配对生成结论。`
      : hasActiveSignal
        ? `当前信号延迟模型尚未通过信号起点滚动回测，结果按低置信度展示。`
        : `当前没有尚未兑现的 Tibo 重置信号，使用历史间隔弱基线，结果按低置信度展示。`,
    reason_keys: factors.map((item) => item.feature_key),
  };
}

function modelOutputTemplate() {
  return {
    name: "tibo_signal_worktime_survival",
    version: MODEL_VERSION,
    variant: "none",
    status: "blocked",
    formula: "P(reset≤h|Tibo signal, signal age, post-reset cooldown, work window)=SignalLatencyPosterior(BaselineSurvival(h), matched intent→outcome pairs)",
    coefficients: fixedCoefficients(null),
    hyperparameters: { time_step_hours: 1, l2_lambda: null, signal_decay_hours: null, post_reset_cooldown_hours: null },
    training: { sample_count: 0, positive_count: 0, negative_count: 0, start_at_utc: null, end_at_utc: null },
    validation: {
      method: "signal_origin_expanding_window",
      fold_count: 0,
      brier_score_4h: null,
      brier_score_24h: null,
      brier_score_72h: null,
      log_loss: null,
      calibration_error: null,
      baseline_brier_score_24h: null,
      latest_holdout: null,
      passed: false,
    },
    signal_adjustment: {
      method: "signal_latency_empirical_bayes_with_worktime",
      prior_strength: SIGNAL_PRIOR_STRENGTH,
      current_signal_post_id: null,
      current_signal_level: null,
      current_signal_intent_class: null,
      current_signal_age_hours: null,
      historical_intent_count: 0,
      exact_outcome_count: 0,
      interval_censored_outcome_count: 0,
      right_censored_count: 0,
      baseline_variant: null,
      work_timezone: DEFAULT_WORK_TIMEZONE,
    },
  };
}

function buildBlockedOutput(input, reasons) {
  const asOf = input?.asOf ?? new Date().toISOString();
  const events = input?.events ?? [];
  const signals = input?.signals ?? [];
  return {
    schema_version: SCHEMA_VERSION,
    classification_version: CLASSIFICATION_VERSION,
    file_name: OUTPUT_NAME,
    site: { file_name: HTML_NAME, data_path: `./${OUTPUT_NAME}`, local_launcher: `./${LOCAL_LAUNCHER_NAME}`, local_server: `./${LOCAL_SERVER_NAME}`, language: "zh-CN", max_horizon_hours: 72, direct_file_supported: false, access_modes: ["local_http", "http", "https"], data_loading_priority: ["current_page_directory_json", "http_cache_bust"] },
    generated_at_utc: asOf,
    generated_at_beijing: beijingIso(asOf),
    status: "blocked",
    blocked_reasons: reasons.map(String),
    refresh: input ? buildRefreshOutput(input, confirmedEvents(input)) : {
      mode: "full_refresh", data_fingerprint: null, checked_at_utc: asOf, last_full_refresh_at_utc: asOf,
      status_indicator: null, active_incident_id: null, last_confirmed_reset_event_id: null, last_confirmed_reset_at_utc: null,
      reuse_max_age_minutes: REUSE_MAX_AGE_MINUTES, full_refresh_max_age_hours: FULL_REFRESH_MAX_AGE_HOURS,
    },
    sources: input?.sources ?? [],
    current: {
      as_of_utc: asOf,
      as_of_beijing: beijingIso(asOf),
      cross_source_consistent: input?.current?.cross_source_consistent ?? false,
      tibo_work_timezone: input?.current?.tibo_work_timezone ?? DEFAULT_WORK_TIMEZONE,
      last_confirmed_reset_at_utc: null,
      latest_overall_post: input?.current?.latest_overall_post ?? null,
      latest_reset_signal: input?.current?.latest_reset_signal ?? null,
      recent_tibo_posts: input?.current?.recent_tibo_posts ?? [],
    },
    history: {
      observation_start_utc: events[0]?.announced_at_utc ?? null,
      observation_end_utc: asOf,
      confirmed_reset_count: confirmedEvents(input ?? { events: [] }).length,
      signal_count: signals.length,
      excluded_event_count: events.filter((event) => !event.included_in_training).length,
      events,
      signals,
      contexts: input?.contexts ?? [],
      intervals: buildIntervals(confirmedEvents(input ?? { events: [] })),
    },
    model: modelOutputTemplate(),
    forecast: { horizons: [], most_likely_windows: [] },
    conclusion: blockedConclusion(reasons),
    explanation: {
      summary: "数据或模型门禁未通过，本次未生成预测概率。",
      factors: [],
      limitations: reasons.map(String),
      risk_notice: "这是根据公开历史记录建立的统计模型，不是 OpenAI 官方时间表。",
    },
  };
}

function validateRemoteGate(data) {
  const reasons = [];
  const allowedMethods = new Set(["chatgpt_remote_web_search", "remote_connector"]);
  const validSources = data.sources.filter((source) => new Set(["ok", "conflict"]).has(source.status) && source.fresh && allowedMethods.has(source.retrieval_method));
  if (validSources.length < 2) reasons.push("至少需要两个新鲜且由 ChatGPT/Codex 远程能力抓取的来源；来源可以存在已披露的内容冲突");
  const sourceIds = new Set();
  const evidenceRefs = new Set();
  for (const source of data.sources) {
    if (!source.source_id || sourceIds.has(source.source_id)) reasons.push("来源 source_id 缺失或重复");
    if (!source.evidence_ref || evidenceRefs.has(source.evidence_ref)) reasons.push("来源 evidence_ref 缺失或重复");
    if (!source.independence_group) reasons.push(`来源 ${source.source_id || "unknown"} 缺少 independence_group`);
    if (!source.evidence_scopes.length) reasons.push(`来源 ${source.source_id || "unknown"} 缺少 evidence_scopes`);
    sourceIds.add(source.source_id);
    evidenceRefs.add(source.evidence_ref);
  }
  const latestSources = validSources.filter((source) => source.evidence_scopes.includes("latest_overall"));
  const latestPost = data.current.latest_overall_post;
  for (const source of latestSources) {
    if (!latestPost || source.observed_post_id !== latestPost.post_id || source.observed_post_at_utc !== latestPost.published_at_utc || source.observed_post_url !== latestPost.url) reasons.push(`来源 ${source.source_id || "unknown"} 声称核验最新总体动态，但未与同一帖子 ID、时间和 URL 精确绑定`);
  }
  if (new Set(latestSources.map((source) => source.independence_group)).size < 2) reasons.push("最新总体动态必须由两个不同 independence_group 的新鲜来源核验");
  if (!validSources.some((source) => source.evidence_scopes.includes("official_status") && isOfficialOpenAIUrl(source.url))) reasons.push("缺少 OpenAI 官方域名的状态页或官方公告来源");
  if (!data.current.latest_overall_post) reasons.push("缺少 Tibo 最新总体动态");
  if (!data.current.latest_reset_signal) reasons.push("缺少最新重置相关动态");
  reasons.push(...recentPostIntegrityReasons(data.current));
  if (JSON.stringify(data.horizonReasoning.map((item) => item.horizon_hours)) !== JSON.stringify(HORIZONS)) reasons.push("LLM 逐预测范围证据解读必须完整覆盖固定预测节点");
  if (data.horizonReasoning.some((item) => !item.llm_evidence_summary.trim() || !item.uncertainty.trim() || !item.supporting_factors.length || !item.counter_factors.length || !item.evidence_refs.length)) reasons.push("LLM 逐预测范围证据解读缺少摘要、支持因素、反向因素、不确定性或证据引用");
  const knownEvidenceRefs = new Set(data.sources.map((source) => source.evidence_ref));
  if (data.horizonReasoning.some((item) => item.evidence_refs.some((ref) => !knownEvidenceRefs.has(ref)))) reasons.push("LLM 逐预测范围证据解读包含未知证据引用");
  return reasons;
}

function validateSnapshot(rawInput) {
  let data;
  try {
    data = normalizeInput(rawInput);
  } catch (error) {
    return { action: "blocked", status: "blocked", blocked_reasons: [error.message], warnings: [] };
  }
  const blockedReasons = validateRemoteGate(data);
  const events = confirmedEvents(data);
  if (events.length < 10) blockedReasons.push(`可信重置事件只有 ${events.length} 条，少于基础模型要求的 10 条`);
  const evaluableSignals = data.signals.filter((signal) => signal.signal_level > 0 && signal.confidence >= 0.7);
  const warnings = [];
  const staleAuxiliarySources = data.sources.filter((source) => source.status !== "failed" && !source.fresh && !source.evidence_scopes.includes("latest_overall") && !source.evidence_scopes.includes("official_status"));
  if (staleAuxiliarySources.length) warnings.push(`已忽略过期辅助来源：${staleAuxiliarySources.map((source) => source.source_id).join("、")}`);
  if (evaluableSignals.length < 3) warnings.push(`可评估历史 Tibo 信号只有 ${evaluableSignals.length} 条；将使用 baseline_fallback 或输出未通过回测的 degraded 结果`);
  return {
    action: blockedReasons.length ? "blocked" : "proceed",
    status: blockedReasons.length ? "blocked" : warnings.length ? "degraded_ready" : "ready",
    blocked_reasons: [...new Set(blockedReasons)],
    warnings,
    audit: {
      fresh_remote_source_count: data.sources.filter((source) => source.fresh && source.status !== "failed").length,
      latest_overall_independence_group_count: new Set(data.sources.filter((source) => source.fresh && source.evidence_scopes.includes("latest_overall")).map((source) => source.independence_group)).size,
      official_status_source_count: data.sources.filter((source) => source.fresh && source.evidence_scopes.includes("official_status") && isOfficialOpenAIUrl(source.url)).length,
      recent_tibo_post_count: data.current.recent_tibo_posts.length,
      confirmed_reset_count: events.length,
      historical_signal_count: data.signals.length,
      evaluable_historical_signal_count: evaluableSignals.length,
    },
  };
}

function normalizeReasoningContext(context, sources) {
  const legacy = Array.isArray(context?.horizons) ? context.horizons.map(normalizeHorizonReasoning).sort((a, b) => a.horizon_hours - b.horizon_hours) : [];
  if (JSON.stringify(legacy.map((item) => item.horizon_hours)) === JSON.stringify(HORIZONS)) return legacy;
  const evidenceAliases = new Map(sources.flatMap((source) => [[source.source_id, source.evidence_ref], [source.evidence_ref, source.evidence_ref]]));
  const evidenceRefs = Array.isArray(context?.evidence_refs) && context.evidence_refs.length
    ? context.evidence_refs.map((value) => evidenceAliases.get(String(value)) ?? String(value))
    : sources.filter((source) => source.status !== "failed").map((source) => source.evidence_ref);
  const global = {
    llm_evidence_summary: String(context?.evidence_summary ?? "当前公开证据已通过来源门禁；概率由统计模型确定性计算。"),
    supporting_factors: Array.isArray(context?.supporting_factors) && context.supporting_factors.length ? context.supporting_factors.map(String) : ["最新可审计动态已纳入计算。"],
    counter_factors: Array.isArray(context?.counter_factors) && context.counter_factors.length ? context.counter_factors.map(String) : ["公开信号不等同于官方重置时间承诺。"],
    uncertainty: String(context?.uncertainty ?? "公开信号和历史样本有限，结论保留不确定性。"),
    evidence_refs: evidenceRefs,
  };
  return HORIZONS.map((horizonHours) => ({ horizon_hours: horizonHours, ...global }));
}

function runForecast(rawInput) {
  if (hasEncodingCorruption(rawInput)) return buildBlockedOutput(null, ["输入包含 Unicode 替换符或私用区字符，疑似乱码"]);
  let data;
  try {
    data = normalizeInput(rawInput);
  } catch (error) {
    return buildBlockedOutput(null, [error.message]);
  }
  const gateReasons = validateRemoteGate(data);
  const events = confirmedEvents(data);
  if (events.length < 10) gateReasons.push(`可信重置事件只有 ${events.length} 条，少于基础模型要求的 10 条`);
  if (gateReasons.length) return buildBlockedOutput(data, gateReasons);

  const { best, model, rows } = selectModel(events, data, false);
  if (!model.converged) return buildBlockedOutput(data, ["生存回归没有收敛"]);
  const lastReset = events.at(-1);
  const lastResetMs = new Date(lastReset.announced_at_utc).getTime();
  const asOfMs = new Date(data.asOf).getTime();
  if (asOfMs < lastResetMs) return buildBlockedOutput(data, ["当前时间早于最近一次确认重置，存在数据倒退"]);
  const signalResolution = resolveCurrentSignal(data, events, asOfMs);
  if (signalResolution.expiredUnresolved) return buildBlockedOutput(data, [`明确重置承诺的观察窗口已结束，但没有独立证据确认是否已静默重置；已停止旧信号加成，等待 reset_history 双来源核验`]);
  const forecast = cumulativeForecast(model, data, lastResetMs, asOfMs);
  const currentSignal = signalResolution.signal;
  const adjustedPoints = currentSignal ? bayesianSignalAdjustment(forecast.points, data, currentSignal, asOfMs) : baselineAdjustedPoints(forecast.points);
  const signalValidation = signalWalkForwardValidation(events, data);
  const horizons = adjustedPoints.map((point, index) => {
    const probability = Number(point.probability.toFixed(6));
    const displayProbability = Math.round(point.probability * 100);
    const priorProbability = index ? adjustedPoints[index - 1].probability : 0;
    const context = data.horizonReasoning.find((item) => item.horizon_hours === point.hour);
    return {
      horizon_hours: point.hour,
      deadline_utc: new Date(point.timeMs).toISOString(),
      deadline_beijing: beijingIso(point.timeMs),
      cumulative_probability: probability,
      display_probability_percent: displayProbability,
      baseline_probability: Number(point.baselineProbability.toFixed(6)),
      signal_probability_delta: Number(point.signalDelta.toFixed(6)),
      confidence_lower: Number(point.confidenceLower.toFixed(6)),
      confidence_upper: Number(point.confidenceUpper.toFixed(6)),
      signal_posterior: point.posterior,
      reasoning: {
        model_basis: currentSignal
          ? `历史间隔仅提供 ${(point.baselineProbability * 100).toFixed(1)}% 的弱先验；信号主模型按当前等级、意图类型、已等待 ${((asOfMs - new Date(currentSignal.published_at_utc).getTime()) / 3600_000).toFixed(1)} 小时及历史信号—重置延迟，得到 ${displayProbability}%（变化 ${(point.signalDelta * 100).toFixed(1)} 个百分点，有效信号权重 ${point.posterior.effective_sample_count.toFixed(2)}）。具体小时再按 Tibo 当地工作时段分配。`
          : `当前没有尚未兑现的 Tibo 重置信号，使用历史间隔弱基线 ${(point.baselineProbability * 100).toFixed(1)}%，具体小时按 Tibo 当地工作时段与历史重置小时分布安排。`,
        llm_evidence_summary: context.llm_evidence_summary,
        supporting_factors: context.supporting_factors,
        counter_factors: context.counter_factors,
        cumulative_effect: `这是从模型计算时点到 +${point.hour}h 的累计概率，不是该小时的独立概率，也不会随浏览器当前时间自动平移。`,
        uncertainty: context.uncertainty,
        evidence_refs: context.evidence_refs,
      },
    };
  });
  const currentFeatures = featureVector(asOfMs + 3600_000, lastResetMs, data, best.decayHours, best.cooldownHours);
  const validation = signalValidation;
  const positives = rows.reduce((sum, row) => sum + row.y, 0);
  const staleAuxiliarySources = data.sources.filter((source) => source.status !== "failed" && !source.fresh && !source.evidence_scopes.includes("latest_overall") && !source.evidence_scopes.includes("official_status"));
  const status = data.current.cross_source_consistent && validation.passed && currentSignal && !staleAuxiliarySources.length ? "ok" : "degraded";
  const modelStatus = data.current.cross_source_consistent && validation.passed && currentSignal && !staleAuxiliarySources.length ? "trained" : "degraded";
  const adjustedHourly = currentSignal
    ? adjustedHourlyForecast(forecast.hourly, adjustedPoints, data, currentSignal, asOfMs)
    : worktimeHourlyForecast(forecast.hourly, adjustedPoints, data);
  const windows = likelyWindows(adjustedHourly);
  const factors = explanationFactors(model, currentFeatures, data);
  if (!data.current.cross_source_consistent) factors.push({
    feature_key: "source_consistency",
    feature_value: 0,
    direction: "decrease",
    contribution_log_odds: 0,
    evidence_refs: data.sources.filter((source) => source.status !== "failed").map((source) => source.evidence_ref),
    explanation: "最新总体动态未通过独立第二来源一致性核验；模型仍继续计算，但状态与结论置信度降级，无法精确定位的新摘要不作为当前 Tibo 信号。",
  });
  const representativeSignalDelta = horizons.find((item) => item.horizon_hours === 24)?.signal_probability_delta ?? horizons.at(-1).signal_probability_delta;
  if (currentSignal) factors.push({
      feature_key: "tibo_signal_latency_posterior",
      feature_value: representativeSignalDelta,
      direction: representativeSignalDelta > 0 ? "increase" : representativeSignalDelta < 0 ? "decrease" : "neutral",
      contribution_log_odds: 0,
      evidence_refs: data.sources.filter((source) => source.status === "ok").map((source) => source.evidence_ref),
      explanation: `当前为 ${currentSignal.intent_class}、等级 ${currentSignal.signal_level}，且已等待 ${((asOfMs - new Date(currentSignal.published_at_utc).getTime()) / 3600_000).toFixed(1)} 小时；信号层按历史意图—真实重置延迟主导各预测范围。`,
    });
  const workMultiplier = workWindowMultiplier(asOfMs + 3600_000, data);
  factors.push({
    feature_key: "tibo_work_window",
    feature_value: Number(workMultiplier.toFixed(6)),
    direction: workMultiplier > 1.05 ? "increase" : workMultiplier < 0.95 ? "decrease" : "neutral",
    contribution_log_odds: Number(Math.log(Math.max(workMultiplier, 1e-6)).toFixed(6)),
    evidence_refs: data.sources.filter((source) => source.status === "ok").map((source) => source.evidence_ref),
    explanation: `按 ${data.current.tibo_work_timezone} 的当地工作时段及历史重置小时分布，为候选小时重新分配概率。`,
  });
  return {
    schema_version: SCHEMA_VERSION,
    classification_version: CLASSIFICATION_VERSION,
    file_name: OUTPUT_NAME,
    site: { file_name: HTML_NAME, data_path: `./${OUTPUT_NAME}`, local_launcher: `./${LOCAL_LAUNCHER_NAME}`, local_server: `./${LOCAL_SERVER_NAME}`, language: "zh-CN", max_horizon_hours: 72, direct_file_supported: false, access_modes: ["local_http", "http", "https"], data_loading_priority: ["current_page_directory_json", "http_cache_bust"] },
    generated_at_utc: data.asOf,
    generated_at_beijing: beijingIso(data.asOf),
    status,
    blocked_reasons: [],
    refresh: buildRefreshOutput(data, events),
    sources: data.sources,
    current: {
      as_of_utc: data.asOf,
      as_of_beijing: beijingIso(data.asOf),
      cross_source_consistent: data.current.cross_source_consistent,
      tibo_work_timezone: data.current.tibo_work_timezone,
      last_confirmed_reset_at_utc: lastReset.announced_at_utc,
      latest_overall_post: data.current.latest_overall_post,
      latest_reset_signal: data.current.latest_reset_signal,
      recent_tibo_posts: data.current.recent_tibo_posts,
    },
    history: {
      observation_start_utc: events[0].announced_at_utc,
      observation_end_utc: data.asOf,
      confirmed_reset_count: events.length,
      signal_count: data.signals.length,
      excluded_event_count: data.events.filter((event) => !event.included_in_training).length,
      events: data.events,
      signals: data.signals,
      contexts: data.contexts,
      intervals: buildIntervals(events),
    },
    model: {
      ...modelOutputTemplate(),
      variant: currentSignal ? "signal_primary" : "baseline_fallback",
      status: modelStatus,
      coefficients: fixedCoefficients(model),
      hyperparameters: { time_step_hours: 1, l2_lambda: best.lambda, signal_decay_hours: best.variant === "full" ? best.decayHours : null, post_reset_cooldown_hours: best.cooldownHours },
      training: {
        sample_count: rows.length,
        positive_count: positives,
        negative_count: rows.length - positives,
        start_at_utc: events[0].announced_at_utc,
        end_at_utc: events.at(-1).announced_at_utc,
      },
      validation: {
        method: validation.method,
        fold_count: validation.folds,
        brier_score_4h: finiteOrNull(validation.metrics[4]),
        brier_score_24h: finiteOrNull(validation.metrics[24]),
        brier_score_72h: finiteOrNull(validation.metrics[72]),
        log_loss: null,
        calibration_error: null,
        baseline_brier_score_24h: finiteOrNull(validation.baselineMetrics[24]),
        latest_holdout: validation.latestHoldout,
        passed: validation.passed,
      },
      signal_adjustment: {
        method: "signal_latency_empirical_bayes_with_worktime",
        prior_strength: SIGNAL_PRIOR_STRENGTH,
        current_signal_post_id: currentSignal?.post_id ?? null,
        current_signal_level: currentSignal?.signal_level ?? null,
        current_signal_intent_class: currentSignal?.intent_class ?? null,
        current_signal_age_hours: currentSignal ? Number(((asOfMs - new Date(currentSignal.published_at_utc).getTime()) / 3600_000).toFixed(3)) : null,
        historical_intent_count: data.signals.filter((item) => item.post_id !== currentSignal?.post_id && item.signal_level > 0).length,
        exact_outcome_count: data.signals.filter((item) => item.outcome_time_kind === "exact").length,
        interval_censored_outcome_count: data.signals.filter((item) => item.outcome_time_kind === "interval_censored").length,
        right_censored_count: data.signals.filter((item) => item.outcome_time_kind === "right_censored").length,
        baseline_variant: best.variant,
        work_timezone: data.current.tibo_work_timezone,
      },
    },
    forecast: {
      horizons,
      most_likely_windows: windows,
    },
    conclusion: buildConclusion(status, horizons, windows, factors, events.length, Boolean(currentSignal), data.current.cross_source_consistent),
    explanation: {
      summary: "以 Tibo 信号等级和历史信号—重置延迟为主模型；等级 4 只表示已完成，重置后冷却与历史间隔形成弱基线，再按当地工作时段分配具体小时概率；LLM 只解释证据。",
      factors,
      limitations: [
        "Tibo 意图—结果配对样本仍少，部分落地时间为区间删失；工作时段使用配置时区与历史小时分布，不以国籍直接推定。",
        ...(signalValidation.folds < 3 ? [`历史 Tibo 信号逐步回测只有 ${signalValidation.folds} 折，未达到 3 折放行条件；本次不得声称回测通过。`] : []),
        ...(!data.current.cross_source_consistent ? ["最新总体动态存在来源冲突：概率继续由确定性模型生成，但本次状态和置信度已降级；无法精确定位的新摘要未作为模型信号。"] : []),
        ...(staleAuxiliarySources.length ? [`已忽略过期辅助来源：${staleAuxiliarySources.map((source) => source.source_id).join("、")}；最新总体动态双来源和官方状态仍须通过新鲜度硬门禁。`] : []),
      ],
      risk_notice: "这是根据公开历史记录建立的统计模型，不是 OpenAI 官方时间表。",
    },
  };
}

function validateOutput(output) {
  if (hasEncodingCorruption(output)) throw new Error("输出包含连续问号、Unicode 替换符或私用区字符，疑似乱码");
  const requiredTop = ["schema_version", "classification_version", "file_name", "site", "generated_at_utc", "generated_at_beijing", "status", "blocked_reasons", "refresh", "sources", "current", "history", "model", "forecast", "conclusion", "explanation"];
  for (const key of requiredTop) if (!(key in output)) throw new Error(`输出缺少固定 key：${key}`);
  if (output.schema_version !== SCHEMA_VERSION) throw new Error("输出 schema_version 不兼容");
  if (output.classification_version !== CLASSIFICATION_VERSION) throw new Error("输出 classification_version 不兼容");
  if (output.file_name !== OUTPUT_NAME) throw new Error("输出文件名契约不一致");
  if (output.site?.file_name !== HTML_NAME || output.site?.data_path !== `./${OUTPUT_NAME}` || output.site?.local_launcher !== `./${LOCAL_LAUNCHER_NAME}` || output.site?.local_server !== `./${LOCAL_SERVER_NAME}` || output.site?.max_horizon_hours !== 72 || output.site?.direct_file_supported !== false || JSON.stringify(output.site?.access_modes) !== JSON.stringify(["local_http", "http", "https"]) || JSON.stringify(output.site?.data_loading_priority) !== JSON.stringify(["current_page_directory_json", "http_cache_bust"])) throw new Error("静态网站契约不一致");
  if (!new Set(["ok", "degraded", "blocked"]).has(output.status)) throw new Error("status 枚举无效");
  const sourceKeys = ["source_id", "name", "url", "retrieved_at_utc", "source_reported_fetched_at_utc", "effective_retrieved_at_utc", "independence_group", "evidence_scopes", "observed_post_id", "observed_post_at_utc", "observed_post_url", "retrieval_method", "status", "fresh", "evidence_ref"];
  for (const source of output.sources) {
    if (JSON.stringify(Object.keys(source)) !== JSON.stringify(sourceKeys)) throw new Error("来源固定 key 不一致");
    if (!source.independence_group || !Array.isArray(source.evidence_scopes)) throw new Error("来源独立性或证据范围无效");
  }
  if (!Array.isArray(output.history.events) || !Array.isArray(output.history.signals) || !Array.isArray(output.history.contexts) || !Array.isArray(output.history.intervals)) throw new Error("history 数组结构无效");
  if (output.refresh.mode !== "full_refresh" || !output.refresh.checked_at_utc || !output.refresh.last_full_refresh_at_utc) throw new Error("refresh 结构无效");
  const signalKeys = ["post_id", "published_at_utc", "url", "text", "signal_level", "intent_class", "has_explicit_timing", "promised_window_end_at_utc", "outcome_status", "outcome_time_kind", "reset_at_utc", "latency_lower_hours", "latency_upper_hours", "observation_end_at_utc", "confidence", "classification_evidence", "matched_reset_event_id", "hours_to_reset", "reset_within_4h", "reset_within_24h", "reset_within_72h"];
  for (const signal of output.history.signals) {
    if (JSON.stringify(Object.keys(signal)) !== JSON.stringify(signalKeys)) throw new Error("历史意图—结果记录固定 key 不一致");
    if (!new Set(["weak_mention", "directional_reset", "explicit_commitment"]).has(signal.intent_class)) throw new Error("历史信号 intent_class 无效");
    if (!new Set(["exact", "interval_censored", "right_censored"]).has(signal.outcome_time_kind)) throw new Error("历史信号 outcome_time_kind 无效");
    if (signal.signal_level < 0 || signal.signal_level > 3) throw new Error("历史预测信号等级必须为 0—3");
  }
  if (output.status !== "blocked" && (output.model.name !== "tibo_signal_worktime_survival" || !new Set(["signal_primary", "baseline_fallback"]).has(output.model.variant) || output.model.signal_adjustment?.method !== "signal_latency_empirical_bayes_with_worktime")) throw new Error("信号主模型输出契约不一致");
  if (!Array.isArray(output.current.recent_tibo_posts)) throw new Error("近期 Tibo 动态结构无效");
  if (typeof output.current.cross_source_consistent !== "boolean") throw new Error("来源一致性字段无效");
  if (output.status !== "blocked" && (output.current.recent_tibo_posts.length < MIN_RECENT_POSTS || output.current.recent_tibo_posts.length > MAX_RECENT_POSTS)) throw new Error(`近期 Tibo 动态数量必须为 ${MIN_RECENT_POSTS}—${MAX_RECENT_POSTS} 条`);
  const recentPostKeys = ["post_id", "published_at_utc", "url", "text_original", "text_zh", "translation_method", "post_type", "signal_level", "reset_meaning", "classification_evidence", "is_latest_overall", "is_latest_reset_signal"];
  for (const post of output.current.recent_tibo_posts) {
    if (JSON.stringify(Object.keys(post)) !== JSON.stringify(recentPostKeys)) throw new Error("近期 Tibo 动态固定 key 不一致");
    const predictionRelevant = post.post_type === "reset_signal" || post.signal_level >= 2;
    if (!post.text_original || !post.text_zh || (predictionRelevant ? post.translation_method !== "chatgpt" : !new Set(["chatgpt", "script_fallback"]).has(post.translation_method))) throw new Error("近期 Tibo 动态双语内容不完整");
    if (!new Set(["reset_signal", "codex", "limits", "release", "other"]).has(post.post_type)) throw new Error("近期 Tibo 动态类型无效");
    if (post.signal_level < 0 || post.signal_level > 4) throw new Error("近期 Tibo 动态等级必须为 0—4");
    if (!RESET_MEANING_LEVELS.has(post.reset_meaning) || RESET_MEANING_LEVELS.get(post.reset_meaning) !== post.signal_level) throw new Error("近期 Tibo 动态重置语义与等级不一致");
  }
  const latestResetPost = output.current.recent_tibo_posts.find((post) => post.is_latest_reset_signal);
  if (latestResetPost && output.current.latest_reset_signal && latestResetPost.post_id === output.current.latest_reset_signal.post_id && latestResetPost.signal_level !== output.current.latest_reset_signal.signal_level) throw new Error("最新重置相关动态等级在当前对象和近期列表中不一致");
  if (output.status !== "blocked") {
    const integrityReasons = recentPostIntegrityReasons(output.current);
    if (integrityReasons.length) throw new Error(integrityReasons.join("；"));
  }
  if (!Array.isArray(output.forecast.horizons) || !Array.isArray(output.explanation.factors)) throw new Error("forecast 或 explanation 结构无效");
  if (!Array.isArray(output.conclusion.reason_keys) || !new Set(["low", "medium", "high", "unavailable"]).has(output.conclusion.confidence_level)) throw new Error("conclusion 结构无效");
  if (output.forecast.horizons.some((row) => row.horizon_hours > 72)) throw new Error("预测范围不得超过 72 小时");
  if (output.status !== "blocked" && JSON.stringify(output.forecast.horizons.map((row) => row.horizon_hours)) !== JSON.stringify(HORIZONS)) throw new Error("预测节点契约不一致");
  let previous = -1;
  for (const row of output.forecast.horizons) {
    if (!Number.isFinite(row.cumulative_probability) || row.cumulative_probability < 0 || row.cumulative_probability > 1) throw new Error("预测概率越界");
    if (row.cumulative_probability < previous) throw new Error("累计概率不是单调递增");
    if (row.display_probability_percent !== Math.round(row.cumulative_probability * 100)) throw new Error("展示百分比与原始概率不一致");
    if (!Number.isFinite(row.baseline_probability) || !Number.isFinite(row.signal_probability_delta) || !row.signal_posterior) throw new Error("信号主模型字段不完整");
    if (!Number.isFinite(row.confidence_lower) || !Number.isFinite(row.confidence_upper) || row.confidence_lower > row.cumulative_probability || row.confidence_upper < row.cumulative_probability) throw new Error("概率区间无效");
    const reasoningKeys = ["model_basis", "llm_evidence_summary", "supporting_factors", "counter_factors", "cumulative_effect", "uncertainty", "evidence_refs"];
    if (JSON.stringify(Object.keys(row.reasoning ?? {})) !== JSON.stringify(reasoningKeys)) throw new Error("逐预测范围推理固定 key 不一致");
    if (!row.reasoning.model_basis || !row.reasoning.llm_evidence_summary || !row.reasoning.cumulative_effect || !row.reasoning.uncertainty) throw new Error("逐预测范围推理文本不完整");
    if (!row.reasoning.supporting_factors.length || !row.reasoning.counter_factors.length || !row.reasoning.evidence_refs.length) throw new Error("逐预测范围推理数组不完整");
    previous = row.cumulative_probability;
  }
  const serialized = JSON.stringify(output);
  if (serialized.includes("NaN") || serialized.includes("Infinity")) throw new Error("输出包含非有限数值");
}

function writeAtomic(output, outputPath) {
  validateOutput(output);
  const directory = path.dirname(outputPath);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(outputPath)}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(output, null, 2)}\n`, { encoding: "utf8" });
  JSON.parse(fs.readFileSync(temporary, "utf8"));
  fs.renameSync(temporary, outputPath);
}

async function postGeneratedJson(outputPath, postUrl, postToken = null) {
  const target = new URL(postUrl);
  if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error("--post-url 只支持 HTTP 或 HTTPS URL");
  const body = fs.readFileSync(outputPath, "utf8");
  JSON.parse(body);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  let response;
  try {
    response = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", Accept: "application/json", ...(postToken ? { token: postToken } : {}) },
      body,
      redirect: "error",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw new Error(`JSON POST 提交失败：HTTP ${response.status}`);
  return { url: target.href, status: response.status, content_type: response.headers.get("content-type"), response_body: await response.text() };
}

function migrateDisplayContract(output) {
  const asOf = iso(output.generated_at_utc, "generated_at_utc");
  return {
    ...output,
    schema_version: SCHEMA_VERSION,
    classification_version: CLASSIFICATION_VERSION,
    sources: (output.sources ?? []).map((source, index) => normalizeSource({
      ...source,
      source_reported_fetched_at_utc: source.source_reported_fetched_at_utc ?? null,
      independence_group: source.independence_group || `legacy_${source.source_id || index}`,
      evidence_scopes: source.evidence_scopes?.length ? source.evidence_scopes : ["legacy"],
    }, asOf, `sources[${index}]`)),
    current: {
      ...output.current,
      recent_tibo_posts: (output.current?.recent_tibo_posts ?? []).map(normalizeRecentPost),
      cross_source_consistent: typeof output.current?.cross_source_consistent === "boolean"
        ? output.current.cross_source_consistent
        : !output.explanation?.factors?.some((factor) => factor.feature_key === "source_consistency"),
    },
    site: {
      file_name: HTML_NAME,
      data_path: `./${OUTPUT_NAME}`,
      local_launcher: `./${LOCAL_LAUNCHER_NAME}`,
      local_server: `./${LOCAL_SERVER_NAME}`,
      language: "zh-CN",
      max_horizon_hours: 72,
      direct_file_supported: false,
      access_modes: ["local_http", "http", "https"],
      data_loading_priority: ["current_page_directory_json", "http_cache_bust"],
    },
  };
}

function writeHtmlAtomic(_output, outputPath) {
  const directory = path.dirname(outputPath);
  const target = path.join(directory, HTML_NAME);
  const temporary = path.join(directory, `.${HTML_NAME}.tmp`);
  const template = fs.readFileSync(HTML_TEMPLATE, "utf8");
  if (!template.includes(`const DATA_FILE = "${OUTPUT_NAME}";`) || !template.includes('lang="zh-CN"') || !template.includes('new URL("./", location.href)') || !template.includes('new URL(DATA_FILE, pageDirectoryUrl)') || !template.includes('searchParams.set("_t"') || template.includes('location.protocol') || template.includes('type="file"')) throw new Error("HTML 模板不符合纯网络同目录 JSON 加载契约");
  if (template.includes("embedded-forecast-data") || template.includes('type="application/json"') || template.includes("__CODEX_FORECAST_JSON__")) throw new Error("HTML 模板禁止包含内置预测数据");
  fs.writeFileSync(temporary, template, { encoding: "utf8" });
  const reread = fs.readFileSync(temporary, "utf8");
  if (reread.includes("embedded-forecast-data") || reread.includes('type="application/json"')) throw new Error("HTML 输出包含内置预测数据");
  fs.renameSync(temporary, target);
  for (const [source, name] of [[LOCAL_SERVER_TEMPLATE, LOCAL_SERVER_NAME], [LOCAL_LAUNCHER_TEMPLATE, LOCAL_LAUNCHER_NAME]]) {
    const assetTemporary = path.join(directory, `.${name}.tmp`);
    fs.writeFileSync(assetTemporary, fs.readFileSync(source, "utf8"), { encoding: "utf8" });
    fs.renameSync(assetTemporary, path.join(directory, name));
  }
  return target;
}

function normalizeProbe(rawProbe) {
  const checkedAt = iso(rawProbe?.checked_at_utc ?? rawProbe?.refresh?.checked_at_utc ?? rawProbe?.current?.as_of_utc, "probe.checked_at_utc");
  const sources = Array.isArray(rawProbe?.sources) ? rawProbe.sources.map((source, index) => normalizeSource({
    source_id: source?.source_id ?? `probe_${index + 1}`,
    name: source?.name ?? `probe source ${index + 1}`,
    independence_group: source?.independence_group ?? `probe_${urlHost(source?.url) || index + 1}`,
    evidence_scopes: source?.evidence_scopes?.length ? source.evidence_scopes : ["latest_overall"],
    retrieval_method: source?.retrieval_method ?? "chatgpt_remote_web_search",
    status: source?.status ?? "ok",
    evidence_ref: source?.evidence_ref ?? `probe:${source?.url ?? index + 1}`,
    ...source,
  }, checkedAt, `probe.sources[${index}]`)) : [];
  return {
    checkedAt,
    sources,
    latestOverallPost: rawProbe?.latest_overall_post ?? rawProbe?.current?.latest_overall_post ?? null,
    latestResetSignal: rawProbe?.latest_reset_signal ?? rawProbe?.current?.latest_reset_signal ?? null,
    lastResetEventId: (rawProbe?.last_confirmed_reset ?? rawProbe?.current?.last_confirmed_reset)?.event_id == null ? null : String((rawProbe?.last_confirmed_reset ?? rawProbe?.current?.last_confirmed_reset).event_id),
    lastResetAt: (rawProbe?.last_confirmed_reset ?? rawProbe?.current?.last_confirmed_reset)?.announced_at_utc ? iso((rawProbe?.last_confirmed_reset ?? rawProbe?.current?.last_confirmed_reset).announced_at_utc, "probe.last_confirmed_reset.announced_at_utc") : null,
    statusIndicator: (rawProbe?.status_indicator ?? rawProbe?.refresh?.status_indicator) == null ? null : String(rawProbe?.status_indicator ?? rawProbe?.refresh?.status_indicator),
    activeIncidentId: (rawProbe?.active_incident_id ?? rawProbe?.refresh?.active_incident_id) == null ? null : String(rawProbe?.active_incident_id ?? rawProbe?.refresh?.active_incident_id),
  };
}

function probeFailure(reason) {
  return { action: "full_refresh", reason, wrote_files: false };
}

function existingPromiseNeedsResolution(existing, checkedAt) {
  const latest = existing?.current?.latest_reset_signal;
  if (Number(latest?.signal_level) !== 3) return false;
  const signal = existing?.history?.signals?.find((item) => String(item?.post_id) === String(latest.post_id)) ?? {
    ...latest,
    published_at_utc: latest.published_at_utc,
    text: latest.text,
    signal_level: 3,
    intent_class: "explicit_commitment",
    outcome_time_kind: "right_censored",
    matched_reset_event_id: null,
  };
  if (signal.matched_reset_event_id || signal.outcome_time_kind !== "right_censored") return false;
  const events = (existing?.history?.events ?? []).filter((event) => event.event_type === "confirmed_reset" && event.included_in_training && Number(event.confidence) >= 0.7);
  if (firstConfirmedEventAfter(signal, events)) return false;
  return new Date(checkedAt).getTime() > signalResolutionDeadlineMs(signal);
}

function runRefreshProbe(rawProbe, existingPath, outputPath) {
  void outputPath;
  const usingSeed = !existingPath || !fs.existsSync(existingPath);
  const comparisonPath = usingSeed ? BASELINE_HISTORY_TEMPLATE : existingPath;

  let existing;
  try {
    existing = JSON.parse(usingSeed ? readBundledBaseline() : readUtf8NoBom(comparisonPath));
  } catch {
    return probeFailure("现有预测 JSON 无法解析");
  }
  const existingPost = existing?.current?.latest_overall_post;
  const existingCursorPost = maxRecentPostById(existing?.current?.recent_tibo_posts) ?? existingPost;
  if (!usingSeed && (existing?.schema_version !== SCHEMA_VERSION || existing?.classification_version !== CLASSIFICATION_VERSION || existing?.model?.version !== MODEL_VERSION)) return probeFailure("现有预测版本或分类规则不兼容");
  if (!usingSeed && (existing?.status === "blocked" || !Array.isArray(existing?.forecast?.horizons) || !existing.forecast.horizons.length)) return probeFailure("现有预测结果不可复用");
  const existingTimelineReasons = recentPostIntegrityReasons(existing?.current);
  if (existingTimelineReasons.length) return probeFailure(`现有预测近期时间线校验失败：${existingTimelineReasons.join("；")}`);
  if (!existingPost?.post_id || !existingCursorPost?.post_id || !/^\d+$/.test(String(existingCursorPost.post_id)) || !existingCursorPost?.published_at_utc) return probeFailure("现有预测缺少可比较的最新帖子或增量游标");

  let probe;
  try {
    probe = normalizeProbe(rawProbe);
  } catch (error) {
    return { action: "retry_probe", reason: error.message, wrote_files: false };
  }
  const validSources = probe.sources.filter((source) => source.status === "ok" && source.fresh && new Set(["chatgpt_remote_web_search", "remote_connector"]).has(source.retrieval_method));
  if (!validSources.length) return { action: "retry_probe", reason: "快速检查缺少新鲜远程来源", wrote_files: false };
  if (probe.sources.some((source) => source.status !== "failed" && !source.fresh)) return { action: "retry_probe", reason: "快速检查来源不在 20 分钟新鲜度窗口内", wrote_files: false };

  const remotePost = probe.latestOverallPost;
  if (!remotePost?.post_id || !/^\d+$/.test(String(remotePost.post_id)) || !remotePost?.published_at_utc || !remotePost?.url) return { action: "retry_probe", reason: "远程来源没有返回精确帖子 ID、时间和 URL", wrote_files: false };
  const existingId = String(existingCursorPost.post_id);
  const remoteId = String(remotePost.post_id);
  const existingAt = iso(existingCursorPost.published_at_utc, "existing.probe_cursor_post.published_at_utc");
  const remoteAt = iso(remotePost.published_at_utc, "probe.latest_overall_post.published_at_utc");
  const remoteSnowflakeTime = snowflakeTimestampMs(remoteId);
  if (remoteSnowflakeTime == null || Math.abs(new Date(remoteAt).getTime() - remoteSnowflakeTime) > POST_TIME_TOLERANCE_MS || !String(remotePost.url).includes(`/status/${remoteId}`)) return { action: "retry_probe", reason: "远程最新帖子 ID、发布时间或 URL 绑定不一致", wrote_files: false };
  const requiredFloorId = BigInt(existingId) > BigInt(KNOWN_LATEST_POST_FLOOR.post_id) ? existingId : KNOWN_LATEST_POST_FLOOR.post_id;
  if (BigInt(remoteId) < BigInt(requiredFloorId)) return { action: "retry_probe", reason: `远程候选早于已知最低锚点 ${requiredFloorId}`, existing_post_id: existingId, remote_post_id: remoteId, wrote_files: false };
  if (remoteId === existingId) {
    if (usingSeed) return { action: "full_refresh", reason: "cold_start_seed_anchor", existing_post_id: existingId, remote_post_id: remoteId, checked_at_utc: probe.checkedAt, wrote_files: false };
    if (existingPromiseNeedsResolution(existing, probe.checkedAt)) return { action: "full_refresh", reason: "signal_outcome_window_elapsed", existing_post_id: existingId, remote_post_id: remoteId, checked_at_utc: probe.checkedAt, wrote_files: false };
    return {
      action: "reuse_existing",
      reason: "same_latest_post",
      existing_post_id: existingId,
      remote_post_id: remoteId,
      generated_at_beijing: existing.generated_at_beijing ?? null,
      checked_at_utc: probe.checkedAt,
      output: path.resolve(existingPath),
      wrote_files: false,
    };
  }
  if (BigInt(remoteId) > BigInt(existingId)) {
    return { action: "full_refresh", reason: "new_latest_post", existing_post_id: existingId, remote_post_id: remoteId, checked_at_utc: probe.checkedAt, wrote_files: false };
  }
  return { action: "retry_probe", reason: "远程帖子 ID 或发布时间发生倒退", existing_post_id: existingId, remote_post_id: remoteId, wrote_files: false };
}

function runBacktest(rawInput) {
  const data = normalizeInput(rawInput);
  const events = confirmedEvents(data);
  if (events.length < 10) throw new Error("回测至少需要 10 次可信重置事件");
  const validation = signalWalkForwardValidation(events, data);
  return {
    model: "tibo_signal_worktime_survival",
    version: MODEL_VERSION,
    training_rule: "每一折只使用该 Tibo 信号之前的数据；latest_holdout 不进入训练",
    work_timezone: data.current.tibo_work_timezone,
    fold_count: validation.folds,
    signal_brier: validation.metrics,
    baseline_brier: validation.baselineMetrics,
    latest_holdout: validation.latestHoldout,
    passed: validation.passed,
    fold_details: validation.fold_details,
  };
}

function syntheticInput() {
  const start = Date.parse("2026-09-01T00:00:00Z");
  const events = [];
  const signals = [];
  for (let index = 0; index < 30; index += 1) {
    const eventMs = start + index * 72 * 3600_000 + (index % 3) * 5 * 3600_000;
    events.push({
      event_id: `reset-${index}`,
      event_type: "confirmed_reset",
      announced_at_utc: new Date(eventMs).toISOString(),
      effective_at_utc: null,
      post_id: `post-${index}`,
      source_url: `https://example.com/reset-${index}`,
      confidence: 1,
      reason_tags: [],
      included_in_training: true,
      exclusion_reason: null,
    });
    if (index > 0) {
      const signalMs = eventMs - 4 * 3600_000;
      signals.push({
        post_id: `signal-${index}`,
        published_at_utc: new Date(signalMs).toISOString(),
        url: `https://example.com/signal-${index}`,
        text: "reset in a few hours",
        signal_level: 3,
        classification_evidence: "in a few hours",
        matched_reset_event_id: `reset-${index}`,
        hours_to_reset: 4,
        reset_within_4h: true,
        reset_within_24h: true,
        reset_within_72h: true,
      });
    }
  }
  for (let index = 0; index < 4; index += 1) {
    signals.push({
      post_id: `miss-${index}`,
      published_at_utc: new Date(start + (index * 6 + 2) * 72 * 3600_000).toISOString(),
      url: `https://example.com/miss-${index}`,
      text: "resets are interesting",
      signal_level: 1,
      classification_evidence: "resets",
      matched_reset_event_id: null,
      hours_to_reset: null,
      reset_within_4h: false,
      reset_within_24h: false,
      reset_within_72h: false,
    });
  }
  const asOf = new Date(new Date(events.at(-1).announced_at_utc).getTime() + 24 * 3600_000).toISOString();
  const recentPosts = Array.from({ length: 12 }, (_, index) => {
    const publishedAtMs = new Date(asOf).getTime() - index * 3600_000;
    const postId = (((BigInt(publishedAtMs) - X_EPOCH_MS) << 22n) + BigInt(index)).toString();
    return {
      post_id: postId,
      published_at_utc: new Date(publishedAtMs).toISOString(),
      url: `https://x.com/thsottiaux/status/${postId}`,
      text_original: `Recent post ${index}`,
      text_zh: `近期动态 ${index}`,
      translation_method: "chatgpt",
      post_type: index === 1 ? "reset_signal" : "other",
      signal_level: index === 1 ? 2 : 0,
      classification_evidence: index === 1 ? "mentions reset" : "no reset signal",
      is_latest_overall: index === 0,
      is_latest_reset_signal: index === 1,
    };
  });
  return {
    classification_version: CLASSIFICATION_VERSION,
    current: {
      as_of_utc: asOf,
      cross_source_consistent: true,
      latest_overall_post: { post_id: recentPosts[0].post_id, published_at_utc: recentPosts[0].published_at_utc, url: recentPosts[0].url, text: recentPosts[0].text_original, signal_level: recentPosts[0].signal_level, classification_evidence: recentPosts[0].classification_evidence },
      latest_reset_signal: { post_id: recentPosts[1].post_id, published_at_utc: recentPosts[1].published_at_utc, url: recentPosts[1].url, text: recentPosts[1].text_original, signal_level: recentPosts[1].signal_level, classification_evidence: recentPosts[1].classification_evidence },
      recent_tibo_posts: recentPosts,
    },
    sources: [
      { source_id: "one", name: "Tibo X", url: recentPosts[0].url, retrieved_at_utc: asOf, source_reported_fetched_at_utc: null, independence_group: "x_original", evidence_scopes: ["latest_overall", "latest_reset_signal"], observed_post_id: recentPosts[0].post_id, observed_post_at_utc: recentPosts[0].published_at_utc, observed_post_url: recentPosts[0].url, retrieval_method: "chatgpt_remote_web_search", status: "ok", evidence_ref: "source:one" },
      { source_id: "two", name: "Remote search", url: recentPosts[0].url, retrieved_at_utc: asOf, source_reported_fetched_at_utc: null, independence_group: "search_engine", evidence_scopes: ["latest_overall"], observed_post_id: recentPosts[0].post_id, observed_post_at_utc: recentPosts[0].published_at_utc, observed_post_url: recentPosts[0].url, retrieval_method: "chatgpt_remote_web_search", status: "ok", evidence_ref: "source:two" },
      { source_id: "official", name: "OpenAI status", url: "https://status.openai.com", retrieved_at_utc: asOf, source_reported_fetched_at_utc: null, independence_group: "openai_official", evidence_scopes: ["official_status"], retrieval_method: "chatgpt_remote_web_search", status: "ok", evidence_ref: "source:official" },
    ],
    reasoning_context: {
      horizons: HORIZONS.map((hours) => ({
        horizon_hours: hours,
        llm_evidence_summary: `ChatGPT 对未来 ${hours} 小时公开证据的结构化解读。`,
        supporting_factors: ["最新动态提到 reset。"],
        counter_factors: ["没有明确时间承诺。"],
        uncertainty: "公开信号样本有限，解读不参与概率计算。",
        evidence_refs: ["source:one", "source:two"],
      })),
    },
    historical_events: events,
    historical_signals: signals,
    historical_contexts: [],
  };
}

function selfTest() {
  const unicodeSample = '{"text":"中文编码校验"}';
  const encodedSample = Buffer.from(unicodeSample, "utf8").toString("base64");
  if (readInputText(null, encodedSample) !== unicodeSample) throw new Error("自检 UTF-8 Base64 输入通道失败");
  process.env.CODEX_RESET_SELF_TEST = unicodeSample;
  if (readInputText(null, null, "CODEX_RESET_SELF_TEST") !== unicodeSample) throw new Error("自检环境变量输入通道失败");
  delete process.env.CODEX_RESET_SELF_TEST;
  const onceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-reset-once-"));
  const oncePath = path.join(onceDirectory, ".codex-reset-input.json");
  fs.writeFileSync(oncePath, unicodeSample, "utf8");
  if (readInputOnce(oncePath) !== unicodeSample || fs.existsSync(oncePath)) throw new Error("自检一次性 UTF-8 输入通道或清理失败");
  fs.rmSync(onceDirectory, { recursive: true, force: true });
  if (normalizeRecentPost({ post_id: "done", published_at_utc: new Date().toISOString(), signal_level: 4 }).signal_level !== 4) throw new Error("自检已完成重置等级 4 被错误降级");
  const output = runForecast(syntheticInput());
  validateOutput(output);
  if (output.status === "blocked") throw new Error(`自检被意外阻断：${output.blocked_reasons.join("；")}`);
  const inferredWindowStart = "2026-08-13T01:01:37Z";
  if (inferredPromisedWindowEndAt({ at: inferredWindowStart, text: "Landing in the next hour or so" }) !== "2026-08-13T03:01:37.000Z") throw new Error("自检未解析明确承诺窗口");
  const expiredInput = syntheticInput();
  const expiredAtMs = new Date(expiredInput.current.as_of_utc).getTime() - 23 * 3600_000;
  const expiredPostId = ((BigInt(expiredAtMs) - X_EPOCH_MS) << 22n).toString();
  const expiredPost = expiredInput.current.recent_tibo_posts[1];
  expiredPost.post_id = expiredPostId;
  expiredPost.published_at_utc = new Date(expiredAtMs).toISOString();
  expiredPost.url = `${TIBO_X_URL}/status/${expiredPostId}`;
  expiredPost.text_original = "Enjoy a nice reset everyone. Landing in the next hour or so.";
  expiredPost.post_type = "reset_signal";
  expiredPost.signal_level = 3;
  expiredPost.reset_meaning = "explicit_future";
  expiredInput.current.latest_reset_signal = postFromRecent(normalizeRecentPost(expiredPost));
  expiredInput.historical_signals.push({
    post_id: expiredPostId, published_at_utc: expiredPost.published_at_utc, url: expiredPost.url, text: expiredPost.text_original,
    signal_level: 3, intent_class: "explicit_commitment", has_explicit_timing: true,
    promised_window_end_at_utc: inferredPromisedWindowEndAt(expiredPost), outcome_status: "not_observed", outcome_time_kind: "right_censored",
    observation_end_at_utc: expiredInput.current.as_of_utc, confidence: 1, classification_evidence: "明确未来承诺",
    matched_reset_event_id: null, hours_to_reset: null, reset_within_4h: false, reset_within_24h: false, reset_within_72h: false,
  });
  const expiredOutput = runForecast(expiredInput);
  if (expiredOutput.status !== "blocked" || !expiredOutput.blocked_reasons.some((reason) => reason.includes("静默重置"))) throw new Error("自检未阻止过期但结果未知的明确重置承诺");
  if (!existingPromiseNeedsResolution(expiredOutput, expiredInput.current.as_of_utc)) throw new Error("自检未在帖子 ID 不变时触发过期承诺刷新");
  const resolvedInput = structuredClone(expiredInput);
  const observedAt = new Date(expiredAtMs + 90 * 60_000).toISOString();
  resolvedInput.historical_events.push({ event_id: "reset-silent", event_type: "confirmed_reset", announced_at_utc: observedAt, effective_at_utc: observedAt, post_id: null, source_url: "https://tracker.example/reset-silent", confidence: 0.9, reason_tags: ["silent_reset_observation"], included_in_training: true, exclusion_reason: null });
  const resolvedOutput = runForecast(resolvedInput);
  if (resolvedOutput.status === "blocked" || resolvedOutput.forecast.horizons.some((row) => row.signal_probability_delta !== 0)) throw new Error("自检未用静默重置事件关闭旧信号并回到重置后基线");
  const conditionalCurrent = { post_id: "current", published_at_utc: "2026-01-02T00:00:00Z", signal_level: 3, intent_class: "explicit_commitment" };
  const conditionalPoints = bayesianSignalAdjustment([{ hour: 2, probability: 0.1 }], { signals: [{ post_id: "old", published_at_utc: "2026-01-01T00:00:00Z", signal_level: 3, intent_class: "explicit_commitment", confidence: 1, latency_lower_hours: 1, latency_upper_hours: 1, outcome_time_kind: "exact" }] }, conditionalCurrent, Date.parse("2026-01-02T10:00:00Z"));
  if (conditionalPoints[0].posterior.weighted_successes !== 0 || conditionalPoints[0].posterior.unavailable_outcome_count !== 1) throw new Error("自检未按已等待条件排除早已落地的历史信号");
  const explicitPriorPoints = bayesianSignalAdjustment([{ hour: 4, probability: 0.1 }], { signals: [{ post_id: "prior-explicit", published_at_utc: "2026-01-01T00:00:00Z", signal_level: 3, intent_class: "explicit_commitment", confidence: 1, latency_lower_hours: 2, latency_upper_hours: 2, outcome_time_kind: "exact" }] }, { post_id: "current-explicit", published_at_utc: "2026-01-02T00:00:00Z", signal_level: 3, intent_class: "explicit_commitment" }, Date.parse("2026-01-02T00:00:00Z"));
  if (explicitPriorPoints[0].probability <= 0.5) throw new Error("自检明确预告没有从历史明确预告的兑现结果获得有效加成");
  const legacyAnnouncement = { post_id: "done", outcome_time_kind: "exact", latency_lower_hours: 0, latency_upper_hours: 0, matched_reset_event_id: "reset-done" };
  if (!isLegacyCompletedAnnouncementSignal(legacyAnnouncement, [{ event_id: "reset-done", post_id: "done" }])) throw new Error("自检未识别旧基座中的已完成公告伪信号");
  if (output.current.recent_tibo_posts.length !== 12 || output.current.recent_tibo_posts.some((post, index, posts) => index > 0 && compareRecentPosts(posts[index - 1], post) > 0)) throw new Error("自检近期动态未完整保留或未按最新优先排序");
  const mismatchedTimelineInput = syntheticInput();
  mismatchedTimelineInput.current.recent_tibo_posts[2].published_at_utc = mismatchedTimelineInput.current.recent_tibo_posts[3].published_at_utc;
  const mismatchedTimelineOutput = runForecast(mismatchedTimelineInput);
  if (mismatchedTimelineOutput.status !== "blocked" || !mismatchedTimelineOutput.blocked_reasons.some((reason) => reason.includes("Snowflake ID"))) throw new Error("自检未阻止帖子 ID 与发布时间错配");
  const mismatchedTextInput = syntheticInput();
  mismatchedTextInput.current.latest_overall_post.text = "wrong post text";
  const mismatchedTextOutput = runForecast(mismatchedTextInput);
  if (mismatchedTextOutput.status !== "degraded" || mismatchedTextOutput.current.cross_source_consistent || mismatchedTextOutput.current.latest_overall_post.text === "wrong post text") throw new Error("自检未从时间线修复最新帖子正文错配并降级");
  if (output.history.confirmed_reset_count !== 30) throw new Error("自检历史事件数量不正确");
  if (output.forecast.horizons.length !== HORIZONS.length || output.forecast.horizons.at(-1)?.horizon_hours !== 72) throw new Error("自检预测范围超过 72 小时");
  if (output.conclusion.primary_horizon_hours == null || !output.conclusion.headline.includes("重置概率")) throw new Error("自检结论结构不正确");
  const conflictInput = syntheticInput();
  conflictInput.current.cross_source_consistent = false;
  conflictInput.sources[1].status = "conflict";
  const conflictOutput = runForecast(conflictInput);
  validateOutput(conflictOutput);
  if (conflictOutput.status !== "degraded" || conflictOutput.forecast.horizons.length !== HORIZONS.length) throw new Error("自检来源冲突未继续生成降级预测");
  if (!conflictOutput.explanation.factors.some((factor) => factor.feature_key === "source_consistency")) throw new Error("自检来源冲突缺少降级说明");
  const forbiddenInput = syntheticInput();
  forbiddenInput.reasoning_context.horizons[0].cumulative_probability = 1;
  const forbiddenOutput = runForecast(forbiddenInput);
  if (forbiddenOutput.status !== "blocked" || !forbiddenOutput.blocked_reasons.some((reason) => reason.includes("禁止字段"))) throw new Error("自检未阻止 LLM 覆盖概率字段");
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-reset-forecast-"));
  const target = path.join(temporaryDirectory, OUTPUT_NAME);
  writeAtomic(output, target);
  const htmlTarget = writeHtmlAtomic(output, target);
  const reread = JSON.parse(fs.readFileSync(target, "utf8"));
  validateOutput(reread);
  const state = compactExistingState(target);
  if (!state.base_reusable || state.display_allowed !== false || "forecast_summary" in state || state.latest_overall_post_id !== output.current.latest_overall_post.post_id || state.confirmed_reset_count !== output.history.confirmed_reset_count) throw new Error("自检紧凑状态读取失败或提前暴露概率");
  const gateRequiredPosts = output.current.recent_tibo_posts.map((post) => ({ post_id: post.post_id, published_at_utc: post.published_at_utc, url: post.url, text_original: post.text_original }));
  const gateSnapshot = { schema_version: 1, checked_at_utc: new Date().toISOString(), latest_overall_post: output.current.latest_overall_post, probe_post: maxRecentPostById(gateRequiredPosts), required_posts: gateRequiredPosts };
  const gateResult = evaluateLiveSnapshot(gateSnapshot, target);
  if (gateResult.action !== "reuse_existing" || gateResult.display_allowed !== true || !gateResult.forecast_summary?.horizons?.length) throw new Error("自检安全实时入口未在门禁通过后返回概率");
  const gapResult = evaluateLiveSnapshot({ ...gateSnapshot, required_posts: [...gateRequiredPosts, { post_id: `${BigInt(gateSnapshot.probe_post.post_id) + 1n}`, published_at_utc: new Date().toISOString(), url: `${TIBO_X_URL}/status/${BigInt(gateSnapshot.probe_post.post_id) + 1n}`, text_original: "new" }] }, target);
  if (gapResult.action !== "full_refresh" || gapResult.display_allowed !== false || "forecast_summary" in gapResult) throw new Error("自检安全实时入口在清单缺口时提前暴露概率");
  const deltaInput = syntheticInput();
  deltaInput.historical_events = [];
  deltaInput.historical_signals = [];
  deltaInput.historical_contexts = [];
  const mergedInput = mergeBaseHistory(deltaInput, target);
  const mergedOutput = runForecast(mergedInput);
  if (mergedOutput.status === "blocked" || !mergedOutput.refresh.cached_history_verified || mergedOutput.history.confirmed_reset_count !== output.history.confirmed_reset_count) throw new Error("自检历史基座增量重算失败");
  const staleDelta = syntheticInput();
  staleDelta.historical_events = [];
  staleDelta.historical_signals = [];
  staleDelta.historical_contexts = [];
  staleDelta.current.recent_tibo_posts = [];
  staleDelta.current.latest_overall_post = output.current.latest_reset_signal;
  const recoveredOutput = runForecast(mergeBaseHistory(staleDelta, target));
  if (recoveredOutput.status === "blocked" || recoveredOutput.current.cross_source_consistent || recoveredOutput.current.latest_overall_post.post_id !== output.current.latest_overall_post.post_id || recoveredOutput.current.recent_tibo_posts.length !== output.current.recent_tibo_posts.length) throw new Error("自检未用基座时间线修复不完整增量");
  const report = renderMarkdownReport(reread, target);
  if (!["数据抓取时间", "Tibo 最新总体动态", "第二来源核验", "一致", "预计截止时间（北京时间）", "模型因素", path.resolve(target)].every((text) => report.includes(text))) throw new Error("自检固定对话报告缺少必填内容");
  const legacy = JSON.parse(JSON.stringify(reread));
  legacy.schema_version = "1.9.0";
  delete legacy.current.cross_source_consistent;
  legacy.sources = legacy.sources.map(({ source_reported_fetched_at_utc, effective_retrieved_at_utc, independence_group, evidence_scopes, ...source }) => source);
  validateOutput(migrateDisplayContract(legacy));
  if (!fs.existsSync(htmlTarget)) throw new Error("自检未生成固定 HTML 文件");
  if (!fs.existsSync(path.join(temporaryDirectory, LOCAL_SERVER_NAME)) || !fs.existsSync(path.join(temporaryDirectory, LOCAL_LAUNCHER_NAME))) throw new Error("自检未生成本地启动文件");
  const html = fs.readFileSync(htmlTarget, "utf8");
  if (html.includes("embedded-forecast-data") || html.includes('type="application/json"') || html.includes('type="file"') || html.includes('location.protocol') || !html.includes('new URL("./", location.href)') || !html.includes('new URL(DATA_FILE, pageDirectoryUrl)') || !html.includes('searchParams.set("_t"') || !html.includes("[...posts].sort")) throw new Error("自检 HTML 纯网络同目录加载及最新优先排序契约失败");
  const lastReset = output.history.events.filter((event) => event.event_type === "confirmed_reset" && event.included_in_training).at(-1);
  const probeResult = runRefreshProbe({
    checked_at_utc: output.generated_at_utc,
    sources: [{ source_id: "probe", name: "probe", url: "https://example.com/probe", retrieved_at_utc: output.generated_at_utc, retrieval_method: "chatgpt_remote_web_search", status: "ok", fresh: true, evidence_ref: "source:probe" }],
    latest_overall_post: output.current.latest_overall_post,
    latest_reset_signal: output.current.latest_reset_signal,
    last_confirmed_reset: { event_id: lastReset.event_id, announced_at_utc: lastReset.announced_at_utc },
    status_indicator: output.refresh.status_indicator,
    active_incident_id: output.refresh.active_incident_id,
  }, target, target);
  if (probeResult.action !== "reuse_existing" || probeResult.wrote_files || probeResult.reason !== "same_latest_post") throw new Error("自检同 ID 快速复用失败");
  const blockedExistingTarget = path.join(temporaryDirectory, "blocked-existing.json");
  fs.writeFileSync(blockedExistingTarget, JSON.stringify({ ...output, status: "blocked", forecast: { horizons: [], most_likely_windows: [] } }), "utf8");
  const blockedProbeResult = runRefreshProbe({ checked_at_utc: output.generated_at_utc, sources: [{ name: "probe", url: "https://example.com/probe", retrieved_at_utc: output.generated_at_utc }], latest_overall_post: output.current.latest_overall_post }, blockedExistingTarget, target);
  if (blockedProbeResult.action !== "full_refresh" || !blockedProbeResult.reason.includes("不可复用")) throw new Error("自检错误复用 blocked 预测");
  const corruptedExistingTarget = path.join(temporaryDirectory, "corrupted-existing.json");
  const corruptedExisting = JSON.parse(JSON.stringify(output));
  corruptedExisting.current.recent_tibo_posts[2].published_at_utc = corruptedExisting.current.recent_tibo_posts[3].published_at_utc;
  fs.writeFileSync(corruptedExistingTarget, JSON.stringify(corruptedExisting), "utf8");
  const corruptedProbeResult = runRefreshProbe({
    checked_at_utc: output.generated_at_utc,
    sources: [{ source_id: "probe", name: "probe", url: "https://example.com/probe", retrieved_at_utc: output.generated_at_utc, retrieval_method: "chatgpt_remote_web_search", status: "ok", fresh: true, evidence_ref: "source:probe" }],
    latest_overall_post: output.current.latest_overall_post,
  }, corruptedExistingTarget, target);
  if (corruptedProbeResult.action !== "full_refresh" || !corruptedProbeResult.reason.includes("近期时间线校验失败")) throw new Error("自检未阻止复用损坏的近期时间线");
  const newerPostId = `${BigInt(output.current.latest_overall_post.post_id) + 1n}`;
  const newerProbe = {
    ...JSON.parse(JSON.stringify({
      checked_at_utc: output.generated_at_utc,
      sources: [{ source_id: "probe", name: "probe", url: "https://example.com/probe", retrieved_at_utc: output.generated_at_utc, retrieval_method: "chatgpt_remote_web_search", status: "ok", fresh: true, evidence_ref: "source:probe" }],
      latest_overall_post: { ...output.current.latest_overall_post, post_id: newerPostId, url: `https://x.com/thsottiaux/status/${newerPostId}` },
    })),
  };
  if (runRefreshProbe(newerProbe, target, target).action !== "full_refresh") throw new Error("自检新 ID 未进入完整刷新路径");
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  process.stdout.write("forecast self-test passed\n");
}

function smokeTest() {
  const valid = validateSnapshot(syntheticInput());
  if (valid.action !== "proceed") throw new Error(`快速自检预检失败：${valid.blocked_reasons.join("；")}`);
  const threadedInput = syntheticInput();
  threadedInput.current.recent_tibo_posts[0].is_latest_overall = false;
  threadedInput.current.recent_tibo_posts[1].is_latest_overall = true;
  delete threadedInput.current.latest_overall_post;
  delete threadedInput.current.latest_reset_signal;
  const threadedData = normalizeInput(threadedInput);
  if (threadedData.current.latest_overall_post.post_id !== threadedInput.current.recent_tibo_posts[1].post_id || threadedData.current.recent_tibo_posts[0].post_id !== threadedInput.current.recent_tibo_posts[1].post_id || maxRecentPostById(threadedData.current.recent_tibo_posts).post_id !== threadedInput.current.recent_tibo_posts[0].post_id) throw new Error("快速自检未区分帖子串顶部主帖与最大增量游标");
  const compactBase = syntheticInput();
  const compact = {
    classification_version: CLASSIFICATION_VERSION,
    as_of_utc: compactBase.current.as_of_utc,
    posts: compactBase.current.recent_tibo_posts.map((post) => ({ id: post.post_id, at: post.published_at_utc, url: post.url, text: post.text_original, zh: post.text_zh, type: post.post_type, level: post.signal_level, reset_meaning: inferredResetMeaning(post), evidence: post.classification_evidence, confirmed_event: false, latest: post.is_latest_overall })),
    sources: compactBase.sources.map((source) => ({ id: source.source_id, name: source.name, url: source.url, group: source.independence_group, scopes: source.evidence_scopes, post_id: source.observed_post_id, ref: source.evidence_ref })),
    status_indicator: "operational",
  };
  const compactValidation = validateSnapshot(mergeBaseHistory(compact, null));
  if (compactValidation.action !== "proceed") throw new Error(`快速自检未接受紧凑当前证据格式：${compactValidation.blocked_reasons.join("；")}`);
  const compactMerged = mergeBaseHistory(compact, null);
  const compactCurrentSignal = compactMerged.historical_signals.find((signal) => signal.post_id === compact.posts.find((post) => post.type === "reset_signal")?.id);
  if (!compactCurrentSignal || compactCurrentSignal.outcome_time_kind !== "right_censored" || compactCurrentSignal.intent_class !== "directional_reset") throw new Error("快速自检未把 LLM 实时分类转换为模型当前信号");
  const promisedWindowEnd = new Date(new Date(compact.as_of_utc).getTime() + 12 * 3600_000).toISOString();
  const promisedCompact = expandCompactInput({ classification_version: CLASSIFICATION_VERSION, as_of_utc: compact.as_of_utc, posts: [{ ...compact.posts[0], text: "I will reset Codex usage limits later today.", zh: "我会在今天晚些时候重置 Codex 使用额度。", type: "reset_signal", level: 3, reset_meaning: "explicit_future", evidence: "明确表示未来会重置", confirmed_event: false, window_end: promisedWindowEnd }], sources: [] });
  if (promisedCompact.historical_signals[0]?.promised_window_end_at_utc !== promisedWindowEnd) throw new Error("快速自检丢失 LLM 提供的明确承诺窗口上限");
  const completedText = "I have reset Codex usage limits for everyone.";
  const completedCompact = expandCompactInput({ classification_version: CLASSIFICATION_VERSION, as_of_utc: compact.as_of_utc, posts: [{ ...compact.posts[0], text: completedText, type: "reset_signal", level: 4, reset_meaning: "completed", confirmed_event: true }], sources: [] });
  if (completedCompact.historical_events[0]?.event_id !== `reset-${compact.posts[0].id}`) throw new Error("快速自检未从已完成重置帖生成确认事件");
  const companionCompact = expandCompactInput({ classification_version: CLASSIFICATION_VERSION, as_of_utc: compact.as_of_utc, posts: [{ ...compact.posts[0], text: completedText, type: "reset_signal", level: 4, reset_meaning: "completed", confirmed_event: false }], sources: [] });
  if (companionCompact.historical_events.length) throw new Error("快速自检未抑制同一帖子串的重复确认事件");
  const trackerSources = [
    { id: "tracker_a", url: "https://tracker-a.example/event", group: "tracker_a", scopes: ["reset_history"], ref: "source:tracker_a" },
    { id: "tracker_b", url: "https://tracker-b.example/event", group: "tracker_b", scopes: ["reset_history"], ref: "source:tracker_b" },
  ];
  const silentCompact = expandCompactInput({ classification_version: CLASSIFICATION_VERSION, as_of_utc: compact.as_of_utc, posts: [], sources: trackerSources, reset_events: [{ id: "silent-1", at: compact.as_of_utc, url: trackerSources[0].url, source_refs: trackerSources.map((source) => source.ref) }] });
  if (silentCompact.historical_events[0]?.event_id !== "reset-observed-silent-1") throw new Error("快速自检未接受双来源核验的静默重置事件");
  let singleTrackerRejected = false;
  try { expandCompactInput({ classification_version: CLASSIFICATION_VERSION, as_of_utc: compact.as_of_utc, posts: [], sources: trackerSources, reset_events: [{ id: "silent-2", at: compact.as_of_utc, url: trackerSources[0].url, source_refs: [trackerSources[0].ref] }] }); } catch { singleTrackerRejected = true; }
  if (!singleTrackerRejected) throw new Error("快速自检未拒绝单来源静默重置事件");
  for (const invalidPost of [
    { ...compact.posts[0], text: "Enjoy a nice reset everyone. Landing in the next hour or so.", type: "reset_signal", level: 4, reset_meaning: "completed", confirmed_event: true },
    { ...compact.posts[0], text: "Don't say reset.", type: "other", level: 1, reset_meaning: "weak", confirmed_event: false },
    { ...compact.posts[0], type: "social", level: 0, reset_meaning: "none", confirmed_event: false },
  ]) {
    let rejected = false;
    try { expandCompactInput({ classification_version: CLASSIFICATION_VERSION, as_of_utc: compact.as_of_utc, posts: [invalidPost], sources: [] }); } catch { rejected = true; }
    if (!rejected) throw new Error("快速自检未阻止语义、等级、类型或确认事件冲突");
  }
  const latestCompact = expandCompactInput({ classification_version: CLASSIFICATION_VERSION, as_of_utc: compact.as_of_utc, posts: [{ ...compact.posts[0], latest: true }], sources: [] });
  if (latestCompact.current.recent_tibo_posts[0]?.is_latest_overall !== true) throw new Error("快速自检未保留顶部帖子串主帖标记");
  const classifiedXIds = classifyVisibleXPostIds('/thsottiaux/status/2086800639120888014 /thsottiaux/status/2086972933566857393 /thsottiaux/status/2086874565909815403 /thsottiaux/status/2086972802457063486 /thsottiaux/status/2086353229894529148 /thsottiaux/status/2086874565909815403', [
    { id: '2086972933566857393', is_reply: true, replying_to: 'thsottiaux' },
    { id: '2086800639120888014', is_reply: true, replying_to: 'hqmank' },
  ]);
  if (classifiedXIds.eligible.join(',') !== '2086972933566857393,2086972802457063486,2086874565909815403,2086353229894529148' || classifiedXIds.topLevel.join(',') !== '2086972802457063486,2086874565909815403,2086353229894529148') throw new Error("快速自检未正确排序主帖、保留自身帖子串或排除普通回复");
  const proxyText = textFromXStatusHtml('<title>Tibo on X: &quot;Long &amp; useful&quot; / X</title> unrelated __typename:"NoteTweet",text:"Other text" target __typename:"NoteTweet",text:"Long &amp; useful\\n\\ncomplete text"', 'proxy-test');
  if (proxyText !== 'Long & useful\n\ncomplete text') throw new Error("快速自检未从 X 代理单帖页提取完整长帖正文");
  const truncatedTitleText = textFromXStatusHtml('<title>Tibo on X: &quot;Long truncated… / X</title> __typename:"NoteTweet",text:"Long truncated complete text"', 'proxy-truncated-title-test');
  if (truncatedTitleText !== 'Long truncated complete text') throw new Error("快速自检未兼容 X 长帖标题截断格式");
  if (comparableXText('Same post https://t.co/example') !== comparableXText('Same post') || comparableXText('Truncated… https://t.co/example') === comparableXText('Truncated complete text')) throw new Error("快速自检 X 正文比较规则失败");
  const collectionDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-reset-collection-"));
  const collectionPath = path.join(collectionDirectory, "live.json");
  const collectionInput = structuredClone(compactBase);
  collectionInput.current.as_of_utc = new Date().toISOString();
  const requiredPosts = collectionInput.current.recent_tibo_posts.slice(0, 3).map((post) => ({ post_id: post.post_id, published_at_utc: post.published_at_utc, url: post.url, text_original: post.text_original }));
  fs.writeFileSync(collectionPath, `${JSON.stringify({ schema_version: 1, checked_at_utc: collectionInput.current.as_of_utc, latest_overall_post: collectionInput.current.latest_overall_post, probe_post: maxRecentPostById(requiredPosts), required_posts: requiredPosts })}\n`, "utf8");
  assertLiveCollectionComplete(collectionInput, collectionPath);
  const incompleteTimeline = structuredClone(collectionInput);
  incompleteTimeline.current.recent_tibo_posts = incompleteTimeline.current.recent_tibo_posts.filter((post) => post.post_id !== requiredPosts[1].post_id);
  let missingPostRejected = false;
  try { assertLiveCollectionComplete(incompleteTimeline, collectionPath); } catch (error) { missingPostRejected = String(error.message).includes(requiredPosts[1].post_id); }
  if (!missingPostRejected) throw new Error("快速自检未阻止完整性清单中的中间帖子缺失");
  const mismatchedTimeline = structuredClone(collectionInput);
  mismatchedTimeline.current.recent_tibo_posts[0].text_original = "paraphrased";
  assertLiveCollectionComplete(mismatchedTimeline, collectionPath);
  if (mismatchedTimeline.current.recent_tibo_posts[0].text_original !== requiredPosts[0].text_original) throw new Error("快速自检未用实时清单恢复帖子原文");
  fs.rmSync(collectionDirectory, { recursive: true, force: true });
  if (normalizeRecentPost({ post_id: "alias", published_at_utc: new Date().toISOString(), post_type: "general" }).post_type !== "other") throw new Error("快速自检未归一化 general 类型");
  const preservedPost = mergeRecentPosts([{ post_id: "same", text_original: "verified" }], [{ post_id: "same", text_original: "summary" }])[0];
  const correctedPost = mergeRecentPosts([{ post_id: "same", text_original: "old" }], [{ post_id: "same", text_original: "corrected", correction: true }])[0];
  const excludedPosts = mergeRecentPosts([{ post_id: "same", text_original: "wrong" }], [{ post_id: "same", exclude: true }]);
  if (preservedPost.text_original !== "verified" || correctedPost.text_original !== "corrected" || excludedPosts.length) throw new Error("快速自检基座帖子防覆盖、显式修正或排除失败");
  const compactReasoningInput = syntheticInput();
  compactReasoningInput.reasoning_context = { evidence_summary: "单份全局证据摘要。", evidence_refs: ["source:one", "source:two"] };
  if (validateSnapshot(compactReasoningInput).action !== "proceed") throw new Error("快速自检未接受紧凑全局证据摘要");
  const softDisplayInput = syntheticInput();
  delete softDisplayInput.current.recent_tibo_posts[2].text_zh;
  delete softDisplayInput.current.recent_tibo_posts[2].classification_evidence;
  if (validateSnapshot(softDisplayInput).action !== "proceed") throw new Error("快速自检把非预测展示字段误设为硬门禁");
  const hardSignalInput = syntheticInput();
  delete hardSignalInput.current.recent_tibo_posts[1].text_zh;
  if (!validateSnapshot(hardSignalInput).blocked_reasons.some((reason) => reason.includes("预测相关动态"))) throw new Error("快速自检未保留预测相关动态翻译门禁");
  const staleInput = syntheticInput();
  staleInput.sources[0].source_reported_fetched_at_utc = new Date(new Date(staleInput.current.as_of_utc).getTime() - 21 * 60_000).toISOString();
  const stale = validateSnapshot(staleInput);
  if (stale.action !== "blocked" || !stale.blocked_reasons.some((reason) => reason.includes("新鲜度") || reason.includes("independence_group"))) throw new Error("快速自检未阻止过期来源");
  const staleAuxiliaryInput = syntheticInput();
  staleAuxiliaryInput.sources.push({ ...staleAuxiliaryInput.sources[2], source_id: "auxiliary", name: "Cached tracker history", url: "https://codex-reset.com/api/feed", source_reported_fetched_at_utc: new Date(new Date(staleAuxiliaryInput.current.as_of_utc).getTime() - 21 * 60_000).toISOString(), independence_group: "codex_reset_tracker", evidence_scopes: ["latest_reset_signal", "reset_history"], evidence_ref: "source:auxiliary" });
  const staleAuxiliary = validateSnapshot(staleAuxiliaryInput);
  if (staleAuxiliary.action !== "proceed" || !staleAuxiliary.warnings.some((warning) => warning.includes("auxiliary"))) throw new Error("快速自检错误阻断过期辅助来源");
  const sameGroupInput = syntheticInput();
  sameGroupInput.sources[1].independence_group = sameGroupInput.sources[0].independence_group;
  if (!validateSnapshot(sameGroupInput).blocked_reasons.some((reason) => reason.includes("不同 independence_group"))) throw new Error("快速自检未阻止非独立双来源");
  const noOfficialInput = syntheticInput();
  noOfficialInput.sources = noOfficialInput.sources.filter((source) => source.source_id !== "official");
  if (!validateSnapshot(noOfficialInput).blocked_reasons.some((reason) => reason.includes("OpenAI 官方域名"))) throw new Error("快速自检未阻止缺少官方状态来源");
  process.stdout.write("forecast smoke-test passed\n");
}

function formatBeijingText(value) {
  if (!value) return "无";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(value)).map((part) => [part.type, part.value]));
  return `${parts.year}年${parts.month}月${parts.day}日 ${parts.hour}:${parts.minute}`;
}

function tableCell(value) {
  return String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
}

function renderMarkdownReport(output, outputPath) {
  validateOutput(output);
  const latest = output.current.latest_overall_post;
  const reset = output.current.latest_reset_signal;
  const latestSources = output.sources.filter((source) => source.evidence_scopes.includes("latest_overall"));
  const secondSource = latestSources[1] ?? null;
  const lines = [
    `数据抓取时间：${formatBeijingText(output.generated_at_utc)}（北京时间）`,
    "",
    `Tibo 最新总体动态：${formatBeijingText(latest?.published_at_utc)}｜${latest?.post_id ?? "无"}｜${tableCell(latest?.text ?? "无")}`,
    "",
    `第二来源核验：${secondSource?.name ?? "无"}｜${secondSource?.evidence_ref ?? "无"}｜${output.current.cross_source_consistent ? "一致" : "冲突"}`,
    "",
    `最新重置相关动态：${formatBeijingText(reset?.published_at_utc)}｜${reset?.post_id ?? "无"}｜${tableCell(reset?.text ?? "无")}`,
    "",
    `结论：${output.conclusion.headline}`,
    "",
  ];
  if (output.status === "blocked") {
    lines.push(`本次未生成新概率：${output.blocked_reasons.join("；")}`, "");
  } else {
    lines.push("| 预计截止时间（北京时间） | 距当前约 | 累计重置概率 | 模型状态 |", "|---|---:|---:|---|", ...output.forecast.horizons.map((row) => `| ${tableCell(row.deadline_beijing)} | ${row.horizon_hours} 小时 | ${row.display_probability_percent}% | ${output.model.status} |`), "");
    lines.push("| 模型因素 | 当前值 | 影响方向 | 对数优势贡献 | 数据依据 |", "|---|---:|---|---:|---|", ...output.explanation.factors.map((factor) => `| ${tableCell(factor.feature_key)} | ${tableCell(factor.feature_value)} | ${tableCell(factor.direction)} | ${tableCell(factor.contribution_log_odds)} | ${tableCell(factor.evidence_refs.join("、"))} |`), "");
    if (output.forecast.most_likely_windows.length) lines.push("最可能窗口：", "", ...output.forecast.most_likely_windows.slice(0, 3).map((window) => `- ${window.start_at_beijing}—${window.end_at_beijing}：${Math.round(window.window_probability * 100)}%`), "");
    lines.push(`模型：${output.model.name} ${output.model.version}｜样本 ${output.model.training.sample_count}｜回测 ${output.model.validation.fold_count} 折｜通过：${output.model.validation.passed ? "是" : "否"}`, "");
  }
  lines.push("局限：", "", ...output.explanation.limitations.map((item) => `- ${item}`), "", output.explanation.risk_notice, "", `JSON：${path.resolve(outputPath)}`, `HTML：${path.join(path.dirname(path.resolve(outputPath)), HTML_NAME)}`, "", "来源：", "", ...output.sources.filter((source) => source.status !== "failed").map((source) => `- [${source.name}](${source.url})（${source.evidence_ref}）`));
  return `${lines.join("\n")}\n`;
}

function hasUsableExistingForecast(outputPath) {
  if (!fs.existsSync(outputPath)) return false;
  try {
    const existing = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    return existing.status !== "blocked" && Array.isArray(existing.forecast?.horizons) && existing.forecast.horizons.length > 0;
  } catch {
    return false;
  }
}

function compactExistingState(outputPath) {
  const usingSeed = !fs.existsSync(outputPath);
  const output = JSON.parse(usingSeed ? readBundledBaseline() : readUtf8NoBom(outputPath));
  const probeCursorPost = maxRecentPostById(output.current?.recent_tibo_posts) ?? output.current?.latest_overall_post;
  const useProbeCursor = BigInt(probeCursorPost?.post_id ?? "0") > BigInt(KNOWN_LATEST_POST_FLOOR.post_id);
  return {
    output: path.resolve(outputPath),
    base_source: usingSeed ? "bundled_seed" : "existing_output",
    output_exists: !usingSeed,
    result_reusable: !usingSeed && output.status !== "blocked",
    next_action: usingSeed ? "full_refresh_required" : "probe_then_reuse_or_refresh",
    schema_version: usingSeed ? SCHEMA_VERSION : output.schema_version ?? null,
    classification_version: usingSeed ? CLASSIFICATION_VERSION : output.classification_version ?? null,
    model_version: output.model?.version ?? null,
    generated_at_utc: usingSeed ? null : output.generated_at_utc ?? null,
    status: usingSeed ? "baseline_only" : output.status ?? null,
    latest_overall_post_id: output.current?.latest_overall_post?.post_id ?? null,
    latest_overall_post_at_utc: output.current?.latest_overall_post?.published_at_utc ?? null,
    probe_floor_post_id: useProbeCursor ? probeCursorPost.post_id : KNOWN_LATEST_POST_FLOOR.post_id,
    probe_floor_post_at_utc: useProbeCursor ? probeCursorPost.published_at_utc : KNOWN_LATEST_POST_FLOOR.published_at_utc,
    latest_reset_signal_id: output.current?.latest_reset_signal?.post_id ?? null,
    latest_reset_signal_at_utc: output.current?.latest_reset_signal?.published_at_utc ?? null,
    recent_post_count: Array.isArray(output.current?.recent_tibo_posts) ? output.current.recent_tibo_posts.length : 0,
    confirmed_reset_count: Array.isArray(output.history?.events) ? output.history.events.filter((event) => event.event_type === "confirmed_reset" && event.included_in_training).length : 0,
    historical_signal_count: Array.isArray(output.history?.signals) ? output.history.signals.length : 0,
    display_allowed: false,
    base_reusable: Array.isArray(output.current?.recent_tibo_posts) && Array.isArray(output.history?.events) && Array.isArray(output.history?.signals) && Array.isArray(output.history?.contexts),
  };
}

function compactForecastSummary(output) {
  return {
    headline: output.conclusion?.headline ?? null,
    horizons: Array.isArray(output.forecast?.horizons) ? output.forecast.horizons.map((item) => ({ horizon_hours: item.horizon_hours, display_probability_percent: item.display_probability_percent })) : [],
  };
}

function evaluateLiveSnapshot(snapshot, statePath) {
  const usingSeed = !fs.existsSync(statePath);
  const existing = JSON.parse(usingSeed ? readBundledBaseline() : readUtf8NoBom(statePath));
  const gaps = collectionGaps(snapshot, existing.current?.recent_tibo_posts);
  const mismatches = collectionMismatches(snapshot, existing.current?.recent_tibo_posts);
  if (gaps.length || mismatches.length) return {
    status: "ok",
    action: "full_refresh",
    reason: gaps.length ? "collection_gap" : "collection_mismatch",
    missing_post_ids: gaps,
    mismatched_post_ids: mismatches,
    display_allowed: false,
    wrote_files: false,
    ...snapshot,
  };
  const result = runRefreshProbe({
    checked_at_utc: snapshot.checked_at_utc,
    latest_overall_post: snapshot.probe_post,
    sources: [{ name: "deterministic live gate", url: TIBO_X_URL, retrieved_at_utc: snapshot.checked_at_utc }],
  }, statePath, statePath);
  if (result.action !== "reuse_existing") return {
    status: result.action === "full_refresh" ? "ok" : "blocked",
    action: result.action === "full_refresh" ? "full_refresh" : "stop",
    reason: result.reason,
    display_allowed: false,
    wrote_files: false,
    ...snapshot,
  };
  return {
    status: "ok",
    ...result,
    display_allowed: true,
    forecast_summary: compactForecastSummary(existing),
  };
}

async function startLiveGate(statePath, collectionPath) {
  if (!statePath) return { status: "blocked", action: "stop", stage: "start_live", reason: "--start-live 必须同时提供 --state", display_allowed: false, wrote_files: false };
  try {
    return evaluateLiveSnapshot(await collectLiveSnapshot(statePath, collectionPath), statePath);
  } catch (error) {
    return { status: "blocked", action: "stop", stage: "collect_live", reason: error.message, display_allowed: false, wrote_files: false };
  }
}

function readUtf8NoBom(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`缺少固定产物：${filePath}`);
  const bytes = fs.readFileSync(filePath);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new Error(`固定产物包含 UTF-8 BOM：${filePath}`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`固定产物不是有效 UTF-8：${filePath}`);
  }
}

function readBundledBaseline() {
  const bytes = zlib.gunzipSync(fs.readFileSync(BASELINE_HISTORY_TEMPLATE));
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new Error("内置历史基座包含 UTF-8 BOM");
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (hasEncodingCorruption(JSON.parse(text))) throw new Error("内置历史基座包含连续问号或其他乱码字符");
    return text;
  } catch {
    throw new Error("内置历史基座不是有效 UTF-8");
  }
}

function verifyArtifactBundle(outputPath) {
  const resolvedOutput = path.resolve(outputPath);
  const directory = path.dirname(resolvedOutput);
  const output = JSON.parse(readUtf8NoBom(resolvedOutput));
  validateOutput(output);
  const html = readUtf8NoBom(path.join(directory, HTML_NAME));
  readUtf8NoBom(path.join(directory, LOCAL_SERVER_NAME));
  readUtf8NoBom(path.join(directory, LOCAL_LAUNCHER_NAME));
  if (!html.includes(`const DATA_FILE = "${OUTPUT_NAME}";`) || !html.includes('new URL(DATA_FILE, pageDirectoryUrl)') || !html.includes('searchParams.set("_t"') || html.includes('location.protocol') || html.includes('type="file"') || html.includes('type="application/json"')) throw new Error("HTML 产物不符合同目录网络加载契约");
  return output;
}

async function main() {
  if (process.argv.length === 2) {
    process.stdout.write(`${JSON.stringify(await startLiveGate(DEFAULT_STATE_PATH, DEFAULT_LIVE_COLLECTION_PATH))}\n`);
    return;
  }
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return process.stdout.write(`${usage()}\n`);
  if (args.smokeTest) return smokeTest();
  if (args.selfTest) return selfTest();
  if (args.startLive) {
    process.stdout.write(`${JSON.stringify(await startLiveGate(args.state, args.startLive))}\n`);
    return;
  }
  if (args.collectLive) {
    const snapshot = await collectLiveSnapshot(args.state, args.collectLive);
    process.stdout.write(`${JSON.stringify(snapshot)}\n`);
    return;
  }
  if (args.state && !args.probeBase64 && !args.probePostId) return process.stdout.write(`${JSON.stringify(compactExistingState(args.state))}\n`);
  if (args.validateInput || args.validateInputBase64) {
    const inputText = readInputText(args.validateInput, args.validateInputBase64);
    process.stdout.write(`${JSON.stringify(validateSnapshot(JSON.parse(inputText)), null, 2)}\n`);
    return;
  }
  if (args.report) {
    process.stdout.write(renderMarkdownReport(verifyArtifactBundle(args.report), args.report));
    return;
  }
  if (args.backtest) {
    const inputText = args.backtest === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(path.resolve(args.backtest), "utf8");
    process.stdout.write(`${JSON.stringify(runBacktest(JSON.parse(inputText)), null, 2)}\n`);
    return;
  }
  if (args.renderExisting) {
    const output = migrateDisplayContract(JSON.parse(fs.readFileSync(args.renderExisting, "utf8")));
    validateOutput(output);
    writeAtomic(output, args.renderExisting);
    const htmlOutput = writeHtmlAtomic(output, args.renderExisting);
    const postResult = args.postUrl ? await postGeneratedJson(args.renderExisting, args.postUrl, args.postToken) : null;
    process.stdout.write(`${JSON.stringify({ status: output.status, output: args.renderExisting, html_output: htmlOutput, render_only: true, display_contract_migrated: true, post_result: postResult })}\n`);
    return;
  }
  if (args.probeBase64 || args.probePostId) {
    const collection = readLiveCollection(args.liveCollection);
    if (args.probePostId && String(args.probePostId) !== String(collection.probe_post?.post_id ?? "")) throw new Error("probe-post-id 必须使用实时完整性清单的 probe_post.post_id");
    if (args.probeCheckedAt && iso(args.probeCheckedAt, "probe.checked_at_utc") !== iso(collection.checked_at_utc, "live_collection.checked_at_utc")) throw new Error("probe-checked-at 必须使用实时完整性清单的 checked_at_utc");
    const rawProbe = args.probePostId ? {
      checked_at_utc: args.probeCheckedAt,
      latest_overall_post: { post_id: args.probePostId, published_at_utc: args.probePostAt, url: args.probePostUrl },
      sources: [{ name: "remote probe", url: args.probeSourceUrl, retrieved_at_utc: args.probeCheckedAt }],
    } : JSON.parse(readInputText(null, args.probeBase64));
    let result = runRefreshProbe(rawProbe, args.existing ?? args.state, args.output);
    const usingSeed = !(args.existing ?? args.state) || !fs.existsSync(args.existing ?? args.state);
    const existing = JSON.parse(usingSeed ? readBundledBaseline() : readUtf8NoBom(args.existing ?? args.state));
    const gaps = collectionGaps(collection, existing.current?.recent_tibo_posts);
    const mismatches = collectionMismatches(collection, existing.current?.recent_tibo_posts);
    if (gaps.length || mismatches.length) result = { action: "full_refresh", reason: gaps.length ? "collection_gap" : "collection_mismatch", missing_post_ids: gaps, mismatched_post_ids: mismatches, existing_post_id: result.existing_post_id ?? null, remote_post_id: collection.probe_post?.post_id ?? null, checked_at_utc: collection.checked_at_utc, wrote_files: false };
    if (args.postUrl) result.post_deferred = true;
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (!args.input && !args.inputOnce && !args.inputBase64 && !args.inputEnv) throw new Error("必须提供 --input、--input-once、--input-base64 或 --input-env");
  const inputText = args.inputOnce ? readInputOnce(args.inputOnce) : readInputText(args.input, args.inputBase64, args.inputEnv);
  const effectiveBaseHistory = args.baseHistory ?? (args.liveCollection && fs.existsSync(DEFAULT_STATE_PATH) ? DEFAULT_STATE_PATH : null);
  const rawInput = mergeBaseHistory(assertLiveAsOf(JSON.parse(inputText)), effectiveBaseHistory);
  assertLiveCollectionComplete(rawInput, args.liveCollection);
  const output = runForecast(rawInput);
  if (output.status === "blocked") {
    process.stdout.write(`${JSON.stringify({ status: "blocked", output: args.output, wrote_files: false, preserved_existing: hasUsableExistingForecast(args.output), blocked_reasons: output.blocked_reasons })}\n`);
    return;
  }
  writeAtomic(output, args.output);
  const htmlOutput = writeHtmlAtomic(output, args.output);
  fs.rmSync(args.liveCollection, { force: true });
  const postResult = args.postUrl ? await postGeneratedJson(args.output, args.postUrl, args.postToken) : null;
  if (args.printReport) {
    const verifiedOutput = verifyArtifactBundle(args.output);
    process.stdout.write(`${JSON.stringify({ status: verifiedOutput.status, output: args.output, html_output: htmlOutput, wrote_files: true, display_allowed: true, artifact_bundle_verified: true })}\n`);
    process.stdout.write(renderMarkdownReport(verifiedOutput, args.output));
    if (postResult) process.stdout.write(`\n提交：${postResult.url}（HTTP ${postResult.status}）\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({ status: output.status, output: args.output, html_output: htmlOutput, wrote_files: true, blocked_reasons: output.blocked_reasons, report_command: `node scripts/forecast.mjs --report "${args.output}"`, post_result: postResult })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
