#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;
mod companion;
mod growth;
mod motion;
mod observer;
mod service;
mod utilities;
mod windows;

use backend::{StartRequest, TaskManager, TaskView};
use motion::Motion;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_dialog::DialogExt;

// Opt-in numeric trace for real pointer/inertia acceptance; no prompts or screen data.
fn trace_motion(window: &WebviewWindow, motion: &Motion) {
    if !std::env::args().any(|arg| arg == "--diagnostics") {
        return;
    }
    use std::io::Write;
    let result = (|| -> Result<(), Box<dyn std::error::Error>> {
        let path = window
            .app_handle()
            .path()
            .app_data_dir()?
            .join("motion.jsonl");
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(path)?;
        writeln!(file, "{}", serde_json::to_string(motion)?)?;
        Ok(())
    })();
    if let Err(error) = result {
        eprintln!("motion diagnostics: {error}");
    }
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    #[serde(default)]
    codex_path: String,
    #[serde(default)]
    workspace: String,
    #[serde(default = "read_only")]
    permission: String,
    #[serde(default)]
    model: String,
}
fn read_only() -> String {
    "read-only".into()
}

#[derive(Clone, Deserialize)]
struct Rect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

struct State {
    tasks: TaskManager,
    service: service::Service,
    settings: Mutex<Settings>,
    settings_path: PathBuf,
    motion: Arc<Mutex<Motion>>,
    regions: Arc<Mutex<Vec<Rect>>>,
    stop: Arc<AtomicBool>,
    positionable: bool,
}

fn panel(app: &tauri::AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("panel").ok_or("任务窗口不可用")?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}
#[tauri::command]
fn show_panel(app: tauri::AppHandle) -> Result<(), String> {
    panel(&app)
}
#[tauri::command]
fn hide_panel(window: WebviewWindow) -> Result<(), String> {
    window.hide().map_err(|e| e.to_string())
}
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn bootstrap(state: tauri::State<State>) -> Value {
    json!({ "platform":std::env::consts::OS, "positionable":state.positionable,
        "tasks":state.tasks.list(), "settings":*state.settings.lock().unwrap(),
        "motion":*state.motion.lock().unwrap(), "companion":state.service.snapshot() })
}

fn panel_only(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "panel" {
        Ok(())
    } else {
        Err("请从任务窗口执行此操作".into())
    }
}
async fn confirm_permission(app: tauri::AppHandle, old: &str, new: &str) -> Result<(), String> {
    if new == "danger-full-access" && old != "danger-full-access" {
        let allowed=tauri::async_runtime::spawn_blocking(move||app.dialog().message("完全访问会允许任务读写工作目录以外的文件并运行命令。只应为你信任的任务开启。是否继续？").title("启用完全访问").kind(tauri_plugin_dialog::MessageDialogKind::Warning).buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancel).blocking_show()).await.map_err(|e|e.to_string())?;
        if !allowed {
            return Err("已取消权限变更".into());
        }
    }
    Ok(())
}
#[tauri::command]
async fn save_settings(
    window: WebviewWindow,
    state: tauri::State<'_, State>,
    settings: Settings,
) -> Result<(), String> {
    panel_only(&window)?;
    if !["read-only", "workspace-write", "danger-full-access"]
        .contains(&settings.permission.as_str())
    {
        return Err("无效的权限选项".into());
    }
    let previous = state.settings.lock().unwrap().permission.clone();
    confirm_permission(window.app_handle().clone(), &previous, &settings.permission).await?;
    let bytes = serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?;
    let temporary = state.settings_path.with_extension("tmp");
    std::fs::write(&temporary, bytes).map_err(|e| e.to_string())?;
    // Windows rename cannot overwrite an existing file. These settings are local preferences,
    // not the task journal; keep the previous value intact if the staging write fails.
    #[cfg(windows)]
    if state.settings_path.exists() {
        std::fs::remove_file(&state.settings_path).map_err(|e| e.to_string())?;
    }
    std::fs::rename(temporary, &state.settings_path).map_err(|e| e.to_string())?;
    state.service.apply("settings:set",json!({"cwd":settings.workspace,"permission":settings.permission,"codexExe":settings.codex_path,"codexModel":settings.model}))?;
    *state.settings.lock().unwrap() = settings;
    Ok(())
}
#[tauri::command]
async fn choose_workspace(
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    panel_only(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("选择任务工作目录")
            .blocking_pick_folder()
            .map(|p| {
                p.into_path()
                    .map(|p| p.to_string_lossy().into_owned())
                    .map_err(|e| e.to_string())
            })
            .transpose()
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn task_start(
    window: WebviewWindow,
    state: tauri::State<State>,
    mut request: StartRequest,
) -> Result<TaskView, String> {
    panel_only(&window)?;
    if request.permission == "danger-full-access"
        && state.settings.lock().unwrap().permission != "danger-full-access"
    {
        return Err("请先在设置中确认完全访问权限".into());
    }
    let data = state.service.data.snapshot();
    request.backend = data["settings"]["backend"]
        .as_str()
        .unwrap_or("codex")
        .into();
    request.reasoning_effort = data["settings"]["codexEffort"]
        .as_str()
        .unwrap_or("")
        .into();
    request.backend_settings = json!({});
    for key in [
        "dshExe",
        "sourceProfile",
        "provider",
        "model",
        "reasoningEffort",
    ] {
        request.backend_settings[key] = data["settings"][key].clone();
    }
    state.tasks.start(request)
}
#[tauri::command]
fn task_retry(
    window: WebviewWindow,
    state: tauri::State<State>,
    id: u64,
) -> Result<TaskView, String> {
    panel_only(&window)?;
    state.tasks.retry(id)
}
#[tauri::command]
fn task_cancel(state: tauri::State<State>, id: u64) -> Result<(), String> {
    state.tasks.cancel(id)
}
#[tauri::command]
fn task_approval(
    window: WebviewWindow,
    state: tauri::State<State>,
    id: u64,
    request_id: Value,
    accept: bool,
) -> Result<(), String> {
    panel_only(&window)?;
    state.tasks.approve(id, request_id, accept)
}
#[tauri::command]
fn task_answer(
    window: WebviewWindow,
    state: tauri::State<State>,
    id: u64,
    request_id: Value,
    answers: Value,
) -> Result<(), String> {
    panel_only(&window)?;
    state.tasks.answer(id, request_id, answers)
}

#[tauri::command]
fn note_show(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("note") {
        if w.is_visible().map_err(|e| e.to_string())? {
            return Ok(());
        }
    }
    note_toggle(app)
}
#[tauri::command]
fn note_toggle(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<State>();
    if let Some(note) = app.get_webview_window("note") {
        if note.is_visible().map_err(|e| e.to_string())? {
            note.hide().map_err(|e| e.to_string())?;
        } else {
            note.show().map_err(|e| e.to_string())?;
        }
    } else {
        let data = state.service.data.snapshot();
        let note = WebviewWindowBuilder::new(&app, "note", WebviewUrl::App("note.html".into()))
            .title("今天的小事")
            .inner_size(270.0, 360.0)
            .min_inner_size(220.0, 180.0)
            .always_on_top(data["note"]["pinned"] != false)
            .build()
            .map_err(|e| e.to_string())?;
        if let (Some(x), Some(y)) = (data["note"]["x"].as_f64(), data["note"]["y"].as_f64()) {
            note.set_position(PhysicalPosition::new(x as i32, y as i32))
                .map_err(|e| e.to_string())?;
        }
        let service = state.service.clone();
        let win = note.clone();
        note.on_window_event(move |event| {
            if let tauri::WindowEvent::Moved(pos) = event {
                if let Err(e) = service.data.change(|d| {
                    d["note"]["x"] = json!(pos.x);
                    d["note"]["y"] = json!(pos.y);
                    Ok(())
                }) {
                    eprintln!("note position: {e}");
                }
            } else if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = win.hide();
            }
        });
    }
    if let Some(note) = app.get_webview_window("note") {
        let open = note.is_visible().map_err(|e| e.to_string())?;
        state.service.data.change(|d| {
            d["note"]["open"] = json!(open);
            Ok(())
        })?;
    }
    Ok(())
}
#[tauri::command]
fn note_update(
    window: WebviewWindow,
    state: tauri::State<State>,
    id: Value,
    done: bool,
) -> Result<Value, String> {
    if window.label() != "note" {
        return Err("仅便签可更新此操作".into());
    }
    state
        .service
        .apply("todo:update", json!({"id":id,"patch":{"done":done}}))
}
#[tauri::command]
fn note_add(
    window: WebviewWindow,
    state: tauri::State<State>,
    text: String,
) -> Result<Value, String> {
    if window.label() != "note" {
        return Err("仅便签可添加此操作".into());
    }
    state.service.apply("todo:add", json!({"text":text}))
}
#[tauri::command]
async fn companion_command(
    window: WebviewWindow,
    state: tauri::State<'_, State>,
    command: String,
    args: Value,
) -> Result<Value, String> {
    if window.label() != "panel"
        && !matches!(
            command.as_str(),
            "screen:pause" | "alert:ack" | "pomodoro:stop"
        )
    {
        return Err("请从控制面板执行此操作".into());
    }
    if command == "settings:set" {
        if let Some(permission) = args["permission"].as_str() {
            let previous = state.service.data.snapshot()["settings"]["permission"]
                .as_str()
                .unwrap_or("read-only")
                .to_string();
            confirm_permission(window.app_handle().clone(), &previous, permission).await?;
        }
    }
    let service = state.service.clone();
    let operation = command.clone();
    let result = tauri::async_runtime::spawn_blocking(move || service.apply(&operation, args))
        .await
        .map_err(|e| e.to_string())??;
    if command == "settings:set" {
        let d = state.service.data.snapshot();
        let s = &d["settings"];
        let settings = Settings {
            workspace: s["cwd"].as_str().unwrap_or("").into(),
            permission: s["permission"].as_str().unwrap_or("read-only").into(),
            codex_path: s["codexExe"].as_str().unwrap_or("").into(),
            model: s["codexModel"].as_str().unwrap_or("").into(),
        };
        companion::save(
            &state.settings_path,
            &serde_json::to_value(&settings).map_err(|e| e.to_string())?,
        )?;
        *state.settings.lock().unwrap() = settings;
    }
    Ok(result)
}
#[tauri::command]
async fn observer_windows(window: WebviewWindow) -> Result<Vec<Value>, String> {
    panel_only(&window)?;
    tauri::async_runtime::spawn_blocking(observer::choices)
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
fn observer_status(window: WebviewWindow) -> Result<bool, String> {
    panel_only(&window)?;
    Ok(observer::permission())
}
#[tauri::command]
fn observer_permission(window: WebviewWindow) -> Result<bool, String> {
    panel_only(&window)?;
    Ok(observer::request_permission())
}
#[tauri::command]
async fn look_now(
    window: WebviewWindow,
    state: tauri::State<'_, State>,
    chosen: Option<u32>,
) -> Result<(), String> {
    panel_only(&window)?;
    let service = state.service.clone();
    tauri::async_runtime::spawn_blocking(move || service.look(chosen, true))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn set_hit_regions(
    window: WebviewWindow,
    state: tauri::State<State>,
    regions: Vec<Rect>,
) -> Result<(), String> {
    if window.label() != "pet" {
        return Err("仅桌宠可设置命中区域".into());
    }
    *state.regions.lock().unwrap() = regions
        .into_iter()
        .filter(|r| {
            [r.x, r.y, r.width, r.height].iter().all(|n| n.is_finite())
                && r.width > 0.0
                && r.height > 0.0
        })
        .take(128)
        .collect();
    Ok(())
}
#[tauri::command]
fn set_reduced_motion(state: tauri::State<State>, enabled: bool) {
    let mut motion = state.motion.lock().unwrap();
    motion.reduced = enabled;
    if enabled && motion.phase == "flying" {
        motion.phase = "settled".into();
        motion.vx = 0.0;
        motion.vy = 0.0;
    }
}
#[tauri::command]
fn drag_begin(
    window: WebviewWindow,
    state: tauri::State<State>,
    x: f64,
    y: f64,
) -> Result<(), String> {
    if !state.positionable || window.label() != "pet" {
        return Err("当前桌面由系统管理窗口位置".into());
    }
    if !x.is_finite() || !y.is_finite() {
        return Err("无效的指针坐标".into());
    }
    let position = window.outer_position().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().unwrap_or(1.0);
    let mut motion = state.motion.lock().unwrap();
    motion.x = position.x as f64;
    motion.y = position.y as f64;
    motion.scale = scale;
    motion.begin((x * scale, y * scale));
    let snapshot = motion.clone();
    drop(motion);
    trace_motion(&window, &snapshot);
    window
        .emit("motion:update", snapshot)
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn drag_move(
    window: WebviewWindow,
    state: tauri::State<State>,
    x: f64,
    y: f64,
) -> Result<(), String> {
    if window.label() != "pet" || !state.positionable {
        return Err("当前窗口不能拖动".into());
    }
    if !x.is_finite() || !y.is_finite() {
        return Err("无效的指针坐标".into());
    }
    let mut motion = state.motion.lock().unwrap();
    if motion.phase != "dragging" {
        return Ok(());
    }
    let dt = motion.last_sample.elapsed().as_secs_f64().clamp(0.001, 0.1);
    let scale = motion.scale;
    motion.drag((x * scale, y * scale), dt);
    let position = PhysicalPosition::new(motion.x.round() as i32, motion.y.round() as i32);
    drop(motion);
    window.set_position(position).map_err(|e| e.to_string())
}
#[tauri::command]
fn drag_end(window: WebviewWindow, state: tauri::State<State>) -> Result<(), String> {
    let mut motion = state.motion.lock().unwrap();
    motion.release();
    let snapshot = motion.clone();
    drop(motion);
    trace_motion(&window, &snapshot);
    window
        .emit("motion:update", snapshot)
        .map_err(|e| e.to_string())
}

fn window_seats(window: &WebviewWindow, scale: f64) -> Result<Vec<windows::Seat>, String> {
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("没有可用的显示器")?;
    let area = monitor.work_area();
    let native = windows::visible(scale)?;
    if std::env::args().any(|arg| arg == "--diagnostics") {
        let path = window
            .app_handle()
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("windows.json");
        let value = json!({"scale":scale,"ownPid":std::process::id(),"petPosition":window.outer_position().ok(),"area": {"x":area.position.x,"y":area.position.y,"width":area.size.width,"height":area.size.height},"windows":native});
        std::fs::write(path, serde_json::to_vec(&value).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    }
    Ok(windows::seats(&native, scale)
        .into_iter()
        .filter_map(|mut seat| {
            if seat.top < area.position.y as f64 + 128.0 * scale
                || seat.top > area.position.y as f64 + area.size.height as f64 - 40.0 * scale
            {
                return None;
            }
            seat.left = seat.left.max(area.position.x as f64 + 8.0 * scale);
            seat.right = seat
                .right
                .min(area.position.x as f64 + area.size.width as f64 - 8.0 * scale);
            (seat.right - seat.left >= 60.0 * scale).then_some(seat)
        })
        .collect())
}

fn toggle_perch(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<State>();
    if !state.positionable {
        return Err("当前桌面不支持窗口停靠，请使用 X11 或 XWayland".into());
    }
    let window = app.get_webview_window("pet").ok_or("桌宠窗口不可用")?;
    let current = state.motion.lock().unwrap().clone();
    if current.phase == "dragging" {
        return Err("请先放下桌宠".into());
    }
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let seats = if current.phase == "perched" {
        Vec::new()
    } else {
        window_seats(&window, scale)?
    };
    // Explicit "sit" chooses the frontmost usable window, then the nearest span
    // on that window. Do not jump to an unrelated back window just because it is closer.
    let front = seats.first().map(|s| s.window.id);
    let target = seats
        .into_iter()
        .filter(|s| Some(s.window.id) == front)
        .min_by(|a, b| {
            let centre = current.x + size.width as f64 / 2.0;
            let score =
                |s: &windows::Seat| (centre - centre.clamp(s.left, s.right)).abs() + s.top * 0.05;
            score(a).total_cmp(&score(b))
        });
    let mut m = state.motion.lock().unwrap();
    if current.phase == "perched" {
        m.leave();
    } else {
        let seat = target.ok_or("没有可坐的窗口上沿，请将一个普通窗口移到屏幕中部")?;
        m.scale = scale;
        m.sit(seat, (size.width as f64, size.height as f64));
    }
    let snapshot = m.clone();
    drop(m);
    window
        .set_position(PhysicalPosition::new(
            snapshot.x.round() as i32,
            snapshot.y.round() as i32,
        ))
        .map_err(|e| e.to_string())?;
    trace_motion(&window, &snapshot);
    window
        .emit("motion:update", snapshot)
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn perch_toggle(window: WebviewWindow, app: tauri::AppHandle) -> Result<(), String> {
    if window.label() != "pet" {
        return Err("请从桌宠操作窗口停靠".into());
    }
    toggle_perch(&app)
}

#[cfg(target_os = "macos")]
fn left_pressed() -> bool {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceButtonState(state_id: i32, button: u32) -> bool;
    }
    unsafe { CGEventSourceButtonState(0, 0) }
}
#[cfg(target_os = "windows")]
fn left_pressed() -> bool {
    #[link(name = "user32")]
    extern "system" {
        fn GetAsyncKeyState(key: i32) -> i16;
    }
    unsafe { GetAsyncKeyState(1) < 0 }
}
#[cfg(target_os = "linux")]
fn left_pressed() -> bool {
    use std::ffi::{c_char, c_int, c_uint, c_ulong, c_void};
    #[link(name = "X11")]
    extern "C" {
        fn XOpenDisplay(name: *const c_char) -> *mut c_void;
        fn XDefaultRootWindow(display: *mut c_void) -> c_ulong;
        fn XQueryPointer(
            display: *mut c_void,
            window: c_ulong,
            root: *mut c_ulong,
            child: *mut c_ulong,
            root_x: *mut c_int,
            root_y: *mut c_int,
            win_x: *mut c_int,
            win_y: *mut c_int,
            mask: *mut c_uint,
        ) -> c_int;
        fn XCloseDisplay(display: *mut c_void) -> c_int;
    }
    unsafe {
        let display = XOpenDisplay(std::ptr::null());
        if display.is_null() {
            return false;
        }
        let (mut root, mut child, mut rx, mut ry, mut wx, mut wy, mut mask) = (0, 0, 0, 0, 0, 0, 0);
        let ok = XQueryPointer(
            display,
            XDefaultRootWindow(display),
            &mut root,
            &mut child,
            &mut rx,
            &mut ry,
            &mut wx,
            &mut wy,
            &mut mask,
        );
        XCloseDisplay(display);
        ok != 0 && mask & (1 << 8) != 0
    }
}

fn start_motion(
    window: WebviewWindow,
    motion: Arc<Mutex<Motion>>,
    regions: Arc<Mutex<Vec<Rect>>>,
    stop: Arc<AtomicBool>,
) {
    std::thread::spawn(move || {
        let mut last = Instant::now();
        let mut ignored = false;
        let mut visible_seats = Vec::new();
        let mut windows_at = Instant::now() - Duration::from_secs(1);
        let mut last_window_error = String::new();
        while !stop.load(Ordering::Relaxed) {
            let now = Instant::now();
            let dt = now.duration_since(last).as_secs_f64().clamp(0.001, 0.05);
            last = now;
            // Window queries may synchronously marshal to the UI thread. Never hold a
            // shared state lock while querying, moving or emitting to a window.
            let cursor = window.cursor_position().ok();
            let position = window.outer_position().ok();
            let scale = window.scale_factor().unwrap_or(1.0);
            let monitor = window.current_monitor().ok().flatten();
            let size = window.outer_size().ok();
            let observed_phase = motion.lock().unwrap().phase.clone();
            if matches!(observed_phase.as_str(), "flying" | "perched")
                && windows_at.elapsed()
                    >= Duration::from_millis(if observed_phase == "flying" { 100 } else { 400 })
            {
                windows_at = Instant::now();
                match window_seats(&window, scale) {
                    Ok(seats) => {
                        visible_seats = seats;
                        last_window_error.clear();
                    }
                    Err(error) => {
                        visible_seats.clear();
                        if error != last_window_error {
                            let _ = window.emit("pet:error", error.clone());
                            last_window_error = error;
                        }
                    }
                }
            }
            let check_button = observed_phase == "dragging";
            let pressed = check_button && left_pressed();
            let mut m = motion.lock().unwrap();
            let previous = m.phase.clone();
            let moving = previous == "flying";
            if previous == "dragging" {
                // Pointer capture is the primary input. Only a hardware press that was
                // actually observed may trigger the outside-window release backstop.
                if pressed {
                    m.hardware_seen = true;
                } else if m.hardware_seen {
                    m.release();
                }
            }
            if m.phase == "perched" && windows_at >= m.last_sample {
                let centre = m.x + size.map(|s| s.width as f64 / 2.0).unwrap_or(180.0 * scale);
                let valid = m
                    .seat
                    .as_ref()
                    .is_some_and(|seat| seat.remains_visible(&visible_seats, centre, scale));
                if !valid {
                    m.leave();
                }
            }
            if m.phase == "flying" {
                let previous_feet =
                    m.y + size.map(|s| s.height as f64).unwrap_or(340.0 * scale) - 5.0 * scale;
                if let (Some(monitor), Some(size)) = (monitor, size) {
                    let area = monitor.work_area();
                    let left = area.position.x as f64;
                    let top = area.position.y as f64;
                    let right = (left + area.size.width as f64 - size.width as f64).max(left);
                    let bottom = (top + area.size.height as f64 - size.height as f64).max(top);
                    m.step(dt, (left, top, right, bottom));
                    m.land(
                        &visible_seats,
                        previous_feet,
                        (size.width as f64, size.height as f64),
                    );
                }
            }
            let snapshot = m.clone();
            drop(m);
            if moving || snapshot.phase == "flying" {
                let _ = window.set_position(PhysicalPosition::new(
                    snapshot.x.round() as i32,
                    snapshot.y.round() as i32,
                ));
            }
            if previous != snapshot.phase {
                trace_motion(&window, &snapshot);
                let _ = window.emit("motion:update", snapshot.clone());
            }
            let in_motion = matches!(snapshot.phase.as_str(), "dragging" | "flying");
            if window.is_visible().unwrap_or(false) {
                if let (Some(cursor), Some(position)) = (cursor, position) {
                    let x = (cursor.x - position.x as f64) / scale;
                    let y = (cursor.y - position.y as f64) / scale;
                    let inside = snapshot.phase == "dragging"
                        || regions.lock().unwrap().iter().any(|r| {
                            x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height
                        });
                    if ignored == inside && window.set_ignore_cursor_events(!inside).is_ok() {
                        ignored = !inside;
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(if in_motion { 16 } else { 80 }));
        }
    });
}

fn main() {
    // Prefer XWayland when available. Native Wayland remains an ordinary, stationary window.
    let positionable = !(cfg!(target_os = "linux")
        && std::env::var_os("WAYLAND_DISPLAY").is_some()
        && std::env::var_os("DISPLAY").is_none());
    if cfg!(target_os = "linux") && positionable && std::env::var_os("DISPLAY").is_some() {
        std::env::set_var("GDK_BACKEND", "x11");
    }
    let application = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let settings_path = data_dir.join("settings.json");
            let settings = match std::fs::read(&settings_path) {
                Ok(bytes) => {
                    serde_json::from_slice(&bytes).map_err(|e| format!("无法读取原型设置：{e}"))?
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Settings {
                    permission: read_only(),
                    ..Settings::default()
                },
                Err(e) => return Err(e.into()),
            };
            let panel_window = WebviewWindowBuilder::new(
                app,
                "panel",
                WebviewUrl::App("index.html?view=panel".into()),
            )
            .title("Ojousama Lite · 任务")
            .inner_size(680.0, 720.0)
            .min_inner_size(520.0, 540.0)
            .visible(false)
            .build()?;
            let pet = WebviewWindowBuilder::new(
                app,
                "pet",
                WebviewUrl::App("index.html?view=pet".into()),
            )
            .title("Ojousama Lite")
            .inner_size(360.0, 340.0)
            .resizable(false)
            .transparent(positionable)
            .decorations(!positionable)
            .shadow(false)
            .always_on_top(positionable)
            .skip_taskbar(positionable)
            .build()?;
            let mut initial = Motion::new(100.0, 100.0);
            if positionable {
                if let Some(monitor) = pet.primary_monitor()? {
                    let area = monitor.work_area();
                    let size = pet.outer_size()?;
                    initial.x = (area.position.x as f64 + area.size.width as f64 * 0.72
                        - size.width as f64 / 2.0)
                        .max(area.position.x as f64);
                    initial.y = (area.position.y as f64 + area.size.height as f64
                        - size.height as f64)
                        .max(area.position.y as f64);
                    pet.set_position(PhysicalPosition::new(initial.x as i32, initial.y as i32))?;
                }
            }
            let motion = Arc::new(Mutex::new(initial));
            let regions = Arc::new(Mutex::new(Vec::new()));
            let stop = Arc::new(AtomicBool::new(false));
            let handle = app.handle().clone();
            let tasks = TaskManager::new(
                data_dir.join("tasks.json"),
                Arc::new(move |task| {
                    let _ = handle.emit("task:update", task);
                }),
            );
            let legacy = app
                .path()
                .config_dir()?
                .join("claude-ojousama")
                .join("pet-data.json");
            let companion =
                companion::Companion::open(data_dir.join("pet-data.json"), Some(&legacy))?;
            // Preserve prototype connection choices while importing the full companion data.
            let prototype_settings = settings.clone();
            if !data_dir.join("companion-migrated").exists() {
                let has_legacy = legacy.is_file();
                let has_prototype = data_dir.join("settings.json").is_file();
                companion.change(|d| {
                    if !has_legacy && has_prototype {
                        d["settings"]["backend"] = json!("codex");
                        d["settings"]["cwd"] = json!(prototype_settings.workspace);
                        d["settings"]["permission"] = json!(prototype_settings.permission);
                        d["settings"]["codexExe"] = json!(prototype_settings.codex_path);
                        d["settings"]["codexModel"] = json!(prototype_settings.model);
                    } else if d["settings"]["codexExe"].as_str().is_none_or(str::is_empty)
                        && !prototype_settings.codex_path.is_empty()
                    {
                        d["settings"]["codexExe"] = json!(prototype_settings.codex_path);
                    }
                    Ok(())
                })?;
                std::fs::write(data_dir.join("companion-migrated"), b"1")?;
            }
            let effective = companion.snapshot();
            let effective = &effective["settings"];
            let settings = Settings {
                workspace: effective["cwd"].as_str().unwrap_or("").into(),
                codex_path: effective["codexExe"].as_str().unwrap_or("").into(),
                permission: effective["permission"]
                    .as_str()
                    .unwrap_or("read-only")
                    .into(),
                model: effective["codexModel"].as_str().unwrap_or("").into(),
            };
            let handle = app.handle().clone();
            let service = service::Service::new(
                companion,
                tasks.clone(),
                data_dir.join("observer-workspace"),
                app.path().document_dir()?,
                Arc::new(move |name, payload| {
                    let _ = handle.emit(name, payload);
                }),
            )?;
            let service_loop = service.clone();
            let service_stop = stop.clone();
            std::thread::spawn(move || {
                while !service_stop.load(Ordering::Relaxed) {
                    if let Err(error) = service_loop.tick() {
                        eprintln!("companion: {error}");
                    }
                    std::thread::sleep(Duration::from_secs(4));
                }
            });
            app.manage(State {
                tasks,
                service,
                settings: Mutex::new(settings),
                settings_path,
                motion: motion.clone(),
                regions: regions.clone(),
                stop: stop.clone(),
                positionable,
            });
            let show = MenuItem::with_id(app, "show", "打开任务", true, None::<&str>)?;
            let show_pet = MenuItem::with_id(app, "pet", "显示桌宠", true, None::<&str>)?;
            let perch =
                MenuItem::with_id(app, "perch", "坐上窗口 / 下来", positionable, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出原型", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &show_pet, &perch, &quit])?;
            let mut tray = TrayIconBuilder::new()
                .tooltip("Ojousama Lite")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        let _ = panel(app);
                    }
                    "pet" => {
                        if let Some(window) = app.get_webview_window("pet") {
                            let _ = window.show();
                        }
                    }
                    "perch" => {
                        if let Err(error) = toggle_perch(app) {
                            let _ = app.emit("pet:error", error);
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            panel_window.on_window_event({
                let window = panel_window.clone();
                move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
            });
            if app.state::<State>().service.data.snapshot()["note"]["open"] == true {
                note_show(app.handle().clone())?;
            }
            if positionable {
                start_motion(pet, motion, regions, stop);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            show_panel,
            hide_panel,
            quit_app,
            save_settings,
            choose_workspace,
            task_start,
            task_retry,
            task_cancel,
            task_approval,
            task_answer,
            set_hit_regions,
            set_reduced_motion,
            drag_begin,
            drag_move,
            drag_end,
            perch_toggle,
            companion_command,
            observer_windows,
            observer_status,
            observer_permission,
            look_now,
            note_show,
            note_toggle,
            note_update,
            note_add
        ])
        .build(tauri::generate_context!())
        .expect("启动轻量桌宠失败");
    application.run(|app, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
            let state = app.state::<State>();
            state.stop.store(true, Ordering::Relaxed);
            state.tasks.shutdown();
            state.service.shutdown();
        }
    });
}
