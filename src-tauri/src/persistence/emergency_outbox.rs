use super::sync_directory;
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use uuid::Uuid;

const VERSION: u8 = 1;
const MAX_ITEMS: usize = 256;
const MAX_ITEM_BYTES: u64 = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
const LIFETIME_DAYS: i64 = 30;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmergencyTextResult {
    pub version: u8,
    pub result_id: String,
    pub run_id: String,
    pub project_id: String,
    pub node_id: String,
    pub model: String,
    pub kind: String,
    pub text: String,
    pub parameters: Value,
    pub cost_microunits: Option<i64>,
    pub created_at: String,
}

#[derive(Clone)]
pub struct EmergencyOutbox {
    root: Arc<PathBuf>,
    lock: Arc<Mutex<()>>,
}

impl EmergencyOutbox {
    pub fn initialize(app_data_dir: &Path) -> Result<Self, String> {
        let root = app_data_dir.join("emergency-stt-outbox");
        std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;
        let outbox = Self {
            root: Arc::new(root),
            lock: Arc::new(Mutex::new(())),
        };
        outbox.with_lock(|this| {
            this.recover_temporary_files()?;
            this.prune_invalid_and_expired()?;
            Ok(())
        })?;
        Ok(outbox)
    }

    pub fn store(&self, item: &EmergencyTextResult) -> Result<(), String> {
        validate(item)?;
        let bytes = serde_json::to_vec(item).map_err(|error| error.to_string())?;
        if bytes.len() as u64 > MAX_ITEM_BYTES {
            return Err("Das bezahlte Notfallergebnis überschreitet das 2-MB-Limit.".into());
        }
        self.with_lock(|this| {
            this.prune_invalid_and_expired()?;
            let files = this.valid_files()?;
            let total = files.iter().map(|(_, size)| *size).sum::<u64>();
            if files.len() >= MAX_ITEMS || total.saturating_add(bytes.len() as u64) > MAX_TOTAL_BYTES {
                return Err("Die begrenzte STT-Notfallablage ist voll. Stelle die lokale Datenbank wieder her und ordne vorhandene Ergebnisse zu.".into());
            }
            let destination = this.root.join(format!("{}.json", item.result_id));
            if destination.exists() {
                return Err("Dieses Notfallergebnis ist bereits gespeichert.".into());
            }
            let temporary = this.root.join(format!(".{}.tmp", item.result_id));
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temporary)
                .map_err(|error| error.to_string())?;
            let operation = (|| {
                file.write_all(&bytes).map_err(|error| error.to_string())?;
                file.sync_all().map_err(|error| error.to_string())?;
                std::fs::rename(&temporary, &destination).map_err(|error| error.to_string())?;
                sync_directory(&this.root)
            })();
            if operation.is_err() {
                let _ = std::fs::remove_file(temporary);
            }
            operation
        })
    }

    pub fn project_results(&self, project_id: &str) -> Result<Vec<EmergencyTextResult>, String> {
        self.with_lock(|this| {
            this.prune_invalid_and_expired()?;
            let mut items = this.read_all()?;
            items.retain(|item| item.project_id == project_id);
            items.sort_by(|left, right| right.created_at.cmp(&left.created_at));
            Ok(items)
        })
    }

    pub fn find(&self, result_id: &str) -> Result<Option<EmergencyTextResult>, String> {
        if Uuid::parse_str(result_id).is_err() {
            return Ok(None);
        }
        self.with_lock(|this| {
            let path = this.root.join(format!("{result_id}.json"));
            if !path.exists() {
                return Ok(None);
            }
            Ok(read_valid(&path).ok())
        })
    }

    pub fn remove(&self, result_id: &str) -> Result<(), String> {
        Uuid::parse_str(result_id).map_err(|_| "Ungültige Ergebnis-ID.".to_string())?;
        self.with_lock(|this| {
            let path = this.root.join(format!("{result_id}.json"));
            if path.exists() {
                std::fs::remove_file(path).map_err(|error| error.to_string())?;
                sync_directory(&this.root)?;
            }
            Ok(())
        })
    }

    fn with_lock<T>(
        &self,
        operation: impl FnOnce(&Self) -> Result<T, String>,
    ) -> Result<T, String> {
        let _guard = self
            .lock
            .lock()
            .map_err(|_| "STT-Notfallablage ist nicht verfügbar.".to_string())?;
        operation(self)
    }

    fn recover_temporary_files(&self) -> Result<(), String> {
        for entry in std::fs::read_dir(&*self.root).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.starts_with('.') || !name.ends_with(".tmp") {
                continue;
            }
            let path = entry.path();
            if let Ok(item) = read_valid(&path) {
                let destination = self.root.join(format!("{}.json", item.result_id));
                if !destination.exists() {
                    std::fs::rename(&path, destination).map_err(|error| error.to_string())?;
                    continue;
                }
            }
            let _ = std::fs::remove_file(path);
        }
        sync_directory(&self.root)
    }

    fn prune_invalid_and_expired(&self) -> Result<(), String> {
        let now = Utc::now();
        for entry in std::fs::read_dir(&*self.root).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let remove = read_valid(&path).map_or(true, |item| {
                DateTime::parse_from_rfc3339(&item.created_at)
                    .map(|created| {
                        now.signed_duration_since(created.with_timezone(&Utc))
                            > Duration::days(LIFETIME_DAYS)
                    })
                    .unwrap_or(true)
            });
            if remove {
                let _ = std::fs::remove_file(path);
            }
        }
        sync_directory(&self.root)
    }

    fn valid_files(&self) -> Result<Vec<(PathBuf, u64)>, String> {
        Ok(std::fs::read_dir(&*self.root)
            .map_err(|error| error.to_string())?
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let metadata = entry.metadata().ok()?;
                (entry.path().extension().and_then(|value| value.to_str()) == Some("json")
                    && metadata.is_file())
                .then_some((entry.path(), metadata.len()))
            })
            .collect())
    }

    fn read_all(&self) -> Result<Vec<EmergencyTextResult>, String> {
        Ok(self
            .valid_files()?
            .into_iter()
            .filter_map(|(path, _)| read_valid(&path).ok())
            .collect())
    }
}

fn read_valid(path: &Path) -> Result<EmergencyTextResult, String> {
    let metadata = std::fs::metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_ITEM_BYTES {
        return Err("Ungültige Notfallablage-Datei.".into());
    }
    let item: EmergencyTextResult =
        serde_json::from_slice(&std::fs::read(path).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
    validate(&item)?;
    Ok(item)
}

fn validate(item: &EmergencyTextResult) -> Result<(), String> {
    if item.version != VERSION
        || Uuid::parse_str(&item.result_id).is_err()
        || Uuid::parse_str(&item.run_id).is_err()
        || Uuid::parse_str(&item.project_id).is_err()
        || item.node_id.is_empty()
        || item.node_id.len() > 200
        || item.model.is_empty()
        || item.model.len() > 200
        || item.kind != "transcription"
        || item.text.trim().is_empty()
        || item.text.len() > 1024 * 1024
        || item.cost_microunits.is_some_and(|cost| cost < 0)
        || !item.parameters.is_object()
        || DateTime::parse_from_rfc3339(&item.created_at).is_err()
    {
        return Err("Ungültiges bezahltes STT-Notfallergebnis.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item() -> EmergencyTextResult {
        EmergencyTextResult {
            version: VERSION,
            result_id: Uuid::new_v4().to_string(),
            run_id: Uuid::new_v4().to_string(),
            project_id: Uuid::new_v4().to_string(),
            node_id: "stt".into(),
            model: "openai/whisper-1".into(),
            kind: "transcription".into(),
            text: "Paid transcript".into(),
            parameters: serde_json::json!({"orphaned":true,"timestampData":{"segments":[],"words":[]}}),
            cost_microunits: Some(200),
            created_at: Utc::now().to_rfc3339(),
        }
    }

    #[test]
    fn persists_recovers_and_removes_paid_result_durably() {
        let temp = tempfile::tempdir().unwrap();
        let record = item();
        let outbox = EmergencyOutbox::initialize(temp.path()).unwrap();
        outbox.store(&record).unwrap();
        drop(outbox);
        let reopened = EmergencyOutbox::initialize(temp.path()).unwrap();
        assert_eq!(
            reopened.project_results(&record.project_id).unwrap()[0].text,
            record.text
        );
        reopened.remove(&record.result_id).unwrap();
        assert!(reopened
            .project_results(&record.project_id)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn salvages_complete_temp_and_prunes_expired_or_invalid_files() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("emergency-stt-outbox");
        std::fs::create_dir_all(&root).unwrap();
        let record = item();
        std::fs::write(
            root.join(format!(".{}.tmp", record.result_id)),
            serde_json::to_vec(&record).unwrap(),
        )
        .unwrap();
        std::fs::write(root.join("broken.json"), b"nope").unwrap();
        let outbox = EmergencyOutbox::initialize(temp.path()).unwrap();
        assert!(outbox.find(&record.result_id).unwrap().is_some());
        assert!(!root.join("broken.json").exists());
    }
}
