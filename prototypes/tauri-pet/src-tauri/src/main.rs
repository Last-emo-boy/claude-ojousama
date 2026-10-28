#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod accessibility;
mod agenda;
mod alerts;
mod backend;
mod behavior;
mod clipboard_watch;
mod companion;
mod desktop;
mod desktop_entry;
mod file_watch;
mod growth;
mod intent;
mod motion;
mod observer;
mod panel;
mod service;
mod sprites;
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
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

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

fn trace_windows(
    window: &WebviewWindow,
    screens: &[desktop::Screen],
    native: &[windows::WindowRect],
    scale: f64,
    position: Option<desktop::Point>,
    size: desktop::Point,
) {
    if !std::env::args().any(|arg| arg == "--diagnostics") {
        return;
    }
    let result = (|| -> Result<(), String> {
        let area = position
            .and_then(|p| {
                desktop::nearest(screens, (p.0 + size.0 / 2.0, p.1 + size.1 - 5.0 * scale))
            })
            .map(|i| screens[i].work);
        let value = json!({"scale":scale,"coordinateSpace":if cfg!(target_os="macos"){"logical-points"}else{"physical-pixels"},"ownPid":std::process::id(),"petPosition":position.map(|p|json!({"x":p.0,"y":p.1})),"area":area,"screens":screens,"windows":native});
        let path = window
            .app_handle()
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("windows.json");
        std::fs::write(path, serde_json::to_vec(&value).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())
    })();
    if let Err(error) = result {
        eprintln!("window diagnostics: {error}");
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
    desktop_entry: Arc<Mutex<desktop_entry::Controller>>,
    clipboard_pending: AtomicBool,
    pet_interacting: AtomicBool,
    panel: Mutex<panel::Session>,
}

struct DesktopHost {
    app: tauri::AppHandle,
    service: service::Service,
    shortcut_supported: bool,
}
impl desktop_entry::Host for DesktopHost {
    fn register(&mut self, key: Shortcut) -> Result<(), String> {
        if !self.shortcut_supported {
            return Err("当前桌面不提供全局快捷键".into());
        }
        self.app
            .global_shortcut()
            .register(key)
            .map_err(|e| format!("快捷键未启用，可能已被占用：{e}"))
    }
    fn unregister(&mut self, key: Shortcut) -> Result<(), String> {
        if !self.shortcut_supported {
            return Ok(());
        }
        self.app
            .global_shortcut()
            .unregister(key)
            .map_err(|e| e.to_string())
    }
    fn registered(&self, key: Shortcut) -> bool {
        self.shortcut_supported && self.app.global_shortcut().is_registered(key)
    }
    fn autostart(&self) -> Result<bool, String> {
        self.app
            .autolaunch()
            .is_enabled()
            .map_err(|e| e.to_string())
    }
    fn set_autostart(&mut self, enabled: bool) -> Result<(), String> {
        if enabled {
            self.app.autolaunch().enable()
        } else {
            self.app.autolaunch().disable()
        }
        .map_err(|e| format!("登录启动设置失败：{e}"))
    }
    fn save(&mut self, args: Value) -> Result<Value, String> {
        self.service.apply("settings:set", args)
    }
}
fn request_clipboard(app: &tauri::AppHandle) -> Result<(), String> {
    if observer::screen_supported() && !observer::unlocked() {
        return Err("屏幕锁定时不读取剪贴板".into());
    }
    let state = app.state::<State>();
    state.service.clipboard_reset();
    state.clipboard_pending.store(true, Ordering::Relaxed);
    if let Err(error) = open_pet(app.clone()) {
        state.clipboard_pending.store(false, Ordering::Relaxed);
        return Err(error);
    }
    app.emit_to("pet", "clipboard:request", ())
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn clipboard_pending(window: WebviewWindow, state: tauri::State<State>) -> Result<bool, String> {
    pet_or_panel(&window)?;
    Ok(state.clipboard_pending.swap(false, Ordering::Relaxed))
}
#[tauri::command]
async fn clipboard_preview(window: WebviewWindow) -> Result<Value, String> {
    pet_or_panel(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let allowed = || -> Result<bool, String> {
            let detection = observer::screen_supported();
            let unlocked = !detection || observer::unlocked();
            let focused = window.is_focused().map_err(|e| e.to_string())?;
            Ok(desktop_entry::clipboard_allowed(
                detection, unlocked, focused,
            ))
        };
        if !allowed()? {
            return Err("请激活桌宠或面板并确认屏幕已解锁，再读取剪贴板。".into());
        }
        let text = arboard::Clipboard::new()
            .and_then(|mut clipboard| clipboard.get_text())
            .map_err(|e| format!("无法读取剪贴板文字，可直接粘贴：{e}"))?;
        if !allowed()? {
            return Err("窗口状态已变化，本次剪贴板内容未带入。".into());
        }
        desktop_entry::clipboard_preview(text)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn clipboard_offer_pending(
    window: WebviewWindow,
    state: tauri::State<State>,
) -> Result<bool, String> {
    pet_or_panel(&window)?;
    Ok(state.service.clipboard_pending())
}
#[tauri::command]
fn clipboard_offer_open(
    window: WebviewWindow,
    state: tauri::State<State>,
    token: u64,
    action: String,
) -> Result<(), String> {
    if !matches!(window.label(), "pet" | "panel") {
        return Err("请从桌宠或面板打开剪贴板操作".into());
    }
    if !observer::unlocked() {
        return Err("请先解锁屏幕，再打开剪贴板操作".into());
    }
    state.service.clipboard_choose(token, &action)?;
    if action == "no" {
        return Ok(());
    }
    state.clipboard_pending.store(false, Ordering::Relaxed);
    if let Err(error) = open_pet(window.app_handle().clone()) {
        state.service.clipboard_reset();
        return Err(error);
    }
    window
        .app_handle()
        .emit_to("pet", "clipboard:offer-request", ())
        .map_err(|e| e.to_string())
}
#[tauri::command]
async fn clipboard_offer_preview(
    window: WebviewWindow,
    state: tauri::State<'_, State>,
) -> Result<Value, String> {
    pet_or_panel(&window)?;
    let service = state.service.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if !window.is_focused().map_err(|e| e.to_string())? || !observer::unlocked() {
            return Err("请激活桌宠或面板并确认屏幕已解锁，再带入剪贴板内容。".into());
        }
        let value = service.clipboard_take()?;
        if !window.is_focused().map_err(|e| e.to_string())? || !observer::unlocked() {
            return Err("窗口状态已变化，本次剪贴板内容未带入。".into());
        }
        Ok(value)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn desktop_status(
    window: WebviewWindow,
    state: tauri::State<'_, State>,
) -> Result<Value, String> {
    panel_only(&window)?;
    let controller = state.desktop_entry.clone();
    let host = DesktopHost {
        app: window.app_handle().clone(),
        service: state.service.clone(),
        shortcut_supported: state.positionable,
    };
    tauri::async_runtime::spawn_blocking(move || {
        controller
            .lock()
            .unwrap()
            .status(&host, host.shortcut_supported)
    })
    .await
    .map_err(|e| e.to_string())
}

fn open_panel(
    app: &tauri::AppHandle,
    tab: Option<String>,
    task_id: Option<u64>,
) -> Result<(), String> {
    let state = app.state::<State>();
    let mut session = state.panel.lock().unwrap();
    session.request(tab, task_id);
    if let Some(window) = app.get_webview_window("panel") {
        if session.ready {
            window
                .emit("panel:open", session.take_target())
                .map_err(|e| e.to_string())?;
            window.show().map_err(|e| e.to_string())?;
            window.set_focus().map_err(|e| e.to_string())?;
        } else if session.parked {
            window
                .eval("location.replace('index.html?view=panel')")
                .map_err(|e| e.to_string())?;
            session.parked = false;
        }
        return Ok(());
    }
    session.ready = false;
    let window = WebviewWindowBuilder::new(
        app,
        "panel",
        WebviewUrl::App("index.html?view=panel".into()),
    )
    .title("Claude Ojousama")
    .inner_size(840.0, 720.0)
    .min_inner_size(560.0, 540.0)
    .visible(false)
    .build()
    .map_err(|e| e.to_string())?;
    if let Some((w, h)) = session.size {
        window
            .set_size(tauri::PhysicalSize::new(w, h))
            .map_err(|e| e.to_string())?;
    }
    if let Some((x, y)) = session.position {
        window
            .set_position(PhysicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
    }
    let closing = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            if let Err(error) = closing.emit("panel:close", ()) {
                eprintln!("panel close: {error}");
            }
        }
    });
    Ok(())
}
// WebView2 cannot create a WebView inside a synchronous native event handler.
fn panel(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(error) = open_panel(&app, None, None) {
            let _ = app.emit("pet:error", error);
        }
    });
}
#[tauri::command]
async fn show_panel(
    app: tauri::AppHandle,
    tab: Option<String>,
    task_id: Option<u64>,
) -> Result<(), String> {
    open_panel(&app, tab, task_id)
}
#[tauri::command]
fn panel_ready(window: WebviewWindow, state: tauri::State<State>) -> Result<(), String> {
    panel_only(&window)?;
    let mut session = state.panel.lock().unwrap();
    session.ready = true;
    session.parked = false;
    window
        .emit("panel:open", session.take_target())
        .map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}
#[tauri::command]
fn hide_panel(
    window: WebviewWindow,
    state: tauri::State<State>,
    view_state: Option<Value>,
) -> Result<(), String> {
    if window.label() != "panel" {
        return window.hide().map_err(|e| e.to_string());
    }
    let mut session = state.panel.lock().unwrap();
    if let Some(view) = view_state {
        session.view = view;
    }
    session.position = window.outer_position().ok().map(|p| (p.x, p.y));
    session.size = window.inner_size().ok().map(|s| (s.width, s.height));
    // Keep the native accessibility/window identity stable. Navigating away drops
    // the panel DOM, listeners and render resources without retaining a hidden UI.
    window.hide().map_err(|e| e.to_string())?;
    // Replace, not a history navigation: a back/forward cache must not retain
    // the full settings page behind the otherwise empty parked document.
    window
        .eval("location.replace('park.html')")
        .map_err(|e| e.to_string())?;
    session.ready = false;
    session.parked = true;
    Ok(())
}
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
async fn sprite_bands(
    window: WebviewWindow,
    name: String,
) -> Result<Vec<Vec<sprites::Band>>, String> {
    if window.label() != "pet" {
        return Err("请从桌宠加载角色动作".into());
    }
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let assets = app.asset_resolver();
        let manifest = assets
            .get("assets/sprites/manifest.json".into())
            .ok_or("缺少角色动作定义")?;
        let manifest: sprites::Manifest =
            serde_json::from_slice(&manifest.bytes).map_err(|e| e.to_string())?;
        let sheet = manifest.anims.get(&name).ok_or("缺少角色动作")?;
        let asset = assets
            .get(format!("assets/sprites/{}", sheet.file))
            .ok_or("缺少角色图集")?;
        let image = image::load_from_memory_with_format(&asset.bytes, image::ImageFormat::Png)
            .map_err(|e| e.to_string())?
            .into_rgba8();
        sprites::bands(&image, sheet)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn bootstrap(window: WebviewWindow, state: tauri::State<State>) -> Value {
    json!({ "platform":std::env::consts::OS, "positionable":state.positionable,
        "tasks":state.tasks.list(), "settings":*state.settings.lock().unwrap(),
        "motion":*state.motion.lock().unwrap(), "companion":state.service.snapshot(),
        "panelState":if window.label()=="panel" {state.panel.lock().unwrap().view.clone()}else{Value::Null} })
}

fn panel_only(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "panel" {
        Ok(())
    } else {
        Err("请从任务窗口执行此操作".into())
    }
}
fn pet_or_panel(window: &WebviewWindow) -> Result<(), String> {
    if matches!(window.label(), "pet" | "panel") {
        Ok(())
    } else {
        Err("请从桌宠或面板执行此操作".into())
    }
}
#[tauri::command]
fn pet_interaction(
    window: WebviewWindow,
    state: tauri::State<State>,
    active: bool,
    focus: bool,
) -> Result<(), String> {
    if window.label() != "pet" {
        return Err("仅桌宠可更新交互状态".into());
    }
    if focus && active {
        window.set_focus().map_err(|e| e.to_string())?;
    }
    state.pet_interacting.store(active, Ordering::Relaxed);
    Ok(())
}
#[tauri::command]
fn open_pet(app: tauri::AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("pet").ok_or("桌宠窗口不可用")?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    app.emit_to("pet", "pet:compose", ())
        .map_err(|e| e.to_string())
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
async fn choose_folder(
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    panel_only(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("选择要整理或关注的文件夹")
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
    if state.stop.load(Ordering::Relaxed) {
        return Err("应用正在退出".into());
    }
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
    pet_or_panel(&window)?;
    if state.stop.load(Ordering::Relaxed) {
        return Err("应用正在退出".into());
    }
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
    pet_or_panel(&window)?;
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
    pet_or_panel(&window)?;
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
            "screen:pause"
                | "alert:ack"
                | "alert:respond"
                | "pomodoro:stop"
                | "pet:touch"
                | "chat:send"
                | "chat:new"
                | "chat:answer"
                | "notice:respond"
                | "notice:shown"
                | "companion:pause"
                | "prank"
                | "todo:add"
                | "reminder:add"
                | "goal:add"
                | "memory:add"
                | "pomodoro:start"
                | "action:accept"
                | "action:reject"
                | "goal:answer"
                | "agenda:brief"
                | "agenda:pulse"
                | "agenda:tip"
                | "summary:now"
                | "growth:reflect"
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
    if command == "watch:set"
        && args["enabled"] == true
        && args["mode"] == "auto"
        && file_watch::auto_confirmation_required(
            &state.service.data.snapshot(),
            &file_watch::roots(
                &args["folders"],
                &window
                    .app_handle()
                    .path()
                    .download_dir()
                    .map_err(|e| e.to_string()),
            )?,
        )
    {
        let app = window.app_handle().clone();
        let scope = if args["folders"].is_null() {
            "系统下载文件夹".to_string()
        } else {
            args["folders"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default()
        };
        let message=format!("大小姐会自动把这些文件夹中新出现、已稳定的文件移到同目录的分类文件夹中：\n{scope}\n\n不读取文件内容，不调用 AI，不覆盖现有文件。可撤销上次整理；此权限独立于 AI 任务权限。是否开启？");
        let allowed = tauri::async_runtime::spawn_blocking(move || {
            app.dialog()
                .message(message)
                .title("开启自动整理新文件")
                .kind(tauri_plugin_dialog::MessageDialogKind::Warning)
                .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancel)
                .blocking_show()
        })
        .await
        .map_err(|e| e.to_string())?;
        if !allowed {
            return Err("未开启自动整理，原设置保持不变".into());
        }
    }
    let service = state.service.clone();
    let operation = command.clone();
    let controller = state.desktop_entry.clone();
    let app = window.app_handle().clone();
    let supported = state.positionable;
    let result = tauri::async_runtime::spawn_blocking(move || {
        if operation == "settings:set"
            && (args.get("hotkey").is_some() || args.get("autoStart").is_some())
        {
            let mut proposed = service.data.snapshot();
            companion::apply(&mut proposed, "settings:set", args.clone())?;
            let mut host = DesktopHost {
                app,
                service,
                shortcut_supported: supported,
            };
            controller
                .lock()
                .unwrap()
                .update(&mut host, args, supported)
        } else {
            service.apply(&operation, args)
        }
    })
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
async fn alert_shown(
    window: WebviewWindow,
    state: tauri::State<'_, State>,
    token: u64,
) -> Result<bool, String> {
    if window.label() != "pet" {
        return Err("仅桌宠可确认提醒已显示".into());
    }
    if !window.is_visible().map_err(|e| e.to_string())? {
        return Ok(false);
    }
    let service = state.service.clone();
    tauri::async_runtime::spawn_blocking(move || service.alert_shown(token))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn observer_windows(
    window: WebviewWindow,
    state: tauri::State<'_, State>,
) -> Result<Vec<Value>, String> {
    pet_or_panel(&window)?;
    let config = state.service.data.snapshot()["observation"].clone();
    tauri::async_runtime::spawn_blocking(move || {
        observer::choices(
            config["excludeApps"].as_str().unwrap_or(""),
            observer::text_enabled(&config),
        )
    })
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
fn observer_capabilities(
    window: WebviewWindow,
    state: tauri::State<State>,
) -> Result<Value, String> {
    panel_only(&window)?;
    Ok(observer::capabilities(
        &state.service.data.snapshot()["observation"],
    ))
}
#[tauri::command]
fn accessibility_permission(window: WebviewWindow) -> Result<bool, String> {
    panel_only(&window)?;
    Ok(accessibility::request_permission())
}
#[tauri::command]
async fn look_now(
    window: WebviewWindow,
    state: tauri::State<'_, State>,
    chosen: Option<u32>,
) -> Result<(), String> {
    pet_or_panel(&window)?;
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
fn set_reduced_motion(
    window: WebviewWindow,
    state: tauri::State<State>,
    enabled: bool,
) -> Result<(), String> {
    if window.label() != "pet" {
        return Err("仅桌宠可设置动态效果".into());
    }
    let snapshot = {
        let mut motion = state.motion.lock().unwrap();
        motion.reduce(enabled);
        motion.clone()
    };
    window
        .emit("motion:update", snapshot)
        .map_err(|e| e.to_string())
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
    let position = desktop::position(&window)?;
    let size = desktop::size(&window)?;
    let scale = desktop::units(&window);
    let cursor = if cfg!(target_os = "macos") {
        (x, y)
    } else {
        desktop::cursor(&window).unwrap_or((x * scale, y * scale))
    };
    let mut motion = state.motion.lock().unwrap();
    motion.x = position.0;
    motion.y = position.1;
    motion.rebase(size, scale);
    motion.begin(cursor);
    let snapshot = motion.clone();
    drop(motion);
    state.service.perch_changed(None);
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
    let scale = desktop::units(&window);
    let cursor = if cfg!(target_os = "macos") {
        (x, y)
    } else {
        desktop::cursor(&window).unwrap_or((x * scale, y * scale))
    };
    let mut motion = state.motion.lock().unwrap();
    if motion.phase != "dragging" {
        return Ok(());
    }
    let dt = motion.last_sample.elapsed().as_secs_f64().clamp(0.001, 0.1);
    motion.drag(cursor, dt);
    let position = (motion.x, motion.y);
    drop(motion);
    desktop::place(&window, position)
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

fn seats_on(native: &[windows::WindowRect], screen: &desktop::Screen) -> Vec<windows::Seat> {
    let area = screen.work;
    let scale = screen.scale;
    windows::seats(native, scale)
        .into_iter()
        .filter_map(|mut seat| {
            if seat.top < area.y + 128.0 * scale || seat.top > area.bottom() - 40.0 * scale {
                return None;
            }
            seat.left = seat.left.max(area.x + 8.0 * scale);
            seat.right = seat.right.min(area.right() - 8.0 * scale);
            (seat.right - seat.left >= 60.0 * scale).then_some(seat)
        })
        .collect()
}

fn plan_motion(
    m: &mut Motion,
    screens: &[desktop::Screen],
    native: &[windows::WindowRect],
    size: desktop::Point,
    command: &str,
    destination: Option<usize>,
    autonomous: bool,
) -> Result<(), String> {
    if m.reduced && command != "climb" {
        return Err("已开启减少动态效果，仍可以直接拖动桌宠".into());
    }
    if m.phase == "dragging" {
        return Err("请先放下桌宠".into());
    }
    let current = desktop::nearest(screens, m.feet(size)).ok_or("没有可用的显示器")?;
    let screen = &screens[current];
    if command == "climb" {
        let seats = seats_on(native, screen);
        let front = seats.first().map(|s| s.window.id);
        let centre = m.feet(size).0;
        if m.reduced {
            let seat = seats
                .into_iter()
                .filter(|s| Some(s.window.id) == front)
                .min_by(|a, b| {
                    (centre - centre.clamp(a.left, a.right))
                        .abs()
                        .total_cmp(&(centre - centre.clamp(b.left, b.right)).abs())
                })
                .ok_or("没有可坐的窗口上沿，请将一个普通窗口移到屏幕中部")?;
            m.generation = m.generation.wrapping_add(1);
            m.sit(seat, size);
            return Ok(());
        }
        let target = seats
            .into_iter()
            .filter(|s| Some(s.window.id) == front)
            .find_map(|s| {
                windows::climb_side(&s, native, screen.work, m.scale, centre).map(|side| (s, side))
            });
        let (seat, side) =
            target.ok_or("没有可攀爬的窗口边缘，请给普通窗口的两侧和上方留一点空间")?;
        m.climb(
            seat,
            side,
            screen.floor(centre).1,
            size,
            screens,
            autonomous,
        );
    } else {
        let target = destination.unwrap_or(current);
        let target_screen = screens.get(target).ok_or("目标显示器已断开")?;
        let x = if target == current && command != "screen" {
            let centre = m.feet(size).0;
            let step = 240.0 * m.scale;
            if centre < screen.work.x + screen.work.width / 2.0 {
                centre + step
            } else {
                centre - step
            }
        } else {
            target_screen.work.x + target_screen.work.width / 2.0
        };
        let mut from = m.feet(size);
        let mut points = Vec::new();
        let floor = screen.floor(from.0);
        if (from.1 - floor.1).abs() > 5.0 * m.scale {
            points.push((from.0, floor.1));
            from = (from.0, floor.1);
        }
        points.extend(desktop::path(screens, from, target, x)?);
        m.walk(&points, size, screens, autonomous);
    }
    Ok(())
}

fn move_pet(
    app: &tauri::AppHandle,
    command: &str,
    destination: Option<&str>,
) -> Result<(), String> {
    let state = app.state::<State>();
    if state.stop.load(Ordering::Relaxed) {
        return Err("应用正在退出".into());
    }
    if command == "pause" || command == "resume" {
        state.service.apply(
            "settings:set",
            json!({"motionPausedUntil":if command=="pause"{companion::now()+3600_000}else{0}}),
        )?;
        let snapshot = {
            let mut m = state.motion.lock().unwrap();
            m.generation = m.generation.wrapping_add(1);
            if command == "pause" {
                m.pause("user");
            } else if m.pause_reason == "user" {
                m.pause("starting");
            }
            m.clone()
        };
        app.emit("motion:update", snapshot)
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    if !state.positionable {
        return Err("当前 Wayland 桌面不允许应用自行移动；X11 或 XWayland 支持桌面活动".into());
    }
    if !["walk", "climb", "screen", "stop"].contains(&command) {
        return Err("未知桌面活动".into());
    }
    let window = app.get_webview_window("pet").ok_or("桌宠窗口不可用")?;
    if command == "stop" {
        let snapshot = {
            let mut m = state.motion.lock().unwrap();
            if m.phase == "dragging" {
                return Err("请先放下桌宠".into());
            }
            m.leave();
            m.clone()
        };
        return window
            .emit("motion:update", snapshot)
            .map_err(|e| e.to_string());
    }
    let generation = state.motion.lock().unwrap().generation;
    let screens = desktop::screens(&window)?;
    let destination = destination
        .map(|key| {
            screens
                .iter()
                .position(|s| s.key() == key)
                .ok_or("显示器布局已改变，请刷新屏幕列表")
        })
        .transpose()?;
    if command == "screen" && destination.is_none() {
        return Err("请选择一块显示器".into());
    }
    let native = if command == "climb" {
        windows::visible(desktop::units(&window))?
    } else {
        Vec::new()
    };
    let size = desktop::size(&window)?;
    let scale = desktop::units(&window);
    let settings = state.service.data.snapshot();
    if command == "screen" && settings["settings"]["crossScreens"] == false {
        return Err("请先在桌面活动设置中允许跨屏".into());
    }
    if command != "stop"
        && settings["settings"]["motionPausedUntil"]
            .as_u64()
            .unwrap_or(0)
            > companion::now()
    {
        return Err("桌面活动已暂停，请先继续活动".into());
    }
    let mut m = state.motion.lock().unwrap();
    if m.generation != generation || m.phase == "dragging" {
        return Err("移动已被拖动打断".into());
    }
    m.rebase(size, scale);
    plan_motion(&mut m, &screens, &native, size, command, destination, false)?;
    let snapshot = m.clone();
    drop(m);
    if !snapshot.scripted() {
        desktop::place(&window, (snapshot.x, snapshot.y))?;
    }
    trace_motion(&window, &snapshot);
    window
        .emit("motion:update", snapshot)
        .map_err(|e| e.to_string())
}

fn toggle_perch(app: &tauri::AppHandle) -> Result<(), String> {
    let phase = app.state::<State>().motion.lock().unwrap().phase.clone();
    move_pet(app, if phase == "perched" { "stop" } else { "climb" }, None)
}
#[tauri::command]
fn perch_toggle(window: WebviewWindow, app: tauri::AppHandle) -> Result<(), String> {
    if window.label() != "pet" {
        return Err("请从桌宠操作窗口停靠".into());
    }
    toggle_perch(&app)
}
#[tauri::command]
async fn motion_command(
    window: WebviewWindow,
    app: tauri::AppHandle,
    command: String,
    screen: Option<String>,
) -> Result<(), String> {
    if !["pet", "panel"].contains(&window.label()) {
        return Err("请从桌宠或控制面板操作".into());
    }
    tauri::async_runtime::spawn_blocking(move || move_pet(&app, &command, screen.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
fn motion_status(window: WebviewWindow, app: tauri::AppHandle) -> Result<Value, String> {
    panel_only(&window)?;
    let state = app.state::<State>();
    if !state.positionable {
        return Ok(
            json!({"positionable":false,"screens":[],"current":null,"motion":*state.motion.lock().unwrap()}),
        );
    }
    let pet = app.get_webview_window("pet").ok_or("桌宠窗口不可用")?;
    let screens = desktop::screens(&pet)?;
    let size = desktop::size(&pet)?;
    let motion = state.motion.lock().unwrap().clone();
    let current = desktop::nearest(&screens, motion.feet(size)).map(|i| screens[i].key());
    Ok(
        json!({"positionable":state.positionable,"screens":screens.iter().map(|s|json!({"id":s.key(),"name":s.name,"bounds":s.bounds})).collect::<Vec<_>>(),"current":current,"motion":motion}),
    )
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
        let mut screens = Vec::new();
        let mut native = Vec::new();
        let mut environment_at = Instant::now() - Duration::from_secs(2);
        let mut windows_at = Instant::now() - Duration::from_secs(2);
        let mut auto_at = Instant::now() + Duration::from_secs(30);
        let mut allowed = false;
        let mut suspended = true;
        let mut pause_reason = "starting";
        let mut auto_pause_reason = "starting";
        let mut cross_screens = true;
        let mut climb_windows = true;
        let mut hidden_for_fullscreen = false;
        let mut last_error = String::new();
        let mut sequence = companion::now() ^ std::process::id() as u64;
        let mut observed_perch = None;
        let mut body_at = Instant::now() - Duration::from_secs(2);
        let mut session_unlocked = false;
        let mut panel_open = false;
        while !stop.load(Ordering::Relaxed) {
            let now = Instant::now();
            let dt = now.duration_since(last).as_secs_f64().clamp(0.001, 0.05);
            last = now;
            // All native window calls stay outside the shared motion lock.
            let size = match desktop::size(&window) {
                Ok(s) => s,
                Err(_) => break,
            };
            let scale = desktop::units(&window);
            let cursor = desktop::cursor(&window);
            let position = desktop::position(&window).ok();
            let visible = window.is_visible().unwrap_or(false);
            let observed = motion.lock().unwrap().clone();
            if environment_at.elapsed() >= Duration::from_secs(1) {
                environment_at = now;
                match desktop::screens(&window) {
                    Ok(value) => {
                        screens = value;
                    }
                    Err(error) => {
                        screens.clear();
                        if error != last_error {
                            let _ = window.emit("pet:error", error.clone());
                            last_error = error;
                        }
                    }
                }
                let state = window.app_handle().state::<State>();
                let d = state.service.data.snapshot();
                let busy =
                    state.tasks.list().iter().any(|t| {
                        !matches!(t.status.as_str(), "completed" | "cancelled" | "failed")
                    });
                let unlocked = observer::unlocked();
                session_unlocked = unlocked;
                let panel_visible = window
                    .app_handle()
                    .get_webview_window("panel")
                    .is_some_and(|w| w.is_visible().unwrap_or(false));
                panel_open = panel_visible;
                let fullscreen = d["settings"]["hideOnFullscreen"] != false
                    && native
                        .first()
                        .is_some_and(|w| screens.iter().any(|s| s.fullscreen(w)));
                if fullscreen && visible {
                    let _ = window.hide();
                    hidden_for_fullscreen = true;
                } else if !fullscreen && hidden_for_fullscreen {
                    let _ = window.show();
                    hidden_for_fullscreen = false;
                }
                pause_reason = if !unlocked {
                    "locked"
                } else if fullscreen {
                    "fullscreen"
                } else if d["settings"]["motionPausedUntil"].as_u64().unwrap_or(0)
                    > companion::now()
                {
                    "user"
                } else {
                    ""
                };
                suspended = !pause_reason.is_empty();
                auto_pause_reason = if suspended {
                    pause_reason
                } else if busy {
                    "task"
                } else if window
                    .app_handle()
                    .state::<State>()
                    .pet_interacting
                    .load(Ordering::Relaxed)
                {
                    "interaction"
                } else if d["settings"]["companionPausedUntil"].as_u64().unwrap_or(0)
                    > companion::now()
                {
                    "user"
                } else if panel_visible {
                    "panel"
                } else if companion::quiet_hours(&d) {
                    "quiet"
                } else if d["settings"]["wander"] == false {
                    "disabled"
                } else if d["settings"]["focusGuard"] != false
                    && d["pomodoro"]["until"].as_u64().unwrap_or(0) > companion::now()
                {
                    "focus"
                } else if observer::idle_seconds() >= 300.0 {
                    "away"
                } else {
                    ""
                };
                allowed = auto_pause_reason.is_empty();
                cross_screens = d["settings"]["crossScreens"] != false;
                climb_windows = d["settings"]["climbWindows"] != false;
                if !allowed {
                    auto_at = now + Duration::from_secs(15);
                }
            }
            let interval = if observed.phase == "flying" {
                100
            } else if observed.scripted() {
                250
            } else if observed.phase == "perched" {
                400
            } else {
                1000
            };
            if windows_at.elapsed() >= Duration::from_millis(interval) {
                windows_at = now;
                match windows::visible(scale) {
                    Ok(windows) => {
                        native = windows;
                        trace_windows(&window, &screens, &native, scale, position, size);
                        last_error.clear();
                    }
                    Err(error) => {
                        native.clear();
                        if error != last_error {
                            let _ = window.emit("pet:error", error.clone());
                            last_error = error;
                        }
                    }
                }
            }
            let inside = cursor.zip(position).is_some_and(|(c, p)| {
                let x = (c.0 - p.0) / scale;
                let y = (c.1 - p.1) / scale;
                regions
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|r| x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)
            });
            let activity_busy = window.app_handle().state::<State>().service.activity_busy();
            let pressed = observed.phase == "dragging" && left_pressed();
            let mut m = motion.lock().unwrap();
            let previous = (m.phase.clone(), m.facing, m.paused, m.pause_reason.clone());
            let was_scripted = m.scripted();
            let was_flying = m.phase == "flying";
            m.rebase(size, scale);
            if !m.scripted() && !matches!(m.phase.as_str(), "dragging" | "flying") {
                if let Some(p) = position {
                    m.x = p.0;
                    m.y = p.1;
                }
            }
            if m.phase == "dragging" {
                if pressed {
                    m.hardware_seen = true;
                } else if m.hardware_seen {
                    m.release();
                }
            }
            let screen_index = desktop::nearest(&screens, m.feet(size));
            if let Some(index) = screen_index {
                let screen = &screens[index];
                let seats = seats_on(&native, screen);
                if windows_at >= m.last_sample {
                    let target = if m.scripted() {
                        m.target_seat().cloned()
                    } else {
                        m.seat.clone()
                    };
                    let centre = if m.scripted() {
                        m.target_centre().unwrap_or(m.feet(size).0)
                    } else {
                        m.feet(size).0
                    };
                    if target.is_some_and(|seat| !seat.remains_visible(&seats, centre, scale)) {
                        m.leave();
                    }
                }
                if m.scripted() && !m.layout_valid(&screens) {
                    m.leave();
                }
                let autonomous = m.autonomous();
                m.pause(if suspended {
                    pause_reason
                } else if autonomous && inside {
                    "hover"
                } else if autonomous && !allowed {
                    auto_pause_reason
                } else {
                    ""
                });
                if m.scripted() {
                    m.advance(dt, size);
                } else if m.phase == "flying" && !m.paused {
                    let old_feet = m.feet(size).1;
                    let area = screen.work;
                    let left = area.x - size.0 / 2.0 + 90.0 * scale;
                    let right = (area.right() - size.0 / 2.0 - 90.0 * scale).max(left);
                    let bottom = (area.bottom() - size.1).max(area.y);
                    m.step(dt, (left, area.y, right, bottom));
                    m.land(&seats, old_feet, size);
                }
                if allowed
                    && !activity_busy
                    && visible
                    && !inside
                    && !m.reduced
                    && !m.scripted()
                    && matches!(m.phase.as_str(), "settled" | "perched")
                    && m.last_sample.elapsed() >= Duration::from_secs(45)
                    && now >= auto_at
                {
                    sequence = sequence.wrapping_mul(6364136223846793005).wrapping_add(1);
                    let choice = (sequence >> 32) % 6;
                    let target = if choice == 0 && cross_screens {
                        screens
                            .iter()
                            .enumerate()
                            .filter(|(i, _)| *i != index)
                            .find(|(i, s)| {
                                desktop::path(
                                    &screens,
                                    m.feet(size),
                                    *i,
                                    s.work.x + s.work.width / 2.0,
                                )
                                .is_ok()
                            })
                            .map(|(i, _)| i)
                    } else {
                        None
                    };
                    let command = if choice <= 2 && climb_windows && target.is_none() {
                        "climb"
                    } else {
                        "walk"
                    };
                    if plan_motion(&mut m, &screens, &native, size, command, target, true).is_err()
                    {
                        let _ = plan_motion(&mut m, &screens, &native, size, "walk", None, true);
                    }
                    auto_at = now + Duration::from_secs(60 + (sequence % 60));
                }
                // A disconnected display must never strand the character in the empty desktop.
                if !matches!(m.phase.as_str(), "dragging")
                    && !screens.iter().any(|s| s.bounds.contains(m.feet(size)))
                {
                    let p = screen.floor(m.feet(size).0);
                    m.leave();
                    m.x = p.0 - size.0 / 2.0;
                    m.y = p.1 - size.1 + 5.0 * scale;
                    m.phase = "settled".into();
                }
            } else {
                m.pause("display");
            }
            let snapshot = m.clone();
            drop(m);
            let same_owner = { motion.lock().unwrap().generation == snapshot.generation };
            let changed_position = position
                .is_some_and(|p| (p.0 - snapshot.x).abs() > 0.5 || (p.1 - snapshot.y).abs() > 0.5);
            if (was_scripted
                || was_flying
                || snapshot.scripted()
                || snapshot.phase == "flying"
                || changed_position)
                && !snapshot.paused
                && same_owner
                && snapshot.phase != "dragging"
            {
                if let Err(error) = desktop::place(&window, (snapshot.x, snapshot.y)) {
                    let _ = window.emit("pet:error", error);
                }
            }
            if previous
                != (
                    snapshot.phase.clone(),
                    snapshot.facing,
                    snapshot.paused,
                    snapshot.pause_reason.clone(),
                )
            {
                trace_motion(&window, &snapshot);
                let _ = window.emit("motion:update", snapshot.clone());
            }
            if same_owner && body_at.elapsed() >= Duration::from_secs(1) {
                body_at = now;
                let grounded = snapshot.phase == "settled";
                let resting = !snapshot.paused || snapshot.pause_reason == "away";
                window
                    .app_handle()
                    .state::<State>()
                    .service
                    .body_context(behavior::Context {
                        at: companion::now(),
                        unlocked: session_unlocked,
                        ambient: visible
                            && !hidden_for_fullscreen
                            && !panel_open
                            && !window
                                .app_handle()
                                .state::<State>()
                                .pet_interacting
                                .load(Ordering::Relaxed),
                        free: visible
                            && grounded
                            && !snapshot.paused
                            && !panel_open
                            && !window
                                .app_handle()
                                .state::<State>()
                                .pet_interacting
                                .load(Ordering::Relaxed)
                            && !inside
                            && snapshot.last_sample.elapsed() >= Duration::from_secs(10),
                        may_sleep: visible
                            && grounded
                            && resting
                            && !panel_open
                            && !window
                                .app_handle()
                                .state::<State>()
                                .pet_interacting
                                .load(Ordering::Relaxed),
                    });
            }
            if same_owner {
                let target = if snapshot.phase == "perched" && !snapshot.paused {
                    snapshot.seat.as_ref().map(|s| accessibility::Target {
                        id: s.window.id as u32,
                        pid: s.window.pid,
                    })
                } else {
                    None
                };
                if target != observed_perch {
                    window
                        .app_handle()
                        .state::<State>()
                        .service
                        .perch_changed(target);
                    observed_perch = target;
                }
            }
            if visible {
                let hit = snapshot.phase == "dragging" || inside;
                if ignored == hit && window.set_ignore_cursor_events(!hit).is_ok() {
                    ignored = !hit;
                }
            }
            let moving =
                (snapshot.scripted() || snapshot.phase == "flying" || snapshot.phase == "dragging")
                    && !snapshot.paused;
            std::thread::sleep(Duration::from_millis(
                if !visible || pause_reason == "locked" {
                    400
                } else if moving {
                    16
                } else {
                    80
                },
            ));
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
    let context = tauri::generate_context!();
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if !args.iter().any(|arg| arg == "--from-autostart") {
                panel(app);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name(context.config().identifier.clone())
                .arg("--from-autostart")
                .build(),
        );
    if positionable {
        builder = builder.plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        if let Err(error) = request_clipboard(app) {
                            eprintln!("clipboard shortcut: {error}");
                        }
                    }
                })
                .build(),
        );
    }
    let application = builder
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
            let pet = WebviewWindowBuilder::new(
                app,
                "pet",
                WebviewUrl::App("index.html?view=pet".into()),
            )
            .title("Ojousama Lite")
            .focused(false)
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
                let screens = desktop::screens(&pet)?;
                let size = desktop::size(&pet)?;
                initial.rebase(size, desktop::units(&pet));
                if let Some(screen) = screens.first() {
                    let floor = screen.floor(screen.work.x + screen.work.width * 0.72);
                    initial.x = floor.0 - size.0 / 2.0;
                    initial.y = floor.1 - size.1 + 5.0 * initial.scale;
                    desktop::place(&pet, (initial.x, initial.y))?;
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
            )?
            .with_download_folder(app.path().download_dir().map_err(|e| e.to_string()));
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
                desktop_entry: Arc::new(Mutex::new(desktop_entry::Controller::default())),
                clipboard_pending: AtomicBool::new(false),
                pet_interacting: AtomicBool::new(false),
                panel: Mutex::new(panel::Session::default()),
            });
            {
                let state = app.state::<State>();
                let settings = state.service.data.snapshot()["settings"].clone();
                let mut host = DesktopHost {
                    app: app.handle().clone(),
                    service: state.service.clone(),
                    shortcut_supported: positionable,
                };
                state.desktop_entry.lock().unwrap().initialize(
                    &mut host,
                    settings["hotkey"].as_str().unwrap_or(""),
                    positionable,
                );
            }
            let show = MenuItem::with_id(app, "show", "打开任务", true, None::<&str>)?;
            let show_pet = MenuItem::with_id(app, "pet", "显示桌宠", true, None::<&str>)?;
            let perch =
                MenuItem::with_id(app, "perch", "坐上窗口 / 下来", positionable, None::<&str>)?;
            let clipboard =
                MenuItem::with_id(app, "clipboard", "剪贴板快捷操作", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出原型", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &show_pet, &clipboard, &perch, &quit])?;
            let mut tray = TrayIconBuilder::new()
                .tooltip("Ojousama Lite")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        panel(app);
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
                    "clipboard" => {
                        if let Err(error) = request_clipboard(app) {
                            eprintln!("clipboard menu: {error}");
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
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
            sprite_bands,
            desktop_status,
            clipboard_pending,
            clipboard_preview,
            clipboard_offer_pending,
            clipboard_offer_open,
            clipboard_offer_preview,
            show_panel,
            panel_ready,
            hide_panel,
            quit_app,
            save_settings,
            choose_workspace,
            choose_folder,
            task_start,
            task_retry,
            task_cancel,
            task_approval,
            task_answer,
            set_hit_regions,
            pet_interaction,
            open_pet,
            set_reduced_motion,
            drag_begin,
            drag_move,
            drag_end,
            perch_toggle,
            motion_command,
            motion_status,
            companion_command,
            alert_shown,
            observer_windows,
            observer_status,
            observer_permission,
            observer_capabilities,
            accessibility_permission,
            look_now,
            note_show,
            note_toggle,
            note_update,
            note_add
        ])
        .build(context)
        .expect("启动轻量桌宠失败");
    application.run(|app, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
            let state = app.state::<State>();
            state.stop.store(true, Ordering::Relaxed);
            state.service.shutdown();
            state.tasks.shutdown();
        }
    });
}

#[cfg(test)]
mod movement_commands_tests {
    use super::*;
    #[test]
    fn reduced_motion_preserves_the_existing_instant_perch_contract() {
        let bounds = desktop::Bounds {
            x: 0.0,
            y: 0.0,
            width: 1600.0,
            height: 1000.0,
        };
        let screens = [desktop::Screen {
            name: "fixture".into(),
            bounds,
            work: bounds,
            scale: 1.0,
        }];
        let windows = [windows::WindowRect {
            id: 3,
            pid: 4,
            x: 300.0,
            y: 400.0,
            width: 700.0,
            height: 400.0,
        }];
        let mut m = Motion::new(200.0, 660.0);
        m.reduce(true);
        plan_motion(
            &mut m,
            &screens,
            &windows,
            (360.0, 340.0),
            "climb",
            None,
            false,
        )
        .unwrap();
        assert_eq!(m.phase, "perched");
        assert!(!m.scripted());
        assert_eq!(m.seat.as_ref().unwrap().window.id, 3);
        assert!(plan_motion(
            &mut m,
            &screens,
            &windows,
            (360.0, 340.0),
            "walk",
            None,
            false
        )
        .is_err());
    }
}
