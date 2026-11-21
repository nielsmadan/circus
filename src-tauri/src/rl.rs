use std::collections::HashSet;
use std::time::Duration;

use crate::contract::{DecideRequest, DecisionAction, Envelope, HandoffRequest, TailsRequest};
use crate::error::{CircusError, ErrorKind};
use crate::process::{OnDeadline, ProcessOutput, ProcessRunner, ProcessSpec, RunError};

pub const LIST_TIMEOUT: Duration = Duration::from_secs(60);
pub const SCAN_TIMEOUT: Duration = Duration::from_secs(300);
pub const TAILS_TIMEOUT: Duration = Duration::from_secs(30);
pub const DECIDE_TIMEOUT: Duration = Duration::from_secs(120);
pub const HARVEST_TIMEOUT: Duration = Duration::from_secs(420);
pub const HANDOFF_TIMEOUT: Duration = Duration::from_secs(30);
pub const TAIL_MAX_IDS: usize = 16;
const TAIL_MIN_CHARS: u32 = 1_000;
const TAIL_MAX_CHARS: u32 = 2_000_000;
const SESSION_ID_MAX_CHARS: usize = 1_000;
const TIME_MAX_CHARS: usize = 64;
const FINGERPRINT_MAX_CHARS: usize = 256;
const PROJECT_KEY_MAX_CHARS: usize = 4_096;
const AGENT_MAX_CHARS: usize = 32;
pub(crate) const STDERR_TAIL_CHARS: usize = 2_000;
const CONTRACT_VERSION: u64 = 1;
const EMPTY_TAILS: &[u8] = br#"{"version":1,"kind":"tails","items":[]}"#;
const RL_TOO_OLD: &str = "The installed ringleader is too old for Circus";
const CONTRACT_COMMANDS: &[&str] = &[
    "inbox", "data", "export", "session", "archive", "delete", "harvest", "snooze", "keep",
    "unkeep", "wake", "mark", "reviewed", "handoff", "triage",
];

pub fn valid_session_id(id: &str) -> bool {
    (1..=SESSION_ID_MAX_CHARS).contains(&id.chars().count())
        && !id.starts_with('-')
        && !id.chars().any(char::is_control)
}

fn valid_time(text: &str) -> bool {
    text.len() <= TIME_MAX_CHARS
        && text
            .chars()
            .all(|c| c.is_ascii_digit() || matches!(c, 'T' | ':' | '.' | '+' | '-' | 'Z'))
}

fn valid_fingerprint(text: &str) -> bool {
    (1..=FINGERPRINT_MAX_CHARS).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_graphic())
}

fn valid_project_key(text: &str) -> bool {
    (1..=PROJECT_KEY_MAX_CHARS).contains(&text.chars().count())
        && !text.chars().any(char::is_control)
}

fn valid_agent(text: &str) -> bool {
    (1..=AGENT_MAX_CHARS).contains(&text.len())
        && !text.starts_with('-')
        && text
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| (*s).to_string()).collect()
}

pub fn list_args() -> Vec<String> {
    strings(&["inbox", "--json"])
}

pub fn scan_args() -> Vec<String> {
    strings(&["inbox", "--json", "--scan"])
}

pub fn tails_args(req: &TailsRequest) -> Result<Option<Vec<String>>, CircusError> {
    if req.ids.is_empty() || req.ids.len() > TAIL_MAX_IDS {
        return Err(CircusError::invalid(format!(
            "tails takes 1 to {TAIL_MAX_IDS} ids, got {}",
            req.ids.len()
        )));
    }
    let distinct: HashSet<&str> = req.ids.iter().map(String::as_str).collect();
    if distinct.len() != req.ids.len() {
        return Err(CircusError::invalid("tails ids must not repeat"));
    }
    let max_chars = req.max_chars;
    if !(TAIL_MIN_CHARS..=TAIL_MAX_CHARS).contains(&max_chars) {
        return Err(CircusError::invalid(format!(
            "max_chars must be {TAIL_MIN_CHARS} to {TAIL_MAX_CHARS}, got {max_chars}"
        )));
    }
    let passable: Vec<String> = req
        .ids
        .iter()
        .filter(|id| valid_session_id(id))
        .cloned()
        .collect();
    if passable.is_empty() {
        return Ok(None);
    }
    Ok(Some(
        strings(&["data", "export"])
            .into_iter()
            .chain(passable)
            .chain(["--json".to_string(), format!("--max-chars={max_chars}")])
            .collect(),
    ))
}

pub fn decide_args(req: &DecideRequest) -> Result<Vec<String>, CircusError> {
    if !valid_session_id(&req.id) || !req.id.contains(':') {
        return Err(CircusError::invalid(format!(
            "Circus can't use the session id {:?}",
            req.id
        )));
    }
    if !valid_time(&req.mtime) {
        return Err(CircusError::invalid(format!(
            "invalid mtime: {:?}",
            req.mtime
        )));
    }
    if let Some(fingerprint) = &req.fingerprint
        && !valid_fingerprint(fingerprint)
    {
        return Err(CircusError::invalid(format!(
            "invalid fingerprint: {fingerprint:?}"
        )));
    }
    match (req.action, &req.until) {
        (DecisionAction::Snooze, None) => {
            return Err(CircusError::invalid("snooze needs an until time"));
        }
        (DecisionAction::Snooze, Some(until)) if !valid_time(until) || until.is_empty() => {
            return Err(CircusError::invalid(format!("invalid until: {until:?}")));
        }
        (action, Some(_)) if action != DecisionAction::Snooze => {
            return Err(CircusError::invalid(format!(
                "until is only valid for snooze, not {}",
                action.as_str()
            )));
        }
        _ => {}
    }
    let verb: &[&str] = match req.action {
        DecisionAction::Archive => &["session", "archive"],
        DecisionAction::Delete => &["session", "delete"],
        DecisionAction::Harvest => &["session", "harvest"],
        DecisionAction::Snooze => &["session", "snooze"],
        DecisionAction::Keep => &["session", "keep"],
        DecisionAction::KeepGoing => &["session", "mark", "reviewed"],
        DecisionAction::Unkeep => &["session", "unkeep"],
        DecisionAction::Wake => &["session", "wake"],
    };
    let archive = (req.action == DecisionAction::Harvest).then(|| "--archive".to_string());
    let fingerprint = req
        .fingerprint
        .iter()
        .map(|fp| format!("--if-fingerprint={fp}"));
    let until = req.until.iter().map(|until| format!("--until={until}"));
    Ok(strings(verb)
        .into_iter()
        .chain([req.id.clone()])
        .chain(archive)
        .chain(["--json".to_string(), format!("--if-mtime={}", req.mtime)])
        .chain(fingerprint)
        .chain(until)
        .collect())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HandoffMode {
    Preview,
    Launch,
}

pub fn handoff_args(req: &HandoffRequest, mode: HandoffMode) -> Result<Vec<String>, CircusError> {
    if !valid_project_key(&req.project_key) {
        return Err(CircusError::invalid(format!(
            "invalid project key: {:?}",
            req.project_key
        )));
    }
    if !valid_agent(&req.agent) {
        return Err(CircusError::invalid(format!(
            "invalid agent: {:?}",
            req.agent
        )));
    }
    let preview: &[&str] = match mode {
        HandoffMode::Preview => &["--dry-run", "--json"],
        HandoffMode::Launch => &[],
    };
    Ok(strings(&["handoff", "triage"])
        .into_iter()
        .chain([
            format!("--project={}", req.project_key),
            format!("--agent={}", req.agent),
        ])
        .chain(strings(preview))
        .collect())
}

pub fn decide_timeout(action: DecisionAction) -> Duration {
    match action {
        DecisionAction::Harvest => HARVEST_TIMEOUT,
        _ => DECIDE_TIMEOUT,
    }
}

pub(crate) fn last_chars(text: &str, count: usize) -> String {
    let total = text.chars().count();
    text.chars().skip(total.saturating_sub(count)).collect()
}

fn names_a_contract_command(line: &str) -> bool {
    line.strip_prefix("rl: unknown command '")
        .and_then(|rest| rest.split_once('\''))
        .is_some_and(|(name, _)| CONTRACT_COMMANDS.contains(&name))
}

fn rejects_json_flag(line: &str) -> bool {
    line.split_once("error: unrecognized arguments:")
        .is_some_and(|(_, rest)| rest.split_whitespace().any(|arg| arg == "--json"))
}

fn is_too_old(output: &ProcessOutput) -> bool {
    output.exit_code == Some(2)
        && output.stdout.is_empty()
        && output
            .stderr
            .lines()
            .any(|line| rejects_json_flag(line) || names_a_contract_command(line))
}

pub(crate) fn non_empty_tail(stderr: &str) -> Option<String> {
    (!stderr.is_empty()).then(|| last_chars(stderr, STDERR_TAIL_CHARS))
}

pub fn parse_document(output: ProcessOutput, kind: &str) -> Result<Vec<u8>, CircusError> {
    if std::str::from_utf8(&output.stdout).is_err() {
        return Err(CircusError::new(
            ErrorKind::BadOutput,
            "the response was not UTF-8",
        ));
    }
    let failed = |kind: ErrorKind, message: String| CircusError {
        kind,
        message,
        exit_code: output.exit_code,
        stderr_tail: non_empty_tail(&output.stderr),
    };
    let envelope = serde_json::from_slice::<Envelope>(&output.stdout).ok();
    if let Some(envelope) = &envelope {
        if envelope.kind == kind && envelope.version == CONTRACT_VERSION {
            return Ok(output.stdout);
        }
        if envelope.kind == "error" {
            let message = envelope
                .message
                .clone()
                .unwrap_or_else(|| "an unknown error".to_string());
            return Err(failed(ErrorKind::RlError, message));
        }
        if envelope.version != CONTRACT_VERSION {
            return Err(CircusError::new(
                ErrorKind::BadOutput,
                format!("unsupported contract version {}", envelope.version),
            ));
        }
    }
    if is_too_old(&output) {
        return Err(CircusError::new(ErrorKind::RlTooOld, RL_TOO_OLD));
    }
    match output.exit_code {
        Some(0) => Err(CircusError::new(
            ErrorKind::BadOutput,
            match envelope {
                Some(envelope) => {
                    format!("expected a {kind} document, got {}", envelope.kind)
                }
                None => format!("no {kind} response came back"),
            },
        )),
        Some(code) => Err(failed(
            ErrorKind::Failed,
            format!("it exited with code {code}"),
        )),
        None => Err(failed(
            ErrorKind::Failed,
            "it was stopped by a signal".to_string(),
        )),
    }
}

pub fn map_run_error(error: RunError, not_found_message: &str) -> CircusError {
    match error {
        RunError::NotFound => CircusError::new(ErrorKind::RlNotFound, not_found_message),
        RunError::Timeout => CircusError::new(ErrorKind::Timeout, "it did not finish in time"),
        RunError::OutputTooLarge => {
            CircusError::new(ErrorKind::BadOutput, "the response was too large")
        }
        RunError::Detached => {
            CircusError::new(ErrorKind::Failed, "it was still running past its deadline")
        }
        RunError::Io(message) => CircusError::new(ErrorKind::Failed, message),
    }
}

pub(crate) fn command_spec(
    command: &[String],
    path_env: Option<&str>,
    args: Vec<String>,
    timeout: Duration,
) -> Option<ProcessSpec> {
    let (program, prefix) = command.split_first()?;
    Some(ProcessSpec {
        program: program.clone(),
        args: prefix.iter().cloned().chain(args).collect(),
        path_env: path_env.map(str::to_string),
        extra_env: Vec::new(),
        timeout,
        on_deadline: OnDeadline::Terminate,
    })
}

pub struct RlClient<R: ProcessRunner> {
    runner: R,
    command: Vec<String>,
    path_env: Option<String>,
    not_found_message: String,
}

impl<R: ProcessRunner> RlClient<R> {
    pub fn new(
        runner: R,
        command: Vec<String>,
        path_env: Option<String>,
        not_found_message: String,
    ) -> Self {
        Self {
            runner,
            command,
            path_env,
            not_found_message,
        }
    }

    pub fn list(&self) -> Result<Vec<u8>, CircusError> {
        self.call(list_args(), LIST_TIMEOUT, "list")
    }

    pub fn scan(&self) -> Result<Vec<u8>, CircusError> {
        self.call(scan_args(), SCAN_TIMEOUT, "list")
    }

    pub fn tails(&self, req: &TailsRequest) -> Result<Vec<u8>, CircusError> {
        match tails_args(req)? {
            Some(args) => self.call(args, TAILS_TIMEOUT, "tails"),
            None => Ok(EMPTY_TAILS.to_vec()),
        }
    }

    pub fn decide(&self, req: &DecideRequest) -> Result<Vec<u8>, CircusError> {
        self.call(decide_args(req)?, decide_timeout(req.action), "outcome")
    }

    pub fn handoff_preview(&self, req: &HandoffRequest) -> Result<Vec<u8>, CircusError> {
        self.call(
            handoff_args(req, HandoffMode::Preview)?,
            HANDOFF_TIMEOUT,
            "handoff",
        )
    }

    fn call(
        &self,
        args: Vec<String>,
        timeout: Duration,
        kind: &str,
    ) -> Result<Vec<u8>, CircusError> {
        let spec = command_spec(&self.command, self.path_env.as_deref(), args, timeout)
            .ok_or_else(|| {
                CircusError::new(ErrorKind::RlNotFound, self.not_found_message.clone())
            })?;
        let output = self
            .runner
            .run(&spec)
            .map_err(|error| map_run_error(error, &self.not_found_message))?;
        parse_document(output, kind)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    const LIST: &[u8] = include_bytes!("../tests/fixtures/list.json");
    const TAILS: &[u8] = include_bytes!("../tests/fixtures/tails.json");
    const SCAN: &[u8] = include_bytes!("../tests/fixtures/scan.json");
    const REFUSED: &[u8] = include_bytes!("../tests/fixtures/outcome-refused.json");
    const ERROR: &[u8] = include_bytes!("../tests/fixtures/error.json");
    const LIST_V2: &[u8] = include_bytes!("../tests/fixtures/list-v2.json");

    struct FakeRunner {
        specs: Mutex<Vec<ProcessSpec>>,
        stdout: Vec<u8>,
    }

    impl FakeRunner {
        fn returning(stdout: &[u8]) -> Self {
            Self {
                specs: Mutex::new(Vec::new()),
                stdout: stdout.to_vec(),
            }
        }

        fn recorded(&self) -> Vec<ProcessSpec> {
            self.specs.lock().expect("specs").clone()
        }
    }

    impl ProcessRunner for FakeRunner {
        fn run(&self, spec: &ProcessSpec) -> Result<ProcessOutput, RunError> {
            self.specs.lock().expect("specs").push(spec.clone());
            Ok(ProcessOutput {
                exit_code: Some(0),
                stdout: self.stdout.clone(),
                stderr: String::new(),
            })
        }
    }

    fn client(runner: FakeRunner) -> RlClient<FakeRunner> {
        RlClient::new(
            runner,
            vec!["/w/.venv/bin/rl".to_string()],
            Some("/w/bin:/usr/bin".to_string()),
            "rl not found".to_string(),
        )
    }

    fn output(stdout: &[u8], exit_code: i32, stderr: &str) -> ProcessOutput {
        ProcessOutput {
            exit_code: Some(exit_code),
            stdout: stdout.to_vec(),
            stderr: stderr.to_string(),
        }
    }

    fn tails_req(ids: &[&str], max_chars: u32) -> TailsRequest {
        TailsRequest {
            ids: strings(ids),
            max_chars,
        }
    }

    fn decide_req(action: DecisionAction, id: &str, mtime: &str) -> DecideRequest {
        DecideRequest {
            action,
            id: id.to_string(),
            mtime: mtime.to_string(),
            fingerprint: None,
            until: None,
        }
    }

    fn handoff_req(project_key: &str, agent: &str) -> HandoffRequest {
        HandoffRequest {
            project_key: project_key.to_string(),
            agent: agent.to_string(),
        }
    }

    #[test]
    fn handoff_args_pass_project_and_agent_as_flag_values() {
        let req = handoff_req("/w/my proj", "claude-code");
        assert_eq!(
            handoff_args(&req, HandoffMode::Preview).expect("args"),
            strings(&[
                "handoff",
                "triage",
                "--project=/w/my proj",
                "--agent=claude-code",
                "--dry-run",
                "--json"
            ])
        );
        assert_eq!(
            handoff_args(&req, HandoffMode::Launch).expect("args"),
            strings(&[
                "handoff",
                "triage",
                "--project=/w/my proj",
                "--agent=claude-code"
            ])
        );
    }

    #[test]
    fn handoff_args_reject_unpassable_values() {
        let invalid = [
            handoff_req("", "claude-code"),
            handoff_req("/w/a\nb", "claude-code"),
            handoff_req("/w/proj", "-x"),
            handoff_req("/w/proj", "Claude Code"),
        ];
        for req in invalid {
            assert_eq!(
                kind_of(handoff_args(&req, HandoffMode::Preview)),
                ErrorKind::InvalidArgument,
                "{req:?}"
            );
        }
    }

    #[test]
    fn handoff_args_cap_the_project_key_and_agent_lengths() {
        let longest_key = format!("/{}", "é".repeat(4_095));
        let longest_agent = "a".repeat(32);
        assert!(handoff_args(&handoff_req(&longest_key, "codex"), HandoffMode::Preview).is_ok());
        assert!(handoff_args(&handoff_req("/w", &longest_agent), HandoffMode::Preview).is_ok());
        let too_long_key = format!("{longest_key}x");
        let too_long_agent = format!("{longest_agent}a");
        for req in [
            handoff_req(&too_long_key, "codex"),
            handoff_req("/w", &too_long_agent),
        ] {
            assert_eq!(
                kind_of(handoff_args(&req, HandoffMode::Preview)),
                ErrorKind::InvalidArgument
            );
        }
    }

    #[test]
    fn handoff_preview_runs_the_dry_run_and_returns_the_handoff_document() {
        let document = br#"{"version":1,"kind":"handoff","status":"ok","project_key":"/w/proj"}"#;
        let rl = client(FakeRunner::returning(document));
        let bytes = rl
            .handoff_preview(&handoff_req("/w/proj", "codex"))
            .expect("preview");
        assert_eq!(bytes, document);
        let specs = rl.runner.recorded();
        assert_eq!(specs.len(), 1);
        assert_eq!(specs[0].program, "/w/.venv/bin/rl");
        assert_eq!(
            specs[0].args,
            strings(&[
                "handoff",
                "triage",
                "--project=/w/proj",
                "--agent=codex",
                "--dry-run",
                "--json"
            ])
        );
        assert_eq!(specs[0].timeout, Duration::from_secs(30));
        let rl = client(FakeRunner::returning(LIST));
        let error = rl
            .handoff_preview(&handoff_req("/w/proj", "codex"))
            .expect_err("wrong kind");
        assert_eq!(error.message, "expected a handoff document, got list");
    }

    fn kind_of<T>(result: Result<T, CircusError>) -> ErrorKind {
        result.err().expect("an error").kind
    }

    #[test]
    fn list_runs_the_resolved_command_with_list_args() {
        assert_eq!(list_args(), strings(&["inbox", "--json"]));
        assert_eq!(scan_args(), strings(&["inbox", "--json", "--scan"]));
        let rl = client(FakeRunner::returning(LIST));
        assert_eq!(rl.list().expect("list"), LIST);
        let specs = rl.runner.recorded();
        assert_eq!(specs.len(), 1);
        assert_eq!(specs[0].program, "/w/.venv/bin/rl");
        assert_eq!(specs[0].args, strings(&["inbox", "--json"]));
        assert_eq!(specs[0].timeout, Duration::from_secs(60));
        assert_eq!(specs[0].path_env.as_deref(), Some("/w/bin:/usr/bin"));
    }

    #[test]
    fn command_prefix_words_come_before_the_args() {
        let rl = RlClient::new(
            FakeRunner::returning(SCAN),
            strings(&["uv", "run", "rl"]),
            None,
            String::new(),
        );
        rl.scan().expect("scan");
        let specs = rl.runner.recorded();
        assert_eq!(specs[0].program, "uv");
        assert_eq!(
            specs[0].args,
            strings(&["run", "rl", "inbox", "--json", "--scan"])
        );
        assert_eq!(specs[0].timeout, Duration::from_secs(300));
    }

    #[test]
    fn tails_args_keep_request_order_and_max_chars() {
        let args = tails_args(&tails_req(&["claude-code:a", "codex:b"], 50_000)).expect("args");
        assert_eq!(
            args.expect("passable ids"),
            strings(&[
                "data",
                "export",
                "claude-code:a",
                "codex:b",
                "--json",
                "--max-chars=50000"
            ])
        );
        let rl = client(FakeRunner::returning(TAILS));
        rl.tails(&tails_req(&["claude-code:a"], 2000))
            .expect("tails");
        let specs = rl.runner.recorded();
        assert_eq!(specs[0].timeout, Duration::from_secs(30));
        assert_eq!(
            specs[0].args.last().map(String::as_str),
            Some("--max-chars=2000")
        );
    }

    #[test]
    fn decide_args_name_the_guarded_session_verb_for_each_action() {
        let mtime = "2026-10-16T09:00:00+00:00";
        let expected: [(DecisionAction, &[&str]); 8] = [
            (DecisionAction::Archive, &["session", "archive", "codex:b"]),
            (DecisionAction::Delete, &["session", "delete", "codex:b"]),
            (
                DecisionAction::Harvest,
                &["session", "harvest", "codex:b", "--archive"],
            ),
            (DecisionAction::Keep, &["session", "keep", "codex:b"]),
            (
                DecisionAction::KeepGoing,
                &["session", "mark", "reviewed", "codex:b"],
            ),
            (DecisionAction::Snooze, &["session", "snooze", "codex:b"]),
            (DecisionAction::Unkeep, &["session", "unkeep", "codex:b"]),
            (DecisionAction::Wake, &["session", "wake", "codex:b"]),
        ];
        for (action, head) in expected {
            let mut req = decide_req(action, "codex:b", mtime);
            req.fingerprint = Some("1:6:4068:17:17".to_string());
            let mut tail = vec![
                "--json".to_string(),
                format!("--if-mtime={mtime}"),
                "--if-fingerprint=1:6:4068:17:17".to_string(),
            ];
            if action == DecisionAction::Snooze {
                req.until = Some("2026-10-20T07:00:00.000Z".to_string());
                tail.push("--until=2026-10-20T07:00:00.000Z".to_string());
            }
            let want: Vec<String> = strings(head).into_iter().chain(tail).collect();
            assert_eq!(decide_args(&req).expect("args"), want, "{action:?}");
        }
    }

    #[test]
    fn decide_args_pass_an_empty_mtime_and_omit_a_missing_fingerprint() {
        let archive = decide_req(DecisionAction::Archive, "codex:b", "");
        assert_eq!(
            decide_args(&archive).expect("args"),
            strings(&["session", "archive", "codex:b", "--json", "--if-mtime="])
        );
        let mut snooze = decide_req(
            DecisionAction::Snooze,
            "claude-code:a",
            "2026-10-16T09:00:00+00:00",
        );
        snooze.until = Some("2026-10-20T07:00:00.000Z".to_string());
        assert_eq!(
            decide_args(&snooze).expect("args"),
            strings(&[
                "session",
                "snooze",
                "claude-code:a",
                "--json",
                "--if-mtime=2026-10-16T09:00:00+00:00",
                "--until=2026-10-20T07:00:00.000Z",
            ])
        );
    }

    #[test]
    fn decide_timeout_is_longer_for_harvest() {
        assert_eq!(
            decide_timeout(DecisionAction::Harvest),
            Duration::from_secs(420)
        );
        assert_eq!(
            decide_timeout(DecisionAction::Archive),
            Duration::from_secs(120)
        );
        let rl = client(FakeRunner::returning(REFUSED));
        rl.decide(&decide_req(DecisionAction::Harvest, "claude-code:a", ""))
            .expect("decide");
        assert_eq!(rl.runner.recorded()[0].timeout, Duration::from_secs(420));
    }

    #[test]
    fn ids_are_checked_only_for_argument_safety() {
        let ok = "2026-10-16T09:00:00+00:00";
        for id in [
            "-x:y",
            "",
            "claude-code",
            "claude-code:a\nb",
            "claude-code:a\0b",
        ] {
            assert_eq!(
                kind_of(decide_args(&decide_req(DecisionAction::Keep, id, ok))),
                ErrorKind::InvalidArgument,
                "{id:?}"
            );
        }
        let long = format!("claude-code:{}", "a".repeat(1_000));
        assert!(!valid_session_id(&long));
        assert!(valid_session_id(&format!(
            "claude-code:{}",
            "a".repeat(988)
        )));
        for id in [
            "pi:2026-10-16_a.b",
            "Claude:y",
            "claude-code:a b",
            "claude-code:-a",
            "droid:ünïcode/€",
        ] {
            assert!(valid_session_id(id), "{id:?}");
            assert_eq!(
                decide_args(&decide_req(DecisionAction::Keep, id, ok)).expect("passes")[2],
                id
            );
        }
    }

    #[test]
    fn invalid_decide_fields_are_rejected() {
        let id = "claude-code:a";
        assert_eq!(
            kind_of(decide_args(&decide_req(DecisionAction::Keep, id, "; rm"))),
            ErrorKind::InvalidArgument
        );
        assert_eq!(
            kind_of(decide_args(&decide_req(DecisionAction::Snooze, id, ""))),
            ErrorKind::InvalidArgument
        );
        let mut archive = decide_req(DecisionAction::Archive, id, "");
        archive.until = Some("2026-10-20T07:00:00Z".to_string());
        assert_eq!(kind_of(decide_args(&archive)), ErrorKind::InvalidArgument);
        let mut spaced = decide_req(DecisionAction::Archive, id, "");
        spaced.fingerprint = Some("1 2".to_string());
        assert_eq!(kind_of(decide_args(&spaced)), ErrorKind::InvalidArgument);
    }

    #[test]
    fn invalid_tails_requests_are_rejected() {
        let seventeen: Vec<String> = (0..17).map(|n| format!("codex:s{n}")).collect();
        let cases = [
            tails_req(&["claude-code:a"], 10),
            tails_req(&[], 50_000),
            TailsRequest {
                ids: seventeen,
                max_chars: 50_000,
            },
            tails_req(&["claude-code:a", "claude-code:a"], 50_000),
        ];
        for case in &cases {
            assert_eq!(
                kind_of(tails_args(case)),
                ErrorKind::InvalidArgument,
                "{case:?}"
            );
        }
        let rl = client(FakeRunner::returning(TAILS));
        assert_eq!(
            kind_of(rl.tails(&tails_req(&[], 50_000))),
            ErrorKind::InvalidArgument
        );
        assert!(rl.runner.recorded().is_empty());
    }

    #[test]
    fn an_unpassable_tail_id_is_dropped_from_its_batch() {
        let rl = client(FakeRunner::returning(TAILS));
        rl.tails(&tails_req(&["claude-code:a", "-x", "codex:b"], 50_000))
            .expect("tails");
        assert_eq!(
            rl.runner.recorded()[0].args,
            strings(&[
                "data",
                "export",
                "claude-code:a",
                "codex:b",
                "--json",
                "--max-chars=50000"
            ])
        );
    }

    #[test]
    fn a_batch_of_only_unpassable_ids_returns_no_items_without_spawning() {
        let rl = client(FakeRunner::returning(TAILS));
        let bytes = rl
            .tails(&tails_req(&["-x", "codex:\u{7}"], 50_000))
            .expect("tails");
        assert!(rl.runner.recorded().is_empty());
        let document: serde_json::Value = serde_json::from_slice(&bytes).expect("json");
        assert_eq!(document["kind"], "tails");
        assert_eq!(document["version"], 1);
        assert_eq!(document["items"], serde_json::json!([]));
    }

    #[test]
    fn parse_document_returns_the_stdout_bytes_unchanged() {
        assert_eq!(
            parse_document(output(LIST, 0, ""), "list").expect("list"),
            LIST
        );
        assert_eq!(
            parse_document(output(TAILS, 0, ""), "tails").expect("tails"),
            TAILS
        );
        assert_eq!(
            parse_document(output(SCAN, 0, ""), "list").expect("scan"),
            SCAN
        );
        assert_eq!(
            parse_document(output(REFUSED, 0, ""), "outcome").expect("outcome"),
            REFUSED
        );
    }

    #[test]
    fn parse_document_rejects_the_wrong_kind() {
        let error = parse_document(output(LIST, 0, ""), "tails").expect_err("wrong kind");
        assert_eq!(error.kind, ErrorKind::BadOutput);
    }

    #[test]
    fn scan_accepts_a_list_document_and_rejects_a_scan_document() {
        let rl = client(FakeRunner::returning(SCAN));
        assert_eq!(rl.scan().expect("scan"), SCAN);
        let old_scan = br#"{"version":1,"kind":"scan","scanned_at":"2026-10-17T08:00:00+00:00","added":0,"removed":0,"unavailable_sources":[]}"#;
        let rl = client(FakeRunner::returning(old_scan));
        let error = rl.scan().expect_err("scan kind");
        assert_eq!(error.kind, ErrorKind::BadOutput);
        assert_eq!(error.message, "expected a list document, got scan");
    }

    #[test]
    fn an_rl_without_the_json_commands_is_too_old() {
        let usage = "usage: rl inbox [-h] [--read-only]\n";
        for stderr in [
            format!("{usage}rl inbox: error: unrecognized arguments: --json"),
            format!("{usage}rl inbox: error: unrecognized arguments: --json --scan"),
            format!(
                "{usage}rl session archive: error: unrecognized arguments: --json --if-mtime=x"
            ),
            "rl: unknown command 'inbox'\nusage: rl ...".to_string(),
            "rl: unknown command 'data'\nusage: rl ...".to_string(),
            "rl: unknown command 'reviewed' in 'rl session mark'\nusage: rl ...".to_string(),
        ] {
            let error = parse_document(output(b"", 2, &stderr), "list").expect_err("too old");
            assert_eq!(error.kind, ErrorKind::RlTooOld, "{stderr:?}");
            assert_eq!(
                error.message,
                "The installed ringleader is too old for Circus"
            );
        }
    }

    #[test]
    fn every_command_token_circus_passes_is_a_contract_command() {
        let id = "codex:b";
        let actions = [
            DecisionAction::Harvest,
            DecisionAction::Archive,
            DecisionAction::Delete,
            DecisionAction::Snooze,
            DecisionAction::Keep,
            DecisionAction::KeepGoing,
            DecisionAction::Unkeep,
            DecisionAction::Wake,
        ];
        let mut argvs = vec![
            list_args(),
            scan_args(),
            tails_args(&tails_req(&[id], 2000))
                .expect("args")
                .expect("passable"),
        ];
        for action in actions {
            match action {
                DecisionAction::Harvest
                | DecisionAction::Archive
                | DecisionAction::Delete
                | DecisionAction::Snooze
                | DecisionAction::Keep
                | DecisionAction::KeepGoing
                | DecisionAction::Unkeep
                | DecisionAction::Wake => {}
            }
            let mut req = decide_req(action, id, "2026-10-16T09:00:00+00:00");
            if action == DecisionAction::Snooze {
                req.until = Some("2026-10-20T07:00:00.000Z".to_string());
            }
            argvs.push(decide_args(&req).expect("args"));
        }
        argvs.push(
            handoff_args(&handoff_req("/w/proj", "claude-code"), HandoffMode::Preview)
                .expect("args"),
        );
        for argv in argvs {
            for token in argv.iter().filter(|t| !t.starts_with("--") && *t != id) {
                assert!(
                    CONTRACT_COMMANDS.contains(&token.as_str()),
                    "{token:?} from {argv:?}"
                );
            }
        }
    }

    #[test]
    fn other_usage_errors_are_failures_with_the_stderr_tail() {
        let bogus = "usage: rl inbox\nrl inbox: error: unrecognized arguments: --bogus";
        let error = parse_document(output(b"", 2, bogus), "list").expect_err("usage");
        assert_eq!(error.kind, ErrorKind::Failed);
        assert_eq!(error.exit_code, Some(2));
        assert_eq!(error.stderr_tail.as_deref(), Some(bogus));

        let unknown = "rl: unknown command 'gui'\nusage: rl ...";
        let error = parse_document(output(b"", 2, unknown), "list").expect_err("gui");
        assert_eq!(error.kind, ErrorKind::Failed);

        let noisy = "rl inbox: error: unrecognized arguments: --json";
        let error = parse_document(output(b"partial", 2, noisy), "list").expect_err("stdout");
        assert_eq!(error.kind, ErrorKind::Failed);

        let exit_one = parse_document(output(b"", 1, noisy), "list").expect_err("exit 1");
        assert_eq!(exit_one.kind, ErrorKind::Failed);
    }

    #[test]
    fn parse_document_maps_error_documents_to_rl_error() {
        let error = parse_document(output(ERROR, 1, ""), "list").expect_err("error doc");
        assert_eq!(error.kind, ErrorKind::RlError);
        assert_eq!(error.message, "registry is locked by another writer");
        assert_eq!(error.exit_code, Some(1));
    }

    #[test]
    fn parse_document_rejects_other_versions() {
        let error = parse_document(output(LIST_V2, 0, ""), "list").expect_err("v2");
        assert_eq!(error.kind, ErrorKind::BadOutput);
        assert!(error.message.contains("unsupported contract version 2"));
    }

    #[test]
    fn parse_document_maps_process_failures() {
        let crashed = parse_document(
            output(b"", 1, "Traceback (most recent call last):\nboom"),
            "list",
        )
        .expect_err("crash");
        assert_eq!(crashed.kind, ErrorKind::Failed);
        assert_eq!(crashed.exit_code, Some(1));
        assert!(crashed.stderr_tail.expect("tail").ends_with("boom"));

        let long = format!("{}end", "x".repeat(5000));
        let clipped = parse_document(output(b"", 1, &long), "list").expect_err("crash");
        assert_eq!(clipped.stderr_tail.map(|t| t.chars().count()), Some(2000));

        let garbage = parse_document(output(&[0xff, 0xfe], 0, ""), "list").expect_err("utf8");
        assert_eq!(garbage.kind, ErrorKind::BadOutput);

        let unparsable = parse_document(output(b"not json", 0, ""), "list").expect_err("json");
        assert_eq!(unparsable.kind, ErrorKind::BadOutput);
    }

    #[test]
    fn map_run_error_maps_each_variant() {
        let not_found = map_run_error(RunError::NotFound, "msg");
        assert_eq!(not_found.kind, ErrorKind::RlNotFound);
        assert_eq!(not_found.message, "msg");
        assert_eq!(
            map_run_error(RunError::Timeout, "msg").kind,
            ErrorKind::Timeout
        );
        assert_eq!(
            map_run_error(RunError::OutputTooLarge, "msg").kind,
            ErrorKind::BadOutput
        );
        assert_eq!(
            map_run_error(RunError::Io("denied".to_string()), "msg").kind,
            ErrorKind::Failed
        );
    }
}
