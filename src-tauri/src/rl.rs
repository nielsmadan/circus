use std::collections::HashSet;
use std::time::Duration;

use crate::contract::{DecideRequest, DecisionAction, Envelope, TailsRequest};
use crate::error::{CircusError, ErrorKind};
use crate::process::{ProcessOutput, ProcessRunner, ProcessSpec, RunError};

pub const LIST_TIMEOUT: Duration = Duration::from_secs(60);
pub const SCAN_TIMEOUT: Duration = Duration::from_secs(300);
pub const TAILS_TIMEOUT: Duration = Duration::from_secs(30);
pub const DECIDE_TIMEOUT: Duration = Duration::from_secs(120);
pub const HARVEST_TIMEOUT: Duration = Duration::from_secs(420);
pub const TAIL_DEFAULT_CHARS: u32 = 50_000;
pub const TAIL_MAX_IDS: usize = 16;
const TAIL_MIN_CHARS: u32 = 1_000;
const TAIL_MAX_CHARS: u32 = 2_000_000;
const SESSION_MAX_CHARS: usize = 200;
const TIME_MAX_CHARS: usize = 64;
const FINGERPRINT_MAX_CHARS: usize = 256;
const STDERR_TAIL_CHARS: usize = 2_000;
const CONTRACT_VERSION: u64 = 1;
const RL_TOO_OLD: &str = "The installed rl has no `rl gui` commands. Install the ringleader branch that has them: run `just install` in that ringleader checkout.";

pub fn valid_session_id(id: &str) -> bool {
    let Some((source, session)) = id.split_once(':') else {
        return false;
    };
    let source_ok = source.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && source
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    let session_ok = (1..=SESSION_MAX_CHARS).contains(&session.len())
        && !session.starts_with('-')
        && session
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    source_ok && session_ok
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

pub fn list_args() -> Vec<String> {
    vec!["gui".to_string(), "list".to_string()]
}

pub fn scan_args() -> Vec<String> {
    vec!["gui".to_string(), "scan".to_string()]
}

pub fn tails_args(req: &TailsRequest) -> Result<Vec<String>, CircusError> {
    if req.ids.is_empty() || req.ids.len() > TAIL_MAX_IDS {
        return Err(CircusError::invalid(format!(
            "tails takes 1 to {TAIL_MAX_IDS} ids, got {}",
            req.ids.len()
        )));
    }
    if let Some(bad) = req.ids.iter().find(|id| !valid_session_id(id)) {
        return Err(CircusError::invalid(format!("invalid session id: {bad:?}")));
    }
    let distinct: HashSet<&str> = req.ids.iter().map(String::as_str).collect();
    if distinct.len() != req.ids.len() {
        return Err(CircusError::invalid("tails ids must not repeat"));
    }
    let max_chars = req.max_chars.unwrap_or(TAIL_DEFAULT_CHARS);
    if !(TAIL_MIN_CHARS..=TAIL_MAX_CHARS).contains(&max_chars) {
        return Err(CircusError::invalid(format!(
            "max_chars must be {TAIL_MIN_CHARS} to {TAIL_MAX_CHARS}, got {max_chars}"
        )));
    }
    Ok(["gui", "tail"]
        .iter()
        .map(|s| (*s).to_string())
        .chain(req.ids.iter().cloned())
        .chain([format!("--max-chars={max_chars}")])
        .collect())
}

pub fn decide_args(req: &DecideRequest) -> Result<Vec<String>, CircusError> {
    if !valid_session_id(&req.id) {
        return Err(CircusError::invalid(format!(
            "invalid session id: {:?}",
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
    let base = [
        "gui".to_string(),
        "decide".to_string(),
        req.action.as_str().to_string(),
        req.id.clone(),
        format!("--mtime={}", req.mtime),
    ];
    let fingerprint = req
        .fingerprint
        .iter()
        .map(|fp| format!("--fingerprint={fp}"));
    let until = req.until.iter().map(|until| format!("--until={until}"));
    Ok(base.into_iter().chain(fingerprint).chain(until).collect())
}

pub fn decide_timeout(action: DecisionAction) -> Duration {
    match action {
        DecisionAction::Harvest => HARVEST_TIMEOUT,
        _ => DECIDE_TIMEOUT,
    }
}

fn last_chars(text: &str, count: usize) -> String {
    let total = text.chars().count();
    text.chars().skip(total.saturating_sub(count)).collect()
}

fn non_empty_tail(stderr: &str) -> Option<String> {
    (!stderr.is_empty()).then(|| last_chars(stderr, STDERR_TAIL_CHARS))
}

pub fn parse_document(output: ProcessOutput, kind: &str) -> Result<Vec<u8>, CircusError> {
    if std::str::from_utf8(&output.stdout).is_err() {
        return Err(CircusError::new(
            ErrorKind::BadOutput,
            "rl printed output that is not UTF-8",
        ));
    }
    let failed = |message: String| CircusError {
        kind: ErrorKind::Failed,
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
                .unwrap_or_else(|| "rl reported an error".to_string());
            return Err(failed(message));
        }
        if envelope.version != CONTRACT_VERSION {
            return Err(CircusError::new(
                ErrorKind::BadOutput,
                format!("unsupported contract version {}", envelope.version),
            ));
        }
    }
    match output.exit_code {
        Some(2) if output.stderr.contains("unknown command 'gui'") => {
            Err(CircusError::new(ErrorKind::RlTooOld, RL_TOO_OLD))
        }
        Some(0) => Err(CircusError::new(
            ErrorKind::BadOutput,
            match envelope {
                Some(envelope) => {
                    format!("expected a {kind} document, got {}", envelope.kind)
                }
                None => format!("rl did not print a {kind} document"),
            },
        )),
        Some(code) => Err(failed(format!("rl exited with code {code}"))),
        None => Err(failed("rl was killed by a signal".to_string())),
    }
}

pub fn map_run_error(error: RunError, not_found_message: &str) -> CircusError {
    match error {
        RunError::NotFound => CircusError::new(ErrorKind::RlNotFound, not_found_message),
        RunError::Timeout => CircusError::new(ErrorKind::Timeout, "rl did not finish in time"),
        RunError::OutputTooLarge => CircusError::new(
            ErrorKind::BadOutput,
            "rl printed more output than circus accepts",
        ),
        RunError::Io(message) => CircusError::new(ErrorKind::Failed, message),
    }
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
        self.call(scan_args(), SCAN_TIMEOUT, "scan")
    }

    pub fn tails(&self, req: &TailsRequest) -> Result<Vec<u8>, CircusError> {
        self.call(tails_args(req)?, TAILS_TIMEOUT, "tails")
    }

    pub fn decide(&self, req: &DecideRequest) -> Result<Vec<u8>, CircusError> {
        self.call(decide_args(req)?, decide_timeout(req.action), "outcome")
    }

    pub fn command(&self) -> &[String] {
        &self.command
    }

    fn call(
        &self,
        args: Vec<String>,
        timeout: Duration,
        kind: &str,
    ) -> Result<Vec<u8>, CircusError> {
        let Some((program, prefix)) = self.command.split_first() else {
            return Err(CircusError::new(
                ErrorKind::RlNotFound,
                self.not_found_message.clone(),
            ));
        };
        let spec = ProcessSpec {
            program: program.clone(),
            args: prefix.iter().cloned().chain(args).collect(),
            path_env: self.path_env.clone(),
            extra_env: Vec::new(),
            timeout,
        };
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

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_string()).collect()
    }

    fn tails_req(ids: &[&str], max_chars: Option<u32>) -> TailsRequest {
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

    fn kind_of<T>(result: Result<T, CircusError>) -> ErrorKind {
        result.err().expect("an error").kind
    }

    #[test]
    fn list_runs_the_resolved_command_with_list_args() {
        assert_eq!(list_args(), strings(&["gui", "list"]));
        assert_eq!(scan_args(), strings(&["gui", "scan"]));
        let rl = client(FakeRunner::returning(LIST));
        assert_eq!(rl.list().expect("list"), LIST);
        let specs = rl.runner.recorded();
        assert_eq!(specs.len(), 1);
        assert_eq!(specs[0].program, "/w/.venv/bin/rl");
        assert_eq!(specs[0].args, strings(&["gui", "list"]));
        assert_eq!(specs[0].timeout, Duration::from_secs(60));
        assert_eq!(specs[0].path_env.as_deref(), Some("/w/bin:/usr/bin"));
        assert_eq!(rl.command(), strings(&["/w/.venv/bin/rl"]));
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
        assert_eq!(specs[0].args, strings(&["run", "rl", "gui", "scan"]));
        assert_eq!(specs[0].timeout, Duration::from_secs(300));
    }

    #[test]
    fn tails_args_keep_request_order_and_default_max_chars() {
        let args = tails_args(&tails_req(&["claude-code:a", "codex:b"], None)).expect("args");
        assert_eq!(
            args,
            strings(&[
                "gui",
                "tail",
                "claude-code:a",
                "codex:b",
                "--max-chars=50000"
            ])
        );
        let rl = client(FakeRunner::returning(TAILS));
        rl.tails(&tails_req(&["claude-code:a"], Some(2000)))
            .expect("tails");
        let specs = rl.runner.recorded();
        assert_eq!(specs[0].timeout, Duration::from_secs(30));
        assert_eq!(
            specs[0].args.last().map(String::as_str),
            Some("--max-chars=2000")
        );
    }

    #[test]
    fn decide_args_append_flags_in_flag_value_form() {
        let mut snooze = decide_req(
            DecisionAction::Snooze,
            "claude-code:a",
            "2026-10-16T09:00:00+00:00",
        );
        snooze.until = Some("2026-10-20T07:00:00.000Z".to_string());
        let args = decide_args(&snooze).expect("args");
        assert_eq!(
            args,
            strings(&[
                "gui",
                "decide",
                "snooze",
                "claude-code:a",
                "--mtime=2026-10-16T09:00:00+00:00",
                "--until=2026-10-20T07:00:00.000Z",
            ])
        );
        assert_eq!(
            args.iter()
                .filter(|a| a.starts_with("--fingerprint"))
                .count(),
            0
        );

        let mut archive = decide_req(DecisionAction::Archive, "codex:b", "");
        archive.fingerprint = Some("1:6:4068:17:17".to_string());
        assert_eq!(
            decide_args(&archive).expect("args"),
            strings(&[
                "gui",
                "decide",
                "archive",
                "codex:b",
                "--mtime=",
                "--fingerprint=1:6:4068:17:17"
            ])
        );
        let keep_going = decide_req(DecisionAction::KeepGoing, "codex:b", "");
        assert_eq!(decide_args(&keep_going).expect("args")[2], "keep_going");
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
    fn invalid_ids_are_rejected() {
        let ok = "2026-10-16T09:00:00+00:00";
        for id in [
            "-x:y",
            "Claude:y",
            "claude-code",
            "claude-code:a b",
            "claude-code:-a",
            "claude-code:",
        ] {
            assert_eq!(
                kind_of(decide_args(&decide_req(DecisionAction::Keep, id, ok))),
                ErrorKind::InvalidArgument,
                "{id}"
            );
        }
        let long = format!("claude-code:{}", "a".repeat(201));
        assert!(!valid_session_id(&long));
        assert!(valid_session_id(&format!(
            "claude-code:{}",
            "a".repeat(200)
        )));
        assert!(valid_session_id("pi:2026-10-16_a.b"));
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
            tails_req(&["claude-code:a"], Some(10)),
            tails_req(&[], None),
            TailsRequest {
                ids: seventeen,
                max_chars: None,
            },
            tails_req(&["claude-code:a", "claude-code:a"], None),
            tails_req(&["claude-code:a", "bad id", "codex:b"], None),
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
            kind_of(rl.tails(&tails_req(&[], None))),
            ErrorKind::InvalidArgument
        );
        assert!(rl.runner.recorded().is_empty());
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
            parse_document(output(SCAN, 0, ""), "scan").expect("scan"),
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
    fn parse_document_maps_error_documents_to_failed() {
        let error = parse_document(output(ERROR, 1, ""), "list").expect_err("error doc");
        assert_eq!(error.kind, ErrorKind::Failed);
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
        let too_old = parse_document(
            output(b"", 2, "rl: unknown command 'gui'\nusage: rl ..."),
            "list",
        )
        .expect_err("too old");
        assert_eq!(too_old.kind, ErrorKind::RlTooOld);

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
