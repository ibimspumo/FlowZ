use super::sync_directory;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use uuid::Uuid;

const MAX_IMPORT_BYTES: u64 = 4 * 1024 * 1024 * 1024;

#[derive(Clone)]
pub struct BlobStore {
    root: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportBlobRequest {
    pub path: PathBuf,
    pub media_type: Option<String>,
    pub original_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobMetadata {
    pub hash: String,
    pub size_bytes: u64,
    pub media_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_name: Option<String>,
    pub created_at: DateTime<Utc>,
    pub relative_path: String,
}

impl BlobStore {
    pub fn new(root: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&root).map_err(|error| error.to_string())?;
        Ok(Self { root })
    }

    pub fn import(&self, request: ImportBlobRequest) -> Result<BlobMetadata, String> {
        self.import_cancellable(request, None)
    }

    pub fn import_cancellable(
        &self,
        request: ImportBlobRequest,
        cancelled: Option<&AtomicBool>,
    ) -> Result<BlobMetadata, String> {
        let source_metadata = fs::metadata(&request.path)
            .map_err(|_| "Die zu importierende Datei existiert nicht.".to_string())?;
        if !source_metadata.is_file() {
            return Err("Die zu importierende Datei existiert nicht.".into());
        }
        if source_metadata.len() == 0 || source_metadata.len() > MAX_IMPORT_BYTES {
            return Err("Dateiimporte müssen zwischen 1 Byte und 4 GiB groß sein.".into());
        }
        if request
            .media_type
            .as_ref()
            .is_some_and(|value| value.len() > 255 || value.contains(['\r', '\n']))
        {
            return Err("Ungültiger Medientyp.".into());
        }
        if request.original_name.as_ref().is_some_and(|value| {
            value.is_empty() || value.len() > 255 || value.contains(['/', '\\', '\r', '\n'])
        }) {
            return Err("Ungültiger ursprünglicher Dateiname.".into());
        }
        let incoming = self.root.join(".incoming");
        fs::create_dir_all(&incoming).map_err(|error| error.to_string())?;
        let temporary = incoming.join(format!("{}.tmp", Uuid::new_v4()));
        let mut source = File::open(&request.path).map_err(|error| error.to_string())?;
        let mut target = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        let mut hasher = Sha256::new();
        let mut size_bytes = 0_u64;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            if cancelled.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
                drop(target);
                let _ = fs::remove_file(&temporary);
                return Err("Medienimport abgebrochen.".into());
            }
            let read = source
                .read(&mut buffer)
                .map_err(|error| error.to_string())?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
            target
                .write_all(&buffer[..read])
                .map_err(|error| error.to_string())?;
            size_bytes += read as u64;
            if size_bytes > MAX_IMPORT_BYTES {
                drop(target);
                let _ = fs::remove_file(&temporary);
                return Err("Die Datei ist während des Imports über 4 GiB angewachsen.".into());
            }
        }
        target.sync_all().map_err(|error| error.to_string())?;
        drop(target);
        let hash = format!("{:x}", hasher.finalize());
        if hash_file(&temporary)? != hash {
            let _ = fs::remove_file(&temporary);
            return Err("Blob-Verifikation nach dem Kopieren fehlgeschlagen.".into());
        }

        let directory = self.root.join(&hash[..2]);
        fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        let destination = directory.join(&hash);
        if destination.exists() {
            if hash_file(&destination)? == hash {
                fs::remove_file(&temporary).map_err(|error| error.to_string())?;
            } else {
                quarantine(&destination, "hash-mismatch")?;
                fs::rename(&temporary, &destination).map_err(|error| error.to_string())?;
                sync_directory(&directory)?;
            }
        } else {
            fs::rename(&temporary, &destination).map_err(|error| error.to_string())?;
            sync_directory(&directory)?;
        }

        let inferred_name = request.original_name.or_else(|| {
            request
                .path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
        });
        let media_type = request.media_type.unwrap_or_else(|| {
            mime_guess::from_path(&request.path)
                .first_or_octet_stream()
                .essence_str()
                .to_owned()
        });
        let metadata_path = directory.join(format!("{hash}.metadata.json"));
        let metadata = if metadata_path.exists() {
            match serde_json::from_slice::<BlobMetadata>(
                &fs::read(&metadata_path).map_err(|error| error.to_string())?,
            ) {
                Ok(item)
                    if item.hash == hash
                        && item.size_bytes == size_bytes
                        && !item.media_type.is_empty()
                        && item.relative_path == format!("{}/{}", &hash[..2], hash) =>
                {
                    item
                }
                _ => {
                    quarantine(&metadata_path, "invalid-metadata")?;
                    let item = BlobMetadata {
                        hash: hash.clone(),
                        size_bytes,
                        media_type,
                        original_name: inferred_name,
                        created_at: Utc::now(),
                        relative_path: format!("{}/{}", &hash[..2], hash),
                    };
                    write_metadata_atomic(&metadata_path, &item)?;
                    item
                }
            }
        } else {
            let metadata = BlobMetadata {
                hash: hash.clone(),
                size_bytes,
                media_type,
                original_name: inferred_name,
                created_at: Utc::now(),
                relative_path: format!("{}/{}", &hash[..2], hash),
            };
            write_metadata_atomic(&metadata_path, &metadata)?;
            metadata
        };
        Ok(metadata)
    }

    /// Imports trusted in-memory provider output without exposing a filesystem path to the WebView.
    pub fn import_bytes(
        &self,
        bytes: &[u8],
        media_type: String,
        original_name: Option<String>,
    ) -> Result<BlobMetadata, String> {
        const MAX_PROVIDER_BYTES: usize = 64 * 1024 * 1024;
        if bytes.is_empty() || bytes.len() > MAX_PROVIDER_BYTES {
            return Err("Provider-Bilder müssen zwischen 1 Byte und 64 MiB groß sein.".into());
        }
        let staged = self.root.join(".incoming");
        fs::create_dir_all(&staged).map_err(|error| error.to_string())?;
        let path = staged.join(format!("provider-{}.bin", Uuid::new_v4()));
        let result = (|| {
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&path)
                .map_err(|error| error.to_string())?;
            file.write_all(bytes).map_err(|error| error.to_string())?;
            file.sync_all().map_err(|error| error.to_string())?;
            self.import(ImportBlobRequest {
                path: path.clone(),
                media_type: Some(media_type),
                original_name,
            })
        })();
        let _ = fs::remove_file(path);
        result
    }

    pub fn read(&self, hash: &str) -> Result<Vec<u8>, String> {
        if hash.len() != 64 || !hash.chars().all(|character| character.is_ascii_hexdigit()) {
            return Err("Ungültiger Blob-Hash.".into());
        }
        let path = self.root.join(&hash[..2]).join(hash);
        let bytes = fs::read(&path).map_err(|_| "Bibliotheksdatei fehlt.".to_string())?;
        if bytes.len() > 64 * 1024 * 1024 || hash_file(&path)? != hash.to_ascii_lowercase() {
            return Err("Bibliotheksdatei ist zu groß oder beschädigt.".into());
        }
        Ok(bytes)
    }

    pub fn size(&self, hash: &str) -> Result<u64, String> {
        let path = self.path_for_hash(hash)?;
        fs::metadata(path)
            .map(|item| item.len())
            .map_err(|_| "Bibliotheksdatei fehlt.".to_string())
    }

    pub fn metadata(&self, hash: &str) -> Result<BlobMetadata, String> {
        self.path_for_hash(hash)?;
        let path = self
            .root
            .join(&hash[..2])
            .join(format!("{}.metadata.json", hash.to_ascii_lowercase()));
        let metadata: BlobMetadata = serde_json::from_slice(
            &fs::read(path).map_err(|_| "Blob-Metadaten fehlen.".to_string())?,
        )
        .map_err(|_| "Blob-Metadaten sind beschädigt.".to_string())?;
        if metadata.hash != hash.to_ascii_lowercase() {
            return Err("Blob-Metadaten passen nicht zur Hash-ID.".into());
        }
        Ok(metadata)
    }

    /// Reads only the requested byte interval. Video/audio previews therefore never
    /// cross IPC as base64 and large blobs are not allocated in full.
    pub fn read_range(&self, hash: &str, start: u64, length: usize) -> Result<Vec<u8>, String> {
        let path = self.path_for_hash(hash)?;
        let size = fs::metadata(&path)
            .map_err(|_| "Bibliotheksdatei fehlt.".to_string())?
            .len();
        if start > size || length as u64 > size.saturating_sub(start) {
            return Err("Ungültiger Medienbereich.".into());
        }
        let mut file = File::open(path).map_err(|_| "Bibliotheksdatei fehlt.".to_string())?;
        file.seek(SeekFrom::Start(start))
            .map_err(|error| error.to_string())?;
        let mut bytes = vec![0; length];
        file.read_exact(&mut bytes)
            .map_err(|error| error.to_string())?;
        Ok(bytes)
    }

    pub(crate) fn path_for_hash(&self, hash: &str) -> Result<PathBuf, String> {
        if hash.len() != 64 || !hash.chars().all(|character| character.is_ascii_hexdigit()) {
            return Err("Ungültiger Blob-Hash.".into());
        }
        Ok(self.root.join(&hash[..2]).join(hash.to_ascii_lowercase()))
    }

    pub(crate) fn set_media_type(
        &self,
        hash: &str,
        media_type: &str,
    ) -> Result<BlobMetadata, String> {
        if !media_type.starts_with("video/")
            && !media_type.starts_with("audio/")
            && !media_type.starts_with("image/")
        {
            return Err("Ungültiger Medientyp für CAS-Metadaten.".into());
        }
        let mut metadata = self.metadata(hash)?;
        metadata.media_type = media_type.to_owned();
        let path = self
            .root
            .join(&hash[..2])
            .join(format!("{hash}.metadata.json"));
        write_metadata_atomic(&path, &metadata)?;
        Ok(metadata)
    }

    pub(crate) fn remove_untracked(&self, hash: &str) -> Result<(), String> {
        let path = self.path_for_hash(hash)?;
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
        let metadata = self
            .root
            .join(&hash[..2])
            .join(format!("{hash}.metadata.json"));
        let _ = fs::remove_file(metadata);
        Ok(())
    }

    pub fn repair_orphans(&self) -> Result<Vec<BlobMetadata>, String> {
        let incoming = self.root.join(".incoming");
        if incoming.exists() {
            for entry in fs::read_dir(&incoming).map_err(|error| error.to_string())? {
                let path = entry.map_err(|error| error.to_string())?.path();
                if path.is_file() {
                    let _ = fs::remove_file(path);
                }
            }
        }

        let directories: Vec<PathBuf> = fs::read_dir(&self.root)
            .map_err(|error| error.to_string())?
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.is_dir() && path.file_name().and_then(|v| v.to_str()) != Some(".incoming")
            })
            .collect();
        let mut candidates = Vec::new();
        for directory in &directories {
            for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
                let path = entry.map_err(|error| error.to_string())?.path();
                let name = path
                    .file_name()
                    .and_then(|v| v.to_str())
                    .unwrap_or_default();
                if name.ends_with(".tmp") {
                    let _ = fs::remove_file(path);
                } else if path.is_file()
                    && name.len() == 64
                    && name.chars().all(|c| c.is_ascii_hexdigit())
                {
                    candidates.push(path);
                }
            }
        }

        let mut metadata_by_hash = BTreeMap::new();
        for original_path in candidates {
            if !original_path.exists() {
                continue;
            }
            let name = original_path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();
            let original_directory = original_path.parent().ok_or("Ungültiger Blob-Pfad.")?;
            let old_metadata_path = original_directory.join(format!("{name}.metadata.json"));
            let actual = hash_file(&original_path)?;
            if actual != name {
                quarantine(&original_path, "hash-mismatch")?;
                if old_metadata_path.exists() {
                    quarantine(&old_metadata_path, "orphaned")?;
                }
                continue;
            }

            let correct_directory = self.root.join(&actual[..2]);
            fs::create_dir_all(&correct_directory).map_err(|error| error.to_string())?;
            let correct_path = correct_directory.join(&actual);
            let carried_metadata =
                read_usable_metadata(&old_metadata_path, &actual, &original_path);
            if original_path != correct_path {
                if correct_path.exists() {
                    if hash_file(&correct_path)? == actual {
                        fs::remove_file(&original_path).map_err(|error| error.to_string())?;
                    } else {
                        quarantine(&correct_path, "hash-mismatch")?;
                        fs::rename(&original_path, &correct_path)
                            .map_err(|error| error.to_string())?;
                    }
                } else {
                    fs::rename(&original_path, &correct_path).map_err(|error| error.to_string())?;
                }
                if old_metadata_path.exists() {
                    fs::remove_file(&old_metadata_path).map_err(|error| error.to_string())?;
                }
                sync_directory(&correct_directory)?;
                sync_directory(original_directory)?;
            }

            let metadata_path = correct_directory.join(format!("{actual}.metadata.json"));
            let mut item = carried_metadata
                .or_else(|| read_usable_metadata(&metadata_path, &actual, &correct_path))
                .unwrap_or_else(|| metadata_for_file(&actual, &correct_path));
            item.hash = actual.clone();
            item.size_bytes = fs::metadata(&correct_path)
                .map_err(|error| error.to_string())?
                .len();
            item.relative_path = format!("{}/{}", &actual[..2], actual);
            if item.media_type.is_empty() {
                item.media_type = "application/octet-stream".into();
            }
            write_metadata_atomic(&metadata_path, &item)?;
            metadata_by_hash.insert(actual, item);
        }

        // Metadata without a physical CAS object cannot be retained.
        for prefix in fs::read_dir(&self.root).map_err(|error| error.to_string())? {
            let directory = prefix.map_err(|error| error.to_string())?.path();
            if !directory.is_dir()
                || directory.file_name().and_then(|v| v.to_str()) == Some(".incoming")
            {
                continue;
            }
            for entry in fs::read_dir(&directory).map_err(|error| error.to_string())? {
                let path = entry.map_err(|error| error.to_string())?.path();
                let name = path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or_default();
                if name.ends_with(".metadata.json") {
                    let hash = name.trim_end_matches(".metadata.json");
                    if hash.len() != 64
                        || !hash.chars().all(|c| c.is_ascii_hexdigit())
                        || directory.file_name().and_then(|v| v.to_str()) != Some(&hash[..2])
                        || !directory.join(hash).exists()
                    {
                        let _ = fs::remove_file(path);
                    }
                }
            }
        }
        Ok(metadata_by_hash.into_values().collect())
    }
}

fn read_usable_metadata(path: &Path, hash: &str, blob_path: &Path) -> Option<BlobMetadata> {
    let item: BlobMetadata = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    (item.hash.eq_ignore_ascii_case(hash)
        && item.size_bytes == fs::metadata(blob_path).ok()?.len()
        && !item.media_type.is_empty())
    .then_some(item)
}

fn metadata_for_file(hash: &str, path: &Path) -> BlobMetadata {
    BlobMetadata {
        hash: hash.to_owned(),
        size_bytes: fs::metadata(path).map(|m| m.len()).unwrap_or(0),
        media_type: "application/octet-stream".into(),
        original_name: None,
        created_at: Utc::now(),
        relative_path: format!("{}/{}", &hash[..2], hash),
    }
}

fn quarantine(path: &Path, reason: &str) -> Result<(), String> {
    fs::rename(
        path,
        path.with_extension(format!(
            "{reason}.{}.quarantine",
            Utc::now().timestamp_millis()
        )),
    )
    .map_err(|e| e.to_string())
}

fn hash_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn write_metadata_atomic(path: &Path, metadata: &BlobMetadata) -> Result<(), String> {
    let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let bytes = serde_json::to_vec_pretty(metadata).map_err(|error| error.to_string())?;
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    file.write_all(&bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| error.to_string())?;
    sync_directory(path.parent().ok_or("Ungültiger Blob-Pfad.")?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_blobs_are_deduplicated() {
        let temp = tempfile::tempdir().unwrap();
        let store = BlobStore::new(temp.path().join("blobs")).unwrap();
        let first = temp.path().join("first.txt");
        let second = temp.path().join("second.txt");
        fs::write(&first, b"same content").unwrap();
        fs::write(&second, b"same content").unwrap();
        let one = store
            .import(ImportBlobRequest {
                path: first,
                media_type: None,
                original_name: None,
            })
            .unwrap();
        let two = store
            .import(ImportBlobRequest {
                path: second,
                media_type: None,
                original_name: None,
            })
            .unwrap();
        assert_eq!(one.hash, two.hash);
        assert_eq!(store.repair_orphans().unwrap().len(), 1);
    }

    #[test]
    fn range_reads_only_requested_bytes_and_rejects_escape() {
        let temp = tempfile::tempdir().unwrap();
        let store = BlobStore::new(temp.path().join("blobs")).unwrap();
        let source = temp.path().join("sample.bin");
        fs::write(&source, b"0123456789").unwrap();
        let blob = store
            .import(ImportBlobRequest {
                path: source,
                media_type: Some("video/mp4".into()),
                original_name: None,
            })
            .unwrap();
        assert_eq!(store.read_range(&blob.hash, 3, 4).unwrap(), b"3456");
        assert!(store.read_range(&blob.hash, 9, 2).is_err());
        assert!(store.read_range("../../etc/passwd", 0, 1).is_err());
    }

    #[test]
    fn cancellable_import_stops_before_cas_commit() {
        let temp = tempfile::tempdir().unwrap();
        let store = BlobStore::new(temp.path().join("blobs")).unwrap();
        let source = temp.path().join("large.bin");
        fs::write(&source, vec![7_u8; 128 * 1024]).unwrap();
        let cancelled = AtomicBool::new(true);
        let result = store.import_cancellable(
            ImportBlobRequest {
                path: source,
                media_type: Some("application/octet-stream".into()),
                original_name: None,
            },
            Some(&cancelled),
        );
        assert!(result.unwrap_err().contains("abgebrochen"));
        assert_eq!(store.repair_orphans().unwrap().len(), 0);
    }

    #[test]
    fn corrupt_existing_target_is_quarantined_and_replaced() {
        let temp = tempfile::tempdir().unwrap();
        let store = BlobStore::new(temp.path().join("blobs")).unwrap();
        let source = temp.path().join("source.txt");
        fs::write(&source, b"trusted content").unwrap();
        let first = store
            .import(ImportBlobRequest {
                path: source.clone(),
                media_type: None,
                original_name: None,
            })
            .unwrap();
        let target = store.root.join(&first.relative_path);
        fs::write(&target, b"corrupt").unwrap();
        store
            .import(ImportBlobRequest {
                path: source,
                media_type: None,
                original_name: None,
            })
            .unwrap();
        assert_eq!(hash_file(&target).unwrap(), first.hash);
        assert!(fs::read_dir(target.parent().unwrap())
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().contains("quarantine")));
    }

    #[test]
    fn repair_moves_valid_blob_from_wrong_prefix_and_repairs_metadata() {
        let temp = tempfile::tempdir().unwrap();
        let store = BlobStore::new(temp.path().join("blobs")).unwrap();
        let content = b"valid content in the wrong CAS prefix";
        let hash = format!("{:x}", Sha256::digest(content));
        let wrong_directory = store.root.join("ff");
        fs::create_dir_all(&wrong_directory).unwrap();
        let wrong_path = wrong_directory.join(&hash);
        fs::write(&wrong_path, content).unwrap();
        let wrong_metadata = BlobMetadata {
            hash: hash.clone(),
            size_bytes: content.len() as u64,
            media_type: "text/plain".into(),
            original_name: Some("brand.txt".into()),
            created_at: Utc::now(),
            relative_path: format!("ff/{hash}"),
        };
        write_metadata_atomic(
            &wrong_directory.join(format!("{hash}.metadata.json")),
            &wrong_metadata,
        )
        .unwrap();

        let repaired = store.repair_orphans().unwrap();
        let correct_path = store.root.join(&hash[..2]).join(&hash);
        assert!(!wrong_path.exists());
        assert_eq!(fs::read(&correct_path).unwrap(), content);
        assert_eq!(repaired.len(), 1);
        assert_eq!(
            repaired[0].relative_path,
            format!("{}/{}", &hash[..2], hash)
        );
        assert_eq!(repaired[0].original_name.as_deref(), Some("brand.txt"));
    }
}
