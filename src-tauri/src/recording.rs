use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use uuid::Uuid;

const MAX_CHUNK_BYTES: usize = 4 * 1024 * 1024;
const MAX_RECORDING_BYTES: u64 = 512 * 1024 * 1024;
const SESSION_LIFETIME: Duration = Duration::from_secs(2 * 60 * 60);

struct RecordingSession {
    file: File,
    path: PathBuf,
    project_id: String,
    node_id: String,
    target_grant: String,
    mime_type: String,
    bytes_written: u64,
    created_at: Instant,
}

#[derive(Clone)]
pub struct RecordingSessionRegistry {
    root: PathBuf,
    sessions: Arc<Mutex<HashMap<String, RecordingSession>>>,
}

#[derive(Debug)]
pub struct CompletedRecording {
    pub path: PathBuf,
    pub project_id: String,
    pub node_id: String,
    pub target_grant: String,
    pub original_name: String,
}

impl RecordingSessionRegistry {
    pub fn initialize(app_data_dir: &Path) -> Result<Self, String> {
        let root = app_data_dir.join("recording-staging");
        std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;
        // Sessions cannot survive an application process. Clearing this dedicated
        // directory on boot recovers cleanly after a crash without touching CAS data.
        for entry in std::fs::read_dir(&root).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            if entry
                .file_type()
                .map_err(|error| error.to_string())?
                .is_file()
            {
                let _ = std::fs::remove_file(entry.path());
            }
        }
        Ok(Self {
            root,
            sessions: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub fn begin(
        &self,
        project_id: String,
        node_id: String,
        target_grant: String,
        mime_type: String,
    ) -> Result<String, String> {
        let mime_type = normalize_mime(&mime_type)?;
        self.prune_expired();
        let session_id = Uuid::new_v4().to_string();
        let extension = if mime_type == "audio/mp4" {
            "m4a"
        } else {
            "webm"
        };
        let path = self.root.join(format!("{session_id}.{extension}.part"));
        let file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
            .map_err(|error| format!("Aufnahmedatei konnte nicht angelegt werden: {error}"))?;
        self.sessions
            .lock()
            .map_err(|_| "Aufnahme-Registry ist nicht verfügbar.".to_string())?
            .insert(
                session_id.clone(),
                RecordingSession {
                    file,
                    path,
                    project_id,
                    node_id,
                    target_grant,
                    mime_type,
                    bytes_written: 0,
                    created_at: Instant::now(),
                },
            );
        Ok(session_id)
    }

    pub fn append(&self, session_id: &str, bytes: &[u8]) -> Result<u64, String> {
        self.prune_expired();
        if bytes.is_empty() {
            return self.session_bytes(session_id);
        }
        if bytes.len() > MAX_CHUNK_BYTES {
            return Err("Ein Aufnahme-Chunk überschreitet das 4-MB-Limit.".into());
        }
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "Aufnahme-Registry ist nicht verfügbar.".to_string())?;
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| "Die Aufnahme-Session ist abgelaufen oder unbekannt.".to_string())?;
        if session.created_at.elapsed() > SESSION_LIFETIME {
            return Err("Die Aufnahme-Session ist abgelaufen.".into());
        }
        let next = session
            .bytes_written
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| "Die Aufnahme ist zu groß.".to_string())?;
        if next > MAX_RECORDING_BYTES {
            return Err("Aufnahmen sind auf 512 MB begrenzt.".into());
        }
        session
            .file
            .write_all(bytes)
            .map_err(|error| format!("Aufnahme-Chunk konnte nicht gespeichert werden: {error}"))?;
        session.bytes_written = next;
        Ok(next)
    }

    pub fn finish(&self, session_id: &str) -> Result<CompletedRecording, String> {
        self.prune_expired();
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "Aufnahme-Registry ist nicht verfügbar.".to_string())?;
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| "Die Aufnahme-Session ist abgelaufen oder unbekannt.".to_string())?;
        if session.bytes_written == 0 {
            return Err("Die Aufnahme enthält keine Audiodaten.".into());
        }
        session.file.flush().map_err(|error| error.to_string())?;
        session.file.sync_all().map_err(|error| error.to_string())?;
        let extension = if session.mime_type == "audio/mp4" {
            "m4a"
        } else {
            "webm"
        };
        Ok(CompletedRecording {
            path: session.path.clone(),
            project_id: session.project_id.clone(),
            node_id: session.node_id.clone(),
            target_grant: session.target_grant.clone(),
            original_name: format!("FlowZ-Aufnahme.{extension}"),
        })
    }

    pub fn complete(&self, session_id: &str) -> Result<(), String> {
        let session = self
            .sessions
            .lock()
            .map_err(|_| "Aufnahme-Registry ist nicht verfügbar.".to_string())?
            .remove(session_id);
        if let Some(session) = session {
            drop(session.file);
            std::fs::remove_file(session.path).map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    pub fn abort(&self, session_id: &str) -> Result<bool, String> {
        let session = self
            .sessions
            .lock()
            .map_err(|_| "Aufnahme-Registry ist nicht verfügbar.".to_string())?
            .remove(session_id);
        if let Some(session) = session {
            drop(session.file);
            let _ = std::fs::remove_file(session.path);
            Ok(true)
        } else {
            Ok(false)
        }
    }

    fn session_bytes(&self, session_id: &str) -> Result<u64, String> {
        self.sessions
            .lock()
            .map_err(|_| "Aufnahme-Registry ist nicht verfügbar.".to_string())?
            .get(session_id)
            .map(|session| session.bytes_written)
            .ok_or_else(|| "Die Aufnahme-Session ist abgelaufen oder unbekannt.".to_string())
    }

    pub fn prune_expired(&self) {
        let expired = self.sessions.lock().ok().map(|mut sessions| {
            let ids = sessions
                .iter()
                .filter(|(_, session)| session.created_at.elapsed() > SESSION_LIFETIME)
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            ids.into_iter()
                .filter_map(|id| sessions.remove(&id))
                .collect::<Vec<_>>()
        });
        for session in expired.into_iter().flatten() {
            drop(session.file);
            let _ = std::fs::remove_file(session.path);
        }
    }
}

fn normalize_mime(value: &str) -> Result<String, String> {
    let mime = value
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if !matches!(mime.as_str(), "audio/webm" | "audio/mp4") {
        return Err("Diese MediaRecorder-Kodierung wird nicht unterstützt.".into());
    }
    Ok(mime)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_lifecycle_streams_bytes_and_cleans_up() {
        let temp = tempfile::tempdir().unwrap();
        let registry = RecordingSessionRegistry::initialize(temp.path()).unwrap();
        let id = registry
            .begin(
                "project".into(),
                "node".into(),
                "grant".into(),
                "audio/webm;codecs=opus".into(),
            )
            .unwrap();
        assert_eq!(registry.append(&id, b"abc").unwrap(), 3);
        assert_eq!(registry.append(&id, b"def").unwrap(), 6);
        let completed = registry.finish(&id).unwrap();
        assert_eq!(std::fs::read(&completed.path).unwrap(), b"abcdef");
        assert!(completed.path.exists());
        registry.complete(&id).unwrap();
        assert!(!completed.path.exists());
        assert!(registry.finish(&id).is_err());
    }

    #[test]
    fn abort_and_boot_recovery_remove_temporary_files() {
        let temp = tempfile::tempdir().unwrap();
        let registry = RecordingSessionRegistry::initialize(temp.path()).unwrap();
        let id = registry
            .begin(
                "project".into(),
                "node".into(),
                "grant".into(),
                "audio/mp4".into(),
            )
            .unwrap();
        registry.append(&id, b"partial").unwrap();
        assert!(registry.abort(&id).unwrap());
        assert!(!registry.abort(&id).unwrap());
        let orphan = temp.path().join("recording-staging").join("orphan.part");
        std::fs::write(&orphan, b"orphan").unwrap();
        RecordingSessionRegistry::initialize(temp.path()).unwrap();
        assert!(!orphan.exists());
    }

    #[test]
    fn rejects_empty_finish_unsupported_mime_and_large_chunks() {
        let temp = tempfile::tempdir().unwrap();
        let registry = RecordingSessionRegistry::initialize(temp.path()).unwrap();
        assert!(registry
            .begin("p".into(), "n".into(), "grant".into(), "audio/wav".into())
            .is_err());
        let id = registry
            .begin("p".into(), "n".into(), "grant".into(), "audio/webm".into())
            .unwrap();
        assert!(registry.append(&id, &vec![0; MAX_CHUNK_BYTES + 1]).is_err());
        assert!(registry.finish(&id).is_err());
    }

    #[test]
    fn expired_append_prunes_session_and_temporary_file_immediately() {
        let temp = tempfile::tempdir().unwrap();
        let registry = RecordingSessionRegistry::initialize(temp.path()).unwrap();
        let id = registry
            .begin("p".into(), "n".into(), "grant".into(), "audio/webm".into())
            .unwrap();
        let path = registry
            .sessions
            .lock()
            .unwrap()
            .get(&id)
            .unwrap()
            .path
            .clone();
        registry
            .sessions
            .lock()
            .unwrap()
            .get_mut(&id)
            .unwrap()
            .created_at = Instant::now() - SESSION_LIFETIME - Duration::from_secs(1);
        assert!(registry.append(&id, b"late").is_err());
        assert!(!path.exists());
        assert!(registry.finish(&id).is_err());
    }
}
