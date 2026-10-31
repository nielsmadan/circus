pub mod appearance;
pub mod cache;
pub mod close;
pub mod commands;
pub mod config;
pub mod contract;
pub mod error;
pub mod process;
pub mod resume;
pub mod rl;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::menu::{
    CheckMenuItem, CheckMenuItemBuilder, Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder,
};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};

use appearance::Appearance;
use close::{CloseGate, Watch, close_effects};
use commands::{CLOSE_REQUESTED_EVENT, lock_gate};
use config::{EnvSnapshot, Pending, Resolved, Settings};
use contract::CloseRequested;

const QUIT_MENU_ID: &str = "quit";
const WATCHDOG_POLL: Duration = Duration::from_millis(250);

pub struct AppState {
    pub resolved: Arc<Pending<Resolved>>,
    pub settings: Settings,
    pub settings_path: String,
    pub environment_label: Option<String>,
    pub world_root: Option<String>,
    pub resume_dry_run: bool,
    pub list_cache: Option<PathBuf>,
    pub close: Arc<Mutex<CloseGate>>,
    pub preferences: Option<PathBuf>,
}

struct AppearanceMenu {
    items: Vec<(Appearance, CheckMenuItem<tauri::Wry>)>,
}

fn env_non_empty(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|value| !value.is_empty())
}

fn app_state(app: &AppHandle, close: Arc<Mutex<CloseGate>>) -> AppState {
    let config_dir = match app.path().app_config_dir() {
        Ok(dir) => Some(dir),
        Err(error) => {
            eprintln!(
                "circus: no app config directory, settings and appearance not saved: {error}"
            );
            None
        }
    };
    let settings_file = config_dir
        .as_ref()
        .map(|dir| dir.join(config::SETTINGS_FILE));
    let settings = settings_file
        .as_deref()
        .map(|path| config::read_or_default(path, config::parse_settings))
        .unwrap_or_default();
    let environment_label = env_non_empty("CIRCUS_ENV_LABEL");
    let world_root = env_non_empty("CIRCUS_WORLD_ROOT");
    let preferences = config_dir.as_deref().and_then(|dir| {
        appearance::preferences_path(dir, environment_label.as_deref(), world_root.as_deref())
    });
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
        close,
        preferences,
    }
}

fn check_selected(items: &[(Appearance, CheckMenuItem<tauri::Wry>)], selected: Appearance) {
    for (each, item) in items {
        if let Err(error) = item.set_checked(*each == selected) {
            eprintln!("circus: could not update the appearance menu: {error}");
        }
    }
}

fn set_appearance(app: &AppHandle, chosen: Appearance) {
    app.set_theme(appearance::forced_theme(chosen));
    check_selected(&app.state::<AppearanceMenu>().items, chosen);
    if let Some(path) = &app.state::<AppState>().preferences
        && let Err(error) = appearance::save(path, chosen)
    {
        eprintln!("circus: could not save {}: {error}", path.display());
    }
}

fn appearance_items(
    app: &AppHandle,
) -> tauri::Result<Vec<(Appearance, CheckMenuItem<tauri::Wry>)>> {
    appearance::ALL
        .into_iter()
        .map(|each| {
            CheckMenuItemBuilder::with_id(appearance::menu_id(each), appearance::menu_label(each))
                .build(app)
                .map(|item| (each, item))
        })
        .collect()
}

fn app_menu(
    app: &AppHandle,
    appearance_items: &[(Appearance, CheckMenuItem<tauri::Wry>)],
) -> tauri::Result<Menu<tauri::Wry>> {
    // replaces the predefined Quit, which tao never routes through ExitRequested (tauri-apps/tauri#9198)
    let quit = MenuItemBuilder::with_id(QUIT_MENU_ID, "Quit Circus")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;
    let circus = SubmenuBuilder::new(app, "Circus")
        .about(None)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .item(&quit)
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let appearance_menu = appearance_items
        .iter()
        .fold(SubmenuBuilder::new(app, "Appearance"), |menu, (_, item)| {
            menu.item(item)
        })
        .build()?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&appearance_menu)
        .build()?;
    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .close_window()
        .build()?;
    MenuBuilder::new(app)
        .items(&[&circus, &edit, &view, &window])
        .build()
}

fn spawn_watchdog(app: AppHandle, gate: Arc<Mutex<CloseGate>>, round: u64) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(WATCHDOG_POLL);
            // bound by `let` so the guard is dropped before exit
            let next = lock_gate(&gate).watch(Instant::now(), round);
            match next {
                Watch::Wait => {}
                Watch::Stop => return,
                Watch::Exit => {
                    app.exit(0);
                    return;
                }
            }
        }
    });
}

fn on_close_request(app: &AppHandle, gate: &Arc<Mutex<CloseGate>>) -> bool {
    let now = Instant::now();
    let (action, round, finish_in) = {
        let mut gate = lock_gate(gate);
        let action = gate.request(now);
        (action, gate.round(), gate.finish_in(now))
    };
    let effects = close_effects(action);
    if effects.spawn_watchdog {
        spawn_watchdog(app.clone(), Arc::clone(gate), round);
    }
    let payload = CloseRequested {
        finish_in_ms: u64::try_from(finish_in.as_millis()).unwrap_or(u64::MAX),
    };
    if effects.emit
        && let Err(error) = app.emit(CLOSE_REQUESTED_EVENT, payload)
    {
        eprintln!("circus: could not emit {CLOSE_REQUESTED_EVENT}: {error}");
    }
    effects.prevent
}

pub fn run() {
    let gate = Arc::new(Mutex::new(CloseGate::default()));
    let setup_gate = Arc::clone(&gate);
    let window_gate = Arc::clone(&gate);
    let menu_gate = Arc::clone(&gate);
    let app = tauri::Builder::default()
        .setup(move |app| {
            let state = app_state(app.handle(), setup_gate);
            let current = state
                .preferences
                .as_deref()
                .map(appearance::load)
                .unwrap_or_default();
            app.set_theme(appearance::forced_theme(current));
            let items = appearance_items(app.handle())?;
            check_selected(&items, current);
            app.set_menu(app_menu(app.handle(), &items)?)?;
            app.manage(AppearanceMenu { items });
            app.manage(state);
            Ok(())
        })
        .on_window_event(move |window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event
                && on_close_request(window.app_handle(), &window_gate)
            {
                api.prevent_close();
            }
        })
        .on_menu_event(move |app, event| {
            let id = event.id().as_ref();
            if let Some(chosen) = appearance::from_menu_id(id) {
                set_appearance(app, chosen);
            } else if id == QUIT_MENU_ID && !on_close_request(app, &menu_gate) {
                app.exit(0);
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::rl_list,
            commands::rl_scan,
            commands::rl_tails,
            commands::rl_decide,
            commands::cached_list,
            commands::app_info,
            commands::resume_session,
            commands::set_pending,
            commands::close_ack,
            commands::close_cancel,
            commands::app_exit,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Circus");
    app.run(move |app, event| {
        if let RunEvent::ExitRequested {
            code: None, api, ..
        } = event
            && on_close_request(app, &gate)
        {
            api.prevent_exit();
        }
    });
}
