//! One desktop coordinate space: macOS points, Windows/X11 physical pixels.
use serde::Serialize;
use std::collections::VecDeque;
use tauri::WebviewWindow;

pub type Point = (f64, f64);

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
impl Bounds {
    pub fn right(self) -> f64 {
        self.x + self.width
    }
    pub fn bottom(self) -> f64 {
        self.y + self.height
    }
    pub fn contains(self, p: Point) -> bool {
        p.0 >= self.x && p.0 <= self.right() && p.1 >= self.y && p.1 <= self.bottom()
    }
    pub fn distance(self, p: Point) -> f64 {
        (p.0 - p.0.clamp(self.x, self.right())).hypot(p.1 - p.1.clamp(self.y, self.bottom()))
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct Screen {
    pub name: String,
    pub bounds: Bounds,
    pub work: Bounds,
    pub scale: f64,
}
impl Screen {
    pub fn key(&self) -> String {
        format!(
            "{}:{}:{}:{}:{}",
            self.bounds.x, self.bounds.y, self.bounds.width, self.bounds.height, self.name
        )
    }
    pub fn floor(&self, x: f64) -> Point {
        let margin = (90.0 * self.scale).min(self.work.width / 2.0);
        (
            x.clamp(self.work.x + margin, self.work.right() - margin),
            self.work.bottom() - 5.0 * self.scale,
        )
    }
    pub fn fullscreen(&self, window: &crate::windows::WindowRect) -> bool {
        let e = 6.0 * self.scale;
        (window.x - self.bounds.x).abs() <= e
            && (window.y - self.bounds.y).abs() <= e
            && (window.width - self.bounds.width).abs() <= e
            && (window.height - self.bounds.height).abs() <= e
    }
}

pub fn nearest(screens: &[Screen], point: Point) -> Option<usize> {
    screens
        .iter()
        .enumerate()
        .min_by(|(_, a), (_, b)| {
            a.bounds
                .distance(point)
                .total_cmp(&b.bounds.distance(point))
        })
        .map(|(i, _)| i)
}

// A corridor must fit the character. Touching corners and disconnected screens are not portals.
fn portal(a: &Screen, b: &Screen, from: Point) -> Option<Point> {
    let (a, b, scale) = (a.bounds, b.bounds, a.scale.max(b.scale));
    let top = a.y.max(b.y) + 180.0 * scale;
    let bottom = a.bottom().min(b.bottom()) - 8.0 * scale;
    if top <= bottom {
        if (a.right() - b.x).abs() <= 2.0 {
            return Some(((a.right() + b.x) / 2.0, from.1.clamp(top, bottom)));
        }
        if (b.right() - a.x).abs() <= 2.0 {
            return Some(((b.right() + a.x) / 2.0, from.1.clamp(top, bottom)));
        }
    }
    let left = a.x.max(b.x) + 90.0 * scale;
    let right = a.right().min(b.right()) - 90.0 * scale;
    if left <= right {
        if (a.bottom() - b.y).abs() <= 2.0 {
            return Some((from.0.clamp(left, right), (a.bottom() + b.y) / 2.0));
        }
        if (b.bottom() - a.y).abs() <= 2.0 {
            return Some((from.0.clamp(left, right), (b.bottom() + a.y) / 2.0));
        }
    }
    None
}

/// Route through each display's corridor, never through a virtual-desktop bounding-box hole.
pub fn path(
    screens: &[Screen],
    from: Point,
    destination: usize,
    x: f64,
) -> Result<Vec<Point>, String> {
    let start = nearest(screens, from).ok_or("没有可用的显示器")?;
    if destination >= screens.len() {
        return Err("目标显示器已断开".into());
    }
    let mut parent = vec![None; screens.len()];
    let mut queue = VecDeque::from([start]);
    parent[start] = Some(start);
    while let Some(i) = queue.pop_front() {
        if i == destination {
            break;
        }
        for j in 0..screens.len() {
            if parent[j].is_none() && portal(&screens[i], &screens[j], from).is_some() {
                parent[j] = Some(i);
                queue.push_back(j);
            }
        }
    }
    if parent[destination].is_none() {
        return Err("这块屏幕与当前屏幕不相连，请在系统显示设置中调整排列".into());
    }
    let mut chain = vec![destination];
    while *chain.last().unwrap() != start {
        chain.push(parent[*chain.last().unwrap()].unwrap());
    }
    chain.reverse();
    let mut points = Vec::new();
    let mut point = from;
    for pair in chain.windows(2) {
        point = portal(&screens[pair[0]], &screens[pair[1]], point)
            .ok_or("显示器之间没有可通行的边缘")?;
        points.push(point);
    }
    points.push(screens[destination].floor(x));
    Ok(points)
}

pub fn units(window: &WebviewWindow) -> f64 {
    if cfg!(target_os = "macos") {
        1.0
    } else {
        window.scale_factor().unwrap_or(1.0)
    }
}
pub fn position(window: &WebviewWindow) -> Result<Point, String> {
    let p = window.outer_position().map_err(|e| e.to_string())?;
    let divisor = if cfg!(target_os = "macos") {
        window.scale_factor().map_err(|e| e.to_string())?
    } else {
        1.0
    };
    Ok((p.x as f64 / divisor, p.y as f64 / divisor))
}
pub fn size(window: &WebviewWindow) -> Result<Point, String> {
    let p = window.outer_size().map_err(|e| e.to_string())?;
    let divisor = if cfg!(target_os = "macos") {
        window.scale_factor().map_err(|e| e.to_string())?
    } else {
        1.0
    };
    Ok((p.width as f64 / divisor, p.height as f64 / divisor))
}
pub fn place(window: &WebviewWindow, point: Point) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let result = window.set_position(tauri::LogicalPosition::new(point.0, point.1));
    #[cfg(not(target_os = "macos"))]
    let result = window.set_position(tauri::PhysicalPosition::new(
        point.0.round() as i32,
        point.1.round() as i32,
    ));
    result.map_err(|e| e.to_string())
}
pub fn cursor(window: &WebviewWindow) -> Option<Point> {
    let p = window.cursor_position().ok()?;
    // Tao reports the *global* Mac cursor using the primary screen's factor, not the pet's.
    let divisor = if cfg!(target_os = "macos") {
        window.primary_monitor().ok()??.scale_factor()
    } else {
        1.0
    };
    Some((p.x / divisor, p.y / divisor))
}
pub fn screens(window: &WebviewWindow) -> Result<Vec<Screen>, String> {
    let mut result = Vec::new();
    for monitor in window.available_monitors().map_err(|e| e.to_string())? {
        let divisor = if cfg!(target_os = "macos") {
            monitor.scale_factor()
        } else {
            1.0
        };
        let p = monitor.position();
        let s = monitor.size();
        let w = monitor.work_area();
        let bounds = Bounds {
            x: p.x as f64 / divisor,
            y: p.y as f64 / divisor,
            width: s.width as f64 / divisor,
            height: s.height as f64 / divisor,
        };
        let screen = Screen {
            name: monitor.name().cloned().unwrap_or_else(|| "显示器".into()),
            bounds,
            work: Bounds {
                x: w.position.x as f64 / divisor,
                y: w.position.y as f64 / divisor,
                width: w.size.width as f64 / divisor,
                height: w.size.height as f64 / divisor,
            },
            scale: if cfg!(target_os = "macos") {
                1.0
            } else {
                monitor.scale_factor()
            },
        };
        if !result.iter().any(|s: &Screen| s.bounds == screen.bounds) {
            result.push(screen);
        }
    }
    #[cfg(target_os = "macos")]
    mac_bounds(&mut result)?;
    let mut seen = Vec::new();
    result.retain(|s| {
        if seen.contains(&s.bounds) {
            false
        } else {
            seen.push(s.bounds);
            true
        }
    });
    Ok(result)
}

#[cfg(target_os = "macos")]
fn mac_bounds(screens: &mut [Screen]) -> Result<(), String> {
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
        fn CGGetActiveDisplayList(max: u32, ids: *mut u32, count: *mut u32) -> i32;
        fn CGDisplayBounds(id: u32) -> Rect;
    }
    let mut ids = [0u32; 32];
    let mut count = 0;
    if unsafe { CGGetActiveDisplayList(32, ids.as_mut_ptr(), &mut count) } != 0 {
        return Err("无法读取 Mac 显示器布局".into());
    }
    let bounds: Vec<_> = ids[..count as usize]
        .iter()
        .map(|id| {
            let r = unsafe { CGDisplayBounds(*id) };
            Bounds {
                x: r.origin.x,
                y: r.origin.y,
                width: r.size.width,
                height: r.size.height,
            }
        })
        .collect();
    for screen in screens {
        screen.bounds = *bounds
            .iter()
            .find(|b| (b.x - screen.bounds.x).abs() < 2.0 && (b.y - screen.bounds.y).abs() < 2.0)
            .ok_or("显示器布局正在变化，请稍后重试")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn screen(x: f64, y: f64, width: f64, height: f64, scale: f64) -> Screen {
        let bounds = Bounds {
            x,
            y,
            width,
            height,
        };
        Screen {
            name: "fixture".into(),
            bounds,
            work: bounds,
            scale,
        }
    }
    fn assert_visible(screens: &[Screen], from: Point, path: &[Point]) {
        let mut from = from;
        for end in path {
            for i in 0..=100 {
                let t = i as f64 / 100.0;
                let p = (from.0 + (end.0 - from.0) * t, from.1 + (end.1 - from.1) * t);
                assert!(
                    screens.iter().any(|s| s.bounds.contains(p)),
                    "route crossed a desktop hole at {p:?}"
                );
            }
            from = *end;
        }
    }
    #[test]
    fn mixed_dpi_and_negative_origins_cross_a_shared_edge() {
        let s = [
            screen(-1920.0, 0.0, 1920.0, 1080.0, 1.0),
            screen(0.0, 0.0, 2880.0, 1800.0, 2.0),
        ];
        let p = path(&s, (-800.0, 1075.0), 1, 1500.0).unwrap();
        assert_eq!(p.last(), Some(&(1500.0, 1790.0)));
        assert_visible(&s, (-800.0, 1075.0), &p);
    }
    #[test]
    fn l_shaped_layout_uses_intermediate_screen_not_a_diagonal_shortcut() {
        let s = [
            screen(0.0, 0.0, 1000.0, 800.0, 1.0),
            screen(1000.0, 0.0, 1000.0, 800.0, 1.0),
            screen(1000.0, 800.0, 1000.0, 800.0, 1.0),
        ];
        let p = path(&s, (100.0, 795.0), 2, 1700.0).unwrap();
        assert_eq!(p.len(), 3);
        assert_visible(&s, (100.0, 795.0), &p);
    }
    #[test]
    fn disconnected_corner_only_and_removed_screens_are_rejected() {
        let a = screen(0.0, 0.0, 1000.0, 800.0, 1.0);
        for b in [
            screen(1100.0, 0.0, 1000.0, 800.0, 1.0),
            screen(1000.0, 800.0, 1000.0, 800.0, 1.0),
        ] {
            assert!(path(&[a.clone(), b], (500.0, 795.0), 1, 1500.0).is_err());
        }
        assert!(path(&[a], (500.0, 795.0), 1, 1500.0).is_err());
    }
    #[test]
    fn vertically_stacked_screens_and_fullscreen_detection_use_full_display_bounds() {
        let s = [
            screen(0.0, 0.0, 1200.0, 800.0, 1.0),
            screen(200.0, -900.0, 1400.0, 900.0, 1.0),
        ];
        let p = path(&s, (300.0, 795.0), 1, 700.0).unwrap();
        assert_visible(&s, (300.0, 795.0), &p);
        let mut w = crate::windows::WindowRect {
            id: 1,
            pid: 2,
            x: 0.0,
            y: 0.0,
            width: 1200.0,
            height: 800.0,
        };
        assert!(s[0].fullscreen(&w));
        w.y = 26.0;
        w.height -= 26.0;
        assert!(!s[0].fullscreen(&w));
    }
}
