//! Fast paths for explicit user requests, never for observed screen/model text.
use regex::Regex;
use serde_json::{json, Value};
use std::sync::OnceLock;
pub struct Intent {
    pub command: &'static str,
    pub args: Value,
    pub reply: String,
}
pub fn parse(text: &str, now: u64) -> Option<Intent> {
    static REMINDER: OnceLock<Regex> = OnceLock::new();
    static FOCUS: OnceLock<Regex> = OnceLock::new();
    let text = text.trim();
    if let Some(body) = text
        .strip_prefix("记个待办：")
        .or_else(|| text.strip_prefix("记个待办:"))
        .or_else(|| text.strip_prefix("待办："))
        .or_else(|| text.strip_prefix("待办:"))
    {
        let body = body.trim();
        if body.is_empty() {
            return None;
        }
        return Some(Intent {
            command: "todo:add",
            args: json!({"text":body}),
            reply: format!("记下了：{body}"),
        });
    }
    for (prefix, command, key, reply) in [
        ("目标：", "goal:add", "title", "目标记好了，我会定期推进。"),
        ("目标:", "goal:add", "title", "目标记好了，我会定期推进。"),
        ("记住：", "memory:add", "text", "记住啦。"),
        ("记住:", "memory:add", "text", "记住啦。"),
    ] {
        if let Some(body) = text
            .strip_prefix(prefix)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return Some(Intent {
                command,
                args: json!({key:body}),
                reply: reply.into(),
            });
        }
    }
    let re=REMINDER.get_or_init(||Regex::new(r"^(?:提醒我\s*(\d{1,4})\s*分钟后[，,：:\s]*(.+)|(\d{1,4})\s*分钟后提醒我[，,：:\s]*(.+))$").unwrap());
    if let Some(c) = re.captures(text) {
        let minutes = c
            .get(1)
            .or_else(|| c.get(3))?
            .as_str()
            .parse::<u64>()
            .ok()?;
        let body = c.get(2).or_else(|| c.get(4))?.as_str().trim();
        if minutes == 0 || minutes > 1440 || body.is_empty() {
            return None;
        }
        return Some(Intent {
            command: "reminder:add",
            args: json!({"text":body,"at":now+minutes*60_000}),
            reply: format!("好，{minutes} 分钟后提醒你：{body}"),
        });
    }
    if let Some(c) = FOCUS
        .get_or_init(|| Regex::new(r"^(?:开始)?专注\s*(\d{1,3})\s*分钟[。！!]*$").unwrap())
        .captures(text)
    {
        let minutes = c[1].parse::<u64>().ok()?;
        if !(1..=180).contains(&minutes) {
            return None;
        }
        return Some(Intent {
            command: "pomodoro:start",
            args: json!({"minutes":minutes}),
            reply: format!("开始专注 {minutes} 分钟，我会安静陪着。"),
        });
    }
    None
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_local_requests_keep_values_and_do_not_need_a_model() {
        let i = parse("提醒我10分钟后起来走走", 1000).unwrap();
        assert_eq!(i.command, "reminder:add");
        assert_eq!(i.args["at"], 601000);
        assert_eq!(i.args["text"], "起来走走");
        assert_eq!(
            parse("25 分钟后提醒我，喝水", 0).unwrap().args["text"],
            "喝水"
        );
        assert_eq!(parse("待办：修好窗口停靠", 0).unwrap().command, "todo:add");
        assert_eq!(parse("专注 25 分钟", 0).unwrap().args["minutes"], 25);
        for text in [
            "怎样设置提醒我10分钟后喝水？",
            "待办：",
            "专注181分钟",
            "0分钟后提醒我喝水",
            "这段代码里有专注25分钟",
            "解释提醒功能",
        ] {
            assert!(parse(text, 0).is_none(), "{text}");
        }
    }
}
