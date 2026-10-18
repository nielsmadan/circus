use tauri::State;
use tauri::ipc::Response;

use crate::AppState;
use crate::cache;
use crate::config::{self, Resolved};
use crate::contract::{AppInfo, DecideRequest, TailsRequest, TerminalKind};
use crate::error::{CircusError, ErrorKind};
use crate::process::SystemRunner;
use crate::rl::RlClient;

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

#[tauri::command]
pub async fn rl_list(state: State<'_, AppState>) -> Result<Response, CircusError> {
    let cache_file = state.list_cache.clone();
    let work = with_client(&state, move |rl| {
        let bytes = rl.list()?;
        if let Some(path) = cache_file
            && let Err(error) = cache::write_atomic(&path, &bytes)
        {
            eprintln!(
                "circus: could not write the list cache {}: {error}",
                path.display()
            );
        }
        Ok(bytes)
    });
    blocking(work).await.map(Response::new)
}

#[tauri::command]
pub async fn rl_scan(state: State<'_, AppState>) -> Result<Response, CircusError> {
    blocking(with_client(&state, |rl| rl.scan()))
        .await
        .map(Response::new)
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
