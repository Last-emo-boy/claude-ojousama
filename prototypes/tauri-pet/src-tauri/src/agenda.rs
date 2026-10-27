//! Background scheduling over the existing companion records; no desktop or model access.
use crate::companion;
use chrono::{DateTime, Datelike, Local, NaiveTime, TimeZone, Timelike};
use serde_json::{json, Value};
use std::collections::HashMap;
const MINUTE: u64 = 60_000;

fn local(at: u64) -> Option<DateTime<Local>> {
    Local.timestamp_millis_opt(i64::try_from(at).ok()?).single()
}
pub fn day(at: u64) -> Option<String> {
    Some(local(at)?.format("%Y-%m-%d").to_string())
}
pub fn same_day(value: &Value, at: u64) -> bool {
    let (Some(value), Some(date)) = (value.as_str(), local(at)) else {
        return false;
    };
    value == date.format("%Y-%m-%d").to_string()
        || value == date.format("%a %b %d %Y").to_string()
        || value == format!("{}-{}-{}", date.year(), date.month(), date.day())
}
pub fn used(d: &Value, at: u64) -> u64 {
    if same_day(&d["growth"]["agendaDay"], at) {
        d["growth"]["agendaRuns"].as_u64().unwrap_or(0)
    } else {
        0
    }
}
pub fn available(d: &Value, at: u64) -> bool {
    used(d, at) < d["settings"]["agendaPerDay"].as_u64().unwrap_or(6)
}
pub fn allowed(d: &Value, kind: &str, at: u64) -> bool {
    available(d, at) && enabled(d, kind, at)
}
pub fn enabled(d: &Value, kind: &str, at: u64) -> bool {
    d["settings"]["agendaPerDay"].as_u64().unwrap_or(6) > 0
        && !companion::quiet_hours_at(d, at)
        && !(d["settings"]["focusGuard"] != false
            && d["pomodoro"]["until"].as_u64().unwrap_or(0) > at)
        && if kind == "summary" {
            NaiveTime::parse_from_str(d["settings"]["summaryTime"].as_str().unwrap_or(""), "%H:%M")
                .is_ok()
        } else {
            d["settings"]["rules"]["agenda"] != "off"
                && (kind != "brief" || d["settings"]["morningBrief"] != false)
                && (kind != "pulse"
                    || (d["settings"]["workspacePulse"] != false
                        && d["settings"]["cwd"]
                            .as_str()
                            .is_some_and(|s| !s.trim().is_empty())))
        }
}
#[derive(Default)]
pub struct State {
    active_day: Option<String>,
    last_try: HashMap<String, u64>,
}
impl State {
    pub fn observe_activity(&mut self, at: u64, present: bool) {
        if present {
            self.active_day = day(at);
        }
    }
    pub fn attempted(&mut self, kind: &str, at: u64) {
        self.last_try.insert(kind.into(), at);
    }
    pub fn due(&self, d: &Value, at: u64, idle: f64) -> Option<&'static str> {
        let date = local(at)?;
        let key = date.format("%Y-%m-%d").to_string();
        let tried = |kind: &str, minutes| {
            self.last_try
                .get(kind)
                .is_some_and(|last| at.saturating_sub(*last) < minutes * MINUTE)
        };
        let ready = |kind, minutes| allowed(d, kind, at) && !tried(kind, minutes);
        if ready("summary", 30)
            && !same_day(&d["pet"]["lastSummaryDay"], at)
            && NaiveTime::parse_from_str(
                d["settings"]["summaryTime"].as_str().unwrap_or(""),
                "%H:%M",
            )
            .is_ok_and(|time| date.time() >= time)
        {
            return Some("summary");
        }
        let present = idle.is_finite() && (0.0..120.0).contains(&idle);
        let away = |seconds| idle.is_finite() && idle >= seconds;
        if ready("brief", 30)
            && !same_day(&d["growth"]["lastBriefDay"], at)
            && (5..12).contains(&date.hour())
            && present
            && (same_day(&d["pet"]["lastGreetDay"], at)
                || self.active_day.as_deref() == Some(key.as_str()))
        {
            return Some("brief");
        }
        let fresh = d["activity"]
            .as_array()?
            .iter()
            .filter(|a| {
                a["ts"].as_u64().is_some_and(|ts| {
                    ts > d["growth"]["reflectCursor"].as_u64().unwrap_or(0) && ts <= at
                })
            })
            .count();
        let reflects = if same_day(&d["growth"]["reflectDay"], at) {
            d["growth"]["reflectsToday"].as_u64().unwrap_or(0)
        } else {
            0
        };
        if ready("reflect", 30)
            && reflects < 4
            && fresh >= 10
            && at.saturating_sub(d["growth"]["lastReflectAt"].as_u64().unwrap_or(0)) >= 180 * MINUTE
            && (away(480.0) || date.hour() >= 22)
        {
            return Some("reflect");
        }
        if ready("pulse", 60)
            && !same_day(&d["growth"]["lastPulseDay"], at)
            && date.hour() >= 10
            && away(600.0)
        {
            return Some("pulse");
        }
        let today = d["activity"]
            .as_array()?
            .iter()
            .filter(|a| {
                a["ts"]
                    .as_u64()
                    .is_some_and(|ts| ts <= at && day(ts).as_deref() == Some(key.as_str()))
            })
            .count();
        if ready("tip", 60)
            && !same_day(&d["growth"]["lastTipDay"], at)
            && (14..23).contains(&date.hour())
            && away(300.0)
            && today >= 5
        {
            return Some("tip");
        }
        None
    }
}
pub fn record_start(d: &mut Value, kind: &str, at: u64) -> Result<(), String> {
    let today = day(at).ok_or("系统日期不可用")?;
    let runs = used(d, at);
    d["growth"]["agendaDay"] = json!(today);
    d["growth"]["agendaRuns"] = json!(runs + 1);
    match kind {
        "brief" => d["growth"]["lastBriefDay"] = json!(today),
        "pulse" => d["growth"]["lastPulseDay"] = json!(today),
        "tip" => d["growth"]["lastTipDay"] = json!(today),
        "summary" => d["pet"]["lastSummaryDay"] = json!(today),
        "reflect" => {
            let count = if same_day(&d["growth"]["reflectDay"], at) {
                d["growth"]["reflectsToday"].as_u64().unwrap_or(0)
            } else {
                0
            };
            d["growth"]["reflectDay"] = json!(today);
            d["growth"]["reflectsToday"] = json!(count + 1);
        }
        _ => {}
    }
    Ok(())
}
pub fn record_reflection(d: &mut Value, at: u64) {
    d["growth"]["reflectCursor"] =
        json!(at.max(d["growth"]["reflectCursor"].as_u64().unwrap_or(0)));
    d["growth"]["lastReflectAt"] = json!(at);
}
#[cfg(test)]
mod tests {
    use super::*;
    fn at(hour: u32, minute: u32) -> u64 {
        Local
            .with_ymd_and_hms(2026, 10, 26, hour, minute, 0)
            .single()
            .unwrap()
            .timestamp_millis() as u64
    }
    fn data(acts: usize) -> Value {
        let mut d = companion::defaults();
        d["settings"]["quietStart"] = json!("");
        d["settings"]["summaryTime"] = json!("");
        d["settings"]["cwd"] = json!("controlled workspace");
        d["activity"] = json!((0..acts)
            .map(|i| json!({"ts":at(8,0)+i as u64*1000,"text":"controlled activity"}))
            .collect::<Vec<_>>());
        d
    }
    #[test]
    fn first_observed_activity_or_imported_greeting_enables_one_morning_brief() {
        let mut d = data(0);
        let mut state = State::default();
        assert_eq!(state.due(&d, at(9, 0), 30.0), None);
        state.observe_activity(at(9, 0), false);
        assert_eq!(state.due(&d, at(9, 0), 30.0), None);
        state.observe_activity(at(9, 0), true);
        assert_eq!(state.due(&d, at(9, 0), 30.0), Some("brief"));
        assert_eq!(state.due(&d, at(15, 0), 30.0), None);
        record_start(&mut d, "brief", at(9, 0)).unwrap();
        assert_eq!(State::default().due(&d, at(9, 1), 30.0), None);
        d["growth"]["lastBriefDay"] = json!("");
        d["pet"]["lastGreetDay"] = json!("2026-10-26");
        assert_eq!(State::default().due(&d, at(9, 0), 30.0), Some("brief"));
    }
    #[test]
    fn reflection_pulse_and_tip_keep_the_original_idle_and_activity_thresholds() {
        let mut d = data(12);
        let state = State::default();
        assert_eq!(state.due(&d, at(15, 0), 540.0), Some("reflect"));
        assert_eq!(state.due(&d, at(15, 0), 30.0), None);
        assert_eq!(state.due(&d, at(22, 30), 30.0), Some("reflect"));
        d["growth"]["lastReflectAt"] = json!(at(14, 0));
        assert_eq!(state.due(&d, at(15, 0), 660.0), Some("pulse"));
        d["settings"]["workspacePulse"] = json!(false);
        assert_eq!(state.due(&d, at(15, 0), 660.0), Some("tip"));
        assert_eq!(state.due(&d, at(15, 0), f64::INFINITY), None);
        assert_eq!(state.due(&d, at(15, 0), -1.0), None);
    }
    #[test]
    fn failures_are_throttled_and_reflection_attempts_do_not_advance_the_cursor() {
        let mut d = data(12);
        d["settings"]["workspacePulse"] = json!(false);
        let mut state = State::default();
        state.attempted("reflect", at(15, 0));
        assert_ne!(state.due(&d, at(15, 29), 540.0), Some("reflect"));
        assert_eq!(state.due(&d, at(15, 30), 540.0), Some("reflect"));
        for _ in 0..4 {
            record_start(&mut d, "reflect", at(15, 0)).unwrap();
        }
        assert_eq!(d["growth"]["reflectCursor"], 0);
        assert_eq!(d["growth"]["reflectsToday"], 4);
        assert_ne!(State::default().due(&d, at(15, 0), 540.0), Some("reflect"));
        record_reflection(&mut d, at(15, 0));
        assert_eq!(d["growth"]["reflectCursor"], at(15, 0));
        assert_ne!(state.due(&d, at(18, 0), 540.0), Some("reflect"));
    }
    #[test]
    fn imported_javascript_day_markers_cannot_reset_budget_or_daily_stamps() {
        let mut d = data(0);
        for key in ["Mon Oct 26 2026", "2026-10-26"] {
            d["growth"]["agendaDay"] = json!(key);
            d["growth"]["agendaRuns"] = json!(5);
            assert_eq!(used(&d, at(9, 0)), 5);
            record_start(&mut d, "brief", at(9, 0)).unwrap();
            assert_eq!(used(&d, at(9, 0)), 6);
            assert!(!available(&d, at(9, 0)));
            assert_eq!(used(&d, at(9, 0) + 86_400_000), 0);
            d["growth"]["lastBriefDay"] = json!(key);
            d["growth"]["agendaRuns"] = json!(0);
            d["pet"]["lastGreetDay"] = json!("2026-10-26");
            assert_eq!(State::default().due(&d, at(9, 0), 30.0), None);
        }
        let early = Local
            .with_ymd_and_hms(2026, 1, 5, 9, 0, 0)
            .single()
            .unwrap()
            .timestamp_millis() as u64;
        assert!(same_day(&json!("2026-1-5"), early));
        assert!(same_day(&json!("Mon Jan 05 2026"), early));
    }
    #[test]
    fn summary_has_its_own_time_switch_but_shares_the_existing_native_daily_limit() {
        let mut d = data(0);
        let state = State::default();
        d["settings"]["summaryTime"] = json!("18:30");
        d["settings"]["rules"]["agenda"] = json!("off");
        assert_eq!(state.due(&d, at(18, 29), 30.0), None);
        assert_eq!(state.due(&d, at(18, 30), f64::INFINITY), Some("summary"));
        record_start(&mut d, "summary", at(18, 30)).unwrap();
        assert_eq!(state.due(&d, at(20, 0), 30.0), None);
        d["pet"]["lastSummaryDay"] = json!("");
        d["settings"]["agendaPerDay"] = json!(0);
        assert_eq!(state.due(&d, at(20, 0), 30.0), None);
    }
    #[test]
    fn quiet_focus_switches_and_missing_workspace_stop_only_automatic_work() {
        let mut d = data(12);
        let state = State::default();
        d["settings"]["rules"]["agenda"] = json!("off");
        assert_eq!(state.due(&d, at(15, 0), 660.0), None);
        d["settings"]["rules"]["agenda"] = json!("auto");
        d["settings"]["quietStart"] = json!("14:00");
        d["settings"]["quietEnd"] = json!("16:00");
        assert_eq!(state.due(&d, at(15, 0), 660.0), None);
        d["settings"]["quietStart"] = json!("");
        d["pomodoro"]["until"] = json!(at(16, 0));
        assert_eq!(state.due(&d, at(15, 0), 660.0), None);
        d["settings"]["focusGuard"] = json!(false);
        assert_eq!(state.due(&d, at(15, 0), 660.0), Some("reflect"));
        d["activity"] = json!([]);
        d["settings"]["cwd"] = json!("");
        assert_eq!(state.due(&d, at(15, 0), 660.0), None);
    }
}
