//! Compatibility with the user's installed DSH host; no Electron runtime is bundled.
use super::*;
use std::io;

pub(super) fn locate(request: &StartRequest) -> Result<Launch, String> {
    if !cfg!(windows) {
        return Err("DSH 兼容后端需要 Windows；此平台请使用 Codex".into());
    }
    let s = &request.backend_settings;
    let home = home_dir().ok_or("没有可用的用户目录")?;
    let mut candidates = vec![PathBuf::from(s["dshExe"].as_str().unwrap_or(""))];
    if let Some(p) = env::var_os("DSH_DESKTOP_NODE_EXECUTABLE") {
        candidates.push(p.into());
    }
    candidates.push(
        env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData/Local"))
            .join("Programs/DeepSeek Harness/DeepSeek Harness.exe"),
    );
    candidates.push(
        env::var_os("ProgramFiles")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("C:/Program Files"))
            .join("DeepSeek Harness/DeepSeek Harness.exe"),
    );
    for exe in candidates {
        if exe.is_file()
            && exe
                .parent()
                .is_some_and(|p| p.join("resources/app.asar").is_file())
        {
            return Ok(Launch {
                executable: exe,
                args: Vec::new(),
            });
        }
    }
    Err("找不到 DeepSeek Harness，请在设置中选择其 exe".into())
}
fn patch(source: &str, request: &StartRequest) -> String {
    let mut chunks = Vec::new();
    let mut current = String::new();
    for line in source.lines() {
        if line.starts_with("- ") && !current.is_empty() {
            chunks.push(std::mem::take(&mut current));
        }
        current.push_str(line);
        current.push('\n');
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    let mut output = String::new();
    for chunk in chunks {
        let id = chunk.lines().find_map(|line| {
            line.trim()
                .trim_start_matches("- ")
                .strip_prefix("id:")
                .map(str::trim)
        });
        if matches!(
            id,
            Some("llm-pi-ai" | "llm-deepseek" | "llm-deepseek-account" | "agent-default-model")
        ) {
            output.push_str(&chunk);
        }
    }
    let settings = &request.backend_settings;
    if let (Some(provider), Some(model)) = (
        settings["provider"].as_str().filter(|s| !s.is_empty()),
        settings["model"].as_str().filter(|s| !s.is_empty()),
    ) {
        output.push_str(&format!("- id: agent-default-model\n  name: '@deepseek-ai/dsh-agent-default-model'\n  config:\n    provider: {}\n    model: {}\n",json!(provider),json!(model)));
        if let Some(effort) = settings["reasoningEffort"]
            .as_str()
            .filter(|s| !s.is_empty())
        {
            output.push_str(&format!("    reasoningEffort: {}\n", json!(effort)));
        }
    }
    output.push_str("- id: credentials\n  name: '@deepseek-ai/dsh-credentials-local'\n  disabled: false\n- id: system-prompt\n  name: '@deepseek-ai/dsh-system-prompt'\n  config:\n    personaPrefix: |-\n");
    for line in request.instructions.lines() {
        output.push_str(&format!("      {line}\n"));
    }
    for id in ["agent-instructions", "skill-filesystem"] {
        output.push_str(&format!(
            "- id: {id}\n  name: '@deepseek-ai/dsh-{id}'\n  disabled: true\n"
        ));
    }
    if request.restricted {
        for id in [
            "tool-ask-user",
            "tool-bash",
            "tool-bash-persistent",
            "tool-cordis",
            "tool-fs",
            "tool-fs-search",
            "tool-goal",
            "tool-jobs",
            "tool-present",
            "tool-pwsh",
            "tool-pwsh-persistent",
            "tool-ralph",
            "tool-schedule",
            "tool-session-query",
            "tool-skill",
            "tool-str-replace-editor",
            "tool-subagent",
            "tool-subagent-control",
            "tool-terminal",
            "tool-todo",
            "tool-web",
            "tool-workflow",
            "tool-working-directory",
            "tool-workspace-dependencies",
            "experimental-tool-agent-team",
            "subagent-fork-in-process",
            "plan-mode",
            "mcp-client",
        ] {
            output.push_str(&format!(
                "- id: {id}\n  name: '@deepseek-ai/dsh-{id}'\n  disabled: true\n"
            ));
        }
    }
    output
}
fn apply_event(
    shared: &Shared,
    id: u64,
    event: Value,
    final_text: &mut String,
) -> Result<(), String> {
    match event["type"].as_str().unwrap_or("") {
        "session" => shared.update(id, |v| {
            v.thread_id = event["sessionId"].as_str().map(String::from)
        }),
        "text" | "final" => {
            let text = event["text"].as_str().unwrap_or("");
            if event["type"] == "final" {
                *final_text = text.into();
            } else {
                final_text.push_str(text);
            }
            *final_text = bounded(final_text, OUTPUT_LIMIT);
            shared.update(id, |v| {
                v.output = final_text.clone();
                v.status = "thinking".into();
                v.activity = "回复中…".into();
            });
        }
        "tool_call" => shared.update(id, |v| {
            v.status = "working".into();
            v.activity = format!("工具：{}", event["name"].as_str().unwrap_or("运行中"));
        }),
        "thinking" | "status" => shared.update(id, |v| {
            v.status = "thinking".into();
            v.activity = "思考中…".into();
        }),
        "error" => {
            return Err(event["message"]
                .as_str()
                .or(event["error"].as_str())
                .unwrap_or("DSH 返回错误")
                .into())
        }
        _ => {}
    }
    Ok(())
}
pub(super) fn run(
    shared: Arc<Shared>,
    id: u64,
    request: StartRequest,
    launch: Launch,
    controls: mpsc::Receiver<Control>,
) {
    let result = (|| -> Result<Outcome, String> {
        if request.image.is_some() {
            return Err("图像观察请使用 Codex；DSH 兼容运行不接收隐式图片输入".into());
        }
        let profile = request.backend_settings["sourceProfile"]
            .as_str()
            .unwrap_or("desktop");
        if profile.is_empty()
            || !profile
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            return Err("DSH profile 名称无效".into());
        }
        let home = env::var_os("DSH_HOME")
            .map(PathBuf::from)
            .unwrap_or(home_dir().ok_or("用户目录不可用")?.join(".dsh"));
        #[cfg(test)]
        let home = request.dsh_test_home.clone().unwrap_or(home);
        let source = match fs::read_to_string(
            home.join("profiles").join(profile).join("cordis.patch.yml"),
        ) {
            Ok(s) => s,
            Err(e) if e.kind() == io::ErrorKind::NotFound => String::new(),
            Err(e) => return Err(e.to_string()),
        };
        static NEXT_DIRECTORY: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let serial = NEXT_DIRECTORY.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = env::temp_dir().join(format!(
            "ojousama-dsh-{}-{id}-{}-{serial}",
            std::process::id(),
            now_ms()
        ));
        fs::create_dir(&dir).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
        struct Cleanup(PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                if let Err(error) = fs::remove_dir_all(&self.0) {
                    eprintln!("DSH 临时配置清理失败：{error}");
                }
            }
        }
        let _cleanup = Cleanup(dir.clone());
        let patch_file = dir.join("pet.yml");
        fs::write(&patch_file, patch(&source, &request)).map_err(|e| e.to_string())?;
        let cli =
            launch.executable.parent().ok_or("DSH 路径无效")?.join(
                "resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js",
            );
        let mut command = Command::new(&launch.executable);
        command
            .args(&launch.args)
            .arg("--expose-internals")
            .arg(cli)
            .args(["--profile", "headless", "--patch"])
            .arg(patch_file)
            .arg("--json");
        if !request.session_id.is_empty() {
            command.args(["--session-id", &request.session_id]);
        }
        command
            .arg("-")
            .current_dir(&request.workspace)
            .env("ELECTRON_RUN_AS_NODE", "1")
            .env("DSH_PERMISSION_MODE", &request.permission)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for key in [
            "DSH_SESSION_ID",
            "DSH_PROFILE",
            "DSH_PROFILE_DIR",
            "DSH_SHELL",
            "DSH_WEB_URL",
        ] {
            command.env_remove(key);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000 | 0x00000200);
        }
        let child = command.spawn().map_err(|e| format!("DSH 启动失败：{e}"))?;
        #[cfg(windows)]
        let _job = match windows_process::Job::attach(&child) {
            Ok(j) => j,
            Err(e) => {
                let mut child = child;
                let _ = child.kill();
                let _ = child.wait();
                return Err(e.to_string());
            }
        };
        struct Owned {
            child: Child,
            reaped: bool,
        }
        impl Drop for Owned {
            fn drop(&mut self) {
                if !self.reaped {
                    #[cfg(unix)]
                    kill_group(self.child.id());
                    let _ = self.child.kill();
                    let _ = self.child.wait();
                }
            }
        }
        let mut owned = Owned {
            child,
            reaped: false,
        };
        let child = &mut owned.child;
        let mut input = child.stdin.take().ok_or("DSH stdin 不可用")?;
        input
            .write_all(request.prompt.as_bytes())
            .map_err(|e| e.to_string())?;
        drop(input);
        let (tx, rx) = mpsc::channel();
        let stdout = child.stdout.take().ok_or("DSH stdout 不可用")?;
        let output_reader = thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = Vec::new();
                match reader.by_ref().take(1_048_576).read_until(b'\n', &mut line) {
                    Ok(0) => break,
                    Ok(_) if line.len() >= 1_048_576 => {
                        let _ = tx.send(Err("DSH 单条输出超过限制".to_string()));
                        break;
                    }
                    Ok(_) => {
                        let _ = tx.send(
                            serde_json::from_slice::<Value>(&line).map_err(|e| e.to_string()),
                        );
                    }
                    Err(e) => {
                        let _ = tx.send(Err(e.to_string()));
                        break;
                    }
                }
            }
        });
        let stderr = child.stderr.take().ok_or("DSH stderr 不可用")?;
        let error_reader = thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = stderr.take(65_536).read_to_end(&mut bytes);
            (result, bytes)
        });
        let mut final_text = String::new();
        let mut saw_event = false;
        let outcome = loop {
            match controls.try_recv() {
                Ok(Control::Cancel) => {
                    break Outcome::Cancelled;
                }
                Ok(Control::Respond { reply, .. }) => {
                    let _ = reply.send(Err("DSH 不支持 Codex 审批请求".into()));
                }
                Err(mpsc::TryRecvError::Disconnected) => {
                    break Outcome::Cancelled;
                }
                Err(mpsc::TryRecvError::Empty) => {}
            }
            while let Ok(message) = rx.try_recv() {
                match message {
                    Ok(event) => {
                        saw_event = true;
                        apply_event(&shared, id, event, &mut final_text)?;
                    }
                    Err(error) if error.starts_with("DSH ") => return Err(error),
                    Err(error) => eprintln!("DSH non-protocol line: {error}"),
                }
            }
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                if status.success() {
                    break Outcome::Completed;
                } else {
                    break Outcome::Failed(format!("DSH 退出：{status}"));
                }
            }
            thread::sleep(Duration::from_millis(20));
        };
        #[cfg(unix)]
        kill_group(child.id());
        let _ = child.kill();
        let _ = child.wait();
        owned.reaped = true;
        #[cfg(windows)]
        drop(_job);
        output_reader.join().map_err(|_| "DSH 输出线程退出")?;
        while let Ok(message) = rx.try_recv() {
            if let Ok(event) = message {
                saw_event = true;
                apply_event(&shared, id, event, &mut final_text)?;
            }
        }
        let outcome = if matches!(outcome, Outcome::Completed) && !saw_event {
            Outcome::Failed("DSH 未返回有效事件".into())
        } else {
            outcome
        };
        let (error_result, error_bytes) =
            error_reader.join().map_err(|_| "DSH stderr 读取线程退出")?;
        error_result.map_err(|e| e.to_string())?;
        Ok(match outcome {
            Outcome::Failed(error) => Outcome::Failed(format!(
                "{error}\\n{}",
                String::from_utf8_lossy(&error_bytes)
                    .chars()
                    .take(1000)
                    .collect::<String>()
            )),
            other => other,
        })
    })();
    shared.finish(id, result.unwrap_or_else(Outcome::Failed));
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn patch_preserves_provider_and_disables_tools_for_background() {
        let request = StartRequest {
            restricted: true,
            instructions: "hello".into(),
            ..StartRequest::default()
        };
        let output=patch("- id: llm-pi-ai\n  name: provider\n  config:\n    model: x\n- id: dangerous\n  name: unexpected\n",&request);
        assert!(output.contains("name: provider"));
        assert!(!output.contains("unexpected"));
        assert!(output.contains("- id: tool-bash"));
        assert!(output.contains("- id: mcp-client"));
        assert!(output.contains("disabled: true"));
    }
}
