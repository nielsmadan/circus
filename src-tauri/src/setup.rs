use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::config::{self, Resolved};
use crate::contract::{InstallState, RlSource, SetupPrefs, SetupStatus};
use crate::error::{CircusError, ErrorKind};
use crate::process::{self, OnDeadline, ProcessOutput, ProcessRunner, ProcessSpec, RunError};
use crate::{cache, rl};

const SETUP_FILE: &str = "setup.json";
const MANIFEST_JSON: &str = include_str!("../../ringleader.json");
const VERSION_TIMEOUT: Duration = Duration::from_secs(15);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(300);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(600);
const STEP_TIMEOUT: Duration = Duration::from_secs(180);
const CURL: &str = "/usr/bin/curl";
const SHASUM: &str = "/usr/bin/shasum";
const SH: &str = "/bin/sh";
const UV_INSTALLER_FILE: &str = "uv-installer.sh";
const UV_DIRS: [&str; 4] = [
    "~/.local/bin",
    "~/.cargo/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
];
const PRESENCE: &str = "turn on running-session detection";

#[derive(Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct Manifest {
    pub repository: String,
    pub minimum: String,
    pub latest: String,
    pub wheel: String,
    pub sha256: String,
    pub uv_version: String,
    pub uv_installer_sha256: String,
}

pub fn manifest() -> &'static Manifest {
    static MANIFEST: OnceLock<Manifest> = OnceLock::new();
    MANIFEST.get_or_init(|| serde_json::from_str(MANIFEST_JSON).expect("ringleader.json is valid"))
}

pub type Version = (u64, u64, u64);

pub fn parse_version(text: &str) -> Option<Version> {
    let word = text.split_whitespace().last()?;
    let core = word.split(['+', '-']).next()?;
    let mut parts = core.split('.').map(|part| part.parse::<u64>().ok());
    let version = (parts.next()??, parts.next()??, parts.next()??);
    parts.next().is_none().then_some(version)
}

fn classify(installed: Option<Version>, minimum: Version, latest: Version) -> InstallState {
    match installed {
        None => InstallState::Missing,
        Some(version) if version < minimum => InstallState::TooOld,
        Some(version) if version < latest => InstallState::Outdated,
        Some(_) => InstallState::Current,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallPolicy {
    Allowed,
    Sandboxed,
}

impl InstallPolicy {
    pub fn for_environment(environment_label: Option<&str>) -> Self {
        match environment_label {
            Some(_) => Self::Sandboxed,
            None => Self::Allowed,
        }
    }

    pub fn check(self) -> Result<(), CircusError> {
        match self {
            Self::Allowed => Ok(()),
            Self::Sandboxed => Err(CircusError::new(
                ErrorKind::Failed,
                "Installing is turned off in the sandbox",
            )),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Uv(PathBuf);

#[derive(Debug, Clone)]
pub struct SetupContext {
    pub home: PathBuf,
    pub download_dir: Option<PathBuf>,
    pub setup_file: Option<PathBuf>,
    pub settings_path: String,
    pub policy: InstallPolicy,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq, Eq)]
struct SetupFile {
    #[serde(flatten)]
    prefs: SetupPrefs,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    rl_command: Option<Vec<String>>,
}

pub fn setup_path(preferences: Option<&Path>) -> Option<PathBuf> {
    preferences
        .and_then(Path::parent)
        .map(|dir| dir.join(SETUP_FILE))
}

fn parse_file(text: &str) -> Result<SetupFile, String> {
    serde_json::from_str(text).map_err(|error| format!("invalid setup preferences: {error}"))
}

fn load_file(path: &Path) -> SetupFile {
    config::read_or_default(path, parse_file)
}

fn save_file(path: &Path, file: &SetupFile) -> std::io::Result<()> {
    let mut text = serde_json::to_string_pretty(file).expect("setup file serializes");
    text.push('\n');
    cache::write_atomic(path, text.as_bytes())
}

pub fn load_prefs(path: &Path) -> SetupPrefs {
    load_file(path).prefs
}

pub fn save_prefs(path: &Path, prefs: SetupPrefs) -> std::io::Result<()> {
    save_file(
        path,
        &SetupFile {
            prefs,
            ..load_file(path)
        },
    )
}

pub fn installed_command(path: &Path) -> Option<Vec<String>> {
    load_file(path)
        .rl_command
        .filter(|command| !command.is_empty())
}

fn remember_installed(path: &Path, command: Vec<String>) -> std::io::Result<()> {
    save_file(
        path,
        &SetupFile {
            rl_command: Some(command),
            ..load_file(path)
        },
    )
}

fn tool_spec(
    program: &str,
    args: &[&str],
    path_env: Option<&str>,
    timeout: Duration,
) -> ProcessSpec {
    ProcessSpec {
        program: program.to_string(),
        args: args.iter().map(|arg| (*arg).to_string()).collect(),
        path_env: path_env.map(str::to_string),
        extra_env: Vec::new(),
        timeout,
        on_deadline: OnDeadline::Terminate,
    }
}

fn rl_spec(
    resolved: &Resolved,
    args: &[&str],
    timeout: Duration,
    not_found: &str,
) -> Result<ProcessSpec, CircusError> {
    rl::command_spec(
        &resolved.command,
        resolved.path_env.as_deref(),
        args.iter().map(|arg| (*arg).to_string()).collect(),
        timeout,
    )
    .ok_or_else(|| CircusError::new(ErrorKind::RlNotFound, not_found))
}

fn succeeded(output: &ProcessOutput) -> bool {
    output.exit_code == Some(0)
}

fn run_failure(what: &str, error: RunError, not_found: &str) -> CircusError {
    let mapped = rl::map_run_error(error, not_found);
    CircusError {
        message: format!("Could not {what}: {}", mapped.message),
        ..mapped
    }
}

fn step_failure(what: &str, output: &ProcessOutput) -> CircusError {
    CircusError {
        kind: ErrorKind::Failed,
        message: format!("Could not {what}"),
        exit_code: output.exit_code,
        stderr_tail: rl::non_empty_tail(&output.stderr),
    }
}

fn run_step<R: ProcessRunner>(
    runner: &R,
    spec: &ProcessSpec,
    what: &str,
    not_found: &str,
) -> Result<ProcessOutput, CircusError> {
    let output = runner
        .run(spec)
        .map_err(|error| run_failure(what, error, not_found))?;
    if succeeded(&output) {
        Ok(output)
    } else {
        Err(step_failure(what, &output))
    }
}

fn run_tool<R: ProcessRunner>(
    runner: &R,
    spec: &ProcessSpec,
    what: &str,
) -> Result<ProcessOutput, CircusError> {
    run_step(
        runner,
        spec,
        what,
        &format!("{} was not found", spec.program),
    )
}

pub fn installed_version<R: ProcessRunner>(runner: &R, resolved: &Resolved) -> Option<Version> {
    if resolved.source == RlSource::Missing {
        return None;
    }
    let spec = rl::command_spec(
        &resolved.command,
        resolved.path_env.as_deref(),
        vec!["--version".to_string()],
        VERSION_TIMEOUT,
    )?;
    let output = runner.run(&spec).ok()?;
    succeeded(&output)
        .then(|| parse_version(&String::from_utf8_lossy(&output.stdout)))
        .flatten()
}

pub fn find_uv(
    path_env: Option<&str>,
    home: &Path,
    is_executable: &dyn Fn(&Path) -> bool,
) -> Option<Uv> {
    process::find_on_path("uv", path_env, is_executable)
        .or_else(|| config::find_in_dirs(&UV_DIRS, home, "uv", is_executable))
        .map(Uv)
}

pub fn status(
    installed: Option<Version>,
    uv: Option<&Uv>,
    policy: InstallPolicy,
    manifest: &Manifest,
) -> SetupStatus {
    let minimum = parse_version(&manifest.minimum).expect("manifest minimum");
    let latest = parse_version(&manifest.latest).expect("manifest latest");
    SetupStatus {
        state: classify(installed, minimum, latest),
        installed: installed.map(|(major, minor, patch)| format!("{major}.{minor}.{patch}")),
        minimum: manifest.minimum.clone(),
        latest: manifest.latest.clone(),
        uv_available: uv.is_some(),
        can_install: policy == InstallPolicy::Allowed,
    }
}

pub fn current_status<R: ProcessRunner>(
    runner: &R,
    context: &SetupContext,
    resolved: &Resolved,
    is_executable: &dyn Fn(&Path) -> bool,
    manifest: &Manifest,
) -> SetupStatus {
    let uv = find_uv(resolved.path_env.as_deref(), &context.home, is_executable);
    status(
        installed_version(runner, resolved),
        uv.as_ref(),
        context.policy,
        manifest,
    )
}

fn wheel_url(manifest: &Manifest) -> String {
    format!(
        "https://github.com/{}/releases/download/v{}/{}",
        manifest.repository, manifest.latest, manifest.wheel
    )
}

fn uv_installer_url(manifest: &Manifest) -> String {
    format!("https://astral.sh/uv/{}/install.sh", manifest.uv_version)
}

fn pinned_hash<'a>(hash: &'a str, what: &str) -> Result<&'a str, CircusError> {
    if hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(hash)
    } else {
        Err(CircusError::new(
            ErrorKind::Failed,
            format!("This build of Circus has no pinned {what} to install"),
        ))
    }
}

fn prepared_download_dir(context: &SetupContext) -> Result<&Path, CircusError> {
    let dir = context
        .download_dir
        .as_deref()
        .ok_or_else(|| CircusError::new(ErrorKind::Failed, "No folder to download into"))?;
    std::fs::create_dir_all(dir).map_err(|error| {
        CircusError::new(
            ErrorKind::Failed,
            format!("Could not create {}: {error}", dir.display()),
        )
    })?;
    Ok(dir)
}

struct Download<'a> {
    what: &'a str,
    url: &'a str,
    file: &'a Path,
    sha256: &'a str,
}

fn download_verified<R: ProcessRunner>(
    runner: &R,
    download: &Download<'_>,
    path_env: Option<&str>,
) -> Result<(), CircusError> {
    let file = download.file.to_string_lossy();
    run_tool(
        runner,
        &tool_spec(
            CURL,
            &["-fsSL", "--proto", "=https", "-o", &file, download.url],
            path_env,
            DOWNLOAD_TIMEOUT,
        ),
        &format!("download {}", download.what),
    )?;
    let sum = run_tool(
        runner,
        &tool_spec(SHASUM, &["-a", "256", &file], path_env, VERSION_TIMEOUT),
        "check the download",
    )?;
    let actual = String::from_utf8_lossy(&sum.stdout);
    match actual.split_whitespace().next() {
        Some(hash) if hash.eq_ignore_ascii_case(download.sha256) => Ok(()),
        _ => Err(CircusError::new(
            ErrorKind::Failed,
            format!(
                "The downloaded {} does not match the pinned release",
                download.what
            ),
        )),
    }
}

fn install_wheel<R: ProcessRunner>(
    runner: &R,
    uv: &Uv,
    download_dir: &Path,
    path_env: Option<&str>,
    manifest: &Manifest,
) -> Result<PathBuf, CircusError> {
    let wheel = download_dir.join(&manifest.wheel);
    download_verified(
        runner,
        &Download {
            what: "ringleader",
            url: &wheel_url(manifest),
            file: &wheel,
            sha256: pinned_hash(&manifest.sha256, "ringleader release")?,
        },
        path_env,
    )?;
    let wheel_text = wheel.to_string_lossy();
    let uv_text = uv.0.to_string_lossy();
    run_tool(
        runner,
        &tool_spec(
            &uv_text,
            &["tool", "install", "--force", &wheel_text],
            path_env,
            INSTALL_TIMEOUT,
        ),
        "install ringleader",
    )?;
    let bin = run_tool(
        runner,
        &tool_spec(
            &uv_text,
            &["tool", "dir", "--bin"],
            path_env,
            VERSION_TIMEOUT,
        ),
        "find the installed ringleader",
    )?;
    Ok(Path::new(String::from_utf8_lossy(&bin.stdout).trim()).join("rl"))
}

pub fn install_ringleader<R: ProcessRunner>(
    runner: &R,
    context: &SetupContext,
    previous: &Resolved,
    manifest: &Manifest,
    is_executable: &dyn Fn(&Path) -> bool,
) -> Result<Resolved, CircusError> {
    context.policy.check()?;
    pinned_hash(&manifest.sha256, "ringleader release")?;
    let path_env = previous.path_env.as_deref();
    let uv = find_uv(path_env, &context.home, is_executable)
        .ok_or_else(|| CircusError::new(ErrorKind::Failed, "uv is not installed"))?;
    let dir = prepared_download_dir(context)?;
    let rl_path = install_wheel(runner, &uv, dir, path_env, manifest)?;
    let command = vec![rl_path.to_string_lossy().into_owned()];
    if let Some(path) = context.setup_file.as_deref()
        && let Err(error) = remember_installed(path, command.clone())
    {
        eprintln!(
            "circus: could not record the installed command in {}: {error}",
            path.display()
        );
    }
    Ok(after_install(previous, command))
}

pub fn install_uv<R: ProcessRunner>(
    runner: &R,
    context: &SetupContext,
    path_env: Option<&str>,
    manifest: &Manifest,
    is_executable: &dyn Fn(&Path) -> bool,
) -> Result<Uv, CircusError> {
    context.policy.check()?;
    let sha256 = pinned_hash(&manifest.uv_installer_sha256, "uv installer")?;
    let installer = prepared_download_dir(context)?.join(UV_INSTALLER_FILE);
    download_verified(
        runner,
        &Download {
            what: "uv",
            url: &uv_installer_url(manifest),
            file: &installer,
            sha256,
        },
        path_env,
    )?;
    let spec = ProcessSpec {
        extra_env: vec![("UV_NO_MODIFY_PATH".to_string(), "1".to_string())],
        ..tool_spec(
            SH,
            &[&installer.to_string_lossy()],
            path_env,
            DOWNLOAD_TIMEOUT,
        )
    };
    run_tool(runner, &spec, "install uv")?;
    find_uv(path_env, &context.home, is_executable).ok_or_else(|| {
        CircusError::new(
            ErrorKind::Failed,
            "uv was installed but Circus can't find it",
        )
    })
}

#[derive(Deserialize)]
struct PresenceHook {
    agent: String,
    ok: bool,
    #[serde(default)]
    detail: Option<String>,
}

#[derive(Deserialize)]
struct PresenceInstalled {
    ok: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    hooks: Vec<PresenceHook>,
}

fn presence_reason(answer: &PresenceInstalled) -> Option<String> {
    let failed_hooks: Vec<String> = answer
        .hooks
        .iter()
        .filter(|hook| !hook.ok)
        .map(
            |hook| match hook.detail.as_deref().filter(|d| !d.is_empty()) {
                Some(detail) => format!("{}: {detail}", hook.agent),
                None => format!("{}: failed", hook.agent),
            },
        )
        .collect();
    answer
        .error
        .clone()
        .filter(|error| !error.is_empty())
        .or_else(|| (!failed_hooks.is_empty()).then(|| failed_hooks.join("\n")))
}

pub fn install_presence<R: ProcessRunner>(
    runner: &R,
    context: &SetupContext,
    resolved: &Resolved,
) -> Result<(), CircusError> {
    context.policy.check()?;
    let not_found = config::not_found_message(resolved, &context.settings_path);
    let spec = rl_spec(
        resolved,
        &["data", "presence", "install", "--yes", "--json"],
        STEP_TIMEOUT,
        &not_found,
    )?;
    let output = runner
        .run(&spec)
        .map_err(|error| run_failure(PRESENCE, error, &not_found))?;
    match serde_json::from_slice::<PresenceInstalled>(&output.stdout) {
        Ok(answer) if answer.ok && succeeded(&output) => Ok(()),
        Ok(answer) => Err(CircusError {
            stderr_tail: presence_reason(&answer).or_else(|| rl::non_empty_tail(&output.stderr)),
            ..step_failure(PRESENCE, &output)
        }),
        Err(_) if !succeeded(&output) => Err(step_failure(PRESENCE, &output)),
        Err(parse) => Err(CircusError {
            kind: ErrorKind::BadOutput,
            message: format!("Could not {PRESENCE}: the answer was unreadable"),
            exit_code: output.exit_code,
            stderr_tail: Some(parse.to_string()),
        }),
    }
}

pub fn install_agent_extras<R: ProcessRunner>(
    runner: &R,
    context: &SetupContext,
    resolved: &Resolved,
) -> Result<(), CircusError> {
    context.policy.check()?;
    let not_found = config::not_found_message(resolved, &context.settings_path);
    for (args, what) in [
        (["install", "skills", "--yes"], "install the agent skills"),
        (
            ["install", "hooks", "--yes"],
            "install the session-end hook",
        ),
    ] {
        let spec = rl_spec(resolved, &args, STEP_TIMEOUT, &not_found)?;
        run_step(runner, &spec, what, &not_found)?;
    }
    Ok(())
}

fn after_install(previous: &Resolved, command: Vec<String>) -> Resolved {
    match previous.source {
        RlSource::Env | RlSource::Settings => previous.clone(),
        _ => Resolved {
            command,
            source: RlSource::Installed,
            path_env: previous.path_env.clone(),
            probe: previous.probe,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::ShellProbeState;
    use std::sync::Mutex;

    struct FakeRunner {
        results: Mutex<Vec<Result<ProcessOutput, RunError>>>,
        specs: Mutex<Vec<ProcessSpec>>,
    }

    impl FakeRunner {
        fn new(outputs: Vec<ProcessOutput>) -> Self {
            Self::with_results(outputs.into_iter().map(Ok).collect())
        }

        fn with_results(results: Vec<Result<ProcessOutput, RunError>>) -> Self {
            Self {
                results: Mutex::new(results.into_iter().rev().collect()),
                specs: Mutex::new(Vec::new()),
            }
        }

        fn specs(&self) -> Vec<ProcessSpec> {
            self.specs.lock().expect("specs").clone()
        }

        fn argvs(&self) -> Vec<Vec<String>> {
            self.specs()
                .into_iter()
                .map(|spec| std::iter::once(spec.program).chain(spec.args).collect())
                .collect()
        }
    }

    impl ProcessRunner for FakeRunner {
        fn run(&self, spec: &ProcessSpec) -> Result<ProcessOutput, RunError> {
            self.specs.lock().expect("specs").push(spec.clone());
            self.results
                .lock()
                .expect("results")
                .pop()
                .unwrap_or(Err(RunError::NotFound))
        }
    }

    fn ok(stdout: &str) -> ProcessOutput {
        exited(0, stdout, "")
    }

    fn exited(code: i32, stdout: &str, stderr: &str) -> ProcessOutput {
        ProcessOutput {
            exit_code: Some(code),
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.to_string(),
        }
    }

    fn pinned(hash: &str) -> Manifest {
        Manifest {
            repository: "o/ringleader".to_string(),
            minimum: "0.2.0".to_string(),
            latest: "0.3.1".to_string(),
            wheel: "ringleader-0.3.1-py3-none-any.whl".to_string(),
            sha256: hash.to_string(),
            uv_version: "0.13.7".to_string(),
            uv_installer_sha256: UV_HASH.to_string(),
        }
    }

    fn resolved(source: RlSource) -> Resolved {
        Resolved {
            command: vec!["/u/bin/rl".to_string()],
            source,
            path_env: Some("/usr/bin".to_string()),
            probe: ShellProbeState::Ok,
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        std::env::temp_dir().join(format!(
            "circus-setup-{name}-{}-{nanos}",
            std::process::id()
        ))
    }

    fn context(root: &Path, policy: InstallPolicy) -> SetupContext {
        SetupContext {
            home: PathBuf::from("/h"),
            download_dir: Some(root.join("cache")),
            setup_file: Some(root.join("config").join(SETUP_FILE)),
            settings_path: "/cfg/settings.json".to_string(),
            policy,
        }
    }

    fn only(wanted: &'static str) -> impl Fn(&Path) -> bool {
        move |path: &Path| path == Path::new(wanted)
    }

    const HASH: &str = "ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12";
    const UV_HASH: &str = "cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34";

    #[test]
    fn the_bundled_manifest_parses_and_names_a_release_at_least_its_minimum() {
        let manifest = manifest();
        let minimum = parse_version(&manifest.minimum).expect("minimum");
        let latest = parse_version(&manifest.latest).expect("latest");
        assert!(minimum <= latest);
        assert!(manifest.wheel.contains(&manifest.latest));
        assert!(pinned_hash(&manifest.uv_installer_sha256, "uv installer").is_ok());
        assert!(parse_version(&manifest.uv_version).is_some());
    }

    #[test]
    fn parse_version_reads_the_last_word_and_ignores_build_suffixes() {
        assert_eq!(parse_version("rl 0.2.0\n"), Some((0, 2, 0)));
        assert_eq!(parse_version("1.10.3+dev"), Some((1, 10, 3)));
        assert_eq!(parse_version("rl 0.2"), None);
        assert_eq!(parse_version("rl 0.2.0.1"), None);
        assert_eq!(parse_version(""), None);
    }

    #[test]
    fn classify_orders_missing_too_old_outdated_and_current() {
        let (minimum, latest) = ((0, 2, 0), (0, 3, 1));
        assert_eq!(classify(None, minimum, latest), InstallState::Missing);
        assert_eq!(
            classify(Some((0, 1, 9)), minimum, latest),
            InstallState::TooOld
        );
        assert_eq!(
            classify(Some((0, 2, 0)), minimum, latest),
            InstallState::Outdated
        );
        assert_eq!(
            classify(Some((0, 3, 1)), minimum, latest),
            InstallState::Current
        );
        assert_eq!(
            classify(Some((1, 0, 0)), minimum, latest),
            InstallState::Current
        );
    }

    #[test]
    fn the_sandbox_rule_decides_both_can_install_and_the_refusal() {
        let sandboxed = InstallPolicy::for_environment(Some("SANDBOX"));
        assert_eq!(sandboxed, InstallPolicy::Sandboxed);
        assert!(!status(None, None, sandboxed, &pinned(HASH)).can_install);
        assert_eq!(
            sandboxed.check().expect_err("refused").message,
            "Installing is turned off in the sandbox"
        );
        let allowed = InstallPolicy::for_environment(None);
        assert_eq!(allowed, InstallPolicy::Allowed);
        assert!(status(None, None, allowed, &pinned(HASH)).can_install);
        assert_eq!(allowed.check(), Ok(()));
    }

    #[test]
    fn status_reports_the_found_uv_and_the_installed_version() {
        let uv = Uv(PathBuf::from("/h/.local/bin/uv"));
        let shown = status(
            Some((0, 2, 0)),
            Some(&uv),
            InstallPolicy::Allowed,
            &pinned(HASH),
        );
        assert!(shown.uv_available);
        assert_eq!(shown.installed.as_deref(), Some("0.2.0"));
        assert_eq!(shown.state, InstallState::Outdated);
    }

    #[test]
    fn installed_version_runs_the_resolved_command_with_version() {
        let runner = FakeRunner::new(vec![ok("rl 0.2.0\n")]);
        assert_eq!(
            installed_version(&runner, &resolved(RlSource::Fallback)),
            Some((0, 2, 0))
        );
        assert_eq!(runner.argvs(), vec![vec!["/u/bin/rl", "--version"]]);
    }

    #[test]
    fn an_rl_without_version_or_a_missing_one_has_no_version() {
        let usage = exited(2, "", "unrecognized arguments: --version");
        assert_eq!(
            installed_version(&FakeRunner::new(vec![usage]), &resolved(RlSource::Fallback)),
            None
        );
        let runner = FakeRunner::new(vec![]);
        assert_eq!(
            installed_version(&runner, &resolved(RlSource::Missing)),
            None
        );
        assert!(runner.argvs().is_empty());
    }

    #[test]
    fn find_uv_prefers_path_then_known_directories() {
        let home = Path::new("/h");
        assert_eq!(
            find_uv(Some("/a:/b"), home, &only("/b/uv")),
            Some(Uv(PathBuf::from("/b/uv")))
        );
        assert_eq!(
            find_uv(Some("/a"), home, &only("/h/.local/bin/uv")),
            Some(Uv(PathBuf::from("/h/.local/bin/uv")))
        );
        assert_eq!(
            find_uv(None, home, &only("/h/.cargo/bin/uv")),
            Some(Uv(PathBuf::from("/h/.cargo/bin/uv")))
        );
        assert_eq!(
            find_uv(None, home, &only("/opt/homebrew/bin/uv")),
            Some(Uv(PathBuf::from("/opt/homebrew/bin/uv")))
        );
        assert_eq!(find_uv(None, home, &|_| false), None);
    }

    #[test]
    fn install_ringleader_downloads_verifies_installs_and_records_the_rl_path() {
        let root = temp_dir("install");
        let context = context(&root, InstallPolicy::Allowed);
        let runner = FakeRunner::new(vec![
            ok(""),
            ok(&format!("{HASH}  /c/ringleader-0.3.1-py3-none-any.whl\n")),
            ok("Installed 1 executable: rl\n"),
            ok("/h/.local/bin\n"),
        ]);
        let next = install_ringleader(
            &runner,
            &context,
            &resolved(RlSource::LoginShell),
            &pinned(HASH),
            &only("/h/.local/bin/uv"),
        )
        .expect("install");
        let setup_file = context.setup_file.clone().expect("setup file");
        let recorded = installed_command(&setup_file);
        let _ = std::fs::remove_dir_all(&root);
        assert_eq!(next.command, vec!["/h/.local/bin/rl".to_string()]);
        assert_eq!(next.source, RlSource::Installed);
        assert_eq!(recorded, Some(vec!["/h/.local/bin/rl".to_string()]));
        let wheel = root.join("cache").join("ringleader-0.3.1-py3-none-any.whl");
        let wheel = wheel.to_str().expect("utf-8");
        assert_eq!(
            runner.argvs(),
            vec![
                vec![
                    CURL,
                    "-fsSL",
                    "--proto",
                    "=https",
                    "-o",
                    wheel,
                    "https://github.com/o/ringleader/releases/download/v0.3.1/ringleader-0.3.1-py3-none-any.whl"
                ],
                vec![SHASUM, "-a", "256", wheel],
                vec!["/h/.local/bin/uv", "tool", "install", "--force", wheel],
                vec!["/h/.local/bin/uv", "tool", "dir", "--bin"],
            ]
        );
    }

    #[test]
    fn install_ringleader_refuses_in_the_sandbox_and_runs_nothing() {
        let root = temp_dir("sandboxed");
        let runner = FakeRunner::new(vec![]);
        let error = install_ringleader(
            &runner,
            &context(&root, InstallPolicy::Sandboxed),
            &resolved(RlSource::Env),
            &pinned(HASH),
            &|_| true,
        )
        .expect_err("sandboxed");
        assert_eq!(error.message, "Installing is turned off in the sandbox");
        assert!(runner.argvs().is_empty());
        assert!(!root.exists());
    }

    #[test]
    fn install_ringleader_without_uv_runs_nothing() {
        let root = temp_dir("no-uv");
        let runner = FakeRunner::new(vec![]);
        let error = install_ringleader(
            &runner,
            &context(&root, InstallPolicy::Allowed),
            &resolved(RlSource::Missing),
            &pinned(HASH),
            &|_| false,
        )
        .expect_err("no uv");
        assert_eq!(error.message, "uv is not installed");
        assert!(runner.argvs().is_empty());
    }

    fn install_with(runner: &FakeRunner, root: &Path, hash: &str) -> Result<Resolved, CircusError> {
        let result = install_ringleader(
            runner,
            &context(root, InstallPolicy::Allowed),
            &resolved(RlSource::Missing),
            &pinned(hash),
            &only("/usr/bin/uv"),
        );
        let _ = std::fs::remove_dir_all(root);
        result
    }

    #[test]
    fn install_ringleader_refuses_a_download_that_does_not_match_the_pin() {
        let other = "ef56".repeat(16);
        let runner = FakeRunner::new(vec![ok(""), ok(&format!("{other}  /c/w.whl\n"))]);
        let error = install_with(&runner, &temp_dir("mismatch"), HASH).expect_err("mismatch");
        assert_eq!(
            error.message,
            "The downloaded ringleader does not match the pinned release"
        );
        assert_eq!(runner.argvs().len(), 2);
    }

    #[test]
    fn install_ringleader_refuses_without_a_pinned_hash_and_runs_nothing() {
        let runner = FakeRunner::new(vec![]);
        let error = install_with(&runner, &temp_dir("unpinned"), "").expect_err("unpinned");
        assert_eq!(
            error.message,
            "This build of Circus has no pinned ringleader release to install"
        );
        assert!(runner.argvs().is_empty());
    }

    #[test]
    fn a_failed_step_names_the_step_and_keeps_the_stderr_tail() {
        let runner = FakeRunner::new(vec![exited(22, "", "curl: (22) 404")]);
        let error = install_with(&runner, &temp_dir("404"), HASH).expect_err("404");
        assert_eq!(error.message, "Could not download ringleader");
        assert_eq!(error.stderr_tail.as_deref(), Some("curl: (22) 404"));
        assert_eq!(error.exit_code, Some(22));
    }

    #[test]
    fn a_failed_tool_dir_step_stops_the_install() {
        let runner = FakeRunner::new(vec![
            ok(""),
            ok(&format!("{HASH}  /c/w.whl\n")),
            ok(""),
            exited(2, "", "error: unknown command"),
        ]);
        let error = install_with(&runner, &temp_dir("tool-dir"), HASH).expect_err("tool dir");
        assert_eq!(error.message, "Could not find the installed ringleader");
        assert_eq!(error.stderr_tail.as_deref(), Some("error: unknown command"));
    }

    #[test]
    fn a_spawn_failure_is_described_in_words() {
        let runner = FakeRunner::with_results(vec![Err(RunError::Timeout)]);
        let error = install_with(&runner, &temp_dir("timeout"), HASH).expect_err("timeout");
        assert_eq!(error.kind, ErrorKind::Timeout);
        assert_eq!(
            error.message,
            "Could not download ringleader: it did not finish in time"
        );
    }

    #[test]
    fn after_install_keeps_an_explicit_command_and_adopts_the_installed_one_otherwise() {
        let installed = vec!["/h/.local/bin/rl".to_string()];
        assert_eq!(
            after_install(&resolved(RlSource::Settings), installed.clone()),
            resolved(RlSource::Settings)
        );
        let adopted = after_install(&resolved(RlSource::LoginShell), installed.clone());
        assert_eq!(adopted.command, installed);
        assert_eq!(adopted.source, RlSource::Installed);
    }

    #[test]
    fn install_uv_runs_the_pinned_installer_without_touching_shell_files() {
        let root = temp_dir("uv");
        let runner = FakeRunner::new(vec![
            ok(""),
            ok(&format!("{UV_HASH}  /c/uv-installer.sh\n")),
            ok("installed\n"),
        ]);
        let uv = install_uv(
            &runner,
            &context(&root, InstallPolicy::Allowed),
            Some("/usr/bin"),
            &pinned(HASH),
            &only("/h/.local/bin/uv"),
        );
        let _ = std::fs::remove_dir_all(&root);
        assert_eq!(uv, Ok(Uv(PathBuf::from("/h/.local/bin/uv"))));
        let installer = root.join("cache").join(UV_INSTALLER_FILE);
        let installer = installer.to_str().expect("utf-8");
        assert_eq!(
            runner.argvs(),
            vec![
                vec![
                    CURL,
                    "-fsSL",
                    "--proto",
                    "=https",
                    "-o",
                    installer,
                    "https://astral.sh/uv/0.13.7/install.sh"
                ],
                vec![SHASUM, "-a", "256", installer],
                vec![SH, installer],
            ]
        );
        assert_eq!(
            runner.specs()[2].extra_env,
            vec![("UV_NO_MODIFY_PATH".to_string(), "1".to_string())]
        );
    }

    fn uv_with(runner: &FakeRunner, root: &Path, found: &str) -> Result<Uv, CircusError> {
        let found = PathBuf::from(found);
        let result = install_uv(
            runner,
            &context(root, InstallPolicy::Allowed),
            None,
            &pinned(HASH),
            &|path| path == found,
        );
        let _ = std::fs::remove_dir_all(root);
        result
    }

    #[test]
    fn a_failed_uv_download_reports_curl_and_runs_no_installer() {
        let runner = FakeRunner::new(vec![exited(6, "", "curl: (6) Could not resolve host")]);
        let error =
            uv_with(&runner, &temp_dir("uv-offline"), "/h/.local/bin/uv").expect_err("offline");
        assert_eq!(error.message, "Could not download uv");
        assert_eq!(
            error.stderr_tail.as_deref(),
            Some("curl: (6) Could not resolve host")
        );
        assert_eq!(runner.argvs().len(), 1);
    }

    #[test]
    fn a_uv_installer_that_does_not_match_the_pin_is_not_run() {
        let runner = FakeRunner::new(vec![ok(""), ok(&format!("{HASH}  /c/uv-installer.sh\n"))]);
        let error =
            uv_with(&runner, &temp_dir("uv-mismatch"), "/h/.local/bin/uv").expect_err("mismatch");
        assert_eq!(
            error.message,
            "The downloaded uv does not match the pinned release"
        );
        assert_eq!(runner.argvs().len(), 2);
    }

    #[test]
    fn a_uv_install_that_leaves_no_uv_behind_is_an_error() {
        let runner = FakeRunner::new(vec![
            ok(""),
            ok(&format!("{UV_HASH}  /c/uv-installer.sh\n")),
            ok(""),
        ]);
        let error = uv_with(&runner, &temp_dir("uv-lost"), "/elsewhere/uv").expect_err("lost");
        assert_eq!(error.message, "uv was installed but Circus can't find it");
    }

    fn presence(runner: &FakeRunner) -> Result<(), CircusError> {
        install_presence(
            runner,
            &context(&temp_dir("presence"), InstallPolicy::Allowed),
            &resolved(RlSource::Fallback),
        )
    }

    #[test]
    fn install_presence_runs_the_json_form_and_accepts_ok() {
        let runner = FakeRunner::new(vec![ok(r#"{"ok":true,"hooks":[]}"#)]);
        presence(&runner).expect("presence");
        assert_eq!(
            runner.argvs(),
            vec![vec![
                "/u/bin/rl",
                "data",
                "presence",
                "install",
                "--yes",
                "--json"
            ]]
        );
    }

    #[test]
    fn install_presence_reports_the_error_ringleader_printed_on_exit_one() {
        let runner = FakeRunner::new(vec![exited(
            1,
            r#"{"ok": false, "error": "no hooklinesinker binary for this platform"}"#,
            "",
        )]);
        let error = presence(&runner).expect_err("not ok");
        assert_eq!(error.kind, ErrorKind::Failed);
        assert_eq!(error.message, "Could not turn on running-session detection");
        assert_eq!(
            error.stderr_tail.as_deref(),
            Some("no hooklinesinker binary for this platform")
        );
        assert_eq!(error.exit_code, Some(1));
    }

    #[test]
    fn install_presence_names_each_failed_hook() {
        let runner = FakeRunner::new(vec![exited(
            1,
            r#"{"ok": false, "hooks": [{"agent": "claude-code", "ok": true, "detail": "installed"}, {"agent": "codex", "ok": false, "detail": "config is read-only"}, {"agent": "pi", "ok": false, "detail": ""}]}"#,
            "",
        )]);
        let error = presence(&runner).expect_err("hooks failed");
        assert_eq!(
            error.stderr_tail.as_deref(),
            Some("codex: config is read-only\npi: failed")
        );
    }

    #[test]
    fn install_presence_falls_back_to_stderr_without_a_reason() {
        let runner = FakeRunner::new(vec![exited(1, r#"{"ok": false}"#, "Traceback: boom")]);
        let error = presence(&runner).expect_err("not ok");
        assert_eq!(error.stderr_tail.as_deref(), Some("Traceback: boom"));
        let crashed = FakeRunner::new(vec![exited(1, "", "Traceback: crash")]);
        let error = presence(&crashed).expect_err("crash");
        assert_eq!(error.kind, ErrorKind::Failed);
        assert_eq!(error.stderr_tail.as_deref(), Some("Traceback: crash"));
    }

    #[test]
    fn install_presence_rejects_an_unreadable_answer() {
        let runner = FakeRunner::new(vec![ok("registered\n")]);
        let error = presence(&runner).expect_err("unreadable");
        assert_eq!(error.kind, ErrorKind::BadOutput);
        assert_eq!(
            error.message,
            "Could not turn on running-session detection: the answer was unreadable"
        );
    }

    #[test]
    fn a_missing_rl_reports_where_circus_looked() {
        let runner = FakeRunner::with_results(vec![Err(RunError::NotFound)]);
        let error = presence(&runner).expect_err("missing");
        assert_eq!(error.kind, ErrorKind::RlNotFound);
        assert_eq!(
            error.message,
            format!(
                "Could not turn on running-session detection: {}",
                config::not_found_message(&resolved(RlSource::Fallback), "/cfg/settings.json")
            )
        );
    }

    #[test]
    fn agent_extras_install_skills_then_hooks() {
        let runner = FakeRunner::new(vec![ok(""), ok("")]);
        install_agent_extras(
            &runner,
            &context(&temp_dir("extras"), InstallPolicy::Allowed),
            &resolved(RlSource::Fallback),
        )
        .expect("extras");
        assert_eq!(
            runner.argvs(),
            vec![
                vec!["/u/bin/rl", "install", "skills", "--yes"],
                vec!["/u/bin/rl", "install", "hooks", "--yes"],
            ]
        );
    }

    #[test]
    fn agent_extras_stop_before_the_hooks_when_the_skills_fail() {
        let runner = FakeRunner::new(vec![exited(1, "", "permission denied")]);
        let error = install_agent_extras(
            &runner,
            &context(&temp_dir("extras-fail"), InstallPolicy::Allowed),
            &resolved(RlSource::Fallback),
        )
        .expect_err("skills failed");
        assert_eq!(error.message, "Could not install the agent skills");
        assert_eq!(
            runner.argvs(),
            vec![vec!["/u/bin/rl", "install", "skills", "--yes"]]
        );
    }

    #[test]
    fn prefs_default_to_not_onboarded_with_update_prompts_on() {
        assert_eq!(
            parse_file("{}").expect("prefs").prefs,
            SetupPrefs {
                onboarded: false,
                prompt_updates: true
            }
        );
        assert_eq!(
            parse_file(r#"{"onboarded":true,"prompt_updates":false,"rl_command":["/x/rl"]}"#)
                .expect("prefs"),
            SetupFile {
                prefs: SetupPrefs {
                    onboarded: true,
                    prompt_updates: false
                },
                rl_command: Some(vec!["/x/rl".to_string()]),
            }
        );
    }

    #[test]
    fn saving_prefs_keeps_the_recorded_install() {
        let root = temp_dir("prefs");
        let path = root.join(SETUP_FILE);
        remember_installed(&path, vec!["/h/.local/bin/rl".to_string()]).expect("record");
        let prefs = SetupPrefs {
            onboarded: true,
            prompt_updates: false,
        };
        save_prefs(&path, prefs).expect("save");
        let (loaded, command) = (load_prefs(&path), installed_command(&path));
        let _ = std::fs::remove_dir_all(&root);
        assert_eq!(loaded, prefs);
        assert_eq!(command, Some(vec!["/h/.local/bin/rl".to_string()]));
    }

    #[test]
    fn setup_preferences_live_next_to_the_preferences_file() {
        assert_eq!(
            setup_path(Some(Path::new("/w/.circus/preferences.json"))),
            Some(PathBuf::from("/w/.circus/setup.json"))
        );
        assert_eq!(setup_path(None), None);
    }
}
