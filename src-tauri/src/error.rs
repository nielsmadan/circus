use serde::Serialize;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    RlNotFound,
    RlTooOld,
    Timeout,
    Failed,
    RlError,
    BadOutput,
    InvalidArgument,
    Launch,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct CircusError {
    pub kind: ErrorKind,
    pub message: String,
    pub exit_code: Option<i32>,
    pub stderr_tail: Option<String>,
}

impl CircusError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            exit_code: None,
            stderr_tail: None,
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::InvalidArgument, message)
    }
}

impl std::fmt::Display for CircusError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.kind, self.message)
    }
}

impl std::error::Error for CircusError {}
