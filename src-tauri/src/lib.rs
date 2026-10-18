pub mod cache;
pub mod commands;
pub mod config;
pub mod contract;
pub mod error;
pub mod process;
pub mod rl;

use std::path::PathBuf;
use std::sync::Arc;

use tauri::Manager;

use config::{EnvSnapshot, Pending, Resolved, Settings};

pub struct AppState {
    pub resolved: Arc<Pending<Resolved>>,
    pub settings: Settings,
    pub settings_path: String,
    pub environment_label: Option<String>,
    pub world_root: Option<String>,
    pub resume_dry_run: bool,
    pub list_cache: Option<PathBuf>,
}

fn env_non_empty(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|value| !value.is_empty())
}

fn load_settings(path: &std::path::Path) -> Settings {
    match std::fs::read_to_string(path) {
        Ok(text) => config::parse_settings(&text).unwrap_or_else(|error| {
            eprintln!("circus: ignoring {}: {error}", path.display());
            Settings::default()
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Settings::default(),
        Err(error) => {
            eprintln!("circus: could not read {}: {error}", path.display());
            Settings::default()
        }
    }
}

fn app_state(app: &tauri::AppHandle) -> AppState {
    let settings_file = match app.path().app_config_dir() {
        Ok(dir) => Some(dir.join("settings.json")),
        Err(error) => {
            eprintln!("circus: no app config directory: {error}");
            None
        }
    };
    let settings = settings_file
        .as_deref()
        .map(load_settings)
        .unwrap_or_default();
    let environment_label = env_non_empty("CIRCUS_ENV_LABEL");
    let world_root = env_non_empty("CIRCUS_WORLD_ROOT");
    let list_cache = match app.path().app_data_dir() {
        Ok(dir) => cache::cache_path(&dir, environment_label.as_deref(), world_root.as_deref()),
        Err(error) => {
            eprintln!("circus: no app data directory, list cache disabled: {error}");
            None
        }
    };
    let snapshot = EnvSnapshot {
        circus_rl: env_non_empty("CIRCUS_RL"),
        env_label: environment_label.clone(),
        shell: env_non_empty("SHELL"),
        path: env_non_empty("PATH"),
        home: app
            .path()
            .home_dir()
            .unwrap_or_else(|_| PathBuf::from(std::env::var("HOME").unwrap_or_default())),
    };
    let resolved = Arc::new(Pending::new());
    {
        let resolved = Arc::clone(&resolved);
        let settings = settings.clone();
        std::thread::spawn(move || {
            resolved.set(config::resolve(
                &process::SystemRunner,
                &snapshot,
                &settings,
                &process::is_executable,
            ));
        });
    }
    AppState {
        resolved,
        settings,
        settings_path: settings_file
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_else(|| "settings.json in the app config directory".to_string()),
        environment_label,
        world_root,
        resume_dry_run: std::env::var("CIRCUS_RESUME_DRY_RUN").is_ok_and(|value| value == "1"),
        list_cache,
    }
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let state = app_state(app.handle());
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::rl_list,
            commands::rl_scan,
            commands::rl_tails,
            commands::rl_decide,
            commands::cached_list,
            commands::app_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Circus");
}
