#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;
mod motion;

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
        "motion":*state.motion.lock().unwrap() })
}

fn panel_only(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "panel" {
        Ok(())
    } else {
        Err("请从任务窗口执行此操作".into())
    }
}
#[tauri::command]
fn save_settings(
    window: WebviewWindow,
    state: tauri::State<State>,
    settings: Settings,
) -> Result<(), String> {
    panel_only(&window)?;
    if !["read-only", "workspace-write"].contains(&settings.permission.as_str()) {
        return Err("无效的权限选项".into());
    }
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
    request: StartRequest,
) -> Result<TaskView, String> {
    panel_only(&window)?;
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
            let check_button = motion.lock().unwrap().phase == "dragging";
            let pressed = check_button && left_pressed();
            let mut m = motion.lock().unwrap();
            let previous = m.phase.clone();
            let moving = previous != "settled";
            if previous == "dragging" {
                // Pointer capture is the primary input. Only a hardware press that was
                // actually observed may trigger the outside-window release backstop.
                if pressed {
                    m.hardware_seen = true;
                } else if m.hardware_seen {
                    m.release();
                }
            }
            if m.phase == "flying" {
                if let (Some(monitor), Some(size)) = (monitor, size) {
                    let area = monitor.work_area();
                    let left = area.position.x as f64;
                    let top = area.position.y as f64;
                    let right = (left + area.size.width as f64 - size.width as f64).max(left);
                    let bottom = (top + area.size.height as f64 - size.height as f64).max(top);
                    m.step(dt, (left, top, right, bottom));
                }
            }
            let snapshot = m.clone();
            drop(m);
            if moving && snapshot.phase != "dragging" {
                let _ = window.set_position(PhysicalPosition::new(
                    snapshot.x.round() as i32,
                    snapshot.y.round() as i32,
                ));
            }
            if previous != snapshot.phase {
                trace_motion(&window, &snapshot);
                let _ = window.emit("motion:update", snapshot.clone());
            }
            let in_motion = snapshot.phase != "settled";
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
            app.manage(State {
                tasks,
                settings: Mutex::new(settings),
                settings_path,
                motion: motion.clone(),
                regions: regions.clone(),
                stop: stop.clone(),
                positionable,
            });
            let show = MenuItem::with_id(app, "show", "打开任务", true, None::<&str>)?;
            let show_pet = MenuItem::with_id(app, "pet", "显示桌宠", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出原型", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &show_pet, &quit])?;
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
            drag_end
        ])
        .build(tauri::generate_context!())
        .expect("启动轻量桌宠失败");
    application.run(|app, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
            let state = app.state::<State>();
            state.stop.store(true, Ordering::Relaxed);
            state.tasks.shutdown();
        }
    });
}
