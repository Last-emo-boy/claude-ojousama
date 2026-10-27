use super::*;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    OnceLock,
};

pub(super) fn fixture() -> PathBuf {
    static BINARY: OnceLock<PathBuf> = OnceLock::new();
    BINARY
        .get_or_init(|| {
            let dir = env::temp_dir().join(format!(
                "ojousama-backend-fixture-{}-{}",
                std::process::id(),
                now_ms()
            ));
            fs::create_dir_all(&dir).unwrap();
            let source = dir.join("fixture.rs");
            fs::write(&source, include_str!("backend_fixture.rs")).unwrap();
            let binary = dir.join(if cfg!(windows) {
                "fixture.exe"
            } else {
                "fixture"
            });
            let result = Command::new("rustc")
                .arg("--edition=2021")
                .arg(source)
                .arg("-o")
                .arg(&binary)
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
            binary
        })
        .clone()
}
fn setup(
    scenario: &str,
) -> (
    TaskManager,
    StartRequest,
    PathBuf,
    Arc<Mutex<Vec<TaskView>>>,
) {
    static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(0);
    let serial = NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed);
    let directory = env::temp_dir().join(format!(
        "ojousama-backend-test-{}-{}-{}-{}",
        std::process::id(),
        now_ms(),
        scenario,
        serial
    ));
    fs::create_dir_all(&directory).unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let capture = events.clone();
    let mut manager = TaskManager::new(
        directory.join("history.json"),
        Arc::new(move |view| capture.lock().unwrap().push(view)),
    );
    manager.launch_override = Some(Launch {
        executable: fixture(),
        args: vec![scenario.into()],
    });
    let request = StartRequest {
        prompt: "fixture task".into(),
        workspace: directory.to_string_lossy().into_owned(),
        ..StartRequest::default()
    };
    (manager, request, directory, events)
}
fn wait(manager: &TaskManager, predicate: impl Fn(&TaskView) -> bool) -> TaskView {
    let deadline = Instant::now() + Duration::from_secs(6);
    loop {
        if let Some(view) = manager.list().first() {
            if predicate(view) {
                return view.clone();
            }
        }
        if Instant::now() >= deadline {
            let last = manager.list();
            manager.shutdown();
            panic!("task did not reach expected state: {last:?}");
        }
        thread::sleep(Duration::from_millis(5));
    }
}
#[test]
fn handshake_stream_tools_and_success() {
    let (manager, request, dir, events) = setup("success");
    let started = manager.start(request).unwrap();
    assert_eq!(started.status, "starting");
    let done = wait(&manager, |v| terminal(&v.status));
    assert_eq!(done.status, "completed");
    assert_eq!(done.output, "MOCK_OK");
    assert_eq!(done.thread_id.as_deref(), Some("thread-fixture"));
    let statuses: Vec<String> = events
        .lock()
        .unwrap()
        .iter()
        .map(|v| v.status.clone())
        .collect();
    assert!(statuses.contains(&"thinking".into()));
    assert!(statuses.contains(&"working".into()));
    let records: Vec<Record> =
        serde_json::from_slice(&fs::read(dir.join("history.json")).unwrap()).unwrap();
    assert_eq!(records[0].view.output, "MOCK_OK");
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn approval_is_explicit_single_use_and_has_request_details() {
    let (manager, request, dir, _) = setup("approval");
    let id = manager.start(request).unwrap().id;
    let pending = wait(&manager, |v| v.status == "approval").pending.unwrap();
    assert_eq!(pending["command"], "fixture command");
    assert!(manager.approve(id, json!(999), true).is_err());
    manager.approve(id, pending["id"].clone(), true).unwrap();
    assert!(manager.approve(id, pending["id"].clone(), true).is_err());
    assert_eq!(wait(&manager, |v| terminal(&v.status)).output, "APPROVED");
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn permissions_use_per_turn_response_shape() {
    let (manager, request, dir, _) = setup("permission");
    let id = manager.start(request).unwrap().id;
    wait(&manager, |v| v.status == "approval");
    manager.approve(id, json!(501), true).unwrap();
    assert_eq!(wait(&manager, |v| terminal(&v.status)).output, "APPROVED");
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn invalid_answers_leave_question_pending_and_valid_answers_clear_it() {
    let (manager, request, dir, _) = setup("input");
    let id = manager.start(request).unwrap().id;
    wait(&manager, |v| v.status == "input");
    assert!(manager
        .answer(id, json!(601), json!({"unknown":{"answers":["a"]}}))
        .is_err());
    assert!(manager
        .answer(id, json!(601), json!({"name":{"answers":[7]}}))
        .is_err());
    assert!(manager.approve(id, json!(601), true).is_err());
    assert!(manager.list()[0].pending.is_some());
    manager
        .answer(id, json!(601), json!({"name":{"answers":["test"]}}))
        .unwrap();
    let done = wait(&manager, |v| terminal(&v.status));
    assert_eq!(done.output, "ANSWERED");
    assert!(done.pending.is_none());
    assert!(manager.answer(id, json!(601), json!({})).is_err());
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn unanswered_approval_declines_on_deadline() {
    let (mut manager, request, dir, _) = setup("expire");
    Arc::get_mut(&mut manager.shared).unwrap().question_timeout = Duration::from_millis(100);
    manager.start(request).unwrap();
    let done = wait(&manager, |v| terminal(&v.status));
    assert_eq!(done.output, "DECLINED");
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn server_failures_preserve_error_and_stderr() {
    for scenario in ["fail", "crash"] {
        let (manager, request, dir, _) = setup(scenario);
        manager.start(request).unwrap();
        let done = wait(&manager, |v| terminal(&v.status));
        assert_eq!(done.status, "failed");
        assert!(done.error.unwrap().contains(if scenario == "fail" {
            "fixture failure"
        } else {
            "fixture abrupt exit"
        }));
        fs::remove_dir_all(dir).unwrap();
    }
}
#[test]
fn cancellation_handles_early_start_and_inflight_turn_response() {
    for scenario in ["stall-init", "race-turn", "hang", "approval"] {
        let (manager, request, dir, _) = setup(scenario);
        let id = manager.start(request.clone()).unwrap().id;
        if scenario != "stall-init" {
            wait(&manager, |v| {
                if scenario == "approval" {
                    v.status == "approval"
                } else {
                    v.status == "working"
                }
            });
        }
        assert!(manager.start(request).is_err());
        manager.cancel(id).unwrap();
        let done = wait(&manager, |v| terminal(&v.status));
        assert_eq!(done.status, "cancelled", "{scenario}");
        assert!(done.pending.is_none());
        assert!(manager.approve(id, json!(501), true).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}
#[test]
fn shutdown_waits_for_owned_task_and_retry_creates_new_id() {
    let (manager, request, dir, _) = setup("hang");
    let id = manager.start(request).unwrap().id;
    wait(&manager, |v| v.status == "working");
    manager.shutdown();
    assert_eq!(manager.list()[0].status, "cancelled");
    let next = manager.retry(id).unwrap();
    assert!(next.id > id);
    manager.shutdown();
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn interrupted_history_recovers_without_restarting_process() {
    let (manager, request, dir, _) = setup("hang");
    let record = Record {
        view: TaskView {
            id: 9,
            prompt: "old".into(),
            workspace: request.workspace.clone(),
            permission: "read-only".into(),
            status: "input".into(),
            activity: "old".into(),
            output: "partial".into(),
            error: None,
            thread_id: Some("old-thread".into()),
            created_at: 1,
            finished_at: None,
            pending: Some(json!({"id":1})),
        },
        request,
    };
    fs::write(
        dir.join("history.json"),
        serde_json::to_vec(&vec![record]).unwrap(),
    )
    .unwrap();
    let recovered = TaskManager::new(dir.join("history.json"), Arc::new(|_| {}));
    assert_eq!(recovered.list()[0].status, "failed");
    assert!(recovered.list()[0].pending.is_none());
    assert_eq!(recovered.list()[0].output, "partial");
    assert_eq!(recovered.shared.state.lock().unwrap().next_id, 10);
    drop(manager);
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn validates_workspace_permission_prompt_and_preserves_bad_history() {
    let (manager, mut request, dir, _) = setup("success");
    request.permission = "unknown-permission".into();
    assert!(manager.start(request.clone()).is_err());
    request.permission = "read-only".into();
    request.workspace = dir.join("missing").to_string_lossy().into_owned();
    assert!(manager.start(request.clone()).is_err());
    request.workspace = dir.to_string_lossy().into_owned();
    request.prompt = "   ".into();
    assert!(manager.start(request).is_err());
    fs::write(dir.join("history.json"), "bad history").unwrap();
    let recovered = TaskManager::new(dir.join("history.json"), Arc::new(|_| {}));
    assert!(recovered.shared.state.lock().unwrap().load_error.is_some());
    assert_eq!(
        fs::read_to_string(dir.join("history.json")).unwrap(),
        "bad history"
    );
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn output_is_bounded_on_utf8_boundary_and_defaults_are_read_only() {
    assert_eq!(StartRequest::default().permission, "read-only");
    assert_eq!(bounded("你好abc", 4), "abc");
    let text = "界".repeat(40_000);
    assert!(bounded(&text, OUTPUT_LIMIT).len() <= OUTPUT_LIMIT);
}
#[test]
fn native_locator_finds_npm_vendor_and_never_executes_wrapper() {
    let dir = env::temp_dir().join(format!(
        "ojousama-npm-fixture-{}-{}",
        std::process::id(),
        now_ms()
    ));
    let package = dir.join("node_modules/@openai/codex");
    let wrapper = package.join("bin/codex.js");
    fs::create_dir_all(wrapper.parent().unwrap()).unwrap();
    fs::write(&wrapper, "throw new Error('must not run');").unwrap();
    let native = package
        .join("vendor")
        .join(native_target())
        .join("codex")
        .join(if cfg!(windows) { "codex.exe" } else { "codex" });
    fs::create_dir_all(native.parent().unwrap()).unwrap();
    fs::write(&native, "native fixture").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&native, fs::Permissions::from_mode(0o755)).unwrap();
    }
    assert_eq!(
        locate_codex(wrapper.to_str().unwrap()).unwrap(),
        fs::canonicalize(native).unwrap()
    );
    assert!(locate_codex(dir.join("missing").to_str().unwrap()).is_err());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn completed_task_reaps_descendants_that_inherit_its_pipes() {
    let (manager, request, dir, _) = setup("spawn-descendant");
    manager.start(request).unwrap();
    let done = wait(&manager, |view| terminal(&view.status));
    assert_eq!(done.status, "completed");
    assert_eq!(done.output, "DESCENDANT_DONE");
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn restricted_observation_has_no_tools_and_image_never_enters_history() {
    let (manager, mut request, dir, _) = setup("restricted");
    request.restricted = true;
    request.permission = "workspace-write".into();
    request.image = Some("data:image/png;base64,fixture".into());
    manager.start(request).unwrap();
    let done = wait(&manager, |v| terminal(&v.status));
    assert_eq!(done.status, "completed");
    assert_eq!(done.output, "MOCK_OK");
    assert_eq!(done.permission, "read-only");
    let history = fs::read_to_string(dir.join("history.json")).unwrap();
    assert!(!history.contains("base64"));
    assert!(manager.shared.state.lock().unwrap().records[0]
        .request
        .image
        .is_none());
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn restricted_observation_stops_a_server_that_attempts_a_tool() {
    let (manager, mut request, dir, _) = setup("restricted-malicious");
    request.restricted = true;
    manager.start(request).unwrap();
    let done = wait(&manager, |v| terminal(&v.status));
    assert_eq!(done.status, "failed");
    assert!(done.error.unwrap().contains("未授权"));
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn ephemeral_manager_does_not_create_a_journal() {
    let (mut manager, request, dir, _) = setup("success");
    Arc::get_mut(&mut manager.shared).unwrap().history = None;
    manager.start(request).unwrap();
    wait(&manager, |v| terminal(&v.status));
    assert!(!dir.join("history.json").exists());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn dsh_stream_is_drained_before_finish_and_keeps_its_session_namespace() {
    let (manager, mut request, dir, _) = setup("dsh-success");
    request.backend = "dsh".into();
    request.dsh_test_home = Some(dir.clone());
    manager.start(request).unwrap();
    let result = wait(&manager, |v| terminal(&v.status));
    assert_eq!(result.status, "completed");
    assert_eq!(result.output, "DSH_OK");
    assert_eq!(result.thread_id.as_deref(), Some("dsh-fixture-session"));
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn dsh_cancellation_reaps_its_owned_host() {
    let (manager, mut request, dir, _) = setup("dsh-hang");
    request.backend = "dsh".into();
    request.dsh_test_home = Some(dir.clone());
    let task = manager.start(request).unwrap();
    wait(&manager, |v| v.status == "thinking");
    manager.cancel(task.id).unwrap();
    let result = wait(&manager, |v| terminal(&v.status));
    assert_eq!(result.status, "cancelled");
    manager.shutdown();
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn legacy_full_access_is_preserved_for_explicit_interactive_tasks() {
    let (manager, mut request, dir, _) = setup("success");
    request.permission = "danger-full-access".into();
    manager.start(request).unwrap();
    let done = wait(&manager, |v| terminal(&v.status));
    assert_eq!(done.status, "completed");
    assert_eq!(done.permission, "danger-full-access");
    fs::remove_dir_all(dir).unwrap();
}
