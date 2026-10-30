use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::contract::Envelope;

pub const LIST_CACHE_FILE: &str = "list-cache.json";

static WRITE_COUNTER: AtomicU64 = AtomicU64::new(0);

pub fn cache_path(
    app_data_dir: &Path,
    env_label: Option<&str>,
    world_root: Option<&str>,
) -> Option<PathBuf> {
    match (env_label, world_root) {
        (None, _) => Some(app_data_dir.join(LIST_CACHE_FILE)),
        (Some(_), Some(world)) => Some(Path::new(world).join(".circus").join(LIST_CACHE_FILE)),
        (Some(_), None) => None,
    }
}

pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "cache path has no parent")
    })?;
    let name = path.file_name().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "cache path has no file name",
        )
    })?;
    std::fs::create_dir_all(parent)?;
    let temp = parent.join(format!(
        "{}.tmp.{}.{}",
        name.to_string_lossy(),
        std::process::id(),
        WRITE_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    if let Err(error) = std::fs::write(&temp, bytes) {
        let _ = std::fs::remove_file(&temp);
        return Err(error);
    }
    std::fs::rename(&temp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&temp);
    })
}

pub fn read_cache(path: Option<&Path>) -> Vec<u8> {
    let Some(bytes) = path.and_then(|p| std::fs::read(p).ok()) else {
        return Vec::new();
    };
    let valid = std::str::from_utf8(&bytes).is_ok()
        && serde_json::from_slice::<Envelope>(&bytes)
            .is_ok_and(|envelope| envelope.kind == "list" && envelope.version == 1);
    if valid { bytes } else { Vec::new() }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIST: &[u8] = include_bytes!("../tests/fixtures/list.json");
    const SCAN: &[u8] = include_bytes!("../tests/fixtures/scan.json");
    const TAILS: &[u8] = include_bytes!("../tests/fixtures/tails.json");

    fn temp_dir(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let dir = std::env::temp_dir().join(format!(
            "circus-cache-{name}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn cache_path_follows_the_environment_label() {
        assert_eq!(
            cache_path(Path::new("/d"), None, None),
            Some(PathBuf::from("/d/list-cache.json"))
        );
        assert_eq!(
            cache_path(Path::new("/d"), Some("sandbox"), Some("/w")),
            Some(PathBuf::from("/w/.circus/list-cache.json"))
        );
        assert_eq!(cache_path(Path::new("/d"), Some("sandbox"), None), None);
    }

    #[test]
    fn write_atomic_creates_and_replaces_the_cache() {
        let dir = temp_dir("write");
        let path = dir.join("a").join(LIST_CACHE_FILE);
        write_atomic(&path, LIST).expect("first write");
        assert_eq!(read_cache(Some(&path)), LIST);
        let entries: Vec<_> = std::fs::read_dir(dir.join("a"))
            .expect("read dir")
            .map(|entry| entry.expect("entry").file_name())
            .collect();
        assert_eq!(entries, vec![std::ffi::OsString::from(LIST_CACHE_FILE)]);

        let replacement = br#"{"version":1,"kind":"list","sessions":[{"id":"codex:x"}]}"#;
        write_atomic(&path, replacement).expect("second write");
        assert_eq!(read_cache(Some(&path)), replacement);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn concurrent_writes_all_succeed_and_leave_one_whole_document() {
        let dir = temp_dir("concurrent");
        let path = dir.join(LIST_CACHE_FILE);
        let documents: Vec<Vec<u8>> = (1..=8)
            .map(|n| {
                format!(
                    r#"{{"version":1,"kind":"list","sessions":[{}]}}"#,
                    vec![r#"{"id":"codex:x"}"#; n * 200].join(",")
                )
                .into_bytes()
            })
            .collect();
        let failures: usize = std::thread::scope(|scope| {
            let handles: Vec<_> = documents
                .iter()
                .map(|document| {
                    let path = &path;
                    scope.spawn(move || {
                        (0..40)
                            .filter(|_| write_atomic(path, document).is_err())
                            .count()
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|handle| handle.join().expect("writer"))
                .sum()
        });
        assert_eq!(failures, 0);
        assert!(documents.contains(&read_cache(Some(&path))));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn read_cache_returns_empty_for_anything_but_a_v1_list() {
        let dir = temp_dir("read");
        let scan = dir.join("scan.json");
        std::fs::write(&scan, SCAN).expect("write scan");
        assert_eq!(read_cache(Some(&scan)), SCAN);
        let tails = dir.join("tails.json");
        std::fs::write(&tails, TAILS).expect("write tails");
        assert_eq!(read_cache(Some(&tails)), Vec::<u8>::new());
        let invalid = dir.join("invalid.json");
        std::fs::write(&invalid, [0xff]).expect("write invalid");
        assert_eq!(read_cache(Some(&invalid)), Vec::<u8>::new());
        assert_eq!(
            read_cache(Some(&dir.join("missing.json"))),
            Vec::<u8>::new()
        );
        assert_eq!(read_cache(None), Vec::<u8>::new());
        let _ = std::fs::remove_dir_all(dir);
    }
}
