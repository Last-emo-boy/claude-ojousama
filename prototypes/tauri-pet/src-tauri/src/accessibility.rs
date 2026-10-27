//! Read-only, viewport-bounded text. No actions, input, or persistent content.
#[cfg(target_os = "macos")]
mod macos;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Target {
    // xcap also represents native HWNDs as u32; PID disambiguates reused IDs.
    pub id: u32,
    pub pid: u32,
}
pub struct TextCapture {
    pub text: String,
    pub app: String,
    pub title: String,
}
pub fn supported() -> bool {
    cfg!(target_os = "macos")
}
pub fn permission() -> bool {
    #[cfg(target_os = "macos")]
    return macos::permission();
    #[cfg(not(target_os = "macos"))]
    false
}
pub fn request_permission() -> bool {
    #[cfg(target_os = "macos")]
    return macos::request_permission();
    #[cfg(not(target_os = "macos"))]
    false
}
pub fn capture(
    extra: &str,
    chosen: Option<u32>,
    expected: Option<Target>,
) -> Result<Option<TextCapture>, String> {
    #[cfg(target_os = "macos")]
    return macos::capture(extra, chosen, expected);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (extra, chosen, expected);
        Ok(None)
    }
}
pub fn choices(extra: &str) -> Result<Vec<serde_json::Value>, String> {
    #[cfg(target_os = "macos")]
    return macos::choices(extra);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = extra;
        Ok(Vec::new())
    }
}
pub fn foreground_allowed(extra: &str, expected: Option<Target>) -> Option<bool> {
    #[cfg(target_os = "macos")]
    return macos::foreground_allowed(extra, expected);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (extra, expected);
        None
    }
}

#[cfg(any(target_os = "macos", test))]
mod viewport {
    use std::{collections::HashSet, time::Instant};
    #[derive(Clone, Copy, Debug, PartialEq)]
    pub struct Rect {
        pub x: f64,
        pub y: f64,
        pub width: f64,
        pub height: f64,
    }
    impl Rect {
        pub fn intersection(self, other: Self) -> Option<Self> {
            let x = self.x.max(other.x);
            let y = self.y.max(other.y);
            let width = (self.x + self.width).min(other.x + other.width) - x;
            let height = (self.y + self.height).min(other.y + other.height) - y;
            (width > 0.0 && height > 0.0 && width.is_finite() && height.is_finite()).then_some(
                Self {
                    x,
                    y,
                    width,
                    height,
                },
            )
        }
        pub fn contains(self, other: Self) -> bool {
            other.width > 0.0
                && other.height > 0.0
                && other.x >= self.x
                && other.y >= self.y
                && other.x + other.width <= self.x + self.width
                && other.y + other.height <= self.y + self.height
        }
        pub fn matches(self, other: Self) -> bool {
            (self.x - other.x).abs() <= 2.0
                && (self.y - other.y).abs() <= 2.0
                && (self.width - other.width).abs() <= 2.0
                && (self.height - other.height).abs() <= 2.0
        }
    }
    pub struct Meta {
        pub role: String,
        pub subrole: String,
        pub hidden: bool,
        pub frame: Option<Rect>,
    }
    impl Meta {
        pub fn secure(&self) -> bool {
            self.role == "AXSecureTextField" || self.subrole == "AXSecureTextField"
        }
        pub fn editable(&self) -> bool {
            matches!(
                self.role.as_str(),
                "AXTextArea" | "AXTextField" | "AXComboBox"
            )
        }
        fn readable(&self) -> bool {
            self.editable()
                || matches!(
                    self.role.as_str(),
                    "AXStaticText"
                        | "AXHeading"
                        | "AXButton"
                        | "AXLink"
                        | "AXCheckBox"
                        | "AXRadioButton"
                        | "AXMenuButton"
                        | "AXPopUpButton"
                )
        }
    }
    pub trait Reader {
        type Node;
        fn inspect(&self, node: &Self::Node) -> Meta;
        // Editable text must use AXVisibleCharacterRange + AXStringForRange only.
        fn text(&self, node: &Self::Node, meta: &Meta) -> Option<String>;
        fn children(&self, node: &Self::Node) -> Vec<Self::Node>;
    }
    pub fn collect<R: Reader>(
        reader: &R,
        root: R::Node,
        clip: Rect,
        deadline: Instant,
    ) -> Result<String, String> {
        let mut stack = vec![(root, clip, 0)];
        let mut seen = HashSet::new();
        let mut lines = Vec::new();
        let mut chars = 0;
        let mut nodes = 0;
        while let Some((node, clip, depth)) = stack.pop() {
            if nodes >= 500 || Instant::now() >= deadline || chars >= 10_000 {
                break;
            }
            nodes += 1;
            let meta = reader.inspect(&node);
            if meta.hidden {
                continue;
            }
            if meta.secure() {
                return Err("当前窗口含密码输入框，本次观察已跳过".into());
            }
            if meta.frame.is_some_and(|r| r.intersection(clip).is_none()) {
                continue;
            }
            // Without a frame, only traverse containers; never read unpositioned text.
            let fully_visible = meta.frame.is_some_and(|r| clip.contains(r));
            if fully_visible && meta.readable() {
                if let Some(value) = reader.text(&node, &meta) {
                    let value = value.trim();
                    if !value.is_empty() && seen.insert(value.to_string()) {
                        let line: String = value.chars().take(10_000 - chars).collect();
                        chars += line.chars().count();
                        lines.push(line);
                    }
                }
            }
            let clip = if matches!(meta.role.as_str(), "AXScrollArea" | "AXWebArea") {
                match meta.frame.and_then(|r| r.intersection(clip)) {
                    Some(r) => r,
                    None => continue,
                }
            } else {
                clip
            };
            if depth < 20 {
                stack.extend(
                    reader
                        .children(&node)
                        .into_iter()
                        .rev()
                        .map(|n| (n, clip, depth + 1)),
                );
            }
        }
        Ok(lines.join("\n"))
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        use std::{cell::RefCell, time::Duration};
        struct Fake {
            roles: Vec<(&'static str, &'static str, bool, Option<Rect>)>,
            reads: RefCell<Vec<usize>>,
            values: Vec<String>,
            children: Vec<Vec<usize>>,
        }
        const BOX: Rect = Rect {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 100.0,
        };
        impl Reader for Fake {
            type Node = usize;
            fn inspect(&self, n: &usize) -> Meta {
                let (role, subrole, hidden, frame) = self.roles[*n];
                Meta {
                    role: role.into(),
                    subrole: subrole.into(),
                    hidden,
                    frame,
                }
            }
            fn text(&self, n: &usize, _: &Meta) -> Option<String> {
                self.reads.borrow_mut().push(*n);
                Some(self.values[*n].clone())
            }
            fn children(&self, n: &usize) -> Vec<usize> {
                self.children[*n].clone()
            }
        }
        fn fake(items: Vec<(&'static str, &'static str, bool, Option<Rect>)>) -> Fake {
            Fake {
                values: vec!["可见文字".into(); items.len()],
                children: (0..items.len())
                    .map(|i| {
                        if i == 0 {
                            (1..items.len()).collect()
                        } else {
                            Vec::new()
                        }
                    })
                    .collect(),
                roles: items,
                reads: RefCell::new(Vec::new()),
            }
        }
        #[test]
        fn hidden_offscreen_and_partly_clipped_values_are_never_read() {
            let r = fake(vec![
                ("AXWindow", "", false, Some(BOX)),
                ("AXStaticText", "", true, Some(BOX)),
                ("AXStaticText", "", false, Some(Rect { x: 200.0, ..BOX })),
                ("AXStaticText", "", false, Some(Rect { x: 50.0, ..BOX })),
                ("AXStaticText", "", false, None),
                ("AXStaticText", "", false, Some(BOX)),
            ]);
            assert_eq!(
                collect(&r, 0, BOX, Instant::now() + Duration::from_secs(1)).unwrap(),
                "可见文字"
            );
            assert_eq!(*r.reads.borrow(), vec![5]);
        }
        #[test]
        fn secure_fields_abort_before_their_values_are_read() {
            let r = fake(vec![
                ("AXWindow", "", false, Some(BOX)),
                ("AXTextField", "AXSecureTextField", false, Some(BOX)),
            ]);
            assert!(collect(&r, 0, BOX, Instant::now() + Duration::from_secs(1)).is_err());
            assert!(r.reads.borrow().is_empty());
        }
        #[test]
        fn deduplicates_and_limits_unicode_without_breaking_characters() {
            let mut r = fake(vec![
                ("AXWindow", "", false, Some(BOX)),
                ("AXStaticText", "", false, Some(BOX)),
                ("AXStaticText", "", false, Some(BOX)),
            ]);
            assert_eq!(
                collect(&r, 0, BOX, Instant::now() + Duration::from_secs(1)).unwrap(),
                "可见文字"
            );
            r.values[1] = "文".repeat(20_000);
            assert_eq!(
                collect(&r, 0, BOX, Instant::now() + Duration::from_secs(1))
                    .unwrap()
                    .chars()
                    .count(),
                10_000
            );
            r.reads.borrow_mut().clear();
            assert!(collect(&r, 0, BOX, Instant::now()).unwrap().is_empty());
            assert!(r.reads.borrow().is_empty());
        }
        #[test]
        fn scroll_viewport_clips_descendants_even_inside_the_window() {
            let mut r = fake(vec![
                ("AXWindow", "", false, Some(BOX)),
                (
                    "AXScrollArea",
                    "",
                    false,
                    Some(Rect {
                        height: 40.0,
                        ..BOX
                    }),
                ),
                (
                    "AXStaticText",
                    "",
                    false,
                    Some(Rect {
                        y: 50.0,
                        height: 10.0,
                        ..BOX
                    }),
                ),
                (
                    "AXStaticText",
                    "",
                    false,
                    Some(Rect {
                        height: 10.0,
                        ..BOX
                    }),
                ),
            ]);
            r.children = vec![vec![1], vec![2, 3], vec![], vec![]];
            assert_eq!(
                collect(&r, 0, BOX, Instant::now() + Duration::from_secs(1)).unwrap(),
                "可见文字"
            );
            assert_eq!(*r.reads.borrow(), vec![3]);
        }
        #[test]
        fn editable_roles_always_require_visible_ranges() {
            for role in ["AXTextArea", "AXTextField", "AXComboBox"] {
                assert!(Meta {
                    role: role.into(),
                    subrole: String::new(),
                    hidden: false,
                    frame: Some(BOX)
                }
                .editable());
            }
        }
        #[test]
        fn window_mapping_requires_matching_bounds() {
            assert!(BOX.matches(Rect { x: 1.0, ..BOX }));
            assert!(!BOX.matches(Rect { x: 10.0, ..BOX }));
            assert!(!BOX.matches(Rect { width: 50.0, ..BOX }));
        }
    }
}
