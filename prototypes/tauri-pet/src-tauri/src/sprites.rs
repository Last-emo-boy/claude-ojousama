use image::RgbaImage;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Deserialize)]
pub struct Manifest {
    pub anims: BTreeMap<String, Definition>,
}
#[derive(Deserialize)]
pub struct Definition {
    pub file: String,
    pub w: u32,
    pub h: u32,
    pub frames: u32,
}
#[derive(Debug, PartialEq, Serialize)]
pub struct Band {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

pub fn bands(image: &RgbaImage, sheet: &Definition) -> Result<Vec<Vec<Band>>, String> {
    if sheet.w == 0
        || sheet.h == 0
        || sheet.frames == 0
        || sheet.w.checked_mul(sheet.frames) != Some(image.width())
        || sheet.h != image.height()
    {
        return Err("角色图集尺寸与动作定义不一致".into());
    }
    Ok((0..sheet.frames)
        .map(|frame| {
            let mut bands = Vec::new();
            for y in (0..sheet.h).step_by(6) {
                let bottom = (y + 6).min(sheet.h);
                let mut left = sheet.w;
                let mut right = None;
                for row in y..bottom {
                    for x in 0..sheet.w {
                        if image.get_pixel(frame * sheet.w + x, row)[3] > 8 {
                            left = left.min(x);
                            right = Some(right.map_or(x, |old: u32| old.max(x)));
                        }
                    }
                }
                if let Some(right) = right {
                    bands.push(Band {
                        x: left,
                        y,
                        width: right - left + 1,
                        height: bottom - y,
                    });
                }
            }
            bands
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    #[test]
    fn native_bands_match_the_renderers_alpha_threshold_and_six_row_contract() {
        let mut image = RgbaImage::new(8, 8);
        image.put_pixel(0, 0, Rgba([0, 0, 0, 8]));
        image.put_pixel(1, 0, Rgba([0, 0, 0, 9]));
        image.put_pixel(3, 5, Rgba([0, 0, 0, 255]));
        image.put_pixel(6, 7, Rgba([0, 0, 0, 255]));
        let sheet = Definition {
            file: "test.png".into(),
            w: 4,
            h: 8,
            frames: 2,
        };
        assert_eq!(
            bands(&image, &sheet).unwrap(),
            vec![
                vec![Band {
                    x: 1,
                    y: 0,
                    width: 3,
                    height: 6
                }],
                vec![Band {
                    x: 2,
                    y: 6,
                    width: 1,
                    height: 2
                }],
            ]
        );
    }

    #[test]
    fn mismatched_sheets_fail_without_installing_incorrect_hit_regions() {
        let sheet = Definition {
            file: "test.png".into(),
            w: 4,
            h: 8,
            frames: 2,
        };
        assert!(bands(&RgbaImage::new(4, 8), &sheet).is_err());
    }
}
