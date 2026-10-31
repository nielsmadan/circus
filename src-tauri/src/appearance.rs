use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::Theme;

use crate::{cache, config};

pub const PREFERENCES_FILE: &str = "preferences.json";
pub const ALL: [Appearance; 3] = [Appearance::System, Appearance::Light, Appearance::Dark];

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Appearance {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Serialize, Deserialize)]
struct Preferences {
    #[serde(default)]
    appearance: Option<Appearance>,
}

pub fn preferences_path(
    app_config_dir: &Path,
    env_label: Option<&str>,
    world_root: Option<&str>,
) -> Option<PathBuf> {
    match (env_label, world_root) {
        (None, _) => Some(app_config_dir.join(PREFERENCES_FILE)),
        (Some(_), Some(world)) => Some(Path::new(world).join(".circus").join(PREFERENCES_FILE)),
        (Some(_), None) => None,
    }
}

fn parse(text: &str) -> Result<Appearance, String> {
    serde_json::from_str::<Preferences>(text)
        .map(|preferences| preferences.appearance.unwrap_or_default())
        .map_err(|error| format!("invalid preferences: {error}"))
}

fn to_json(appearance: Appearance) -> String {
    let preferences = Preferences {
        appearance: Some(appearance),
    };
    let mut text = serde_json::to_string_pretty(&preferences).expect("preferences serialize");
    text.push('\n');
    text
}

pub fn load(path: &Path) -> Appearance {
    config::read_or_default(path, parse)
}

pub fn save(path: &Path, appearance: Appearance) -> std::io::Result<()> {
    cache::write_atomic(path, to_json(appearance).as_bytes())
}

pub fn forced_theme(appearance: Appearance) -> Option<Theme> {
    match appearance {
        Appearance::System => None,
        Appearance::Light => Some(Theme::Light),
        Appearance::Dark => Some(Theme::Dark),
    }
}

pub fn menu_id(appearance: Appearance) -> &'static str {
    match appearance {
        Appearance::System => "appearance-system",
        Appearance::Light => "appearance-light",
        Appearance::Dark => "appearance-dark",
    }
}

pub fn menu_label(appearance: Appearance) -> &'static str {
    match appearance {
        Appearance::System => "Follow System",
        Appearance::Light => "Light",
        Appearance::Dark => "Dark",
    }
}

pub fn from_menu_id(id: &str) -> Option<Appearance> {
    ALL.into_iter()
        .find(|appearance| menu_id(*appearance) == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let dir = std::env::temp_dir().join(format!(
            "circus-appearance-{name}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn parse_reads_each_appearance() {
        assert_eq!(parse(r#"{"appearance":"system"}"#), Ok(Appearance::System));
        assert_eq!(parse(r#"{"appearance":"light"}"#), Ok(Appearance::Light));
        assert_eq!(parse(r#"{"appearance":"dark"}"#), Ok(Appearance::Dark));
    }

    #[test]
    fn parse_ignores_unknown_keys() {
        assert_eq!(
            parse(r#"{"appearance":"dark","other":1}"#),
            Ok(Appearance::Dark)
        );
    }

    #[test]
    fn parse_defaults_a_missing_appearance_to_system() {
        assert_eq!(parse("{}"), Ok(Appearance::System));
        assert_eq!(parse(r#"{"appearance":null}"#), Ok(Appearance::System));
    }

    #[test]
    fn parse_rejects_unknown_values_and_malformed_documents() {
        for text in [
            r#"{"appearance":"sepia"}"#,
            r#"{"appearance":"Dark"}"#,
            r#"{"appearance":1}"#,
            r#""dark""#,
            "null",
            "",
            "{not json",
        ] {
            assert!(parse(text).is_err(), "{text:?}");
        }
    }

    #[test]
    fn to_json_writes_only_the_appearance_and_round_trips() {
        assert_eq!(
            to_json(Appearance::Dark),
            "{\n  \"appearance\": \"dark\"\n}\n"
        );
        for appearance in ALL {
            assert_eq!(parse(&to_json(appearance)), Ok(appearance));
        }
    }

    #[test]
    fn preferences_path_keeps_labelled_launches_inside_their_world() {
        assert_eq!(PREFERENCES_FILE, "preferences.json");
        assert_eq!(
            preferences_path(Path::new("/c"), None, None),
            Some(PathBuf::from("/c/preferences.json"))
        );
        assert_eq!(
            preferences_path(Path::new("/c"), Some("sandbox"), Some("/w")),
            Some(PathBuf::from("/w/.circus/preferences.json"))
        );
        assert_eq!(
            preferences_path(Path::new("/c"), Some("sandbox"), None),
            None
        );
    }

    #[test]
    fn save_then_load_restores_the_choice() {
        let dir = temp_dir("round-trip");
        let path = dir.join("nested").join(PREFERENCES_FILE);
        for appearance in ALL {
            save(&path, appearance).expect("save");
            assert_eq!(load(&path), appearance);
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn load_falls_back_to_system_for_missing_unreadable_or_invalid_files() {
        let dir = temp_dir("fallback");
        assert_eq!(load(&dir.join("missing.json")), Appearance::System);
        assert_eq!(load(&dir), Appearance::System);
        let invalid = dir.join(PREFERENCES_FILE);
        std::fs::write(&invalid, "{not json").expect("write");
        assert_eq!(load(&invalid), Appearance::System);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn forced_theme_is_none_only_when_following_the_system() {
        assert_eq!(forced_theme(Appearance::System), None);
        assert_eq!(forced_theme(Appearance::Light), Some(Theme::Light));
        assert_eq!(forced_theme(Appearance::Dark), Some(Theme::Dark));
    }

    #[test]
    fn menu_lists_the_choices_in_order_with_their_labels() {
        assert_eq!(ALL.map(menu_label), ["Follow System", "Light", "Dark"]);
    }

    #[test]
    fn menu_ids_map_back_to_their_appearance() {
        for appearance in ALL {
            assert_eq!(from_menu_id(menu_id(appearance)), Some(appearance));
        }
        assert_eq!(from_menu_id("quit"), None);
        assert_eq!(from_menu_id(""), None);
        assert_eq!(from_menu_id("appearance-Light"), None);
    }
}
