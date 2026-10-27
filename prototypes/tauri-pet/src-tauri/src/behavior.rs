//! Local companion habits. Owns animation intents, never native window positions or model work.
use serde_json::{json, Value};
const MINUTE: u64 = 60_000;
#[derive(Clone, Copy, Default)]
pub struct Context {
    pub at: u64,
    pub free: bool,
    pub may_sleep: bool,
    pub unlocked: bool,
    pub ambient: bool,
}
impl Context {
    pub fn fresh(self, now: u64) -> bool {
        self.at > 0 && now.saturating_sub(self.at) < 5_000
    }
}
pub struct Scene {
    pub animation: &'static str,
    pub text: &'static str,
    pub duration: u64,
}
fn scene(animation: &'static str, duration: u64) -> Scene {
    Scene {
        animation,
        text: "",
        duration,
    }
}
#[derive(Default)]
pub struct Update {
    pub scene: Option<Scene>,
    pub decay: bool,
}
#[derive(Default)]
pub struct State {
    last_tick: Option<u64>,
    next_idle: u64,
    next_prank: u64,
    next_decay: u64,
    water_active: u64,
    sleeping: bool,
    seed: u64,
}
impl State {
    fn number(&mut self) -> u64 {
        self.seed = self.seed.wrapping_mul(6364136223846793005).wrapping_add(1);
        self.seed >> 32
    }
    fn idle_delay(&mut self, d: &Value) -> u64 {
        let (a, b) = match d["settings"]["autonomy"].as_str().unwrap_or("active") {
            "quiet" => (8, 14),
            "normal" => (4, 8),
            _ => (3, 5),
        };
        (a + self.number() % (b - a + 1)) * MINUTE
    }
    pub fn tick(
        &mut self,
        d: &Value,
        now: u64,
        idle: f64,
        context: Context,
        blocked: bool,
        quiet: bool,
    ) -> Update {
        let dt = self
            .last_tick
            .replace(now)
            .map(|last| now.saturating_sub(last).min(30_000))
            .unwrap_or(0);
        if self.next_idle == 0 {
            self.seed = now | 1;
            self.next_idle = now + 2 * MINUTE;
            self.next_prank = now + 10 * MINUTE;
            self.next_decay = now + 15 * MINUTE;
        }
        let present = context.fresh(now) && context.unlocked && idle.is_finite();
        let mut result = Update::default();
        if present && idle < 120.0 && now >= self.next_decay {
            self.next_decay = now + 15 * MINUTE;
            result.decay = d["pet"]["mood"].as_i64().unwrap_or(0) != 0;
        }
        let water = d["settings"]["waterMinutes"].as_u64().unwrap_or(60);
        if water == 0 {
            self.water_active = 0;
        } else if present && idle < 60.0 {
            self.water_active = self.water_active.saturating_add(dt);
        }
        let focus = d["settings"]["focusGuard"] != false
            && d["pomodoro"]["until"].as_u64().unwrap_or(0) > now;
        let enabled = d["settings"]["idleActions"] != false;
        let sleep = present && context.may_sleep && enabled && !focus && idle >= 300.0;
        if self.sleeping && !sleep {
            // Let an explicit response or task finish before issuing the wake gesture.
            if blocked {
                return result;
            }
            self.sleeping = false;
            result.scene = Some(scene(
                if present && context.free && !blocked && !quiet && !focus {
                    "stretch"
                } else {
                    "idle"
                },
                3000,
            ));
            return result;
        }
        if sleep {
            if !self.sleeping && !blocked {
                self.sleeping = true;
                result.scene = Some(scene("nap", 3_600_000));
            }
            return result;
        }
        if !present || !context.free || blocked || quiet || focus || idle >= 120.0 {
            return result;
        }
        let proactive = d["settings"]["proactive"] != false;
        if proactive && water > 0 && self.water_active >= water.saturating_mul(MINUTE) {
            self.water_active = 0;
            self.next_idle = self.next_idle.max(now + 30_000);
            result.scene = Some(Scene {
                animation: "water",
                text: "喝口水，也让肩膀松一松。",
                duration: 8000,
            });
            return result;
        }
        let mischief = d["settings"]["mischief"].as_u64().unwrap_or(2);
        if enabled && proactive && mischief > 0 && now >= self.next_prank {
            let mean = match mischief {
                1 => 55,
                2 => 28,
                _ => 11,
            };
            self.next_prank = now + (mean * 4 / 5 + self.number() % (mean * 2 / 5 + 1)) * MINUTE;
            self.next_idle = now + self.idle_delay(d);
            let animations = if d["growth"]["level"].as_u64().unwrap_or(1) >= 3 {
                vec!["giggle", "laugh", "magic"]
            } else {
                vec!["giggle", "laugh", "stretch"]
            };
            result.scene = Some(scene(
                animations[self.number() as usize % animations.len()],
                5000,
            ));
            return result;
        }
        if enabled && now >= self.next_idle {
            self.next_idle = now + self.idle_delay(d);
            let mut pool = vec!["read", "eat", "water", "stretch", "phone", "write", "clean"];
            let mood = d["pet"]["mood"].as_i64().unwrap_or(0);
            if mood <= -2 {
                pool.push("sulk");
            } else if mood >= 2 {
                pool.extend(["giggle", "laugh"]);
            }
            let level = d["growth"]["level"].as_u64().unwrap_or(1);
            if level >= 2 {
                pool.push("pet");
            }
            if level >= 3 {
                pool.push("magic");
            }
            if level >= 4 {
                pool.push("dance");
            }
            if level >= 6 {
                pool.push("cheer");
            }
            if level >= 5
                && now.saturating_sub(d["pet"]["lastGiftAt"].as_u64().unwrap_or(0))
                    >= 3 * 86_400_000
            {
                pool.push("gift");
            }
            result.scene = Some(scene(pool[self.number() as usize % pool.len()], 8000));
        }
        result
    }
}
pub fn reward(d: &mut Value) -> bool {
    let before = d["pet"]["affection"].as_u64().unwrap_or(0).min(999);
    let affection = (before + 1).min(999);
    d["pet"]["mood"] = json!((d["pet"]["mood"].as_i64().unwrap_or(0).clamp(-3, 3) + 1).min(3));
    d["pet"]["affection"] = json!(affection);
    affection / 20 > before / 20
}
pub fn attention(d: &mut Value, now: u64) -> Option<bool> {
    if d["pet"]["lastTouchAt"]
        .as_u64()
        .is_some_and(|last| now.saturating_sub(last) < 10 * MINUTE)
    {
        return None;
    }
    d["pet"]["lastTouchAt"] = json!(now);
    Some(reward(d))
}
pub fn decay(d: &mut Value) {
    let value = d["pet"]["mood"].as_i64().unwrap_or(0).clamp(-3, 3);
    d["pet"]["mood"] = json!(value - value.signum());
}
#[cfg(test)]
mod tests {
    use super::*;
    fn context(now: u64) -> Context {
        Context {
            at: now,
            free: true,
            may_sleep: true,
            unlocked: true,
            ambient: true,
        }
    }
    #[test]
    fn idle_scenes_are_silent_bounded_and_never_own_movement() {
        let d = crate::companion::defaults();
        let mut s = State::default();
        s.tick(&d, 1000, 1.0, context(1000), false, false);
        let result = s
            .tick(&d, 130_000, 1.0, context(130_000), false, false)
            .scene
            .unwrap();
        assert!(result.text.is_empty());
        assert!(result.duration <= 8000);
        assert!(!["walk", "climb", "ledge"].contains(&result.animation));
        let assets: Value =
            serde_json::from_str(include_str!("../../../../assets/sprites/manifest.json")).unwrap();
        assert!(assets["anims"].get(result.animation).is_some());
    }
    #[test]
    fn task_focus_quiet_stale_hidden_and_disabled_contexts_prevent_idle_scenes() {
        for condition in 0..6 {
            let mut d = crate::companion::defaults();
            let mut s = State::default();
            s.tick(&d, 1000, 1.0, context(1000), false, false);
            let now = 130_000;
            let mut c = context(now);
            match condition {
                1 => d["pomodoro"]["until"] = json!(now + MINUTE),
                3 => c.at = 1000,
                4 => c.free = false,
                5 => d["settings"]["idleActions"] = json!(false),
                _ => {}
            }
            assert!(s
                .tick(&d, now, 1.0, c, condition == 0, condition == 2)
                .scene
                .is_none());
        }
    }
    #[test]
    fn away_rest_and_return_are_silent_transitions_not_repeated_speech() {
        let d = crate::companion::defaults();
        let mut s = State::default();
        assert_eq!(
            s.tick(&d, 1000, 301.0, context(1000), false, false)
                .scene
                .unwrap()
                .animation,
            "nap"
        );
        assert!(s
            .tick(&d, 5000, 400.0, context(5000), false, false)
            .scene
            .is_none());
        assert_eq!(
            s.tick(&d, 9000, 0.0, context(9000), false, false)
                .scene
                .unwrap()
                .animation,
            "stretch"
        );
    }
    #[test]
    fn water_uses_active_time_not_a_sleep_or_suspension_jump() {
        let mut d = crate::companion::defaults();
        d["settings"]["waterMinutes"] = json!(1);
        d["settings"]["idleActions"] = json!(false);
        let mut s = State::default();
        s.tick(&d, 1000, 0.0, context(1000), false, false);
        assert!(s
            .tick(&d, 3_601_000, 4000.0, context(3_601_000), false, false)
            .scene
            .is_none());
        assert!(s
            .tick(&d, 3_631_000, 0.0, context(3_631_000), false, false)
            .scene
            .is_none());
        assert_eq!(
            s.tick(&d, 3_661_000, 0.0, context(3_661_000), false, false)
                .scene
                .unwrap()
                .animation,
            "water"
        );
    }
    #[test]
    fn nap_does_not_wake_itself_or_overwrite_a_manual_response() {
        let d = crate::companion::defaults();
        let mut s = State::default();
        s.tick(&d, 1000, 301.0, context(1000), false, false);
        assert!(s
            .tick(&d, 5000, 400.0, context(5000), true, false)
            .scene
            .is_none());
        assert!(s
            .tick(&d, 9000, 0.0, context(9000), true, false)
            .scene
            .is_none());
        assert_eq!(
            s.tick(&d, 13000, 0.0, context(13000), false, false)
                .scene
                .unwrap()
                .animation,
            "stretch"
        );
    }
    #[test]
    fn every_unlocked_idle_scene_has_a_real_sprite_sheet() {
        let mut d = crate::companion::defaults();
        d["growth"]["level"] = json!(6);
        let assets: Value =
            serde_json::from_str(include_str!("../../../../assets/sprites/manifest.json")).unwrap();
        for mood in [-3, 0, 3] {
            d["pet"]["mood"] = json!(mood);
            let mut s = State::default();
            for n in 1..200 {
                let now = n * 10 * MINUTE + 300_000_000;
                if let Some(scene) = s.tick(&d, now, 0.0, context(now), false, false).scene {
                    assert!(
                        assets["anims"].get(scene.animation).is_some(),
                        "{}",
                        scene.animation
                    );
                }
            }
        }
    }
    #[test]
    fn attention_preserves_legacy_mood_affection_bounds_and_cooldown() {
        let mut d = crate::companion::defaults();
        d["pet"]["affection"] = json!(19);
        d["pet"]["mood"] = json!(3);
        assert_eq!(attention(&mut d, 1_000_000), Some(true));
        assert_eq!(d["pet"]["affection"], 20);
        assert_eq!(d["pet"]["mood"], 3);
        assert_eq!(attention(&mut d, 1_001_000), None);
        assert_eq!(d["pet"]["affection"], 20);
        decay(&mut d);
        assert_eq!(d["pet"]["mood"], 2);
        d["pet"]["affection"] = json!(999);
        attention(&mut d, 2_000_000);
        assert_eq!(d["pet"]["affection"], 999);
    }
    #[test]
    fn mood_decays_toward_neutral_once_per_interval_without_a_bubble() {
        let mut d = crate::companion::defaults();
        d["pet"]["mood"] = json!(-3);
        let mut s = State::default();
        s.tick(&d, 1000, 0.0, context(1000), true, false);
        let update = s.tick(&d, 901_000, 0.0, context(901_000), true, false);
        assert!(update.decay);
        assert!(update.scene.is_none());
        decay(&mut d);
        assert_eq!(d["pet"]["mood"], -2);
        assert!(
            !s.tick(&d, 905_000, 0.0, context(905_000), true, false)
                .decay
        );
    }
}
