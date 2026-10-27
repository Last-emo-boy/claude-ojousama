use std::io::{self, BufRead, Read, Write};
use std::{env, thread, time::Duration};
fn emit(line: &str) {
    println!("{line}");
    io::stdout().flush().unwrap();
}
fn complete(text: &str) {
    let mut escaped = String::new();
    for c in text.chars() {
        match c {
            '"' | '\\' => {
                escaped.push('\\');
                escaped.push(c);
            }
            c if c < ' ' => escaped.push_str(&format!("\\u{:04x}", c as u32)),
            _ => escaped.push(c),
        }
    }
    emit(&format!(
        r#"{{"method":"item/completed","params":{{"threadId":"thread-fixture","item":{{"id":"answer","type":"agentMessage","text":"{escaped}"}}}}}}"#
    ));
    emit(
        r#"{"method":"turn/completed","params":{"threadId":"thread-fixture","turn":{"id":"turn-fixture","status":"completed"}}}"#,
    );
}
fn main() {
    let scenario = env::args().nth(1).unwrap();
    if scenario.starts_with("dsh-") {
        let mut prompt=String::new();io::stdin().read_to_string(&mut prompt).unwrap();
        if scenario=="dsh-hang"{emit(r#"{"type":"status","status":"ready"}"#);loop{thread::sleep(Duration::from_secs(60));}}
        emit(r#"{"type":"session","sessionId":"dsh-fixture-session"}"#);
        emit(r#"{"type":"text","text":"DSH_"}"#);
        emit(r#"{"type":"final","text":"DSH_OK"}"#);
        return;
    }
    if scenario == "descendant" {
        loop {
            thread::sleep(Duration::from_secs(60));
        }
    }
    for line in io::stdin().lock().lines() {
        let line = line.unwrap();
        let id: String = line
            .split("\"id\":")
            .nth(1)
            .unwrap_or("")
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        if line.contains("\"method\":\"initialize\"") {
            if scenario == "stall-init" {
                thread::sleep(Duration::from_secs(5));
            }
            emit(&format!(r#"{{"id":{id},"result":{{}}}}"#));
        } else if line.contains("\"method\":\"config/read\"") {
            emit(&format!(
                r#"{{"id":{id},"result":{{"config":{{"mcp_servers":{{"dangerous":{{"enabled":true}},"with.dot":{{"enabled":true}}}}}}}}}}"#
            ));
        } else if line.contains("\"method\":\"thread/start\"") {
            if !line.contains(r#""dangerous":{"enabled":false}"#)
                || !line.contains(r#""with.dot":{"enabled":false}"#)
                || !(line.contains(r#""approvalPolicy":"on-request""#) || (scenario.starts_with("restricted") && line.contains(r#""approvalPolicy":"never""#) && line.contains(r#""features.shell_tool":false"#) && line.contains(r#""environments":[]"#) && line.contains(r#""ephemeral":true"#)))
                || !line.contains(r#""features.hooks":false"#)
            {
                emit(&format!(
                    r#"{{"id":{id},"error":{{"message":"unsafe handshake"}}}}"#
                ));
                continue;
            }
            emit(&format!(
                r#"{{"id":{id},"result":{{"thread":{{"id":"thread-fixture"}}}}}}"#
            ));
        } else if line.contains("\"method\":\"turn/start\"") {
            emit(
                r#"{"method":"turn/started","params":{"threadId":"thread-fixture","turn":{"id":"turn-fixture"}}}"#,
            );
            emit(
                r#"{"method":"item/reasoning/summaryTextDelta","params":{"threadId":"thread-fixture","delta":"thinking"}}"#,
            );
            if !matches!(scenario.as_str(),"restricted"|"restricted-hang"|"restricted-reflect") { emit(
                r#"{"method":"item/started","params":{"threadId":"thread-fixture","item":{"id":"command","type":"commandExecution","command":"fixture command"}}}"#,
            ); }
            if scenario == "restricted" && !line.contains("data:image/png;base64,fixture") { complete("MISSING_IMAGE");continue; }
            if scenario == "race-turn" {
                thread::sleep(Duration::from_millis(200));
            }
            emit(&format!(
                r#"{{"id":{id},"result":{{"turn":{{"id":"turn-fixture","status":"inProgress"}}}}}}"#
            ));
            match scenario.as_str() {
                "approval" | "expire" => emit(
                    r#"{"id":501,"method":"item/commandExecution/requestApproval","params":{"threadId":"thread-fixture","reason":"fixture reason","command":"fixture command"}}"#,
                ),
                "permission" => emit(
                    r#"{"id":501,"method":"item/permissions/requestApproval","params":{"threadId":"thread-fixture","permissions":{"network":{"enabled":true}}}}"#,
                ),
                "input" => emit(
                    r#"{"id":601,"method":"item/tool/requestUserInput","params":{"threadId":"thread-fixture","questions":[{"id":"name","question":"What name?","options":null}]}}"#,
                ),
                "fail" => {
                    eprintln!("fixture server detail");
                    emit(
                        r#"{"method":"turn/completed","params":{"threadId":"thread-fixture","turn":{"id":"turn-fixture","status":"failed","error":{"message":"fixture failure"}}}}"#,
                    );
                }
                "crash" => {
                    eprintln!("fixture abrupt exit");
                    return;
                }
                "spawn-descendant" => {
                    let _child = std::process::Command::new(env::current_exe().unwrap())
                        .arg("descendant")
                        .spawn()
                        .unwrap();
                    complete("DESCENDANT_DONE");
                }
                "hang" | "race-turn" | "restricted-hang" => {}
                "restricted-reflect" => complete(r#"{"notes":["整理了受控笔记。"]}"#),
                _ => {
                    emit(
                        r#"{"method":"item/agentMessage/delta","params":{"threadId":"thread-fixture","itemId":"answer","delta":"MOCK_"}}"#,
                    );
                    emit(
                        r#"{"method":"item/agentMessage/delta","params":{"threadId":"different-thread","itemId":"answer","delta":"WRONG"}}"#,
                    );
                    complete("MOCK_OK");
                }
            }
        } else if line.contains("\"method\":\"turn/interrupt\"") {
            emit(&format!(r#"{{"id":{id},"result":{{}}}}"#));
            emit(
                r#"{"method":"turn/completed","params":{"threadId":"thread-fixture","turn":{"id":"turn-fixture","status":"interrupted"}}}"#,
            );
        } else if id == "501" && line.contains("\"result\"") {
            if line.contains("\"accept\"") || line.contains("\"network\":{\"enabled\":true}") {
                complete("APPROVED");
            } else {
                complete("DECLINED");
            }
        } else if id == "601" && line.contains("\"result\"") {
            complete("ANSWERED");
        }
    }
}
