#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const OUTPUT_NAME = "codex-reset-forecast.json";
const HTML_NAME = "codex.html";
const HTML_TEMPLATE = new URL("../assets/codex.html", import.meta.url);
const HORIZONS = [2, 4, 8, 12, 24, 72];
const LAMBDAS = [0.01, 0.1, 1, 10, 100];
const DECAYS = [12, 24, 48, 72];
const FEATURE_KEYS = [
  "log_hours_since_last_reset",
  "decayed_tibo_signal",
  "recent_incident",
  "recent_release_or_milestone",
  "utc_hour_sin",
  "utc_hour_cos",
];

function parseArgs(argv) {
  const args = { input: null, output: path.resolve(process.cwd(), OUTPUT_NAME), renderExisting: null, selfTest: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--input") args.input = argv[++i];
    else if (argv[i] === "--output") args.output = path.resolve(argv[++i]);
    else if (argv[i] === "--render-existing") args.renderExisting = path.resolve(argv[++i]);
    else if (argv[i] === "--self-test") args.selfTest = true;
    else throw new Error(`未知参数：${argv[i]}`);
  }
  return args;
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
    signal_level: Math.min(3, Math.max(0, Number(post?.signal_level ?? 0))),
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
    current: {
      cross_source_consistent: Boolean(input.current?.cross_source_consistent),
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

function latestBefore(items, time, field) {
  const limit = new Date(time).getTime();
  let latest = null;
  for (const item of items) {
    const itemTime = new Date(item[field]).getTime();
    if (itemTime <= limit && (!latest || itemTime > new Date(latest[field]).getTime())) latest = item;
  }
  return latest;
}

function featureVector(timeMs, lastResetMs, data, decayHours) {
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
    decayed_tibo_signal: signal ? signal.signal_level * Math.exp(-signalAge / decayHours) : 0,
    recent_incident: recentContexts.some((item) => item.context_type === "incident") ? 1 : 0,
    recent_release_or_milestone: recentContexts.some((item) => ["release", "milestone"].includes(item.context_type)) ? 1 : 0,
    utc_hour_sin: Math.sin((2 * Math.PI * hour) / 24),
    utc_hour_cos: Math.cos((2 * Math.PI * hour) / 24),
  };
}

function buildRows(events, data, decayHours, endAtMs = null) {
  const rows = [];
  for (let index = 0; index < events.length - 1; index += 1) {
    const startMs = new Date(events[index].announced_at_utc).getTime();
    const eventMs = new Date(events[index + 1].announced_at_utc).getTime();
    const stopMs = endAtMs == null ? eventMs : Math.min(eventMs, endAtMs);
    for (let timeMs = startMs + 3600_000; timeMs < stopMs; timeMs += 3600_000) {
      rows.push({
        timeMs,
        features: featureVector(timeMs, startMs, data, decayHours),
        y: 0,
      });
    }
    if (stopMs === eventMs) rows.push({ timeMs: eventMs, features: featureVector(eventMs, startMs, data, decayHours), y: 1 });
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
    const features = featureVector(timeMs, lastResetMs, data, model.decayHours ?? 24);
    const hazard = Math.min(0.999, Math.max(0.000001, predictHazard(model, features)));
    const before = survival;
    survival *= 1 - hazard;
    hourly.push({ hour, timeMs, hazard, windowProbability: before * hazard });
    if (HORIZONS.includes(hour)) points.push({ hour, timeMs, probability: 1 - survival });
  }
  return { points, hourly };
}

function signalSimilarity(signal, currentSignal) {
  const levelWeight = Math.exp(-0.8 * Math.abs(signal.signal_level - currentSignal.signal_level));
  const classWeight = signal.intent_class === currentSignal.intent_class ? 1
    : signal.intent_class === "explicit_commitment" || currentSignal.intent_class === "explicit_commitment" ? 0.25 : 0.55;
  return levelWeight * classWeight * signal.confidence;
}

function bayesianSignalAdjustment(points, data, currentSignal, asOfMs) {
  const priorStrength = 10;
  const currentAge = Math.max(0, (asOfMs - new Date(currentSignal.published_at_utc).getTime()) / 3600_000);
  let previous = 0;
  return points.map((point) => {
    let successWeight = 0;
    let failureWeight = 0;
    let exactCount = 0;
    let intervalCount = 0;
    let excludedBeforeCurrentAge = 0;
    for (const signal of data.signals) {
      if (signal.post_id === currentSignal.post_id || signal.signal_level <= 0) continue;
      const weight = signalSimilarity(signal, currentSignal);
      const lower = signal.latency_lower_hours;
      const upper = signal.latency_upper_hours;
      if (Number.isFinite(upper)) {
        if (upper <= currentAge) {
          excludedBeforeCurrentAge += 1;
          continue;
        }
        if (Number.isFinite(lower) && lower > currentAge + point.hour) failureWeight += weight;
        else if (upper <= currentAge + point.hour && (!Number.isFinite(lower) || lower > currentAge)) {
          successWeight += weight;
          if (signal.outcome_time_kind === "exact") exactCount += 1;
          else intervalCount += 1;
        }
        continue;
      }
      const observedHours = (new Date(signal.observation_end_at_utc).getTime() - new Date(signal.published_at_utc).getTime()) / 3600_000;
      if (observedHours >= currentAge + point.hour) failureWeight += weight;
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
        excluded_before_current_age_count: excludedBeforeCurrentAge,
      },
    };
  });
}

function brier(values) {
  if (!values.length) return null;
  return values.reduce((sum, item) => sum + (item.prediction - item.actual) ** 2, 0) / values.length;
}

function validateCandidate(events, data, featureKeys, lambda, decayHours) {
  const scores = Object.fromEntries([4, 24, 72].map((horizon) => [horizon, []]));
  const startIndex = Math.max(9, Math.floor(events.length * 0.5));
  let folds = 0;
  for (let origin = startIndex; origin < events.length - 1; origin += 1) {
    const trainingEvents = events.slice(0, origin + 1);
    const rows = buildRows(trainingEvents, data, decayHours);
    if (!rows.some((row) => row.y === 1)) continue;
    const model = fitLogistic(rows, featureKeys, lambda);
    model.decayHours = decayHours;
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
  const baselineKeys = ["log_hours_since_last_reset"];
  const fullKeys = FEATURE_KEYS;
  let best = null;
  const candidates = [];
  for (const variant of fullEligible ? ["baseline", "full"] : ["baseline"]) {
    for (const lambda of LAMBDAS) {
      for (const decayHours of variant === "full" ? DECAYS : [24]) {
        const featureKeys = variant === "full" ? fullKeys : baselineKeys;
        const validation = validateCandidate(events, data, featureKeys, lambda, decayHours);
        const candidate = { variant, lambda, decayHours, featureKeys, validation };
        candidates.push(candidate);
        if (!best || validation.objective < best.validation.objective) best = candidate;
      }
    }
  }
  const baselineBest = candidates.filter((item) => item.variant === "baseline").sort((a, b) => a.validation.objective - b.validation.objective)[0];
  const fullBest = candidates.filter((item) => item.variant === "full").sort((a, b) => a.validation.objective - b.validation.objective)[0] ?? null;
  if (fullBest && fullBest.validation.objective <= baselineBest.validation.objective) best = fullBest;
  else best = baselineBest;
  const rows = buildRows(events, data, best.decayHours);
  const model = fitLogistic(rows, best.featureKeys, best.lambda);
  model.decayHours = best.decayHours;
  return { best, baselineBest, model, rows };
}

function fixedCoefficients(model) {
  const result = {
    intercept: finiteOrNull(model?.beta?.[0]),
    log_hours_since_last_reset: null,
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

function buildConclusion(status, horizons, windows, factors, historyCount) {
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
      ? `贝叶斯信号校正模型基于 ${historyCount} 次确认重置及意图—结果配对生成结论。`
      : `当前采用贝叶斯小样本收缩：以基础生存概率为先验，仅让可比的 Tibo 意图—结果样本有限度地修正概率。`,
    reason_keys: factors.map((item) => item.feature_key),
  };
}

function modelOutputTemplate() {
  return {
    name: "bayesian_signal_adjusted_discrete_survival",
    version: "2.0.0",
    variant: "none",
    status: "blocked",
    formula: "P(reset≤h|survived to signal_age)=BetaPosterior(BaselineSurvival(h), matched Tibo intent→outcome pairs)",
    coefficients: fixedCoefficients(null),
    hyperparameters: { time_step_hours: 1, l2_lambda: null, signal_decay_hours: null },
    training: { sample_count: 0, positive_count: 0, negative_count: 0, start_at_utc: null, end_at_utc: null },
    validation: {
      method: "expanding_window",
      fold_count: 0,
      brier_score_4h: null,
      brier_score_24h: null,
      brier_score_72h: null,
      log_loss: null,
      calibration_error: null,
      baseline_brier_score_24h: null,
      passed: false,
    },
    signal_adjustment: {
      method: "time_conditioned_empirical_bayes_beta_binomial",
      prior_strength: 10,
      current_signal_post_id: null,
      current_signal_level: null,
      current_signal_intent_class: null,
      current_signal_age_hours: null,
      historical_intent_count: 0,
      exact_outcome_count: 0,
      interval_censored_outcome_count: 0,
      right_censored_count: 0,
      baseline_variant: null,
    },
  };
}

function buildBlockedOutput(input, reasons) {
  const asOf = input?.asOf ?? new Date().toISOString();
  const events = input?.events ?? [];
  const signals = input?.signals ?? [];
  return {
    schema_version: "1.5.0",
    file_name: OUTPUT_NAME,
    site: { file_name: HTML_NAME, data_path: `./${OUTPUT_NAME}`, language: "zh-CN", max_horizon_hours: 72, direct_file_supported: true, access_modes: ["file", "http", "https"], data_loading_priority: ["relative_json", "embedded_snapshot"] },
    generated_at_utc: asOf,
    generated_at_beijing: beijingIso(asOf),
    status: "blocked",
    blocked_reasons: reasons.map(String),
    sources: input?.sources ?? [],
    current: {
      as_of_utc: asOf,
      as_of_beijing: beijingIso(asOf),
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

  const unmatchedSignals = data.signals.filter((signal) => signal.signal_level > 0 && !signal.matched_reset_event_id).length;
  const fullEligible = events.length >= 25 && data.signals.length >= 10 && unmatchedSignals >= 3;
  const { best, baselineBest, model, rows } = selectModel(events, data, fullEligible);
  if (!model.converged) return buildBlockedOutput(data, ["生存回归没有收敛"]);
  const lastReset = events.at(-1);
  const lastResetMs = new Date(lastReset.announced_at_utc).getTime();
  const asOfMs = new Date(data.asOf).getTime();
  if (asOfMs < lastResetMs) return buildBlockedOutput(data, ["当前时间早于最近一次确认重置，存在数据倒退"]);
  const forecast = cumulativeForecast(model, data, lastResetMs, asOfMs);
  const currentSignal = data.signals.find((signal) => signal.post_id === data.current.latest_reset_signal?.post_id);
  if (!currentSignal) return buildBlockedOutput(data, ["最新重置信号未纳入意图—结果数据集，无法执行贝叶斯校正"]);
  const adjustedPoints = bayesianSignalAdjustment(forecast.points, data, currentSignal, asOfMs);
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
        model_basis: `基础离散时间生存模型先得到 ${(point.baselineProbability * 100).toFixed(1)}%；贝叶斯层再按当前信号等级、意图类型及“信号已持续 ${((asOfMs - new Date(currentSignal.published_at_utc).getTime()) / 3600_000).toFixed(1)} 小时仍未确认重置”这一条件，使用可比意图—结果样本校正为 ${displayProbability}%（变化 ${(point.signalDelta * 100).toFixed(1)} 个百分点，有效样本权重 ${point.posterior.effective_sample_count.toFixed(2)}）。`,
        llm_evidence_summary: context.llm_evidence_summary,
        supporting_factors: context.supporting_factors,
        counter_factors: context.counter_factors,
        cumulative_effect: `这是从模型计算时点到 +${point.hour}h 的累计概率，不是该小时的独立概率，也不会随浏览器当前时间自动平移。`,
        uncertainty: context.uncertainty,
        evidence_refs: context.evidence_refs,
      },
    };
  });
  const currentFeatures = featureVector(asOfMs + 3600_000, lastResetMs, data, best.decayHours);
  const validation = best.validation;
  const positives = rows.reduce((sum, row) => sum + row.y, 0);
  const status = best.variant === "full" ? "ok" : "degraded";
  const modelStatus = best.variant === "full" ? "trained" : "degraded";
  const windows = likelyWindows(forecast.hourly);
  const factors = explanationFactors(model, currentFeatures, data);
  const representativeSignalDelta = horizons.find((item) => item.horizon_hours === 24)?.signal_probability_delta ?? horizons.at(-1).signal_probability_delta;
  factors.push({
    feature_key: "tibo_intent_outcome_posterior",
    feature_value: representativeSignalDelta,
    direction: representativeSignalDelta > 0 ? "increase" : representativeSignalDelta < 0 ? "decrease" : "neutral",
    contribution_log_odds: 0,
    evidence_refs: data.sources.filter((source) => source.status === "ok").map((source) => source.evidence_ref),
    explanation: `当前为 ${currentSignal.intent_class}、等级 ${currentSignal.signal_level}，且已等待 ${((asOfMs - new Date(currentSignal.published_at_utc).getTime()) / 3600_000).toFixed(1)} 小时；贝叶斯层按历史意图—真实重置配对修正各预测范围。`,
  });
  return {
    schema_version: "1.5.0",
    file_name: OUTPUT_NAME,
    site: { file_name: HTML_NAME, data_path: `./${OUTPUT_NAME}`, language: "zh-CN", max_horizon_hours: 72, direct_file_supported: true, access_modes: ["file", "http", "https"], data_loading_priority: ["relative_json", "embedded_snapshot"] },
    generated_at_utc: data.asOf,
    generated_at_beijing: beijingIso(data.asOf),
    status,
    blocked_reasons: [],
    sources: data.sources,
    current: {
      as_of_utc: data.asOf,
      as_of_beijing: beijingIso(data.asOf),
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
      intervals: buildIntervals(events),
    },
    model: {
      ...modelOutputTemplate(),
      variant: "bayesian_signal_adjusted",
      status: modelStatus,
      coefficients: fixedCoefficients(model),
      hyperparameters: { time_step_hours: 1, l2_lambda: best.lambda, signal_decay_hours: best.variant === "full" ? best.decayHours : null },
      training: {
        sample_count: rows.length,
        positive_count: positives,
        negative_count: rows.length - positives,
        start_at_utc: events[0].announced_at_utc,
        end_at_utc: events.at(-1).announced_at_utc,
      },
      validation: {
        method: "expanding_window",
        fold_count: validation.folds,
        brier_score_4h: finiteOrNull(validation.metrics[4]),
        brier_score_24h: finiteOrNull(validation.metrics[24]),
        brier_score_72h: finiteOrNull(validation.metrics[72]),
        log_loss: null,
        calibration_error: null,
        baseline_brier_score_24h: finiteOrNull(baselineBest.validation.metrics[24]),
        passed: validation.folds > 0 && Number.isFinite(validation.objective),
      },
      signal_adjustment: {
        method: "time_conditioned_empirical_bayes_beta_binomial",
        prior_strength: 10,
        current_signal_post_id: currentSignal.post_id,
        current_signal_level: currentSignal.signal_level,
        current_signal_intent_class: currentSignal.intent_class,
        current_signal_age_hours: Number(((asOfMs - new Date(currentSignal.published_at_utc).getTime()) / 3600_000).toFixed(3)),
        historical_intent_count: data.signals.filter((item) => item.post_id !== currentSignal.post_id && item.signal_level > 0).length,
        exact_outcome_count: data.signals.filter((item) => item.outcome_time_kind === "exact").length,
        interval_censored_outcome_count: data.signals.filter((item) => item.outcome_time_kind === "interval_censored").length,
        right_censored_count: data.signals.filter((item) => item.outcome_time_kind === "right_censored").length,
        baseline_variant: best.variant,
      },
    },
    forecast: {
      horizons,
      most_likely_windows: windows,
    },
    conclusion: buildConclusion(status, horizons, windows, factors, events.length),
    explanation: {
      summary: "先由离散时间生存回归计算历史基准概率，再以贝叶斯小样本模型按 Tibo 意图等级、承诺窗口、真实落地时间和当前等待时长进行收缩校正；LLM 只解释证据。",
      factors,
      limitations: ["Tibo 意图—结果配对样本仍少，区间时间只按区间删失处理，可信区间使用正态近似；因此信号校正会强烈向历史基准收缩。"],
      risk_notice: "这是根据公开历史记录建立的统计模型，不是 OpenAI 官方时间表。",
    },
  };
}

function validateOutput(output) {
  const requiredTop = ["schema_version", "file_name", "site", "generated_at_utc", "generated_at_beijing", "status", "blocked_reasons", "sources", "current", "history", "model", "forecast", "conclusion", "explanation"];
  for (const key of requiredTop) if (!(key in output)) throw new Error(`输出缺少固定 key：${key}`);
  if (output.file_name !== OUTPUT_NAME) throw new Error("输出文件名契约不一致");
  if (output.site?.file_name !== HTML_NAME || output.site?.data_path !== `./${OUTPUT_NAME}` || output.site?.max_horizon_hours !== 72 || output.site?.direct_file_supported !== true || JSON.stringify(output.site?.access_modes) !== JSON.stringify(["file", "http", "https"]) || JSON.stringify(output.site?.data_loading_priority) !== JSON.stringify(["relative_json", "embedded_snapshot"])) throw new Error("静态网站契约不一致");
  if (!new Set(["ok", "degraded", "blocked"]).has(output.status)) throw new Error("status 枚举无效");
  if (!Array.isArray(output.history.events) || !Array.isArray(output.history.signals) || !Array.isArray(output.history.intervals)) throw new Error("history 数组结构无效");
  const signalKeys = ["post_id", "published_at_utc", "url", "text", "signal_level", "intent_class", "has_explicit_timing", "promised_window_end_at_utc", "outcome_status", "outcome_time_kind", "reset_at_utc", "latency_lower_hours", "latency_upper_hours", "observation_end_at_utc", "confidence", "classification_evidence", "matched_reset_event_id", "hours_to_reset", "reset_within_4h", "reset_within_24h", "reset_within_72h"];
  for (const signal of output.history.signals) {
    if (JSON.stringify(Object.keys(signal)) !== JSON.stringify(signalKeys)) throw new Error("历史意图—结果记录固定 key 不一致");
    if (!new Set(["weak_mention", "directional_reset", "explicit_commitment"]).has(signal.intent_class)) throw new Error("历史信号 intent_class 无效");
    if (!new Set(["exact", "interval_censored", "right_censored"]).has(signal.outcome_time_kind)) throw new Error("历史信号 outcome_time_kind 无效");
  }
  if (output.status !== "blocked" && (output.model.name !== "bayesian_signal_adjusted_discrete_survival" || output.model.variant !== "bayesian_signal_adjusted" || output.model.signal_adjustment?.method !== "time_conditioned_empirical_bayes_beta_binomial")) throw new Error("贝叶斯模型输出契约不一致");
  if (!Array.isArray(output.current.recent_tibo_posts)) throw new Error("近期 Tibo 动态结构无效");
  if (output.status !== "blocked" && (output.current.recent_tibo_posts.length < 3 || output.current.recent_tibo_posts.length > 6)) throw new Error("近期 Tibo 动态数量必须为 3—6 条");
  const recentPostKeys = ["post_id", "published_at_utc", "url", "text_original", "text_zh", "translation_method", "post_type", "signal_level", "classification_evidence", "is_latest_overall", "is_latest_reset_signal"];
  for (const post of output.current.recent_tibo_posts) {
    if (JSON.stringify(Object.keys(post)) !== JSON.stringify(recentPostKeys)) throw new Error("近期 Tibo 动态固定 key 不一致");
    if (!post.text_original || !post.text_zh || post.translation_method !== "chatgpt") throw new Error("近期 Tibo 动态双语内容不完整");
    if (!new Set(["reset_signal", "codex", "limits", "release", "other"]).has(post.post_type)) throw new Error("近期 Tibo 动态类型无效");
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
    if (!Number.isFinite(row.baseline_probability) || !Number.isFinite(row.signal_probability_delta) || !row.signal_posterior) throw new Error("贝叶斯信号校正字段不完整");
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

function readEmbeddedOutput(html) {
  const match = html.match(/<script type="application\/json" id="embedded-forecast-data">([\s\S]*?)<\/script>/);
  if (!match) throw new Error("HTML 缺少内置预测快照");
  return JSON.parse(match[1]);
}

function writeHtmlAtomic(output, outputPath) {
  const directory = path.dirname(outputPath);
  const target = path.join(directory, HTML_NAME);
  const temporary = path.join(directory, `.${HTML_NAME}.tmp`);
  const template = fs.readFileSync(HTML_TEMPLATE, "utf8");
  if (!template.includes(`const DATA_PATH = "./${OUTPUT_NAME}";`) || !template.includes('lang="zh-CN"') || !template.includes("__CODEX_FORECAST_JSON__")) throw new Error("HTML 模板不符合相对数据路径、中文或内置快照契约");
  const embedded = JSON.stringify(output).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  const html = template.replace("__CODEX_FORECAST_JSON__", embedded);
  if (html.includes("__CODEX_FORECAST_JSON__")) throw new Error("HTML 内置快照替换失败");
  fs.writeFileSync(temporary, html, { encoding: "utf8" });
  const embeddedOutput = readEmbeddedOutput(fs.readFileSync(temporary, "utf8"));
  validateOutput(embeddedOutput);
  if (JSON.stringify(embeddedOutput) !== JSON.stringify(output)) throw new Error("HTML 内置快照与 JSON 输出不一致");
  fs.renameSync(temporary, target);
  return target;
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
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  process.stdout.write("forecast self-test passed\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) return selfTest();
  if (args.renderExisting) {
    const output = JSON.parse(fs.readFileSync(args.renderExisting, "utf8"));
    validateOutput(output);
    const htmlOutput = writeHtmlAtomic(output, args.renderExisting);
    process.stdout.write(`${JSON.stringify({ status: output.status, output: args.renderExisting, html_output: htmlOutput, render_only: true })}\n`);
    return;
  }
  if (!args.input) throw new Error("必须提供 --input <remote-snapshot.json>");
  const inputText = args.input === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(path.resolve(args.input), "utf8");
  const rawInput = JSON.parse(inputText);
  const output = runForecast(rawInput);
  writeAtomic(output, args.output);
  const htmlOutput = writeHtmlAtomic(output, args.output);
  process.stdout.write(`${JSON.stringify({ status: output.status, output: args.output, html_output: htmlOutput, blocked_reasons: output.blocked_reasons })}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
}
