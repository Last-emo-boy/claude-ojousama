//! Persistent companion data. The legacy JSON schema remains the migration boundary.
use chrono::{Duration, Local, NaiveTime, TimeZone};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn defaults() -> Value {
    let mut data: Value =
        serde_json::from_str(include_str!("../../../../assets/companion-defaults.json"))
            .expect("valid shared defaults");
    data["observation"] = json!({"enabled":false,"consentVersion":0,"intervalSeconds":120,"maxPerHour":4,"quiet":true,"excludeApps":"","pausedUntil":0});
    data["pomodoro"] = json!({"until":0,"minutes":25});
    data
}
pub fn save(path: &Path, data: &Value) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    fs::write(
        &tmp,
        serde_json::to_vec_pretty(data).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    #[cfg(not(windows))]
    fs::rename(tmp, path).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        extern "system" {
            fn MoveFileExW(a: *const u16, b: *const u16, flags: u32) -> i32;
        }
        let a: Vec<_> = tmp.as_os_str().encode_wide().chain(Some(0)).collect();
        let b: Vec<_> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe { MoveFileExW(a.as_ptr(), b.as_ptr(), 1 | 8) } == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    Ok(())
}
#[derive(Clone)]
pub struct Companion {
    data: Arc<Mutex<Value>>,
    path: PathBuf,
}
impl Companion {
    pub fn open(path: PathBuf, legacy: Option<&Path>) -> Result<Self, String> {
        let mut data = defaults();
        let source = if path.exists() {
            Some(path.as_path())
        } else {
            legacy.filter(|p| p.is_file())
        };
        if let Some(source) = source {
            let imported: Value =
                serde_json::from_slice(&fs::read(source).map_err(|e| e.to_string())?)
                    .map_err(|e| format!("旧数据无法读取，原文件已保留：{e}"))?;
            let object = imported.as_object().ok_or("旧数据不是对象，未进行迁移")?;
            for (key, value) in object {
                if value.is_object() && data[key].is_object() {
                    for (k, v) in value.as_object().unwrap() {
                        data[key][k] = v.clone();
                    }
                } else {
                    data[key] = value.clone();
                }
            }
            if imported.get("settings").is_some() && imported["settings"].get("backend").is_none() {
                data["settings"]["backend"] = json!("dsh");
            }
            if source != path {
                fs::copy(source, path.with_extension("legacy-backup.json"))
                    .map_err(|e| e.to_string())?;
            }
        }
        save(&path, &data)?;
        Ok(Self {
            data: Arc::new(Mutex::new(data)),
            path,
        })
    }
    pub fn snapshot(&self) -> Value {
        self.data.lock().unwrap().clone()
    }
    pub fn change<T>(&self, f: impl FnOnce(&mut Value) -> Result<T, String>) -> Result<T, String> {
        let mut current = self.data.lock().unwrap();
        let mut updated = current.clone();
        let result = f(&mut updated)?;
        save(&self.path, &updated)?;
        *current = updated;
        Ok(result)
    }
    pub fn apply(&self, command: &str, args: Value) -> Result<Value, String> {
        self.change(|d| apply(d, command, args))
    }
}
pub fn log(d: &mut Value, kind: &str, text: &str) {
    let items = d["activity"].as_array_mut().unwrap();
    items.insert(
        0,
        json!({"id":now(),"ts":now(),"kind":kind,"text":text,"icon":"✦"}),
    );
    items.truncate(300);
}
fn text(v: &Value, key: &str) -> Result<String, String> {
    let t = v[key].as_str().unwrap_or("").trim();
    if t.is_empty() || t.chars().count() > 2000 {
        Err("请输入 1–2000 字的内容".into())
    } else {
        Ok(t.into())
    }
}
fn id(v: &Value) -> String {
    v.as_str()
        .map(String::from)
        .unwrap_or_else(|| v.to_string())
}
fn rows<'a>(d: &'a mut Value, key: &str) -> Result<&'a mut Vec<Value>, String> {
    d[key]
        .as_array_mut()
        .ok_or_else(|| format!("{key} 数据无法读取"))
}
fn next_id(items: &[Value]) -> u64 {
    items
        .iter()
        .filter_map(|x| x["id"].as_u64())
        .max()
        .unwrap_or(0)
        .max(now())
        + 1
}
pub fn next_check(goal: &Value, from: u64) -> u64 {
    match goal["every"].as_str().unwrap_or("daily") {
        "hourly" => from + 3_600_000,
        "3h" => from + 10_800_000,
        _ => {
            let from = Local
                .timestamp_millis_opt(from as i64)
                .single()
                .unwrap_or_else(Local::now);
            let time = NaiveTime::parse_from_str(goal["at"].as_str().unwrap_or("09:00"), "%H:%M")
                .unwrap_or(NaiveTime::from_hms_opt(9, 0, 0).unwrap());
            let date = from.date_naive();
            let mut at = Local
                .from_local_datetime(&date.and_time(time))
                .earliest()
                .unwrap_or(from + Duration::hours(1));
            if at <= from + Duration::minutes(1) {
                at += Duration::days(1);
            }
            at.timestamp_millis() as u64
        }
    }
}
pub fn quiet_hours(d: &Value) -> bool {
    let parse =
        |key| NaiveTime::parse_from_str(d["settings"][key].as_str().unwrap_or(""), "%H:%M").ok();
    let (Some(a), Some(b)) = (parse("quietStart"), parse("quietEnd")) else {
        return false;
    };
    let t = Local::now().time();
    if a > b {
        t >= a || t < b
    } else {
        t >= a && t < b
    }
}
fn apply(d: &mut Value, command: &str, args: Value) -> Result<Value, String> {
    match command {
        "todo:add" | "reminder:add" | "memory:add" | "goal:add" => {
            let key = match command {
                "todo:add" => "todos",
                "reminder:add" => "reminders",
                "memory:add" => "memories",
                _ => "goals",
            };
            let value = text(&args, if key == "goals" { "title" } else { "text" })?;
            let items = rows(d, key)?;
            let n = next_id(items);
            let item = match key {
                "todos" => {
                    json!({"id":n,"text":value,"due":args["due"],"done":false,"createdAt":now()})
                }
                "reminders" => {
                    let at = args["at"]
                        .as_u64()
                        .filter(|n| *n > now())
                        .ok_or("请选择将来的提醒时间")?;
                    json!({"id":n,"text":value,"at":at,"repeat":args["repeat"].as_str().unwrap_or(""),"createdAt":now()})
                }
                "memories" => json!({"id":n,"text":value,"source":"user","weight":4,"at":now()}),
                _ => {
                    let mut g = json!({"id":n,"title":value,"detail":args["detail"].as_str().unwrap_or(""),"every":args["every"].as_str().unwrap_or("daily"),"at":args["at"].as_str().unwrap_or("09:00"),"status":"active","log":[],"createdAt":now()});
                    g["nextAt"] = json!(next_check(&g, now()));
                    g
                }
            };
            items.insert(0, item.clone());
            Ok(item)
        }
        "todo:update" | "goal:update" => {
            let key = if command == "todo:update" {
                "todos"
            } else {
                "goals"
            };
            let item = rows(d, key)?
                .iter_mut()
                .find(|x| id(&x["id"]) == id(&args["id"]))
                .ok_or("记录不存在")?;
            let fields = if key == "todos" {
                &["text", "due", "done"][..]
            } else {
                &["title", "detail", "status", "every", "at"][..]
            };
            for field in fields {
                if let Some(v) = args["patch"].get(field) {
                    item[*field] = v.clone();
                }
            }
            if key == "todos" && item["done"] == true {
                item["doneAt"] = json!(now());
            }
            if key == "goals" {
                item["nextAt"] = json!(next_check(item, now()));
            }
            Ok(item.clone())
        }
        "todo:remove" | "reminder:remove" | "memory:remove" | "goal:remove" => {
            let key = command.split(':').next().unwrap();
            let key = match key {
                "todo" => "todos",
                "reminder" => "reminders",
                "memory" => "memories",
                _ => "goals",
            };
            rows(d, key)?.retain(|x| id(&x["id"]) != id(&args["id"]));
            Ok(Value::Null)
        }
        "todo:clear-done" => {
            rows(d, "todos")?.retain(|x| x["done"] != true);
            Ok(Value::Null)
        }
        "activity:clear" => {
            d["activity"] = json!([]);
            Ok(Value::Null)
        }
        "pomodoro:start" => {
            let m = args["minutes"].as_u64().unwrap_or(25).clamp(1, 180);
            d["pomodoro"] = json!({"until":now()+m*60_000,"minutes":m});
            Ok(d["pomodoro"].clone())
        }
        "pomodoro:stop" => {
            d["pomodoro"]["until"] = json!(0);
            Ok(Value::Null)
        }
        "settings:set" => {
            let object = args.as_object().ok_or("设置格式错误")?;
            for (key, value) in object {
                if d["settings"].get(key).is_none() {
                    return Err(format!("未知设置：{key}"));
                }
                d["settings"][key] = value.clone();
            }
            Ok(d["settings"].clone())
        }
        "observation:set" => {
            let enabled = args["enabled"].as_bool().unwrap_or(false);
            if enabled && args["consentVersion"] != 1 {
                return Err("请先确认观察范围和 AI 处理说明".into());
            }
            let interval = args["intervalSeconds"].as_u64().unwrap_or(120);
            let max = args["maxPerHour"].as_u64().unwrap_or(4);
            if !(30..=3600).contains(&interval) || max > 12 {
                return Err("观察间隔需为 30–3600 秒，每小时最多 12 次互动".into());
            }
            d["observation"] = json!({"enabled":enabled,"consentVersion":if enabled{1}else{0},"intervalSeconds":interval,"maxPerHour":max,"quiet":args["quiet"].as_bool().unwrap_or(true),"excludeApps":args["excludeApps"].as_str().unwrap_or(""),"pausedUntil":d["observation"]["pausedUntil"]});
            Ok(d["observation"].clone())
        }
        "screen:pause" => {
            d["observation"]["pausedUntil"] =
                json!(now() + args["minutes"].as_u64().unwrap_or(60).min(1440) * 60_000);
            Ok(Value::Null)
        }
        "alert:ack" => {
            rows(d, "alerts")?.retain(|x| id(&x["id"]) != id(&args["id"]));
            Ok(Value::Null)
        }
        _ => Err(format!("未知操作：{command}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn crud_preserves_legacy_ids_and_unknown_fields() {
        let mut d = defaults();
        d["custom"] = json!({"x":1});
        d["todos"] = json!([{"id":"old-id","text":"old"}]);
        apply(
            &mut d,
            "todo:update",
            json!({"id":"old-id","patch":{"done":true}}),
        )
        .unwrap();
        assert_eq!(d["todos"][0]["done"], true);
        assert_eq!(d["custom"]["x"], 1);
    }
    #[test]
    fn observation_requires_specific_consent_and_has_cost_limits() {
        let mut d = defaults();
        assert_eq!(d["observation"]["enabled"], false);
        assert!(apply(&mut d, "observation:set", json!({"enabled":true})).is_err());
        assert!(apply(
            &mut d,
            "observation:set",
            json!({"enabled":true,"consentVersion":1,"intervalSeconds":1})
        )
        .is_err());
        apply(
            &mut d,
            "observation:set",
            json!({"enabled":true,"consentVersion":1}),
        )
        .unwrap();
        assert_eq!(d["observation"]["quiet"], true);
    }
    #[test]
    fn legacy_import_is_a_copy_and_keeps_settings_and_messages() {
        let dir = std::env::temp_dir().join(format!("ojousama-migrate-{}", now()));
        fs::create_dir_all(&dir).unwrap();
        let legacy = dir.join("old.json");
        let raw = r#"{"settings":{"backend":"codex","codexModel":"my-model"},"chat":{"messages":[{"text":"hello"}]},"memories":[{"id":"m","text":"hi"}]}"#;
        fs::write(&legacy, raw).unwrap();
        let c = Companion::open(dir.join("pet-data.json"), Some(&legacy)).unwrap();
        assert_eq!(c.snapshot()["settings"]["codexModel"], "my-model");
        assert_eq!(c.snapshot()["chat"]["messages"][0]["text"], "hello");
        assert_eq!(fs::read_to_string(&legacy).unwrap(), raw);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn shared_defaults_cover_every_original_data_section() {
        let d = defaults();
        for name in [
            "todos",
            "reminders",
            "goals",
            "memories",
            "chat",
            "growth",
            "activity",
            "watch",
            "tidyLog",
            "note",
            "stats",
            "inbox",
        ] {
            assert!(!d[name].is_null(), "{name}");
        }
    }
}
