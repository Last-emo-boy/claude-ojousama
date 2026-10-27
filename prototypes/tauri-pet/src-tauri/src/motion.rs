use crate::{
    desktop::{Bounds, Point},
    windows::Seat,
};
use serde::Serialize;
use std::collections::VecDeque;
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Motion {
    pub phase: String,
    pub x: f64,
    pub y: f64,
    pub vx: f64,
    pub vy: f64,
    pub seat: Option<Seat>,
    pub facing: i8,
    pub paused: bool,
    pub pause_reason: String,
    pub generation: u64,
    #[serde(skip)]
    route: Option<Route>,
    #[serde(skip)]
    body_size: Point,
    #[serde(skip)]
    pub offset: (f64, f64),
    #[serde(skip)]
    pub reduced: bool,
    #[serde(skip)]
    pub scale: f64,
    #[serde(skip)]
    pub last_sample: Instant,
    #[serde(skip)]
    pub hardware_seen: bool,
}

#[derive(Clone, Debug)]
struct Leg {
    from: Point,
    to: Point,
    phase: &'static str,
    seconds: f64,
    elapsed: f64,
    facing: i8,
}
#[derive(Clone, Debug)]
struct Route {
    legs: VecDeque<Leg>,
    seat: Option<Seat>,
    autonomous: bool,
    layout: Vec<Bounds>,
}

fn leg(from: Point, to: Point, phase: &'static str, speed: f64, facing: i8) -> Leg {
    Leg {
        from,
        to,
        phase,
        seconds: ((to.0 - from.0).hypot(to.1 - from.1) / speed).max(0.016),
        elapsed: 0.0,
        facing,
    }
}

impl Motion {
    pub fn new(x: f64, y: f64) -> Self {
        Self {
            phase: "settled".into(),
            x,
            y,
            vx: 0.0,
            vy: 0.0,
            seat: None,
            facing: 1,
            paused: false,
            pause_reason: String::new(),
            generation: 0,
            route: None,
            body_size: (360.0, 340.0),
            offset: (0.0, 0.0),
            reduced: false,
            scale: 1.0,
            last_sample: Instant::now(),
            hardware_seen: false,
        }
    }

    pub fn begin(&mut self, cursor: (f64, f64)) {
        self.generation = self.generation.wrapping_add(1);
        self.route = None;
        self.paused = false;
        self.seat = None;
        self.offset = (cursor.0 - self.x, cursor.1 - self.y);
        self.phase = "dragging".into();
        self.vx = 0.0;
        self.vy = 0.0;
        self.last_sample = Instant::now();
        self.hardware_seen = false;
    }

    pub fn drag(&mut self, cursor: (f64, f64), dt: f64) {
        let (x, y) = (cursor.0 - self.offset.0, cursor.1 - self.offset.1);
        if (x - self.x).abs() < 0.01 && (y - self.y).abs() < 0.01 {
            return;
        }
        let cap = 2200.0 * self.scale;
        let target_x = ((x - self.x) / dt).clamp(-cap, cap);
        let target_y = ((y - self.y) / dt).clamp(-cap, cap);
        self.vx = self.vx * 0.4 + target_x * 0.6;
        self.vy = self.vy * 0.4 + target_y * 0.6;
        self.x = x;
        self.y = y;
        self.last_sample = Instant::now();
    }

    pub fn release(&mut self) {
        if self.phase != "dragging" {
            return;
        }
        self.generation = self.generation.wrapping_add(1);
        if self.last_sample.elapsed() > Duration::from_millis(80) {
            self.vx = 0.0;
            self.vy = 0.0;
        }
        self.phase = if self.reduced { "settled" } else { "flying" }.into();
        if self.reduced {
            self.vx = 0.0;
            self.vy = 0.0;
        }
    }

    pub fn step(&mut self, dt: f64, bounds: (f64, f64, f64, f64)) {
        if self.phase != "flying" {
            return;
        }
        let (left, top, right, bottom) = bounds;
        self.vy += 1800.0 * self.scale * dt;
        self.vx *= (-1.5 * dt).exp();
        self.x += self.vx * dt;
        self.y += self.vy * dt;
        if self.x < left || self.x > right {
            self.x = self.x.clamp(left, right);
            self.vx *= -0.45;
        }
        if self.y < top {
            self.y = top;
            self.vy = self.vy.abs() * 0.45;
        }
        if self.y >= bottom {
            self.y = bottom;
            self.vy *= -0.38;
            self.vx *= 0.72;
            if self.vy.abs() < 55.0 * self.scale && self.vx.abs() < 12.0 * self.scale {
                self.phase = "settled".into();
                self.vx = 0.0;
                self.vy = 0.0;
            }
        }
    }

    pub fn sit(&mut self, seat: Seat, size: (f64, f64)) {
        self.route = None;
        self.paused = false;
        self.x = (self.x + size.0 / 2.0).clamp(seat.left, seat.right) - size.0 / 2.0;
        // The original character's sit sheet hangs 36 sprite pixels below the edge.
        self.y = seat.top - (size.1 - 5.0 * self.scale) + 36.0 * 1.35 * self.scale;
        self.vx = 0.0;
        self.vy = 0.0;
        self.phase = "perched".into();
        self.last_sample = Instant::now();
        self.seat = Some(seat);
    }

    pub fn leave(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.route = None;
        self.paused = false;
        self.seat = None;
        self.phase = "flying".into();
        self.vx = 0.0;
        self.vy = 50.0 * self.scale;
        self.last_sample = Instant::now();
    }

    pub fn feet(&self, size: Point) -> Point {
        (self.x + size.0 / 2.0, self.y + size.1 - 5.0 * self.scale)
    }
    pub fn pause(&mut self, reason: &str) {
        self.paused = !reason.is_empty();
        self.pause_reason = reason.into();
    }
    pub fn scripted(&self) -> bool {
        self.route.is_some()
    }
    pub fn autonomous(&self) -> bool {
        self.route.as_ref().is_some_and(|r| r.autonomous)
    }
    pub fn target_seat(&self) -> Option<&Seat> {
        self.route.as_ref().and_then(|r| r.seat.as_ref())
    }
    pub fn target_centre(&self) -> Option<f64> {
        self.route
            .as_ref()
            .and_then(|r| r.legs.back())
            .map(|l| l.to.0)
    }
    pub fn reduce(&mut self, enabled: bool) {
        self.reduced = enabled;
        if enabled && (self.scripted() || self.phase == "flying") {
            self.route = None;
            self.phase = "settled".into();
            self.vx = 0.0;
            self.vy = 0.0;
            self.paused = false;
        }
    }
    pub fn layout_valid(&self, screens: &[crate::desktop::Screen]) -> bool {
        self.route
            .as_ref()
            .is_none_or(|r| r.layout == screens.iter().map(|s| s.bounds).collect::<Vec<_>>())
    }
    pub fn rebase(&mut self, size: Point, scale: f64) {
        if self.scripted() && (self.body_size != size || (self.scale - scale).abs() > 0.001) {
            let feet = self.feet(self.body_size);
            self.x = feet.0 - size.0 / 2.0;
            self.y = feet.1 - size.1 + 5.0 * scale;
        }
        self.body_size = size;
        self.scale = scale;
    }
    fn start(
        &mut self,
        legs: VecDeque<Leg>,
        seat: Option<Seat>,
        screens: &[crate::desktop::Screen],
        autonomous: bool,
    ) {
        self.generation = self.generation.wrapping_add(1);
        self.seat = None;
        self.paused = false;
        self.vx = 0.0;
        self.vy = 0.0;
        self.phase = legs.front().map(|l| l.phase).unwrap_or("settled").into();
        self.facing = legs.front().map(|l| l.facing).unwrap_or(self.facing);
        self.route = (!legs.is_empty()).then(|| Route {
            legs,
            seat,
            autonomous,
            layout: screens.iter().map(|s| s.bounds).collect(),
        });
        self.last_sample = Instant::now();
    }
    pub fn walk(
        &mut self,
        points: &[Point],
        size: Point,
        screens: &[crate::desktop::Screen],
        autonomous: bool,
    ) {
        self.rebase(size, self.scale);
        let mut legs = VecDeque::new();
        let mut from = self.feet(size);
        let mut face = self.facing;
        for &to in points {
            let dx = to.0 - from.0;
            let dy = to.1 - from.1;
            if dx.abs() > 1.0 {
                face = if dx > 0.0 { 1 } else { -1 };
            }
            let phase = if dy.abs() > 60.0 * self.scale {
                if dy < 0.0 {
                    "climbing"
                } else {
                    "descending"
                }
            } else {
                "walking"
            };
            legs.push_back(leg(
                from,
                to,
                phase,
                if phase == "walking" { 90.0 } else { 150.0 } * self.scale,
                face,
            ));
            from = to;
        }
        self.start(legs, None, screens, autonomous);
    }
    pub fn climb(
        &mut self,
        seat: Seat,
        side: i8,
        floor: f64,
        size: Point,
        screens: &[crate::desktop::Screen],
        autonomous: bool,
    ) {
        self.rebase(size, self.scale);
        let s = self.scale;
        let mut legs = VecDeque::new();
        let mut from = self.feet(size);
        let down = (from.0, floor);
        if (down.1 - from.1).abs() > 5.0 * s {
            legs.push_back(leg(from, down, "descending", 220.0 * s, self.facing));
            from = down;
        }
        let edge = if side > 0 {
            seat.window.x - 42.0 * s
        } else {
            seat.window.x + seat.window.width + 42.0 * s
        };
        let walk = (edge, floor);
        let face = if walk.0 >= from.0 { 1 } else { -1 };
        legs.push_back(leg(from, walk, "walking", 110.0 * s, face));
        from = walk;
        let up = (edge, seat.top + 100.0 * s);
        legs.push_back(leg(from, up, "climbing", 105.0 * s, side));
        let x = if side > 0 {
            seat.window.x + 100.0 * s
        } else {
            seat.window.x + seat.window.width - 100.0 * s
        };
        let end = (x.clamp(seat.left, seat.right), seat.top + 36.0 * 1.35 * s);
        let mut hoist = leg(up, end, "hoisting", 150.0 * s, side);
        hoist.seconds = 1.0;
        legs.push_back(hoist);
        self.start(legs, Some(seat), screens, autonomous);
    }
    pub fn advance(&mut self, dt: f64, size: Point) {
        if self.paused {
            return;
        }
        let Some(mut route) = self.route.take() else {
            return;
        };
        let Some(current) = route.legs.front_mut() else {
            return;
        };
        current.elapsed = (current.elapsed + dt).min(current.seconds);
        let mut t = current.elapsed / current.seconds;
        if current.phase == "hoisting" {
            t = t * t * (3.0 - 2.0 * t);
        }
        let p = (
            current.from.0 + (current.to.0 - current.from.0) * t,
            current.from.1 + (current.to.1 - current.from.1) * t,
        );
        let old = self.feet(size);
        self.x = p.0 - size.0 / 2.0;
        self.y = p.1 - size.1 + 5.0 * self.scale;
        self.vx = (p.0 - old.0) / dt;
        self.vy = (p.1 - old.1) / dt;
        self.facing = current.facing;
        let finished = current.elapsed >= current.seconds;
        if finished {
            route.legs.pop_front();
        }
        if let Some(next) = route.legs.front() {
            self.phase = next.phase.into();
            self.route = Some(route);
        } else {
            self.phase = "settled".into();
            self.vx = 0.0;
            self.vy = 0.0;
            self.last_sample = Instant::now();
            if let Some(seat) = route.seat {
                self.sit(seat, size);
            }
        }
    }

    pub fn land(&mut self, seats: &[Seat], previous_feet: f64, size: (f64, f64)) -> bool {
        if self.phase != "flying" || self.vy < 0.0 {
            return false;
        }
        let centre = self.x + size.0 / 2.0;
        let feet = self.y + size.1 - 5.0 * self.scale;
        let seat = seats
            .iter()
            .filter(|s| {
                centre >= s.left
                    && centre <= s.right
                    && s.top >= previous_feet - 6.0 * self.scale
                    && s.top <= feet + 3.0 * self.scale
            })
            .min_by(|a, b| a.top.total_cmp(&b.top))
            .cloned();
        if let Some(seat) = seat {
            self.sit(seat, size);
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::windows::WindowRect;
    fn screens() -> Vec<crate::desktop::Screen> {
        let b = Bounds {
            x: 0.0,
            y: 0.0,
            width: 1600.0,
            height: 1000.0,
        };
        vec![crate::desktop::Screen {
            name: "fixture".into(),
            bounds: b,
            work: b,
            scale: 1.0,
        }]
    }
    #[test]
    fn walk_is_continuous_and_grabbing_cancels_every_remaining_leg() {
        let mut m = Motion::new(100.0, 660.0);
        let size = (360.0, 340.0);
        m.walk(&[(800.0, 995.0)], size, &screens(), true);
        assert_eq!(m.x, 100.0);
        m.advance(0.016, size);
        assert!(m.x > 100.0 && m.x < 102.0);
        let grabbed = (m.x, m.y);
        m.begin((m.x + 60.0, m.y + 80.0));
        let generation = m.generation;
        for _ in 0..500 {
            m.advance(0.016, size);
        }
        assert_eq!((m.x, m.y), grabbed);
        assert_eq!(m.phase, "dragging");
        assert_eq!(m.generation, generation);
        assert!(!m.scripted());
    }
    #[test]
    fn climbing_reaches_the_edge_then_hoists_and_keeps_the_native_seat() {
        let mut m = Motion::new(200.0, 660.0);
        let size = (360.0, 340.0);
        let mut phases = Vec::new();
        m.climb(seat(), -1, 995.0, size, &screens(), false);
        assert_eq!((m.x, m.y), (200.0, 660.0));
        for _ in 0..1500 {
            if phases.last() != Some(&m.phase) {
                phases.push(m.phase.clone());
            }
            m.advance(0.02, size);
        }
        assert_eq!(phases, vec!["walking", "climbing", "hoisting", "perched"]);
        assert_eq!(m.seat.as_ref().unwrap().window.id, 1);
        assert_eq!(m.facing, -1);
        assert!(!m.scripted());
        assert!((m.feet(size).1 - (500.0 + 48.6)).abs() < 0.01);
    }
    #[test]
    fn pause_freezes_a_route_and_dpi_rebase_preserves_the_foot_anchor() {
        let mut m = Motion::new(100.0, 660.0);
        let size = (360.0, 340.0);
        m.walk(&[(900.0, 995.0)], size, &screens(), true);
        m.advance(0.02, size);
        let feet = m.feet(size);
        m.paused = true;
        m.advance(1.0, size);
        assert_eq!(m.feet(size), feet);
        m.rebase((720.0, 680.0), 2.0);
        assert_eq!(m.feet((720.0, 680.0)), feet);
        m.paused = false;
        m.advance(0.02, (720.0, 680.0));
        assert!(m.feet((720.0, 680.0)).0 > feet.0);
        m.reduce(true);
        let p = (m.x, m.y);
        m.advance(1.0, (720.0, 680.0));
        assert_eq!((m.x, m.y), p);
        assert!(!m.scripted());
    }
    #[test]
    fn unplug_or_rearrangement_invalidates_a_pending_route() {
        let mut m = Motion::new(100.0, 660.0);
        let mut s = screens();
        m.walk(&[(900.0, 995.0)], (360.0, 340.0), &s, true);
        assert!(m.layout_valid(&s));
        s[0].bounds.x = -500.0;
        assert!(!m.layout_valid(&s));
        assert!(!m.layout_valid(&[]));
    }
    fn seat() -> Seat {
        Seat {
            window: WindowRect {
                id: 1,
                pid: 1,
                x: 50.0,
                y: 500.0,
                width: 800.0,
                height: 500.0,
            },
            left: 82.0,
            right: 818.0,
            top: 500.0,
        }
    }
    #[test]
    fn falling_crosses_window_edge_and_sits_with_legs_below_it() {
        let mut m = Motion::new(200.0, 140.0);
        m.phase = "flying".into();
        m.vy = 900.0;
        let before = m.y + 335.0;
        m.step(0.04, (0.0, 0.0, 1200.0, 1000.0));
        assert!(m.land(&[seat()], before, (360.0, 340.0)));
        assert_eq!(m.phase, "perched");
        assert!((m.y - (500.0 - 335.0 + 48.6)).abs() < 0.01);
        assert_eq!(m.seat.as_ref().unwrap().window.id, 1);
        m.leave();
        assert!(
            !m.land(&[seat()], m.y + 335.0, (360.0, 340.0)),
            "leaving must not land immediately on the same edge"
        );
        m.begin((m.x + 100.0, m.y + 100.0));
        assert!(m.seat.is_none());
    }
    #[test]
    fn no_landing_while_rising_or_outside_visible_span() {
        let mut m = Motion::new(1000.0, 200.0);
        m.phase = "flying".into();
        m.vy = 100.0;
        assert!(!m.land(&[seat()], 450.0, (360.0, 340.0)));
        m.x = 200.0;
        m.vy = -100.0;
        assert!(!m.land(&[seat()], 450.0, (360.0, 340.0)));
    }
    #[test]
    fn final_identical_pointer_sample_preserves_fling_but_a_held_pointer_does_not() {
        let mut m = Motion::new(0.0, 0.0);
        m.begin((0.0, 0.0));
        m.drag((40.0, 20.0), 0.016);
        let velocity = (m.vx, m.vy);
        m.drag((40.0, 20.0), 0.016);
        assert_eq!((m.vx, m.vy), velocity);
        m.last_sample = Instant::now() - Duration::from_millis(100);
        m.release();
        assert_eq!((m.vx, m.vy), (0.0, 0.0));
    }
    #[test]
    fn throw_keeps_momentum_and_settles_inside_work_area() {
        let mut m = Motion::new(200.0, 100.0);
        m.begin((220.0, 140.0));
        m.drag((250.0, 140.0), 0.016);
        m.release();
        let release_x = m.x;
        m.step(0.016, (0.0, 0.0, 800.0, 600.0));
        assert!(m.x > release_x);
        for _ in 0..1600 {
            m.step(0.016, (0.0, 0.0, 800.0, 600.0));
        }
        assert_eq!(m.phase, "settled");
        assert_eq!(m.y, 600.0);
        assert!((0.0..=800.0).contains(&m.x));
    }
    #[test]
    fn reduced_motion_stays_where_released_and_regrab_interrupts_flight() {
        let mut m = Motion::new(10.0, 10.0);
        m.reduced = true;
        m.begin((10.0, 10.0));
        m.drag((100.0, 80.0), 0.016);
        m.release();
        m.step(1.0, (0.0, 0.0, 800.0, 600.0));
        assert_eq!((m.x, m.y), (100.0, 80.0));
        m.reduced = false;
        m.begin((100.0, 80.0));
        m.release();
        m.begin((100.0, 80.0));
        assert_eq!(m.phase, "dragging");
        assert_eq!((m.vx, m.vy), (0.0, 0.0));
    }
}
