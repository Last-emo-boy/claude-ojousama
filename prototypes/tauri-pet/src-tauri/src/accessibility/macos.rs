use super::{
    viewport::{self, Meta, Reader, Rect},
    Target, TextCapture,
};
use crate::observer;
use serde_json::{json, Value};
use std::{
    ffi::{c_void, CStr},
    ptr,
    time::{Duration, Instant},
};

type Ref = *const c_void;
#[repr(C)]
#[derive(Default)]
struct Point {
    x: f64,
    y: f64,
}
#[repr(C)]
#[derive(Default)]
struct Size {
    width: f64,
    height: f64,
}
#[repr(C)]
#[derive(Default)]
struct CgRect {
    origin: Point,
    size: Size,
}
#[repr(C)]
#[derive(Default)]
struct Range {
    location: isize,
    length: isize,
}
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: Ref) -> bool;
    static kAXTrustedCheckOptionPrompt: Ref;
    fn AXUIElementCreateSystemWide() -> Ref;
    fn AXUIElementCreateApplication(pid: i32) -> Ref;
    fn AXUIElementGetTypeID() -> usize;
    fn AXUIElementGetPid(element: Ref, pid: *mut i32) -> i32;
    fn AXUIElementSetMessagingTimeout(element: Ref, timeout: f32) -> i32;
    fn AXUIElementCopyAttributeValue(element: Ref, attr: Ref, value: *mut Ref) -> i32;
    fn AXUIElementCopyAttributeValues(
        element: Ref,
        attr: Ref,
        index: isize,
        max: isize,
        value: *mut Ref,
    ) -> i32;
    fn AXUIElementCopyParameterizedAttributeValue(
        element: Ref,
        attr: Ref,
        parameter: Ref,
        value: *mut Ref,
    ) -> i32;
    fn AXValueGetTypeID() -> usize;
    fn AXValueGetType(value: Ref) -> u32;
    fn AXValueGetValue(value: Ref, kind: u32, out: *mut c_void) -> bool;
    fn AXValueCreate(kind: u32, value: *const c_void) -> Ref;
}
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(value: Ref);
    fn CFRetain(value: Ref) -> Ref;
    fn CFEqual(a: Ref, b: Ref) -> bool;
    fn CFGetTypeID(value: Ref) -> usize;
    fn CFStringGetTypeID() -> usize;
    fn CFStringCreateWithCString(allocator: Ref, string: *const i8, encoding: u32) -> Ref;
    fn CFStringGetLength(string: Ref) -> isize;
    fn CFStringGetCharacters(string: Ref, range: Range, buffer: *mut u16);
    fn CFArrayGetTypeID() -> usize;
    fn CFArrayGetCount(array: Ref) -> isize;
    fn CFArrayGetValueAtIndex(array: Ref, index: isize) -> Ref;
    fn CFDictionaryGetValue(dict: Ref, key: Ref) -> Ref;
    fn CFDictionaryCreate(
        allocator: Ref,
        keys: *const Ref,
        values: *const Ref,
        count: isize,
        key_callbacks: Ref,
        value_callbacks: Ref,
    ) -> Ref;
    fn CFNumberGetTypeID() -> usize;
    fn CFNumberGetValue(number: Ref, kind: isize, out: *mut c_void) -> bool;
    fn CFBooleanGetTypeID() -> usize;
    fn CFBooleanGetValue(value: Ref) -> bool;
    static kCFBooleanTrue: Ref;
}
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGWindowListCopyWindowInfo(options: u32, relative: u32) -> Ref;
    fn CGRectMakeWithDictionaryRepresentation(dict: Ref, rect: *mut CgRect) -> bool;
    static kCGWindowNumber: Ref;
    static kCGWindowOwnerPID: Ref;
    static kCGWindowOwnerName: Ref;
    static kCGWindowBounds: Ref;
    static kCGWindowLayer: Ref;
}
// All native references are owned locally by the blocking read; none cross threads.
struct Owned(Ref);
impl Owned {
    fn new(value: Ref) -> Option<Self> {
        (!value.is_null()).then_some(Self(value))
    }
}
impl Drop for Owned {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0) }
    }
}
fn key(value: &CStr) -> Owned {
    Owned::new(unsafe { CFStringCreateWithCString(ptr::null(), value.as_ptr(), 0x08000100) })
        .expect("CFString key")
}
fn string(value: Ref) -> Option<String> {
    if value.is_null() || unsafe { CFGetTypeID(value) != CFStringGetTypeID() } {
        return None;
    }
    // Bound allocation even if a provider exposes a whole document as static text.
    let length = unsafe { CFStringGetLength(value) }.clamp(0, 20_000);
    let mut text = vec![0_u16; length as usize];
    unsafe {
        CFStringGetCharacters(
            value,
            Range {
                location: 0,
                length,
            },
            text.as_mut_ptr(),
        );
    }
    Some(String::from_utf16_lossy(&text))
}
fn value<T: Default>(value: Ref, kind: u32) -> Option<T> {
    if value.is_null()
        || unsafe { CFGetTypeID(value) != AXValueGetTypeID() || AXValueGetType(value) != kind }
    {
        return None;
    }
    let mut out = T::default();
    unsafe { AXValueGetValue(value, kind, &mut out as *mut T as *mut c_void) }.then_some(out)
}
fn number(dict: Ref, key: Ref) -> Option<i64> {
    let v = unsafe { CFDictionaryGetValue(dict, key) };
    if v.is_null() || unsafe { CFGetTypeID(v) != CFNumberGetTypeID() } {
        return None;
    }
    let mut n = 0_i64;
    unsafe { CFNumberGetValue(v, 4, &mut n as *mut _ as *mut c_void) }.then_some(n)
}
pub fn permission() -> bool {
    unsafe { AXIsProcessTrusted() }
}
pub fn request_permission() -> bool {
    unsafe {
        let Some(options) = Owned::new(CFDictionaryCreate(
            ptr::null(),
            &kAXTrustedCheckOptionPrompt,
            &kCFBooleanTrue,
            1,
            ptr::null(),
            ptr::null(),
        )) else {
            return false;
        };
        AXIsProcessTrustedWithOptions(options.0)
    }
}

#[derive(Clone)]
struct Window {
    target: Target,
    frame: Rect,
    app: String,
}
fn unique_window(windows: &[Window], pid: u32, frame: Rect) -> Option<&Window> {
    let mut matches = windows
        .iter()
        .filter(|w| w.target.pid == pid && w.frame.matches(frame));
    let first = matches.next()?;
    matches.next().is_none().then_some(first)
}
fn native_windows() -> Result<Vec<Window>, String> {
    if !observer::unlocked() {
        return Err("屏幕已锁定，已暂停观察".into());
    }
    let list = Owned::new(unsafe { CGWindowListCopyWindowInfo(1 | 16, 0) })
        .ok_or("macOS 未返回可见窗口信息")?;
    let mut windows = Vec::new();
    for index in 0..unsafe { CFArrayGetCount(list.0) }.min(256) {
        let item = unsafe { CFArrayGetValueAtIndex(list.0, index) };
        let (Some(id), Some(pid)) = (
            number(item, unsafe { kCGWindowNumber }),
            number(item, unsafe { kCGWindowOwnerPID }),
        ) else {
            continue;
        };
        if pid <= 0
            || pid == std::process::id() as i64
            || number(item, unsafe { kCGWindowLayer }) != Some(0)
        {
            continue;
        }
        let bounds = unsafe { CFDictionaryGetValue(item, kCGWindowBounds) };
        let mut rect = CgRect::default();
        if bounds.is_null()
            || !unsafe { CGRectMakeWithDictionaryRepresentation(bounds, &mut rect) }
            || rect.size.width < 1.0
            || rect.size.height < 1.0
        {
            continue;
        }
        let Some(app) = string(unsafe { CFDictionaryGetValue(item, kCGWindowOwnerName) }) else {
            continue;
        };
        windows.push(Window {
            target: Target {
                id: id as u32,
                pid: pid as u32,
            },
            frame: Rect {
                x: rect.origin.x,
                y: rect.origin.y,
                width: rect.size.width,
                height: rect.size.height,
            },
            app,
        });
    }
    Ok(windows)
}
struct Client {
    deadline: Instant,
}
impl Client {
    fn new(duration: Duration) -> Self {
        Self {
            deadline: Instant::now() + duration,
        }
    }
    fn available(&self) -> bool {
        Instant::now() < self.deadline
    }
    fn attr(&self, node: &Owned, name: &CStr) -> Option<Owned> {
        if !self.available() {
            return None;
        }
        let mut out = ptr::null();
        let key = key(name);
        unsafe {
            // Timeout is per actual element, not just its parent application.
            AXUIElementSetMessagingTimeout(node.0, 0.06);
            let code = AXUIElementCopyAttributeValue(node.0, key.0, &mut out);
            if code == 0 {
                Owned::new(out)
            } else {
                None
            }
        }
    }
    fn text_attr(&self, node: &Owned, name: &CStr) -> Option<String> {
        self.attr(node, name).and_then(|v| string(v.0))
    }
    fn elements(&self, node: &Owned, name: &CStr, max: isize) -> Vec<Owned> {
        if !self.available() {
            return Vec::new();
        }
        let mut out = ptr::null();
        let key = key(name);
        unsafe {
            AXUIElementSetMessagingTimeout(node.0, 0.06);
            if AXUIElementCopyAttributeValues(node.0, key.0, 0, max, &mut out) != 0 {
                return Vec::new();
            }
            let Some(array) = Owned::new(out) else {
                return Vec::new();
            };
            if CFGetTypeID(array.0) != CFArrayGetTypeID() {
                return Vec::new();
            }
            (0..CFArrayGetCount(array.0).min(max))
                .filter_map(|i| {
                    let item = CFArrayGetValueAtIndex(array.0, i);
                    if item.is_null() || CFGetTypeID(item) != AXUIElementGetTypeID() {
                        None
                    } else {
                        Owned::new(CFRetain(item))
                    }
                })
                .collect()
        }
    }
    fn element(&self, node: &Owned, name: &CStr) -> Option<Owned> {
        self.attr(node, name)
            .filter(|v| unsafe { CFGetTypeID(v.0) == AXUIElementGetTypeID() })
    }
    fn frame(&self, node: &Owned) -> Option<Rect> {
        let p: Point = self.attr(node, c"AXPosition").and_then(|v| value(v.0, 1))?;
        let s: Size = self.attr(node, c"AXSize").and_then(|v| value(v.0, 2))?;
        Some(Rect {
            x: p.x,
            y: p.y,
            width: s.width,
            height: s.height,
        })
    }
    fn pid(&self, node: &Owned) -> Option<u32> {
        let mut pid = 0;
        (unsafe { AXUIElementGetPid(node.0, &mut pid) } == 0 && pid > 0).then_some(pid as u32)
    }
    fn focused(&self) -> Option<(Owned, Owned)> {
        let system = Owned::new(unsafe { AXUIElementCreateSystemWide() })?;
        let app = self.element(&system, c"AXFocusedApplication")?;
        let root = self.element(&app, c"AXFocusedWindow")?;
        Some((app, root))
    }
}
impl Reader for Client {
    type Node = Owned;
    fn inspect(&self, node: &Owned) -> Meta {
        Meta {
            role: self.text_attr(node, c"AXRole").unwrap_or_default(),
            subrole: self.text_attr(node, c"AXSubrole").unwrap_or_default(),
            hidden: self.attr(node, c"AXHidden").is_some_and(|v| unsafe {
                CFGetTypeID(v.0) == CFBooleanGetTypeID() && CFBooleanGetValue(v.0)
            }),
            frame: self.frame(node),
        }
    }
    fn text(&self, node: &Owned, meta: &Meta) -> Option<String> {
        if meta.editable() {
            let range = self.attr(node, c"AXVisibleCharacterRange")?;
            let range: Range = value(range.0, 4)?;
            if range.location < 0
                || range.length <= 0
                || range.location.checked_add(range.length).is_none()
            {
                return None;
            }
            let range = Range {
                length: range.length.min(10_000),
                ..range
            };
            let parameter =
                Owned::new(unsafe { AXValueCreate(4, &range as *const _ as *const c_void) })?;
            if !self.available() {
                return None;
            }
            let key = key(c"AXStringForRange");
            let mut out = ptr::null();
            if unsafe {
                AXUIElementCopyParameterizedAttributeValue(node.0, key.0, parameter.0, &mut out)
            } != 0
            {
                return None;
            }
            let text = Owned::new(out)?;
            return string(text.0);
        }
        if meta.role == "AXStaticText" {
            self.text_attr(node, c"AXValue")
                .or_else(|| self.text_attr(node, c"AXTitle"))
        } else {
            self.text_attr(node, c"AXTitle")
        }
    }
    fn children(&self, node: &Owned) -> Vec<Owned> {
        let visible = self.elements(node, c"AXVisibleChildren", 128);
        if visible.is_empty() {
            self.elements(node, c"AXChildren", 128)
        } else {
            visible
        }
    }
}
struct Context {
    app: Owned,
    root: Owned,
    window: Window,
    title: String,
}
fn context(
    client: &Client,
    extra: &str,
    chosen: Option<u32>,
    expected: Option<Target>,
) -> Result<Option<Context>, String> {
    let windows = native_windows()?;
    let (app, root, window) = if let Some(id) = chosen {
        let w = windows
            .iter()
            .find(|w| w.target.id == id)
            .ok_or("选中的窗口已关闭或不在当前桌面")?;
        if unique_window(&windows, w.target.pid, w.frame).is_none() {
            return Err("窗口位置重叠，无法确认辅助功能目标，请移动窗口后再试".into());
        }
        if observer::blocked(&w.app, "", extra) {
            return Err("这个应用已排除，不会读取其内容".into());
        }
        let app = Owned::new(unsafe { AXUIElementCreateApplication(w.target.pid as i32) })
            .ok_or("无法连接窗口的辅助功能")?;
        let mut matching = client
            .elements(&app, c"AXWindows", 64)
            .into_iter()
            .filter(|n| client.frame(n).is_some_and(|r| r.matches(w.frame)));
        let Some(root) = matching.next() else {
            return Ok(None);
        };
        if matching.next().is_some() {
            return Err("窗口位置重叠，无法确认辅助功能目标，请移动窗口后再试".into());
        }
        (app, root, w.clone())
    } else {
        let Some((app, root)) = client.focused() else {
            return Ok(None);
        };
        let Some(pid) = client.pid(&app) else {
            return Ok(None);
        };
        if pid == std::process::id() {
            return Err("桌宠面板在前台，等待你回到其他应用".into());
        }
        let Some(frame) = client.frame(&root) else {
            return Ok(None);
        };
        let mut matching = windows
            .iter()
            .filter(|w| w.target.pid == pid && w.frame.matches(frame));
        let Some(window) = matching.next() else {
            return Ok(None);
        };
        if matching.next().is_some() {
            return Err("无法确认当前窗口，本次观察已跳过".into());
        }
        (app, root, window.clone())
    };
    if expected.is_some_and(|target| target != window.target) {
        return Err("桌宠停靠的窗口不在前台，本次观察已跳过".into());
    }
    let Some(title) = client.text_attr(&root, c"AXTitle") else {
        return Ok(None);
    };
    if observer::blocked(&window.app, &title, extra) {
        return Err("这个窗口已排除，不会读取其内容".into());
    }
    if let Some(focus) = client.element(&app, c"AXFocusedUIElement") {
        // A password field may belong to a sheet rather than the window's child tree.
        if client.inspect(&focus).secure() {
            return Err("正在输入密码，本次观察已跳过".into());
        }
    }
    Ok(Some(Context {
        app,
        root,
        window,
        title,
    }))
}
fn unchanged(client: &Client, ctx: &Context, automatic: bool) -> bool {
    if !observer::unlocked() || !permission() {
        return false;
    }
    if client.text_attr(&ctx.root, c"AXTitle").as_deref() != Some(ctx.title.as_str())
        || client
            .frame(&ctx.root)
            .is_none_or(|r| !r.matches(ctx.window.frame))
    {
        return false;
    }
    if automatic
        && client.focused().is_none_or(|(app, root)| {
            client.pid(&app) != Some(ctx.window.target.pid)
                || !unsafe { CFEqual(root.0, ctx.root.0) }
        })
    {
        return false;
    }
    native_windows().is_ok_and(|windows| {
        windows
            .iter()
            .any(|w| w.target == ctx.window.target && w.frame.matches(ctx.window.frame))
    })
}
pub fn capture(
    extra: &str,
    chosen: Option<u32>,
    expected: Option<Target>,
) -> Result<Option<TextCapture>, String> {
    if !permission() {
        return Ok(None);
    }
    let client = Client::new(Duration::from_millis(600));
    let Some(ctx) = context(&client, extra, chosen, expected)? else {
        return Ok(None);
    };
    let Context {
        app,
        root,
        window,
        title,
    } = ctx;
    // Traversal and revalidation each have their own finite allowance.
    let reader = Client::new(Duration::from_millis(600));
    let root_copy = Owned::new(unsafe { CFRetain(root.0) }).expect("retained AX window");
    let text = viewport::collect(&reader, root_copy, window.frame, reader.deadline)?;
    let ctx = Context {
        app,
        root,
        window,
        title,
    };
    let verifier = Client::new(Duration::from_millis(300));
    if !unchanged(&verifier, &ctx, chosen.is_none()) {
        return Err("窗口正在切换，本次内容已丢弃".into());
    }
    if text.is_empty() {
        return Ok(None);
    }
    Ok(Some(TextCapture {
        text,
        app: ctx.window.app,
        title: ctx.title,
    }))
}
pub fn foreground_allowed(extra: &str, expected: Option<Target>) -> Option<bool> {
    if !permission() {
        return None;
    }
    match context(
        &Client::new(Duration::from_millis(300)),
        extra,
        None,
        expected,
    ) {
        Ok(Some(_)) => Some(true),
        Ok(None) => None,
        Err(_) => Some(false),
    }
}
pub fn choices(extra: &str) -> Result<Vec<Value>, String> {
    if !permission() {
        return Err("请先允许辅助功能读字，或授权屏幕访问".into());
    }
    let client = Client::new(Duration::from_millis(1200));
    let mut result = Vec::new();
    // Metadata only. Listing does not fetch any window body text.
    let windows = native_windows()?;
    let mut pids = std::collections::HashSet::new();
    for w in &windows {
        if !client.available() {
            break;
        }
        if !pids.insert(w.target.pid) || observer::blocked(&w.app, "", extra) {
            continue;
        }
        let Some(app) = Owned::new(unsafe { AXUIElementCreateApplication(w.target.pid as i32) })
        else {
            continue;
        };
        let roots = client.elements(&app, c"AXWindows", 64);
        for native in windows.iter().filter(|v| v.target.pid == w.target.pid) {
            if unique_window(&windows, native.target.pid, native.frame).is_none() {
                continue;
            }
            let matching: Vec<_> = roots
                .iter()
                .filter(|n| client.frame(n).is_some_and(|r| r.matches(native.frame)))
                .collect();
            if matching.len() != 1 {
                continue;
            }
            let Some(title) = client.text_attr(matching[0], c"AXTitle") else {
                continue;
            };
            if !observer::blocked(&native.app, &title, extra) {
                result.push(json!({"id":native.target.id,"name":native.app,"title":title}));
            }
        }
    }
    Ok(result)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn same_process_overlapping_windows_are_not_mapped_to_the_wrong_native_id() {
        let frame = Rect {
            x: 10.0,
            y: 20.0,
            width: 400.0,
            height: 300.0,
        };
        let first = Window {
            target: Target { id: 7, pid: 8 },
            frame,
            app: "Fixture".into(),
        };
        let second = Window {
            target: Target { id: 9, pid: 8 },
            ..first.clone()
        };
        assert!(unique_window(&[first.clone(), second], 8, frame).is_none());
        let other = Window {
            target: Target { id: 10, pid: 11 },
            ..first.clone()
        };
        assert_eq!(
            unique_window(&[first, other], 8, frame).unwrap().target.id,
            7
        );
    }
    #[test]
    fn cf_strings_and_ax_ranges_are_typed_and_owned_without_reading_the_desktop() {
        let text = key(c"只读文字");
        assert_eq!(string(text.0).as_deref(), Some("只读文字"));
        assert!(value::<Range>(text.0, 4).is_none());
        let range = Range {
            location: 11,
            length: 22,
        };
        let native =
            Owned::new(unsafe { AXValueCreate(4, &range as *const _ as *const c_void) }).unwrap();
        assert!(string(native.0).is_none());
        let actual: Range = value(native.0, 4).unwrap();
        assert_eq!((actual.location, actual.length), (11, 22));
        assert!(value::<Point>(native.0, 1).is_none());
    }
}
