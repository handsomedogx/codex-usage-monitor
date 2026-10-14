use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use crate::pricing::PriceTable;
use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, NaiveDateTime, TimeZone, Timelike};
use regex::Regex;
use serde_json::{json, Map, Value};
use uuid::Uuid;

const SIGNATURE_KEYS: [&str; 6] = [
    "input_tokens",
    "cached_input_tokens",
    "cache_read_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
];

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Tokens {
    input: u64,
    cached: u64,
    output: u64,
}

impl Tokens {
    fn max(self, other: Self) -> Self {
        Self {
            input: self.input.max(other.input),
            cached: self.cached.max(other.cached),
            output: self.output.max(other.output),
        }
    }

    fn delta_from(self, previous: Self) -> Self {
        Self {
            input: self.input.saturating_sub(previous.input),
            cached: self.cached.saturating_sub(previous.cached),
            output: self.output.saturating_sub(previous.output),
        }
    }

    fn is_zero(self) -> bool {
        self.input == 0 && self.cached == 0 && self.output == 0
    }
}

#[derive(Clone, Debug, PartialEq)]
struct Signature {
    total: Option<Vec<Value>>,
    last: Option<Vec<Value>>,
}

#[derive(Clone, Debug)]
struct TokenEvent {
    signature: Signature,
    delta: Tokens,
    event_index: Option<u64>,
    model: String,
    timestamp: Option<i64>,
}

#[derive(Debug)]
struct ParsedRollout {
    path: PathBuf,
    session_id: String,
    rollout_id: String,
    model_provider: String,
    root_meta_seen: bool,
    root_timestamp: Option<i64>,
    parent_id: Option<String>,
    history_base_id: Option<String>,
    parent_error: Option<String>,
    token_events: Vec<TokenEvent>,
}

impl ParsedRollout {
    fn has_billable_tokens(&self) -> bool {
        self.token_events
            .iter()
            .any(|event| event.event_index.is_some())
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct Usage {
    input: u64,
    cached: u64,
    output: u64,
    requests: u64,
}

impl Usage {
    fn add(&mut self, tokens: Tokens) {
        self.input = self.input.saturating_add(tokens.input);
        self.cached = self.cached.saturating_add(tokens.cached);
        self.output = self.output.saturating_add(tokens.output);
        self.requests = self.requests.saturating_add(1);
    }

    fn total(self) -> u64 {
        self.input.saturating_add(self.output)
    }
}

pub fn analyze(
    codex_home: &str,
    days: i32,
    from_timestamp: Option<i64>,
    to_timestamp: Option<i64>,
    prices: &PriceTable,
) -> Result<Value, String> {
    let codex_home = PathBuf::from(codex_home);
    if !codex_home.is_dir() {
        return Err(format!(
            "Codex directory not found:\n{}",
            codex_home.display()
        ));
    }

    let rollout_name = Regex::new(
        r"(?i)rollout-.*?-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))?\.jsonl$",
    )
    .map_err(|error| error.to_string())?;
    let dated_model_suffix =
        Regex::new(r"-(?:\d{4}-\d{2}-\d{2}|\d{8})$").map_err(|error| error.to_string())?;

    let to_timestamp = to_timestamp.unwrap_or_else(|| Local::now().timestamp());
    let from_timestamp = range_start_timestamp(days, to_timestamp, from_timestamp);
    let grain = timeline_grain(days);

    let files = find_rollouts(&codex_home);
    let mut parsed_rollouts = Vec::new();
    let mut parse_errors = Vec::new();
    for path in &files {
        match parse_rollout(path, &rollout_name, &dated_model_suffix) {
            Ok(Some(rollout)) => parsed_rollouts.push(rollout),
            Ok(None) => {}
            Err(error) => parse_errors.push(format!("{}: {error}", path.display())),
        }
    }

    let mut rollout_index: HashMap<String, Vec<usize>> = HashMap::new();
    for (index, rollout) in parsed_rollouts.iter().enumerate() {
        rollout_index
            .entry(rollout.session_id.clone())
            .or_default()
            .push(index);
    }

    let mut totals = Usage::default();
    let mut by_model: HashMap<String, Usage> = HashMap::new();
    let mut by_provider: HashMap<String, Usage> = HashMap::new();
    let mut by_provider_model: HashMap<(String, String), Usage> = HashMap::new();
    let mut timeline_usage: HashMap<i64, Usage> = HashMap::new();
    let mut timeline_official_cost: HashMap<i64, f64> = HashMap::new();
    let mut timeline_custom_reference_cost: HashMap<i64, f64> = HashMap::new();
    let mut seen_requests = HashSet::new();
    let mut deferred_files = Vec::new();
    let mut replay_events_skipped = 0_u64;
    let mut duplicate_requests_skipped = 0_u64;

    for rollout in &parsed_rollouts {
        if !rollout.has_billable_tokens() {
            continue;
        }
        if !rollout.root_meta_seen {
            deferred_files.push(json!({
                "path": rollout.path.to_string_lossy(),
                "reason": "billable rollout has no session_meta",
            }));
            continue;
        }

        let (replay_prefix, deferred_reason) =
            resolve_replay_prefix(rollout, &rollout_index, &parsed_rollouts);
        if let Some(reason) = deferred_reason {
            deferred_files.push(json!({
                "path": rollout.path.to_string_lossy(),
                "reason": reason,
            }));
            continue;
        }

        for (token_offset, token_event) in rollout.token_events.iter().enumerate() {
            if token_offset < replay_prefix {
                if token_event.event_index.is_some() {
                    replay_events_skipped = replay_events_skipped.saturating_add(1);
                }
                continue;
            }
            let Some(event_index) = token_event.event_index else {
                continue;
            };

            let request_id = format!("{}:{event_index}", rollout.session_id);
            if !seen_requests.insert(request_id) {
                duplicate_requests_skipped = duplicate_requests_skipped.saturating_add(1);
                continue;
            }

            let timestamp = token_event.timestamp.unwrap_or(0);
            if timestamp < from_timestamp || timestamp > to_timestamp {
                continue;
            }

            let tokens = token_event.delta;
            let provider = rollout.model_provider.as_str();
            let model = token_event.model.as_str();
            totals.add(tokens);
            by_model.entry(model.to_string()).or_default().add(tokens);
            by_provider
                .entry(provider.to_string())
                .or_default()
                .add(tokens);
            by_provider_model
                .entry((provider.to_string(), model.to_string()))
                .or_default()
                .add(tokens);

            let bucket = timeline_bucket(timestamp, grain);
            timeline_usage.entry(bucket).or_default().add(tokens);
            if let Some(cost) = estimated_cost(
                prices,
                model,
                Usage {
                    input: tokens.input,
                    cached: tokens.cached,
                    output: tokens.output,
                    requests: 1,
                },
            ) {
                let target = if provider == "openai" {
                    &mut timeline_official_cost
                } else {
                    &mut timeline_custom_reference_cost
                };
                *target.entry(bucket).or_default() += cost;
            }
        }
    }

    let mut equivalent_cost_by_provider: HashMap<String, f64> = HashMap::new();
    let mut unknown_price_models = Vec::new();
    let mut provider_model_entries: Vec<_> = by_provider_model.into_iter().collect();
    provider_model_entries.sort_by_key(|entry| std::cmp::Reverse(entry.1.total()));
    let provider_model_rows: Vec<Value> = provider_model_entries
        .into_iter()
        .map(|((provider, model), usage)| {
            let equivalent_cost = estimated_cost(prices, &model, usage);
            if let Some(cost) = equivalent_cost {
                *equivalent_cost_by_provider
                    .entry(provider.clone())
                    .or_default() += cost;
            } else {
                unknown_price_models.push(json!({ "provider": provider, "model": model }));
            }
            json!({
                "provider": provider,
                "model": model,
                "inputTokens": usage.input,
                "cachedInputTokens": usage.cached,
                "outputTokens": usage.output,
                "requestCount": usage.requests,
                "totalTokens": usage.total(),
                "estimatedCostUsd": if provider == "openai" { equivalent_cost } else { None },
                "openAiEquivalentCostUsd": equivalent_cost,
            })
        })
        .collect();

    let mut provider_entries: Vec<_> = by_provider.into_iter().collect();
    provider_entries.sort_by_key(|entry| std::cmp::Reverse(entry.1.total()));
    let provider_rows: Vec<Value> = provider_entries
        .into_iter()
        .map(|(provider, usage)| {
            let equivalent_cost = equivalent_cost_by_provider
                .get(&provider)
                .copied()
                .unwrap_or(0.0);
            json!({
                "provider": provider,
                "inputTokens": usage.input,
                "cachedInputTokens": usage.cached,
                "outputTokens": usage.output,
                "requestCount": usage.requests,
                "totalTokens": usage.total(),
                "estimatedCostUsd": if provider == "openai" { Some(equivalent_cost) } else { None },
                "openAiEquivalentCostUsd": equivalent_cost,
                "costStatus": if provider == "openai" { "estimated" } else { "unpriced" },
            })
        })
        .collect();

    let mut model_entries: Vec<_> = by_model.into_iter().collect();
    model_entries.sort_by_key(|entry| std::cmp::Reverse(entry.1.total()));
    let model_rows: Vec<Value> = model_entries
        .into_iter()
        .map(|(model, usage)| {
            json!({
                "model": model,
                "inputTokens": usage.input,
                "cachedInputTokens": usage.cached,
                "outputTokens": usage.output,
                "requestCount": usage.requests,
                "totalTokens": usage.total(),
                "openAiEquivalentCostUsd": estimated_cost(prices, &model, usage),
            })
        })
        .collect();

    let official_estimated_cost = equivalent_cost_by_provider
        .get("openai")
        .copied()
        .unwrap_or(0.0);
    let custom_equivalent_cost: f64 = equivalent_cost_by_provider
        .iter()
        .filter(|(provider, _)| provider.as_str() != "openai")
        .map(|(_, cost)| *cost)
        .sum();

    let mut timeline_rows = Vec::new();
    let first_bucket = if from_timestamp > 0 {
        Some(timeline_bucket(from_timestamp, grain))
    } else {
        timeline_usage.keys().min().copied()
    };
    if let Some(mut bucket) = first_bucket {
        let last_bucket = timeline_bucket(to_timestamp, grain);
        while bucket <= last_bucket {
            let usage = timeline_usage.get(&bucket).copied().unwrap_or_default();
            timeline_rows.push(json!({
                "timestamp": bucket,
                "label": timeline_label(bucket, grain),
                "inputTokens": usage.input,
                "cachedInputTokens": usage.cached,
                "outputTokens": usage.output,
                "requestCount": usage.requests,
                "totalTokens": usage.total(),
                "officialEstimatedCostUsd": timeline_official_cost.get(&bucket).copied().unwrap_or(0.0),
                "customOpenAiEquivalentCostUsd": timeline_custom_reference_cost.get(&bucket).copied().unwrap_or(0.0),
            }));
            let next_bucket = next_timeline_bucket(bucket, grain);
            if next_bucket <= bucket {
                break;
            }
            bucket = next_bucket;
        }
    }

    Ok(json!({
        "codexHome": codex_home.to_string_lossy(),
        "range": if days <= 0 { "all".to_string() } else { format!("last-{days}-local-calendar-days") },
        "fromTimestamp": from_timestamp,
        "toTimestamp": to_timestamp,
        "timelineGrain": grain,
        "timeline": timeline_rows,
        "filesScanned": files.len(),
        "filesParsed": parsed_rollouts.len(),
        "totals": usage_json(totals),
        "costSummary": {
            "officialEstimatedCostUsd": official_estimated_cost,
            "customActualCostUsd": null,
            "customOpenAiEquivalentCostUsd": custom_equivalent_cost,
            "allProvidersOpenAiEquivalentCostUsd": official_estimated_cost + custom_equivalent_cost,
            "note": "Custom-provider actual cost is unknown without its own price table; the OpenAI-equivalent value is only a comparison benchmark.",
        },
        "byProvider": provider_rows,
        "byProviderModel": provider_model_rows,
        "byModel": model_rows,
        "unknownPriceModels": unknown_price_models,
        "parseErrors": parse_errors,
        "forkHandling": {
            "replayEventsSkipped": replay_events_skipped,
            "deferredFiles": deferred_files.len(),
            "deferredDetails": deferred_files.into_iter().take(20).collect::<Vec<_>>(),
        },
        "duplicateRequestsSkipped": duplicate_requests_skipped,
    }))
}

fn usage_json(usage: Usage) -> Value {
    json!({
        "inputTokens": usage.input,
        "cachedInputTokens": usage.cached,
        "outputTokens": usage.output,
        "requestCount": usage.requests,
        "totalTokens": usage.total(),
    })
}

fn range_start_timestamp(days: i32, to_timestamp: i64, explicit_start: Option<i64>) -> i64 {
    explicit_start.unwrap_or_else(|| {
        if days > 0 {
            let last_date = local_datetime(to_timestamp).date_naive();
            let first_date = last_date - Duration::days(i64::from(days - 1));
            local_naive_timestamp(first_date.and_hms_opt(0, 0, 0).expect("valid midnight"))
        } else {
            0
        }
    })
}

fn find_rollouts(codex_home: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for directory_name in ["sessions", "archived_sessions"] {
        let directory = codex_home.join(directory_name);
        if directory.is_dir() {
            collect_rollouts(&directory, &mut files);
        }
    }
    files.sort();
    files
}

fn collect_rollouts(directory: &Path, files: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_rollouts(&path, files);
        } else if path.is_file() {
            let is_rollout = path
                .file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.starts_with("rollout-") && name.ends_with(".jsonl"))
                .unwrap_or(false);
            if is_rollout {
                files.push(path);
            }
        }
    }
}

fn parse_rollout(
    path: &Path,
    rollout_name: &Regex,
    dated_model_suffix: &Regex,
) -> Result<Option<ParsedRollout>, String> {
    let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
        return Ok(None);
    };
    let Some(captures) = rollout_name.captures(file_name) else {
        return Ok(None);
    };
    let Some(session_capture) = captures.get(1) else {
        return Ok(None);
    };

    let session_id = session_capture.as_str().to_lowercase();
    let rollout_id = captures
        .get(2)
        .map(|capture| capture.as_str().to_lowercase())
        .unwrap_or_else(|| session_id.clone());
    let file = File::open(path).map_err(|error| error.to_string())?;
    let mut reader = BufReader::new(file);
    let mut raw_line = Vec::new();
    let mut root_meta_seen = false;
    let mut root_timestamp = None;
    let mut parent_id = None;
    let mut history_base_id = None;
    let mut parent_error = None;
    let mut model_provider = "unknown".to_string();
    let mut current_model = "unknown".to_string();
    let mut high_water: Option<Tokens> = None;
    let mut last_signature_by_source: HashMap<String, Signature> = HashMap::new();
    let mut previous_signature: Option<Signature> = None;
    let mut event_index = 0_u64;
    let mut token_events = Vec::new();

    loop {
        raw_line.clear();
        let bytes_read = reader
            .read_until(b'\n', &mut raw_line)
            .map_err(|error| error.to_string())?;
        if bytes_read == 0 {
            break;
        }
        let line = String::from_utf8_lossy(&raw_line);
        if !line.contains("\"session_meta\"")
            && !line.contains("\"turn_context\"")
            && !line.contains("\"token_count\"")
        {
            continue;
        }
        let Ok(event) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let event_type = event.get("type").and_then(Value::as_str);
        let Some(payload) = event.get("payload").and_then(Value::as_object) else {
            continue;
        };

        if event_type == Some("session_meta") && !root_meta_seen {
            root_meta_seen = true;
            root_timestamp = parse_timestamp(event.get("timestamp"));
            if let Some(provider) = payload.get("model_provider").and_then(non_empty_string) {
                model_provider = provider.trim().to_lowercase();
            }
            (parent_id, parent_error) = explicit_parent_from_meta(payload);
            history_base_id = payload
                .get("history_base")
                .and_then(Value::as_object)
                .and_then(|history_base| history_base.get("thread_id"))
                .and_then(non_empty_string)
                .map(str::to_lowercase);
            if parent_id.as_deref() == Some(session_id.as_str()) {
                parent_id = None;
                parent_error = Some("parent session ID equals child session ID".to_string());
            }

            let meta_session_id = payload
                .get("id")
                .or_else(|| payload.get("thread_id"))
                .or_else(|| payload.get("threadId"))
                .and_then(non_empty_string);
            if let Some(meta_session_id) = meta_session_id {
                if meta_session_id != session_id {
                    parent_error = Some(format!(
                        "filename session ID ({session_id}) and metadata ID ({meta_session_id}) disagree"
                    ));
                }
            }
            continue;
        }

        if event_type == Some("turn_context") {
            let raw_model = payload.get("model").and_then(Value::as_str).or_else(|| {
                payload
                    .get("info")
                    .and_then(Value::as_object)
                    .and_then(|info| info.get("model"))
                    .and_then(Value::as_str)
            });
            if let Some(model) = raw_model.filter(|model| !model.is_empty()) {
                current_model = normalize_model(model, dated_model_suffix);
            }
            continue;
        }

        if event_type != Some("event_msg")
            || payload.get("type").and_then(Value::as_str) != Some("token_count")
        {
            continue;
        }
        let Some(info) = payload.get("info").and_then(Value::as_object) else {
            continue;
        };

        let raw_model = info
            .get("model")
            .and_then(Value::as_str)
            .or_else(|| info.get("model_name").and_then(Value::as_str))
            .or_else(|| payload.get("model").and_then(Value::as_str));
        if let Some(model) = raw_model.filter(|model| !model.is_empty()) {
            current_model = normalize_model(model, dated_model_suffix);
        }

        let total_value = info.get("total_token_usage");
        let last_value = info.get("last_token_usage");
        let total_tokens = read_tokens(total_value);
        let last_tokens = read_tokens(last_value);
        if total_tokens.is_none() && last_tokens.is_none() {
            continue;
        }

        let signature = Signature {
            total: snapshot_signature(total_value),
            last: snapshot_signature(last_value),
        };
        let source = payload
            .get("rate_limits")
            .and_then(Value::as_object)
            .and_then(|rate_limits| rate_limits.get("limit_id"))
            .and_then(|value| serde_json::to_string(value).ok())
            .unwrap_or_else(|| "null".to_string());
        let duplicate = total_tokens.is_some()
            && (last_signature_by_source.get(&source) == Some(&signature)
                || previous_signature.as_ref() == Some(&signature));
        if total_tokens.is_some() {
            last_signature_by_source.insert(source, signature.clone());
        }
        previous_signature = Some(signature.clone());

        let mut delta = if duplicate {
            Tokens::default()
        } else if let Some(last) = last_tokens {
            last
        } else if let Some(previous) = high_water {
            total_tokens
                .expect("total token snapshot exists")
                .delta_from(previous)
        } else {
            total_tokens.expect("total token snapshot exists")
        };
        if let Some(total) = total_tokens {
            high_water = Some(
                high_water
                    .map(|previous| previous.max(total))
                    .unwrap_or(total),
            );
        }
        delta.cached = delta.cached.min(delta.input);

        let nonzero_index = if delta.is_zero() {
            None
        } else {
            event_index = event_index.saturating_add(1);
            Some(event_index)
        };
        token_events.push(TokenEvent {
            signature,
            delta,
            event_index: nonzero_index,
            model: current_model.clone(),
            timestamp: parse_timestamp(event.get("timestamp")),
        });
    }

    Ok(Some(ParsedRollout {
        path: path.to_path_buf(),
        session_id,
        rollout_id,
        model_provider,
        root_meta_seen,
        root_timestamp,
        parent_id,
        history_base_id,
        parent_error,
        token_events,
    }))
}

fn explicit_parent_from_meta(payload: &Map<String, Value>) -> (Option<String>, Option<String>) {
    let forked_from = payload
        .get("forked_from_id")
        .and_then(non_empty_string)
        .map(str::to_string);
    let spawned_from = payload
        .get("source")
        .and_then(Value::as_object)
        .and_then(|source| source.get("subagent"))
        .and_then(Value::as_object)
        .and_then(|subagent| subagent.get("thread_spawn"))
        .and_then(Value::as_object)
        .and_then(|thread_spawn| thread_spawn.get("parent_thread_id"))
        .and_then(non_empty_string)
        .map(str::to_string);

    if let (Some(forked), Some(spawned)) = (&forked_from, &spawned_from) {
        if forked != spawned {
            return (
                None,
                Some(format!(
                    "forked_from_id ({forked}) and parent_thread_id ({spawned}) disagree"
                )),
            );
        }
    }
    let Some(raw_parent) = forked_from.or(spawned_from) else {
        return (None, None);
    };
    match Uuid::parse_str(&raw_parent) {
        Ok(parent) => (Some(parent.hyphenated().to_string()), None),
        Err(_) => (None, Some(format!("invalid parent UUID: {raw_parent}"))),
    }
}

fn resolve_replay_prefix(
    rollout: &ParsedRollout,
    rollout_index: &HashMap<String, Vec<usize>>,
    parsed_rollouts: &[ParsedRollout],
) -> (usize, Option<String>) {
    if let Some(error) = &rollout.parent_error {
        return (0, Some(error.clone()));
    }
    let Some(parent_id) = &rollout.parent_id else {
        return (0, None);
    };
    let Some(root_timestamp) = rollout.root_timestamp else {
        return (
            0,
            Some("forked rollout metadata has no valid timestamp".to_string()),
        );
    };
    let Some(parent_candidates) = rollout_index.get(parent_id) else {
        return (0, Some(format!("parent rollout not found: {parent_id}")));
    };

    // A logical session can span multiple paginated rollout files. Fork metadata
    // identifies the exact physical segment through history_base.thread_id; use
    // it when available instead of requiring every segment to contain the same
    // token history.
    let matching_candidates: Vec<usize> = rollout
        .history_base_id
        .as_ref()
        .map(|history_base_id| {
            parent_candidates
                .iter()
                .copied()
                .filter(|index| parsed_rollouts[*index].rollout_id == *history_base_id)
                .collect()
        })
        .unwrap_or_default();
    let candidates = if matching_candidates.is_empty() {
        parent_candidates.as_slice()
    } else {
        matching_candidates.as_slice()
    };

    let mut candidate_signatures = Vec::new();
    for index in candidates {
        let parent = &parsed_rollouts[*index];
        if parent
            .token_events
            .iter()
            .any(|event| event.timestamp.is_none())
        {
            return (
                0,
                Some(format!(
                    "parent rollout has token_count without timestamp: {}",
                    parent.path.display()
                )),
            );
        }
        let signatures: Vec<Signature> = parent
            .token_events
            .iter()
            .filter(|event| {
                event
                    .timestamp
                    .is_some_and(|timestamp| timestamp <= root_timestamp)
            })
            .map(|event| event.signature.clone())
            .collect();
        if signatures.is_empty() {
            return (
                0,
                Some(format!(
                    "parent rollout has no token_count before fork: {}",
                    parent.path.display()
                )),
            );
        }
        candidate_signatures.push(signatures);
    }

    let first = &candidate_signatures[0];
    if candidate_signatures
        .iter()
        .skip(1)
        .any(|signatures| signatures != first)
    {
        return (
            0,
            Some(format!("multiple parent rollouts disagree: {parent_id}")),
        );
    }
    (matching_replay_prefix(&rollout.token_events, first), None)
}

fn matching_replay_prefix(child: &[TokenEvent], parent: &[Signature]) -> usize {
    let mut parent_offset = 0;
    let mut matched = 0;
    for event in child {
        let Some(relative_match) = parent[parent_offset..]
            .iter()
            .position(|signature| signature == &event.signature)
        else {
            break;
        };
        parent_offset += relative_match + 1;
        matched += 1;
    }
    matched
}

fn positive_u64(value: Option<&Value>) -> u64 {
    let Some(value) = value else {
        return 0;
    };
    if let Some(number) = value.as_u64() {
        return number;
    }
    value
        .as_f64()
        .filter(|number| *number >= 0.0 && number.is_finite())
        .map(|number| number.trunc() as u64)
        .unwrap_or(0)
}

fn snapshot_signature(value: Option<&Value>) -> Option<Vec<Value>> {
    let object = value?.as_object()?;
    Some(
        SIGNATURE_KEYS
            .iter()
            .map(|key| object.get(*key).cloned().unwrap_or(Value::Null))
            .collect(),
    )
}

fn read_tokens(value: Option<&Value>) -> Option<Tokens> {
    let object = value?.as_object()?;
    if !SIGNATURE_KEYS.iter().any(|key| object.contains_key(*key)) {
        return None;
    }
    let input = positive_u64(object.get("input_tokens"));
    let cached_value = if object.contains_key("cached_input_tokens") {
        object.get("cached_input_tokens")
    } else {
        object.get("cache_read_input_tokens")
    };
    Some(Tokens {
        input,
        cached: positive_u64(cached_value).min(input),
        output: positive_u64(object.get("output_tokens")),
    })
}

fn non_empty_string(value: &Value) -> Option<&str> {
    value.as_str().filter(|text| !text.is_empty())
}

fn normalize_model(raw: &str, dated_model_suffix: &Regex) -> String {
    let model = raw
        .trim()
        .to_lowercase()
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_string();
    let normalized = dated_model_suffix.replace(&model, "");
    if normalized.is_empty() {
        "unknown".to_string()
    } else {
        normalized.into_owned()
    }
}

fn parse_timestamp(value: Option<&Value>) -> Option<i64> {
    let text = value?.as_str().filter(|text| !text.is_empty())?;
    if let Ok(timestamp) = DateTime::parse_from_rfc3339(text) {
        return Some(timestamp.timestamp());
    }
    for format in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%d %H:%M:%S%.f"] {
        if let Ok(timestamp) = NaiveDateTime::parse_from_str(text, format) {
            return Some(local_naive_timestamp(timestamp));
        }
    }
    None
}

fn estimated_cost(prices: &PriceTable, model: &str, usage: Usage) -> Option<f64> {
    let price = prices.get(model)?;
    let cached = usage.cached.min(usage.input);
    let uncached = usage.input - cached;
    Some(
        (uncached as f64 * price.input
            + cached as f64 * price.cached_input
            + usage.output as f64 * price.output)
            / 1_000_000.0,
    )
}

fn timeline_grain(days: i32) -> &'static str {
    if days == 1 {
        "hour"
    } else if (1..=90).contains(&days) {
        "day"
    } else if (1..=730).contains(&days) {
        "week"
    } else {
        "month"
    }
}

fn timeline_bucket(timestamp: i64, grain: &str) -> i64 {
    let local = local_datetime(timestamp);
    let date = local.date_naive();
    let naive = match grain {
        "hour" => date
            .and_hms_opt(local.hour(), 0, 0)
            .expect("valid local hour"),
        "day" => date.and_hms_opt(0, 0, 0).expect("valid local midnight"),
        "week" => {
            let monday = date - Duration::days(i64::from(date.weekday().num_days_from_monday()));
            monday.and_hms_opt(0, 0, 0).expect("valid local midnight")
        }
        _ => NaiveDate::from_ymd_opt(date.year(), date.month(), 1)
            .expect("valid first day of month")
            .and_hms_opt(0, 0, 0)
            .expect("valid local midnight"),
    };
    local_naive_timestamp(naive)
}

fn next_timeline_bucket(timestamp: i64, grain: &str) -> i64 {
    let local = local_datetime(timestamp);
    let date = local.date_naive();
    match grain {
        "hour" => (local + Duration::hours(1)).timestamp(),
        "day" => local_naive_timestamp(
            (date + Duration::days(1))
                .and_hms_opt(0, 0, 0)
                .expect("valid local midnight"),
        ),
        "week" => local_naive_timestamp(
            (date + Duration::days(7))
                .and_hms_opt(0, 0, 0)
                .expect("valid local midnight"),
        ),
        _ => {
            let (year, month) = if date.month() == 12 {
                (date.year() + 1, 1)
            } else {
                (date.year(), date.month() + 1)
            };
            local_naive_timestamp(
                NaiveDate::from_ymd_opt(year, month, 1)
                    .expect("valid first day of month")
                    .and_hms_opt(0, 0, 0)
                    .expect("valid local midnight"),
            )
        }
    }
}

fn timeline_label(timestamp: i64, grain: &str) -> String {
    let local = local_datetime(timestamp);
    match grain {
        "hour" => local.format("%m/%d %H:00").to_string(),
        "day" | "week" => local.format("%m/%d").to_string(),
        _ => local.format("%Y/%m").to_string(),
    }
}

fn local_datetime(timestamp: i64) -> DateTime<Local> {
    Local
        .timestamp_opt(timestamp, 0)
        .earliest()
        .unwrap_or_else(Local::now)
}

fn local_naive_timestamp(timestamp: NaiveDateTime) -> i64 {
    Local
        .from_local_datetime(&timestamp)
        .earliest()
        .unwrap_or_else(|| Local.from_utc_datetime(&timestamp))
        .timestamp()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_signature(marker: u64) -> Signature {
        Signature {
            total: Some(vec![json!(marker)]),
            last: None,
        }
    }

    fn test_event(marker: u64, timestamp: i64) -> TokenEvent {
        TokenEvent {
            signature: test_signature(marker),
            delta: Tokens {
                input: marker,
                cached: 0,
                output: 0,
            },
            event_index: Some(marker),
            model: "gpt-5.4-mini".to_string(),
            timestamp: Some(timestamp),
        }
    }

    #[test]
    fn selects_the_history_base_segment_for_a_paginated_parent() {
        let parent_id = "123e4567-e89b-12d3-a456-426614174000";
        let parent_segment_id = "223e4567-e89b-12d3-a456-426614174000";
        let parents = vec![
            ParsedRollout {
                path: PathBuf::from("parent.jsonl"),
                session_id: parent_id.to_string(),
                rollout_id: parent_id.to_string(),
                model_provider: "openai".to_string(),
                root_meta_seen: true,
                root_timestamp: Some(10),
                parent_id: None,
                history_base_id: None,
                parent_error: None,
                token_events: vec![test_event(1, 11)],
            },
            ParsedRollout {
                path: PathBuf::from("parent-segment.jsonl"),
                session_id: parent_id.to_string(),
                rollout_id: parent_segment_id.to_string(),
                model_provider: "openai".to_string(),
                root_meta_seen: true,
                root_timestamp: Some(20),
                parent_id: None,
                history_base_id: Some(parent_id.to_string()),
                parent_error: None,
                token_events: vec![test_event(2, 21)],
            },
            ParsedRollout {
                path: PathBuf::from("child.jsonl"),
                session_id: "323e4567-e89b-12d3-a456-426614174000".to_string(),
                rollout_id: "323e4567-e89b-12d3-a456-426614174000".to_string(),
                model_provider: "openai".to_string(),
                root_meta_seen: true,
                root_timestamp: Some(30),
                parent_id: Some(parent_id.to_string()),
                history_base_id: Some(parent_segment_id.to_string()),
                parent_error: None,
                token_events: vec![test_event(2, 21), test_event(3, 31)],
            },
        ];
        let rollout_index = HashMap::from([(parent_id.to_string(), vec![0, 1])]);

        let (replay_prefix, deferred_reason) =
            resolve_replay_prefix(&parents[2], &rollout_index, &parents);

        assert_eq!(replay_prefix, 1);
        assert_eq!(deferred_reason, None);
    }

    #[test]
    fn scans_an_arbitrarily_named_root_without_python() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time after epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "renamed-codex-data-{}-{suffix}",
            std::process::id()
        ));
        let sessions = root.join("sessions").join("2026").join("09").join("08");
        std::fs::create_dir_all(&sessions).expect("create fixture directory");

        let session_id = "123e4567-e89b-12d3-a456-426614174000";
        let path = sessions.join(format!("rollout-test-{session_id}.jsonl"));
        let lines = [
            json!({
                "timestamp": "2026-09-08T01:00:00Z",
                "type": "session_meta",
                "payload": { "id": session_id, "model_provider": "openai" }
            }),
            json!({
                "timestamp": "2026-09-08T01:00:01Z",
                "type": "turn_context",
                "payload": { "model": "openai/gpt-5.4-mini-2026-01-01" }
            }),
            json!({
                "timestamp": "2026-09-08T01:00:02Z",
                "type": "event_msg",
                "payload": {
                    "type": "token_count",
                    "info": {
                        "total_token_usage": {
                            "input_tokens": 100,
                            "cached_input_tokens": 20,
                            "output_tokens": 10
                        },
                        "last_token_usage": {
                            "input_tokens": 100,
                            "cached_input_tokens": 20,
                            "output_tokens": 10
                        }
                    }
                }
            }),
        ];
        let contents = lines
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(&path, contents).expect("write fixture rollout");

        let report = analyze(
            root.to_str().expect("UTF-8 temp path"),
            0,
            None,
            Some(1_800_000_000),
            &crate::pricing::defaults(),
        )
        .expect("analyze fixture");
        assert_eq!(report["filesScanned"], 1);
        assert_eq!(report["filesParsed"], 1);
        assert_eq!(report["totals"]["inputTokens"], 100);
        assert_eq!(report["totals"]["cachedInputTokens"], 20);
        assert_eq!(report["totals"]["outputTokens"], 10);
        assert_eq!(report["totals"]["totalTokens"], 110);
        assert_eq!(report["totals"]["requestCount"], 1);
        assert_eq!(report["byProviderModel"][0]["model"], "gpt-5.4-mini");

        // A newly introduced model must use saved rates in every cost aggregation.
        let contents = std::fs::read_to_string(&path)
            .unwrap()
            .replace("gpt-5.4-mini-2026-01-01", "new-model-2026-10-14");
        std::fs::write(&path, contents).unwrap();
        let prices = crate::pricing::validate(std::collections::BTreeMap::from([(
            "new-model".into(),
            crate::pricing::ModelPrice {
                input: 2.0,
                cached_input: 0.5,
                output: 10.0,
            },
        )]))
        .unwrap();
        let report = analyze(
            root.to_str().unwrap(),
            0,
            None,
            Some(1_800_000_000),
            &prices,
        )
        .unwrap();
        let expected = (80.0 * 2.0 + 20.0 * 0.5 + 10.0 * 10.0) / 1_000_000.0;
        assert_eq!(report["byProviderModel"][0]["estimatedCostUsd"], expected);
        assert_eq!(report["byProvider"][0]["estimatedCostUsd"], expected);
        assert_eq!(report["costSummary"]["officialEstimatedCostUsd"], expected);
        assert_eq!(report["timeline"][0]["officialEstimatedCostUsd"], expected);
        assert!(report["unknownPriceModels"].as_array().unwrap().is_empty());
        let unpriced = analyze(
            root.to_str().unwrap(),
            0,
            None,
            Some(1_800_000_000),
            &PriceTable::new(),
        )
        .unwrap();
        assert!(unpriced["byProviderModel"][0]["estimatedCostUsd"].is_null());
        assert_eq!(unpriced["unknownPriceModels"][0]["model"], "new-model");

        std::fs::remove_dir_all(&root).expect("remove fixture directory");
    }

    #[test]
    fn explicit_range_start_overrides_calendar_day_fallback() {
        let to_timestamp = 1_800_000_000;
        let rolling_start = to_timestamp - 86_400;

        assert_eq!(
            range_start_timestamp(1, to_timestamp, Some(rolling_start)),
            rolling_start
        );
        assert_eq!(range_start_timestamp(0, to_timestamp, None), 0);
    }
}
