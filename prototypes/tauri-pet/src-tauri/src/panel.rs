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
    pub ready: bool,
    pub parked: bool,
    pub target: Target,
    pub position: Option<(i32, i32)>,
    pub size: Option<(u32, u32)>,
}

impl Session {
    pub fn request(&mut self, tab: Option<String>, task_id: Option<u64>) {
        self.target = Target { tab, task_id };
    }

    pub fn take_target(&mut self) -> Target {
        std::mem::take(&mut self.target)
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
}
