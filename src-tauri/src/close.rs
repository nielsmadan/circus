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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Watch {
    Wait,
    Exit,
    Stop,
}

#[derive(Debug, Default)]
pub struct CloseGate {
    pending: u32,
    closing_since: Option<Instant>,
    acked: bool,
    exiting: bool,
    round: u64,
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
                self.round += 1;
                CloseAction::Notify { first: true }
            }
            Some(_) => CloseAction::Notify { first: false },
        }
    }

    pub fn ack(&mut self) {
        self.acked = true;
    }

    pub fn cancel(&mut self) {
        if !self.exiting {
            self.closing_since = None;
            self.acked = false;
        }
    }

    pub fn round(&self) -> u64 {
        self.round
    }

    pub fn finish_in(&self, now: Instant) -> Duration {
        self.closing_since.map_or(FINISH_TIMEOUT, |since| {
            FINISH_TIMEOUT.saturating_sub(now.saturating_duration_since(since))
        })
    }

    pub fn watch(&mut self, now: Instant, round: u64) -> Watch {
        if self.exiting || self.round != round || self.closing_since.is_none() {
            return Watch::Stop;
        }
        if self.fallback_due(now) && self.begin_exit() {
            Watch::Exit
        } else {
            Watch::Wait
        }
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
    fn a_cancelled_close_never_falls_back() {
        let start = Instant::now();
        let mut gate = closing_gate(start);
        gate.ack();
        let round = gate.round();
        gate.cancel();
        assert!(!gate.fallback_due(start + FINISH_TIMEOUT));
        assert_eq!(gate.watch(start + FINISH_TIMEOUT, round), Watch::Stop);
    }

    #[test]
    fn a_close_after_a_cancel_starts_a_new_round_and_deadline() {
        let start = Instant::now();
        let mut gate = closing_gate(start);
        let first_round = gate.round();
        gate.cancel();
        let later = start + Duration::from_secs(400);
        assert_eq!(gate.request(later), CloseAction::Notify { first: true });
        gate.ack();
        assert_eq!(gate.watch(start + FINISH_TIMEOUT, first_round), Watch::Stop);
        assert_eq!(
            gate.watch(start + FINISH_TIMEOUT, gate.round()),
            Watch::Wait
        );
        assert_eq!(gate.finish_in(later), FINISH_TIMEOUT);
        assert_eq!(
            gate.watch(later + FINISH_TIMEOUT, gate.round()),
            Watch::Exit
        );
    }

    #[test]
    fn the_watch_exits_once_when_due() {
        let start = Instant::now();
        let mut gate = closing_gate(start);
        let round = gate.round();
        assert_eq!(gate.watch(start, round), Watch::Wait);
        assert_eq!(gate.watch(start + ACK_TIMEOUT, round), Watch::Exit);
        assert_eq!(gate.watch(start + ACK_TIMEOUT, round), Watch::Stop);
    }

    #[test]
    fn finish_in_counts_down_from_the_first_request() {
        let start = Instant::now();
        let mut gate = closing_gate(start);
        assert_eq!(gate.finish_in(start), FINISH_TIMEOUT);
        let again = start + Duration::from_secs(100);
        assert_eq!(gate.request(again), CloseAction::Notify { first: false });
        assert_eq!(gate.finish_in(again), Duration::from_secs(350));
        assert_eq!(gate.finish_in(start + FINISH_TIMEOUT * 2), Duration::ZERO);
    }

    #[test]
    fn cancel_after_begin_exit_keeps_exiting() {
        let start = Instant::now();
        let mut gate = closing_gate(start);
        assert!(gate.begin_exit());
        gate.cancel();
        assert_eq!(gate.request(start), CloseAction::Allow);
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
