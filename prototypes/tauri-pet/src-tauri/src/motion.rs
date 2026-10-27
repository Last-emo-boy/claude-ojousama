use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Motion {
    pub phase: String,
    pub x: f64,
    pub y: f64,
    pub vx: f64,
    pub vy: f64,
    #[serde(skip)]
    pub offset: (f64, f64),
    #[serde(skip)]
    pub reduced: bool,
    #[serde(skip)]
    pub scale: f64,
}

impl Motion {
    pub fn new(x: f64, y: f64) -> Self {
        Self {
            phase: "settled".into(),
            x,
            y,
            vx: 0.0,
            vy: 0.0,
            offset: (0.0, 0.0),
            reduced: false,
            scale: 1.0,
        }
    }

    pub fn begin(&mut self, cursor: (f64, f64)) {
        self.offset = (cursor.0 - self.x, cursor.1 - self.y);
        self.phase = "dragging".into();
        self.vx = 0.0;
        self.vy = 0.0;
    }

    pub fn drag(&mut self, cursor: (f64, f64), dt: f64) {
        let (x, y) = (cursor.0 - self.offset.0, cursor.1 - self.offset.1);
        let cap = 2200.0 * self.scale;
        let target_x = ((x - self.x) / dt).clamp(-cap, cap);
        let target_y = ((y - self.y) / dt).clamp(-cap, cap);
        self.vx = self.vx * 0.4 + target_x * 0.6;
        self.vy = self.vy * 0.4 + target_y * 0.6;
        self.x = x;
        self.y = y;
    }

    pub fn release(&mut self) {
        if self.phase != "dragging" {
            return;
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
}

#[cfg(test)]
mod tests {
    use super::*;
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
