use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DecisionAction {
    Harvest,
    Archive,
    Delete,
    Snooze,
    Keep,
    KeepGoing,
}

impl DecisionAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Harvest => "harvest",
            Self::Archive => "archive",
            Self::Delete => "delete",
            Self::Snooze => "snooze",
            Self::Keep => "keep",
            Self::KeepGoing => "keep_going",
        }
    }
}

#[derive(Deserialize, Clone, Debug)]
pub struct TailsRequest {
    pub ids: Vec<String>,
    pub max_chars: Option<u32>,
}

// serde ignores every other field; responses are never parsed into a JSON value tree
#[derive(Deserialize, Debug)]
pub struct Envelope {
    pub kind: String,
    pub version: u64,
    #[serde(default)]
    pub message: Option<String>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct DecideRequest {
    pub action: DecisionAction,
    pub id: String,
    pub mtime: String,
    pub fingerprint: Option<String>,
    pub until: Option<String>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct ResumeRequest {
    pub id: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct ResumeLaunch {
    pub command: String,
    pub launched: bool,
    pub via: TerminalKind,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TerminalKind {
    Iterm2,
    Custom,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RlSource {
    Env,
    Settings,
    LoginShell,
    Fallback,
    Missing,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ShellProbeState {
    Ok,
    TimedOut,
    Failed,
    Skipped,
}

#[derive(Serialize, Clone, Debug)]
pub struct AppInfo {
    pub rl_command: Vec<String>,
    pub rl_source: RlSource,
    pub shell_probe: ShellProbeState,
    pub environment_label: Option<String>,
    pub world_root: Option<String>,
    pub resume_dry_run: bool,
    pub terminal: TerminalKind,
    pub settings_path: String,
}
