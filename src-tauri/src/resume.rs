use std::time::Duration;

use crate::contract::{ResumeLaunch, TerminalKind};
use crate::error::{CircusError, ErrorKind};
use crate::process::{OnDeadline, ProcessOutput, ProcessRunner, ProcessSpec, RunError};
use crate::rl;

pub const RESUME_LAUNCH_TIMEOUT: Duration = Duration::from_secs(60);
pub const CUSTOM_LAUNCH_GRACE: Duration = Duration::from_secs(5);
const OSASCRIPT: &str = "/usr/bin/osascript";
const COMMAND_PLACEHOLDER: &str = "{command}";
const NOT_AUTHORIZED: &str = "Circus isn't allowed to control iTerm2. Allow it in System Settings › Privacy & Security › Automation, then resume again.";
const NO_RESPONSE: &str = "iTerm2 did not respond within 60 s — answer the permission prompt if one is open, then resume again.";

pub fn resume_command_line(rl_command: &[String], id: &str) -> Result<String, CircusError> {
    shlex::try_join(rl_command.iter().map(String::as_str).chain(["resume", id]))
        .map_err(|error| CircusError::invalid(format!("cannot quote the resume command: {error}")))
}

pub fn applescript_string(text: &str) -> String {
    format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
}

pub fn iterm_script(command_line: &str) -> String {
    format!(
        "tell application \"iTerm2\"\n  activate\n  set newWindow to (create window with default profile)\n  tell current session of newWindow to write text {}\nend tell\n",
        applescript_string(command_line)
    )
}

pub fn custom_argv(template: &[String], command_line: &str) -> Vec<String> {
    template
        .iter()
        .map(|element| element.replace(COMMAND_PLACEHOLDER, command_line))
        .collect()
}

pub fn launch_spec(
    terminal_command: Option<&[String]>,
    command_line: &str,
) -> Result<(ProcessSpec, TerminalKind), CircusError> {
    let (program, args, via) = match terminal_command {
        None => (
            OSASCRIPT.to_string(),
            vec!["-e".to_string(), iterm_script(command_line)],
            TerminalKind::Iterm2,
        ),
        Some(template) => {
            let argv = custom_argv(template, command_line);
            let Some((program, args)) = argv.split_first() else {
                return Err(CircusError::invalid(
                    "terminal_command in settings.json is empty",
                ));
            };
            (program.clone(), args.to_vec(), TerminalKind::Custom)
        }
    };
    // a custom launcher may be the terminal itself, which stays in the foreground until its window closes
    let (timeout, on_deadline) = match via {
        TerminalKind::Iterm2 => (RESUME_LAUNCH_TIMEOUT, OnDeadline::Terminate),
        TerminalKind::Custom => (CUSTOM_LAUNCH_GRACE, OnDeadline::Detach),
    };
    let spec = ProcessSpec {
        program,
        args,
        path_env: None,
        extra_env: Vec::new(),
        timeout,
        on_deadline,
    };
    Ok((spec, via))
}

fn launch_failure(message: impl Into<String>) -> CircusError {
    CircusError::new(ErrorKind::Launch, message)
}

fn classify_launch(
    result: Result<ProcessOutput, RunError>,
    via: TerminalKind,
    program: &str,
) -> Option<CircusError> {
    match result {
        Ok(output) if output.exit_code == Some(0) => None,
        Err(RunError::Detached) => None,
        Ok(output)
            if via == TerminalKind::Iterm2
                && (output.stderr.contains("(-1743)")
                    || output
                        .stderr
                        .contains("Not authorized to send Apple events")) =>
        {
            Some(launch_failure(NOT_AUTHORIZED))
        }
        Ok(output) => {
            let tail = rl::last_chars(output.stderr.trim_end(), rl::STDERR_TAIL_CHARS);
            let status = output
                .exit_code
                .map_or_else(|| "was killed".to_string(), |code| format!("exited {code}"));
            Some(CircusError {
                kind: ErrorKind::Launch,
                message: format!("The terminal launch {status}: {tail}"),
                exit_code: output.exit_code,
                stderr_tail: (!tail.is_empty()).then_some(tail),
            })
        }
        Err(RunError::Timeout) if via == TerminalKind::Iterm2 => Some(launch_failure(NO_RESPONSE)),
        Err(RunError::Timeout) => Some(launch_failure(format!(
            "The terminal launcher {program:?} did not respond in time."
        ))),
        Err(RunError::NotFound) if via == TerminalKind::Custom => Some(launch_failure(format!(
            "The terminal launcher {program:?} was not found. Use an absolute path in terminal_command in settings.json."
        ))),
        Err(RunError::NotFound) => Some(launch_failure("The terminal launcher was not found.")),
        Err(RunError::OutputTooLarge) => Some(launch_failure(
            "The terminal launcher printed more output than circus accepts.",
        )),
        Err(RunError::Io(message)) => Some(launch_failure(message)),
    }
}

pub struct WithPath<'a, R> {
    pub inner: &'a R,
    pub path_env: Option<String>,
}

impl<R: ProcessRunner> ProcessRunner for WithPath<'_, R> {
    fn run(&self, spec: &ProcessSpec) -> Result<ProcessOutput, RunError> {
        let mut spec = spec.clone();
        spec.path_env = spec.path_env.or_else(|| self.path_env.clone());
        self.inner.run(&spec)
    }
}

pub fn launch<R: ProcessRunner>(
    runner: &R,
    rl_command: &[String],
    id: &str,
    terminal_command: Option<&[String]>,
    dry_run: bool,
) -> Result<ResumeLaunch, CircusError> {
    if !rl::valid_session_id(id) {
        return Err(CircusError::invalid(format!("invalid session id: {id:?}")));
    }
    let command = resume_command_line(rl_command, id)?;
    let (spec, via) = launch_spec(terminal_command, &command)?;
    if dry_run {
        return Ok(ResumeLaunch {
            command,
            launched: false,
            via,
        });
    }
    match classify_launch(runner.run(&spec), via, &spec.program) {
        Some(error) => Err(error),
        None => Ok(ResumeLaunch {
            command,
            launched: true,
            via,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct FakeRunner {
        specs: Mutex<Vec<ProcessSpec>>,
        result: Result<ProcessOutput, RunError>,
    }

    impl FakeRunner {
        fn returning(result: Result<ProcessOutput, RunError>) -> Self {
            Self {
                specs: Mutex::new(Vec::new()),
                result,
            }
        }

        fn exiting(code: i32, stderr: &str) -> Self {
            Self::returning(Ok(ProcessOutput {
                exit_code: Some(code),
                stdout: Vec::new(),
                stderr: stderr.to_string(),
            }))
        }

        fn spawned(&self) -> usize {
            self.specs.lock().expect("specs").len()
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

    fn rl_command() -> Vec<String> {
        strings(&["/w/.venv/bin/rl"])
    }

    fn launch_with(
        runner: &FakeRunner,
        id: &str,
        dry_run: bool,
    ) -> Result<ResumeLaunch, CircusError> {
        launch(runner, &rl_command(), id, None, dry_run)
    }

    #[test]
    fn the_command_line_quotes_a_path_with_spaces() {
        assert_eq!(
            resume_command_line(&strings(&["/a b/.venv/bin/rl"]), "claude-code:abc")
                .expect("joins"),
            "'/a b/.venv/bin/rl' resume claude-code:abc"
        );
    }

    #[test]
    fn applescript_strings_escape_backslashes_and_quotes() {
        assert_eq!(
            applescript_string("say \"hi\" \\ there"),
            "\"say \\\"hi\\\" \\\\ there\""
        );
    }

    #[test]
    fn the_iterm_script_writes_the_command_into_a_new_window() {
        let script = iterm_script("rl resume x:y");
        assert!(script.contains("tell application \"iTerm2\""));
        assert!(script.contains("write text \"rl resume x:y\""));
    }

    #[test]
    fn custom_argv_substitutes_the_command() {
        assert_eq!(
            custom_argv(
                &strings(&["open", "-a", "Terminal", "--args", "{command}"]),
                "rl resume x:y"
            ),
            strings(&["open", "-a", "Terminal", "--args", "rl resume x:y"])
        );
    }

    #[test]
    fn the_default_launch_runs_osascript() {
        let (spec, via) = launch_spec(None, "rl resume x:y").expect("spec");
        assert_eq!(spec.program, "/usr/bin/osascript");
        assert_eq!(spec.args[0], "-e");
        assert_eq!(spec.args[1], iterm_script("rl resume x:y"));
        assert_eq!(spec.timeout, Duration::from_secs(60));
        assert_eq!(via, TerminalKind::Iterm2);
    }

    #[test]
    fn a_template_launch_runs_its_first_element() {
        let template = strings(&["/usr/bin/open", "-a", "Terminal", "{command}"]);
        let (spec, via) = launch_spec(Some(&template), "rl resume x:y").expect("spec");
        assert_eq!(spec.program, "/usr/bin/open");
        assert_eq!(spec.args, strings(&["-a", "Terminal", "rl resume x:y"]));
        assert_eq!(spec.timeout, CUSTOM_LAUNCH_GRACE);
        assert_eq!(spec.on_deadline, OnDeadline::Detach);
        assert_eq!(via, TerminalKind::Custom);
    }

    #[test]
    fn the_default_launch_is_torn_down_on_its_deadline() {
        let (spec, _) = launch_spec(None, "rl resume x:y").expect("spec");
        assert_eq!(spec.on_deadline, OnDeadline::Terminate);
    }

    #[test]
    fn a_custom_launcher_still_running_after_the_grace_counts_as_launched() {
        let runner = FakeRunner::returning(Err(RunError::Detached));
        let template = strings(&["/x/alacritty", "-e", "sh", "-c", "{command}"]);
        let launched = launch(
            &runner,
            &rl_command(),
            "claude-code:abc",
            Some(&template),
            false,
        )
        .expect("launches");
        assert!(launched.launched);
        assert_eq!(launched.via, TerminalKind::Custom);
    }

    #[test]
    fn a_foreground_custom_launcher_is_left_running() {
        let dir = std::env::temp_dir().join(format!(
            "circus-resume-foreground-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos())
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let pid_file = dir.join("pid");
        let script = format!("echo $$ > '{}'; sleep 30", pid_file.to_string_lossy());
        let template = strings(&["/bin/sh", "-c", &script, "{command}"]);
        let started = std::time::Instant::now();
        let launched = launch(
            &crate::process::SystemRunner,
            &rl_command(),
            "claude-code:abc",
            Some(&template),
            false,
        );
        let elapsed = started.elapsed();
        let pid: libc::pid_t = std::fs::read_to_string(&pid_file)
            .expect("pid file")
            .trim()
            .parse()
            .expect("pid");
        let alive = unsafe { libc::kill(pid, 0) };
        unsafe { libc::killpg(pid, libc::SIGKILL) };
        let _ = std::fs::remove_dir_all(dir);
        assert!(launched.expect("launches").launched);
        assert_eq!(alive, 0);
        assert!(
            elapsed < CUSTOM_LAUNCH_GRACE + Duration::from_secs(2),
            "{elapsed:?}"
        );
    }

    #[test]
    fn an_empty_template_is_invalid() {
        let error = launch_spec(Some(&[]), "rl resume x:y").expect_err("empty");
        assert_eq!(error.kind, ErrorKind::InvalidArgument);
    }

    #[test]
    fn a_denied_automation_prompt_names_system_settings() {
        let runner = FakeRunner::exiting(
            1,
            "execution error: Not authorized to send Apple events to iTerm. (-1743)",
        );
        let error = launch_with(&runner, "claude-code:abc", false).expect_err("denied");
        assert_eq!(error.kind, ErrorKind::Launch);
        assert!(error.message.contains("Privacy & Security › Automation"));
    }

    #[test]
    fn a_custom_launcher_failure_mentioning_1743_is_not_an_automation_denial() {
        let runner = FakeRunner::exiting(2, "boom at line (-1743)");
        let template = strings(&["/bin/x", "{command}"]);
        let error = launch(
            &runner,
            &rl_command(),
            "claude-code:abc",
            Some(&template),
            false,
        )
        .expect_err("fails");
        assert!(error.message.contains("boom at line"));
    }

    #[test]
    fn a_bare_digit_run_is_not_an_automation_denial() {
        let runner = FakeRunner::exiting(1, "id x-1743 died");
        let error = launch_with(&runner, "claude-code:abc", false).expect_err("fails");
        assert_eq!(error.stderr_tail.as_deref(), Some("id x-1743 died"));
    }

    #[test]
    fn a_missing_custom_launcher_is_named() {
        let runner = FakeRunner::returning(Err(RunError::NotFound));
        let template = strings(&["wezterm", "{command}"]);
        let error = launch(
            &runner,
            &rl_command(),
            "claude-code:abc",
            Some(&template),
            false,
        )
        .expect_err("missing");
        assert!(error.message.contains("wezterm"));
    }

    #[test]
    fn with_path_supplies_the_login_path_to_a_spec_without_one() {
        let fake = FakeRunner::exiting(0, "");
        let runner = WithPath {
            inner: &fake,
            path_env: Some("/opt/homebrew/bin".to_string()),
        };
        let template = strings(&["wezterm", "{command}"]);
        launch(
            &runner,
            &rl_command(),
            "claude-code:abc",
            Some(&template),
            false,
        )
        .expect("launches");
        let specs = fake.specs.lock().expect("specs");
        assert_eq!(specs[0].path_env.as_deref(), Some("/opt/homebrew/bin"));
    }

    #[test]
    fn another_failure_carries_the_stderr_tail() {
        let runner = FakeRunner::exiting(1, "iTerm2 not found\n");
        let error = launch_with(&runner, "claude-code:abc", false).expect_err("fails");
        assert_eq!(error.kind, ErrorKind::Launch);
        assert_eq!(error.stderr_tail.as_deref(), Some("iTerm2 not found"));
        assert!(error.message.contains("iTerm2 not found"));
        assert_eq!(error.exit_code, Some(1));
    }

    #[test]
    fn a_timeout_mentions_the_sixty_seconds() {
        let runner = FakeRunner::returning(Err(RunError::Timeout));
        let error = launch_with(&runner, "claude-code:abc", false).expect_err("times out");
        assert_eq!(error.kind, ErrorKind::Launch);
        assert!(error.message.contains("60 s"));
    }

    #[test]
    fn a_custom_launcher_timeout_names_the_launcher() {
        let runner = FakeRunner::returning(Err(RunError::Timeout));
        let template = strings(&["/x/wezterm", "{command}"]);
        let error = launch(
            &runner,
            &rl_command(),
            "claude-code:abc",
            Some(&template),
            false,
        )
        .expect_err("times out");
        assert!(error.message.contains("/x/wezterm"), "{}", error.message);
        assert!(!error.message.contains("iTerm2"), "{}", error.message);
    }

    #[test]
    fn a_successful_launch_reports_the_command() {
        let runner = FakeRunner::exiting(0, "");
        let launched = launch_with(&runner, "claude-code:abc", false).expect("launches");
        assert!(launched.launched);
        assert_eq!(launched.command, "/w/.venv/bin/rl resume claude-code:abc");
        assert_eq!(launched.via, TerminalKind::Iterm2);
        assert_eq!(runner.spawned(), 1);
    }

    #[test]
    fn a_dry_run_returns_the_command_without_spawning() {
        let runner = FakeRunner::exiting(0, "");
        let launched = launch_with(&runner, "claude-code:abc", true).expect("dry run");
        assert!(!launched.launched);
        assert_eq!(launched.command, "/w/.venv/bin/rl resume claude-code:abc");
        assert_eq!(runner.spawned(), 0);
    }

    #[test]
    fn an_invalid_id_is_rejected_without_spawning() {
        let runner = FakeRunner::exiting(0, "");
        let error = launch_with(&runner, "claude-code:a\nb", false).expect_err("invalid");
        assert_eq!(error.kind, ErrorKind::InvalidArgument);
        assert_eq!(runner.spawned(), 0);
    }

    #[test]
    fn the_info_plist_declares_the_apple_events_usage() {
        assert!(include_str!("../Info.plist").contains("NSAppleEventsUsageDescription"));
    }
}
