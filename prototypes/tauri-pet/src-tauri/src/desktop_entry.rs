//! Native desktop preferences. OS effects are rolled back if settings cannot be saved.
use serde_json::{json, Value};
use tauri_plugin_global_shortcut::Shortcut;

pub trait Host {
    fn register(&mut self, key: Shortcut) -> Result<(), String>;
    fn unregister(&mut self, key: Shortcut) -> Result<(), String>;
    fn registered(&self, key: Shortcut) -> bool;
    fn autostart(&self) -> Result<bool, String>;
    fn set_autostart(&mut self, enabled: bool) -> Result<(), String>;
    fn save(&mut self, args: Value) -> Result<Value, String>;
}
#[derive(Default)]
pub struct Controller {
    pub active: Option<Shortcut>,
    pub error: String,
}
#[derive(Clone, Copy)]
enum Effect {
    Register(Shortcut),
    Unregister(Shortcut),
    Autostart(bool),
}
impl Effect {
    fn run(self, host: &mut impl Host) -> Result<(), String> {
        match self {
            Self::Register(k) => host.register(k),
            Self::Unregister(k) => host.unregister(k),
            Self::Autostart(value) => host.set_autostart(value),
        }
    }
}
pub fn shortcut(value: &str) -> Result<Option<Shortcut>, String> {
    if value.trim().is_empty() {
        return Ok(None);
    }
    value
        .trim()
        .parse::<Shortcut>()
        .map(Some)
        .map_err(|e| format!("快捷键格式无效：{e}"))
}
impl Controller {
    pub fn initialize(&mut self, host: &mut impl Host, value: &str, supported: bool) {
        if !supported {
            self.error = "当前 Wayland 桌面不提供全局快捷键，可从面板使用剪贴板操作。".into();
            return;
        }
        match shortcut(value).and_then(|key| {
            if let Some(key) = key {
                host.register(key)?;
            }
            Ok(key)
        }) {
            Ok(key) => {
                self.active = key;
                self.error.clear();
            }
            Err(error) => self.error = error,
        }
        // Login registration is only changed by an explicit settings operation.
    }
    pub fn status(&self, host: &impl Host, supported: bool) -> Value {
        let (enabled, error) = match host.autostart() {
            Ok(value) => (Some(value), String::new()),
            Err(e) => (None, e),
        };
        json!({"hotkeyActive":self.active.is_some_and(|k|host.registered(k)),"shortcutSupported":supported,"activeHotkey":self.active.map(|k|k.to_string()),"error":self.error,"autoStart":enabled,"autoStartError":error})
    }
    pub fn update(
        &mut self,
        host: &mut impl Host,
        args: Value,
        supported: bool,
    ) -> Result<Value, String> {
        let requested = match args.get("hotkey") {
            Some(value) => Some(shortcut(value.as_str().ok_or("快捷键必须是文字")?)?),
            None => None,
        };
        let next = requested.unwrap_or(self.active);
        if requested.is_some() && next.is_some() && !supported {
            return Err("当前桌面不支持全局快捷键，请留空关闭，或在面板使用剪贴板操作".into());
        }
        let mut plan = Vec::new();
        if next != self.active {
            if let Some(key) = next {
                plan.push((Effect::Register(key), Effect::Unregister(key)));
            }
        }
        if let Some(want) = args.get("autoStart") {
            let want = want.as_bool().ok_or("登录后启动必须是开关")?;
            let old = host.autostart()?;
            if old != want {
                plan.push((Effect::Autostart(want), Effect::Autostart(old)));
            }
        }
        if next != self.active {
            if let Some(key) = self.active {
                plan.push((Effect::Unregister(key), Effect::Register(key)));
            }
        }
        let mut undo = Vec::new();
        let result = (|| {
            for (effect, reverse) in plan {
                effect.run(host)?;
                undo.push(reverse);
            }
            host.save(args)
        })();
        match result {
            Ok(value) => {
                self.active = next;
                self.error.clear();
                Ok(value)
            }
            Err(error) => {
                let mut recovery = Vec::new();
                for effect in undo.into_iter().rev() {
                    if let Err(e) = effect.run(host) {
                        recovery.push(e);
                    }
                }
                let error = if recovery.is_empty() {
                    error
                } else {
                    self.active = self
                        .active
                        .filter(|k| host.registered(*k))
                        .or_else(|| next.filter(|k| host.registered(*k)));
                    format!(
                        "{error}；恢复未完成：{}。请检查实际状态后重新保存；残留快捷键可重启清理。",
                        recovery.join("；")
                    )
                };
                self.error = error.clone();
                Err(error)
            }
        }
    }
}
pub fn clipboard_allowed(lock_detection: bool, unlocked: bool, focused: bool) -> bool {
    focused && (!lock_detection || unlocked)
}
pub fn clipboard_preview(text: String) -> Result<Value, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("剪贴板里没有文字，请先复制或直接粘贴。".into());
    }
    let mut preview = String::new();
    for c in text.chars().take(12_000) {
        if preview.len() + c.len_utf8() > 24_000 {
            break;
        }
        preview.push(c);
    }
    Ok(json!({"truncated":preview.len()<text.len(),"text":preview}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Default)]
    struct Fake {
        keys: Vec<Shortcut>,
        auto: bool,
        fail_register: Option<Shortcut>,
        fail_auto: bool,
        fail_save: bool,
        fail_read: bool,
        fail_restore: bool,
        saved: Option<Value>,
    }
    impl Host for Fake {
        fn register(&mut self, k: Shortcut) -> Result<(), String> {
            if self.fail_register == Some(k) {
                return Err("occupied".into());
            }
            self.keys.push(k);
            Ok(())
        }
        fn unregister(&mut self, k: Shortcut) -> Result<(), String> {
            self.keys.retain(|v| *v != k);
            Ok(())
        }
        fn registered(&self, k: Shortcut) -> bool {
            self.keys.contains(&k)
        }
        fn autostart(&self) -> Result<bool, String> {
            if self.fail_read {
                Err("cannot read startup".into())
            } else {
                Ok(self.auto)
            }
        }
        fn set_autostart(&mut self, value: bool) -> Result<(), String> {
            if self.fail_auto || (self.fail_restore && !value) {
                return Err("cannot change startup".into());
            }
            self.auto = value;
            Ok(())
        }
        fn save(&mut self, args: Value) -> Result<Value, String> {
            if self.fail_save {
                return Err("disk full".into());
            }
            self.saved = Some(args.clone());
            Ok(args)
        }
    }
    fn key(value: &str) -> Shortcut {
        shortcut(value).unwrap().unwrap()
    }
    fn existing() -> (Controller, Fake) {
        let k = key("Ctrl+Alt+Q");
        (
            Controller {
                active: Some(k),
                error: String::new(),
            },
            Fake {
                keys: vec![k],
                ..Fake::default()
            },
        )
    }
    #[test]
    fn parses_legacy_accelerators_and_empty_disables_but_bad_order_is_rejected() {
        assert!(shortcut("CommandOrControl+Alt+Q").unwrap().is_some());
        assert!(shortcut("").unwrap().is_none());
        assert!(shortcut("Ctrl+Q+Alt").is_err());
    }
    #[test]
    fn startup_conflict_is_nonfatal_and_never_changes_login_registration() {
        let mut host = Fake {
            auto: true,
            fail_register: Some(key("Ctrl+Alt+Q")),
            ..Fake::default()
        };
        let mut state = Controller::default();
        state.initialize(&mut host, "Ctrl+Alt+Q", true);
        assert!(state.active.is_none());
        assert!(!state.error.is_empty());
        assert!(host.auto);
        assert!(host.saved.is_none());
    }
    #[test]
    fn occupied_replacement_keeps_the_previous_key_and_saved_preferences() {
        let (mut state, mut host) = existing();
        host.fail_register = Some(key("Ctrl+Alt+W"));
        assert!(state
            .update(
                &mut host,
                json!({"hotkey":"Ctrl+Alt+W","autoStart":true}),
                true
            )
            .is_err());
        assert_eq!(host.keys, vec![key("Ctrl+Alt+Q")]);
        assert!(!host.auto);
        assert!(host.saved.is_none());
    }
    #[test]
    fn startup_failure_removes_the_new_key_without_dropping_the_old_one() {
        let (mut state, mut host) = existing();
        host.fail_auto = true;
        assert!(state
            .update(
                &mut host,
                json!({"hotkey":"Ctrl+Alt+W","autoStart":true}),
                true
            )
            .is_err());
        assert_eq!(host.keys, vec![key("Ctrl+Alt+Q")]);
        assert!(!host.auto);
        assert!(host.saved.is_none());
    }
    #[test]
    fn failed_save_restores_both_os_settings() {
        let (mut state, mut host) = existing();
        host.fail_save = true;
        assert!(state
            .update(
                &mut host,
                json!({"hotkey":"Ctrl+Alt+W","autoStart":true}),
                true
            )
            .is_err());
        assert_eq!(host.keys, vec![key("Ctrl+Alt+Q")]);
        assert!(!host.auto);
        assert_eq!(state.active, Some(key("Ctrl+Alt+Q")));
    }
    #[test]
    fn failed_rollback_reports_actual_startup_state_and_keeps_recovering_the_key() {
        let (mut state, mut host) = existing();
        host.fail_save = true;
        host.fail_restore = true;
        let error = state
            .update(
                &mut host,
                json!({"hotkey":"Ctrl+Alt+W","autoStart":true}),
                true,
            )
            .unwrap_err();
        assert!(error.contains("恢复未完成"));
        assert_eq!(host.keys, vec![key("Ctrl+Alt+Q")]);
        assert_eq!(state.status(&host, true)["autoStart"], true);
        assert!(host.saved.is_none());
    }
    #[test]
    fn save_can_enable_startup_and_disable_the_key_and_later_disable_startup() {
        let (mut state, mut host) = existing();
        state
            .update(&mut host, json!({"hotkey":"","autoStart":true}), true)
            .unwrap();
        assert!(state.active.is_none());
        assert!(host.keys.is_empty());
        assert!(host.auto);
        state
            .update(&mut host, json!({"autoStart":false}), true)
            .unwrap();
        assert!(!host.auto);
    }
    #[test]
    fn ordinary_settings_do_not_require_startup_access_or_global_key_support() {
        let (mut state, mut host) = existing();
        host.fail_read = true;
        state
            .update(&mut host, json!({"userName":"test"}), false)
            .unwrap();
        assert_eq!(host.saved.unwrap()["userName"], "test");
        assert_eq!(host.keys, vec![key("Ctrl+Alt+Q")]);
    }
    #[test]
    fn explicit_focused_wayland_clipboard_reads_do_not_require_x11_idle_tracking() {
        assert!(clipboard_allowed(false, false, true));
        assert!(!clipboard_allowed(false, false, false));
        assert!(!clipboard_allowed(true, false, true));
        assert!(clipboard_allowed(true, true, true));
    }
    #[test]
    fn clipboard_preview_is_unicode_bounded_and_never_saved() {
        assert!(clipboard_preview("  ".into()).is_err());
        let v = clipboard_preview("🌻".repeat(12_001)).unwrap();
        assert_eq!(v["text"].as_str().unwrap().chars().count(), 6_000);
        assert_eq!(v["text"].as_str().unwrap().len(), 24_000);
        assert_eq!(v["truncated"], true);
        assert_eq!(
            clipboard_preview(" hello ".into()).unwrap()["text"],
            "hello"
        );
    }
}
