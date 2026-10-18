fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "rl_list",
            "rl_scan",
            "rl_tails",
            "rl_decide",
            "cached_list",
            "app_info",
            "resume_session",
            "set_pending",
            "close_ack",
            "app_exit",
        ]),
    ))
    .expect("Tauri build");
}
