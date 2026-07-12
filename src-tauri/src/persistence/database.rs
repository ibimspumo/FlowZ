use super::{BlobMetadata, MediaMetadata, ProjectDocument};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

const DATABASE_SCHEMA_VERSION: i64 = 12;
static SCHEMA_MIGRATION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
#[cfg(test)]
type ReferenceTestHook = Option<(Arc<std::sync::Barrier>, Arc<std::sync::Barrier>)>;
fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value.chars().all(|character| {
            character.is_ascii_hexdigit()
                && (!character.is_ascii_alphabetic() || character.is_ascii_lowercase())
        })
}

#[derive(Clone, Debug)]
pub struct Database {
    path: PathBuf,
    reference_lock: Arc<Mutex<()>>,
    #[cfg(test)]
    reference_test_hook: Arc<Mutex<ReferenceTestHook>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryUsage {
    pub blob_count: u64,
    pub blob_bytes: u64,
    pub asset_count: u64,
    pub project_count: u64,
    pub run_count: u64,
    pub cost_microunits: i64,
    pub cost_decimal: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageBreakdown {
    pub total_bytes: u64,
    pub total_blobs: u64,
    pub projects: Vec<StorageProjectRow>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageProjectRow {
    pub project_id: String,
    pub project_name: String,
    pub node_id: String,
    pub media_type: String,
    pub referenced_bytes: u64,
    pub result_count: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostBreakdown {
    pub actual_microunits: i64,
    pub estimated_microunits: i64,
    pub unknown_runs: u64,
    pub rows: Vec<CostRow>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostRow {
    pub node_id: String,
    pub model: String,
    pub day: String,
    pub provenance: String,
    pub amount_microunits: Option<i64>,
    pub runs: u64,
}

#[derive(Debug)]
pub struct DeleteOutcome {
    pub removed_results: u64,
    pub orphaned_hashes: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct FontProvenanceRecord {
    pub font_hash: String,
    pub license_blob_hash: String,
    pub contract: Value,
    pub selections: Vec<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredResult {
    pub result_id: String,
    pub run_id: String,
    pub project_id: String,
    pub node_id: String,
    pub kind: String,
    pub text_value: Option<String>,
    pub blob_hash: Option<String>,
    pub asset_id: Option<String>,
    pub media_type: Option<String>,
    pub created_at: String,
    pub cost_microunits: Option<i64>,
    pub model: Option<String>,
    pub prompt: Option<String>,
    pub parameters: Option<Value>,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryResultPage {
    pub items: Vec<StoredResult>,
    pub total: i64,
    pub page: i64,
    pub page_size: i64,
}

#[derive(Debug, Clone)]
pub struct StoredResultContent {
    pub result_id: String,
    pub text_value: Option<String>,
    pub blob_hash: Option<String>,
    pub media_type: Option<String>,
}
#[derive(Clone, Debug)]
pub struct LocalImageBinding {
    pub source_node_id: String,
    pub mode: String,
    pub result_ids: Vec<String>,
    pub expected_hashes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryAssetSummary {
    pub asset_id: String,
    pub version_id: String,
    pub version: i64,
    pub name: String,
    pub kind: String,
    pub preview_text: Option<String>,
    pub media_type: Option<String>,
    pub created_at: String,
    pub source_project_id: Option<String>,
    pub source_node_id: Option<String>,
    pub source_result_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryAssetPage {
    pub items: Vec<LibraryAssetSummary>,
    pub total: i64,
    pub page: i64,
    pub page_size: i64,
}

#[derive(Debug, Clone)]
pub struct LibraryAssetContent {
    pub summary: LibraryAssetSummary,
    pub text_value: Option<String>,
    pub blob_hash: Option<String>,
}

pub struct FalVideoCommit<'a> {
    pub run_id: &'a str,
    pub project_id: &'a str,
    pub node_id: &'a str,
    pub endpoint: &'a str,
    pub result_id: &'a str,
    pub video_asset_id: &'a str,
    pub start_result_id: &'a str,
    pub start_asset_id: &'a str,
    pub end_result_id: &'a str,
    pub end_asset_id: &'a str,
    pub video: &'a BlobMetadata,
    pub poster: Option<&'a BlobMetadata>,
    pub start: &'a BlobMetadata,
    pub end: &'a BlobMetadata,
    pub metadata: &'a MediaMetadata,
    pub prompt: &'a str,
    pub parameters: &'a Value,
    pub cost_microunits: Option<i64>,
    pub activate: bool,
    pub created_at: &'a str,
}

pub struct FalImageVariantCommit<'a> {
    pub result_id: &'a str,
    pub asset_id: &'a str,
    pub blob: &'a BlobMetadata,
    pub parameters: &'a Value,
}

pub struct FalImageCommit<'a> {
    pub run_id: &'a str,
    pub project_id: &'a str,
    pub node_id: &'a str,
    pub endpoint: &'a str,
    pub prompt: &'a str,
    pub variants: &'a [FalImageVariantCommit<'a>],
    pub cost_microunits: Option<i64>,
    pub activate: bool,
    pub error_code: Option<&'a str>,
    pub created_at: &'a str,
}

impl Database {
    pub fn library_asset_version_matches(
        &self,
        version_id: &str,
        blob_hash: &str,
    ) -> Result<bool, String> {
        self.with_connection(|connection| {
            connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM library_asset_versions WHERE id=?1 AND blob_hash=?2)",
                params![version_id, blob_hash],
                |row| row.get(0),
            )
        })
    }
    pub fn blob_media_type(&self, hash: &str) -> Result<String, String> {
        self.with_connection(|connection| {
            connection.query_row(
                "SELECT media_type FROM blobs WHERE hash=?1",
                [hash],
                |row| row.get(0),
            )
        })
    }
    pub fn record_fal_image_results_atomic(
        &self,
        item: FalImageCommit<'_>,
    ) -> Result<Vec<StoredResult>, String> {
        if item.variants.is_empty() {
            return Err("Fal-Bildlauf besitzt keine Varianten.".into());
        }
        self.with_connection(|connection| {
            let tx = connection.transaction()?;
            let existing_count: i64 = tx.query_row("SELECT COUNT(*) FROM results WHERE run_id=?1 AND kind='image'", [item.run_id], |row| row.get(0))?;
            if existing_count == 0 {
                for variant in item.variants {
                    tx.execute("INSERT INTO blobs(hash,size_bytes,media_type,relative_path,created_at) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(hash) DO UPDATE SET size_bytes=excluded.size_bytes,media_type=excluded.media_type,relative_path=excluded.relative_path", params![variant.blob.hash,variant.blob.size_bytes as i64,variant.blob.media_type,variant.blob.relative_path,variant.blob.created_at.to_rfc3339()])?;
                }
                let status = if item.error_code.is_some() { "failed" } else { "success" };
                tx.execute("INSERT INTO runs(id,project_id,node_id,provider,model,status,started_at,finished_at,error_code) VALUES(?1,?2,?3,'fal.ai',?4,?5,?6,?6,?7)", params![item.run_id,item.project_id,item.node_id,item.endpoint,status,item.created_at,item.error_code])?;
                if let Some(cost) = item.cost_microunits { tx.execute("INSERT INTO costs(run_id,currency,amount_microunits,created_at,provenance) VALUES(?1,'USD',?2,?3,?4)", params![item.run_id,cost,item.created_at,cost_provenance(item.variants.first().map(|v|v.parameters))])?; }
                for variant in item.variants {
                    tx.execute("INSERT INTO assets(id,project_id,blob_hash,name,kind,metadata_json,created_at) VALUES(?1,?2,?3,'fal.ai Bild','image','{}',?4)", params![variant.asset_id,item.project_id,variant.blob.hash,item.created_at])?;
                    let parameters = serde_json::to_string(variant.parameters).map_err(|error| rusqlite::Error::ToSqlConversionFailure(error.into()))?;
                    tx.execute("INSERT INTO results(id,run_id,kind,text_value,blob_hash,asset_id,prompt,parameters_json,created_at) VALUES(?1,?2,'image',NULL,?3,?4,?5,?6,?7)", params![variant.result_id,item.run_id,variant.blob.hash,variant.asset_id,item.prompt,parameters,item.created_at])?;
                }
                if item.activate { tx.execute("INSERT INTO active_results(project_id,node_id,result_id) VALUES(?1,?2,?3) ON CONFLICT(project_id,node_id) DO UPDATE SET result_id=excluded.result_id", params![item.project_id,item.node_id,item.variants[0].result_id])?; }
            }
            let mut statement = tx.prepare("SELECT r.id,r.kind,r.blob_hash,r.asset_id,b.media_type,r.created_at,c.amount_microunits,u.model,r.prompt,r.parameters_json,EXISTS(SELECT 1 FROM active_results a WHERE a.result_id=r.id) FROM results r JOIN runs u ON u.id=r.run_id LEFT JOIN blobs b ON b.hash=r.blob_hash LEFT JOIN costs c ON c.run_id=u.id WHERE u.id=?1 AND r.kind='image' ORDER BY r.created_at,r.id")?;
            let stored = statement.query_map([item.run_id], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,Option<String>>(2)?,row.get::<_,Option<String>>(3)?,row.get::<_,Option<String>>(4)?,row.get::<_,String>(5)?,row.get::<_,Option<i64>>(6)?,row.get::<_,Option<String>>(7)?,row.get::<_,Option<String>>(8)?,row.get::<_,Option<String>>(9)?,row.get::<_,bool>(10)?)))?.collect::<Result<Vec<_>,_>>()?;
            drop(statement);
            tx.commit()?;
            Ok(stored.into_iter().map(|row| StoredResult { result_id:row.0,run_id:item.run_id.into(),project_id:item.project_id.into(),node_id:item.node_id.into(),kind:row.1,text_value:None,blob_hash:row.2,asset_id:row.3,media_type:row.4,created_at:row.5,cost_microunits:row.6,model:row.7,prompt:row.8,parameters:row.9.and_then(|raw|serde_json::from_str(&raw).ok()),active:row.10 }).collect())
        })
    }
    pub fn result_for_run(&self, run_id: &str, kind: &str) -> Result<Option<StoredResult>, String> {
        self.with_connection(|connection| {
            let mut statement = connection.prepare("SELECT r.id,u.project_id,COALESCE(u.node_id,''),r.kind,r.text_value,r.blob_hash,r.asset_id,b.media_type,r.created_at,c.amount_microunits,u.model,r.prompt,r.parameters_json,EXISTS(SELECT 1 FROM active_results a WHERE a.result_id=r.id) FROM results r JOIN runs u ON u.id=r.run_id LEFT JOIN blobs b ON b.hash=r.blob_hash LEFT JOIN costs c ON c.run_id=u.id WHERE u.id=?1 AND r.kind=?2 LIMIT 1")?;
            let mut rows = statement.query(params![run_id, kind])?;
            let Some(row) = rows.next()? else { return Ok(None) };
            let raw: Option<String> = row.get(12)?;
            Ok(Some(StoredResult { result_id: row.get(0)?, run_id: run_id.into(), project_id: row.get(1)?, node_id: row.get(2)?, kind: row.get(3)?, text_value: row.get(4)?, blob_hash: row.get(5)?, asset_id: row.get(6)?, media_type: row.get(7)?, created_at: row.get(8)?, cost_microunits: row.get(9)?, model: row.get(10)?, prompt: row.get(11)?, parameters: raw.and_then(|value| serde_json::from_str(&value).ok()), active: row.get(13)? }))
        })
    }
    pub fn media_metadata(&self, hash: &str) -> Result<(MediaMetadata, Option<String>), String> {
        self.with_connection(|connection| {
            let (raw, poster): (String, Option<String>) = connection.query_row(
                "SELECT metadata_json,poster_blob_hash FROM media_metadata WHERE blob_hash=?1",
                [hash],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            let metadata = serde_json::from_str(&raw).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    error.into(),
                )
            })?;
            Ok((metadata, poster))
        })
    }
    pub fn record_fal_video_result_atomic(
        &self,
        item: FalVideoCommit<'_>,
    ) -> Result<StoredResult, String> {
        self.with_connection(|connection| {
            let tx = connection.transaction()?;
            if let Ok(existing) = tx.query_row(
                "SELECT r.id,r.kind,r.blob_hash,r.asset_id,b.media_type,r.created_at,c.amount_microunits,u.model,r.prompt,r.parameters_json,EXISTS(SELECT 1 FROM active_results a WHERE a.result_id=r.id) FROM results r JOIN runs u ON u.id=r.run_id LEFT JOIN blobs b ON b.hash=r.blob_hash LEFT JOIN costs c ON c.run_id=u.id WHERE u.id=?1 AND r.kind='video' LIMIT 1",
                [item.run_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?, row.get::<_, Option<String>>(3)?, row.get::<_, Option<String>>(4)?, row.get::<_, String>(5)?, row.get::<_, Option<i64>>(6)?, row.get::<_, Option<String>>(7)?, row.get::<_, Option<String>>(8)?, row.get::<_, Option<String>>(9)?, row.get::<_, bool>(10)?))) {
                tx.commit()?;
                return Ok(StoredResult { result_id: existing.0, run_id: item.run_id.into(), project_id: item.project_id.into(), node_id: item.node_id.into(), kind: existing.1, text_value: None, blob_hash: existing.2, asset_id: existing.3, media_type: existing.4, created_at: existing.5, cost_microunits: existing.6, model: existing.7, prompt: existing.8, parameters: existing.9.and_then(|raw| serde_json::from_str(&raw).ok()), active: existing.10 });
            }
            for blob in [item.video, item.start, item.end].into_iter().chain(item.poster) {
                tx.execute("INSERT INTO blobs(hash,size_bytes,media_type,relative_path,created_at) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(hash) DO UPDATE SET size_bytes=excluded.size_bytes,media_type=excluded.media_type,relative_path=excluded.relative_path", params![blob.hash,blob.size_bytes as i64,blob.media_type,blob.relative_path,blob.created_at.to_rfc3339()])?;
            }
            let metadata_json = serde_json::to_string(item.metadata).map_err(|error| rusqlite::Error::ToSqlConversionFailure(error.into()))?;
            tx.execute("INSERT INTO media_metadata(blob_hash,kind,metadata_json,poster_blob_hash) VALUES(?1,'video',?2,?3) ON CONFLICT(blob_hash) DO UPDATE SET metadata_json=excluded.metadata_json,poster_blob_hash=excluded.poster_blob_hash", params![item.video.hash,metadata_json,item.poster.map(|blob| blob.hash.as_str())])?;
            tx.execute("INSERT INTO runs(id,project_id,node_id,provider,model,status,started_at,finished_at,error_code) VALUES(?1,?2,?3,'fal.ai',?4,'success',?5,?5,NULL)", params![item.run_id,item.project_id,item.node_id,item.endpoint,item.created_at])?;
            if let Some(cost) = item.cost_microunits { tx.execute("INSERT INTO costs(run_id,currency,amount_microunits,created_at,provenance) VALUES(?1,'USD',?2,?3,?4)", params![item.run_id,cost,item.created_at,cost_provenance(Some(item.parameters))])?; }
            for (asset_id, blob, name, kind) in [(item.video_asset_id,item.video,"fal.ai Video","video"),(item.start_asset_id,item.start,"Video Startbild","image"),(item.end_asset_id,item.end,"Video Endbild","image")] {
                tx.execute("INSERT INTO assets(id,project_id,blob_hash,name,kind,metadata_json,created_at) VALUES(?1,?2,?3,?4,?5,'{}',?6)", params![asset_id,item.project_id,blob.hash,name,kind,item.created_at])?;
            }
            let params_json = serde_json::to_string(item.parameters).map_err(|error| rusqlite::Error::ToSqlConversionFailure(error.into()))?;
            tx.execute("INSERT INTO results(id,run_id,kind,text_value,blob_hash,asset_id,prompt,parameters_json,created_at) VALUES(?1,?2,'video',NULL,?3,?4,?5,?6,?7)", params![item.result_id,item.run_id,item.video.hash,item.video_asset_id,item.prompt,params_json,item.created_at])?;
            for (result_id, blob, asset_id, kind) in [(item.start_result_id,item.start,item.start_asset_id,"video-start-frame"),(item.end_result_id,item.end,item.end_asset_id,"video-end-frame")] {
                tx.execute("INSERT INTO results(id,run_id,kind,text_value,blob_hash,asset_id,prompt,parameters_json,created_at) VALUES(?1,?2,?3,NULL,?4,?5,NULL,?6,?7)", params![result_id,item.run_id,kind,blob.hash,asset_id,serde_json::to_string(&serde_json::json!({"sourceVideoResultId":item.result_id})).unwrap(),item.created_at])?;
            }
            if item.activate { tx.execute("INSERT INTO active_results(project_id,node_id,result_id) VALUES(?1,?2,?3) ON CONFLICT(project_id,node_id) DO UPDATE SET result_id=excluded.result_id", params![item.project_id,item.node_id,item.result_id])?; }
            tx.commit()?;
            Ok(StoredResult { result_id: item.result_id.into(), run_id: item.run_id.into(), project_id: item.project_id.into(), node_id: item.node_id.into(), kind: "video".into(), text_value: None, blob_hash: Some(item.video.hash.clone()), asset_id: Some(item.video_asset_id.into()), media_type: Some(item.video.media_type.clone()), created_at: item.created_at.into(), cost_microunits: item.cost_microunits, model: Some(item.endpoint.into()), prompt: Some(item.prompt.into()), parameters: Some(item.parameters.clone()), active: item.activate })
        })
    }
    #[allow(clippy::type_complexity)]
    pub fn active_result_identity(
        &self,
        project_id: &str,
        node_id: &str,
    ) -> Result<Option<(String, Option<String>, Option<String>)>, String> {
        self.with_connection(|connection| {
            let mut statement = connection.prepare("SELECT r.id,r.blob_hash,r.text_value FROM active_results a JOIN results r ON r.id=a.result_id WHERE a.project_id=?1 AND a.node_id=?2")?;
            let mut rows = statement.query(params![project_id, node_id])?;
            rows.next()?.map(|row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).transpose()
        })
    }
    pub fn run_target(&self, run_id: &str) -> Result<Option<(String, String)>, String> {
        self.with_connection(|connection| {
            let mut statement =
                connection.prepare("SELECT project_id,node_id FROM runs WHERE id=?1")?;
            let mut rows = statement.query([run_id])?;
            rows.next()?
                .map(|row| {
                    row.get::<_, String>(0)
                        .and_then(|project| row.get::<_, String>(1).map(|node| (project, node)))
                })
                .transpose()
        })
    }

    #[cfg(test)]
    pub fn new(path: PathBuf) -> Result<Self, String> {
        Self::new_with_reference_lock(path, Arc::new(Mutex::new(())))
    }
    pub(crate) fn new_with_reference_lock(
        path: PathBuf,
        reference_lock: Arc<Mutex<()>>,
    ) -> Result<Self, String> {
        let database = Self {
            path,
            reference_lock,
            #[cfg(test)]
            reference_test_hook: Arc::new(Mutex::new(None)),
        };
        database.migrate()?;
        Ok(database)
    }

    fn migrate(&self) -> Result<(), String> {
        let _schema_guard = SCHEMA_MIGRATION_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .map_err(|_| "Die Datenbankschema-Sperre ist beschädigt.".to_string())?;
        let mut connection = self.connection()?;
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(|e| e.to_string())?;
        if version > DATABASE_SCHEMA_VERSION {
            return Err(format!("Die Bibliotheksdatenbank verwendet Version {version}; unterstützt wird höchstens {DATABASE_SCHEMA_VERSION}."));
        }
        if version == DATABASE_SCHEMA_VERSION && validate_current_schema(&connection).is_ok() {
            return Ok(());
        }
        connection
            .execute_batch("PRAGMA wal_checkpoint(FULL);")
            .map_err(|e| e.to_string())?;
        if self.path.exists() && fs::metadata(&self.path).map_err(|e| e.to_string())?.len() > 0 {
            backup_database(&self.path)?;
        }
        let tx = connection.transaction().map_err(|e| e.to_string())?;
        create_base_schema(&tx).map_err(|e| e.to_string())?;
        if version < 2 {
            migrate_to_v2(&tx).map_err(|e| e.to_string())?;
        }
        if version < 3 {
            migrate_v2_to_v3(&tx).map_err(|e| e.to_string())?;
        }
        if version < 4 {
            migrate_v3_to_v4(&tx).map_err(|e| e.to_string())?;
        }
        if version < 5 {
            migrate_v4_to_v5(&tx).map_err(|e| e.to_string())?;
        }
        if version < 6 {
            migrate_v5_to_v6(&tx).map_err(|e| e.to_string())?;
        }
        if version < 7 {
            migrate_v6_to_v7(&tx).map_err(|e| e.to_string())?;
        }
        if version < 8 {
            migrate_v7_to_v8(&tx).map_err(|e| e.to_string())?;
        }
        if version < 9 {
            migrate_v8_to_v9(&tx).map_err(|e| e.to_string())?;
        }
        if version < 10 {
            migrate_v9_to_v10(&tx).map_err(|e| e.to_string())?;
        }
        if version < 11 {
            migrate_v10_to_v11(&tx).map_err(|e| e.to_string())?;
        }
        if version < 12 {
            migrate_v11_to_v12(&tx).map_err(|e| e.to_string())?;
        }
        repair_current_schema(&tx).map_err(|e| e.to_string())?;
        validate_current_schema(&tx).map_err(|e| e.to_string())?;
        tx.pragma_update(None, "user_version", DATABASE_SCHEMA_VERSION)
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn reconcile_blobs(&self, blobs: &[BlobMetadata]) -> Result<(), String> {
        self.with_connection(|connection| {
            let transaction = connection.transaction()?;
            for blob in blobs { transaction.execute("INSERT INTO blobs(hash,size_bytes,media_type,relative_path,created_at) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(hash) DO UPDATE SET size_bytes=excluded.size_bytes,media_type=excluded.media_type,relative_path=excluded.relative_path", params![blob.hash,blob.size_bytes as i64,blob.media_type,blob.relative_path,blob.created_at.to_rfc3339()])?; }
            let physical = serde_json::to_string(&blobs.iter().map(|b|&b.hash).collect::<Vec<_>>()).map_err(|e|rusqlite::Error::ToSqlConversionFailure(e.into()))?;
            transaction.execute("DELETE FROM assets WHERE blob_hash NOT IN (SELECT value FROM json_each(?1))", [&physical])?;
            transaction.execute("UPDATE results SET blob_hash=NULL WHERE blob_hash IS NOT NULL AND blob_hash NOT IN (SELECT value FROM json_each(?1))", [&physical])?;
            transaction.execute("DELETE FROM library_asset_versions WHERE blob_hash IS NOT NULL AND blob_hash NOT IN (SELECT value FROM json_each(?1))", [&physical])?;
            transaction.execute("DELETE FROM blobs WHERE hash NOT IN (SELECT value FROM json_each(?1)) AND hash NOT IN (SELECT thumbnail_blob_hash FROM library_asset_versions WHERE thumbnail_blob_hash IS NOT NULL) AND hash NOT IN (SELECT poster_blob_hash FROM media_metadata WHERE poster_blob_hash IS NOT NULL) AND hash NOT IN (SELECT blob_hash FROM document_covers)", [&physical])?;
            transaction.commit()?; Ok(())
        })
    }

    pub fn upsert_project(&self, project: &ProjectDocument) -> Result<(), String> {
        self.with_connection(|connection| upsert_project_row(connection, project))
    }
    pub(crate) fn catalog_upsert_project_locked(
        &self,
        project: &ProjectDocument,
    ) -> Result<(), String> {
        self.with_catalog_connection(|connection| upsert_project_row(connection, project))
    }
    pub fn upsert_blob(&self, blob: &BlobMetadata) -> Result<(), String> {
        self.with_connection(|c| { c.execute("INSERT INTO blobs(hash,size_bytes,media_type,relative_path,created_at) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(hash) DO UPDATE SET size_bytes=excluded.size_bytes,media_type=excluded.media_type,relative_path=excluded.relative_path", params![blob.hash,blob.size_bytes as i64,blob.media_type,blob.relative_path,blob.created_at.to_rfc3339()])?; Ok(()) })
    }

    pub fn contains_blob(&self, hash: &str) -> Result<bool, String> {
        self.with_connection(|connection| {
            connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM blobs WHERE hash=?1)",
                [hash],
                |row| row.get(0),
            )
        })
    }

    pub fn record_font_provenance(
        &self,
        font_hash: &str,
        license_blob_hash: &str,
        contract: &Value,
        selection: &Value,
    ) -> Result<(), String> {
        if !valid_hash(font_hash)
            || !valid_hash(license_blob_hash)
            || !contract.is_object()
            || !selection.is_object()
        {
            return Err("Ungültiger Font-Provenienzvertrag.".into());
        }
        self.with_connection(|connection| {
            let tx=connection.transaction()?;
            let existing=tx.query_row("SELECT license_blob_hash,contract_json,selections_json FROM font_provenance WHERE font_hash=?1",[font_hash],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?))).ok();
            let mut selections=Vec::<Value>::new();
            if let Some((stored_license,stored_contract,stored_selections))=existing {
                let stored_contract:Value=serde_json::from_str(&stored_contract).map_err(|error|rusqlite::Error::FromSqlConversionFailure(1,rusqlite::types::Type::Text,error.into()))?;
                if stored_license!=license_blob_hash||stored_contract!=*contract { return Err(rusqlite::Error::InvalidParameterName("Font-Provenienz stimmt nicht mit dem unveränderlichen gespeicherten Vertrag überein.".into())); }
                selections=serde_json::from_str(&stored_selections).map_err(|error|rusqlite::Error::FromSqlConversionFailure(2,rusqlite::types::Type::Text,error.into()))?;
            }
            if !selections.contains(selection){selections.push(selection.clone());}
            let contract_json=serde_json::to_string(contract).map_err(|error|rusqlite::Error::ToSqlConversionFailure(error.into()))?;
            let selections_json=serde_json::to_string(&selections).map_err(|error|rusqlite::Error::ToSqlConversionFailure(error.into()))?;
            tx.execute("INSERT INTO font_provenance(font_hash,license_blob_hash,contract_json,selections_json) VALUES(?1,?2,?3,?4) ON CONFLICT(font_hash) DO UPDATE SET selections_json=excluded.selections_json",params![font_hash,license_blob_hash,contract_json,selections_json])?;
            tx.commit()
        })
    }

    pub fn font_provenance(&self, font_hash: &str) -> Result<Option<FontProvenanceRecord>, String> {
        self.with_connection(|connection|connection.query_row("SELECT license_blob_hash,contract_json,selections_json FROM font_provenance WHERE font_hash=?1",[font_hash],|row|{let contract:String=row.get(1)?;let selections:String=row.get(2)?;Ok(FontProvenanceRecord{font_hash:font_hash.into(),license_blob_hash:row.get(0)?,contract:serde_json::from_str(&contract).map_err(|error|rusqlite::Error::FromSqlConversionFailure(1,rusqlite::types::Type::Text,error.into()))?,selections:serde_json::from_str(&selections).map_err(|error|rusqlite::Error::FromSqlConversionFailure(2,rusqlite::types::Type::Text,error.into()))?})}).optional())
    }

    pub fn delete_font_cache_blobs_atomic(
        &self,
        font_hash: &str,
        license_hash: &str,
        project_precheck: impl FnOnce() -> Result<(), String>,
        remove_physical: impl Fn(&str) -> Result<(), String>,
    ) -> Result<Vec<String>, String> {
        let _guard = self
            .reference_lock
            .lock()
            .map_err(|_| "Referenzsperre ist beschädigt.".to_string())?;
        project_precheck()?;
        let mut connection = self.connection()?;
        let tx = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        let referenced = |hash: &str| -> Result<bool, String> {
            tx.query_row("SELECT EXISTS(SELECT 1 FROM results WHERE blob_hash=?1 OR text_value LIKE '%'||?1||'%' OR parameters_json LIKE '%'||?1||'%' UNION ALL SELECT 1 FROM assets WHERE blob_hash=?1 UNION ALL SELECT 1 FROM library_asset_versions WHERE blob_hash=?1 OR thumbnail_blob_hash=?1 UNION ALL SELECT 1 FROM media_metadata WHERE blob_hash=?1 OR poster_blob_hash=?1 LIMIT 1)",[hash],|row|row.get(0)).map_err(|error|error.to_string())
        };
        if referenced(font_hash)? || referenced(license_hash)? {
            return Err("Diese Schrift wird noch von einem Ergebnis oder Asset verwendet.".into());
        }
        tx.execute(
            "DELETE FROM font_provenance WHERE font_hash=?1",
            [font_hash],
        )
        .map_err(|error| error.to_string())?;
        let removed_font=tx.execute("DELETE FROM blobs WHERE hash=?1 AND NOT EXISTS(SELECT 1 FROM font_provenance WHERE font_hash=?1 OR license_blob_hash=?1)",[font_hash]).map_err(|error|error.to_string())?;
        if removed_font != 1 {
            return Err(
                "Font-Blob konnte wegen einer bestehenden Referenz nicht gelöscht werden.".into(),
            );
        }
        let removed_license=tx.execute("DELETE FROM blobs WHERE hash=?1 AND NOT EXISTS(SELECT 1 FROM font_provenance WHERE font_hash=?1 OR license_blob_hash=?1)",[license_hash]).map_err(|error|error.to_string())?;
        tx.commit().map_err(|error| error.to_string())?;
        let mut removed = vec![font_hash.to_owned()];
        if removed_license == 1 {
            removed.push(license_hash.to_owned());
        }
        for hash in &removed {
            remove_physical(hash)?;
        }
        Ok(removed)
    }

    pub fn validates_audio_source(
        &self,
        project_id: &str,
        node_id: &str,
        result_id: &str,
        blob_hash: &str,
    ) -> Result<bool, String> {
        self.with_connection(|connection| {
            connection.query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM results r
                   JOIN runs u ON u.id=r.run_id
                   JOIN blobs b ON b.hash=r.blob_hash
                   WHERE r.id=?1 AND u.project_id=?2 AND u.node_id=?3
                     AND r.blob_hash=?4 AND b.media_type LIKE 'audio/%'
                 )",
                params![result_id, project_id, node_id, blob_hash],
                |row| row.get(0),
            )
        })
    }

    pub fn take_unreferenced_blobs(&self) -> Result<Vec<String>, String> {
        self.with_connection(|connection| {
            let transaction = connection.transaction()?;
            let mut statement = transaction.prepare(
                "SELECT hash FROM blobs b WHERE
                 NOT EXISTS(SELECT 1 FROM assets a WHERE a.blob_hash=b.hash) AND
                 NOT EXISTS(SELECT 1 FROM results r WHERE r.blob_hash=b.hash) AND
                 NOT EXISTS(SELECT 1 FROM library_asset_versions v WHERE v.blob_hash=b.hash OR v.thumbnail_blob_hash=b.hash) AND
                 NOT EXISTS(SELECT 1 FROM media_metadata m WHERE m.blob_hash=b.hash OR m.poster_blob_hash=b.hash) AND
                 NOT EXISTS(SELECT 1 FROM document_covers c WHERE c.blob_hash=b.hash)"
            )?;
            let hashes: Vec<String> = statement.query_map([], |row| row.get(0))?.collect::<Result<_,_>>()?;
            drop(statement);
            for hash in &hashes { transaction.execute("DELETE FROM blobs WHERE hash=?1", [hash])?; }
            transaction.commit()?;
            Ok(hashes)
        })
    }

    /// Releases one CAS row only after every durable reference class has been
    /// checked. Callers that mutate references must hold FlowZ's shared
    /// reference lock for the whole mutation and release sequence.
    pub(crate) fn release_blob_if_unreferenced(&self, hash: &str) -> Result<bool, String> {
        self.with_catalog_connection(|connection| {
            Ok(connection.execute(
                "DELETE FROM blobs WHERE hash=?1 AND
                 NOT EXISTS(SELECT 1 FROM assets a WHERE a.blob_hash=?1) AND
                 NOT EXISTS(SELECT 1 FROM results r WHERE r.blob_hash=?1) AND
                 NOT EXISTS(SELECT 1 FROM library_asset_versions v WHERE v.blob_hash=?1 OR v.thumbnail_blob_hash=?1) AND
                 NOT EXISTS(SELECT 1 FROM media_metadata m WHERE m.blob_hash=?1 OR m.poster_blob_hash=?1) AND
                 NOT EXISTS(SELECT 1 FROM document_covers c WHERE c.blob_hash=?1)",
                [hash],
            )? == 1)
        })
    }

    pub fn record_media_import(
        &self,
        project_id: &str,
        node_id: &str,
        blob: &BlobMetadata,
        metadata: &MediaMetadata,
        poster_blob: Option<&BlobMetadata>,
    ) -> Result<(String, String), String> {
        let run_id = uuid::Uuid::new_v4().to_string();
        let result_id = uuid::Uuid::new_v4().to_string();
        let asset_id = uuid::Uuid::new_v4().to_string();
        let created_at = chrono::Utc::now().to_rfc3339();
        let metadata_json = serde_json::to_string(metadata).map_err(|error| error.to_string())?;
        let parameters = serde_json::json!({
            "durationSeconds": metadata.duration_seconds, "container": metadata.container,
            "codecs": metadata.codecs.join(" + "), "width": metadata.width, "height": metadata.height,
            "fps": metadata.fps, "sampleRate": metadata.sample_rate, "channels": metadata.channels,
            "posterHash": poster_blob.map(|blob| blob.hash.as_str()),
            "fileName": blob.original_name,
            "playable": metadata.playable,
            "playbackWarning": metadata.playback_warning,
        });
        let parameters_json =
            serde_json::to_string(&parameters).map_err(|error| error.to_string())?;
        self.with_connection(|connection| {
            let tx = connection.transaction()?;
            for item in std::iter::once(blob).chain(poster_blob) {
                tx.execute("INSERT INTO blobs(hash,size_bytes,media_type,relative_path,created_at) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(hash) DO UPDATE SET size_bytes=excluded.size_bytes,media_type=excluded.media_type,relative_path=excluded.relative_path", params![item.hash,item.size_bytes as i64,item.media_type,item.relative_path,item.created_at.to_rfc3339()])?;
            }
            tx.execute("INSERT INTO media_metadata(blob_hash,kind,metadata_json,poster_blob_hash) VALUES(?1,?2,?3,?4) ON CONFLICT(blob_hash) DO UPDATE SET kind=excluded.kind,metadata_json=excluded.metadata_json,poster_blob_hash=excluded.poster_blob_hash", params![blob.hash,metadata.kind,metadata_json,poster_blob.map(|item| item.hash.as_str())])?;
            tx.execute("INSERT INTO runs(id,project_id,node_id,provider,model,status,started_at,finished_at,error_code) VALUES(?1,?2,?3,'local','import','success',?4,?4,NULL)", params![run_id,project_id,node_id,created_at])?;
            tx.execute("INSERT INTO assets(id,project_id,blob_hash,name,kind,metadata_json,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)", params![asset_id,project_id,blob.hash,blob.original_name.as_deref().unwrap_or("Lokaler Medienimport"),metadata.kind,metadata_json,created_at])?;
            tx.execute("INSERT INTO results(id,run_id,kind,text_value,blob_hash,asset_id,prompt,parameters_json,created_at) VALUES(?1,?2,?3,NULL,?4,?5,NULL,?6,?7)", params![result_id,run_id,format!("input-{}",metadata.kind),blob.hash,asset_id,parameters_json,created_at])?;
            tx.execute("INSERT INTO active_results(project_id,node_id,result_id) VALUES(?1,?2,?3) ON CONFLICT(project_id,node_id) DO UPDATE SET result_id=excluded.result_id", params![project_id,node_id,result_id])?;
            tx.commit()?;
            Ok(())
        })?;
        Ok((result_id, asset_id))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn record_video_import_with_frames(
        &self,
        project_id: &str,
        node_id: &str,
        blob: &BlobMetadata,
        metadata: &MediaMetadata,
        poster: Option<&BlobMetadata>,
        start: &BlobMetadata,
        end: &BlobMetadata,
    ) -> Result<(String, String), String> {
        let run_id = uuid::Uuid::new_v4().to_string();
        let result_id = uuid::Uuid::new_v4().to_string();
        let asset_id = uuid::Uuid::new_v4().to_string();
        let created_at = chrono::Utc::now().to_rfc3339();
        let start_result = uuid::Uuid::new_v4().to_string();
        let start_asset = uuid::Uuid::new_v4().to_string();
        let end_result = uuid::Uuid::new_v4().to_string();
        let end_asset = uuid::Uuid::new_v4().to_string();
        let metadata_json = serde_json::to_string(metadata).map_err(|error| error.to_string())?;
        let parameters = serde_json::json!({ "durationSeconds":metadata.duration_seconds,"container":metadata.container,"codecs":metadata.codecs.join(" + "),"width":metadata.width,"height":metadata.height,"fps":metadata.fps,"posterHash":poster.map(|item|item.hash.as_str()),"fileName":blob.original_name,"playable":metadata.playable,"playbackWarning":metadata.playback_warning,"startFrameHash":start.hash,"endFrameHash":end.hash });
        self.with_connection(|connection| { let tx = connection.transaction()?;
            for item in [blob,start,end].into_iter().chain(poster) { tx.execute("INSERT INTO blobs(hash,size_bytes,media_type,relative_path,created_at) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(hash) DO UPDATE SET size_bytes=excluded.size_bytes,media_type=excluded.media_type,relative_path=excluded.relative_path",params![item.hash,item.size_bytes as i64,item.media_type,item.relative_path,item.created_at.to_rfc3339()])?; }
            tx.execute("INSERT INTO media_metadata(blob_hash,kind,metadata_json,poster_blob_hash) VALUES(?1,'video',?2,?3) ON CONFLICT(blob_hash) DO UPDATE SET metadata_json=excluded.metadata_json,poster_blob_hash=excluded.poster_blob_hash",params![blob.hash,metadata_json,poster.map(|item|item.hash.as_str())])?;
            tx.execute("INSERT INTO runs(id,project_id,node_id,provider,model,status,started_at,finished_at,error_code) VALUES(?1,?2,?3,'local','import','success',?4,?4,NULL)",params![run_id,project_id,node_id,created_at])?;
            for (id,item,name,kind) in [(&asset_id,blob,blob.original_name.as_deref().unwrap_or("Lokaler Videoimport"),"video"),(&start_asset,start,"Video Startbild","image"),(&end_asset,end,"Video Endbild","image")] { tx.execute("INSERT INTO assets(id,project_id,blob_hash,name,kind,metadata_json,created_at) VALUES(?1,?2,?3,?4,?5,'{}',?6)",params![id,project_id,item.hash,name,kind,created_at])?; }
            tx.execute("INSERT INTO results(id,run_id,kind,text_value,blob_hash,asset_id,prompt,parameters_json,created_at) VALUES(?1,?2,'input-video',NULL,?3,?4,NULL,?5,?6)",params![result_id,run_id,blob.hash,asset_id,serde_json::to_string(&parameters).unwrap(),created_at])?;
            for (id,item,asset,kind) in [(&start_result,start,&start_asset,"video-import-start-frame"),(&end_result,end,&end_asset,"video-import-end-frame")] { tx.execute("INSERT INTO results(id,run_id,kind,text_value,blob_hash,asset_id,prompt,parameters_json,created_at) VALUES(?1,?2,?3,NULL,?4,?5,NULL,?6,?7)",params![id,run_id,kind,item.hash,asset,serde_json::to_string(&serde_json::json!({"sourceVideoResultId":result_id})).unwrap(),created_at])?; }
            tx.execute("INSERT INTO active_results(project_id,node_id,result_id) VALUES(?1,?2,?3) ON CONFLICT(project_id,node_id) DO UPDATE SET result_id=excluded.result_id",params![project_id,node_id,result_id])?; tx.commit()?; Ok(()) })?;
        Ok((result_id, asset_id))
    }

    pub fn record_provider_completion(
        &self,
        run_id: &str,
        project_id: &str,
        node_id: &str,
        model: &str,
        cost_microunits: Option<i64>,
        completed_at: &str,
    ) -> Result<(), String> {
        if cost_microunits.is_some_and(|value| value < 0) {
            return Err("Providerkosten dürfen nicht negativ sein.".into());
        }
        self.with_connection(|connection| {
            let transaction = connection.transaction()?;
            transaction.execute(
                "INSERT INTO runs(id,project_id,node_id,provider,model,status,started_at,finished_at,error_code)
                 VALUES(?1,?2,?3,'openrouter',?4,'provider_completed',?5,?5,NULL)
                 ON CONFLICT(id) DO UPDATE SET status='provider_completed',finished_at=excluded.finished_at",
                params![run_id, project_id, node_id, model, completed_at],
            )?;
            if let Some(cost) = cost_microunits {
                transaction.execute(
                    "INSERT INTO costs(run_id,currency,amount_microunits,created_at)
                     SELECT ?1,'USD',?2,?3 WHERE NOT EXISTS(SELECT 1 FROM costs WHERE run_id=?1)",
                    params![run_id, cost, completed_at],
                )?;
            }
            transaction.commit()?;
            Ok(())
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn commit_external_image_tool_result(
        &self,
        run_id: &str,
        project_id: &str,
        node_id: &str,
        endpoint: &str,
        cost_microunits: Option<i64>,
        blob: &BlobMetadata,
        result_id: &str,
        asset_id: &str,
        parameters: &Value,
        created_at: &str,
        make_active: bool,
    ) -> Result<(), String> {
        if cost_microunits.is_some_and(|value| value < 0) {
            return Err("Ungültige fal.ai-Abrechnung.".into());
        }
        let parameters_json =
            serde_json::to_string(parameters).map_err(|error| error.to_string())?;
        self.with_connection(|connection| {
            let tx = connection.transaction()?;
            tx.execute("INSERT INTO blobs(hash,size_bytes,media_type,relative_path,created_at) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(hash) DO UPDATE SET size_bytes=excluded.size_bytes,media_type=excluded.media_type,relative_path=excluded.relative_path", params![blob.hash,blob.size_bytes as i64,blob.media_type,blob.relative_path,blob.created_at.to_rfc3339()])?;
            tx.execute("INSERT INTO runs(id,project_id,node_id,provider,model,status,started_at,finished_at,error_code) VALUES(?1,?2,?3,'fal.ai',?4,'success',?5,?5,NULL) ON CONFLICT(id) DO UPDATE SET status='success',finished_at=excluded.finished_at,error_code=NULL", params![run_id,project_id,node_id,endpoint,created_at])?;
            if let Some(cost) = cost_microunits {
                tx.execute("INSERT INTO costs(run_id,currency,amount_microunits,created_at,provenance) SELECT ?1,'USD',?2,?3,?4 WHERE NOT EXISTS(SELECT 1 FROM costs WHERE run_id=?1)", params![run_id,cost,created_at,cost_provenance(Some(parameters))])?;
            }
            tx.execute("INSERT INTO assets(id,project_id,blob_hash,name,kind,metadata_json,created_at) VALUES(?1,?2,?3,?4,'image','{}',?5) ON CONFLICT(id) DO NOTHING",params![asset_id,project_id,blob.hash,blob.original_name.as_deref().unwrap_or("fal.ai Bildergebnis"),created_at])?;
            tx.execute("INSERT INTO results(id,run_id,kind,text_value,blob_hash,asset_id,prompt,parameters_json,created_at) VALUES(?1,?2,'image',NULL,?3,?4,NULL,?5,?6) ON CONFLICT(id) DO NOTHING",params![result_id,run_id,blob.hash,asset_id,parameters_json,created_at])?;
            if make_active {
                tx.execute("INSERT INTO active_results(project_id,node_id,result_id) VALUES(?1,?2,?3) ON CONFLICT(project_id,node_id) DO UPDATE SET result_id=excluded.result_id",params![project_id,node_id,result_id])?;
            }
            tx.commit()?;
            Ok(())
        })
    }

    pub fn record_local_completion(
        &self,
        run_id: &str,
        project_id: &str,
        node_id: &str,
        operation: &str,
        completed_at: &str,
    ) -> Result<(), String> {
        self.with_connection(|connection| {
            connection.execute(
                "INSERT INTO runs(id,project_id,node_id,provider,model,status,started_at,finished_at,error_code)
                 VALUES(?1,?2,?3,'local',?4,'provider_completed',?5,?5,NULL)",
                params![run_id, project_id, node_id, operation, completed_at],
            )?;
            Ok(())
        })
    }

    /// Persists a provider-completed text result and its authoritative cost as one
    /// indivisible unit. This is intentionally separate from the two-phase image
    /// path: transcription has no blob/asset work that needs to happen outside the
    /// database, so exposing a completion-only state would only create unrecoverable
    /// paid runs.
    #[allow(clippy::too_many_arguments)]
    pub fn record_provider_text_result_atomic(
        &self,
        result_id: &str,
        run_id: &str,
        project_id: &str,
        node_id: &str,
        model: &str,
        kind: &str,
        text_value: &str,
        parameters: Option<&Value>,
        cost_microunits: Option<i64>,
        completed_at: &str,
        make_active: bool,
    ) -> Result<StoredResult, String> {
        if cost_microunits.is_some_and(|value| value < 0) {
            return Err("Providerkosten dürfen nicht negativ sein.".into());
        }
        let parameters_json = parameters
            .map(serde_json::to_string)
            .transpose()
            .map_err(|error| error.to_string())?;
        self.with_connection(|connection| {
            let transaction = connection.transaction()?;
            // A run id is an immutable execution identity. Deliberately avoid an
            // upsert here: accepting a collision could move billing or a result to
            // another project/node.
            transaction.execute(
                "INSERT INTO runs(id,project_id,node_id,provider,model,status,started_at,finished_at,error_code)
                 VALUES(?1,?2,?3,'openrouter',?4,'success',?5,?5,NULL)",
                params![run_id, project_id, node_id, model, completed_at],
            )?;
            if let Some(cost) = cost_microunits {
                transaction.execute(
                    "INSERT INTO costs(run_id,currency,amount_microunits,created_at)
                     VALUES(?1,'USD',?2,?3)",
                    params![run_id, cost, completed_at],
                )?;
            }
            transaction.execute(
                "INSERT INTO results(id,run_id,kind,text_value,blob_hash,asset_id,prompt,parameters_json,created_at)
                 VALUES(?1,?2,?3,?4,NULL,NULL,NULL,?5,?6)",
                params![
                    result_id,
                    run_id,
                    kind,
                    text_value,
                    parameters_json,
                    completed_at
                ],
            )?;
            if make_active {
                transaction.execute("INSERT INTO active_results(project_id,node_id,result_id) VALUES(?1,?2,?3) ON CONFLICT(project_id,node_id) DO UPDATE SET result_id=excluded.result_id",params![project_id,node_id,result_id])?;
            }
            transaction.commit()?;
            Ok(StoredResult {
                result_id: result_id.into(),
                run_id: run_id.into(),
                project_id: project_id.into(),
                node_id: node_id.into(),
                kind: kind.into(),
                text_value: Some(text_value.into()),
                blob_hash: None,
                asset_id: None,
                media_type: None,
                created_at: completed_at.into(),
                cost_microunits,
                model: Some(model.into()),
                prompt: None,
                parameters: parameters.cloned(),
                active: make_active,
            })
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn attach_result(
        &self,
        result_id: &str,
        run_id: &str,
        project_id: &str,
        node_id: &str,
        kind: &str,
        text_value: Option<&str>,
        blob: Option<&BlobMetadata>,
        asset_id: Option<&str>,
        prompt: Option<&str>,
        parameters: Option<&Value>,
        created_at: &str,
    ) -> Result<StoredResult, String> {
        self.with_connection(|connection| {
            let transaction = connection.transaction()?;
            if let (Some(blob), Some(asset_id)) = (blob, asset_id) {
                transaction.execute(
                    "INSERT INTO assets(id,project_id,blob_hash,name,kind,metadata_json,created_at) VALUES(?1,?2,?3,?4,?5,'{}',?6)",
                    params![asset_id, project_id, blob.hash, blob.original_name.as_deref().unwrap_or("FlowZ Ergebnis"), kind, created_at],
                )?;
            }
            let parameters_json = parameters
                .map(serde_json::to_string)
                .transpose()
                .map_err(|error| rusqlite::Error::ToSqlConversionFailure(error.into()))?;
            transaction.execute(
                "INSERT INTO results(id,run_id,kind,text_value,blob_hash,asset_id,prompt,parameters_json,created_at)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                params![result_id, run_id, kind, text_value, blob.map(|item| item.hash.as_str()), asset_id, prompt, parameters_json, created_at],
            )?;
            transaction.execute("UPDATE runs SET status='success' WHERE id=?1", [run_id])?;
            let cost = transaction.query_row(
                "SELECT amount_microunits FROM costs WHERE run_id=?1 LIMIT 1",
                [run_id],
                |row| row.get::<_, i64>(0),
            ).ok();
            let model = transaction.query_row(
                "SELECT model FROM runs WHERE id=?1",
                [run_id],
                |row| row.get::<_, Option<String>>(0),
            ).ok().flatten();
            transaction.commit()?;
            Ok(StoredResult {
                result_id: result_id.into(), run_id: run_id.into(), project_id: project_id.into(), node_id: node_id.into(),
                kind: kind.into(), text_value: text_value.map(str::to_owned), blob_hash: blob.map(|item| item.hash.clone()),
                asset_id: asset_id.map(str::to_owned), media_type: blob.map(|item| item.media_type.clone()), created_at: created_at.into(),
                cost_microunits: cost, model, prompt: prompt.map(str::to_owned), parameters: parameters.cloned(), active: false,
            })
        })
    }

    /// Stores a free local image operation as one database transaction. The CAS file is
    /// already fsync-safe at this point; every relational reference becomes visible together.
    #[allow(clippy::too_many_arguments)]
    pub fn record_local_image_result_atomic(
        &self,
        result_id: &str,
        run_id: &str,
        project_id: &str,
        node_id: &str,
        operation: &str,
        kind: &str,
        blob: &BlobMetadata,
        asset_id: &str,
        parameters: &Value,
        completed_at: &str,
        activate: bool,
    ) -> Result<StoredResult, String> {
        let parameters_json =
            serde_json::to_string(parameters).map_err(|error| error.to_string())?;
        self.with_connection(|connection| {
            let transaction = connection.transaction()?;
            transaction.execute(
                "INSERT INTO blobs(hash,size_bytes,media_type,original_name,created_at,relative_path) VALUES(?1,?2,?3,?4,?5,?6)
                 ON CONFLICT(hash) DO UPDATE SET size_bytes=excluded.size_bytes,media_type=excluded.media_type,relative_path=excluded.relative_path",
                params![blob.hash, blob.size_bytes, blob.media_type, blob.original_name, blob.created_at.to_rfc3339(), blob.relative_path],
            )?;
            transaction.execute(
                "INSERT INTO runs(id,project_id,node_id,provider,model,status,started_at,finished_at,error_code)
                 VALUES(?1,?2,?3,'local',?4,'success',?5,?5,NULL)",
                params![run_id, project_id, node_id, operation, completed_at],
            )?;
            transaction.execute(
                "INSERT INTO costs(run_id,currency,amount_microunits,created_at) VALUES(?1,'USD',0,?2)",
                params![run_id, completed_at],
            )?;
            transaction.execute(
                "INSERT INTO assets(id,project_id,blob_hash,name,kind,metadata_json,created_at) VALUES(?1,?2,?3,?4,?5,'{}',?6)",
                params![asset_id, project_id, blob.hash, blob.original_name.as_deref().unwrap_or("FlowZ Bildbearbeitung"), kind, completed_at],
            )?;
            transaction.execute(
                "INSERT INTO results(id,run_id,kind,text_value,blob_hash,asset_id,prompt,parameters_json,created_at)
                 VALUES(?1,?2,?3,NULL,?4,?5,NULL,?6,?7)",
                params![result_id, run_id, kind, blob.hash, asset_id, parameters_json, completed_at],
            )?;
            if activate { transaction.execute(
                "INSERT INTO active_results(project_id,node_id,result_id) VALUES(?1,?2,?3)
                 ON CONFLICT(project_id,node_id) DO UPDATE SET result_id=excluded.result_id",
                params![project_id, node_id, result_id],
            )?; }
            transaction.commit()?;
            Ok(StoredResult {
                result_id: result_id.into(), run_id: run_id.into(), project_id: project_id.into(), node_id: node_id.into(),
                kind: kind.into(), text_value: None, blob_hash: Some(blob.hash.clone()), asset_id: Some(asset_id.into()),
                media_type: Some(blob.media_type.clone()), created_at: completed_at.into(), cost_microunits: Some(0),
                model: Some(operation.into()), prompt: None, parameters: Some(parameters.clone()), active: activate,
            })
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn record_bound_local_image_result_atomic(
        &self,
        result_id: &str,
        run_id: &str,
        project_id: &str,
        node_id: &str,
        operation: &str,
        kind: &str,
        blob: &BlobMetadata,
        asset_id: &str,
        parameters: &Value,
        completed_at: &str,
        binding: &LocalImageBinding,
        activate_result: bool,
    ) -> Result<StoredResult, String> {
        let parameters_json =
            serde_json::to_string(parameters).map_err(|error| error.to_string())?;
        self.with_connection(|connection|{
            let tx=connection.transaction()?;let binding_current=binding_hashes(&tx,project_id,binding)?==binding.expected_hashes;let active=binding_current&&activate_result;
            tx.execute("INSERT INTO blobs(hash,size_bytes,media_type,original_name,created_at,relative_path) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(hash) DO UPDATE SET size_bytes=excluded.size_bytes,media_type=excluded.media_type,relative_path=excluded.relative_path",params![blob.hash,blob.size_bytes,blob.media_type,blob.original_name,blob.created_at.to_rfc3339(),blob.relative_path])?;
            tx.execute("INSERT INTO runs(id,project_id,node_id,provider,model,status,started_at,finished_at,error_code) VALUES(?1,?2,?3,'local',?4,'success',?5,?5,NULL)",params![run_id,project_id,node_id,operation,completed_at])?;
            tx.execute("INSERT INTO costs(run_id,currency,amount_microunits,created_at) VALUES(?1,'USD',0,?2)",params![run_id,completed_at])?;
            tx.execute("INSERT INTO assets(id,project_id,blob_hash,name,kind,metadata_json,created_at) VALUES(?1,?2,?3,?4,?5,'{}',?6)",params![asset_id,project_id,blob.hash,blob.original_name.as_deref().unwrap_or("FlowZ Bildbearbeitung"),kind,completed_at])?;
            tx.execute("INSERT INTO results(id,run_id,kind,text_value,blob_hash,asset_id,prompt,parameters_json,created_at) VALUES(?1,?2,?3,NULL,?4,?5,NULL,?6,?7)",params![result_id,run_id,kind,blob.hash,asset_id,parameters_json,completed_at])?;
            if active{tx.execute("INSERT INTO active_results(project_id,node_id,result_id) VALUES(?1,?2,?3) ON CONFLICT(project_id,node_id) DO UPDATE SET result_id=excluded.result_id",params![project_id,node_id,result_id])?;}else if !binding_current{tx.execute("DELETE FROM active_results WHERE project_id=?1 AND node_id=?2",params![project_id,node_id])?;}
            tx.commit()?;Ok(StoredResult{result_id:result_id.into(),run_id:run_id.into(),project_id:project_id.into(),node_id:node_id.into(),kind:kind.into(),text_value:None,blob_hash:Some(blob.hash.clone()),asset_id:Some(asset_id.into()),media_type:Some(blob.media_type.clone()),created_at:completed_at.into(),cost_microunits:Some(0),model:Some(operation.into()),prompt:None,parameters:Some(parameters.clone()),active})
        })
    }

    pub fn activate_local_image_result_bound(
        &self,
        project_id: &str,
        node_id: &str,
        result_id: &str,
        binding: &LocalImageBinding,
    ) -> Result<bool, String> {
        self.with_connection(|connection|{let tx=connection.transaction()?;let active=binding_hashes(&tx,project_id,binding)?==binding.expected_hashes;if active{let belongs:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM results r JOIN runs ru ON ru.id=r.run_id WHERE r.id=?1 AND ru.project_id=?2 AND ru.node_id=?3)",params![result_id,project_id,node_id],|row|row.get(0))?;if !belongs{return Err(rusqlite::Error::QueryReturnedNoRows)}tx.execute("INSERT INTO active_results(project_id,node_id,result_id) VALUES(?1,?2,?3) ON CONFLICT(project_id,node_id) DO UPDATE SET result_id=excluded.result_id",params![project_id,node_id,result_id])?;}else{tx.execute("DELETE FROM active_results WHERE project_id=?1 AND node_id=?2",params![project_id,node_id])?;}tx.commit()?;Ok(active)})
    }

    pub fn cached_local_image_result(
        &self,
        project_id: &str,
        node_id: &str,
        kind: &str,
        recipe_fingerprint: &str,
    ) -> Result<Option<StoredResult>, String> {
        self.with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT r.id,r.run_id,r.kind,r.blob_hash,r.asset_id,b.media_type,r.created_at,r.parameters_json
                 FROM results r JOIN runs ru ON ru.id=r.run_id LEFT JOIN blobs b ON b.hash=r.blob_hash
                 WHERE ru.project_id=?1 AND ru.node_id=?2 AND ru.provider='local' AND r.kind=?3
                 ORDER BY r.created_at DESC",
            )?;
            let rows = statement.query_map(params![project_id, node_id, kind], |row| {
                Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,Option<String>>(3)?,row.get::<_,Option<String>>(4)?,row.get::<_,Option<String>>(5)?,row.get::<_,String>(6)?,row.get::<_,Option<String>>(7)?))
            })?;
            for row in rows {
                let row = row?;
                let parameters = row.7.as_deref().and_then(|raw| serde_json::from_str::<Value>(raw).ok());
                if parameters.as_ref().and_then(|value| value.get("recipeFingerprint")).and_then(Value::as_str) == Some(recipe_fingerprint) {
                    return Ok(Some(StoredResult { result_id:row.0,run_id:row.1,project_id:project_id.into(),node_id:node_id.into(),kind:row.2,text_value:None,blob_hash:row.3,asset_id:row.4,media_type:row.5,created_at:row.6,cost_microunits:Some(0),model:Some("local/image-transform".into()),prompt:None,parameters,active:true }));
                }
            }
            Ok(None)
        })
    }

    pub fn node_owns_image_hash(
        &self,
        project_id: &str,
        node_id: &str,
        hash: &str,
    ) -> Result<bool, String> {
        self.with_connection(|connection| {
            connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM results r JOIN runs ru ON ru.id=r.run_id JOIN blobs b ON b.hash=r.blob_hash
                 WHERE ru.project_id=?1 AND ru.node_id=?2 AND r.blob_hash=?3 AND b.media_type LIKE 'image/%')",
                params![project_id,node_id,hash],
                |row| row.get(0),
            )
        })
    }

    pub fn node_active_image_hash_is(
        &self,
        project_id: &str,
        node_id: &str,
        hash: &str,
    ) -> Result<bool, String> {
        self.with_connection(|connection|connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM active_results ar JOIN results r ON r.id=ar.result_id JOIN blobs b ON b.hash=r.blob_hash
             WHERE ar.project_id=?1 AND ar.node_id=?2 AND r.blob_hash=?3 AND b.media_type LIKE 'image/%')",
            params![project_id,node_id,hash],|row|row.get(0)))
    }

    pub fn active_image_identity(
        &self,
        project_id: &str,
        node_id: &str,
    ) -> Result<Option<(String, String, Option<Value>)>, String> {
        self.with_connection(|connection|connection.query_row(
        "SELECT r.id,r.blob_hash,r.parameters_json FROM active_results ar JOIN results r ON r.id=ar.result_id JOIN blobs b ON b.hash=r.blob_hash WHERE ar.project_id=?1 AND ar.node_id=?2 AND b.media_type LIKE 'image/%'",
        params![project_id,node_id],|row|{let raw:Option<String>=row.get(2)?;Ok((row.get(0)?,row.get(1)?,raw.and_then(|value|serde_json::from_str(&value).ok()))) }).optional())
    }

    pub fn image_hashes_for_group(
        &self,
        project_id: &str,
        node_id: &str,
        group_run_id: &str,
    ) -> Result<Vec<String>, String> {
        self.with_connection(|connection|{let mut statement=connection.prepare(
        "SELECT r.blob_hash,r.parameters_json FROM results r JOIN runs ru ON ru.id=r.run_id JOIN blobs b ON b.hash=r.blob_hash WHERE ru.project_id=?1 AND ru.node_id=?2 AND b.media_type LIKE 'image/%' ORDER BY r.created_at,r.id")?;let rows=statement.query_map(params![project_id,node_id],|row|Ok((row.get::<_,String>(0)?,row.get::<_,Option<String>>(1)?)))?;let mut matched=Vec::new();for row in rows{let(hash,raw)=row?;let parameters=raw.and_then(|value|serde_json::from_str::<Value>(&value).ok());if parameters.as_ref().and_then(|value|value.get("groupRunId")).and_then(Value::as_str)==Some(group_run_id){let order=parameters.as_ref().and_then(|value|value.get("listIndex").or_else(||value.get("variantIndex"))).and_then(Value::as_u64).unwrap_or(u64::MAX);matched.push((order,hash));}}matched.sort_by(|left,right|left.0.cmp(&right.0).then_with(||left.1.cmp(&right.1)));Ok(matched.into_iter().map(|(_,hash)|hash).collect())})
    }

    pub fn image_hashes_for_results(
        &self,
        project_id: &str,
        result_ids: &[String],
    ) -> Result<Vec<String>, String> {
        self.with_connection(|connection|{let mut hashes=Vec::with_capacity(result_ids.len());for result_id in result_ids{let hash=connection.query_row("SELECT r.blob_hash FROM results r JOIN runs ru ON ru.id=r.run_id JOIN blobs b ON b.hash=r.blob_hash WHERE r.id=?1 AND ru.project_id=?2 AND b.media_type LIKE 'image/%'",params![result_id,project_id],|row|row.get::<_,String>(0)).optional()?;let Some(hash)=hash else{return Ok(Vec::new())};hashes.push(hash)}Ok(hashes)})
    }

    pub fn set_active_result(
        &self,
        project_id: &str,
        node_id: &str,
        result_id: &str,
    ) -> Result<(), String> {
        self.with_connection(|connection| {
            let belongs: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM results r JOIN runs ru ON ru.id=r.run_id WHERE r.id=?1 AND ru.project_id=?2 AND ru.node_id=?3)",
                params![result_id, project_id, node_id], |row| row.get(0),
            )?;
            if !belongs { return Err(rusqlite::Error::QueryReturnedNoRows); }
            connection.execute(
                "INSERT INTO active_results(project_id,node_id,result_id) VALUES(?1,?2,?3)
                 ON CONFLICT(project_id,node_id) DO UPDATE SET result_id=excluded.result_id",
                params![project_id, node_id, result_id],
            )?;
            Ok(())
        })
    }
    pub fn project_results(&self, project_id: &str) -> Result<Vec<StoredResult>, String> {
        self.with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT r.id,r.run_id,ru.project_id,COALESCE(ru.node_id,''),r.kind,r.text_value,r.blob_hash,
                        r.asset_id,b.media_type,r.created_at,c.amount_microunits,ru.model,r.prompt,r.parameters_json,
                        EXISTS(SELECT 1 FROM active_results ar WHERE ar.project_id=ru.project_id AND ar.node_id=ru.node_id AND ar.result_id=r.id)
                 FROM results r JOIN runs ru ON ru.id=r.run_id
                 LEFT JOIN blobs b ON b.hash=r.blob_hash LEFT JOIN costs c ON c.run_id=r.run_id
                 WHERE ru.project_id=?1 AND r.kind NOT IN ('video-start-frame','video-end-frame','video-import-start-frame','video-import-end-frame') ORDER BY r.created_at DESC",
            )?;
            let rows = statement.query_map([project_id], |row| {
                let raw: Option<String> = row.get(13)?;
                let parameters = raw
                    .map(|value| serde_json::from_str(&value))
                    .transpose()
                    .map_err(|error| rusqlite::Error::FromSqlConversionFailure(13, rusqlite::types::Type::Text, error.into()))?;
                Ok(StoredResult {
                    result_id: row.get(0)?, run_id: row.get(1)?, project_id: row.get(2)?, node_id: row.get(3)?, kind: row.get(4)?,
                    text_value: row.get(5)?, blob_hash: row.get(6)?, asset_id: row.get(7)?, media_type: row.get(8)?, created_at: row.get(9)?,
                    cost_microunits: row.get(10)?, model: row.get(11)?, prompt: row.get(12)?, parameters, active: row.get(14)?,
                })
            })?;
            rows.collect()
        })
    }

    /// Server-side result history query. The `(created_at, id)` tuple is the stable
    /// ordering key so equal timestamps never cause entries to jump between pages.
    pub fn search_results(
        &self,
        project_id: Option<&str>,
        node_id: Option<&str>,
        kind: Option<&str>,
        query: &str,
        page: i64,
        page_size: i64,
    ) -> Result<LibraryResultPage, String> {
        let page = page.clamp(0, 1_000_000);
        let page_size = page_size.clamp(1, 100);
        let query = query.trim();
        let pattern = format!(
            "%{}%",
            query
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        );
        self.with_connection(|connection| {
            let total = connection.query_row(
                "SELECT COUNT(*) FROM results r JOIN runs ru ON ru.id=r.run_id
                 WHERE (?1 IS NULL OR ru.project_id=?1) AND (?2 IS NULL OR ru.node_id=?2)
                 AND (?3 IS NULL OR r.kind=?3)
                 AND r.kind NOT IN ('video-start-frame','video-end-frame','video-import-start-frame','video-import-end-frame')
                 AND (?4='' OR COALESCE(r.text_value,'') LIKE ?5 ESCAPE '\\' OR COALESCE(r.prompt,'') LIKE ?5 ESCAPE '\\'
                      OR COALESCE(ru.model,'') LIKE ?5 ESCAPE '\\' OR COALESCE(ru.node_id,'') LIKE ?5 ESCAPE '\\')",
                params![project_id, node_id, kind, query, pattern],
                |row| row.get(0),
            )?;
            let mut statement = connection.prepare(
                "SELECT r.id,r.run_id,ru.project_id,COALESCE(ru.node_id,''),r.kind,r.text_value,r.blob_hash,
                        r.asset_id,b.media_type,r.created_at,c.amount_microunits,ru.model,r.prompt,r.parameters_json,
                        EXISTS(SELECT 1 FROM active_results ar WHERE ar.project_id=ru.project_id AND ar.node_id=ru.node_id AND ar.result_id=r.id)
                 FROM results r JOIN runs ru ON ru.id=r.run_id
                 LEFT JOIN blobs b ON b.hash=r.blob_hash LEFT JOIN costs c ON c.run_id=r.run_id
                 WHERE (?1 IS NULL OR ru.project_id=?1) AND (?2 IS NULL OR ru.node_id=?2)
                 AND (?3 IS NULL OR r.kind=?3)
                 AND r.kind NOT IN ('video-start-frame','video-end-frame','video-import-start-frame','video-import-end-frame')
                 AND (?4='' OR COALESCE(r.text_value,'') LIKE ?5 ESCAPE '\\' OR COALESCE(r.prompt,'') LIKE ?5 ESCAPE '\\'
                      OR COALESCE(ru.model,'') LIKE ?5 ESCAPE '\\' OR COALESCE(ru.node_id,'') LIKE ?5 ESCAPE '\\')
                 ORDER BY r.created_at DESC,r.id DESC LIMIT ?6 OFFSET ?7",
            )?;
            let items = statement.query_map(
                params![project_id, node_id, kind, query, pattern, page_size, page * page_size],
                |row| {
                    let raw: Option<String> = row.get(13)?;
                    let parameters = raw.map(|value| serde_json::from_str(&value)).transpose()
                        .map_err(|error| rusqlite::Error::FromSqlConversionFailure(13, rusqlite::types::Type::Text, error.into()))?;
                    Ok(StoredResult {
                        result_id: row.get(0)?, run_id: row.get(1)?, project_id: row.get(2)?, node_id: row.get(3)?, kind: row.get(4)?,
                        text_value: row.get(5)?, blob_hash: row.get(6)?, asset_id: row.get(7)?, media_type: row.get(8)?, created_at: row.get(9)?,
                        cost_microunits: row.get(10)?, model: row.get(11)?, prompt: row.get(12)?, parameters, active: row.get(14)?,
                    })
                },
            )?.collect::<Result<Vec<_>, _>>()?;
            Ok(LibraryResultPage { items, total, page, page_size })
        })
    }

    /// Resolves only project-owned immutable result content. Missing/foreign ids
    /// fail the whole batch instead of silently returning a partial selection.
    pub fn result_contents(
        &self,
        project_id: &str,
        result_ids: &[String],
    ) -> Result<Vec<StoredResultContent>, String> {
        self.with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT r.id,r.text_value,r.blob_hash,b.media_type FROM results r
                 JOIN runs ru ON ru.id=r.run_id LEFT JOIN blobs b ON b.hash=r.blob_hash
                 WHERE r.id=?1 AND ru.project_id=?2",
            )?;
            let mut contents = Vec::with_capacity(result_ids.len());
            for result_id in result_ids {
                let content = statement
                    .query_row(params![result_id, project_id], |row| {
                        Ok(StoredResultContent {
                            result_id: row.get(0)?,
                            text_value: row.get(1)?,
                            blob_hash: row.get(2)?,
                            media_type: row.get(3)?,
                        })
                    })
                    .optional()?;
                let Some(content) = content else {
                    return Err(rusqlite::Error::QueryReturnedNoRows);
                };
                contents.push(content);
            }
            Ok(contents)
        })
    }

    pub fn reassign_result(
        &self,
        project_id: &str,
        result_id: &str,
        node_id: &str,
    ) -> Result<(), String> {
        self.with_connection(|connection| {
            let tx = connection.transaction()?;
            let run_id: String = tx.query_row("SELECT r.run_id FROM results r JOIN runs u ON u.id=r.run_id WHERE r.id=?1 AND u.project_id=?2", params![result_id, project_id], |row| row.get(0))?;
            tx.execute("UPDATE runs SET node_id=?1 WHERE id=?2", params![node_id, run_id])?;
            tx.execute("UPDATE results SET parameters_json=json_set(COALESCE(parameters_json,'{}'),'$.orphaned',json('false'),'$.recoveredAsNodeId',?1) WHERE id=?2", params![node_id, result_id])?;
            tx.execute("INSERT INTO active_results(project_id,node_id,result_id) VALUES(?1,?2,?3) ON CONFLICT(project_id,node_id) DO UPDATE SET result_id=excluded.result_id", params![project_id,node_id,result_id])?;
            tx.commit()?; Ok(())
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_library_asset(
        &self,
        asset_id: &str,
        version_id: &str,
        name: &str,
        kind: &str,
        text_value: Option<&str>,
        blob: Option<&BlobMetadata>,
        thumbnail_blob: Option<&BlobMetadata>,
        source_project_id: Option<&str>,
        source_node_id: Option<&str>,
        source_result_id: Option<&str>,
        created_at: &str,
    ) -> Result<LibraryAssetSummary, String> {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 120 {
            return Err("Asset-Namen müssen 1–120 Zeichen lang sein.".into());
        }
        if !matches!(kind, "prompt" | "text" | "image") {
            return Err("Asset-Typ muss Prompt, Text oder Bild sein.".into());
        }
        if kind == "image" && blob.is_none()
            || kind != "image" && text_value.is_none_or(|value| value.trim().is_empty())
        {
            return Err("Asset-Inhalt passt nicht zum gewählten Typ.".into());
        }
        self.with_connection(|connection| {
            let transaction = connection.transaction()?;
            if let Some(result_id) = source_result_id {
                let valid: bool = transaction.query_row(
                    "SELECT EXISTS(SELECT 1 FROM results r JOIN runs ru ON ru.id=r.run_id WHERE r.id=?1 AND (?2 IS NULL OR ru.project_id=?2) AND (?3 IS NULL OR ru.node_id=?3))",
                    params![result_id, source_project_id, source_node_id], |row| row.get(0),
                )?;
                if !valid { return Err(rusqlite::Error::QueryReturnedNoRows); }
            }
            transaction.execute(
                "INSERT INTO library_assets(id,name,kind,created_at,archived_at) VALUES(?1,?2,?3,?4,NULL)",
                params![asset_id, name, kind, created_at],
            )?;
            transaction.execute(
                "INSERT INTO library_asset_versions(id,asset_id,version,text_value,blob_hash,thumbnail_blob_hash,source_project_id,source_node_id,source_result_id,created_at)
                 VALUES(?1,?2,1,?3,?4,?5,?6,?7,?8,?9)",
                params![version_id, asset_id, text_value, blob.map(|value| value.hash.as_str()), thumbnail_blob.map(|value| value.hash.as_str()), source_project_id, source_node_id, source_result_id, created_at],
            )?;
            transaction.commit()?;
            Ok(LibraryAssetSummary {
                asset_id: asset_id.into(), version_id: version_id.into(), version: 1, name: name.into(), kind: kind.into(),
                preview_text: text_value.map(|value| value.chars().take(240).collect()), media_type: blob.map(|value| value.media_type.clone()),
                created_at: created_at.into(), source_project_id: source_project_id.map(str::to_owned), source_node_id: source_node_id.map(str::to_owned), source_result_id: source_result_id.map(str::to_owned),
            })
        })
    }

    pub fn search_library_assets(
        &self,
        query: &str,
        kind: Option<&str>,
        page: i64,
        page_size: i64,
    ) -> Result<LibraryAssetPage, String> {
        let page = page.max(0);
        let page_size = page_size.clamp(1, 60);
        let pattern = format!("%{}%", query.trim().replace(['%', '_'], ""));
        let kind = kind.filter(|value| matches!(*value, "prompt" | "text" | "image"));
        self.with_connection(|connection| {
            let total = connection.query_row(
                "SELECT COUNT(*) FROM library_assets a JOIN library_asset_versions v ON v.asset_id=a.id
                 WHERE a.archived_at IS NULL AND v.version=(SELECT MAX(v2.version) FROM library_asset_versions v2 WHERE v2.asset_id=a.id)
                 AND (?1 IS NULL OR a.kind=?1) AND (a.name LIKE ?2 ESCAPE '\\' OR COALESCE(v.text_value,'') LIKE ?2 ESCAPE '\\')",
                params![kind, pattern], |row| row.get(0),
            )?;
            let mut statement = connection.prepare(
                "SELECT a.id,v.id,v.version,a.name,a.kind,CASE WHEN v.text_value IS NULL THEN NULL ELSE substr(v.text_value,1,240) END,b.media_type,v.created_at,v.source_project_id,v.source_node_id,v.source_result_id
                 FROM library_assets a JOIN library_asset_versions v ON v.asset_id=a.id LEFT JOIN blobs b ON b.hash=v.blob_hash
                 WHERE a.archived_at IS NULL AND v.version=(SELECT MAX(v2.version) FROM library_asset_versions v2 WHERE v2.asset_id=a.id)
                 AND (?1 IS NULL OR a.kind=?1) AND (a.name LIKE ?2 ESCAPE '\\' OR COALESCE(v.text_value,'') LIKE ?2 ESCAPE '\\')
                 ORDER BY v.created_at DESC,a.id LIMIT ?3 OFFSET ?4",
            )?;
            let items = statement.query_map(params![kind, pattern, page_size, page * page_size], |row| Ok(LibraryAssetSummary {
                asset_id: row.get(0)?, version_id: row.get(1)?, version: row.get(2)?, name: row.get(3)?, kind: row.get(4)?, preview_text: row.get(5)?, media_type: row.get(6)?, created_at: row.get(7)?, source_project_id: row.get(8)?, source_node_id: row.get(9)?, source_result_id: row.get(10)?,
            }))?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(LibraryAssetPage { items, total, page, page_size })
        })
    }

    pub fn library_asset_content(&self, version_id: &str) -> Result<LibraryAssetContent, String> {
        self.with_connection(|connection| connection.query_row(
            "SELECT a.id,v.id,v.version,a.name,a.kind,CASE WHEN v.text_value IS NULL THEN NULL ELSE substr(v.text_value,1,240) END,b.media_type,v.created_at,v.source_project_id,v.source_node_id,v.source_result_id,v.text_value,v.blob_hash
             FROM library_assets a JOIN library_asset_versions v ON v.asset_id=a.id LEFT JOIN blobs b ON b.hash=v.blob_hash
             WHERE v.id=?1 AND a.archived_at IS NULL",
            [version_id], |row| Ok(LibraryAssetContent { summary: LibraryAssetSummary {
                asset_id: row.get(0)?, version_id: row.get(1)?, version: row.get(2)?, name: row.get(3)?, kind: row.get(4)?, preview_text: row.get(5)?, media_type: row.get(6)?, created_at: row.get(7)?, source_project_id: row.get(8)?, source_node_id: row.get(9)?, source_result_id: row.get(10)?,
            }, text_value: row.get(11)?, blob_hash: row.get(12)? })) )
    }

    pub fn library_asset_thumbnail(
        &self,
        version_id: &str,
    ) -> Result<Option<(String, String)>, String> {
        self.with_connection(|connection| connection.query_row(
            "SELECT v.thumbnail_blob_hash,b.media_type FROM library_asset_versions v
             JOIN library_assets a ON a.id=v.asset_id LEFT JOIN blobs b ON b.hash=v.thumbnail_blob_hash
             WHERE v.id=?1 AND a.archived_at IS NULL",
            [version_id], |row| {
                let hash: Option<String> = row.get(0)?;
                let media_type: Option<String> = row.get(1)?;
                Ok(hash.zip(media_type))
            },
        ))
    }

    pub fn set_library_asset_thumbnail(
        &self,
        version_id: &str,
        blob_hash: &str,
    ) -> Result<(String, String), String> {
        self.with_connection(|connection| {
            let transaction = connection.transaction()?;
            transaction.execute(
                "UPDATE library_asset_versions SET thumbnail_blob_hash=?2 WHERE id=?1 AND thumbnail_blob_hash IS NULL",
                params![version_id, blob_hash],
            )?;
            // UPDATE can lose a race to another writer. Always return the canonical
            // persisted hash instead of assuming this caller's candidate won.
            let canonical = transaction.query_row(
                "SELECT v.thumbnail_blob_hash,b.media_type FROM library_asset_versions v
                 JOIN blobs b ON b.hash=v.thumbnail_blob_hash WHERE v.id=?1",
                [version_id], |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            transaction.commit()?;
            Ok(canonical)
        })
    }

    pub fn library_asset_contents(
        &self,
        version_ids: &[String],
    ) -> Result<Vec<LibraryAssetContent>, String> {
        if version_ids.len() > 100 {
            return Err("Höchstens 100 Asset-Versionen können gemeinsam geladen werden.".into());
        }
        let encoded = serde_json::to_string(version_ids).map_err(|error| error.to_string())?;
        self.with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT a.id,v.id,v.version,a.name,a.kind,CASE WHEN v.text_value IS NULL THEN NULL ELSE substr(v.text_value,1,240) END,b.media_type,v.created_at,v.source_project_id,v.source_node_id,v.source_result_id,v.text_value,v.blob_hash
                 FROM library_assets a JOIN library_asset_versions v ON v.asset_id=a.id LEFT JOIN blobs b ON b.hash=v.blob_hash
                 WHERE v.id IN (SELECT value FROM json_each(?1)) AND a.archived_at IS NULL",
            )?;
            let rows = statement.query_map([encoded], |row| Ok(LibraryAssetContent { summary: LibraryAssetSummary {
                asset_id: row.get(0)?, version_id: row.get(1)?, version: row.get(2)?, name: row.get(3)?, kind: row.get(4)?, preview_text: row.get(5)?, media_type: row.get(6)?, created_at: row.get(7)?, source_project_id: row.get(8)?, source_node_id: row.get(9)?, source_result_id: row.get(10)?,
            }, text_value: row.get(11)?, blob_hash: row.get(12)? }))?.collect();
            rows
        })
    }

    pub fn usage(&self) -> Result<LibraryUsage, String> {
        self.with_connection(|c| {
            let (blob_count, blob_bytes) = c.query_row(
                "SELECT COUNT(*),COALESCE(SUM(size_bytes),0) FROM blobs",
                [],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
            )?;
            let scalar = |sql: &str| c.query_row(sql, [], |r| r.get::<_, i64>(0));
            let cost = scalar("SELECT COALESCE(SUM(amount_microunits),0) FROM costs")?;
            Ok(LibraryUsage {
                blob_count: blob_count as u64,
                blob_bytes: blob_bytes as u64,
                asset_count: scalar("SELECT (SELECT COUNT(*) FROM assets)+(SELECT COUNT(*) FROM library_assets WHERE archived_at IS NULL)")? as u64,
                project_count: scalar("SELECT COUNT(*) FROM projects")? as u64,
                run_count: scalar("SELECT COUNT(*) FROM runs")? as u64,
                cost_microunits: cost,
                cost_decimal: decimal_from_microunits(cost),
            })
        })
    }

    pub fn storage_breakdown(&self) -> Result<StorageBreakdown, String> {
        self.with_connection(|connection| {
            let (total_blobs, total_bytes) = connection.query_row(
                "SELECT COUNT(*),COALESCE(SUM(size_bytes),0) FROM blobs", [],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )?;
            let mut statement = connection.prepare(
                "SELECT p.id,p.name,COALESCE(u.node_id,''),
                        CASE WHEN b.media_type LIKE 'image/%' THEN 'Bild' WHEN b.media_type LIKE 'video/%' THEN 'Video' WHEN b.media_type LIKE 'audio/%' THEN 'Audio' ELSE 'Text' END,
                        COALESCE(SUM(b.size_bytes),0),COUNT(r.id)
                 FROM projects p JOIN runs u ON u.project_id=p.id JOIN results r ON r.run_id=u.id
                 LEFT JOIN blobs b ON b.hash=r.blob_hash
                 GROUP BY p.id,p.name,u.node_id,4 ORDER BY p.name,5 DESC"
            )?;
            let projects = statement.query_map([], |row| Ok(StorageProjectRow {
                project_id: row.get(0)?, project_name: row.get(1)?, node_id: row.get(2)?, media_type: row.get(3)?,
                referenced_bytes: row.get::<_, i64>(4)?.max(0) as u64, result_count: row.get::<_, i64>(5)?.max(0) as u64,
            }))?.collect::<Result<Vec<_>, _>>()?;
            Ok(StorageBreakdown { total_bytes: total_bytes.max(0) as u64, total_blobs: total_blobs.max(0) as u64, projects })
        })
    }

    pub fn project_costs(&self, project_id: &str) -> Result<CostBreakdown, String> {
        self.with_connection(|connection| {
            let mut statement = connection.prepare(
                "WITH classified AS (
                   SELECT u.id,COALESCE(u.node_id,'') node_id,COALESCE(u.model,'Unbekannt') model,substr(COALESCE(u.finished_at,u.started_at),1,10) day,
                     COALESCE(c.provenance,'unknown') provenance,
                     c.amount_microunits amount
                   FROM runs u LEFT JOIN costs c ON c.run_id=u.id WHERE u.project_id=?1 AND u.provider!='local'
                 ) SELECT node_id,model,day,provenance,SUM(amount),COUNT(*) FROM classified GROUP BY node_id,model,day,provenance ORDER BY day DESC,node_id,model"
            )?;
            let rows = statement.query_map([project_id], |row| Ok(CostRow {
                node_id: row.get(0)?, model: row.get(1)?, day: row.get(2)?, provenance: row.get(3)?, amount_microunits: row.get(4)?, runs: row.get::<_, i64>(5)?.max(0) as u64,
            }))?.collect::<Result<Vec<_>, _>>()?;
            let actual_microunits = rows.iter().filter(|row| row.provenance == "actual").filter_map(|row| row.amount_microunits).sum();
            let estimated_microunits = rows.iter().filter(|row| row.provenance == "estimated").filter_map(|row| row.amount_microunits).sum();
            let unknown_runs = rows.iter().filter(|row| row.provenance == "unknown").map(|row| row.runs).sum();
            Ok(CostBreakdown { actual_microunits, estimated_microunits, unknown_runs, rows })
        })
    }

    pub fn delete_result(
        &self,
        project_id: &str,
        result_id: &str,
        protected_ids: &[String],
    ) -> Result<DeleteOutcome, String> {
        if protected_ids.iter().any(|id| id == result_id) {
            return Err(
                "Dieses Ergebnis wird im Canvas referenziert und kann nicht gelöscht werden."
                    .into(),
            );
        }
        self.with_connection(|connection| {
            let tx = connection.transaction()?;
            let (run_id, asset_id, kind, active): (String, Option<String>, String, bool) = tx.query_row(
                "SELECT r.run_id,r.asset_id,r.kind,EXISTS(SELECT 1 FROM active_results a WHERE a.result_id=r.id) FROM results r JOIN runs u ON u.id=r.run_id WHERE r.id=?1 AND u.project_id=?2",
                params![result_id,project_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
            )?;
            if active { return Err(rusqlite::Error::InvalidParameterName("Aktive Ergebnisse müssen vor dem Löschen umgeschaltet werden.".into())); }
            tx.execute("DELETE FROM results WHERE id=?1", [result_id])?;
            if kind == "video" { tx.execute("DELETE FROM results WHERE run_id=?1 AND kind IN ('video-start-frame','video-end-frame','video-import-start-frame','video-import-end-frame')", [&run_id])?; }
            if let Some(asset_id)=asset_id { tx.execute("DELETE FROM assets WHERE id=?1 AND NOT EXISTS(SELECT 1 FROM results WHERE asset_id=?1)",[asset_id])?; }
            tx.execute("DELETE FROM assets WHERE project_id=?1 AND NOT EXISTS(SELECT 1 FROM results WHERE asset_id=assets.id)",[project_id])?;
            let remaining: i64 = tx.query_row("SELECT COUNT(*) FROM results WHERE run_id=?1", [&run_id], |row| row.get(0))?;
            if remaining == 0 { tx.execute("DELETE FROM runs WHERE id=?1", [&run_id])?; }
            cleanup_orphan_media_metadata(&tx)?; let hashes = collect_orphaned_hashes(&tx)?;
            tx.commit()?;
            Ok(DeleteOutcome { removed_results: 1, orphaned_hashes: hashes })
        })
    }

    pub fn clear_node_history(
        &self,
        project_id: &str,
        node_id: &str,
        protected_ids: &[String],
    ) -> Result<DeleteOutcome, String> {
        self.with_connection(|connection| {
            let tx = connection.transaction()?;
            let protected=serde_json::to_string(protected_ids).map_err(|e|rusqlite::Error::ToSqlConversionFailure(e.into()))?;
            let removed = tx.execute(
                "DELETE FROM results WHERE run_id IN (SELECT id FROM runs WHERE project_id=?1 AND node_id=?2) AND id NOT IN (SELECT result_id FROM active_results WHERE project_id=?1 AND node_id=?2) AND id NOT IN (SELECT value FROM json_each(?3))",
                params![project_id,node_id,protected],
            )? as u64;
            tx.execute("DELETE FROM results WHERE run_id IN (SELECT id FROM runs WHERE project_id=?1 AND node_id=?2) AND kind IN ('video-start-frame','video-end-frame','video-import-start-frame','video-import-end-frame') AND NOT EXISTS(SELECT 1 FROM results visible WHERE visible.run_id=results.run_id AND visible.kind NOT IN ('video-start-frame','video-end-frame','video-import-start-frame','video-import-end-frame'))",params![project_id,node_id])?;
            tx.execute("DELETE FROM assets WHERE project_id=?1 AND NOT EXISTS(SELECT 1 FROM results WHERE asset_id=assets.id)",[project_id])?;
            tx.execute("DELETE FROM runs WHERE project_id=?1 AND node_id=?2 AND NOT EXISTS(SELECT 1 FROM results WHERE results.run_id=runs.id)", params![project_id,node_id])?;
            cleanup_orphan_media_metadata(&tx)?; let hashes=collect_orphaned_hashes(&tx)?; tx.commit()?;
            Ok(DeleteOutcome { removed_results: removed, orphaned_hashes: hashes })
        })
    }

    pub fn delete_project_records(&self, project_id: &str) -> Result<DeleteOutcome, String> {
        self.with_connection(|connection| {
            let tx = connection.transaction()?;
            let removed: i64 = tx.query_row(
                "SELECT COUNT(*) FROM results r JOIN runs u ON u.id=r.run_id WHERE u.project_id=?1",
                [project_id],
                |row| row.get(0),
            )?;
            tx.execute("DELETE FROM assets WHERE project_id=?1", [project_id])?;
            tx.execute("DELETE FROM projects WHERE id=?1", [project_id])?;
            cleanup_orphan_media_metadata(&tx)?;
            let hashes = collect_orphaned_hashes(&tx)?;
            tx.commit()?;
            Ok(DeleteOutcome {
                removed_results: removed.max(0) as u64,
                orphaned_hashes: hashes,
            })
        })
    }

    pub fn purge_blob_rows(&self, hashes: &[String]) -> Result<(), String> {
        self.with_connection(|connection| {
            let tx=connection.transaction()?;
            for hash in hashes { tx.execute("DELETE FROM blobs WHERE hash=?1 AND NOT EXISTS(SELECT 1 FROM results WHERE blob_hash=?1) AND NOT EXISTS(SELECT 1 FROM assets WHERE blob_hash=?1) AND NOT EXISTS(SELECT 1 FROM library_asset_versions WHERE blob_hash=?1 OR thumbnail_blob_hash=?1) AND NOT EXISTS(SELECT 1 FROM media_metadata WHERE blob_hash=?1 OR poster_blob_hash=?1) AND NOT EXISTS(SELECT 1 FROM document_covers WHERE blob_hash=?1)",[hash])?; }
            tx.commit()
        })
    }

    fn connection(&self) -> Result<Connection, String> {
        let c = Connection::open(&self.path).map_err(|e| e.to_string())?;
        c.busy_timeout(Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        c.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| e.to_string())?;
        c.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| e.to_string())?;
        c.pragma_update(None, "synchronous", "FULL")
            .map_err(|e| e.to_string())?;
        Ok(c)
    }
    pub(crate) fn with_connection<T>(
        &self,
        operation: impl FnOnce(&mut Connection) -> rusqlite::Result<T>,
    ) -> Result<T, String> {
        let _reference_guard = self
            .reference_lock
            .lock()
            .map_err(|_| "Referenzsperre ist beschädigt.".to_string())?;
        #[cfg(test)]
        if let Some((entered, release)) = self
            .reference_test_hook
            .lock()
            .map_err(|_| "Test-Referenzbarriere ist beschädigt.".to_string())?
            .take()
        {
            entered.wait();
            release.wait();
        }
        let mut c = self.connection()?;
        operation(&mut c).map_err(|e| e.to_string())
    }

    /// Only for a caller that already holds FlowZ's shared reference lock.
    pub(crate) fn with_catalog_connection<T>(
        &self,
        operation: impl FnOnce(&mut Connection) -> rusqlite::Result<T>,
    ) -> Result<T, String> {
        let mut connection = self.connection()?;
        operation(&mut connection).map_err(|error| error.to_string())
    }
}

fn upsert_project_row(connection: &Connection, project: &ProjectDocument) -> rusqlite::Result<()> {
    connection.execute("INSERT INTO projects(id,name,project_path,schema_version,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET name=excluded.name,schema_version=excluded.schema_version,updated_at=excluded.updated_at", params![project.id,project.name,format!("projects/{}/project.flowz.json",project.id),project.schema_version,project.created_at.to_rfc3339(),project.updated_at.to_rfc3339()])?;
    Ok(())
}

fn collect_orphaned_hashes(tx: &Transaction<'_>) -> rusqlite::Result<Vec<String>> {
    let mut statement=tx.prepare(
        "SELECT hash FROM blobs b WHERE NOT EXISTS(SELECT 1 FROM results WHERE blob_hash=b.hash) AND NOT EXISTS(SELECT 1 FROM assets WHERE blob_hash=b.hash) AND NOT EXISTS(SELECT 1 FROM library_asset_versions WHERE blob_hash=b.hash OR thumbnail_blob_hash=b.hash) AND NOT EXISTS(SELECT 1 FROM media_metadata WHERE blob_hash=b.hash OR poster_blob_hash=b.hash)"
    )?;
    let hashes = statement.query_map([], |row| row.get(0))?.collect();
    hashes
}

fn binding_hashes(
    tx: &Transaction<'_>,
    project_id: &str,
    binding: &LocalImageBinding,
) -> rusqlite::Result<Vec<String>> {
    match binding.mode.as_str() {
        "active" => {
            let value=tx.query_row("SELECT r.blob_hash FROM active_results ar JOIN results r ON r.id=ar.result_id JOIN blobs b ON b.hash=r.blob_hash WHERE ar.project_id=?1 AND ar.node_id=?2 AND b.media_type LIKE 'image/%'",params![project_id,binding.source_node_id],|row|row.get::<_,String>(0)).optional()?;
            Ok(value.into_iter().collect())
        }
        "results" => {
            let mut hashes = Vec::with_capacity(binding.result_ids.len());
            for id in &binding.result_ids {
                let value=tx.query_row("SELECT r.blob_hash FROM results r JOIN runs ru ON ru.id=r.run_id JOIN blobs b ON b.hash=r.blob_hash WHERE r.id=?1 AND ru.project_id=?2 AND b.media_type LIKE 'image/%'",params![id,project_id],|row|row.get::<_,String>(0)).optional()?;
                let Some(value) = value else {
                    return Ok(Vec::new());
                };
                hashes.push(value)
            }
            Ok(hashes)
        }
        "library_version" => {
            let mut hashes = Vec::with_capacity(binding.result_ids.len());
            for id in &binding.result_ids {
                let value=tx.query_row("SELECT v.blob_hash FROM library_asset_versions v JOIN blobs b ON b.hash=v.blob_hash WHERE v.id=?1 AND b.media_type LIKE 'image/%'",params![id],|row|row.get::<_,String>(0)).optional()?;
                let Some(value) = value else {
                    return Ok(Vec::new());
                };
                hashes.push(value)
            }
            Ok(hashes)
        }
        "active_group" => {
            let raw=tx.query_row("SELECT r.parameters_json FROM active_results ar JOIN results r ON r.id=ar.result_id WHERE ar.project_id=?1 AND ar.node_id=?2",params![project_id,binding.source_node_id],|row|row.get::<_,Option<String>>(0)).optional()?.flatten();
            let group = raw
                .and_then(|value| serde_json::from_str::<Value>(&value).ok())
                .and_then(|value| {
                    value
                        .get("groupRunId")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                });
            let Some(group) = group else {
                return Ok(Vec::new());
            };
            let mut statement=tx.prepare("SELECT r.blob_hash,r.parameters_json FROM results r JOIN runs ru ON ru.id=r.run_id JOIN blobs b ON b.hash=r.blob_hash WHERE ru.project_id=?1 AND ru.node_id=?2 AND b.media_type LIKE 'image/%'")?;
            let rows = statement.query_map(params![project_id, binding.source_node_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
            })?;
            let mut values = Vec::new();
            for row in rows {
                let (hash, raw) = row?;
                let parameters = raw.and_then(|value| serde_json::from_str::<Value>(&value).ok());
                if parameters
                    .as_ref()
                    .and_then(|value| value.get("groupRunId"))
                    .and_then(Value::as_str)
                    == Some(group.as_str())
                {
                    let order = parameters
                        .as_ref()
                        .and_then(|value| {
                            value.get("listIndex").or_else(|| value.get("variantIndex"))
                        })
                        .and_then(Value::as_u64)
                        .unwrap_or(u64::MAX);
                    values.push((order, hash));
                }
            }
            values.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
            Ok(values.into_iter().map(|(_, hash)| hash).collect())
        }
        _ => Ok(Vec::new()),
    }
}

fn cleanup_orphan_media_metadata(tx: &Transaction<'_>) -> rusqlite::Result<usize> {
    tx.execute("DELETE FROM media_metadata WHERE NOT EXISTS(SELECT 1 FROM results WHERE blob_hash=media_metadata.blob_hash) AND NOT EXISTS(SELECT 1 FROM assets WHERE blob_hash=media_metadata.blob_hash) AND NOT EXISTS(SELECT 1 FROM library_asset_versions WHERE blob_hash=media_metadata.blob_hash)",[])
}

fn cost_provenance(parameters: Option<&Value>) -> &'static str {
    match parameters
        .and_then(|p| p.get("costProvenance"))
        .and_then(Value::as_str)
    {
        Some("estimated") => "estimated",
        Some("unknown") => "unknown",
        _ => "actual",
    }
}

fn table_exists(tx: &Transaction<'_>, name: &str) -> rusqlite::Result<bool> {
    tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [name],
        |r| r.get(0),
    )
}
fn create_base_schema(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute_batch("CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,project_path TEXT NOT NULL,schema_version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,node_id TEXT,provider TEXT,model TEXT,status TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT,error_code TEXT); CREATE TABLE IF NOT EXISTS blobs(hash TEXT PRIMARY KEY,size_bytes INTEGER NOT NULL,media_type TEXT NOT NULL,relative_path TEXT NOT NULL,created_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY,project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,blob_hash TEXT NOT NULL REFERENCES blobs(hash),name TEXT NOT NULL,kind TEXT NOT NULL,metadata_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL);")
}
fn migrate_to_v2(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    if table_exists(tx, "results")? {
        tx.execute_batch("ALTER TABLE results RENAME TO results_v1;")?;
    }
    tx.execute_batch("CREATE TABLE results(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,kind TEXT NOT NULL,text_value TEXT,blob_hash TEXT REFERENCES blobs(hash) ON DELETE SET NULL,created_at TEXT NOT NULL);")?;
    if table_exists(tx, "results_v1")? {
        tx.execute_batch("INSERT INTO results SELECT id,run_id,kind,text_value,CASE WHEN blob_hash IN (SELECT hash FROM blobs) THEN blob_hash ELSE NULL END,created_at FROM results_v1; DROP TABLE results_v1;")?;
    }
    if table_exists(tx, "costs")? {
        tx.execute_batch("ALTER TABLE costs RENAME TO costs_v1;")?;
    }
    tx.execute_batch("CREATE TABLE costs(id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,currency TEXT NOT NULL DEFAULT 'USD',amount_microunits INTEGER NOT NULL,created_at TEXT NOT NULL);")?;
    if table_exists(tx, "costs_v1")? {
        tx.execute_batch("INSERT INTO costs(id,run_id,currency,amount_microunits,created_at) SELECT id,run_id,currency,amount_microunits,created_at FROM costs_v1; DROP TABLE costs_v1;")?;
    }
    Ok(())
}

fn migrate_v2_to_v3(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute_batch(
        "CREATE TEMP TABLE active_results_migration(project_id TEXT,node_id TEXT,result_id TEXT);",
    )?;
    if table_exists(tx, "active_results")? {
        tx.execute_batch("INSERT INTO active_results_migration SELECT project_id,node_id,result_id FROM active_results; DROP TABLE active_results;")?;
    }
    tx.execute_batch(
        "ALTER TABLE results RENAME TO results_v2;
         CREATE TABLE results(
           id TEXT PRIMARY KEY,
           run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
           kind TEXT NOT NULL,
           text_value TEXT,
           blob_hash TEXT REFERENCES blobs(hash) ON DELETE SET NULL,
           asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
           prompt TEXT,
           parameters_json TEXT CHECK(parameters_json IS NULL OR json_valid(parameters_json)),
           created_at TEXT NOT NULL
         );
         INSERT INTO results(id,run_id,kind,text_value,blob_hash,asset_id,prompt,parameters_json,created_at)
           SELECT id,run_id,kind,text_value,blob_hash,NULL,NULL,NULL,created_at FROM results_v2;
         DROP TABLE results_v2;
         CREATE TABLE active_results(
           project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
           node_id TEXT NOT NULL,
           result_id TEXT NOT NULL REFERENCES results(id) ON DELETE CASCADE,
           PRIMARY KEY(project_id,node_id)
         );
         INSERT INTO active_results(project_id,node_id,result_id)
           SELECT m.project_id,m.node_id,m.result_id FROM active_results_migration m
           JOIN results r ON r.id=m.result_id
           JOIN runs ru ON ru.id=r.run_id AND ru.project_id=m.project_id AND ru.node_id=m.node_id;
         DROP TABLE active_results_migration;
         CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id);
         CREATE INDEX IF NOT EXISTS idx_results_run ON results(run_id);
         CREATE INDEX IF NOT EXISTS idx_results_asset ON results(asset_id);
         CREATE INDEX IF NOT EXISTS idx_assets_project ON assets(project_id);
         CREATE INDEX IF NOT EXISTS idx_costs_run ON costs(run_id);",
    )
}

fn migrate_v3_to_v4(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS library_assets(
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120),
           kind TEXT NOT NULL CHECK(kind IN ('prompt','text','image')),
           created_at TEXT NOT NULL,
           archived_at TEXT
         );
         CREATE TABLE IF NOT EXISTS library_asset_versions(
           id TEXT PRIMARY KEY,
           asset_id TEXT NOT NULL REFERENCES library_assets(id) ON DELETE CASCADE,
           version INTEGER NOT NULL CHECK(version > 0),
           text_value TEXT,
           blob_hash TEXT REFERENCES blobs(hash) ON DELETE RESTRICT,
           source_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
           source_node_id TEXT,
           source_result_id TEXT REFERENCES results(id) ON DELETE SET NULL,
           created_at TEXT NOT NULL,
           CHECK((text_value IS NOT NULL AND blob_hash IS NULL) OR (text_value IS NULL AND blob_hash IS NOT NULL)),
           UNIQUE(asset_id,version)
         );
         CREATE INDEX IF NOT EXISTS idx_library_assets_kind_created ON library_assets(kind,created_at DESC);
         CREATE INDEX IF NOT EXISTS idx_library_versions_asset ON library_asset_versions(asset_id,version DESC);"
    )
}

fn migrate_v4_to_v5(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute_batch(
        "ALTER TABLE library_asset_versions ADD COLUMN thumbnail_blob_hash TEXT REFERENCES blobs(hash) ON DELETE RESTRICT;
         CREATE INDEX IF NOT EXISTS idx_library_versions_thumbnail ON library_asset_versions(thumbnail_blob_hash);"
    )
}

fn migrate_v5_to_v6(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS media_metadata(
           blob_hash TEXT PRIMARY KEY REFERENCES blobs(hash) ON DELETE CASCADE,
           kind TEXT NOT NULL CHECK(kind IN ('video','audio')),
           metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
           poster_blob_hash TEXT REFERENCES blobs(hash) ON DELETE SET NULL
         );
         CREATE INDEX IF NOT EXISTS idx_media_metadata_kind ON media_metadata(kind);",
    )
}

fn migrate_v6_to_v7(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('costs') WHERE name='provenance')",
        [],
        |row| row.get(0),
    )?;
    if !exists {
        tx.execute_batch("ALTER TABLE costs ADD COLUMN provenance TEXT NOT NULL DEFAULT 'actual' CHECK(provenance IN ('actual','estimated','unknown'));")?;
    }
    tx.execute_batch("CREATE INDEX IF NOT EXISTS idx_costs_provenance ON costs(provenance);")
}

fn migrate_v7_to_v8(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS font_provenance(
           font_hash TEXT PRIMARY KEY REFERENCES blobs(hash) ON DELETE RESTRICT,
           license_blob_hash TEXT NOT NULL REFERENCES blobs(hash) ON DELETE RESTRICT,
           contract_json TEXT NOT NULL CHECK(json_valid(contract_json)),
           selections_json TEXT NOT NULL CHECK(json_valid(selections_json))
         );
         CREATE INDEX IF NOT EXISTS idx_font_provenance_license ON font_provenance(license_blob_hash);",
    )
}

fn migrate_v8_to_v9(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS artboard_workspaces(
           id TEXT PRIMARY KEY,
           project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
           node_id TEXT,
           name TEXT NOT NULL,
           created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS artboard_input_snapshots(
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES artboard_workspaces(id) ON DELETE CASCADE,
           snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
           created_at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS artboard_branches(
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES artboard_workspaces(id) ON DELETE CASCADE,
           name TEXT NOT NULL,
           head_revision_id TEXT,
           redo_revision_id TEXT,
           fork_revision_id TEXT,
           created_at TEXT NOT NULL,
           UNIQUE(workspace_id,name)
         );
         CREATE TABLE IF NOT EXISTS artboard_revisions(
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES artboard_workspaces(id) ON DELETE CASCADE,
           branch_id TEXT NOT NULL REFERENCES artboard_branches(id) ON DELETE CASCADE,
           parent_revision_id TEXT REFERENCES artboard_revisions(id) ON DELETE RESTRICT,
           revision_number INTEGER NOT NULL CHECK(revision_number > 0),
           workspace_json TEXT NOT NULL CHECK(json_valid(workspace_json)),
           input_snapshot_id TEXT REFERENCES artboard_input_snapshots(id) ON DELETE RESTRICT,
           operation_id TEXT NOT NULL,
           request_hash TEXT,
           operations_json TEXT NOT NULL CHECK(json_valid(operations_json)),
           created_at TEXT NOT NULL,
           UNIQUE(workspace_id,operation_id),
           UNIQUE(branch_id,revision_number)
         );
         CREATE TABLE IF NOT EXISTS artboard_board_revisions(
           id TEXT PRIMARY KEY,
           workspace_id TEXT NOT NULL REFERENCES artboard_workspaces(id) ON DELETE CASCADE,
           workspace_revision_id TEXT NOT NULL REFERENCES artboard_revisions(id) ON DELETE CASCADE,
           board_id TEXT NOT NULL,
           parent_board_revision_id TEXT REFERENCES artboard_board_revisions(id) ON DELETE RESTRICT,
           derived_from_board_revision_id TEXT REFERENCES artboard_board_revisions(id) ON DELETE RESTRICT,
           branch_id TEXT NOT NULL,
           board_json TEXT NOT NULL CHECK(json_valid(board_json)),
           created_at TEXT NOT NULL,
           UNIQUE(workspace_revision_id,board_id)
         );
         CREATE INDEX IF NOT EXISTS idx_artboard_revisions_workspace ON artboard_revisions(workspace_id,created_at);
         CREATE INDEX IF NOT EXISTS idx_artboard_revisions_branch ON artboard_revisions(branch_id,revision_number);
         CREATE INDEX IF NOT EXISTS idx_artboard_board_revisions_board ON artboard_board_revisions(workspace_id,board_id,created_at);
         CREATE INDEX IF NOT EXISTS idx_artboard_snapshots_workspace ON artboard_input_snapshots(workspace_id,created_at);",
    )
}

fn migrate_v9_to_v10(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    let branch_fork_exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('artboard_branches') WHERE name='fork_revision_id')", [], |row| row.get(0))?;
    if !branch_fork_exists {
        tx.execute_batch("ALTER TABLE artboard_branches ADD COLUMN fork_revision_id TEXT;")?;
    }
    let request_hash_exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('artboard_revisions') WHERE name='request_hash')", [], |row| row.get(0))?;
    if !request_hash_exists {
        tx.execute_batch("ALTER TABLE artboard_revisions ADD COLUMN request_hash TEXT;")?;
    }
    let derived_exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('artboard_board_revisions') WHERE name='derived_from_board_revision_id')", [], |row| row.get(0))?;
    if !derived_exists {
        tx.execute_batch("ALTER TABLE artboard_board_revisions ADD COLUMN derived_from_board_revision_id TEXT REFERENCES artboard_board_revisions(id) ON DELETE RESTRICT;")?;
    }
    tx.execute_batch("CREATE TABLE IF NOT EXISTS artboard_branch_redo_stack(branch_id TEXT NOT NULL REFERENCES artboard_branches(id) ON DELETE CASCADE,position INTEGER NOT NULL CHECK(position>=0),revision_id TEXT NOT NULL REFERENCES artboard_revisions(id) ON DELETE CASCADE,PRIMARY KEY(branch_id,position));")?;
    Ok(())
}

fn migrate_v10_to_v11(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS catalog_operations(
           operation_id TEXT PRIMARY KEY,
           action TEXT NOT NULL,
           document_kind TEXT NOT NULL,
           request_hash TEXT NOT NULL,
           document_id TEXT NOT NULL,
           created_at TEXT NOT NULL,
           deleted_at TEXT
         );
         CREATE INDEX IF NOT EXISTS idx_catalog_operations_document
           ON catalog_operations(document_id);",
    )
}

fn migrate_v11_to_v12(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS document_covers(
           document_id TEXT NOT NULL,
           document_kind TEXT NOT NULL CHECK(document_kind IN ('flow','artboard')),
           revision INTEGER NOT NULL CHECK(revision > 0),
           content_fingerprint TEXT NOT NULL CHECK(length(content_fingerprint)=64),
           blob_hash TEXT NOT NULL REFERENCES blobs(hash) ON DELETE RESTRICT,
           width INTEGER NOT NULL CHECK(width BETWEEN 1 AND 512),
           height INTEGER NOT NULL CHECK(height BETWEEN 1 AND 512),
           media_type TEXT NOT NULL CHECK(media_type IN ('image/png','image/svg+xml')),
           generated_at TEXT NOT NULL,
           PRIMARY KEY(document_id,document_kind)
         );
         CREATE INDEX IF NOT EXISTS idx_document_covers_blob ON document_covers(blob_hash);",
    )
}

fn schema_error(message: impl Into<String>) -> rusqlite::Error {
    rusqlite::Error::InvalidParameterName(format!("SCHEMA_INCOMPATIBLE: {}", message.into()))
}

fn table_columns(connection: &Connection, table: &str) -> rusqlite::Result<Vec<String>> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info('{table}')"))?;
    let columns = statement
        .query_map([], |row| row.get(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(columns)
}

fn require_columns(
    connection: &Connection,
    table: &str,
    required: &[&str],
) -> rusqlite::Result<()> {
    if !connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [table],
        |row| row.get::<_, bool>(0),
    )? {
        return Err(schema_error(format!("Pflichttabelle {table} fehlt.")));
    }
    let columns = table_columns(connection, table)?;
    let missing = required
        .iter()
        .filter(|column| !columns.iter().any(|existing| existing == **column))
        .copied()
        .collect::<Vec<_>>();
    if missing.is_empty() {
        Ok(())
    } else {
        Err(schema_error(format!(
            "Tabelle {table} besitzt nicht die erwartete Form; fehlend: {}. Die Datenbank wurde nicht destruktiv verändert. Verwende das Migrationsbackup zur Wiederherstellung.",
            missing.join(", ")
        )))
    }
}

fn add_column_if_missing(
    tx: &Transaction<'_>,
    table: &str,
    column: &str,
    declaration: &str,
) -> rusqlite::Result<()> {
    if table_exists(tx, table)? && !table_columns(tx, table)?.iter().any(|name| name == column) {
        tx.execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN {column} {declaration};"
        ))?;
    }
    Ok(())
}

/// Recreates only safely additive schema objects. Existing tables are never renamed,
/// dropped, or copied here; incompatible shapes are rejected by validate_current_schema.
fn repair_current_schema(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    create_base_schema(tx)?;
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS results(
           id TEXT PRIMARY KEY,
           run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
           kind TEXT NOT NULL,
           text_value TEXT,
           blob_hash TEXT REFERENCES blobs(hash) ON DELETE SET NULL,
           asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
           prompt TEXT,
           parameters_json TEXT CHECK(parameters_json IS NULL OR json_valid(parameters_json)),
           created_at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS costs(
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
           currency TEXT NOT NULL DEFAULT 'USD',
           amount_microunits INTEGER NOT NULL,
           created_at TEXT NOT NULL,
           provenance TEXT NOT NULL DEFAULT 'actual' CHECK(provenance IN ('actual','estimated','unknown'))
         );
         CREATE TABLE IF NOT EXISTS active_results(
           project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
           node_id TEXT NOT NULL,
           result_id TEXT NOT NULL REFERENCES results(id) ON DELETE CASCADE,
           PRIMARY KEY(project_id,node_id)
         );",
    )?;

    add_column_if_missing(
        tx,
        "results",
        "asset_id",
        "TEXT REFERENCES assets(id) ON DELETE SET NULL",
    )?;
    add_column_if_missing(tx, "results", "prompt", "TEXT")?;
    add_column_if_missing(
        tx,
        "results",
        "parameters_json",
        "TEXT CHECK(parameters_json IS NULL OR json_valid(parameters_json))",
    )?;
    add_column_if_missing(
        tx,
        "costs",
        "provenance",
        "TEXT NOT NULL DEFAULT 'actual' CHECK(provenance IN ('actual','estimated','unknown'))",
    )?;

    migrate_v3_to_v4(tx)?;
    add_column_if_missing(
        tx,
        "library_asset_versions",
        "thumbnail_blob_hash",
        "TEXT REFERENCES blobs(hash) ON DELETE RESTRICT",
    )?;
    migrate_v5_to_v6(tx)?;
    migrate_v7_to_v8(tx)?;
    migrate_v8_to_v9(tx)?;
    add_column_if_missing(tx, "artboard_branches", "fork_revision_id", "TEXT")?;
    add_column_if_missing(tx, "artboard_revisions", "request_hash", "TEXT")?;
    add_column_if_missing(
        tx,
        "artboard_board_revisions",
        "derived_from_board_revision_id",
        "TEXT REFERENCES artboard_board_revisions(id) ON DELETE RESTRICT",
    )?;
    migrate_v9_to_v10(tx)?;
    migrate_v10_to_v11(tx)?;
    migrate_v11_to_v12(tx)?;

    tx.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id);
         CREATE INDEX IF NOT EXISTS idx_results_run ON results(run_id);
         CREATE INDEX IF NOT EXISTS idx_results_asset ON results(asset_id);
         CREATE INDEX IF NOT EXISTS idx_assets_project ON assets(project_id);
         CREATE INDEX IF NOT EXISTS idx_costs_run ON costs(run_id);
         CREATE INDEX IF NOT EXISTS idx_costs_provenance ON costs(provenance);
         CREATE INDEX IF NOT EXISTS idx_library_assets_kind_created ON library_assets(kind,created_at DESC);
         CREATE INDEX IF NOT EXISTS idx_library_versions_asset ON library_asset_versions(asset_id,version DESC);
         CREATE INDEX IF NOT EXISTS idx_library_versions_thumbnail ON library_asset_versions(thumbnail_blob_hash);
         CREATE INDEX IF NOT EXISTS idx_media_metadata_kind ON media_metadata(kind);
         CREATE INDEX IF NOT EXISTS idx_font_provenance_license ON font_provenance(license_blob_hash);
         CREATE INDEX IF NOT EXISTS idx_artboard_revisions_workspace ON artboard_revisions(workspace_id,created_at);
         CREATE INDEX IF NOT EXISTS idx_artboard_revisions_branch ON artboard_revisions(branch_id,revision_number);
         CREATE INDEX IF NOT EXISTS idx_artboard_board_revisions_board ON artboard_board_revisions(workspace_id,board_id,created_at);
         CREATE INDEX IF NOT EXISTS idx_artboard_snapshots_workspace ON artboard_input_snapshots(workspace_id,created_at);
         CREATE INDEX IF NOT EXISTS idx_catalog_operations_document ON catalog_operations(document_id);
         CREATE INDEX IF NOT EXISTS idx_document_covers_blob ON document_covers(blob_hash);",
    )?;
    Ok(())
}

fn validate_current_schema(connection: &Connection) -> rusqlite::Result<()> {
    for (table, columns) in [
        (
            "projects",
            &[
                "id",
                "name",
                "project_path",
                "schema_version",
                "created_at",
                "updated_at",
            ][..],
        ),
        (
            "runs",
            &[
                "id",
                "project_id",
                "node_id",
                "provider",
                "model",
                "status",
                "started_at",
                "finished_at",
                "error_code",
            ],
        ),
        (
            "blobs",
            &[
                "hash",
                "size_bytes",
                "media_type",
                "relative_path",
                "created_at",
            ],
        ),
        (
            "assets",
            &[
                "id",
                "project_id",
                "blob_hash",
                "name",
                "kind",
                "metadata_json",
                "created_at",
            ],
        ),
        (
            "results",
            &[
                "id",
                "run_id",
                "kind",
                "text_value",
                "blob_hash",
                "asset_id",
                "prompt",
                "parameters_json",
                "created_at",
            ],
        ),
        (
            "costs",
            &[
                "id",
                "run_id",
                "currency",
                "amount_microunits",
                "created_at",
                "provenance",
            ],
        ),
        ("active_results", &["project_id", "node_id", "result_id"]),
        (
            "library_assets",
            &["id", "name", "kind", "created_at", "archived_at"],
        ),
        (
            "library_asset_versions",
            &[
                "id",
                "asset_id",
                "version",
                "text_value",
                "blob_hash",
                "source_project_id",
                "source_node_id",
                "source_result_id",
                "created_at",
                "thumbnail_blob_hash",
            ],
        ),
        (
            "media_metadata",
            &["blob_hash", "kind", "metadata_json", "poster_blob_hash"],
        ),
        (
            "font_provenance",
            &[
                "font_hash",
                "license_blob_hash",
                "contract_json",
                "selections_json",
            ],
        ),
        (
            "artboard_workspaces",
            &[
                "id",
                "project_id",
                "node_id",
                "name",
                "created_at",
                "updated_at",
            ],
        ),
        (
            "artboard_input_snapshots",
            &["id", "workspace_id", "snapshot_json", "created_at"],
        ),
        (
            "artboard_branches",
            &[
                "id",
                "workspace_id",
                "name",
                "head_revision_id",
                "redo_revision_id",
                "fork_revision_id",
                "created_at",
            ],
        ),
        (
            "artboard_revisions",
            &[
                "id",
                "workspace_id",
                "branch_id",
                "parent_revision_id",
                "revision_number",
                "workspace_json",
                "input_snapshot_id",
                "operation_id",
                "request_hash",
                "operations_json",
                "created_at",
            ],
        ),
        (
            "artboard_board_revisions",
            &[
                "id",
                "workspace_id",
                "workspace_revision_id",
                "board_id",
                "parent_board_revision_id",
                "derived_from_board_revision_id",
                "branch_id",
                "board_json",
                "created_at",
            ],
        ),
        (
            "artboard_branch_redo_stack",
            &["branch_id", "position", "revision_id"],
        ),
        (
            "catalog_operations",
            &[
                "operation_id",
                "action",
                "document_kind",
                "request_hash",
                "document_id",
                "created_at",
                "deleted_at",
            ],
        ),
        (
            "document_covers",
            &[
                "document_id",
                "document_kind",
                "revision",
                "content_fingerprint",
                "blob_hash",
                "width",
                "height",
                "media_type",
                "generated_at",
            ],
        ),
    ] {
        require_columns(connection, table, columns)?;
    }

    let active_pk: Vec<(String, i64)> = connection
        .prepare("PRAGMA table_info('active_results')")?
        .query_map([], |row| Ok((row.get(1)?, row.get(5)?)))?
        .collect::<rusqlite::Result<_>>()?;
    if !active_pk
        .iter()
        .any(|(name, order)| name == "project_id" && *order == 1)
        || !active_pk
            .iter()
            .any(|(name, order)| name == "node_id" && *order == 2)
    {
        return Err(schema_error(
            "active_results besitzt nicht den erwarteten zusammengesetzten Primärschlüssel.",
        ));
    }
    for (from, target, on_delete) in [
        ("project_id", "projects", "CASCADE"),
        ("result_id", "results", "CASCADE"),
    ] {
        let valid: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_foreign_key_list('active_results') WHERE \"from\"=?1 AND \"table\"=?2 AND upper(on_delete)=?3)",
            params![from, target, on_delete],
            |row| row.get(0),
        )?;
        if !valid {
            return Err(schema_error(format!(
                "active_results.{from} besitzt nicht den erwarteten Fremdschlüssel."
            )));
        }
    }
    for index in [
        "idx_runs_project",
        "idx_results_run",
        "idx_results_asset",
        "idx_assets_project",
        "idx_costs_run",
        "idx_costs_provenance",
        "idx_library_assets_kind_created",
        "idx_library_versions_asset",
        "idx_library_versions_thumbnail",
        "idx_media_metadata_kind",
        "idx_font_provenance_license",
        "idx_artboard_revisions_workspace",
        "idx_artboard_revisions_branch",
        "idx_artboard_board_revisions_board",
        "idx_artboard_snapshots_workspace",
        "idx_catalog_operations_document",
        "idx_document_covers_blob",
    ] {
        let exists: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name=?1 AND sql IS NOT NULL)",
            [index],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(schema_error(format!("Pflichtindex {index} fehlt.")));
        }
    }
    let malformed_triggers: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND (name IS NULL OR sql IS NULL)",
        [],
        |row| row.get(0),
    )?;
    if malformed_triggers != 0 {
        return Err(schema_error("Der Trigger-Katalog ist unvollständig."));
    }
    let foreign_key_violations: i64 =
        connection.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })?;
    if foreign_key_violations != 0 {
        return Err(schema_error(format!(
            "Die Datenbank enthält {foreign_key_violations} Fremdschlüsselverletzungen."
        )));
    }
    Ok(())
}

fn backup_database(path: &Path) -> Result<(), String> {
    let backup = path.with_extension("sqlite3.migration.bak");
    fs::copy(path, &backup).map_err(|e| e.to_string())?;
    let c = Connection::open(&backup).map_err(|e| e.to_string())?;
    let status: String = c
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if status != "ok" {
        let _ = fs::remove_file(backup);
        return Err("SQLite-Migrationsbackup ist ungültig.".into());
    }
    Ok(())
}
pub fn decimal_to_microunits(value: &str) -> Result<i64, String> {
    let value = value.trim();
    let negative = value.starts_with('-');
    let unsigned = value.trim_start_matches(['-', '+']);
    let mut parts = unsigned.split('.');
    let whole = parts.next().unwrap_or("");
    let fraction = parts.next().unwrap_or("");
    if whole.is_empty()
        || parts.next().is_some()
        || fraction.len() > 6
        || !whole.chars().all(|c| c.is_ascii_digit())
        || !fraction.chars().all(|c| c.is_ascii_digit())
    {
        return Err(
            "Kostenbetrag muss eine Dezimalzahl mit höchstens sechs Nachkommastellen sein.".into(),
        );
    }
    let whole: i64 = whole
        .parse()
        .map_err(|_| "Kostenbetrag ist zu groß.".to_string())?;
    let frac: i64 = format!("{fraction:0<6}")
        .parse()
        .map_err(|_| "Ungültiger Kostenbetrag.".to_string())?;
    let amount = whole
        .checked_mul(1_000_000)
        .and_then(|v| v.checked_add(frac))
        .ok_or("Kostenbetrag ist zu groß.")?;
    Ok(if negative { -amount } else { amount })
}
fn decimal_from_microunits(value: i64) -> String {
    let sign = if value < 0 { "-" } else { "" };
    let v = value.unsigned_abs();
    format!("{}{}.{:06}", sign, v / 1_000_000, v % 1_000_000)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Barrier;
    #[test]
    fn decimal_conversion_is_exact() {
        assert_eq!(decimal_to_microunits("12.345678").unwrap(), 12_345_678);
        assert_eq!(decimal_from_microunits(12_345_678), "12.345678");
    }
    #[test]
    fn committed_text_reference_wins_against_concurrent_font_cache_delete() {
        let temp = tempfile::tempdir().unwrap();
        let database = Database::new(temp.path().join("flowz.sqlite3")).unwrap();
        let font_hash = "a".repeat(64);
        let license_hash = "b".repeat(64);
        database.with_connection(|connection|{connection.execute("INSERT INTO projects(id,name,project_path,schema_version,created_at,updated_at) VALUES('project','P','p',2,'now','now')",[])?;for (hash,kind) in [(&font_hash,"font/ttf"),(&license_hash,"text/plain")]{connection.execute("INSERT INTO blobs(hash,size_bytes,media_type,relative_path,created_at) VALUES(?1,8,?2,?3,'now')",params![hash,kind,hash])?;}Ok(())}).unwrap();
        database
            .record_font_provenance(
                &font_hash,
                &license_hash,
                &serde_json::json!({"family":"Inter"}),
                &serde_json::json!({"axes":{}}),
            )
            .unwrap();
        let entered = Arc::new(Barrier::new(2));
        let release = Arc::new(Barrier::new(2));
        *database.reference_test_hook.lock().unwrap() = Some((entered.clone(), release.clone()));
        let committing = database.clone();
        let referenced_hash = font_hash.clone();
        let commit = std::thread::spawn(move || {
            committing.record_provider_text_result_atomic(
                "result",
                "run",
                "project",
                "node",
                "model",
                "font-pairing",
                "text",
                Some(&serde_json::json!({"fontHash":referenced_hash})),
                None,
                "now",
                false,
            )
        });
        entered.wait();
        let deleting = database.clone();
        let delete_font = font_hash.clone();
        let delete_license = license_hash.clone();
        let deletion = std::thread::spawn(move || {
            deleting.delete_font_cache_blobs_atomic(
                &delete_font,
                &delete_license,
                || Ok(()),
                |_| Ok(()),
            )
        });
        release.wait();
        assert!(commit.join().unwrap().is_ok());
        assert!(deletion.join().unwrap().is_err());
        assert!(database.contains_blob(&font_hash).unwrap());
    }
    #[test]
    fn refuses_newer_database() {
        let t = tempfile::tempdir().unwrap();
        let p = t.path().join("db");
        let c = Connection::open(&p).unwrap();
        c.pragma_update(None, "user_version", DATABASE_SCHEMA_VERSION + 1)
            .unwrap();
        drop(c);
        assert!(Database::new(p).unwrap_err().contains("höchstens"));
    }

    #[test]
    fn current_schema_repairs_missing_active_results_without_rewriting_version() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("flowz.sqlite3");
        Database::new(path.clone()).unwrap();
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch("DROP TABLE active_results; PRAGMA user_version=12;")
            .unwrap();
        drop(connection);

        Database::new(path.clone()).unwrap();
        let connection = Connection::open(path).unwrap();
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        let exists: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='active_results')",
            [], |row| row.get(0),
        ).unwrap();
        assert_eq!(version, DATABASE_SCHEMA_VERSION);
        assert!(exists);
    }

    #[test]
    fn current_schema_repairs_partial_older_backup_additively_and_is_idempotent() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("flowz.sqlite3");
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,project_path TEXT NOT NULL,schema_version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
             CREATE TABLE runs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,node_id TEXT,provider TEXT,model TEXT,status TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT,error_code TEXT);
             CREATE TABLE blobs(hash TEXT PRIMARY KEY,size_bytes INTEGER NOT NULL,media_type TEXT NOT NULL,relative_path TEXT NOT NULL,created_at TEXT NOT NULL);
             CREATE TABLE assets(id TEXT PRIMARY KEY,project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,blob_hash TEXT NOT NULL REFERENCES blobs(hash),name TEXT NOT NULL,kind TEXT NOT NULL,metadata_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL);
             CREATE TABLE results(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,kind TEXT NOT NULL,text_value TEXT,blob_hash TEXT REFERENCES blobs(hash) ON DELETE SET NULL,created_at TEXT NOT NULL);
             CREATE TABLE costs(id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,currency TEXT NOT NULL DEFAULT 'USD',amount_microunits INTEGER NOT NULL,created_at TEXT NOT NULL);
             INSERT INTO projects VALUES('project','Kept','project',2,'now','now');
             PRAGMA user_version=12;",
        ).unwrap();
        drop(connection);

        Database::new(path.clone()).unwrap();
        Database::new(path.clone()).unwrap();
        let connection = Connection::open(path).unwrap();
        assert_eq!(
            connection
                .query_row("SELECT name FROM projects WHERE id='project'", [], |row| {
                    row.get::<_, String>(0)
                })
                .unwrap(),
            "Kept"
        );
        for table in [
            "active_results",
            "artboard_workspaces",
            "catalog_operations",
            "document_covers",
        ] {
            assert!(
                connection
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                        [table],
                        |row| row.get::<_, bool>(0),
                    )
                    .unwrap(),
                "missing {table}"
            );
        }
        for column in ["asset_id", "prompt", "parameters_json"] {
            assert!(
                connection
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('results') WHERE name=?1)",
                        [column],
                        |row| row.get::<_, bool>(0),
                    )
                    .unwrap(),
                "missing results.{column}"
            );
        }
    }

    #[test]
    fn current_schema_repair_preserves_existing_active_results() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("flowz.sqlite3");
        Database::new(path.clone()).unwrap();
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch(
            "INSERT INTO projects VALUES('project','P','p',2,'now','now');
             INSERT INTO runs VALUES('run','project','node','local','model','success','now','now',NULL);
             INSERT INTO results(id,run_id,kind,text_value,created_at) VALUES('result','run','text','kept','now');
             INSERT INTO active_results VALUES('project','node','result');",
        ).unwrap();
        drop(connection);

        Database::new(path.clone()).unwrap();
        let connection = Connection::open(path).unwrap();
        let active: String = connection.query_row(
            "SELECT result_id FROM active_results WHERE project_id='project' AND node_id='node'",
            [], |row| row.get(0),
        ).unwrap();
        assert_eq!(active, "result");
    }

    #[test]
    fn concurrent_current_schema_repair_is_serialized() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("flowz.sqlite3");
        Database::new(path.clone()).unwrap();
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch("DROP TABLE active_results; PRAGMA user_version=12;")
            .unwrap();
        drop(connection);
        let barrier = Arc::new(Barrier::new(3));
        let mut threads = Vec::new();
        for _ in 0..2 {
            let path = path.clone();
            let barrier = barrier.clone();
            threads.push(std::thread::spawn(move || {
                barrier.wait();
                Database::new(path)
            }));
        }
        barrier.wait();
        for thread in threads {
            thread.join().unwrap().unwrap();
        }
        Database::new(path).unwrap();
    }

    #[test]
    fn current_schema_rejects_incompatible_existing_shape_without_dropping_data() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("flowz.sqlite3");
        Database::new(path.clone()).unwrap();
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "DROP TABLE active_results;
             CREATE TABLE active_results(project_id TEXT PRIMARY KEY, legacy_payload TEXT);
             INSERT INTO active_results VALUES('kept','payload');
             PRAGMA user_version=12;",
            )
            .unwrap();
        drop(connection);
        let error = Database::new(path.clone()).unwrap_err();
        assert!(error.contains("SCHEMA_INCOMPATIBLE"));
        let connection = Connection::open(path).unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT legacy_payload FROM active_results WHERE project_id='kept'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "payload"
        );
    }

    #[test]
    fn v5_migrates_to_v6_without_reusing_thumbnail_schema_version() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("flowz.sqlite3");
        Database::new(path.clone()).unwrap();
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch("DROP TABLE media_metadata; PRAGMA user_version=5;")
            .unwrap();
        drop(connection);
        Database::new(path.clone()).unwrap();
        let connection = Connection::open(path).unwrap();
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        let exists: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='media_metadata'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!((version, exists), (DATABASE_SCHEMA_VERSION, 1));
    }

    #[test]
    fn v12_cover_migration_is_repeatable_and_keeps_the_blob_reference_contract() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("flowz.sqlite3");
        Database::new(path.clone()).unwrap();
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch("DROP TABLE document_covers; PRAGMA user_version=11;")
            .unwrap();
        drop(connection);
        Database::new(path.clone()).unwrap();
        let connection = Connection::open(&path).unwrap();
        let columns: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('document_covers')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(columns, 9);
        connection.pragma_update(None, "user_version", 11).unwrap();
        drop(connection);
        Database::new(path.clone()).unwrap();
        let connection = Connection::open(path).unwrap();
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        let foreign_key: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_foreign_key_list('document_covers') WHERE \"table\"='blobs' AND \"from\"='blob_hash'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!((version, foreign_key), (DATABASE_SCHEMA_VERSION, 1));
    }

    #[test]
    fn schema_v3_has_result_provenance_metadata_and_one_cost_source_of_truth() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("flowz.sqlite3");
        Database::new(path.clone()).unwrap();
        let connection = Connection::open(path).unwrap();
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, DATABASE_SCHEMA_VERSION);
        let media_table: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='media_metadata'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(media_table, 1);
        let mut columns = connection.prepare("PRAGMA table_info(costs)").unwrap();
        let names: Vec<String> = columns
            .query_map([], |row| row.get(1))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(names.contains(&"amount_microunits".into()));
        assert!(!names.contains(&"amount_decimal".into()));
        let mut foreign_keys = connection
            .prepare("PRAGMA foreign_key_list(results)")
            .unwrap();
        let targets: Vec<String> = foreign_keys
            .query_map([], |row| row.get(2))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(targets.contains(&"blobs".into()));
        assert!(targets.contains(&"assets".into()));
        let result_columns: Vec<String> = connection
            .prepare("PRAGMA table_info(results)")
            .unwrap()
            .query_map([], |row| row.get(1))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        for expected in ["asset_id", "prompt", "parameters_json"] {
            assert!(result_columns.contains(&expected.to_owned()));
        }
        let journal_mode: String = connection
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .unwrap();
        assert_eq!(journal_mode.to_ascii_lowercase(), "wal");
    }

    #[test]
    fn v2_to_v3_preserves_valid_active_assignment_without_guessing_asset() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("flowz.sqlite3");
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,project_path TEXT NOT NULL,schema_version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
             CREATE TABLE runs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,node_id TEXT,provider TEXT,model TEXT,status TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT,error_code TEXT);
             CREATE TABLE blobs(hash TEXT PRIMARY KEY,size_bytes INTEGER NOT NULL,media_type TEXT NOT NULL,relative_path TEXT NOT NULL,created_at TEXT NOT NULL);
             CREATE TABLE assets(id TEXT PRIMARY KEY,project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,blob_hash TEXT NOT NULL REFERENCES blobs(hash),name TEXT NOT NULL,kind TEXT NOT NULL,metadata_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL);
             CREATE TABLE results(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,kind TEXT NOT NULL,text_value TEXT,blob_hash TEXT REFERENCES blobs(hash) ON DELETE SET NULL,created_at TEXT NOT NULL);
             CREATE TABLE costs(id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,currency TEXT NOT NULL DEFAULT 'USD',amount_microunits INTEGER NOT NULL,created_at TEXT NOT NULL);
             CREATE TABLE active_results(project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,node_id TEXT NOT NULL,result_id TEXT NOT NULL REFERENCES results(id) ON DELETE CASCADE,PRIMARY KEY(project_id,node_id));
             INSERT INTO projects VALUES('project','Test','project',2,'now','now');
             INSERT INTO runs VALUES('run','project','node','openrouter','model','success','now','now',NULL);
             INSERT INTO blobs VALUES('blob',4,'image/png','blobs/blob','now');
             INSERT INTO assets VALUES('legacy-asset','project','blob','Legacy','image','{}','now');
             INSERT INTO results VALUES('result','run','image',NULL,'blob','now');
             INSERT INTO active_results VALUES('project','node','result');
             PRAGMA user_version=2;",
        ).unwrap();
        drop(connection);

        let database = Database::new(path.clone()).unwrap();
        let results = database.project_results("project").unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0].active);
        // Legacy v2 had no Result→Asset relation. A matching blob is not proof of provenance.
        assert_eq!(results[0].asset_id, None);

        let connection = Connection::open(path).unwrap();
        let active_fk_target: String = connection
            .query_row(
                "SELECT [table] FROM pragma_foreign_key_list('active_results') WHERE [from]='result_id'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(active_fk_target, "results");
        let foreign_key_violations: i64 = connection
            .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(foreign_key_violations, 0);
    }

    #[test]
    fn result_metadata_and_asset_provenance_are_exact_and_activation_is_explicit() {
        let temp = tempfile::tempdir().unwrap();
        let database = Database::new(temp.path().join("flowz.sqlite3")).unwrap();
        database
            .with_connection(|connection| {
                connection.execute(
                    "INSERT INTO projects VALUES('project','Test','project',2,'now','now')",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        let blob = BlobMetadata {
            hash: "blob".into(),
            size_bytes: 4,
            media_type: "image/png".into(),
            original_name: Some("result.png".into()),
            created_at: chrono::Utc::now(),
            relative_path: "blobs/blob".into(),
        };
        database.upsert_blob(&blob).unwrap();
        database
            .record_provider_completion("run", "project", "node", "model", Some(42), "now")
            .unwrap();
        let parameters = serde_json::json!({"aspectRatio":"1:1","references":2});
        let stored = database
            .attach_result(
                "result",
                "run",
                "project",
                "node",
                "image",
                None,
                Some(&blob),
                Some("asset-exact"),
                Some("A precise prompt"),
                Some(&parameters),
                "now",
            )
            .unwrap();
        assert!(!stored.active);
        assert_eq!(stored.prompt.as_deref(), Some("A precise prompt"));
        assert_eq!(stored.parameters, Some(parameters.clone()));

        // A second asset sharing the content hash must never replace explicit provenance.
        database.with_connection(|connection| {
            connection.execute(
                "INSERT INTO assets VALUES('asset-other','project','blob','Other','image','{}','later')",
                [],
            )?;
            Ok(())
        }).unwrap();
        let before = database.project_results("project").unwrap();
        assert_eq!(before[0].asset_id.as_deref(), Some("asset-exact"));
        assert!(!before[0].active);
        assert_eq!(before[0].parameters, Some(parameters));

        database
            .set_active_result("project", "node", "result")
            .unwrap();
        assert!(database.project_results("project").unwrap()[0].active);
    }

    #[test]
    fn result_history_is_stably_paginated_filtered_and_clamped() {
        let temp = tempfile::tempdir().unwrap();
        let database = Database::new(temp.path().join("flowz.sqlite3")).unwrap();
        database.with_connection(|connection| {
            connection.execute("INSERT INTO projects VALUES('project','Test','project',2,'now','now')", [])?;
            connection.execute("INSERT INTO projects VALUES('other','Other','other',2,'now','now')", [])?;
            for (run, project, node, model) in [
                ("run-a", "project", "node-a", "model alpha"),
                ("run-b", "project", "node-b", "model beta"),
                ("run-c", "other", "node-a", "model alpha"),
            ] {
                connection.execute(
                    "INSERT INTO runs(id,project_id,node_id,provider,model,status,started_at,finished_at,error_code) VALUES(?1,?2,?3,'local',?4,'success','same','same',NULL)",
                    params![run, project, node, model],
                )?;
            }
            for (id, run, kind, text) in [
                ("result-a", "run-a", "image", "ocean"),
                ("result-b", "run-b", "text", "forest"),
                ("result-c", "run-c", "image", "ocean"),
            ] {
                connection.execute(
                    "INSERT INTO results(id,run_id,kind,text_value,created_at) VALUES(?1,?2,?3,?4,'same')",
                    params![id, run, kind, text],
                )?;
            }
            Ok(())
        }).unwrap();

        let all = database
            .search_results(Some("project"), None, None, "", -9, 999)
            .unwrap();
        assert_eq!((all.page, all.page_size, all.total), (0, 100, 2));
        assert_eq!(
            all.items
                .iter()
                .map(|item| item.result_id.as_str())
                .collect::<Vec<_>>(),
            vec!["result-b", "result-a"]
        );
        let filtered = database
            .search_results(
                Some("project"),
                Some("node-a"),
                Some("image"),
                "ocean",
                0,
                1,
            )
            .unwrap();
        assert_eq!(filtered.total, 1);
        assert_eq!(filtered.items[0].result_id, "result-a");
        let global = database
            .search_results(None, None, Some("image"), "alpha", 0, 20)
            .unwrap();
        assert_eq!(global.total, 2);
    }

    #[test]
    fn result_content_batch_preserves_order_and_fails_closed_for_foreign_or_missing_ids() {
        let temp = tempfile::tempdir().unwrap();
        let database = Database::new(temp.path().join("flowz.sqlite3")).unwrap();
        database.with_connection(|connection| {
            connection.execute("INSERT INTO projects VALUES('project','Test','project',2,'now','now')", [])?;
            connection.execute("INSERT INTO projects VALUES('other','Other','other',2,'now','now')", [])?;
            connection.execute("INSERT INTO runs VALUES('run-a','project','node','local','model','success','now','now',NULL)", [])?;
            connection.execute("INSERT INTO runs VALUES('run-b','other','node','local','model','success','now','now',NULL)", [])?;
            connection.execute("INSERT INTO results(id,run_id,kind,text_value,created_at) VALUES('a','run-a','text','A','now')", [])?;
            connection.execute("INSERT INTO results(id,run_id,kind,text_value,created_at) VALUES('b','run-a','text','B','now')", [])?;
            connection.execute("INSERT INTO results(id,run_id,kind,text_value,created_at) VALUES('foreign','run-b','text','X','now')", [])?;
            Ok(())
        }).unwrap();

        let contents = database
            .result_contents("project", &["b".into(), "a".into()])
            .unwrap();
        assert_eq!(
            contents
                .iter()
                .map(|item| item.result_id.as_str())
                .collect::<Vec<_>>(),
            vec!["b", "a"]
        );
        assert!(database
            .result_contents("project", &["a".into(), "foreign".into()])
            .is_err());
        assert!(database
            .result_contents("project", &["missing".into()])
            .is_err());
    }

    #[test]
    fn atomic_provider_text_result_preserves_text_cost_and_parameters() {
        let temp = tempfile::tempdir().unwrap();
        let database = Database::new(temp.path().join("flowz.sqlite3")).unwrap();
        database
            .with_connection(|connection| {
                connection.execute(
                    "INSERT INTO projects VALUES('project','Test','project',2,'now','now')",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        let parameters = serde_json::json!({
            "language": "de",
            "timestamps": false,
            "sourceResultId": "audio-result",
            "orphaned": true
        });

        let stored = database
            .record_provider_text_result_atomic(
                "transcript-result",
                "transcript-run",
                "project",
                "transcription-node",
                "openai/whisper-1",
                "transcription",
                "Exakter Transkripttext",
                Some(&parameters),
                Some(17),
                "now",
                false,
            )
            .unwrap();

        assert_eq!(stored.text_value.as_deref(), Some("Exakter Transkripttext"));
        assert_eq!(stored.cost_microunits, Some(17));
        assert_eq!(stored.parameters, Some(parameters.clone()));
        let loaded = database.project_results("project").unwrap().remove(0);
        assert_eq!(loaded.text_value.as_deref(), Some("Exakter Transkripttext"));
        assert_eq!(loaded.cost_microunits, Some(17));
        assert_eq!(loaded.parameters, Some(parameters));
        assert_eq!(loaded.model.as_deref(), Some("openai/whisper-1"));
    }

    #[test]
    fn atomic_provider_text_result_rolls_back_run_and_cost_when_attachment_fails() {
        let temp = tempfile::tempdir().unwrap();
        let database = Database::new(temp.path().join("flowz.sqlite3")).unwrap();
        database
            .with_connection(|connection| {
                connection.execute(
                    "INSERT INTO projects VALUES('project','Test','project',2,'now','now')",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        database
            .record_provider_text_result_atomic(
                "duplicate-result",
                "existing-run",
                "project",
                "node",
                "model",
                "transcription",
                "Existing",
                None,
                Some(3),
                "before",
                false,
            )
            .unwrap();

        let error = database
            .record_provider_text_result_atomic(
                "duplicate-result",
                "failed-run",
                "project",
                "node",
                "model",
                "transcription",
                "Must roll back",
                Some(&serde_json::json!({"forced": "duplicate result id"})),
                Some(99),
                "now",
                false,
            )
            .unwrap_err();
        assert!(error.contains("UNIQUE constraint failed"));

        database
            .with_connection(|connection| {
                let run_count: i64 = connection.query_row(
                    "SELECT COUNT(*) FROM runs WHERE id='failed-run'",
                    [],
                    |row| row.get(0),
                )?;
                let cost_count: i64 = connection.query_row(
                    "SELECT COUNT(*) FROM costs WHERE run_id='failed-run'",
                    [],
                    |row| row.get(0),
                )?;
                let completion_only_count: i64 = connection.query_row(
                    "SELECT COUNT(*) FROM runs u LEFT JOIN results r ON r.run_id=u.id WHERE u.id='failed-run' AND r.id IS NULL",
                    [],
                    |row| row.get(0),
                )?;
                assert_eq!((run_count, cost_count, completion_only_count), (0, 0, 0));
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn paid_orphan_result_can_be_reassigned_without_losing_cost_or_text() {
        let temp = tempfile::tempdir().unwrap();
        let database = Database::new(temp.path().join("flowz.sqlite3")).unwrap();
        database
            .with_connection(|connection| {
                connection.execute(
                    "INSERT INTO projects VALUES('project','Test','project',2,'now','now')",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        database
            .record_provider_completion(
                "run-orphan",
                "project",
                "deleted-node",
                "openai/whisper-1",
                Some(7),
                "now",
            )
            .unwrap();
        database
            .attach_result(
                "result-orphan",
                "run-orphan",
                "project",
                "deleted-node",
                "transcription",
                Some("Recoverable transcript"),
                None,
                None,
                None,
                Some(&serde_json::json!({"orphaned": true})),
                "now",
            )
            .unwrap();

        database
            .reassign_result("project", "result-orphan", "restored-node")
            .unwrap();
        let result = database.project_results("project").unwrap().remove(0);
        assert_eq!(result.node_id, "restored-node");
        assert_eq!(result.text_value.as_deref(), Some("Recoverable transcript"));
        assert_eq!(result.cost_microunits, Some(7));
        assert!(result.active);
        assert_eq!(
            result
                .parameters
                .as_ref()
                .and_then(|value| value.get("orphaned"))
                .and_then(Value::as_bool),
            Some(false)
        );
    }

    #[test]
    fn local_media_import_is_immutable_history_and_immediately_active() {
        let temp = tempfile::tempdir().unwrap();
        let database = Database::new(temp.path().join("flowz.sqlite3")).unwrap();
        database
            .with_connection(|connection| {
                connection.execute(
                    "INSERT INTO projects VALUES('project','Test','project',2,'now','now')",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        let blob = BlobMetadata {
            hash: "a".repeat(64),
            size_bytes: 123,
            media_type: "video/mp4".into(),
            original_name: Some("clip.mp4".into()),
            created_at: chrono::Utc::now(),
            relative_path: format!("aa/{}", "a".repeat(64)),
        };
        database.upsert_blob(&blob).unwrap();
        let metadata = MediaMetadata {
            kind: "video".into(),
            container: "mov,mp4".into(),
            codecs: vec!["h264".into()],
            duration_seconds: 2.5,
            width: Some(1920),
            height: Some(1080),
            fps: Some(25.0),
            sample_rate: None,
            channels: None,
            playable: true,
            playback_warning: None,
        };
        let (result_id, asset_id) = database
            .record_media_import("project", "video-node", &blob, &metadata, None)
            .unwrap();
        let results = database.project_results("project").unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].result_id, result_id);
        assert_eq!(results[0].asset_id.as_deref(), Some(asset_id.as_str()));
        assert_eq!(results[0].kind, "input-video");
        assert!(results[0].active);
        assert_eq!(
            results[0]
                .parameters
                .as_ref()
                .and_then(|value| value["width"].as_u64()),
            Some(1920)
        );
    }

    #[test]
    fn transcription_source_validation_is_project_node_result_hash_and_audio_bound() {
        let temp = tempfile::tempdir().unwrap();
        let database = Database::new(temp.path().join("flowz.sqlite3")).unwrap();
        database
            .with_connection(|connection| {
                connection.execute(
                    "INSERT INTO projects VALUES('project','Test','project',2,'now','now')",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        let blob = BlobMetadata {
            hash: "d".repeat(64),
            size_bytes: 12,
            media_type: "audio/wav".into(),
            original_name: Some("voice.wav".into()),
            created_at: chrono::Utc::now(),
            relative_path: format!("dd/{}", "d".repeat(64)),
        };
        let metadata = MediaMetadata {
            kind: "audio".into(),
            container: "wav".into(),
            codecs: vec!["pcm_s16le".into()],
            duration_seconds: 1.0,
            width: None,
            height: None,
            fps: None,
            sample_rate: Some(16_000),
            channels: Some(1),
            playable: true,
            playback_warning: None,
        };
        let (result_id, _) = database
            .record_media_import("project", "audio-node", &blob, &metadata, None)
            .unwrap();
        assert!(database
            .validates_audio_source("project", "audio-node", &result_id, &blob.hash)
            .unwrap());
        assert!(!database
            .validates_audio_source("project", "other-node", &result_id, &blob.hash)
            .unwrap());
        assert!(!database
            .validates_audio_source("project", "audio-node", "other-result", &blob.hash)
            .unwrap());
        assert!(!database
            .validates_audio_source("project", "audio-node", &result_id, &"e".repeat(64))
            .unwrap());
    }

    #[test]
    fn global_assets_are_immutable_versioned_and_paged_without_blob_payloads() {
        let temp = tempfile::tempdir().unwrap();
        let database = Database::new(temp.path().join("flowz.sqlite3")).unwrap();
        database
            .with_connection(|connection| {
                connection.execute(
                    "INSERT INTO projects VALUES('project','Test','project',2,'now','now')",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        let first = database
            .create_library_asset(
                "asset-prompt",
                "version-prompt",
                "Launch Prompt",
                "prompt",
                Some("Schreibe einen Claim"),
                None,
                None,
                Some("project"),
                Some("node"),
                None,
                "2026-01-01T00:00:00Z",
            )
            .unwrap();
        assert_eq!(first.version, 1);
        database
            .create_library_asset(
                "asset-text",
                "version-text",
                "Research Notes",
                "text",
                Some("Zielgruppe"),
                None,
                None,
                None,
                None,
                None,
                "2026-01-02T00:00:00Z",
            )
            .unwrap();
        let page = database.search_library_assets("", None, 0, 1).unwrap();
        assert_eq!(page.total, 2);
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].name, "Research Notes");
        let prompt = database.library_asset_content("version-prompt").unwrap();
        assert_eq!(prompt.text_value.as_deref(), Some("Schreibe einen Claim"));
        assert_eq!(prompt.summary.source_project_id.as_deref(), Some("project"));
        database.with_connection(|connection| {
            connection.execute("INSERT INTO blobs(hash,size_bytes,media_type,relative_path,created_at) VALUES(?1,1,'image/png','aa/thumb','now')", ["a".repeat(64)])?;
            connection.execute("INSERT INTO library_assets(id,name,kind,created_at) VALUES('asset-image','Hero','image','now')", [])?;
            connection.execute("INSERT INTO library_asset_versions(id,asset_id,version,blob_hash,thumbnail_blob_hash,created_at) VALUES('version-image','asset-image',1,?1,?1,'now')", ["a".repeat(64)])?;
            Ok(())
        }).unwrap();
        assert_eq!(
            database.library_asset_thumbnail("version-image").unwrap(),
            Some(("a".repeat(64), "image/png".into()))
        );
        assert_eq!(
            database
                .set_library_asset_thumbnail("version-image", &"b".repeat(64))
                .unwrap(),
            ("a".repeat(64), "image/png".into())
        );
        assert!(database
            .create_library_asset(
                "bad",
                "bad-v",
                "Bad",
                "image",
                Some("not image"),
                None,
                None,
                None,
                None,
                None,
                "now"
            )
            .is_err());
    }

    #[test]
    fn cost_breakdown_keeps_actual_estimated_unknown_and_local_separate() {
        let temp = tempfile::tempdir().unwrap();
        let database = Database::new(temp.path().join("flowz.sqlite3")).unwrap();
        database.with_connection(|c| { c.execute("INSERT INTO projects VALUES('p','P','p',2,'now','now')",[])?;
            c.execute_batch("INSERT INTO runs VALUES('actual','p','a','openrouter','m1','success','2026-01-01','2026-01-01',NULL); INSERT INTO costs(run_id,amount_microunits,created_at,provenance) VALUES('actual',11,'now','actual'); INSERT INTO runs VALUES('estimate','p','b','fal.ai','m2','success','2026-01-02','2026-01-02',NULL); INSERT INTO costs(run_id,amount_microunits,created_at,provenance) VALUES('estimate',22,'now','estimated'); INSERT INTO results(id,run_id,kind,text_value,parameters_json,created_at) VALUES('e','estimate','text','x','{\"costProvenance\":\"estimated\"}','now'); INSERT INTO runs VALUES('unknown','p','c','fal.ai','m3','success','2026-01-03','2026-01-03',NULL); INSERT INTO runs VALUES('local','p','d','local','import','success','2026-01-04','2026-01-04',NULL);")?; Ok(()) }).unwrap();
        let costs = database.project_costs("p").unwrap();
        assert_eq!(
            (
                costs.actual_microunits,
                costs.estimated_microunits,
                costs.unknown_runs
            ),
            (11, 22, 1)
        );
        assert_eq!(costs.rows.len(), 3);
    }

    #[test]
    fn deleting_history_blocks_active_and_releases_unreferenced_asset_and_blob() {
        let temp = tempfile::tempdir().unwrap();
        let database = Database::new(temp.path().join("flowz.sqlite3")).unwrap();
        let hash = "a".repeat(64);
        database.with_connection(|c| { c.execute("INSERT INTO projects VALUES('p','P','p',2,'now','now')",[])?; c.execute("INSERT INTO runs VALUES('r','p','n','local','import','success','now','now',NULL)",[])?; c.execute("INSERT INTO blobs VALUES(?1,12,'image/png','aa/x','now')",[&hash])?; c.execute("INSERT INTO assets VALUES('a','p',?1,'A','image','{}','now')",[&hash])?; c.execute("INSERT INTO results(id,run_id,kind,blob_hash,asset_id,created_at) VALUES('x','r','image',?1,'a','now')",[&hash])?; c.execute("INSERT INTO active_results VALUES('p','n','x')",[])?; Ok(()) }).unwrap();
        assert!(database.delete_result("p", "x", &[]).is_err());
        database
            .with_connection(|c| {
                c.execute("DELETE FROM active_results", [])?;
                Ok(())
            })
            .unwrap();
        assert!(database.delete_result("p", "x", &["x".into()]).is_err());
        let result = database.delete_result("p", "x", &[]).unwrap();
        assert_eq!(result.orphaned_hashes, vec![hash]);
    }
    #[test]
    fn deleting_video_releases_media_metadata_and_poster_after_last_reference() {
        let temp = tempfile::tempdir().unwrap();
        let database = Database::new(temp.path().join("flowz.sqlite3")).unwrap();
        let video = "b".repeat(64);
        let poster = "c".repeat(64);
        database.with_connection(|c|{c.execute("INSERT INTO projects VALUES('p','P','p',2,'now','now')",[])?;c.execute("INSERT INTO runs VALUES('r','p','n','local','import','success','now','now',NULL)",[])?;for (hash,mime) in [(&video,"video/mp4"),(&poster,"image/png")]{c.execute("INSERT INTO blobs VALUES(?1,12,?2,'x','now')",params![hash,mime])?;}c.execute("INSERT INTO assets VALUES('a','p',?1,'V','video','{}','now')",[&video])?;c.execute("INSERT INTO results(id,run_id,kind,blob_hash,asset_id,created_at) VALUES('x','r','video',?1,'a','now')",[&video])?;c.execute("INSERT INTO media_metadata VALUES(?1,'video','{\"kind\":\"video\",\"container\":\"mp4\",\"codecs\":[],\"durationSeconds\":1,\"playable\":true}',?2)",params![video,poster])?;Ok(())}).unwrap();
        let outcome = database.delete_result("p", "x", &[]).unwrap();
        assert!(outcome.orphaned_hashes.contains(&video));
        assert!(outcome.orphaned_hashes.contains(&poster));
    }
    #[test]
    fn bound_activation_rechecks_source_switch_inside_transaction() {
        let temp = tempfile::tempdir().unwrap();
        let database = Database::new(temp.path().join("flowz.sqlite3")).unwrap();
        let a = "a".repeat(64);
        let b = "b".repeat(64);
        let target = "c".repeat(64);
        database.with_connection(|c|{c.execute("INSERT INTO projects VALUES('p','P','p',2,'now','now')",[])?;for(run,node)in[("ra","source"),("rb","source"),("rt","trim")]{c.execute("INSERT INTO runs VALUES(?1,'p',?2,'local','test','success','now','now',NULL)",params![run,node])?;}for hash in [&a,&b,&target]{c.execute("INSERT INTO blobs VALUES(?1,1,'image/png','x','now')",[hash])?;}c.execute("INSERT INTO results(id,run_id,kind,blob_hash,created_at) VALUES('a','ra','image',?1,'now')",[&a])?;c.execute("INSERT INTO results(id,run_id,kind,blob_hash,created_at) VALUES('b','rb','image',?1,'now')",[&b])?;c.execute("INSERT INTO results(id,run_id,kind,blob_hash,created_at) VALUES('target','rt','image-trim-transparent',?1,'now')",[&target])?;c.execute("INSERT INTO active_results VALUES('p','source','b')",[])?;c.execute("INSERT INTO active_results VALUES('p','trim','target')",[])?;Ok(())}).unwrap();
        let binding = LocalImageBinding {
            source_node_id: "source".into(),
            mode: "active".into(),
            result_ids: Vec::new(),
            expected_hashes: vec![a],
        };
        assert!(!database
            .activate_local_image_result_bound("p", "trim", "target", &binding)
            .unwrap());
        let active = database
            .with_connection(|c| {
                c.query_row(
                    "SELECT COUNT(*) FROM active_results WHERE project_id='p' AND node_id='trim'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
            })
            .unwrap();
        assert_eq!(active, 0);
    }
}
