//! The panel renderer is disposable; its unsaved UI state lives for this app session.
use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub tab: Option<String>,
    pub task_id: Option<u64>,
}

#[derive(Default)]
pub struct Session {
    pub view: Value,
    pub phase: Phase,
    pending: Option<Target>,
    pub position: Option<(i32, i32)>,
    pub size: Option<(u32, u32)>,
}

#[derive(Default, PartialEq, Debug)]
pub enum Phase {
    #[default]
    Dormant,
    Loading,
    Ready,
    Closing,
}

impl Session {
    pub fn request(&mut self, tab: Option<String>, task_id: Option<u64>) {
        self.pending = Some(Target { tab, task_id });
    }

    pub fn take_target(&mut self) -> Target {
        self.pending.take().unwrap_or_default()
    }

    pub fn begin_close(&mut self) {
        self.phase = Phase::Closing;
        self.pending = None;
    }

    pub fn closed(&mut self) -> Option<Target> {
        self.phase = Phase::Dormant;
        self.pending.take()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_new_renderer_keeps_drafts_but_consumes_only_the_latest_navigation() {
        let mut session = Session {
            view: json!({"companion":{"drafts":{"weather-form":{"weather-city":"unsaved"}}},"selected":7}),
            position: Some((-100, 80)),
            size: Some((1120, 1080)),
            ..Session::default()
        };
        session.request(Some("tasks".into()), Some(8));
        session.request(Some("settings".into()), None);
        let target = session.take_target();
        assert_eq!(target.tab.as_deref(), Some("settings"));
        assert_eq!(target.task_id, None);
        assert_eq!(session.view["selected"], 7);
        assert_eq!(
            session.view["companion"]["drafts"]["weather-form"]["weather-city"],
            "unsaved"
        );
        assert!(session.take_target().tab.is_none());
        assert_eq!(session.position, Some((-100, 80)));
        assert_eq!(session.size, Some((1120, 1080)));
    }
    #[test]
    fn reopening_during_deferred_native_destruction_is_delivered_after_destroyed() {
        let mut session = Session::default();
        session.begin_close();
        session.request(Some("settings".into()), None);
        session.request(Some("tasks".into()), Some(42));
        assert_eq!(session.phase, Phase::Closing);
        let target = session.closed().unwrap();
        assert_eq!(target.tab.as_deref(), Some("tasks"));
        assert_eq!(target.task_id, Some(42));
        assert_eq!(session.phase, Phase::Dormant);
        assert!(session.closed().is_none());
        session.begin_close();
        assert!(session.closed().is_none());
    }
}
