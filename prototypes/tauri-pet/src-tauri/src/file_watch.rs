//! Metadata-only discovery. Existing files are a baseline, never a new-file offer.
use crate::utilities;
use serde_json::{json, Value};
use std::{collections::HashMap, fs, path::Path, time::UNIX_EPOCH};

pub const STABLE_MS: u64 = 45_000;
#[derive(Clone, Debug)]
pub struct File {
    pub name: String,
    pub full: String,
    pub size: u64,
    pub modified: u64,
}
pub struct Folder {
    pub path: String,
    pub files: Vec<File>,
}
pub fn enabled(d: &Value) -> bool {
    d["watch"]["native"]["enabled"] == true && d["watch"]["native"]["consentVersion"] == 1
}
pub fn configuration(d: &Value) -> Value {
    json!([
        d["watch"]["native"],
        d["settings"]["watchFolders"],
        d["settings"]["rules"]["tidy"]
    ])
}
pub fn roots(
    folders: &Value,
    downloads: &Result<std::path::PathBuf, String>,
) -> Result<Vec<String>, String> {
    let paths = if folders.is_null() {
        vec![downloads.as_ref().map_err(Clone::clone)?.clone()]
    } else {
        folders
            .as_array()
            .ok_or("文件夹设置格式错误")?
            .iter()
            .map(|p| {
                p.as_str()
                    .filter(|p| !p.trim().is_empty())
                    .map(std::path::PathBuf::from)
                    .ok_or("请选择有效的文件夹".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?
    };
    if paths.is_empty() {
        return Err("请至少选择一个文件夹".into());
    }
    let mut result = Vec::new();
    for path in paths {
        let path = fs::canonicalize(&path)
            .map_err(|e| format!("文件夹不可用：{}：{e}", path.display()))?;
        if !path.is_dir() {
            return Err("请选择文件夹，而不是文件".into());
        }
        let path = path
            .to_str()
            .ok_or("文件夹路径不能表示为 Unicode")?
            .to_owned();
        if !result.contains(&path) {
            result.push(path);
        }
    }
    Ok(result)
}
pub fn configure(
    d: &mut Value,
    enabled: bool,
    folders: Value,
    mode: &str,
    roots: &[String],
) -> Result<(), String> {
    if !folders.is_null()
        && !folders.as_array().is_some_and(|a| {
            !a.is_empty()
                && a.iter()
                    .all(|v| v.as_str().is_some_and(|s| !s.trim().is_empty()))
        })
    {
        return Err("请选择有效的文件夹列表，或留空使用系统下载目录".into());
    }
    if !matches!(mode, "ask" | "auto" | "off") {
        return Err("请选择先预览、自动整理或关闭".into());
    }
    d["settings"]["watchFolders"] = folders;
    d["settings"]["rules"]["tidy"] = json!(mode);
    // Every explicit reconfiguration starts with a silent baseline. A normal
    // restart, in contrast, retains seen/pending/ready and does not forget files.
    d["watch"] = json!({"seen":{},"pending":{},"ready":[],"native":{"enabled":enabled,"consentVersion":if enabled{1}else{0},"autoRoots":if enabled&&mode=="auto"{json!(roots)}else{Value::Null},"autoError":""}});
    clear_notice(d);
    Ok(())
}
fn ignored(name: &str) -> bool {
    let lower = name.to_lowercase();
    name.starts_with('.')
        || name.starts_with("~$")
        || matches!(lower.as_str(), "desktop.ini" | "thumbs.db")
        || Path::new(&lower)
            .extension()
            .and_then(|s| s.to_str())
            .is_some_and(|s| {
                matches!(
                    s,
                    "crdownload"
                        | "part"
                        | "partial"
                        | "download"
                        | "tmp"
                        | "temp"
                        | "opdownload"
                        | "aria2"
                )
            })
}
pub fn read(folder: &str) -> Result<Folder, String> {
    if fs::canonicalize(folder).map_err(|e| e.to_string())? != Path::new(folder) {
        return Err("文件夹位置已变化，请重新选择".into());
    }
    let mut files = Vec::new();
    for entry in fs::read_dir(folder).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "有文件名不能表示为 Unicode")?;
        if ignored(&name) {
            continue;
        }
        let meta = match fs::symlink_metadata(entry.path()) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.to_string()),
        };
        if !meta.is_file() {
            continue;
        }
        let modified = meta
            .modified()
            .map_err(|e| e.to_string())?
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        files.push(File {
            name,
            full: entry
                .path()
                .to_str()
                .ok_or("文件路径不能表示为 Unicode")?
                .into(),
            size: meta.len(),
            modified,
        });
    }
    files.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(Folder {
        path: folder.into(),
        files,
    })
}
fn same(file: &File, value: &Value) -> bool {
    value["size"] == file.size && value["modified"] == file.modified
}
pub fn reconcile(watch: &mut Value, folder: &Folder, now: u64, off: bool) -> Result<usize, String> {
    if !watch["seen"].is_object() || !watch["pending"].is_object() {
        return Err("文件发现记录损坏，请重新保存文件夹设置".into());
    }
    if watch.get("ready").is_none() {
        watch["ready"] = json!([]);
    }
    if !watch["ready"].is_array() {
        return Err("新文件列表损坏，请重新保存文件夹设置".into());
    }
    let files: HashMap<_, _> = folder.files.iter().map(|f| (f.name.as_str(), f)).collect();
    watch["ready"].as_array_mut().unwrap().retain(|v| {
        v["folder"] != folder.path
            || (!off
                && files
                    .get(v["name"].as_str().unwrap_or(""))
                    .is_some_and(|f| same(f, v)))
    });
    watch["pending"].as_object_mut().unwrap().retain(|full, _| {
        Path::new(full).parent() != Some(Path::new(&folder.path))
            || Path::new(full)
                .file_name()
                .and_then(|s| s.to_str())
                .is_some_and(|name| files.contains_key(name))
    });
    if watch["seen"].get(&folder.path).is_none() || off {
        watch["seen"][&folder.path] = Value::Object(
            folder
                .files
                .iter()
                .map(|f| (f.name.clone(), json!(f.modified)))
                .collect(),
        );
        watch["pending"]
            .as_object_mut()
            .unwrap()
            .retain(|full, _| Path::new(full).parent() != Some(Path::new(&folder.path)));
        return Ok(0);
    }
    watch["seen"][&folder.path]
        .as_object_mut()
        .ok_or("文件基线损坏，请重新保存文件夹设置")?
        .retain(|name, _| files.contains_key(name.as_str()));
    let mut added = 0;
    for f in &folder.files {
        if watch["seen"][&folder.path].get(&f.name).is_some()
            || utilities::category(&f.name).is_none()
        {
            watch["seen"][&folder.path][&f.name] = json!(f.modified);
            watch["pending"].as_object_mut().unwrap().remove(&f.full);
            continue;
        }
        let p = &watch["pending"][&f.full];
        if !same(f, p) {
            watch["pending"][&f.full] = json!({"size":f.size,"modified":f.modified,"since":now});
        } else if now.saturating_sub(p["since"].as_u64().unwrap_or(now)) >= STABLE_MS
            && now.saturating_sub(f.modified) >= STABLE_MS / 2
        {
            watch["ready"].as_array_mut().unwrap().push(json!({"folder":folder.path,"name":f.name,"full":f.full,"size":f.size,"modified":f.modified,"cat":utilities::category(&f.name)}));
            watch["seen"][&folder.path][&f.name] = json!(f.modified);
            watch["pending"].as_object_mut().unwrap().remove(&f.full);
            added += 1;
        }
    }
    Ok(added)
}
pub fn selected(d: &Value, folder: &str) -> Vec<Value> {
    d["watch"]["ready"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|v| v["folder"] == folder)
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}
pub fn clear_notice(d: &mut Value) {
    if let Some(items) = d["inbox"].as_array_mut() {
        items.retain(|v| v["kind"] != "files");
    }
}
pub fn remove_ready(d: &mut Value, matches: impl Fn(&Value) -> bool) {
    if let Some(items) = d["watch"]["ready"].as_array_mut() {
        items.retain(|v| !matches(v));
    }
    let count = d["watch"]["ready"].as_array().map_or(0, Vec::len);
    if count == 0 {
        clear_notice(d);
    } else if let Some(items) = d["inbox"].as_array_mut() {
        for item in items.iter_mut().filter(|v| v["kind"] == "files") {
            item["text"] = json!(format!("发现 {count} 个新文件，想看看怎么整理吗？"));
        }
    }
}
pub fn restored(d: &mut Value, movement: &Value) {
    let Some(full) = movement["from"].as_str() else {
        return;
    };
    let path = Path::new(full);
    if let (Some(folder), Some(name)) = (
        path.parent().and_then(|p| p.to_str()),
        path.file_name().and_then(|s| s.to_str()),
    ) {
        if d["watch"]["seen"][folder].is_object() {
            d["watch"]["seen"][folder][name] = json!(0);
        }
        if let Some(pending) = d["watch"]["pending"].as_object_mut() {
            pending.remove(full);
        }
    }
    remove_ready(d, |v| v["full"] == full);
}
pub fn notice(d: &mut Value, now: u64) {
    clear_notice(d);
    let count = d["watch"]["ready"].as_array().map_or(0, Vec::len);
    if count == 0 {
        return;
    }
    if let Some(items) = d["inbox"].as_array_mut() {
        items.push(json!({"id":"native-files","kind":"files","text":format!("发现 {count} 个新文件，想看看怎么整理吗？"),"tab":"files","createdAt":now}));
        if items.len() > 12 {
            items.remove(0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn watch() -> Value {
        json!({"seen":{},"pending":{}})
    }
    fn folder(names: &[(&str, u64, u64)]) -> Folder {
        Folder {
            path: "/controlled".into(),
            files: names
                .iter()
                .map(|(n, s, m)| File {
                    name: (*n).into(),
                    full: format!("/controlled/{n}"),
                    size: *s,
                    modified: *m,
                })
                .collect(),
        }
    }
    #[test]
    fn baseline_changes_partial_downloads_and_restart_preserve_new_file_meaning() {
        let mut w = watch();
        assert_eq!(
            reconcile(&mut w, &folder(&[("old.txt", 1, 1)]), 100_000, false).unwrap(),
            0
        );
        let f = folder(&[
            ("old.txt", 2, 100_000),
            ("new.txt", 1, 100_000),
            ("unknown.foo", 1, 1),
        ]);
        assert_eq!(reconcile(&mut w, &f, 100_000, false).unwrap(), 0);
        let mut w: Value = serde_json::from_str(&w.to_string()).unwrap();
        assert_eq!(reconcile(&mut w, &f, 144_999, false).unwrap(), 0);
        assert_eq!(reconcile(&mut w, &f, 145_000, false).unwrap(), 1);
        assert_eq!(w["ready"][0]["name"], "new.txt");
        assert_eq!(reconcile(&mut w, &f, 200_000, false).unwrap(), 0);
        assert_eq!(w["ready"].as_array().unwrap().len(), 1);
        for name in [
            ".hidden.txt",
            "~$lock.docx",
            "a.part",
            "b.crdownload",
            "desktop.ini",
            "Thumbs.DB",
            "c.aria2",
        ] {
            assert!(ignored(name), "{name}");
        }
    }
    #[test]
    fn same_size_rewrites_restart_the_stability_clock_and_deleted_names_can_return() {
        let mut w = watch();
        reconcile(&mut w, &folder(&[]), 100_000, false).unwrap();
        reconcile(&mut w, &folder(&[("new.txt", 1, 100_000)]), 100_000, false).unwrap();
        let f = folder(&[("new.txt", 1, 140_000)]);
        assert_eq!(reconcile(&mut w, &f, 145_000, false).unwrap(), 0);
        assert_eq!(reconcile(&mut w, &f, 190_000, false).unwrap(), 1);
        reconcile(&mut w, &folder(&[]), 200_000, false).unwrap();
        assert!(w["ready"].as_array().unwrap().is_empty());
        reconcile(&mut w, &f, 200_000, false).unwrap();
        assert_eq!(reconcile(&mut w, &f, 245_000, false).unwrap(), 1);
        reconcile(&mut w, &folder(&[("new.txt", 2, 245_000)]), 245_000, false).unwrap();
        assert!(w["ready"].as_array().unwrap().is_empty());
        assert_eq!(
            reconcile(&mut w, &folder(&[("new.txt", 2, 245_000)]), 300_000, false).unwrap(),
            0
        );
    }
    #[test]
    fn off_baselines_new_files_and_native_opt_in_does_not_follow_legacy_auto_mode() {
        let mut d = crate::companion::defaults();
        d["settings"]["rules"]["tidy"] = json!("auto");
        assert!(!enabled(&d));
        let mut w = watch();
        reconcile(&mut w, &folder(&[]), 100_000, false).unwrap();
        reconcile(&mut w, &folder(&[("a.txt", 1, 1)]), 100_000, true).unwrap();
        assert_eq!(
            reconcile(&mut w, &folder(&[("a.txt", 1, 1)]), 200_000, false).unwrap(),
            0
        );
        configure(
            &mut d,
            true,
            json!(["/controlled"]),
            "ask",
            &["/controlled".into()],
        )
        .unwrap();
        assert!(enabled(&d));
        assert!(d["watch"]["native"]["autoRoots"].is_null());
    }
}
