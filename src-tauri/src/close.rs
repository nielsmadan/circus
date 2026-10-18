use std::time::{Duration, Instant};

pub const ACK_TIMEOUT: Duration = Duration::from_secs(5);
pub const FINISH_TIMEOUT: Duration = Duration::from_secs(450);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAction {
    Allow,
    Notify { first: bool },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CloseEffects {
    pub prevent: bool,
    pub emit: bool,
    pub spawn_watchdog: bool,
}

pub fn close_effects(action: CloseAction) -> CloseEffects {
    match action {
        CloseAction::Allow => CloseEffects {
            prevent: false,
            emit: false,
            spawn_watchdog: false,
        },
        CloseAction::Notify { first } => CloseEffects {
            prevent: true,
            emit: true,
            spawn_watchdog: first,
        },
    }
}

#[derive(Debug, Default)]
pub struct CloseGate {
    pending: u32,
    closing_since: Option<Instant>,
    acked: bool,
    exiting: bool,
}

impl CloseGate {
    pub fn set_pending(&mut self, count: u32) {
        self.pending = count;
    }

    pub fn request(&mut self, now: Instant) -> CloseAction {
        if self.exiting {
            return CloseAction::Allow;
        }
        match self.closing_since {
            None if self.pending == 0 => {
                self.exiting = true;
                CloseAction::Allow
            }
            None => {
                self.closing_since = Some(now);
                CloseAction::Notify { first: true }
            }
            Some(_) => CloseAction::Notify { first: false },
        }
    }

    pub fn ack(&mut self) {
        self.acked = true;
    }

    pub fn begin_exit(&mut self) -> bool {
        !std::mem::replace(&mut self.exiting, true)
    }

    pub fn fallback_due(&self, now: Instant) -> bool {
        match self.closing_since {
            Some(since) if !self.exiting => {
                let waited = now.saturating_duration_since(since);
                (!self.acked && waited >= ACK_TIMEOUT) || waited >= FINISH_TIMEOUT
            }
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn closing_gate(start: Instant) -> CloseGate {
        let mut gate = CloseGate::default();
        gate.set_pending(2);
        assert_eq!(gate.request(start), CloseAction::Notify { first: true });
        gate
    }

    #[test]
    fn nothing_pending_allows_the_close() {
        let mut gate = CloseGate::default();
        assert_eq!(gate.request(Instant::now()), CloseAction::Allow);
        assert_eq!(gate.request(Instant::now()), CloseAction::Allow);
    }

    #[test]
    fn pending_work_notifies_once_as_first() {
        let start = Instant::now();
        let mut gate = closing_gate(start);
        assert_eq!(gate.request(start), CloseAction::Notify { first: false });
    }

    #[test]
    fn an_unacked_close_falls_back_after_the_ack_timeout() {
        let start = Instant::now();
        let gate = closing_gate(start);
        assert!(!gate.fallback_due(start + Duration::from_secs(4)));
        assert!(gate.fallback_due(start + Duration::from_secs(5)));
    }

    #[test]
    fn an_acked_close_falls_back_after_the_finish_timeout() {
        let start = Instant::now();
        let mut gate = closing_gate(start);
        gate.ack();
        assert!(!gate.fallback_due(start + Duration::from_secs(449)));
        assert!(gate.fallback_due(start + Duration::from_secs(450)));
    }

    #[test]
    fn allow_has_no_effects() {
        assert_eq!(
            close_effects(CloseAction::Allow),
            CloseEffects {
                prevent: false,
                emit: false,
                spawn_watchdog: false
            }
        );
    }

    #[test]
    fn only_the_first_notify_spawns_the_watchdog() {
        assert_eq!(
            close_effects(CloseAction::Notify { first: true }),
            CloseEffects {
                prevent: true,
                emit: true,
                spawn_watchdog: true
            }
        );
        assert_eq!(
            close_effects(CloseAction::Notify { first: false }),
            CloseEffects {
                prevent: true,
                emit: true,
                spawn_watchdog: false
            }
        );
    }

    #[test]
    fn begin_exit_succeeds_only_once() {
        let mut gate = CloseGate::default();
        assert!(gate.begin_exit());
        assert!(!gate.begin_exit());
    }

    #[test]
    fn after_begin_exit_every_request_is_allowed() {
        let start = Instant::now();
        let mut gate = closing_gate(start);
        assert!(gate.begin_exit());
        assert_eq!(gate.request(start), CloseAction::Allow);
        assert!(!gate.fallback_due(start + FINISH_TIMEOUT));
    }
}
