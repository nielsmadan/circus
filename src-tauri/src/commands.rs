use std::path::Path;
use std::sync::{Mutex, MutexGuard, PoisonError};

use tauri::ipc::Response;
use tauri::{AppHandle, State};

use crate::AppState;
use crate::cache;
use crate::close::CloseGate;
use crate::config::{self, Resolved};
use crate::contract::{
    AppInfo, DecideRequest, ResumeLaunch, ResumeRequest, TailsRequest, TerminalKind,
};
use crate::error::{CircusError, ErrorKind};
use crate::process::{ProcessRunner, SystemRunner};
use crate::resume;
use crate::rl::RlClient;

pub const CLOSE_REQUESTED_EVENT: &str = "circus://close-requested";

pub fn lock_gate(gate: &Mutex<CloseGate>) -> MutexGuard<'_, CloseGate> {
    gate.lock().unwrap_or_else(PoisonError::into_inner)
}

async fn blocking<T, F>(work: F) -> Result<T, CircusError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, CircusError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| {
            CircusError::new(
                ErrorKind::Failed,
                format!("background task failed: {error}"),
            )
        })?
}

fn client(resolved: Resolved, settings_path: &str) -> RlClient<SystemRunner> {
    let message = config::not_found_message(&resolved, settings_path);
    RlClient::new(SystemRunner, resolved.command, resolved.path_env, message)
}

fn with_client<T, F>(
    state: &AppState,
    call: F,
) -> impl FnOnce() -> Result<T, CircusError> + Send + 'static
where
    F: FnOnce(RlClient<SystemRunner>) -> Result<T, CircusError> + Send + 'static,
{
    let resolved = std::sync::Arc::clone(&state.resolved);
    let settings_path = state.settings_path.clone();
    move || call(client(resolved.wait(), &settings_path))
}

#[derive(Clone, Copy)]
enum ListFetch {
    Plain,
    Scan,
}

fn fetch_list_and_cache<R: ProcessRunner>(
    rl: &RlClient<R>,
    fetch: ListFetch,
    cache_file: Option<&Path>,
) -> Result<Vec<u8>, CircusError> {
    let bytes = match fetch {
        ListFetch::Plain => rl.list(),
        ListFetch::Scan => rl.scan(),
    }?;
    if let Some(path) = cache_file
        && let Err(error) = cache::write_atomic(path, &bytes)
    {
        eprintln!(
            "circus: could not write the list cache {}: {error}",
            path.display()
        );
    }
    Ok(bytes)
}

async fn list_command(state: &AppState, fetch: ListFetch) -> Result<Response, CircusError> {
    let cache_file = state.list_cache.clone();
    let work = with_client(state, move |rl| {
        fetch_list_and_cache(&rl, fetch, cache_file.as_deref())
    });
    blocking(work).await.map(Response::new)
}

#[tauri::command]
pub async fn rl_list(state: State<'_, AppState>) -> Result<Response, CircusError> {
    list_command(&state, ListFetch::Plain).await
}

#[tauri::command]
pub async fn rl_scan(state: State<'_, AppState>) -> Result<Response, CircusError> {
    list_command(&state, ListFetch::Scan).await
}

#[tauri::command]
pub async fn rl_tails(
    state: State<'_, AppState>,
    request: TailsRequest,
) -> Result<Response, CircusError> {
    blocking(with_client(&state, move |rl| rl.tails(&request)))
        .await
        .map(Response::new)
}

#[tauri::command]
pub async fn rl_decide(
    state: State<'_, AppState>,
    request: DecideRequest,
) -> Result<Response, CircusError> {
    blocking(with_client(&state, move |rl| rl.decide(&request)))
        .await
        .map(Response::new)
}

#[tauri::command]
pub async fn cached_list(state: State<'_, AppState>) -> Result<Response, CircusError> {
    let cache_file = state.list_cache.clone();
    blocking(move || Ok(cache::read_cache(cache_file.as_deref())))
        .await
        .map(Response::new)
}

#[tauri::command]
pub async fn app_info(state: State<'_, AppState>) -> Result<AppInfo, CircusError> {
    let resolved = std::sync::Arc::clone(&state.resolved);
    let resolved = blocking(move || Ok(resolved.wait())).await?;
    Ok(AppInfo {
        rl_command: resolved.command,
        rl_source: resolved.source,
        shell_probe: resolved.probe,
        environment_label: state.environment_label.clone(),
        world_root: state.world_root.clone(),
        resume_dry_run: state.resume_dry_run,
        terminal: match state.settings.terminal_command {
            Some(_) => TerminalKind::Custom,
            None => TerminalKind::Iterm2,
        },
        settings_path: state.settings_path.clone(),
    })
}

#[tauri::command]
pub async fn resume_session(
    state: State<'_, AppState>,
    request: ResumeRequest,
) -> Result<ResumeLaunch, CircusError> {
    let resolved = std::sync::Arc::clone(&state.resolved);
    let terminal_command = state.settings.terminal_command.clone();
    let dry_run = state.resume_dry_run;
    blocking(move || {
        let resolved = resolved.wait();
        let runner = resume::WithPath {
            inner: &SystemRunner,
            path_env: resolved.path_env.clone(),
        };
        resume::launch(
            &runner,
            &resolved.command,
            &request.id,
            terminal_command.as_deref(),
            dry_run,
        )
    })
    .await
}

#[tauri::command]
pub fn set_pending(state: State<'_, AppState>, count: u32) {
    lock_gate(&state.close).set_pending(count);
}

#[tauri::command]
pub fn close_ack(state: State<'_, AppState>) {
    lock_gate(&state.close).ack();
}

#[tauri::command]
pub fn close_cancel(state: State<'_, AppState>) {
    lock_gate(&state.close).cancel();
}

#[tauri::command]
pub fn app_exit(app: AppHandle, state: State<'_, AppState>) {
    // the watchdog thread shares this mutex, so the guard is dropped before exit
    let first = lock_gate(&state.close).begin_exit();
    if first {
        app.exit(0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process::{ProcessOutput, ProcessSpec, RunError};
    use std::path::PathBuf;

    const LIST: &[u8] = include_bytes!("../tests/fixtures/list.json");
    const SCAN: &[u8] = include_bytes!("../tests/fixtures/scan.json");

    struct ListRunner;

    impl ProcessRunner for ListRunner {
        fn run(&self, spec: &ProcessSpec) -> Result<ProcessOutput, RunError> {
            let scan = spec.args.iter().any(|arg| arg == "--scan");
            Ok(ProcessOutput {
                exit_code: Some(0),
                stdout: if scan { SCAN } else { LIST }.to_vec(),
                stderr: String::new(),
            })
        }
    }

    fn cache_file(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        std::env::temp_dir()
            .join(format!(
                "circus-commands-{name}-{}-{nanos}",
                std::process::id()
            ))
            .join(cache::LIST_CACHE_FILE)
    }

    #[test]
    fn list_and_scan_write_the_document_they_return_to_the_cache() {
        let rl = RlClient::new(ListRunner, vec!["rl".to_string()], None, String::new());
        for (fetch, name, expected) in [
            (ListFetch::Plain, "list", LIST),
            (ListFetch::Scan, "scan", SCAN),
        ] {
            let path = cache_file(name);
            let bytes = fetch_list_and_cache(&rl, fetch, Some(&path)).expect(name);
            assert_eq!(bytes, expected, "{name}");
            assert_eq!(std::fs::read(&path).expect("cache"), expected, "{name}");
            if let Some(dir) = path.parent() {
                let _ = std::fs::remove_dir_all(dir);
            }
        }
    }
}
