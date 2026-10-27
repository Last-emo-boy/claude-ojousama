//! Local classification and short-lived offers. No model calls or clipboard history.
use regex::Regex;
use serde_json::{json, Value};
use std::sync::OnceLock;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Error,
    Code,
    English,
}
impl Kind {
    fn actions(self) -> [(&'static str, &'static str); 2] {
        match self {
            Self::Error => [("fix", "分析报错…"), ("explain", "解释…")],
            Self::Code => [("explain", "解释…"), ("fix", "修复…")],
            Self::English => [("translate", "翻译…"), ("summary", "总结…")],
        }
    }
    fn line(self) -> &'static str {
        match self {
            Self::Error => "复制了一段报错，要一起看看吗？",
            Self::Code => "这段代码，需要我帮你看看吗？",
            Self::English => "复制了一段英文，需要翻译吗？",
        }
    }
}
fn classify(text: &str) -> Option<Kind> {
    static SECRET: OnceLock<Regex> = OnceLock::new();
    static ERROR: OnceLock<Regex> = OnceLock::new();
    let count = text.chars().count();
    if !(24..=8000).contains(&count) || text.len() > 24000 || !text.chars().any(char::is_whitespace)
    {
        return None;
    }
    if SECRET.get_or_init(||Regex::new(r"(?i)password|passwd|pwd|token|secret|api[_-]?key|sk-[a-z0-9]|bearer|private key|BEGIN [A-Z ]*KEY").unwrap()).is_match(text) { return None; }
    let words: Vec<_> = text.split_whitespace().collect();
    if (12..=24).contains(&words.len())
        && words
            .iter()
            .all(|w| (3..=8).contains(&w.len()) && w.bytes().all(|c| c.is_ascii_lowercase()))
    {
        return None;
    }
    if ERROR.get_or_init(||Regex::new(r"(?im)Traceback \(most recent call last\)|\b[A-Za-z]*(Error|Exception): .{3,}|\bUncaught \w+|npm ERR!|\berror (TS|CS|C)\d{3,5}\b|\berror\[E\d{4}\]|^\s*(fatal|panic):|Exception in thread|Segmentation fault|\b(build|compilation) failed\b|\bFAILED\b.*\btests?\b|\b[1-9]\d* (failed|failing)\b|(编译|构建|运行|执行|安装)失败|(报错|异常)[:：]").unwrap()).is_match(text) { return Some(Kind::Error); }
    let symbols = text.chars().filter(|c| "{}();=<>[]".contains(*c)).count();
    let indented = text
        .lines()
        .filter(|line| {
            line.chars().take_while(|c| c.is_whitespace()).count() >= 2 && !line.trim().is_empty()
        })
        .count();
    if text.lines().count() >= 2 && (symbols * 100 > count * 4 || indented >= 2) {
        return Some(Kind::Code);
    }
    let ascii = text.chars().filter(|c| (' '..='~').contains(c)).count();
    let english_words = words
        .iter()
        .filter(|word| {
            word.as_bytes()
                .windows(2)
                .any(|pair| pair.iter().all(u8::is_ascii_alphabetic))
        })
        .count();
    (ascii * 10 > count * 9 && english_words >= 8).then_some(Kind::English)
}
pub fn enabled(d: &Value) -> bool {
    d["settings"]["clipboardWatch"] == true && d["settings"]["clipboardWatchConsent"] == 1
}
struct Offer {
    token: u64,
    until: u64,
    kind: Kind,
    text: String,
}
impl Offer {
    fn notice(&self) -> Value {
        let mut buttons: Vec<_> = self
            .kind
            .actions()
            .into_iter()
            .map(|(id, label)| json!({"id":id,"label":label}))
            .collect();
        buttons.push(json!({"id":"no","label":"不用"}));
        json!({"token":self.token,"until":self.until,"label":"剪贴板","text":self.kind.line(),"buttons":buttons})
    }
}
struct Draft {
    until: u64,
    text: String,
    action: String,
}
#[derive(Default)]
pub struct State {
    epoch: u64,
    baselined: bool,
    last: Option<String>,
    last_offer: Option<u64>,
    token: u64,
    offer: Option<Offer>,
    draft: Option<Draft>,
    pub error: String,
}
impl State {
    pub fn expire(&mut self, now: u64) -> Vec<Value> {
        let mut events = Vec::new();
        if self.offer.as_ref().is_some_and(|o| o.until <= now) {
            events.push(json!({"clear":self.offer.take().unwrap().token}));
        }
        if self.draft.as_ref().is_some_and(|d| d.until <= now) {
            self.draft = None;
        }
        events
    }
    pub fn cancel(&mut self, ticket: u64) -> Vec<Value> {
        if ticket != self.epoch {
            return Vec::new();
        }
        self.reset(true)
    }
    pub fn notice(&self, now: u64) -> Option<Value> {
        self.offer
            .as_ref()
            .filter(|o| o.until > now)
            .map(Offer::notice)
    }
    pub fn pending(&self, now: u64) -> bool {
        self.draft.as_ref().is_some_and(|d| d.until > now)
    }
    pub fn reset(&mut self, draft: bool) -> Vec<Value> {
        self.epoch = self.epoch.wrapping_add(1);
        self.baselined = false;
        self.last = None;
        self.error.clear();
        if draft {
            self.draft = None;
        }
        self.offer
            .take()
            .map(|o| vec![json!({"clear":o.token})])
            .unwrap_or_default()
    }
    pub fn begin(&mut self, enabled: bool, allowed: bool, now: u64) -> (Option<u64>, Vec<Value>) {
        if !enabled {
            return (None, self.reset(true));
        }
        let mut events = self.expire(now);
        if !allowed {
            events.extend(self.reset(false));
            return (None, events);
        }
        if self.draft.is_some() {
            return (None, events);
        }
        self.epoch = self.epoch.wrapping_add(1);
        (Some(self.epoch), events)
    }
    pub fn finish(&mut self, ticket: u64, result: Result<String, String>, now: u64) -> Vec<Value> {
        if ticket != self.epoch {
            return Vec::new();
        }
        let text = match result {
            Ok(t) => t,
            Err(error) => {
                let events = self.reset(false);
                self.error = error;
                return events;
            }
        };
        let text = text.trim();
        self.error.clear();
        let kind = classify(text);
        let changed = self.last.as_deref() != Some(text);
        // Unsuitable and secret-like text is never retained as a baseline.
        self.last = kind.map(|_| text.to_owned());
        if !self.baselined {
            self.baselined = true;
            return Vec::new();
        }
        if !changed {
            return Vec::new();
        }
        let mut events = self
            .offer
            .take()
            .map(|o| vec![json!({"clear":o.token})])
            .unwrap_or_default();
        if let Some(kind) = kind {
            if self
                .last_offer
                .is_none_or(|at| now.saturating_sub(at) >= 120_000)
            {
                self.last_offer = Some(now);
                self.token = self.token.max(now) + 1;
                let offer = Offer {
                    token: self.token,
                    until: now + 20_000,
                    kind,
                    text: text.to_owned(),
                };
                events.push(offer.notice());
                self.offer = Some(offer);
            }
        }
        events
    }
    pub fn choose(&mut self, token: u64, action: &str, now: u64) -> Result<Value, String> {
        let offer = self
            .offer
            .as_ref()
            .filter(|o| o.token == token && o.until > now)
            .ok_or("这条剪贴板提示已过期，请重新复制或使用剪贴板操作。")?;
        if action != "no"
            && action != "preview"
            && !offer.kind.actions().iter().any(|(id, _)| *id == action)
        {
            return Err("这条提示不支持该操作".into());
        }
        let offer = self.offer.take().unwrap();
        self.reset(true);
        if action != "no" {
            self.draft = Some(Draft {
                until: now + 60_000,
                text: offer.text,
                action: action.into(),
            });
        }
        Ok(json!({"clear":token}))
    }
    pub fn take(&mut self, now: u64) -> Result<Value, String> {
        let draft = self
            .draft
            .take()
            .filter(|d| d.until > now)
            .ok_or("剪贴板预览已过期，请重新复制或使用剪贴板操作。")?;
        Ok(json!({"text":draft.text,"action":draft.action,"truncated":false}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const ENGLISH: &str = "The quick brown fox jumps over the lazy dog today.";
    const CODE: &str = "function greet(name) {\n  console.log(name);\n  return name;\n}";
    fn sample(s: &mut State, text: &str, now: u64) -> Vec<Value> {
        let (t, events) = s.begin(true, true, now);
        assert!(events.is_empty());
        s.finish(t.unwrap(), Ok(text.into()), now)
    }
    #[test]
    fn classifier_keeps_original_local_categories_and_ignores_secret_like_content() {
        assert_eq!(classify(ENGLISH), Some(Kind::English));
        assert_eq!(classify(CODE), Some(Kind::Code));
        assert_eq!(
            classify("TypeError: Cannot read properties of undefined"),
            Some(Kind::Error)
        );
        for value in [
            "123456",
            "https://example.com/account/session",
            "bearer this is a secret credential with many spaces",
            "apple beach cat dog eagle field grass happy island joker kettle lemon",
            "This long harmless text contains an api_key variable",
        ] {
            assert!(classify(value).is_none(), "{value}");
        }
    }
    #[test]
    fn baseline_is_silent_offers_never_expose_text_and_duplicates_do_not_renew() {
        let mut s = State::default();
        assert!(sample(&mut s, ENGLISH, 1000).is_empty());
        let events = sample(&mut s, CODE, 5000);
        assert_eq!(events.len(), 1);
        assert!(!events[0].to_string().contains("console.log"));
        assert!(sample(&mut s, CODE, 9000).is_empty());
        assert_eq!(s.notice(9000).unwrap()["until"], 25000);
        let token = events[0]["token"].as_u64().unwrap();
        s.choose(token, "explain", 10000).unwrap();
        assert_eq!(s.take(10001).unwrap()["text"], CODE);
        assert!(s.take(10002).is_err());
    }
    #[test]
    fn revocation_and_new_requests_reject_stale_reads_and_clear_volatile_content() {
        let mut s = State::default();
        let (ticket, _) = s.begin(true, true, 1000);
        s.reset(true);
        assert!(s.finish(ticket.unwrap(), Ok(CODE.into()), 2000).is_empty());
        assert!(s.last.is_none());
        for enabled in [false, true] {
            assert!(s.begin(enabled, false, 3000).0.is_none());
        }
        assert!(!enabled(&json!({"settings":{"clipboardWatch":true}})));
        assert!(enabled(
            &json!({"settings":{"clipboardWatch":true,"clipboardWatchConsent":1}})
        ));
    }
    #[test]
    fn cooldown_expiry_and_baseline_after_pause_prevent_nagging_or_old_copy_offers() {
        let mut s = State::default();
        sample(&mut s, "", 1000);
        sample(&mut s, CODE, 5000);
        let (_, events) = s.begin(true, true, 25000);
        assert_eq!(events.len(), 1);
        assert!(s.notice(25000).is_none());
        assert!(sample(&mut s, ENGLISH, 30000).is_empty());
        s.begin(true, false, 35000);
        assert!(sample(&mut s, CODE, 140000).is_empty());
        assert_eq!(sample(&mut s, ENGLISH, 150000).len(), 1);
    }
    #[test]
    fn choices_are_single_use_and_selected_drafts_expire_without_a_history() {
        let mut s = State::default();
        sample(&mut s, "", 1000);
        let notice = sample(&mut s, ENGLISH, 5000).remove(0);
        let token = notice["token"].as_u64().unwrap();
        assert!(s.choose(token, "fix", 6000).is_err());
        s.choose(token, "translate", 6000).unwrap();
        assert!(s.choose(token, "translate", 6001).is_err());
        assert!(s.pending(6001));
        s.begin(true, true, 66000);
        assert!(!s.pending(66000));
        assert!(s.take(66001).is_err());
    }
    #[test]
    fn a_late_native_read_or_cancel_cannot_erase_a_newer_explicit_selection() {
        let mut s = State::default();
        sample(&mut s, "", 1000);
        let notice = sample(&mut s, ENGLISH, 5000).remove(0);
        let token = notice["token"].as_u64().unwrap();
        let (ticket, _) = s.begin(true, true, 6000);
        s.choose(token, "translate", 6001).unwrap();
        assert!(s.cancel(ticket.unwrap()).is_empty());
        assert!(s.finish(ticket.unwrap(), Ok(CODE.into()), 6002).is_empty());
        assert_eq!(s.take(6003).unwrap()["text"], ENGLISH);
    }
    #[test]
    fn native_errors_are_visible_and_recovery_starts_with_a_new_silent_baseline() {
        let mut s = State::default();
        let (ticket, _) = s.begin(true, true, 1000);
        s.finish(ticket.unwrap(), Err("clipboard unavailable".into()), 1001);
        assert_eq!(s.error, "clipboard unavailable");
        assert!(sample(&mut s, ENGLISH, 5000).is_empty());
        assert!(s.error.is_empty());
        assert!(classify(&"a".repeat(24001)).is_none());
    }
}
