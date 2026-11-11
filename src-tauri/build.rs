fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "rl_list",
            "rl_scan",
            "rl_tails",
            "rl_decide",
            "rl_handoff_preview",
            "cached_list",
            "app_info",
            "resume_session",
            "launch_handoff",
            "set_pending",
            "close_ack",
            "close_cancel",
            "app_exit",
            "setup_status",
            "install_ringleader",
            "install_uv",
            "setup_prefs",
            "save_setup_prefs",
            "install_presence",
            "install_agent_extras",
        ]),
    ))
    .expect("Tauri build");
}
