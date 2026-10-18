use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

pub const KILL_GRACE: Duration = Duration::from_secs(5);
pub const DRAIN_GRACE: Duration = Duration::from_secs(2);
pub const MAX_STDOUT_BYTES: usize = 32 * 1024 * 1024;
pub const STDERR_TAIL_BYTES: usize = 64 * 1024;
const POLL_INTERVAL: Duration = Duration::from_millis(25);
const READ_CHUNK: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessSpec {
    pub program: String,
    pub args: Vec<String>,
    pub path_env: Option<String>,
    pub extra_env: Vec<(String, String)>,
    pub timeout: Duration,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessOutput {
    pub exit_code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunError {
    NotFound,
    Timeout,
    OutputTooLarge,
    Io(String),
}

pub trait ProcessRunner: Send + Sync {
    fn run(&self, spec: &ProcessSpec) -> Result<ProcessOutput, RunError>;
}

pub fn is_executable(path: &Path) -> bool {
    path.metadata()
        .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

pub fn resolve_program(program: &str, path_env: Option<&str>) -> Option<PathBuf> {
    if program.contains('/') {
        return Some(PathBuf::from(program));
    }
    if program.is_empty() {
        return None;
    }
    path_env?
        .split(':')
        .filter(|dir| !dir.is_empty())
        .map(|dir| Path::new(dir).join(program))
        .find(|candidate| is_executable(candidate))
}

pub struct SystemRunner;

impl ProcessRunner for SystemRunner {
    fn run(&self, spec: &ProcessSpec) -> Result<ProcessOutput, RunError> {
        let search_path = spec.path_env.clone().or_else(|| std::env::var("PATH").ok());
        let program =
            resolve_program(&spec.program, search_path.as_deref()).ok_or(RunError::NotFound)?;
        let mut command = Command::new(program);
        command
            .args(&spec.args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // a new session (not just a group) keeps an interactive shell from stopping on the controlling tty
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        if let Some(path) = &spec.path_env {
            command.env("PATH", path);
        }
        command.envs(spec.extra_env.iter().map(|(key, value)| (key, value)));
        let mut child = command.spawn().map_err(spawn_error)?;
        let pgid = child.id() as libc::pid_t;

        let (eof_tx, eof_rx) = mpsc::channel::<()>();
        let stdout = Arc::new(Mutex::new(StdoutCapture::default()));
        let stderr = Arc::new(Mutex::new(Vec::<u8>::new()));
        if let Some(pipe) = child.stdout.take() {
            drain(pipe, Arc::clone(&stdout), eof_tx.clone(), append_capped);
        }
        if let Some(pipe) = child.stderr.take() {
            drain(pipe, Arc::clone(&stderr), eof_tx.clone(), append_tail);
        }
        drop(eof_tx);

        let deadline = Instant::now() + spec.timeout;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if Instant::now() >= deadline => {
                    terminate(&mut child, pgid);
                    return Err(RunError::Timeout);
                }
                Ok(None) => thread::sleep(POLL_INTERVAL),
                Err(error) => {
                    terminate(&mut child, pgid);
                    return Err(RunError::Io(error.to_string()));
                }
            }
        };

        // a grandchild may still hold the pipes open, so EOF is awaited only briefly
        for _ in 0..2 {
            if eof_rx.recv_timeout(DRAIN_GRACE) == Err(mpsc::RecvTimeoutError::Disconnected) {
                break;
            }
        }
        let captured = std::mem::take(&mut *stdout.lock().unwrap_or_else(PoisonError::into_inner));
        let stderr_bytes =
            std::mem::take(&mut *stderr.lock().unwrap_or_else(PoisonError::into_inner));
        if captured.overflow {
            return Err(RunError::OutputTooLarge);
        }
        Ok(ProcessOutput {
            exit_code: status.code(),
            stdout: captured.bytes,
            stderr: String::from_utf8_lossy(&stderr_bytes).into_owned(),
        })
    }
}

#[derive(Default)]
struct StdoutCapture {
    bytes: Vec<u8>,
    overflow: bool,
}

fn spawn_error(error: std::io::Error) -> RunError {
    match error.kind() {
        std::io::ErrorKind::NotFound => RunError::NotFound,
        _ => RunError::Io(error.to_string()),
    }
}

fn append_capped(capture: &mut StdoutCapture, chunk: &[u8]) {
    if capture.overflow || capture.bytes.len() + chunk.len() > MAX_STDOUT_BYTES {
        capture.overflow = true;
    } else {
        capture.bytes.extend_from_slice(chunk);
    }
}

fn append_tail(tail: &mut Vec<u8>, chunk: &[u8]) {
    tail.extend_from_slice(chunk);
    if tail.len() > STDERR_TAIL_BYTES {
        tail.drain(..tail.len() - STDERR_TAIL_BYTES);
    }
}

fn drain<R, B>(mut reader: R, sink: Arc<Mutex<B>>, eof: Sender<()>, append: fn(&mut B, &[u8]))
where
    R: Read + Send + 'static,
    B: Send + 'static,
{
    thread::spawn(move || {
        let mut buffer = vec![0u8; READ_CHUNK];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => append(
                    &mut sink.lock().unwrap_or_else(PoisonError::into_inner),
                    &buffer[..n],
                ),
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => break,
            }
        }
        let _ = eof.send(());
    });
}

fn signal_group(pgid: libc::pid_t, signal: libc::c_int) {
    // ESRCH (the group is already gone) is the expected outcome after a clean exit
    let _ = unsafe { libc::killpg(pgid, signal) };
}

fn terminate(child: &mut Child, pgid: libc::pid_t) {
    signal_group(pgid, libc::SIGTERM);
    let grace_end = Instant::now() + KILL_GRACE;
    while Instant::now() < grace_end {
        match child.try_wait() {
            Ok(None) => thread::sleep(POLL_INTERVAL),
            _ => break,
        }
    }
    signal_group(pgid, libc::SIGKILL);
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(program: &str, args: &[&str], timeout: Duration) -> ProcessSpec {
        ProcessSpec {
            program: program.to_string(),
            args: args.iter().map(|arg| (*arg).to_string()).collect(),
            path_env: None,
            extra_env: Vec::new(),
            timeout,
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let dir = std::env::temp_dir().join(format!(
            "circus-process-{name}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn echo_captures_stdout_and_exit_code() {
        let output = SystemRunner
            .run(&spec("/bin/echo", &["hi"], Duration::from_secs(10)))
            .expect("echo runs");
        assert_eq!(output.stdout, b"hi\n");
        assert_eq!(output.exit_code, Some(0));
    }

    #[test]
    fn deadline_terminates_the_child() {
        let started = Instant::now();
        let result = SystemRunner.run(&spec("/bin/sleep", &["5"], Duration::from_secs(1)));
        assert_eq!(result, Err(RunError::Timeout));
        assert!(started.elapsed() < Duration::from_secs(4));
    }

    #[test]
    fn deadline_terminates_the_whole_process_group() {
        let dir = temp_dir("group");
        let pid_file = dir.join("pid");
        let script = format!(
            "sleep 30 & echo $! > '{}'; sleep 30",
            pid_file.to_string_lossy()
        );
        let started = Instant::now();
        let result = SystemRunner.run(&spec("/bin/sh", &["-c", &script], Duration::from_secs(1)));
        assert_eq!(result, Err(RunError::Timeout));
        assert!(started.elapsed() < Duration::from_secs(5));
        let pid: libc::pid_t = std::fs::read_to_string(&pid_file)
            .expect("pid file")
            .trim()
            .parse()
            .expect("pid");
        let gone_by = Instant::now() + Duration::from_secs(1);
        let mut alive = unsafe { libc::kill(pid, 0) };
        while alive == 0 && Instant::now() < gone_by {
            thread::sleep(Duration::from_millis(20));
            alive = unsafe { libc::kill(pid, 0) };
        }
        assert_eq!(alive, -1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn child_runs_in_its_own_session() {
        let output = SystemRunner
            .run(&spec(
                "python3",
                &[
                    "-c",
                    "import os; print(os.getpid() == os.getsid(0) == os.getpgrp())",
                ],
                Duration::from_secs(10),
            ))
            .expect("python3 runs");
        assert_eq!(output.stdout, b"True\n");
    }

    #[test]
    fn a_child_ignoring_term_is_killed_after_the_grace() {
        let dir = temp_dir("trap");
        let pid_file = dir.join("pid");
        let script = format!(
            "trap '' TERM; echo $$ > '{}'; i=0; while [ $i -lt 15 ]; do sleep 1; i=$((i+1)); done",
            pid_file.to_string_lossy()
        );
        let started = Instant::now();
        let result = SystemRunner.run(&spec("/bin/sh", &["-c", &script], Duration::from_secs(1)));
        let elapsed = started.elapsed();
        assert_eq!(result, Err(RunError::Timeout));
        assert!(
            elapsed >= Duration::from_secs(1) + KILL_GRACE,
            "{elapsed:?}"
        );
        assert!(elapsed < Duration::from_secs(1) + KILL_GRACE + Duration::from_secs(3));
        let pid: libc::pid_t = std::fs::read_to_string(&pid_file)
            .expect("pid file")
            .trim()
            .parse()
            .expect("pid");
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_child_that_exits_within_the_grace_is_not_killed() {
        let dir = temp_dir("graceful");
        let marker = dir.join("done");
        let script = format!(
            "trap 'sleep 1; touch \"{}\"; exit 0' TERM; while :; do sleep 0.1; done",
            marker.to_string_lossy()
        );
        let started = Instant::now();
        let result = SystemRunner.run(&spec("/bin/sh", &["-c", &script], Duration::from_secs(1)));
        assert_eq!(result, Err(RunError::Timeout));
        assert!(marker.exists());
        assert!(started.elapsed() < Duration::from_secs(1) + KILL_GRACE);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn missing_program_is_not_found() {
        let result = SystemRunner.run(&spec(
            "/nonexistent/circus-no-such-program",
            &[],
            Duration::from_secs(5),
        ));
        assert_eq!(result, Err(RunError::NotFound));
    }

    #[test]
    fn bare_program_resolves_against_path_env() {
        let mut found = spec("echo", &["ok"], Duration::from_secs(5));
        found.path_env = Some("/bin".to_string());
        assert_eq!(SystemRunner.run(&found).expect("echo").stdout, b"ok\n");

        let mut missing = spec("echo", &["ok"], Duration::from_secs(5));
        missing.path_env = Some("/nonexistent".to_string());
        assert_eq!(SystemRunner.run(&missing), Err(RunError::NotFound));
    }

    #[test]
    fn oversized_stdout_is_rejected() {
        let result = SystemRunner.run(&spec(
            "/bin/sh",
            &["-c", "head -c 40000000 /dev/zero"],
            Duration::from_secs(30),
        ));
        assert_eq!(result, Err(RunError::OutputTooLarge));
    }

    #[test]
    fn invalid_utf8_stderr_is_decoded_lossily() {
        let output = SystemRunner
            .run(&spec(
                "/bin/sh",
                &["-c", "printf '\\377' >&2"],
                Duration::from_secs(5),
            ))
            .expect("sh runs");
        assert_eq!(output.stderr, "\u{fffd}");
        assert_eq!(output.exit_code, Some(0));
    }

    #[test]
    fn stderr_keeps_only_the_tail() {
        let mut tail = vec![b'a'; STDERR_TAIL_BYTES];
        append_tail(&mut tail, b"end");
        assert_eq!(tail.len(), STDERR_TAIL_BYTES);
        assert!(tail.ends_with(b"aend"));
    }

    #[test]
    fn extra_env_reaches_the_child() {
        let mut with_env = spec(
            "/bin/sh",
            &["-c", "printf %s \"$CIRCUS_T\""],
            Duration::from_secs(5),
        );
        with_env.extra_env = vec![("CIRCUS_T".to_string(), "v".to_string())];
        assert_eq!(SystemRunner.run(&with_env).expect("sh").stdout, b"v");
    }
}
