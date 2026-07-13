mod artboard;
mod blob_store;
mod database;
mod document_catalog;
mod emergency_outbox;
mod fal_empirical_cost;
mod media;
mod project_repository;

pub use artboard::{
    ApplyArtboardOperationBatch, ArtboardBranch, ArtboardCompositeCommit, ArtboardRevision,
    ArtboardWorkspaceRecord, CreateArtboardBranch, CreateArtboardWorkspace, MoveArtboardHead,
    RecordArtboardCompositeBatch, RegisterArtboardInputSnapshot,
};
pub use blob_store::{BlobMetadata, BlobStore, ImportBlobRequest};
pub use database::{
    decimal_to_microunits, CostBreakdown, Database, FalImageCommit, FalImageVariantCommit,
    FalVideoCommit, LibraryAssetPage, LibraryAssetSummary, LibraryResultPage, LibraryUsage,
    LocalImageBinding, StorageBreakdown, StoredResult,
};
pub use document_catalog::{
    CatalogCreateRequest, CatalogDeleteRequest, CatalogDeleteResult, CatalogDuplicateRequest,
    CatalogRecord, CatalogRenameRequest, DocumentCoverCommitRequest, DocumentCoverRecord,
    FlowCoverSource,
};
pub use emergency_outbox::{EmergencyOutbox, EmergencyTextResult};
pub use fal_empirical_cost::{
    FalActualCostSample, FalCostContext, FalEmpiricalCostEstimate, FalEmpiricalCostQuery,
    FalEmpiricalCostStore,
};
pub use media::{extract_video_frame, inspect_media, snapshot_media, ImportedMedia, MediaMetadata};
#[cfg(test)]
pub use project_repository::{CanvasPosition, GraphEdge, GraphNode, UpdatePolicy};
pub use project_repository::{
    CreateProjectRequest, ProjectDiagnosis, ProjectDocument, ProjectRepository, ProjectSaveResult,
    ProjectSummary, SaveProjectRequest,
};

use std::collections::HashSet;
use std::path::Path;
use std::sync::{Arc, Mutex};

#[cfg(test)]
type CatalogDeleteTestHook = Option<(Arc<std::sync::Barrier>, Arc<std::sync::Barrier>)>;

#[derive(Clone)]
pub struct Persistence {
    pub projects: ProjectRepository,
    pub blobs: BlobStore,
    pub database: Database,
    pub emergency_outbox: EmergencyOutbox,
    pub fal_empirical_costs: FalEmpiricalCostStore,
    reference_lock: Arc<Mutex<()>>,
    #[cfg(test)]
    catalog_delete_test_hook: Arc<Mutex<CatalogDeleteTestHook>>,
}

impl Persistence {
    pub fn initialize(app_data_dir: impl AsRef<Path>) -> Result<Self, String> {
        let root = app_data_dir.as_ref();
        std::fs::create_dir_all(root).map_err(|error| error.to_string())?;

        let reference_lock = Arc::new(Mutex::new(()));
        let projects = ProjectRepository::new_with_reference_lock(
            root.join("projects"),
            reference_lock.clone(),
        )?;
        let blobs = BlobStore::new(root.join("library").join("blobs"))?;
        let database =
            Database::new_with_reference_lock(root.join("flowz.sqlite3"), reference_lock.clone())?;
        let emergency_outbox = EmergencyOutbox::initialize(root)?;
        let fal_empirical_costs = FalEmpiricalCostStore::initialize(root)?;

        projects.repair_orphans()?;
        let repaired_blobs = blobs.repair_orphans()?;
        database.reconcile_blobs(&repaired_blobs)?;
        let staged_hashes = recoverable_stage_hashes(root);
        for hash in database.take_unreferenced_blobs()? {
            if !staged_hashes.contains(&hash) {
                blobs.remove_untracked(&hash)?;
            }
        }
        for summary in projects.list()? {
            if let Ok(record) = projects.open(&summary.id) {
                database.upsert_project(&record.project)?;
            }
        }

        Ok(Self {
            projects,
            blobs,
            database,
            emergency_outbox,
            fal_empirical_costs,
            reference_lock,
            #[cfg(test)]
            catalog_delete_test_hook: Arc::new(Mutex::new(None)),
        })
    }
}

fn recoverable_stage_hashes(root: &Path) -> HashSet<String> {
    let stage_root = root.join("media-stages");
    std::fs::read_dir(stage_root)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            if !metadata.is_file() || metadata.len() > 512 * 1024 {
                return None;
            }
            let value: serde_json::Value =
                serde_json::from_slice(&std::fs::read(entry.path()).ok()?).ok()?;
            Some(
                ["hash", "posterHash"]
                    .into_iter()
                    .filter_map(|key| value.get(key).and_then(serde_json::Value::as_str))
                    .map(str::to_owned)
                    .collect::<Vec<_>>(),
            )
        })
        .flatten()
        .filter(|hash| {
            hash.len() == 64 && hash.chars().all(|character| character.is_ascii_hexdigit())
        })
        .collect()
}

pub(crate) fn sync_directory(path: &Path) -> Result<(), String> {
    std::fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restart_preserves_font_provenance_blobs_and_repairs_a_missing_pair() {
        let root = tempfile::tempdir().unwrap();
        let persistence = Persistence::initialize(root.path()).unwrap();
        let font = persistence
            .blobs
            .import_bytes(b"test-font", "font/ttf".into(), Some("Test.ttf".into()))
            .unwrap();
        let license = persistence
            .blobs
            .import_bytes(b"test-license", "text/plain".into(), Some("OFL.txt".into()))
            .unwrap();
        persistence.database.upsert_blob(&font).unwrap();
        persistence.database.upsert_blob(&license).unwrap();
        persistence
            .database
            .record_font_provenance(
                &font.hash,
                &license.hash,
                &serde_json::json!({"family":"Test"}),
                &serde_json::json!({"axes":{}}),
            )
            .unwrap();
        drop(persistence);

        // A normal restart must not classify font/license blobs as orphans. This was
        // the production startup crash: take_unreferenced_blobs tried to DELETE both
        // rows and collided with font_provenance's RESTRICT foreign keys.
        let restarted = Persistence::initialize(root.path()).unwrap();
        assert!(restarted.database.contains_blob(&font.hash).unwrap());
        assert!(restarted.database.contains_blob(&license.hash).unwrap());
        assert!(restarted
            .database
            .font_provenance(&font.hash)
            .unwrap()
            .is_some());

        // If one physical cache object really is lost, the provenance pair is no
        // longer usable. Reconciliation should remove that cache metadata and both
        // now-unreferenced database/CAS entries instead of making startup fatal.
        restarted.blobs.remove_untracked(&font.hash).unwrap();
        drop(restarted);
        let repaired = Persistence::initialize(root.path()).unwrap();
        assert!(!repaired.database.contains_blob(&font.hash).unwrap());
        assert!(!repaired.database.contains_blob(&license.hash).unwrap());
        assert!(repaired
            .database
            .font_provenance(&font.hash)
            .unwrap()
            .is_none());
    }
}
