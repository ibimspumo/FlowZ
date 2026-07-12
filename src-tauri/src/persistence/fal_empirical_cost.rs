use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

const STORE_SCHEMA_VERSION: u32 = 1;
const MAX_SAMPLES_PER_COHORT: usize = 25;
const MAX_SAMPLES_TOTAL: usize = 500;
const MAX_PARAMETER_CLASS_BYTES: usize = 4 * 1024;
const MIN_SAMPLES: usize = 3;

#[derive(Clone, Debug)]
pub struct FalEmpiricalCostStore {
    path: PathBuf,
    lock: Arc<Mutex<()>>,
}

#[derive(Clone, Debug)]
pub struct FalActualCostSample<'a> {
    pub run_id: &'a str,
    pub endpoint: &'a str,
    pub adapter_schema_hash: &'a str,
    pub pricing_manifest_version: u32,
    pub billable_config: &'a Value,
    pub actual_cost_microunits: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FalCostContext {
    pub schema_version: u32,
    pub pricing_manifest_version: u32,
    pub billable_config: Value,
}

impl FalCostContext {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1 || self.pricing_manifest_version == 0 {
            return Err("Der Fal-Kostenkontext verwendet eine ungültige Version.".into());
        }
        canonical_parameter_class(&self.billable_config).map(|_| ())
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FalEmpiricalCostQuery {
    pub endpoint: String,
    pub adapter_schema_hash: String,
    pub pricing_manifest_version: u32,
    pub billable_config: Value,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FalEmpiricalCostEstimate {
    pub state: &'static str,
    pub provenance: &'static str,
    pub sample_count: usize,
    pub used_sample_count: usize,
    pub rejected_outliers: usize,
    pub last_observed_at: Option<String>,
    pub median_microunits: Option<i64>,
    pub p25_microunits: Option<i64>,
    pub p75_microunits: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoreDocument {
    schema_version: u32,
    samples: Vec<StoredSample>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSample {
    run_id: String,
    endpoint: String,
    adapter_schema_hash: String,
    pricing_manifest_version: u32,
    parameter_class: String,
    actual_cost_microunits: i64,
    recorded_at: String,
}

impl FalEmpiricalCostStore {
    pub fn initialize(app_data_dir: impl AsRef<Path>) -> Result<Self, String> {
        fs::create_dir_all(app_data_dir.as_ref()).map_err(|error| error.to_string())?;
        let store = Self {
            path: app_data_dir.as_ref().join("fal-empirical-costs.json"),
            lock: Arc::new(Mutex::new(())),
        };
        {
            let _guard = store
                .lock
                .lock()
                .map_err(|_| "Fal-Kostenhistorie ist gesperrt.")?;
            if store.path.exists() {
                store.read_document()?;
            }
        }
        Ok(store)
    }

    pub fn record_actual(&self, sample: FalActualCostSample<'_>) -> Result<(), String> {
        validate_identity(sample.endpoint, sample.adapter_schema_hash)?;
        if sample.run_id.is_empty() || sample.run_id.len() > 128 {
            return Err("Die Run-ID der Fal-Kostenprobe ist ungültig.".into());
        }
        if !(0..=1_000_000_000_000).contains(&sample.actual_cost_microunits) {
            return Err(
                "Die tatsächlichen Fal-Kosten liegen außerhalb des sicheren Bereichs.".into(),
            );
        }
        let parameter_class = canonical_parameter_class(sample.billable_config)?;
        let _guard = self
            .lock
            .lock()
            .map_err(|_| "Fal-Kostenhistorie ist gesperrt.")?;
        let mut document = self.read_document()?;
        if document
            .samples
            .iter()
            .any(|item| item.run_id == sample.run_id)
        {
            return Ok(());
        }
        document.samples.push(StoredSample {
            run_id: sample.run_id.into(),
            endpoint: sample.endpoint.into(),
            adapter_schema_hash: sample.adapter_schema_hash.into(),
            pricing_manifest_version: sample.pricing_manifest_version,
            parameter_class: parameter_class.clone(),
            actual_cost_microunits: sample.actual_cost_microunits,
            recorded_at: Utc::now().to_rfc3339(),
        });
        retain_bounded(&mut document.samples);
        self.write_document_atomic(&document)
    }

    pub fn estimate(
        &self,
        query: &FalEmpiricalCostQuery,
    ) -> Result<FalEmpiricalCostEstimate, String> {
        validate_identity(&query.endpoint, &query.adapter_schema_hash)?;
        let parameter_class = canonical_parameter_class(&query.billable_config)?;
        let _guard = self
            .lock
            .lock()
            .map_err(|_| "Fal-Kostenhistorie ist gesperrt.")?;
        let document = self.read_document()?;
        let matching = document
            .samples
            .iter()
            .filter(|sample| {
                sample.endpoint == query.endpoint
                    && sample.adapter_schema_hash == query.adapter_schema_hash
                    && sample.pricing_manifest_version == query.pricing_manifest_version
                    && sample.parameter_class == parameter_class
            })
            .collect::<Vec<_>>();
        let last_observed_at = matching
            .iter()
            .map(|sample| sample.recorded_at.as_str())
            .max()
            .map(str::to_owned);
        let mut values = matching
            .iter()
            .map(|sample| sample.actual_cost_microunits)
            .collect::<Vec<_>>();
        values.sort_unstable();
        summarize(&values, last_observed_at)
    }

    fn read_document(&self) -> Result<StoreDocument, String> {
        if !self.path.exists() {
            return Ok(StoreDocument {
                schema_version: STORE_SCHEMA_VERSION,
                samples: Vec::new(),
            });
        }
        let bytes = fs::read(&self.path).map_err(|error| error.to_string())?;
        if bytes.len() > 2 * 1024 * 1024 {
            return Err("Die lokale Fal-Kostenhistorie ist unerwartet groß.".into());
        }
        let document: StoreDocument = serde_json::from_slice(&bytes)
            .map_err(|_| "Die lokale Fal-Kostenhistorie ist beschädigt.".to_string())?;
        if document.schema_version != STORE_SCHEMA_VERSION
            || document.samples.len() > MAX_SAMPLES_TOTAL
        {
            return Err("Die lokale Fal-Kostenhistorie verwendet ein unbekanntes Format.".into());
        }
        Ok(document)
    }

    fn write_document_atomic(&self, document: &StoreDocument) -> Result<(), String> {
        let bytes = serde_json::to_vec(document).map_err(|error| error.to_string())?;
        let temporary = self
            .path
            .with_extension(format!("tmp-{}", std::process::id()));
        fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
        if let Err(error) = fs::rename(&temporary, &self.path) {
            let _ = fs::remove_file(&temporary);
            return Err(error.to_string());
        }
        Ok(())
    }
}

fn validate_identity(endpoint: &str, adapter_schema_hash: &str) -> Result<(), String> {
    let valid = |value: &str, max: usize| {
        !value.is_empty()
            && value.len() <= max
            && value.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '/' | '-' | '_' | '.')
            })
    };
    if !valid(endpoint, 200) || !valid(adapter_schema_hash, 160) {
        return Err("Fal-Endpoint oder Adapter-Version ist ungültig.".into());
    }
    Ok(())
}

fn canonical_parameter_class(value: &Value) -> Result<String, String> {
    if !value.is_object() {
        return Err("Die Fal-Parameterklasse muss ein Objekt sein.".into());
    }
    fn canonical(value: &Value, depth: usize) -> Result<Value, String> {
        if depth > 8 {
            return Err("Die Fal-Parameterklasse ist zu tief verschachtelt.".into());
        }
        match value {
            Value::Null | Value::Bool(_) | Value::Number(_) => Ok(value.clone()),
            Value::String(text)
                if text.len() <= 256
                    && !text.starts_with("data:")
                    && !text.starts_with("http://")
                    && !text.starts_with("https://") =>
            {
                Ok(value.clone())
            }
            Value::Array(items) if items.len() <= 64 => Ok(Value::Array(
                items
                    .iter()
                    .map(|item| canonical(item, depth + 1))
                    .collect::<Result<_, _>>()?,
            )),
            Value::Object(items) if items.len() <= 64 => {
                let mut keys = items.keys().collect::<Vec<_>>();
                keys.sort_unstable();
                let mut sorted = Map::new();
                for key in keys {
                    let normalized_key = key.to_ascii_lowercase().replace(['-', '_'], "");
                    if key.len() > 80
                        || matches!(
                            normalized_key.as_str(),
                            "prompt" | "image" | "images" | "media" | "url" | "dataurl"
                        )
                    {
                        return Err("Die Fal-Parameterklasse darf keine Prompt- oder Mediendaten enthalten.".into());
                    }
                    sorted.insert(key.clone(), canonical(&items[key], depth + 1)?);
                }
                Ok(Value::Object(sorted))
            }
            _ => Err("Die Fal-Parameterklasse ist zu groß.".into()),
        }
    }
    let encoded =
        serde_json::to_string(&canonical(value, 0)?).map_err(|error| error.to_string())?;
    if encoded.len() > MAX_PARAMETER_CLASS_BYTES {
        return Err("Die Fal-Parameterklasse ist zu groß.".into());
    }
    Ok(encoded)
}

fn retain_bounded(samples: &mut Vec<StoredSample>) {
    samples.sort_by(|left, right| left.recorded_at.cmp(&right.recorded_at));
    let mut cohort_counts =
        std::collections::HashMap::<(String, String, u32, String), usize>::new();
    let mut keep = vec![true; samples.len()];
    for (index, sample) in samples.iter().enumerate().rev() {
        let key = (
            sample.endpoint.clone(),
            sample.adapter_schema_hash.clone(),
            sample.pricing_manifest_version,
            sample.parameter_class.clone(),
        );
        let count = cohort_counts.entry(key).or_default();
        *count += 1;
        if *count > MAX_SAMPLES_PER_COHORT {
            keep[index] = false;
        }
    }
    let mut retained = samples
        .drain(..)
        .zip(keep)
        .filter_map(|(sample, keep)| keep.then_some(sample))
        .collect::<Vec<_>>();
    if retained.len() > MAX_SAMPLES_TOTAL {
        retained.drain(..retained.len() - MAX_SAMPLES_TOTAL);
    }
    let mut seen = HashSet::new();
    retained.retain(|sample| seen.insert(sample.run_id.clone()));
    *samples = retained;
}

fn percentile(sorted: &[i64], fraction: f64) -> i64 {
    if sorted.len() == 1 {
        return sorted[0];
    }
    let position = fraction * (sorted.len() - 1) as f64;
    let lower = position.floor() as usize;
    let upper = position.ceil() as usize;
    if lower == upper {
        return sorted[lower];
    }
    let weight = position - lower as f64;
    ((sorted[lower] as f64) * (1.0 - weight) + (sorted[upper] as f64) * weight).round() as i64
}

fn summarize(
    sorted: &[i64],
    last_observed_at: Option<String>,
) -> Result<FalEmpiricalCostEstimate, String> {
    if sorted.len() < MIN_SAMPLES {
        return Ok(FalEmpiricalCostEstimate {
            state: "insufficient",
            provenance: "local-actual",
            sample_count: sorted.len(),
            used_sample_count: sorted.len(),
            rejected_outliers: 0,
            last_observed_at,
            median_microunits: None,
            p25_microunits: None,
            p75_microunits: None,
        });
    }
    let q1 = percentile(sorted, 0.25);
    let q3 = percentile(sorted, 0.75);
    let iqr = q3.saturating_sub(q1);
    let lower = q1.saturating_sub(iqr.saturating_mul(3) / 2);
    let upper = q3.saturating_add(iqr.saturating_mul(3) / 2);
    let filtered = sorted
        .iter()
        .copied()
        .filter(|value| *value >= lower && *value <= upper)
        .collect::<Vec<_>>();
    if filtered.len() < MIN_SAMPLES {
        return Ok(FalEmpiricalCostEstimate {
            state: "insufficient",
            provenance: "local-actual",
            sample_count: sorted.len(),
            used_sample_count: filtered.len(),
            rejected_outliers: sorted.len() - filtered.len(),
            last_observed_at,
            median_microunits: None,
            p25_microunits: None,
            p75_microunits: None,
        });
    }
    Ok(FalEmpiricalCostEstimate {
        state: "available",
        provenance: "local-actual",
        sample_count: sorted.len(),
        used_sample_count: filtered.len(),
        rejected_outliers: sorted.len() - filtered.len(),
        last_observed_at,
        median_microunits: Some(percentile(&filtered, 0.5)),
        p25_microunits: Some(percentile(&filtered, 0.25)),
        p75_microunits: Some(percentile(&filtered, 0.75)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    fn sample<'a>(run_id: &'a str, config: &'a Value, cost: i64) -> FalActualCostSample<'a> {
        FalActualCostSample {
            run_id,
            endpoint: "fal-ai/test",
            adapter_schema_hash: "adapter-v1",
            pricing_manifest_version: 7,
            billable_config: config,
            actual_cost_microunits: cost,
        }
    }

    #[test]
    fn survives_restart_and_requires_three_samples() {
        let root = tempdir().unwrap();
        let config = json!({"size":"square","variants":1});
        let store = FalEmpiricalCostStore::initialize(root.path()).unwrap();
        store
            .record_actual(sample("run-1", &config, 10_000))
            .unwrap();
        store
            .record_actual(sample("run-2", &config, 12_000))
            .unwrap();
        let query = FalEmpiricalCostQuery {
            endpoint: "fal-ai/test".into(),
            adapter_schema_hash: "adapter-v1".into(),
            pricing_manifest_version: 7,
            billable_config: json!({"variants":1,"size":"square"}),
        };
        assert_eq!(store.estimate(&query).unwrap().state, "insufficient");
        drop(store);
        let restarted = FalEmpiricalCostStore::initialize(root.path()).unwrap();
        restarted
            .record_actual(sample("run-3", &config, 11_000))
            .unwrap();
        let result = restarted.estimate(&query).unwrap();
        assert_eq!(
            (result.state, result.median_microunits),
            ("available", Some(11_000))
        );
        assert!(result.last_observed_at.is_some());
    }

    #[test]
    fn never_mixes_adapter_or_pricing_versions() {
        let root = tempdir().unwrap();
        let config = json!({"duration":5});
        let store = FalEmpiricalCostStore::initialize(root.path()).unwrap();
        for (run, adapter, pricing) in [
            ("a", "adapter-v1", 7),
            ("b", "adapter-v2", 7),
            ("c", "adapter-v1", 8),
        ] {
            store
                .record_actual(FalActualCostSample {
                    run_id: run,
                    endpoint: "fal-ai/test",
                    adapter_schema_hash: adapter,
                    pricing_manifest_version: pricing,
                    billable_config: &config,
                    actual_cost_microunits: 10_000,
                })
                .unwrap();
        }
        let query = FalEmpiricalCostQuery {
            endpoint: "fal-ai/test".into(),
            adapter_schema_hash: "adapter-v1".into(),
            pricing_manifest_version: 7,
            billable_config: config,
        };
        assert_eq!(store.estimate(&query).unwrap().sample_count, 1);
    }

    #[test]
    fn rejects_extreme_outlier_from_robust_summary() {
        let root = tempdir().unwrap();
        let config = json!({"size":"square"});
        let store = FalEmpiricalCostStore::initialize(root.path()).unwrap();
        for (index, cost) in [10_000, 10_500, 11_000, 11_500, 1_000_000]
            .into_iter()
            .enumerate()
        {
            store
                .record_actual(sample(&format!("run-{index}"), &config, cost))
                .unwrap();
        }
        let result = store
            .estimate(&FalEmpiricalCostQuery {
                endpoint: "fal-ai/test".into(),
                adapter_schema_hash: "adapter-v1".into(),
                pricing_manifest_version: 7,
                billable_config: config,
            })
            .unwrap();
        assert_eq!(result.rejected_outliers, 1);
        assert_eq!(result.median_microunits, Some(10_750));
    }

    #[test]
    fn rejects_prompt_or_media_fields() {
        let root = tempdir().unwrap();
        let store = FalEmpiricalCostStore::initialize(root.path()).unwrap();
        assert!(store
            .record_actual(sample("run-1", &json!({"prompt":"secret"}), 10))
            .is_err());
        assert!(store
            .record_actual(sample("run-2", &json!({"image":"data:image/png"}), 10))
            .is_err());
    }

    #[test]
    fn retention_is_bounded_per_exact_cohort_and_duplicate_run_is_idempotent() {
        let root = tempdir().unwrap();
        let config = json!({"size":"square"});
        let store = FalEmpiricalCostStore::initialize(root.path()).unwrap();
        for index in 0..30 {
            store
                .record_actual(sample(&format!("run-{index:02}"), &config, 10_000 + index))
                .unwrap();
        }
        store
            .record_actual(sample("run-29", &config, 999_999))
            .unwrap();
        let result = store
            .estimate(&FalEmpiricalCostQuery {
                endpoint: "fal-ai/test".into(),
                adapter_schema_hash: "adapter-v1".into(),
                pricing_manifest_version: 7,
                billable_config: config,
            })
            .unwrap();
        assert_eq!(result.sample_count, MAX_SAMPLES_PER_COHORT);
        assert!(result.median_microunits.unwrap() < 20_000);
    }
}
