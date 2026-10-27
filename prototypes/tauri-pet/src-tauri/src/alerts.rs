//! Persistent reminders; displaying a bubble and acknowledging an item are separate events.
use crate::companion::{self, id};
use serde_json::{json, Value};
const MINUTE: u64 = 60_000;
const DAY: u64 = 1440 * MINUTE;

pub fn actionable(alert: &Value) -> bool {
    matches!(
        alert["kind"].as_str(),
        Some("reminder" | "todo-soon" | "todo-overdue" | "pomodoro")
    )
}
pub fn buttons(alert: &Value) -> Value {
    match alert["kind"].as_str().unwrap_or("") {
        "todo-soon" => json!([{"id":"done","label":"已完成"},{"id":"ok","label":"马上做"}]),
        "todo-overdue" => {
            json!([{"id":"done","label":"已完成"},{"id":"later","label":"推迟 1 小时"}])
        }
        "reminder" | "pomodoro" => {
            json!([{"id":"ok","label":"知道了"},{"id":"snooze","label":"10 分钟后"}])
        }
        _ => json!([]),
    }
}
pub fn prune(d: &mut Value) -> bool {
    let keep: Vec<_> = d["alerts"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|a| {
            let reference = id(&a["refId"]);
            match a["kind"].as_str().unwrap_or("") {
                "reminder" => d["reminders"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|r| id(&r["id"]) == reference),
                "todo-soon" | "todo-overdue" => d["todos"].as_array().unwrap().iter().any(|t| {
                    id(&t["id"]) == reference
                        && t["done"] != true
                        && t["due"].as_u64().is_some_and(|n| n > 0)
                        && (a.get("sourceDue").is_none() || a["sourceDue"] == t["due"])
                }),
                "goal-ask" => d["goals"].as_array().unwrap().iter().any(|g| {
                    id(&g["id"]) == reference
                        && matches!(g["status"].as_str(), Some("active" | "waiting"))
                        && g["question"].is_object()
                }),
                _ => true,
            }
        })
        .cloned()
        .collect();
    let changed = keep.len() != d["alerts"].as_array().unwrap().len();
    if changed {
        d["alerts"] = json!(keep);
    }
    changed
}
fn raise(d: &mut Value, kind: &str, source: &Value, at: u64, text: String, now: u64) {
    let reference = &source["id"];
    d["alerts"].as_array_mut().unwrap().retain(|a| {
        let previous = a["kind"].as_str().unwrap_or("");
        id(&a["refId"]) != id(reference)
            || !(previous == kind || (previous.starts_with("todo-") && kind.starts_with("todo-")))
    });
    let mut alert = json!({"id":format!("native:{kind}:{}:{at}",id(reference)),"kind":kind,"refId":reference,"text":text,"count":0,"nextAt":now,"createdAt":now});
    if kind.starts_with("todo-") {
        alert["sourceDue"] = json!(at);
    }
    d["alerts"].as_array_mut().unwrap().push(alert);
    companion::log(d, "reminder", &text);
}
pub fn reconcile(d: &mut Value, now: u64) -> bool {
    let mut changed = prune(d);
    for r in d["reminders"].as_array().unwrap().clone() {
        let Some(at) = r["at"].as_u64().filter(|at| *at <= now) else {
            continue;
        };
        if r["fired"] == true {
            continue;
        }
        raise(
            d,
            "reminder",
            &r,
            at,
            r["text"].as_str().unwrap_or("提醒到时间了").into(),
            now,
        );
        let item = d["reminders"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|v| v["id"] == r["id"])
            .unwrap();
        if r["repeat"] == "daily" {
            // Preserve the original daily time after a suspended or closed session.
            item["at"] = json!(at
                .saturating_add((now - at) / DAY * DAY)
                .saturating_add(DAY));
        } else {
            item["fired"] = json!(true);
        }
        changed = true;
    }
    for t in d["todos"].as_array().unwrap().clone() {
        let Some(due) = t["due"].as_u64().filter(|n| *n > 0) else {
            continue;
        };
        if t["done"] == true {
            continue;
        }
        let (kind, text) = if due <= now && t["overdue"] != true {
            (
                "todo-overdue",
                format!(
                    "「{}」已经到期，要完成还是延后？",
                    t["text"].as_str().unwrap_or("待办")
                ),
            )
        } else if due > now && due - now <= 10 * MINUTE && t["warned"] != true {
            (
                "todo-soon",
                format!("「{}」快到时间了。", t["text"].as_str().unwrap_or("待办")),
            )
        } else {
            continue;
        };
        raise(d, kind, &t, due, text, now);
        let item = d["todos"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|v| v["id"] == t["id"])
            .unwrap();
        item["warned"] = json!(true);
        if kind == "todo-overdue" {
            item["overdue"] = json!(true);
        }
        changed = true;
    }
    if let Some(until) = d["pomodoro"]["until"]
        .as_u64()
        .filter(|at| *at > 0 && *at <= now)
    {
        raise(
            d,
            "pomodoro",
            &json!({"id":until}),
            until,
            "专注结束，伸个懒腰吧。".into(),
            now,
        );
        d["pomodoro"]["until"] = json!(0);
        changed = true;
    }
    changed
}
pub fn due(d: &Value, now: u64) -> Option<Value> {
    let nag = d["settings"]["nagMinutes"].as_u64().unwrap_or(5);
    d["alerts"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|a| {
            let count = a["count"].as_u64().unwrap_or(0);
            actionable(a)
                && a["nextAt"].as_u64().unwrap_or(0) <= now
                && (count == 0 || (nag > 0 && count < 3))
        })
        .min_by_key(|a| {
            (
                a["nextAt"].as_u64().unwrap_or(0),
                a["createdAt"].as_u64().unwrap_or(0),
            )
        })
        .cloned()
}
pub fn shown(d: &mut Value, alert_id: &Value, now: u64, until: u64) -> bool {
    let nag = d["settings"]["nagMinutes"].as_u64().unwrap_or(5).min(1440);
    let Some(a) = d["alerts"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|a| id(&a["id"]) == id(alert_id))
    else {
        return false;
    };
    a["count"] = json!(a["count"].as_u64().unwrap_or(0) + 1);
    a["shownAt"] = json!(now);
    a["nextAt"] = json!(until.saturating_add(nag * MINUTE));
    true
}
pub fn respond(d: &mut Value, args: &Value, now: u64) -> Result<Value, String> {
    let a = d["alerts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| id(&a["id"]) == id(&args["id"]))
        .cloned()
        .ok_or("这条提醒已经处理")?;
    let choice = args["choice"].as_str().unwrap_or("");
    if !buttons(&a)
        .as_array()
        .unwrap()
        .iter()
        .any(|b| b["id"] == choice)
    {
        return Err("这条提醒不支持该操作".into());
    }
    let kind = a["kind"].as_str().unwrap_or("");
    if choice == "done" {
        companion::apply(
            d,
            "todo:update",
            json!({"id":a["refId"],"patch":{"done":true}}),
        )?;
    }
    if choice == "later" {
        companion::apply(
            d,
            "todo:update",
            json!({"id":a["refId"],"patch":{"due":now+60*MINUTE}}),
        )?;
    }
    if choice == "snooze" {
        let text = d["reminders"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| kind == "reminder" && id(&r["id"]) == id(&a["refId"]))
            .map(|r| r["text"].clone())
            .unwrap_or_else(|| a["text"].clone());
        companion::apply(d, "reminder:add", json!({"text":text,"at":now+10*MINUTE}))?;
    }
    d["alerts"]
        .as_array_mut()
        .unwrap()
        .retain(|item| id(&item["id"]) != id(&a["id"]));
    companion::log(
        d,
        "reminder",
        &format!("{} → {}", a["text"].as_str().unwrap_or("提醒"), choice),
    );
    Ok(Value::Null)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reminder_survives_ignored_bubbles_and_is_reconciled_only_once() {
        let mut d = companion::defaults();
        d["reminders"] = json!([{"id":"old","text":"休息","at":1000}]);
        assert!(reconcile(&mut d, 2000));
        assert!(!reconcile(&mut d, 3000));
        let a = due(&d, 3000).unwrap();
        for n in 1..=3 {
            assert!(shown(&mut d, &a["id"], n * 1_000_000, n * 1_000_000));
        }
        assert!(due(&d, 9_000_000).is_none());
        assert_eq!(d["alerts"].as_array().unwrap().len(), 1);
        respond(
            &mut d,
            &json!({"id":a["id"],"choice":"ok"}),
            companion::now(),
        )
        .unwrap();
        assert!(d["alerts"].as_array().unwrap().is_empty());
    }
    #[test]
    fn daily_schedule_keeps_the_original_time_after_missing_multiple_days() {
        let mut d = companion::defaults();
        d["reminders"] = json!([{"id":1,"text":"每日","at":1000,"repeat":"daily"}]);
        reconcile(&mut d, 1000 + 2 * DAY + 7 * MINUTE);
        assert_eq!(d["reminders"][0]["at"], 1000 + 3 * DAY);
        assert_eq!(d["alerts"].as_array().unwrap().len(), 1);
    }
    #[test]
    fn snooze_creates_one_reminder_without_changing_daily_recurrence() {
        let now = companion::now();
        let mut d = companion::defaults();
        d["reminders"] = json!([{"id":"legacy","text":"喝水","at":now-1000,"repeat":"daily"}]);
        reconcile(&mut d, now);
        let a = d["alerts"][0].clone();
        let next = d["reminders"][0]["at"].clone();
        respond(&mut d, &json!({"id":a["id"],"choice":"snooze"}), now).unwrap();
        assert_eq!(d["reminders"].as_array().unwrap().len(), 2);
        let rows = d["reminders"].as_array().unwrap();
        assert_eq!(
            rows.iter().find(|r| r["id"] == "legacy").unwrap()["at"],
            next
        );
        assert_eq!(
            rows.iter().find(|r| r["id"] != "legacy").unwrap()["at"],
            now + 10 * MINUTE
        );
        assert!(respond(&mut d, &json!({"id":a["id"],"choice":"snooze"}), now).is_err());
    }
    #[test]
    fn todo_soon_is_replaced_by_overdue_and_can_be_completed_or_rescheduled() {
        let now = companion::now();
        let mut d = companion::defaults();
        d["todos"] = json!([{"id":"old","text":"交作业","due":now+MINUTE,"done":false}]);
        reconcile(&mut d, now);
        assert_eq!(d["alerts"][0]["kind"], "todo-soon");
        reconcile(&mut d, now + 2 * MINUTE);
        assert_eq!(d["alerts"].as_array().unwrap().len(), 1);
        let a = d["alerts"][0].clone();
        assert_eq!(a["kind"], "todo-overdue");
        respond(
            &mut d,
            &json!({"id":a["id"],"choice":"later"}),
            now + 2 * MINUTE,
        )
        .unwrap();
        assert_eq!(d["todos"][0]["due"], now + 62 * MINUTE);
        assert_eq!(d["todos"][0]["warned"], false);
        assert_eq!(d["todos"][0]["overdue"], false);
        reconcile(&mut d, now + 70 * MINUTE);
        let a = d["alerts"][0].clone();
        respond(
            &mut d,
            &json!({"id":a["id"],"choice":"done"}),
            now + 70 * MINUTE,
        )
        .unwrap();
        prune(&mut d);
        assert_eq!(d["todos"][0]["done"], true);
        assert!(d["alerts"].as_array().unwrap().is_empty());
    }
    #[test]
    fn removed_sources_are_pruned_and_disabling_nags_keeps_the_first_notification() {
        let mut d = companion::defaults();
        d["settings"]["nagMinutes"] = json!(0);
        d["reminders"] = json!([{"id":1,"text":"test","at":1}]);
        reconcile(&mut d, 2);
        let a = due(&d, 2).unwrap();
        shown(&mut d, &a["id"], 2, 30_000);
        assert!(due(&d, 1_000_000).is_none());
        d["reminders"] = json!([]);
        assert!(prune(&mut d));
        assert!(d["alerts"].as_array().unwrap().is_empty());
    }
    #[test]
    fn expired_focus_sessions_create_one_persistent_alert() {
        let mut d = companion::defaults();
        d["pomodoro"]["until"] = json!(1000);
        assert!(reconcile(&mut d, 2000));
        assert!(!reconcile(&mut d, 3000));
        assert_eq!(d["alerts"][0]["kind"], "pomodoro");
    }
}
