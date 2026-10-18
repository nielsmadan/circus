use std::path::Path;
use std::sync::{Condvar, Mutex, PoisonError};
use std::time::Duration;

use serde::Deserialize;

use crate::contract::{RlSource, ShellProbeState};
use crate::process::{ProcessRunner, ProcessSpec, RunError};

pub const SHELL_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
pub const SHELL_PROBE_SCRIPT: &str = r#"printf '\n__CIRCUS_PATH__%s__CIRCUS_END__\n' "$PATH"; printf '__CIRCUS_RL__%s__CIRCUS_END__\n' "$(command -v rl 2>/dev/null)"; exit 0"#;
pub const FALLBACK_DIRS: [&str; 3] = ["~/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"];
const DEFAULT_SHELL: &str = "/bin/zsh";
const UNRESOLVED_SANDBOX_RL: &str = "circus-sandbox-rl-unresolved";
const END_MARKER: &str = "__CIRCUS_END__";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Settings {
    pub rl_command: Option<Vec<String>>,
    pub terminal_command: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct RawSettings {
    #[serde(default)]
    rl_command: Option<Vec<String>>,
    #[serde(default)]
    terminal_command: Option<Vec<String>>,
}

fn non_empty(list: Option<Vec<String>>) -> Option<Vec<String>> {
    list.filter(|items| !items.is_empty())
}

pub fn parse_settings(text: &str) -> Result<Settings, String> {
    let raw: RawSettings =
        serde_json::from_str(text).map_err(|error| format!("invalid settings: {error}"))?;
    Ok(Settings {
        rl_command: non_empty(raw.rl_command),
        terminal_command: non_empty(raw.terminal_command),
    })
}

pub fn shell_probe_spec(shell: Option<&str>) -> ProcessSpec {
    ProcessSpec {
        program: shell
            .filter(|s| !s.is_empty())
            .unwrap_or(DEFAULT_SHELL)
            .to_string(),
        args: vec!["-ilc".to_string(), SHELL_PROBE_SCRIPT.to_string()],
        path_env: None,
        extra_env: vec![("DISABLE_AUTO_UPDATE".to_string(), "true".to_string())],
        timeout: SHELL_PROBE_TIMEOUT,
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ShellProbe {
    pub path: Option<String>,
    pub rl: Option<String>,
}

fn between_markers(stdout: &str, start: &str) -> Option<String> {
    let from = stdout.rfind(start)? + start.len();
    let len = stdout[from..].find(END_MARKER)?;
    Some(stdout[from..from + len].to_string()).filter(|value| !value.is_empty())
}

pub fn parse_shell_probe(stdout: &str) -> ShellProbe {
    ShellProbe {
        path: between_markers(stdout, "__CIRCUS_PATH__"),
        rl: between_markers(stdout, "__CIRCUS_RL__").filter(|rl| rl.starts_with('/')),
    }
}

pub fn fallback_rl(home: &Path, is_executable: &dyn Fn(&Path) -> bool) -> Option<String> {
    FALLBACK_DIRS
        .iter()
        .map(|dir| match dir.strip_prefix("~/") {
            Some(rest) => home.join(rest).join("rl"),
            None => Path::new(dir).join("rl"),
        })
        .find(|candidate| is_executable(candidate))
        .map(|found| found.to_string_lossy().into_owned())
}

pub fn resolve_rl(
    env_rl: Option<&str>,
    settings: &Settings,
    login_rl: Option<&str>,
    fallback: Option<&str>,
) -> (Vec<String>, RlSource) {
    if let Some(words) = env_rl.and_then(shlex::split).filter(|w| !w.is_empty()) {
        return (words, RlSource::Env);
    }
    if let Some(command) = settings.rl_command.clone().filter(|c| !c.is_empty()) {
        return (command, RlSource::Settings);
    }
    if let Some(rl) = login_rl {
        return (vec![rl.to_string()], RlSource::LoginShell);
    }
    if let Some(rl) = fallback {
        return (vec![rl.to_string()], RlSource::Fallback);
    }
    (vec!["rl".to_string()], RlSource::Missing)
}

pub fn merge_path(current: Option<&str>, login: Option<&str>) -> Option<String> {
    let entries = |path: Option<&str>| -> Vec<String> {
        path.unwrap_or("")
            .split(':')
            .filter(|entry| !entry.is_empty())
            .map(str::to_string)
            .collect()
    };
    let current_entries = entries(current);
    let login_entries = entries(login);
    let extra = login_entries
        .iter()
        .enumerate()
        .filter(|(index, entry)| {
            !current_entries.contains(entry) && !login_entries[..*index].contains(entry)
        })
        .map(|(_, entry)| entry.clone());
    let merged: Vec<String> = current_entries.iter().cloned().chain(extra).collect();
    (!merged.is_empty()).then(|| merged.join(":"))
}

#[derive(Debug, Clone)]
pub struct EnvSnapshot {
    pub circus_rl: Option<String>,
    pub env_label: Option<String>,
    pub shell: Option<String>,
    pub path: Option<String>,
    pub home: std::path::PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    pub command: Vec<String>,
    pub source: RlSource,
    pub path_env: Option<String>,
    pub probe: ShellProbeState,
}

fn run_probe<R: ProcessRunner>(runner: &R, shell: Option<&str>) -> (ShellProbe, ShellProbeState) {
    match runner.run(&shell_probe_spec(shell)) {
        Ok(output) if output.exit_code == Some(0) => (
            parse_shell_probe(&String::from_utf8_lossy(&output.stdout)),
            ShellProbeState::Ok,
        ),
        Err(RunError::Timeout) => (ShellProbe::default(), ShellProbeState::TimedOut),
        _ => (ShellProbe::default(), ShellProbeState::Failed),
    }
}

pub fn resolve<R: ProcessRunner>(
    runner: &R,
    env: &EnvSnapshot,
    settings: &Settings,
    is_executable: &dyn Fn(&Path) -> bool,
) -> Resolved {
    let env_rl_unusable = env.env_label.is_some()
        && env
            .circus_rl
            .as_deref()
            .is_some_and(|value| shlex::split(value).is_none_or(|words| words.is_empty()));
    if env_rl_unusable {
        return Resolved {
            command: vec![UNRESOLVED_SANDBOX_RL.to_string()],
            source: RlSource::Missing,
            path_env: env.path.clone(),
            probe: ShellProbeState::Skipped,
        };
    }
    let (probe, state) = match env.circus_rl {
        Some(_) => (ShellProbe::default(), ShellProbeState::Skipped),
        None => run_probe(runner, env.shell.as_deref()),
    };
    let login_rl = probe.rl.filter(|rl| is_executable(Path::new(rl)));
    let fallback = fallback_rl(&env.home, is_executable);
    let (command, source) = resolve_rl(
        env.circus_rl.as_deref(),
        settings,
        login_rl.as_deref(),
        fallback.as_deref(),
    );
    Resolved {
        command,
        source,
        path_env: merge_path(env.path.as_deref(), probe.path.as_deref()),
        probe: state,
    }
}

pub fn not_found_message(resolved: &Resolved, settings_path: &str) -> String {
    let base = format!(
        "Could not run `{}`. Set CIRCUS_RL, or set \"rl_command\" (an argv array) in {settings_path}, or put rl on your login shell's PATH.",
        resolved.command.join(" ")
    );
    match resolved.probe {
        ShellProbeState::TimedOut => {
            format!("{base} The login shell did not answer within 5 s.")
        }
        _ => base,
    }
}

pub struct Pending<T: Clone> {
    value: Mutex<Option<T>>,
    ready: Condvar,
}

impl<T: Clone> Default for Pending<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T: Clone> Pending<T> {
    pub fn new() -> Self {
        Self {
            value: Mutex::new(None),
            ready: Condvar::new(),
        }
    }

    pub fn set(&self, value: T) {
        *self.value.lock().unwrap_or_else(PoisonError::into_inner) = Some(value);
        self.ready.notify_all();
    }

    pub fn wait(&self) -> T {
        let guard = self.value.lock().unwrap_or_else(PoisonError::into_inner);
        let guard = self
            .ready
            .wait_while(guard, |value| value.is_none())
            .unwrap_or_else(PoisonError::into_inner);
        guard
            .clone()
            .expect("wait_while returns only once a value is set")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process::ProcessOutput;
    use std::path::PathBuf;
    use std::sync::Arc;

    struct FakeRunner {
        result: Result<ProcessOutput, RunError>,
        specs: Mutex<Vec<ProcessSpec>>,
    }

    impl FakeRunner {
        fn new(result: Result<ProcessOutput, RunError>) -> Self {
            Self {
                result,
                specs: Mutex::new(Vec::new()),
            }
        }
    }

    impl ProcessRunner for FakeRunner {
        fn run(&self, spec: &ProcessSpec) -> Result<ProcessOutput, RunError> {
            self.specs.lock().expect("specs").push(spec.clone());
            self.result.clone()
        }
    }

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_string()).collect()
    }

    fn env(circus_rl: Option<&str>) -> EnvSnapshot {
        EnvSnapshot {
            circus_rl: circus_rl.map(str::to_string),
            env_label: None,
            shell: Some("/bin/zsh".to_string()),
            path: Some("/usr/bin:/bin".to_string()),
            home: PathBuf::from("/h"),
        }
    }

    #[test]
    fn parse_settings_reads_both_arrays_and_ignores_unknown_keys() {
        let settings = parse_settings(
            r#"{"rl_command":["/opt/rl","--x"],"terminal_command":["open","{command}"],"theme":"dark"}"#,
        )
        .expect("settings");
        assert_eq!(settings.rl_command, Some(strings(&["/opt/rl", "--x"])));
        assert_eq!(
            settings.terminal_command,
            Some(strings(&["open", "{command}"]))
        );
        assert_eq!(
            parse_settings(r#"{"rl_command":[]}"#)
                .expect("empty")
                .rl_command,
            None
        );
        assert_eq!(parse_settings("{}").expect("defaults"), Settings::default());
    }

    #[test]
    fn parse_settings_rejects_wrong_types_and_invalid_json() {
        assert!(parse_settings(r#"{"rl_command":"rl"}"#).is_err());
        assert!(parse_settings("{not json").is_err());
    }

    #[test]
    fn shell_probe_spec_runs_an_interactive_login_shell() {
        let spec = shell_probe_spec(None);
        assert_eq!(spec.program, "/bin/zsh");
        assert_eq!(spec.args, strings(&["-ilc", SHELL_PROBE_SCRIPT]));
        assert_eq!(spec.timeout, Duration::from_secs(5));
        assert_eq!(
            spec.extra_env,
            vec![("DISABLE_AUTO_UPDATE".to_string(), "true".to_string())]
        );
        assert_eq!(shell_probe_spec(Some("/bin/bash")).program, "/bin/bash");
    }

    #[test]
    fn parse_shell_probe_finds_markers_among_noise() {
        let probe = parse_shell_probe(
            "Last login: Fri Oct 17\n\u{1b}[1m%\n__CIRCUS_PATH__/a:/b__CIRCUS_END__\n__CIRCUS_RL__/u/.local/bin/rl__CIRCUS_END__\n",
        );
        assert_eq!(probe.path.as_deref(), Some("/a:/b"));
        assert_eq!(probe.rl.as_deref(), Some("/u/.local/bin/rl"));
        let alias = parse_shell_probe("__CIRCUS_RL__alias rl='uv run rl'__CIRCUS_END__\n");
        assert_eq!(alias.rl, None);
    }

    #[test]
    fn shell_probe_script_prints_parsable_markers() {
        let output = std::process::Command::new("/bin/sh")
            .args(["-c", SHELL_PROBE_SCRIPT])
            .env("PATH", "/usr/bin:/bin")
            .output()
            .expect("sh runs");
        let probe = parse_shell_probe(&String::from_utf8_lossy(&output.stdout));
        assert_eq!(probe.path.as_deref(), Some("/usr/bin:/bin"));
    }

    #[test]
    fn resolve_rl_follows_the_documented_order() {
        let default = Settings::default();
        assert_eq!(
            resolve_rl(Some("'/w/.venv/bin/rl'"), &default, Some("/u/rl"), None),
            (strings(&["/w/.venv/bin/rl"]), RlSource::Env)
        );
        let configured = Settings {
            rl_command: Some(strings(&["/opt/rl"])),
            terminal_command: None,
        };
        assert_eq!(
            resolve_rl(None, &configured, Some("/u/rl"), None),
            (strings(&["/opt/rl"]), RlSource::Settings)
        );
        assert_eq!(
            resolve_rl(None, &default, Some("/u/rl"), Some("/h/rl")),
            (strings(&["/u/rl"]), RlSource::LoginShell)
        );
        assert_eq!(
            resolve_rl(None, &default, None, Some("/h/rl")),
            (strings(&["/h/rl"]), RlSource::Fallback)
        );
        assert_eq!(
            resolve_rl(None, &default, None, None),
            (strings(&["rl"]), RlSource::Missing)
        );
        assert_eq!(
            resolve_rl(Some("'unterminated"), &default, None, Some("/h/rl")),
            (strings(&["/h/rl"]), RlSource::Fallback)
        );
    }

    #[test]
    fn resolve_skips_the_probe_when_circus_rl_is_set() {
        let runner = FakeRunner::new(Err(RunError::Timeout));
        let resolved = resolve(&runner, &env(Some("/w/rl")), &Settings::default(), &|_| {
            false
        });
        assert!(runner.specs.lock().expect("specs").is_empty());
        assert_eq!(resolved.probe, ShellProbeState::Skipped);
        assert_eq!(resolved.command, strings(&["/w/rl"]));
        assert_eq!(resolved.source, RlSource::Env);
        assert_eq!(resolved.path_env.as_deref(), Some("/usr/bin:/bin"));
    }

    #[test]
    fn unsplittable_circus_rl_in_a_labelled_environment_is_missing() {
        let runner = FakeRunner::new(Err(RunError::Timeout));
        let mut labelled = env(Some("'unterminated"));
        labelled.env_label = Some("sandbox".to_string());
        let settings = Settings {
            rl_command: Some(strings(&["/opt/rl"])),
            terminal_command: None,
        };
        let resolved = resolve(&runner, &labelled, &settings, &|_| true);
        assert_eq!(resolved.source, RlSource::Missing);
        assert_eq!(resolved.command, strings(&[UNRESOLVED_SANDBOX_RL]));
        assert!(runner.specs.lock().expect("specs").is_empty());

        let unlabelled = resolve(&runner, &env(Some("'unterminated")), &settings, &|_| true);
        assert_eq!(unlabelled.source, RlSource::Settings);
    }

    #[test]
    fn resolve_reports_a_timed_out_probe() {
        let runner = FakeRunner::new(Err(RunError::Timeout));
        let resolved = resolve(&runner, &env(None), &Settings::default(), &|_| false);
        assert_eq!(resolved.probe, ShellProbeState::TimedOut);
        assert_eq!(resolved.source, RlSource::Missing);
        let message = not_found_message(&resolved, "/cfg/settings.json");
        assert!(message.contains("5 s"));
        assert!(message.contains("CIRCUS_RL"));
        assert!(message.contains("/cfg/settings.json"));
        assert!(message.contains("rl_command"));
    }

    #[test]
    fn resolve_uses_the_login_shell_answer() {
        let stdout = b"__CIRCUS_PATH__/usr/bin:/u/.local/bin__CIRCUS_END__\n__CIRCUS_RL__/u/.local/bin/rl__CIRCUS_END__\n";
        let runner = FakeRunner::new(Ok(ProcessOutput {
            exit_code: Some(0),
            stdout: stdout.to_vec(),
            stderr: String::new(),
        }));
        let resolved = resolve(&runner, &env(None), &Settings::default(), &|path| {
            path == Path::new("/u/.local/bin/rl")
        });
        assert_eq!(resolved.probe, ShellProbeState::Ok);
        assert_eq!(resolved.source, RlSource::LoginShell);
        assert_eq!(resolved.command, strings(&["/u/.local/bin/rl"]));
        assert_eq!(
            resolved.path_env.as_deref(),
            Some("/usr/bin:/bin:/u/.local/bin")
        );
        let specs = runner.specs.lock().expect("specs");
        assert_eq!(specs[0].program, "/bin/zsh");
    }

    #[test]
    fn resolve_reports_a_failed_probe() {
        let runner = FakeRunner::new(Ok(ProcessOutput {
            exit_code: Some(1),
            stdout: Vec::new(),
            stderr: String::new(),
        }));
        let resolved = resolve(&runner, &env(None), &Settings::default(), &|_| false);
        assert_eq!(resolved.probe, ShellProbeState::Failed);
    }

    #[test]
    fn fallback_rl_returns_the_first_executable_dir() {
        let found = fallback_rl(Path::new("/h"), &|path| {
            path == Path::new("/opt/homebrew/bin/rl") || path == Path::new("/usr/local/bin/rl")
        });
        assert_eq!(found.as_deref(), Some("/opt/homebrew/bin/rl"));
        let home = fallback_rl(Path::new("/h"), &|_| true);
        assert_eq!(home.as_deref(), Some("/h/.local/bin/rl"));
        assert_eq!(fallback_rl(Path::new("/h"), &|_| false), None);
    }

    #[test]
    fn merge_path_keeps_current_entries_first() {
        assert_eq!(
            merge_path(Some("/w/bin:/usr/bin"), Some("/usr/bin:/u/.local/bin")).as_deref(),
            Some("/w/bin:/usr/bin:/u/.local/bin")
        );
        assert_eq!(merge_path(None, Some("/a")).as_deref(), Some("/a"));
        assert_eq!(merge_path(None, None), None);
    }

    #[test]
    fn pending_wait_returns_the_value_set_on_another_thread() {
        let pending = Arc::new(Pending::new());
        let waiter = {
            let pending = Arc::clone(&pending);
            std::thread::spawn(move || pending.wait())
        };
        std::thread::sleep(Duration::from_millis(20));
        pending.set(7_u32);
        assert_eq!(waiter.join().expect("join"), 7);
        assert_eq!(pending.wait(), 7);
    }
}
