#!/usr/bin/env node

import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

const OUTPUT_NAME = "codex-reset-forecast.json";
const HTML_NAME = "codex.html";
const HTML_TEMPLATE = new URL("../assets/codex.html", import.meta.url);
const LOCAL_SERVER_NAME = "codex-local-server.mjs";
const LOCAL_SERVER_TEMPLATE = new URL(`../assets/${LOCAL_SERVER_NAME}`, import.meta.url);
const LOCAL_LAUNCHER_NAME = "open-codex.cmd";
const LOCAL_LAUNCHER_TEMPLATE = new URL(`../assets/${LOCAL_LAUNCHER_NAME}`, import.meta.url);
const HORIZONS = [2, 4, 8, 12, 24, 72];
const LAMBDAS = [0.01, 0.1, 1, 10, 100];
const DECAYS = [12, 24, 48, 72];
const DEFAULT_WORK_TIMEZONE = "America/Los_Angeles";
const SIGNAL_PRIOR_STRENGTH = 1;
const SCHEMA_VERSION = "1.8.1";
const MODEL_VERSION = "3.1.0";
const REUSE_MAX_AGE_MINUTES = 20;
const FULL_REFRESH_MAX_AGE_HOURS = 24;
const COOLDOWN_HOUR_CANDIDATES = [6, 12, 24];
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
  const args = { input: null, inputBase64: null, probeBase64: null, existing: null, backtest: null, output: path.resolve(process.cwd(), OUTPUT_NAME), renderExisting: null, postUrl: null, selfTest: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--input") args.input = argv[++i];
    else if (argv[i] === "--input-base64") args.inputBase64 = argv[++i];
    else if (argv[i] === "--probe-base64") args.probeBase64 = argv[++i];
    else if (argv[i] === "--existing") args.existing = path.resolve(argv[++i]);
    else if (argv[i] === "--backtest") args.backtest = argv[++i];
    else if (argv[i] === "--output") args.output = path.resolve(argv[++i]);
    else if (argv[i] === "--render-existing") args.renderExisting = path.resolve(argv[++i]);
    else if (argv[i] === "--post-url") args.postUrl = argv[++i];
    else if (argv[i] === "--self-test") args.selfTest = true;
    else throw new Error(`未知参数：${argv[i]}`);
  }
  return args;
}

function readInputText(inputPath, base64Source = null) {
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
  return {
    post_id: String(post?.post_id ?? ""),
    published_at_utc: iso(post?.published_at_utc, "recent_tibo_post.published_at_utc"),
    url: String(post?.url ?? ""),
    text_original: String(post?.text_original ?? post?.text ?? ""),
    text_zh: String(post?.text_zh ?? ""),
    translation_method: String(post?.translation_method ?? "chatgpt"),
    post_type: String(post?.post_type ?? "other"),
    signal_level: Math.min(4, Math.max(0, Number(post?.signal_level ?? 0))),
    classification_evidence: String(post?.classification_evidence ?? ""),
    is_latest_overall: Boolean(post?.is_latest_overall),
    is_latest_reset_signal: Boolean(post?.is_latest_reset_signal),
  };
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
  const asOf = iso(input.current?.as_of_utc, "current.as_of_utc");
  const sources = Array.isArray(input.sources) ? input.sources.map((source) => ({
    source_id: String(source.source_id ?? ""),
    name: String(source.name ?? ""),
    url: String(source.url ?? ""),
    retrieved_at_utc: iso(source.retrieved_at_utc, "source.retrieved_at_utc"),
    retrieval_method: String(source.retrieval_method ?? ""),
    status: String(source.status ?? "failed"),
    fresh: Boolean(source.fresh),
    evidence_ref: String(source.evidence_ref ?? ""),
  })) : [];
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
  const signals = (Array.isArray(input.historical_signals) ? input.historical_signals : []).map((signal) => ({
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
  })).sort((a, b) => new Date(a.published_at_utc) - new Date(b.published_at_utc));
  const contexts = (Array.isArray(input.historical_contexts) ? input.historical_contexts : []).map((context) => ({
    context_id: String(context.context_id ?? ""),
    context_type: String(context.context_type ?? ""),
    occurred_at_utc: iso(context.occurred_at_utc, "context.occurred_at_utc"),
    source_url: String(context.source_url ?? ""),
  })).sort((a, b) => new Date(a.occurred_at_utc) - new Date(b.occurred_at_utc));
  const seenRecentPosts = new Set();
  const recentPosts = (Array.isArray(input.current?.recent_tibo_posts) ? input.current.recent_tibo_posts : [])
    .map(normalizeRecentPost)
    .sort((a, b) => new Date(b.published_at_utc) - new Date(a.published_at_utc))
    .filter((post) => post.post_id && !seenRecentPosts.has(post.post_id) && seenRecentPosts.add(post.post_id))
    .slice(0, 6);
  const horizonReasoning = (Array.isArray(input.reasoning_context?.horizons) ? input.reasoning_context.horizons : [])
    .map(normalizeHorizonReasoning)
    .sort((a, b) => a.horizon_hours - b.horizon_hours);
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
      cached_history_verified: false,
    },
    current: {
      cross_source_consistent: Boolean(input.current?.cross_source_consistent),
      tibo_work_timezone: String(input.current?.tibo_work_timezone ?? DEFAULT_WORK_TIMEZONE),
      latest_overall_post: normalizePost(input.current?.latest_overall_post),
      latest_reset_signal: normalizePost(input.current?.latest_reset_signal),
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

function refreshFingerprintPayload({ latestOverallPost, latestResetSignal, lastResetEventId, lastResetAt, statusIndicator, activeIncidentId }) {
  return {
    schema_version: SCHEMA_VERSION,
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
        if (upper <= targetAge) {
          successWeight += weight;
          if (signal.outcome_time_kind === "exact") exactCount += 1;
          else intervalCount += 1;
        } else if (Number.isFinite(lower) && lower > targetAge) failureWeight += weight;
        else unavailableCount += 1;
        continue;
      }
      const observedHours = (new Date(signal.observation_end_at_utc).getTime() - new Date(signal.published_at_utc).getTime()) / 3600_000;
      if (observedHours >= targetAge) failureWeight += weight;
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

function buildConclusion(status, horizons, windows, factors, historyCount, hasActiveSignal = true) {
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
    confidence_explanation: status === "ok"
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
  const validSources = data.sources.filter((source) => source.status === "ok" && source.fresh && allowedMethods.has(source.retrieval_method));
  if (validSources.length < 2) reasons.push("至少需要两个新鲜且由 ChatGPT/Codex 远程能力抓取的来源");
  if (!data.current.cross_source_consistent) reasons.push("Tibo 最新总体动态未通过独立第二来源核验");
  if (!data.current.latest_overall_post) reasons.push("缺少 Tibo 最新总体动态");
  if (data.current.recent_tibo_posts.length < 3) reasons.push("至少需要 3 条近期 Tibo 总体动态用于页面展示");
  if (data.current.recent_tibo_posts.some((post) => !post.text_original.trim() || !post.text_zh.trim() || post.translation_method !== "chatgpt")) reasons.push("近期 Tibo 动态缺少英文原文、中文翻译或 ChatGPT 翻译标记");
  if (data.current.recent_tibo_posts[0]?.post_id !== data.current.latest_overall_post?.post_id || !data.current.recent_tibo_posts[0]?.is_latest_overall) reasons.push("近期 Tibo 动态首条与最新总体动态不一致");
  if (JSON.stringify(data.horizonReasoning.map((item) => item.horizon_hours)) !== JSON.stringify(HORIZONS)) reasons.push("LLM 逐预测范围证据解读必须完整覆盖固定预测节点");
  if (data.horizonReasoning.some((item) => !item.llm_evidence_summary.trim() || !item.uncertainty.trim() || !item.supporting_factors.length || !item.counter_factors.length || !item.evidence_refs.length)) reasons.push("LLM 逐预测范围证据解读缺少摘要、支持因素、反向因素、不确定性或证据引用");
  const knownEvidenceRefs = new Set(data.sources.map((source) => source.evidence_ref));
  if (data.horizonReasoning.some((item) => item.evidence_refs.some((ref) => !knownEvidenceRefs.has(ref)))) reasons.push("LLM 逐预测范围证据解读包含未知证据引用");
  for (const source of validSources) {
    const ageMinutes = (new Date(data.asOf) - new Date(source.retrieved_at_utc)) / 60_000;
    if (ageMinutes < -5 || ageMinutes > 20) reasons.push(`来源 ${source.source_id} 的抓取时间不在 20 分钟新鲜度窗口内`);
  }
  return reasons;
}

function runForecast(rawInput) {
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
  const forecast = cumulativeForecast(model, data, lastResetMs, asOfMs);
  const latestSignalRecord = data.signals.find((signal) => signal.post_id === data.current.latest_reset_signal?.post_id) ?? null;
  const currentSignal = latestSignalRecord && !latestSignalRecord.matched_reset_event_id && latestSignalRecord.outcome_time_kind === "right_censored" ? latestSignalRecord : null;
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
  const status = validation.passed && currentSignal ? "ok" : "degraded";
  const modelStatus = validation.passed && currentSignal ? "trained" : "degraded";
  const adjustedHourly = currentSignal
    ? adjustedHourlyForecast(forecast.hourly, adjustedPoints, data, currentSignal, asOfMs)
    : worktimeHourlyForecast(forecast.hourly, adjustedPoints, data);
  const windows = likelyWindows(adjustedHourly);
  const factors = explanationFactors(model, currentFeatures, data);
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
    conclusion: buildConclusion(status, horizons, windows, factors, events.length, Boolean(currentSignal)),
    explanation: {
      summary: "以 Tibo 信号等级和历史信号—重置延迟为主模型；等级 4 只表示已完成，重置后冷却与历史间隔形成弱基线，再按当地工作时段分配具体小时概率；LLM 只解释证据。",
      factors,
      limitations: ["Tibo 意图—结果配对样本仍少，部分落地时间为区间删失；工作时段使用配置时区与历史小时分布，不以国籍直接推定。"],
      risk_notice: "这是根据公开历史记录建立的统计模型，不是 OpenAI 官方时间表。",
    },
  };
}

function validateOutput(output) {
  const requiredTop = ["schema_version", "file_name", "site", "generated_at_utc", "generated_at_beijing", "status", "blocked_reasons", "refresh", "sources", "current", "history", "model", "forecast", "conclusion", "explanation"];
  for (const key of requiredTop) if (!(key in output)) throw new Error(`输出缺少固定 key：${key}`);
  if (output.file_name !== OUTPUT_NAME) throw new Error("输出文件名契约不一致");
  if (output.site?.file_name !== HTML_NAME || output.site?.data_path !== `./${OUTPUT_NAME}` || output.site?.local_launcher !== `./${LOCAL_LAUNCHER_NAME}` || output.site?.local_server !== `./${LOCAL_SERVER_NAME}` || output.site?.max_horizon_hours !== 72 || output.site?.direct_file_supported !== false || JSON.stringify(output.site?.access_modes) !== JSON.stringify(["local_http", "http", "https"]) || JSON.stringify(output.site?.data_loading_priority) !== JSON.stringify(["current_page_directory_json", "http_cache_bust"])) throw new Error("静态网站契约不一致");
  if (!new Set(["ok", "degraded", "blocked"]).has(output.status)) throw new Error("status 枚举无效");
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
  if (output.status !== "blocked" && (output.current.recent_tibo_posts.length < 3 || output.current.recent_tibo_posts.length > 6)) throw new Error("近期 Tibo 动态数量必须为 3—6 条");
  const recentPostKeys = ["post_id", "published_at_utc", "url", "text_original", "text_zh", "translation_method", "post_type", "signal_level", "classification_evidence", "is_latest_overall", "is_latest_reset_signal"];
  for (const post of output.current.recent_tibo_posts) {
    if (JSON.stringify(Object.keys(post)) !== JSON.stringify(recentPostKeys)) throw new Error("近期 Tibo 动态固定 key 不一致");
    if (!post.text_original || !post.text_zh || post.translation_method !== "chatgpt") throw new Error("近期 Tibo 动态双语内容不完整");
    if (!new Set(["reset_signal", "codex", "limits", "release", "other"]).has(post.post_type)) throw new Error("近期 Tibo 动态类型无效");
    if (post.signal_level < 0 || post.signal_level > 4) throw new Error("近期 Tibo 动态等级必须为 0—4");
  }
  const latestResetPost = output.current.recent_tibo_posts.find((post) => post.is_latest_reset_signal);
  if (latestResetPost && output.current.latest_reset_signal && latestResetPost.post_id === output.current.latest_reset_signal.post_id && latestResetPost.signal_level !== output.current.latest_reset_signal.signal_level) throw new Error("最新重置相关动态等级在当前对象和近期列表中不一致");
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

async function postGeneratedJson(outputPath, postUrl) {
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
      headers: { "Content-Type": "application/json; charset=utf-8", Accept: "application/json" },
      body,
      redirect: "error",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw new Error(`JSON POST 提交失败：HTTP ${response.status}`);
  return { url: target.href, status: response.status, content_type: response.headers.get("content-type") };
}

function migrateDisplayContract(output) {
  return {
    ...output,
    schema_version: SCHEMA_VERSION,
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
  const checkedAt = iso(rawProbe?.checked_at_utc, "probe.checked_at_utc");
  const sources = Array.isArray(rawProbe?.sources) ? rawProbe.sources.map((source) => ({
    source_id: String(source.source_id ?? ""), name: String(source.name ?? ""), url: String(source.url ?? ""),
    retrieved_at_utc: iso(source.retrieved_at_utc, "probe.source.retrieved_at_utc"),
    retrieval_method: String(source.retrieval_method ?? ""), status: String(source.status ?? "failed"),
    fresh: Boolean(source.fresh), evidence_ref: String(source.evidence_ref ?? ""),
  })) : [];
  return {
    checkedAt,
    sources,
    latestOverallPost: rawProbe?.latest_overall_post ?? null,
    latestResetSignal: rawProbe?.latest_reset_signal ?? null,
    lastResetEventId: rawProbe?.last_confirmed_reset?.event_id == null ? null : String(rawProbe.last_confirmed_reset.event_id),
    lastResetAt: rawProbe?.last_confirmed_reset?.announced_at_utc ? iso(rawProbe.last_confirmed_reset.announced_at_utc, "probe.last_confirmed_reset.announced_at_utc") : null,
    statusIndicator: rawProbe?.status_indicator == null ? null : String(rawProbe.status_indicator),
    activeIncidentId: rawProbe?.active_incident_id == null ? null : String(rawProbe.active_incident_id),
  };
}

function probeFailure(reason) {
  return { action: "full_refresh", reason, wrote_files: false };
}

function runRefreshProbe(rawProbe, existingPath, outputPath) {
  void rawProbe;
  void existingPath;
  void outputPath;
  return probeFailure("指纹短路已停用；每次执行都必须继续完整刷新流程");
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
  const start = Date.parse("2026-01-01T00:00:00Z");
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
  return {
    current: {
      as_of_utc: asOf,
      cross_source_consistent: true,
      latest_overall_post: { post_id: "latest", published_at_utc: asOf, url: "https://example.com/latest", text: "hello", signal_level: 0, classification_evidence: "none" },
      latest_reset_signal: signals.at(-1),
      recent_tibo_posts: Array.from({ length: 6 }, (_, index) => ({
        post_id: index === 0 ? "latest" : `recent-${index}`,
        published_at_utc: new Date(new Date(asOf).getTime() - index * 3600_000).toISOString(),
        url: `https://example.com/recent-${index}`,
        text_original: `Recent post ${index}`,
        text_zh: `近期动态 ${index}`,
        translation_method: "chatgpt",
        post_type: index === 1 ? "reset_signal" : "other",
        signal_level: index === 1 ? 2 : 0,
        classification_evidence: index === 1 ? "mentions reset" : "none",
        is_latest_overall: index === 0,
        is_latest_reset_signal: index === 1,
      })),
    },
    sources: ["one", "two"].map((id) => ({ source_id: id, name: id, url: `https://example.com/${id}`, retrieved_at_utc: asOf, retrieval_method: "chatgpt_remote_web_search", status: "ok", fresh: true, evidence_ref: `source:${id}` })),
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
  if (normalizeRecentPost({ post_id: "done", published_at_utc: new Date().toISOString(), signal_level: 4 }).signal_level !== 4) throw new Error("自检已完成重置等级 4 被错误降级");
  const output = runForecast(syntheticInput());
  validateOutput(output);
  if (output.status === "blocked") throw new Error(`自检被意外阻断：${output.blocked_reasons.join("；")}`);
  if (output.history.confirmed_reset_count !== 30) throw new Error("自检历史事件数量不正确");
  if (output.forecast.horizons.length !== HORIZONS.length || output.forecast.horizons.at(-1)?.horizon_hours !== 72) throw new Error("自检预测范围超过 72 小时");
  if (output.conclusion.primary_horizon_hours == null || !output.conclusion.headline.includes("重置概率")) throw new Error("自检结论结构不正确");
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
  if (!fs.existsSync(htmlTarget)) throw new Error("自检未生成固定 HTML 文件");
  if (!fs.existsSync(path.join(temporaryDirectory, LOCAL_SERVER_NAME)) || !fs.existsSync(path.join(temporaryDirectory, LOCAL_LAUNCHER_NAME))) throw new Error("自检未生成本地启动文件");
  const html = fs.readFileSync(htmlTarget, "utf8");
  if (html.includes("embedded-forecast-data") || html.includes('type="application/json"') || html.includes('type="file"') || html.includes('location.protocol') || !html.includes('new URL("./", location.href)') || !html.includes('new URL(DATA_FILE, pageDirectoryUrl)') || !html.includes('searchParams.set("_t"')) throw new Error("自检 HTML 纯网络同目录加载契约失败");
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
  if (probeResult.action !== "full_refresh" || probeResult.wrote_files || !probeResult.reason.includes("指纹短路已停用")) throw new Error("自检未强制进入完整刷新路径");
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  process.stdout.write("forecast self-test passed\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) return selfTest();
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
    const postResult = args.postUrl ? await postGeneratedJson(args.renderExisting, args.postUrl) : null;
    process.stdout.write(`${JSON.stringify({ status: output.status, output: args.renderExisting, html_output: htmlOutput, render_only: true, display_contract_migrated: true, post_result: postResult })}\n`);
    return;
  }
  if (args.probeBase64) {
    const rawProbe = JSON.parse(readInputText(null, args.probeBase64));
    const result = runRefreshProbe(rawProbe, args.existing, args.output);
    if (args.postUrl) result.post_deferred = true;
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (!args.input && !args.inputBase64) throw new Error("必须提供 --input <remote-snapshot.json> 或 --input-base64 <base64|->");
  const inputText = readInputText(args.input, args.inputBase64);
  const rawInput = JSON.parse(inputText);
  const output = runForecast(rawInput);
  writeAtomic(output, args.output);
  const htmlOutput = writeHtmlAtomic(output, args.output);
  const postResult = args.postUrl ? await postGeneratedJson(args.output, args.postUrl) : null;
  process.stdout.write(`${JSON.stringify({ status: output.status, output: args.output, html_output: htmlOutput, blocked_reasons: output.blocked_reasons, post_result: postResult })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
