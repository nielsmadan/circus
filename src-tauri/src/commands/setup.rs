use tauri::State;

use super::blocking;
use crate::AppState;
use crate::contract::{SetupPrefs, SetupStatus};
use crate::error::{CircusError, ErrorKind};
use crate::process::{SystemRunner, is_executable};
use crate::setup::{self, InstallPolicy, SetupContext};

fn setup_context(state: &AppState) -> SetupContext {
    SetupContext {
        home: state.home.clone(),
        download_dir: state.download_dir.clone(),
        setup_file: state.setup_file.clone(),
        settings_path: state.settings_path.clone(),
        policy: InstallPolicy::for_environment(state.environment_label.as_deref()),
    }
}

#[tauri::command]
pub async fn setup_status(state: State<'_, AppState>) -> Result<SetupStatus, CircusError> {
    let resolved = std::sync::Arc::clone(&state.resolved);
    let context = setup_context(&state);
    blocking(move || {
        Ok(setup::current_status(
            &SystemRunner,
            &context,
            &resolved.wait(),
            &is_executable,
            setup::manifest(),
        ))
    })
    .await
}

#[tauri::command]
pub async fn install_ringleader(state: State<'_, AppState>) -> Result<SetupStatus, CircusError> {
    let pending = std::sync::Arc::clone(&state.resolved);
    let context = setup_context(&state);
    blocking(move || {
        let next = setup::install_ringleader(
            &SystemRunner,
            &context,
            &pending.wait(),
            setup::manifest(),
            &is_executable,
        )?;
        pending.set(next.clone());
        Ok(setup::current_status(
            &SystemRunner,
            &context,
            &next,
            &is_executable,
            setup::manifest(),
        ))
    })
    .await
}

#[tauri::command]
pub async fn install_uv(state: State<'_, AppState>) -> Result<SetupStatus, CircusError> {
    let pending = std::sync::Arc::clone(&state.resolved);
    let context = setup_context(&state);
    blocking(move || {
        let resolved = pending.wait();
        setup::install_uv(
            &SystemRunner,
            &context,
            resolved.path_env.as_deref(),
            setup::manifest(),
            &is_executable,
        )?;
        Ok(setup::current_status(
            &SystemRunner,
            &context,
            &resolved,
            &is_executable,
            setup::manifest(),
        ))
    })
    .await
}

#[tauri::command]
pub fn setup_prefs(state: State<'_, AppState>) -> SetupPrefs {
    state
        .setup_file
        .as_deref()
        .map(setup::load_prefs)
        .unwrap_or_default()
}

#[tauri::command]
pub fn save_setup_prefs(state: State<'_, AppState>, prefs: SetupPrefs) -> Result<(), CircusError> {
    let Some(path) = state.setup_file.as_deref() else {
        return Ok(());
    };
    setup::save_prefs(path, prefs).map_err(|error| {
        CircusError::new(
            ErrorKind::Failed,
            format!("Could not save the setup choices: {error}"),
        )
    })
}

#[tauri::command]
pub async fn install_presence(state: State<'_, AppState>) -> Result<(), CircusError> {
    let pending = std::sync::Arc::clone(&state.resolved);
    let context = setup_context(&state);
    blocking(move || setup::install_presence(&SystemRunner, &context, &pending.wait())).await
}

#[tauri::command]
pub async fn install_agent_extras(state: State<'_, AppState>) -> Result<(), CircusError> {
    let pending = std::sync::Arc::clone(&state.resolved);
    let context = setup_context(&state);
    blocking(move || setup::install_agent_extras(&SystemRunner, &context, &pending.wait())).await
}
