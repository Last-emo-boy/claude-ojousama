//! Read-only native window geometry, in front-to-back order. No titles or capture.
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
pub struct WindowRect {
    pub id: u64,
    pub pid: u32,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct Seat {
    pub window: WindowRect,
    pub left: f64,
    pub right: f64,
    pub top: f64,
}

impl Seat {
    pub fn remains_visible(&self, seats: &[Seat], centre: f64, scale: f64) -> bool {
        seats.iter().any(|seat| {
            let a = &self.window;
            let b = &seat.window;
            a.id == b.id
                && a.pid == b.pid
                && (a.x - b.x).abs() <= 3.0 * scale
                && (a.y - b.y).abs() <= 3.0 * scale
                && (a.width - b.width).abs() <= 3.0 * scale
                && (a.height - b.height).abs() <= 3.0 * scale
                && centre >= seat.left
                && centre <= seat.right
        })
    }
}

/// Subtract higher windows from each top edge, not just from the target centre.
pub fn seats(windows: &[WindowRect], scale: f64) -> Vec<Seat> {
    let mut result = Vec::new();
    for (z, window) in windows.iter().enumerate() {
        if window.width < 160.0 * scale || window.height < 80.0 * scale {
            continue;
        }
        let mut spans = vec![(
            window.x + 32.0 * scale,
            window.x + window.width - 32.0 * scale,
        )];
        for above in &windows[..z] {
            if above.y > window.y + 2.0 * scale || above.y + above.height < window.y - 2.0 * scale {
                continue;
            }
            let (cut_left, cut_right) =
                (above.x - 8.0 * scale, above.x + above.width + 8.0 * scale);
            spans = spans
                .into_iter()
                .flat_map(|(left, right)| {
                    if cut_right <= left || cut_left >= right {
                        return vec![(left, right)];
                    }
                    let mut pieces = Vec::new();
                    if cut_left > left {
                        pieces.push((left, cut_left));
                    }
                    if cut_right < right {
                        pieces.push((cut_right, right));
                    }
                    pieces
                })
                .collect();
        }
        for (left, right) in spans {
            if right - left >= 60.0 * scale {
                result.push(Seat {
                    window: window.clone(),
                    left,
                    right,
                    top: window.y,
                });
            }
        }
    }
    result
}

#[cfg(target_os = "macos")]
pub fn visible(scale: f64) -> Result<Vec<WindowRect>, String> {
    use std::ffi::c_void;
    type Ref = *const c_void;
    #[repr(C)]
    struct Point {
        x: f64,
        y: f64,
    }
    #[repr(C)]
    struct Size {
        width: f64,
        height: f64,
    }
    #[repr(C)]
    struct Rect {
        origin: Point,
        size: Size,
    }
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGWindowListCopyWindowInfo(options: u32, relative: u32) -> Ref;
        fn CGRectMakeWithDictionaryRepresentation(dict: Ref, rect: *mut Rect) -> bool;
        static kCGWindowNumber: Ref;
        static kCGWindowOwnerPID: Ref;
        static kCGWindowBounds: Ref;
        static kCGWindowLayer: Ref;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFArrayGetCount(array: Ref) -> isize;
        fn CFArrayGetValueAtIndex(array: Ref, index: isize) -> Ref;
        fn CFDictionaryGetValue(dict: Ref, key: Ref) -> Ref;
        fn CFNumberGetValue(number: Ref, kind: isize, out: *mut c_void) -> bool;
        fn CFRelease(value: Ref);
    }
    unsafe fn number(dict: Ref, key: Ref) -> Option<i64> {
        let value = CFDictionaryGetValue(dict, key);
        let mut out = 0_i64;
        if value.is_null() || !CFNumberGetValue(value, 4, &mut out as *mut _ as *mut c_void) {
            None
        } else {
            Some(out)
        }
    }
    unsafe {
        let list = CGWindowListCopyWindowInfo(1 | 16, 0);
        if list.is_null() {
            return Err("macOS 未返回可见窗口信息".into());
        }
        let mut windows = Vec::new();
        for index in 0..CFArrayGetCount(list).min(256) {
            let item = CFArrayGetValueAtIndex(list, index);
            let Some(pid) = number(item, kCGWindowOwnerPID) else {
                continue;
            };
            if pid == std::process::id() as i64 || number(item, kCGWindowLayer) != Some(0) {
                continue;
            }
            let (Some(id), bounds) = (
                number(item, kCGWindowNumber),
                CFDictionaryGetValue(item, kCGWindowBounds),
            ) else {
                continue;
            };
            if bounds.is_null() {
                continue;
            }
            let mut rect = Rect {
                origin: Point { x: 0.0, y: 0.0 },
                size: Size {
                    width: 0.0,
                    height: 0.0,
                },
            };
            if CGRectMakeWithDictionaryRepresentation(bounds, &mut rect) {
                windows.push(WindowRect {
                    id: id as u64,
                    pid: pid as u32,
                    x: rect.origin.x * scale,
                    y: rect.origin.y * scale,
                    width: rect.size.width * scale,
                    height: rect.size.height * scale,
                });
            }
        }
        CFRelease(list);
        Ok(windows)
    }
}

#[cfg(target_os = "windows")]
pub fn visible(_scale: f64) -> Result<Vec<WindowRect>, String> {
    use std::ffi::c_void;
    type Hwnd = *mut c_void;
    #[repr(C)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }
    #[link(name = "user32")]
    extern "system" {
        fn EnumWindows(callback: unsafe extern "system" fn(Hwnd, isize) -> i32, data: isize)
            -> i32;
        fn IsWindowVisible(hwnd: Hwnd) -> i32;
        fn IsIconic(hwnd: Hwnd) -> i32;
        fn GetWindowThreadProcessId(hwnd: Hwnd, pid: *mut u32) -> u32;
        fn GetWindowRect(hwnd: Hwnd, rect: *mut Rect) -> i32;
        fn GetWindowLongW(hwnd: Hwnd, index: i32) -> i32;
    }
    #[link(name = "dwmapi")]
    extern "system" {
        fn DwmGetWindowAttribute(hwnd: Hwnd, attribute: u32, value: *mut c_void, size: u32) -> i32;
    }
    unsafe extern "system" fn collect(hwnd: Hwnd, data: isize) -> i32 {
        let mut pid = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == std::process::id()
            || IsWindowVisible(hwnd) == 0
            || IsIconic(hwnd) != 0
            || GetWindowLongW(hwnd, -20) & 0x80 != 0
        {
            return 1;
        }
        let mut cloaked = 0_u32;
        if DwmGetWindowAttribute(hwnd, 14, &mut cloaked as *mut _ as *mut c_void, 4) == 0
            && cloaked != 0
        {
            return 1;
        }
        let mut rect = Rect {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        let got = DwmGetWindowAttribute(
            hwnd,
            9,
            &mut rect as *mut _ as *mut c_void,
            std::mem::size_of::<Rect>() as u32,
        ) == 0
            || GetWindowRect(hwnd, &mut rect) != 0;
        if got && rect.right > rect.left && rect.bottom > rect.top {
            let windows = &mut *(data as *mut Vec<WindowRect>);
            windows.push(WindowRect {
                id: hwnd as u64,
                pid,
                x: rect.left as f64,
                y: rect.top as f64,
                width: (rect.right - rect.left) as f64,
                height: (rect.bottom - rect.top) as f64,
            });
        }
        1
    }
    let mut windows = Vec::new();
    if unsafe { EnumWindows(collect, &mut windows as *mut _ as isize) } == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(windows)
}

#[cfg(target_os = "linux")]
pub fn visible(_scale: f64) -> Result<Vec<WindowRect>, String> {
    use x11rb::{
        connection::Connection,
        errors::ReplyError,
        protocol::{
            xproto::{AtomEnum, ConnectionExt, MapState},
            ErrorKind,
        },
    };
    fn property<C: Connection>(
        connection: &C,
        window: u32,
        name: u32,
    ) -> Result<Vec<u32>, ReplyError> {
        let reply = connection
            .get_property(false, window, name, AtomEnum::ANY, 0, 2048)?
            .reply()?;
        Ok(reply.value32().map(|v| v.collect()).unwrap_or_default())
    }
    if std::env::var_os("DISPLAY").is_none() {
        return Err("Wayland 不提供全局窗口上沿；请使用 X11 或 XWayland".into());
    }
    let (connection, screen) = x11rb::connect(None).map_err(|e| e.to_string())?;
    let root = connection.setup().roots[screen].root;
    let atom = |name: &str| -> Result<u32, String> {
        connection
            .intern_atom(false, name.as_bytes())
            .map_err(|e| e.to_string())?
            .reply()
            .map(|r| r.atom)
            .map_err(|e| e.to_string())
    };
    let list = property(&connection, root, atom("_NET_CLIENT_LIST_STACKING")?)
        .map_err(|e| e.to_string())?;
    let pid_key = atom("_NET_WM_PID")?;
    let state_key = atom("_NET_WM_STATE")?;
    let hidden = atom("_NET_WM_STATE_HIDDEN")?;
    let type_key = atom("_NET_WM_WINDOW_TYPE")?;
    let normal = atom("_NET_WM_WINDOW_TYPE_NORMAL")?;
    let dialog = atom("_NET_WM_WINDOW_TYPE_DIALOG")?;
    let extents_key = atom("_NET_FRAME_EXTENTS")?;
    let desktop_key = atom("_NET_WM_DESKTOP")?;
    let desktop = property(&connection, root, atom("_NET_CURRENT_DESKTOP")?)
        .map_err(|e| e.to_string())?
        .first()
        .copied();
    let mut windows = Vec::new();
    for id in list.into_iter().rev().take(256) {
        let read_window = || -> Result<Option<WindowRect>, ReplyError> {
            let pid = property(&connection, id, pid_key)?
                .first()
                .copied()
                .unwrap_or(0);
            if pid == std::process::id() || property(&connection, id, state_key)?.contains(&hidden)
            {
                return Ok(None);
            }
            let kinds = property(&connection, id, type_key)?;
            if !kinds.is_empty() && !kinds.contains(&normal) && !kinds.contains(&dialog) {
                return Ok(None);
            }
            let owner_desktop = property(&connection, id, desktop_key)?.first().copied();
            if let (Some(current), Some(owner)) = (desktop, owner_desktop) {
                if owner != current && owner != u32::MAX {
                    return Ok(None);
                }
            }
            if connection.get_window_attributes(id)?.reply()?.map_state != MapState::VIEWABLE {
                return Ok(None);
            }
            let g = connection.get_geometry(id)?.reply()?;
            let p = connection.translate_coordinates(id, root, 0, 0)?.reply()?;
            let extents = property(&connection, id, extents_key)?;
            let (left, right, top, bottom) = if extents.len() == 4 {
                (extents[0], extents[1], extents[2], extents[3])
            } else {
                (0, 0, 0, 0)
            };
            Ok(Some(WindowRect {
                id: id as u64,
                pid,
                x: p.dst_x as f64 - left as f64,
                y: p.dst_y as f64 - top as f64,
                width: g.width as f64 + (left + right) as f64,
                height: g.height as f64 + (top + bottom) as f64,
            }))
        };
        match read_window() {
            Ok(Some(window)) => windows.push(window),
            Ok(None) => {}
            // A normal close may race enumeration. Connection/permission failures propagate.
            Err(ReplyError::X11Error(error))
                if matches!(error.error_kind, ErrorKind::Window | ErrorKind::Drawable) => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(windows)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_closed_moved_resized_or_covered_window_releases_its_seat() {
        let original = seats(&[rect(7, 50.0, 400.0, 800.0, 500.0)], 1.0).remove(0);
        assert!(original.remains_visible(&[original.clone()], 300.0, 1.0));
        assert!(!original.remains_visible(&[], 300.0, 1.0));
        let moved = seats(&[rect(7, 50.0, 430.0, 800.0, 500.0)], 1.0);
        assert!(!original.remains_visible(&moved, 300.0, 1.0));
        let resized = seats(&[rect(7, 50.0, 400.0, 500.0, 500.0)], 1.0);
        assert!(!original.remains_visible(&resized, 300.0, 1.0));
        let covered = seats(
            &[rect(8, 100.0, 200.0, 500.0, 700.0), original.window.clone()],
            1.0,
        );
        assert!(!original.remains_visible(&covered, 300.0, 1.0));
    }
    fn rect(id: u64, x: f64, y: f64, w: f64, h: f64) -> WindowRect {
        WindowRect {
            id,
            pid: 1,
            x,
            y,
            width: w,
            height: h,
        }
    }
    #[test]
    fn obscured_edges_are_not_seats_and_partial_edges_are_split() {
        let back = rect(2, 0.0, 400.0, 800.0, 300.0);
        let front = rect(1, 200.0, 300.0, 300.0, 300.0);
        let seats = seats(&[front, back], 1.0);
        let pieces: Vec<_> = seats
            .iter()
            .filter(|s| s.window.id == 2)
            .map(|s| (s.left, s.right))
            .collect();
        assert_eq!(pieces, vec![(32.0, 192.0), (508.0, 768.0)]);
        assert!(super::seats(
            &[
                rect(1, 0.0, 100.0, 900.0, 800.0),
                rect(2, 0.0, 400.0, 800.0, 300.0)
            ],
            1.0
        )
        .iter()
        .all(|s| s.window.id != 2));
    }
}
