use crate::windows::Seat;
use serde::Serialize;
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

impl Motion {
    pub fn new(x: f64, y: f64) -> Self {
        Self {
            phase: "settled".into(),
            x,
            y,
            vx: 0.0,
            vy: 0.0,
            seat: None,
            offset: (0.0, 0.0),
            reduced: false,
            scale: 1.0,
            last_sample: Instant::now(),
            hardware_seen: false,
        }
    }

    pub fn begin(&mut self, cursor: (f64, f64)) {
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
        self.x = (self.x + size.0 / 2.0).clamp(seat.left, seat.right) - size.0 / 2.0;
        // The original character's sit sheet hangs 36 sprite pixels below the edge.
        self.y = seat.top - (size.1 - 5.0 * self.scale) + 36.0 * 1.35 * self.scale;
        self.vx = 0.0;
        self.vy = 0.0;
        self.phase = "perched".into();
        self.seat = Some(seat);
    }

    pub fn leave(&mut self) {
        self.seat = None;
        self.phase = "flying".into();
        self.vx = 0.0;
        self.vy = 50.0 * self.scale;
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
