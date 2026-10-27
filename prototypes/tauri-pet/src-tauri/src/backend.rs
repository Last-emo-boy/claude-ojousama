//! Native per-task process management for Codex and optional installed DSH.
#[path = "dsh.rs"]
mod dsh;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, VecDeque},
    env, fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{mpsc, Arc, Condvar, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const HISTORY_LIMIT: usize = 20;
const OUTPUT_LIMIT: usize = 65_536;
const RPC_TIMEOUT: Duration = Duration::from_secs(30);
const QUESTION_TIMEOUT: Duration = Duration::from_secs(120);
const STOP_GRACE: Duration = Duration::from_secs(1);

type Emit = Arc<dyn Fn(TaskView) + Send + Sync>;
type Reply = mpsc::Sender<Result<(), String>>;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StartRequest {
    pub prompt: String,
    pub workspace: String,
    pub permission: String,
    pub codex_path: String,
    pub model: String,
    pub reasoning_effort: String,
    pub session_id: String,
    pub instructions: String,
    pub restricted: bool,
    pub backend: String,
    pub backend_settings: Value,
    #[cfg(test)]
    #[serde(skip)]
    pub dsh_test_home: Option<PathBuf>,
    #[serde(skip)]
    pub image: Option<String>,
}
impl Default for StartRequest {
    fn default() -> Self {
        Self {
            prompt: String::new(),
            workspace: String::new(),
            permission: "read-only".into(),
            codex_path: String::new(),
            model: String::new(),
            reasoning_effort: String::new(),
            session_id: String::new(),
            instructions: String::new(),
            restricted: false,
            backend: "codex".into(),
            backend_settings: Value::Null,
            #[cfg(test)]
            dsh_test_home: None,
            image: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskView {
    pub id: u64,
    pub prompt: String,
    pub workspace: String,
    pub permission: String,
    pub status: String,
    pub activity: String,
    pub output: String,
    pub error: Option<String>,
    pub thread_id: Option<String>,
    pub created_at: u64,
    pub finished_at: Option<u64>,
    pub pending: Option<Value>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Record {
    view: TaskView,
    request: StartRequest,
}
struct Active {
    id: u64,
    controls: mpsc::Sender<Control>,
    ended: Arc<(Mutex<bool>, Condvar)>,
}
struct State {
    records: Vec<Record>,
    active: Option<Active>,
    next_id: u64,
    load_error: Option<String>,
}
struct Shared {
    state: Mutex<State>,
    history: Option<PathBuf>,
    emit: Emit,
    question_timeout: Duration,
}

#[derive(Clone)]
pub struct TaskManager {
    shared: Arc<Shared>,
    launch_override: Option<Launch>,
}
#[derive(Clone)]
struct Launch {
    executable: PathBuf,
    args: Vec<String>,
}

enum Control {
    Cancel,
    Respond {
        id: Value,
        answer: Value,
        is_input: bool,
        reply: Reply,
    },
}
struct Pending {
    id: Value,
    method: String,
    params: Value,
    expires: Instant,
}

enum Wire {
    Message(Value),
    BadMessage(String),
    Closed,
}
#[derive(Clone, Copy, PartialEq)]
enum Phase {
    Initialize,
    Config,
    Thread,
    Turn,
    Running,
}
enum Outcome {
    Completed,
    Cancelled,
    Failed(String),
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn terminal(status: &str) -> bool {
    matches!(status, "completed" | "cancelled" | "failed")
}
fn bounded(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.into();
    }
    let mut start = text.len() - limit;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    text[start..].into()
}
fn short(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

impl TaskManager {
    pub fn new(history: PathBuf, emit: Emit) -> Self {
        let (mut records, load_error) = match fs::read(&history) {
            Ok(bytes) => match serde_json::from_slice::<Vec<Record>>(&bytes) {
                Ok(records) => (records, None),
                Err(error) => (
                    Vec::new(),
                    Some(format!("任务历史无法读取，请保留原文件并检查：{error}")),
                ),
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (Vec::new(), None),
            Err(error) => (Vec::new(), Some(format!("任务历史无法读取：{error}"))),
        };
        records.truncate(HISTORY_LIMIT);
        for record in &mut records {
            if !terminal(&record.view.status) {
                record.view.status = "failed".into();
                record.view.activity = "上次运行已中断".into();
                record.view.error = Some("应用上次退出时任务尚未完成，可重试".into());
                record.view.finished_at = Some(now_ms());
            }
            record.view.pending = None;
            record.view.output = bounded(&record.view.output, OUTPUT_LIMIT);
        }
        let next_id = records.iter().map(|r| r.view.id).max().unwrap_or(0) + 1;
        Self {
            shared: Arc::new(Shared {
                state: Mutex::new(State {
                    records,
                    active: None,
                    next_id,
                    load_error,
                }),
                history: Some(history),
                emit,
                question_timeout: QUESTION_TIMEOUT,
            }),
            launch_override: None,
        }
    }

    pub fn ephemeral(emit: Emit) -> Self {
        Self {
            shared: Arc::new(Shared {
                state: Mutex::new(State {
                    records: Vec::new(),
                    active: None,
                    next_id: 1,
                    load_error: None,
                }),
                history: None,
                emit,
                question_timeout: QUESTION_TIMEOUT,
            }),
            launch_override: None,
        }
    }

    pub fn list(&self) -> Vec<TaskView> {
        self.shared
            .state
            .lock()
            .unwrap()
            .records
            .iter()
            .map(|r| r.view.clone())
            .collect()
    }
    #[cfg(test)]
    pub(crate) fn fixture(scenario: &str) -> Self {
        let mut manager = Self::ephemeral(Arc::new(|_| {}));
        manager.launch_override = Some(Launch {
            executable: tests::fixture(),
            args: vec![scenario.into()],
        });
        manager
    }

    pub fn start(&self, mut request: StartRequest) -> Result<TaskView, String> {
        if request.restricted {
            request.permission = "read-only".into();
        }
        request.prompt = request.prompt.trim().into();
        if request.prompt.is_empty() {
            return Err("请先输入任务".into());
        }
        if request.prompt.len() > 32_768 {
            return Err("任务描述请控制在 32 KiB 以内".into());
        }
        if !matches!(
            request.permission.as_str(),
            "read-only" | "workspace-write" | "danger-full-access"
        ) {
            return Err("无效的任务权限".into());
        }
        if request.workspace.trim().is_empty() {
            return Err("请选择工作目录".into());
        }
        let directory = fs::canonicalize(expand_home(request.workspace.trim()))
            .map_err(|e| format!("工作目录不可用：{e}"))?;
        if !directory.is_dir() {
            return Err("工作目录必须是文件夹".into());
        }
        request.workspace = directory.to_string_lossy().into_owned();
        let launch = if let Some(launch) = &self.launch_override {
            launch.clone()
        } else {
            match request.backend.as_str() {
                "codex" => Launch {
                    executable: locate_codex(&request.codex_path)?,
                    args: Vec::new(),
                },
                "dsh" => dsh::locate(&request)?,
                _ => return Err("未知 AI 后端".into()),
            }
        };
        let (tx, rx) = mpsc::channel();
        let ended = Arc::new((Mutex::new(false), Condvar::new()));
        let view;
        {
            let mut state = self.shared.state.lock().unwrap();
            if state.active.is_some() {
                return Err("已有任务正在运行，请先停止或等待完成".into());
            }
            if let Some(error) = &state.load_error {
                return Err(error.clone());
            }
            view = TaskView {
                id: state.next_id,
                prompt: request.prompt.clone(),
                workspace: request.workspace.clone(),
                permission: request.permission.clone(),
                status: "starting".into(),
                activity: if request.backend == "dsh" {
                    "连接 DSH…"
                } else {
                    "连接 Codex…"
                }
                .into(),
                output: String::new(),
                error: None,
                thread_id: None,
                created_at: now_ms(),
                finished_at: None,
                pending: None,
            };
            state.next_id += 1;
            state.records.insert(
                0,
                Record {
                    view: view.clone(),
                    request: request.clone(),
                },
            );
            state.records.truncate(HISTORY_LIMIT);
            if let Err(error) = self.shared.persist(&state.records) {
                state.records.remove(0);
                return Err(error);
            }
            state.active = Some(Active {
                id: view.id,
                controls: tx,
                ended: ended.clone(),
            });
        }
        (self.shared.emit)(view.clone());
        let shared = self.shared.clone();
        let id = view.id;
        thread::spawn(move || {
            run_task(shared.clone(), id, request, launch, rx);
            let (lock, signal) = &*ended;
            *lock.lock().unwrap() = true;
            signal.notify_all();
        });
        Ok(view)
    }

    pub fn retry(&self, id: u64) -> Result<TaskView, String> {
        let request = {
            let state = self.shared.state.lock().unwrap();
            let record = state
                .records
                .iter()
                .find(|r| r.view.id == id)
                .ok_or("找不到这个任务")?;
            if !terminal(&record.view.status) {
                return Err("运行中的任务不能重试".into());
            }
            record.request.clone()
        };
        self.start(request)
    }

    pub fn cancel(&self, id: u64) -> Result<(), String> {
        self.controls(id)?
            .send(Control::Cancel)
            .map_err(|_| "任务已结束".into())
    }

    pub fn approve(&self, id: u64, request_id: Value, accept: bool) -> Result<(), String> {
        self.respond(id, request_id, Value::Bool(accept), false)
    }

    pub fn answer(&self, id: u64, request_id: Value, answers: Value) -> Result<(), String> {
        self.respond(id, request_id, answers, true)
    }

    fn respond(
        &self,
        id: u64,
        request_id: Value,
        answer: Value,
        is_input: bool,
    ) -> Result<(), String> {
        let controls = self.controls(id)?;
        let (tx, rx) = mpsc::channel();
        controls
            .send(Control::Respond {
                id: request_id,
                answer,
                is_input,
                reply: tx,
            })
            .map_err(|_| "任务已结束")?;
        rx.recv_timeout(Duration::from_secs(2))
            .map_err(|_| "任务未响应，请刷新状态后重试".to_string())?
    }

    fn controls(&self, id: u64) -> Result<mpsc::Sender<Control>, String> {
        let state = self.shared.state.lock().unwrap();
        let active = state
            .active
            .as_ref()
            .filter(|a| a.id == id)
            .ok_or("任务已结束或不存在")?;
        Ok(active.controls.clone())
    }

    pub fn shutdown(&self) {
        let waiting = {
            let state = self.shared.state.lock().unwrap();
            state.active.as_ref().map(|active| {
                let _ = active.controls.send(Control::Cancel);
                active.ended.clone()
            })
        };
        if let Some(ended) = waiting {
            let (lock, signal) = &*ended;
            let guard = lock.lock().unwrap();
            let _ = signal.wait_timeout_while(guard, Duration::from_secs(3), |done| !*done);
        }
    }
}

impl Shared {
    fn persist(&self, records: &[Record]) -> Result<(), String> {
        let Some(history) = &self.history else {
            return Ok(());
        };
        if let Some(parent) = history.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("无法创建任务历史目录：{e}"))?;
        }
        let temp = history.with_extension("json.tmp");
        fs::write(
            &temp,
            serde_json::to_vec(records).map_err(|e| e.to_string())?,
        )
        .map_err(|e| format!("无法保存任务历史：{e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&temp, fs::Permissions::from_mode(0o600))
                .map_err(|e| format!("无法保护任务历史：{e}"))?;
        }
        replace_history(&temp, history).map_err(|e| format!("无法更新任务历史：{e}"))
    }

    fn update(&self, id: u64, change: impl FnOnce(&mut TaskView)) {
        let view = {
            let mut state = self.state.lock().unwrap();
            let Some(record) = state.records.iter_mut().find(|r| r.view.id == id) else {
                return;
            };
            if terminal(&record.view.status) {
                return;
            }
            change(&mut record.view);
            record.view.clone()
        };
        (self.emit)(view);
    }

    fn finish(&self, id: u64, outcome: Outcome) {
        let view = {
            let mut state = self.state.lock().unwrap();
            let Some(record) = state.records.iter_mut().find(|r| r.view.id == id) else {
                return;
            };
            if terminal(&record.view.status) {
                return;
            }
            let view = &mut record.view;
            match outcome {
                Outcome::Completed => {
                    view.status = "completed".into();
                    view.activity = "任务完成".into();
                }
                Outcome::Cancelled => {
                    view.status = "cancelled".into();
                    view.activity = "已停止".into();
                }
                Outcome::Failed(error) => {
                    view.status = "failed".into();
                    view.activity = "任务失败".into();
                    view.error = Some(error);
                }
            }
            view.pending = None;
            view.finished_at = Some(now_ms());
            record.request.image = None;
            state.active = None;
            if let Err(error) = self.persist(&state.records) {
                let record = state.records.iter_mut().find(|r| r.view.id == id).unwrap();
                record.view.error = Some(match &record.view.error {
                    Some(previous) => format!("{previous}\n{error}"),
                    None => error,
                });
            }
            state
                .records
                .iter()
                .find(|r| r.view.id == id)
                .unwrap()
                .view
                .clone()
        };
        (self.emit)(view);
    }
}

#[cfg(not(windows))]
fn replace_history(source: &Path, target: &Path) -> std::io::Result<()> {
    fs::rename(source, target)
}
#[cfg(windows)]
fn replace_history(source: &Path, target: &Path) -> std::io::Result<()> {
    windows_process::replace_file(source, target)
}

#[cfg(windows)]
mod windows_process {
    use std::{
        ffi::c_void,
        io,
        os::windows::{ffi::OsStrExt, io::AsRawHandle},
        path::Path,
        process::Child,
    };
    type Handle = *mut c_void;
    #[repr(C)]
    #[derive(Default)]
    struct BasicLimits {
        process_time: i64,
        job_time: i64,
        flags: u32,
        min_working_set: usize,
        max_working_set: usize,
        active_processes: u32,
        affinity: usize,
        priority: u32,
        scheduling: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimits {
        basic: BasicLimits,
        io_counters: [u64; 6],
        process_memory: usize,
        job_memory: usize,
        peak_process_memory: usize,
        peak_job_memory: usize,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(
            job: Handle,
            class: i32,
            info: *const c_void,
            length: u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
        fn MoveFileExW(source: *const u16, target: *const u16, flags: u32) -> i32;
    }
    pub struct Job(Handle);
    impl Job {
        pub fn attach(child: &Child) -> io::Result<Self> {
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return Err(io::Error::last_os_error());
                }
                let mut limits = ExtendedLimits::default();
                limits.basic.flags = 0x00002000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                if SetInformationJobObject(
                    job,
                    9,
                    &limits as *const _ as *const c_void,
                    std::mem::size_of_val(&limits) as u32,
                ) == 0
                    || AssignProcessToJobObject(job, child.as_raw_handle()) == 0
                {
                    let error = io::Error::last_os_error();
                    CloseHandle(job);
                    return Err(error);
                }
                Ok(Self(job))
            }
        }
    }
    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    pub fn replace_file(source: &Path, target: &Path) -> io::Result<()> {
        let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
        // Replace atomically, retaining the previous history if the operation fails.
        if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), 1 | 8) } == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
}

fn home_dir() -> Option<PathBuf> {
    env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}
fn expand_home(value: &str) -> PathBuf {
    if let Some(rest) = value.strip_prefix("~/") {
        if let Some(home) = home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(value)
}
fn executable_file(path: &Path) -> bool {
    let Ok(meta) = fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o111 == 0 {
            return false;
        }
    }
    true
}

/// Resolve official npm wrappers to their native executable, without launching a command shell or Node.
pub fn locate_codex(override_path: &str) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if !override_path.trim().is_empty() {
        candidates.push(expand_home(override_path.trim()));
    } else {
        for directory in env::split_paths(&env::var_os("PATH").unwrap_or_default()) {
            candidates.push(directory.join(if cfg!(windows) { "codex.exe" } else { "codex" }));
            if cfg!(windows) {
                candidates.push(directory.join("codex.cmd"));
            }
        }
        if let Some(home) = home_dir() {
            for relative in [
                ".local/bin/codex",
                ".cargo/bin/codex",
                ".codex/packages/standalone/current/bin/codex",
            ] {
                candidates.push(home.join(relative));
            }
        }
        if cfg!(target_os = "macos") {
            for path in [
                "/opt/homebrew/bin/codex",
                "/usr/local/bin/codex",
                "/Applications/Codex.app/Contents/Resources/codex",
            ] {
                candidates.push(path.into());
            }
        }
        if let Some(appdata) = env::var_os("APPDATA") {
            candidates.push(PathBuf::from(appdata).join("npm/codex.cmd"));
        }
    }
    for candidate in candidates {
        let Ok(resolved) = fs::canonicalize(&candidate) else {
            continue;
        };
        let extension = resolved
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if matches!(extension.as_str(), "cmd" | "bat" | "js") {
            let target = native_target();
            let binary = if cfg!(windows) { "codex.exe" } else { "codex" };
            let package = format!(
                "codex-{}-{}",
                if cfg!(windows) {
                    "win32"
                } else if cfg!(target_os = "macos") {
                    "darwin"
                } else {
                    "linux"
                },
                if cfg!(target_arch = "aarch64") {
                    "arm64"
                } else {
                    "x64"
                }
            );
            for ancestor in resolved.ancestors().skip(1).take(7) {
                for base in [
                    ancestor.to_path_buf(),
                    ancestor.join(&package),
                    ancestor.join("node_modules/@openai/codex"),
                    ancestor.join("node_modules/@openai").join(&package),
                ] {
                    let native = base.join("vendor").join(target).join("codex").join(binary);
                    if executable_file(&native) {
                        return fs::canonicalize(native).map_err(|e| e.to_string());
                    }
                }
            }
        } else if executable_file(&resolved) {
            return Ok(resolved);
        }
    }
    Err("找不到原生 Codex CLI。请先安装并运行 codex login，或选择 Codex 可执行文件".into())
}

fn native_target() -> &'static str {
    match (env::consts::OS, env::consts::ARCH) {
        ("windows", "aarch64") => "aarch64-pc-windows-msvc",
        ("windows", _) => "x86_64-pc-windows-msvc",
        ("macos", "aarch64") => "aarch64-apple-darwin",
        ("macos", _) => "x86_64-apple-darwin",
        (_, "aarch64") => "aarch64-unknown-linux-musl",
        _ => "x86_64-unknown-linux-musl",
    }
}

fn run_config(restricted: bool) -> BTreeMap<String, Value> {
    let mut config = BTreeMap::new();
    config.insert("notify".into(), json!([]));
    config.insert("project_doc_max_bytes".into(), json!(0));
    config.insert("web_search".into(), json!("disabled"));
    config.insert("skills.include_instructions".into(), json!(false));
    config.insert("skills.bundled.enabled".into(), json!(false));
    config.insert("features.skip_host_skill_discovery".into(), json!(true));
    for feature in [
        "hooks",
        "tool_suggest",
        "skill_search",
        "skill_mcp_dependency_install",
        "apps",
        "plugins",
        "multi_agent",
        "multi_agent_v2",
        "browser_use",
        "computer_use",
        "code_mode",
        "artifact",
        "workspace_dependencies",
        "memories",
        "goals",
    ] {
        config.insert(format!("features.{feature}"), json!(false));
    }
    if restricted {
        config.insert("features.shell_tool".into(), json!(false));
        config.insert("features.view_image".into(), json!(false));
    }
    config
}

fn send(stdin: &mut ChildStdin, value: Value) -> Result<(), String> {
    serde_json::to_writer(&mut *stdin, &value).map_err(|e| e.to_string())?;
    stdin
        .write_all(b"\n")
        .and_then(|_| stdin.flush())
        .map_err(|e| format!("Codex 连接已关闭：{e}"))
}
fn rpc(stdin: &mut ChildStdin, id: u64, method: &str, params: Value) -> Result<(), String> {
    send(stdin, json!({"id":id,"method":method,"params":params}))
}

fn run_task(
    shared: Arc<Shared>,
    id: u64,
    request: StartRequest,
    launch: Launch,
    controls: mpsc::Receiver<Control>,
) {
    if matches!(controls.try_recv(), Ok(Control::Cancel)) {
        shared.finish(id, Outcome::Cancelled);
        return;
    }
    if request.backend == "dsh" {
        dsh::run(shared, id, request, launch, controls);
        return;
    }
    let mut command = Command::new(&launch.executable);
    command
        .args(&launch.args)
        .args(["app-server", "--listen", "stdio://"]);
    for (key, value) in run_config(request.restricted) {
        command.arg("-c").arg(format!("{key}={value}"));
    }
    command
        .current_dir(&request.workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
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
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            shared.finish(id, Outcome::Failed(format!("无法启动 Codex：{error}")));
            return;
        }
    };
    #[cfg(windows)]
    let job = match windows_process::Job::attach(&child) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            shared.finish(
                id,
                Outcome::Failed(format!("无法跟踪 Codex 子进程：{error}")),
            );
            return;
        }
    };
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let stderr_text = Arc::new(Mutex::new(String::new()));
    let stderr_copy = stderr_text.clone();
    let err_reader = thread::spawn(move || {
        let mut buffer = [0u8; 2048];
        loop {
            match stderr.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    let mut text = stderr_copy.lock().unwrap();
                    text.push_str(&String::from_utf8_lossy(&buffer[..count]));
                    *text = bounded(&text, 8192);
                }
            }
        }
    });
    let (tx, rx) = mpsc::sync_channel(64);
    let out_reader = thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let message = match line {
                Ok(line) if line.trim().is_empty() => continue,
                Ok(line) => match serde_json::from_str(&line) {
                    Ok(value) => Wire::Message(value),
                    Err(error) => Wire::BadMessage(format!("Codex 返回了无效协议消息：{error}")),
                },
                Err(error) => Wire::BadMessage(format!("读取 Codex 连接失败：{error}")),
            };
            if tx.send(message).is_err() {
                return;
            }
        }
        let _ = tx.send(Wire::Closed);
    });
    let mut session = Session::new(shared.clone(), id, request);
    let mut outcome = match rpc(
        &mut stdin,
        1,
        "initialize",
        json!({"clientInfo":{"name":"claude_ojousama","title":"Claude Ojousama","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}}),
    ) {
        Ok(()) => session.run(&mut stdin, &rx, &controls),
        Err(error) => Outcome::Failed(error),
    };
    drop(stdin);
    drop(rx);
    reap(&mut child);
    #[cfg(windows)]
    drop(job);
    let _ = out_reader.join();
    let _ = err_reader.join();
    if let Outcome::Failed(error) = &mut outcome {
        let stderr = stderr_text.lock().unwrap();
        if !stderr.trim().is_empty() {
            error.push('\n');
            error.push_str(stderr.trim());
        }
        *error = bounded(error, 8192);
    }
    shared.finish(id, outcome);
}

fn reap(child: &mut Child) {
    let until = Instant::now() + STOP_GRACE;
    while Instant::now() < until {
        if matches!(child.try_wait(), Ok(Some(_))) {
            #[cfg(unix)]
            kill_group(child.id());
            return;
        }
        thread::sleep(Duration::from_millis(20));
    }
    #[cfg(unix)]
    kill_group(child.id());
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(unix)]
fn kill_group(id: u32) {
    // The server was launched into a new group. Also close descendants that retained its pipes.
    unsafe {
        unsafe extern "C" {
            fn kill(pid: i32, sig: i32) -> i32;
        }
        kill(-(id as i32), 9);
    }
}

struct Session {
    shared: Arc<Shared>,
    id: u64,
    request: StartRequest,
    phase: Phase,
    rpc_at: Instant,
    thread_id: Option<String>,
    turn_id: Option<String>,
    cancelled: bool,
    stop_at: Option<Instant>,
    interrupted: bool,
    pending: VecDeque<Pending>,
    messages: Vec<(String, String)>,
    next_id: u64,
}
impl Session {
    fn new(shared: Arc<Shared>, id: u64, request: StartRequest) -> Self {
        Self {
            shared,
            id,
            request,
            phase: Phase::Initialize,
            rpc_at: Instant::now(),
            thread_id: None,
            turn_id: None,
            cancelled: false,
            stop_at: None,
            interrupted: false,
            pending: VecDeque::new(),
            messages: Vec::new(),
            next_id: 5,
        }
    }
    fn run(
        &mut self,
        stdin: &mut ChildStdin,
        wire: &mpsc::Receiver<Wire>,
        controls: &mpsc::Receiver<Control>,
    ) -> Outcome {
        loop {
            while let Ok(control) = controls.try_recv() {
                match control {
                    Control::Cancel => {
                        self.cancelled = true;
                        self.pending.clear();
                        self.shared.update(self.id, |v| {
                            v.pending = None;
                            v.activity = "正在停止…".into();
                        });
                        if self.phase != Phase::Turn && self.phase != Phase::Running {
                            return Outcome::Cancelled;
                        }
                        if self.stop_at.is_none() {
                            self.stop_at = Some(Instant::now() + STOP_GRACE);
                        }
                        if self.interrupt(stdin).is_err() {
                            return Outcome::Cancelled;
                        }
                    }
                    Control::Respond {
                        id,
                        answer,
                        is_input,
                        reply,
                    } => {
                        let result = self.respond(stdin, &id, answer, is_input);
                        let _ = reply.send(result);
                    }
                }
            }
            if self.stop_at.is_some_and(|until| Instant::now() >= until) {
                return Outcome::Cancelled;
            }
            if self.phase != Phase::Running
                && !self.cancelled
                && self.rpc_at.elapsed() >= RPC_TIMEOUT
            {
                return Outcome::Failed("Codex 连接初始化超时".into());
            }
            if let Err(error) = self.expire_questions(stdin) {
                return Outcome::Failed(error);
            }
            match wire.recv_timeout(Duration::from_millis(25)) {
                Ok(Wire::Message(message)) => match self.message(stdin, message) {
                    Ok(Some(outcome)) => return outcome,
                    Ok(None) => {}
                    Err(error) => {
                        return if self.cancelled {
                            Outcome::Cancelled
                        } else {
                            Outcome::Failed(error)
                        }
                    }
                },
                Ok(Wire::BadMessage(error)) => {
                    return if self.cancelled {
                        Outcome::Cancelled
                    } else {
                        Outcome::Failed(error)
                    }
                }
                Ok(Wire::Closed) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return if self.cancelled {
                        Outcome::Cancelled
                    } else {
                        Outcome::Failed("Codex 在任务完成前退出".into())
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
    }
    fn interrupt(&mut self, stdin: &mut ChildStdin) -> Result<(), String> {
        if self.interrupted {
            return Ok(());
        }
        if let (Some(thread_id), Some(turn_id)) = (&self.thread_id, &self.turn_id) {
            rpc(
                stdin,
                self.next_id,
                "turn/interrupt",
                json!({"threadId":thread_id,"turnId":turn_id}),
            )?;
            self.next_id += 1;
            self.interrupted = true;
        }
        Ok(())
    }
    fn message(
        &mut self,
        stdin: &mut ChildStdin,
        message: Value,
    ) -> Result<Option<Outcome>, String> {
        if message.get("id").is_some() && message.get("method").is_some() {
            self.server_request(stdin, message)?;
            return Ok(None);
        }
        if message.get("method").is_none() {
            let expected = match self.phase {
                Phase::Initialize => 1,
                Phase::Config => 2,
                Phase::Thread => 3,
                Phase::Turn => 4,
                Phase::Running => 0,
            };
            if message["id"].as_u64() != Some(expected) {
                return Ok(None);
            }
            if let Some(error) = message.get("error") {
                return Err(error["message"].as_str().unwrap_or("Codex 请求失败").into());
            }
            let result = &message["result"];
            self.rpc_at = Instant::now();
            match self.phase {
                Phase::Initialize => {
                    send(stdin, json!({"method":"initialized"}))?;
                    rpc(stdin, 2, "config/read", json!({"includeLayers":false}))?;
                    self.phase = Phase::Config;
                }
                Phase::Config => {
                    let mut config =
                        serde_json::to_value(run_config(self.request.restricted)).unwrap();
                    let servers = result["config"]["mcp_servers"]
                        .as_object()
                        .map(|servers| {
                            servers
                                .keys()
                                .map(|name| (name.clone(), json!({"enabled":false})))
                                .collect::<serde_json::Map<String, Value>>()
                        })
                        .unwrap_or_default();
                    config["mcp_servers"] = Value::Object(servers);
                    let mut params = json!({"cwd":self.request.workspace,"sandbox":self.request.permission,"approvalPolicy":"on-request","config":config,"developerInstructions":"You are a concise desktop task assistant. Work on the user's explicit request in the selected workspace. Ask for approval when required. Do not claim to have executed actions that have not completed."});
                    if !self.request.instructions.is_empty() {
                        params["developerInstructions"] = json!(self.request.instructions);
                    }
                    if self.request.restricted {
                        params["approvalPolicy"] = json!("never");
                        params["environments"] = json!([]);
                        params["ephemeral"] = json!(true);
                    }
                    if !self.request.reasoning_effort.is_empty() {
                        params["config"]["model_reasoning_effort"] =
                            json!(self.request.reasoning_effort);
                    }
                    if !self.request.model.trim().is_empty() {
                        params["model"] = json!(self.request.model);
                    }
                    if !self.request.session_id.is_empty() && !self.request.restricted {
                        params["threadId"] = json!(self.request.session_id);
                        rpc(stdin, 3, "thread/resume", params)?;
                    } else {
                        rpc(stdin, 3, "thread/start", params)?;
                    }
                    self.phase = Phase::Thread;
                }
                Phase::Thread => {
                    let thread_id = result["thread"]["id"]
                        .as_str()
                        .ok_or("Codex 没有返回会话 ID")?
                        .to_string();
                    self.thread_id = Some(thread_id.clone());
                    self.shared.update(self.id, |v| {
                        v.thread_id = Some(thread_id.clone());
                        v.status = "thinking".into();
                        v.activity = "思考中…".into();
                    });
                    let mut input =
                        vec![json!({"type":"text","text":self.request.prompt,"text_elements":[]})];
                    if let Some(image) = &self.request.image {
                        input.push(json!({"type":"image","url":image}));
                    }
                    let mut turn = json!({"threadId":thread_id,"input":input});
                    if !self.request.reasoning_effort.is_empty() {
                        turn["effort"] = json!(self.request.reasoning_effort);
                    }
                    if self.request.restricted {
                        turn["environments"] = json!([]);
                    }
                    rpc(stdin, 4, "turn/start", turn)?;
                    self.phase = Phase::Turn;
                }
                Phase::Turn => {
                    if let Some(id) = result["turn"]["id"].as_str() {
                        self.turn_id = Some(id.into());
                    }
                    self.phase = Phase::Running;
                    if self.cancelled {
                        self.interrupt(stdin)?;
                    }
                }
                Phase::Running => {}
            }
            return Ok(None);
        }
        let params = &message["params"];
        if let (Some(expected), Some(actual)) = (&self.thread_id, params["threadId"].as_str()) {
            if actual != expected {
                return Ok(None);
            }
        }
        let method = message["method"].as_str().unwrap_or("");
        match method {
            "turn/started" => {
                if let Some(id) = params["turn"]["id"].as_str() {
                    self.turn_id = Some(id.into());
                }
                if self.cancelled {
                    self.interrupt(stdin)?;
                } else {
                    self.activity("thinking", "思考中…");
                }
            }
            "item/agentMessage/delta" => {
                self.text(
                    params["itemId"].as_str().unwrap_or("message"),
                    params["delta"].as_str().unwrap_or(""),
                    false,
                );
            }
            "item/started" | "item/completed" => {
                let item = &params["item"];
                let completed = method == "item/completed";
                if self.request.restricted
                    && !completed
                    && matches!(
                        item["type"].as_str(),
                        Some(
                            "commandExecution"
                                | "fileChange"
                                | "mcpToolCall"
                                | "dynamicToolCall"
                                | "webSearch"
                                | "computerUse"
                        )
                    )
                {
                    return Err("观察会话请求了未授权的工具，已停止".into());
                }
                match item["type"].as_str().unwrap_or("") {
                    "reasoning" => self.activity("thinking", "思考中…"),
                    "agentMessage" if completed => self.text(
                        item["id"].as_str().unwrap_or("message"),
                        item["text"].as_str().unwrap_or(""),
                        true,
                    ),
                    "commandExecution" => {
                        if completed {
                            self.activity(
                                "working",
                                if item["status"] == "completed" {
                                    "命令已完成"
                                } else {
                                    "命令未成功"
                                },
                            );
                        } else {
                            self.activity(
                                "working",
                                &format!(
                                    "执行：{}",
                                    short(item["command"].as_str().unwrap_or("命令"), 120)
                                ),
                            );
                        }
                    }
                    "fileChange" => self.activity(
                        "working",
                        if completed {
                            "文件操作已完成"
                        } else {
                            "正在修改文件…"
                        },
                    ),
                    "mcpToolCall" | "dynamicToolCall" => self.activity(
                        "working",
                        &format!("工具：{}", item["tool"].as_str().unwrap_or("运行中")),
                    ),
                    _ => {}
                }
            }
            "serverRequest/resolved" => {
                self.pending
                    .retain(|pending| pending.id != params["requestId"]);
                self.show_pending();
            }
            "turn/completed" => {
                return Ok(Some(
                    if self.cancelled || params["turn"]["status"] == "interrupted" {
                        Outcome::Cancelled
                    } else if params["turn"]["status"] == "completed" {
                        Outcome::Completed
                    } else {
                        Outcome::Failed(
                            params["turn"]["error"]["message"]
                                .as_str()
                                .unwrap_or("Codex 任务未完成")
                                .into(),
                        )
                    },
                ));
            }
            "error" if params["willRetry"] != true => {
                return Ok(Some(Outcome::Failed(
                    params["error"]["message"]
                        .as_str()
                        .or_else(|| params["message"].as_str())
                        .unwrap_or("Codex 任务失败")
                        .into(),
                )))
            }
            _ if method.starts_with("item/reasoning/") => self.activity("thinking", "思考中…"),
            _ => {}
        }
        Ok(None)
    }
    fn activity(&self, status: &str, activity: &str) {
        self.shared.update(self.id, |view| {
            if self.pending.is_empty() {
                view.status = status.into();
                view.activity = activity.into();
            }
        });
    }
    fn text(&mut self, id: &str, text: &str, replace: bool) {
        let index = match self.messages.iter().position(|(key, _)| key == id) {
            Some(index) => index,
            None => {
                self.messages.push((id.into(), String::new()));
                self.messages.len() - 1
            }
        };
        let message = &mut self.messages[index].1;
        if replace {
            *message = bounded(text, OUTPUT_LIMIT);
        } else {
            message.push_str(text);
            *message = bounded(message, OUTPUT_LIMIT);
        }
        let output = bounded(
            &self
                .messages
                .iter()
                .map(|(_, text)| text.as_str())
                .collect::<Vec<_>>()
                .join("\n\n"),
            OUTPUT_LIMIT,
        );
        self.shared.update(self.id, |view| view.output = output);
    }
    fn server_request(&mut self, stdin: &mut ChildStdin, message: Value) -> Result<(), String> {
        let id = message["id"].clone();
        let method = message["method"].as_str().unwrap_or("").to_string();
        let params = message["params"].clone();
        if let (Some(expected), Some(actual)) = (&self.thread_id, params["threadId"].as_str()) {
            if expected != actual {
                return send(
                    stdin,
                    json!({"id":id,"error":{"code":-32602,"message":"Wrong thread"}}),
                );
            }
        }
        if matches!(
            method.as_str(),
            "item/commandExecution/requestApproval"
                | "item/fileChange/requestApproval"
                | "item/permissions/requestApproval"
                | "item/tool/requestUserInput"
        ) {
            if self.cancelled || self.request.restricted {
                return send(stdin, json!({"id":id,"result":declined(&method)}));
            }
            if self.pending.iter().any(|pending| pending.id == id) {
                return Err("Codex 重复使用了未处理的请求 ID".into());
            }
            self.pending.push_back(Pending {
                id,
                method,
                params,
                expires: Instant::now() + self.shared.question_timeout,
            });
            self.show_pending();
        } else if method == "mcpServer/elicitation/request" {
            send(
                stdin,
                json!({"id":id,"result":{"action":"decline","content":null}}),
            )?;
        } else {
            send(
                stdin,
                json!({"id":id,"error":{"code":-32601,"message":"Unsupported desktop client request"}}),
            )?;
        }
        Ok(())
    }
    fn show_pending(&self) {
        let pending = self.pending.front().map(|request| {
            let input = request.method == "item/tool/requestUserInput";
            json!({"id":request.id,"kind":if input {"input"} else {"approval"},"message":request.params["reason"].as_str().unwrap_or(if input {"Codex 想问你"} else {"允许这次操作吗？"}),"command":request.params["command"],"questions":request.params["questions"],"permissions":request.params["permissions"],"method":request.method})
        });
        self.shared.update(self.id, |view| {
            view.status = pending
                .as_ref()
                .map(|p| {
                    if p["kind"] == "input" {
                        "input"
                    } else {
                        "approval"
                    }
                })
                .unwrap_or("working")
                .into();
            view.activity = match view.status.as_str() {
                "input" => "等你回答",
                "approval" => "需要你的确认",
                _ => "继续处理…",
            }
            .into();
            view.pending = pending;
        });
    }
    fn respond(
        &mut self,
        stdin: &mut ChildStdin,
        id: &Value,
        answer: Value,
        is_input: bool,
    ) -> Result<(), String> {
        if self.cancelled {
            return Err("任务已停止".into());
        }
        let index = self
            .pending
            .iter()
            .position(|pending| &pending.id == id)
            .ok_or("这个请求已结束或已回应")?;
        let request = &self.pending[index];
        if (request.method == "item/tool/requestUserInput") != is_input {
            return Err("回应类型与请求不匹配".into());
        }
        let result = if is_input {
            validate_answers(&request.params, &answer)?;
            json!({"answers":answer})
        } else if request.method == "item/permissions/requestApproval" {
            json!({"permissions":if answer == true {request.params["permissions"].clone()} else {json!({})},"scope":"turn"})
        } else {
            json!({"decision":if answer == true {"accept"} else {"decline"}})
        };
        send(stdin, json!({"id":id,"result":result}))?;
        self.pending.remove(index);
        self.show_pending();
        Ok(())
    }
    fn expire_questions(&mut self, stdin: &mut ChildStdin) -> Result<(), String> {
        let mut changed = false;
        for index in (0..self.pending.len()).rev() {
            if self.pending[index].expires <= Instant::now() {
                let request = self.pending.remove(index).unwrap();
                send(
                    stdin,
                    json!({"id":request.id,"result":declined(&request.method)}),
                )?;
                changed = true;
            }
        }
        if changed {
            self.show_pending();
        }
        Ok(())
    }
}
fn declined(method: &str) -> Value {
    match method {
        "item/tool/requestUserInput" => json!({"answers":{}}),
        "item/permissions/requestApproval" => json!({"permissions":{},"scope":"turn"}),
        _ => json!({"decision":"decline"}),
    }
}
fn validate_answers(params: &Value, answers: &Value) -> Result<(), String> {
    let answers = answers.as_object().ok_or("回答必须是问题 ID 对应的对象")?;
    let questions = params["questions"]
        .as_array()
        .ok_or("Codex 没有提供有效的问题")?;
    for (id, answer) in answers {
        if !questions.iter().any(|q| q["id"].as_str() == Some(id)) {
            return Err("回答包含未知的问题 ID".into());
        }
        let values = answer["answers"].as_array().ok_or("回答必须是字符串数组")?;
        if values.iter().any(|value| !value.is_string()) {
            return Err("回答必须是字符串数组".into());
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "backend_tests.rs"]
mod tests;
