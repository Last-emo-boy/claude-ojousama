//! Fixed network lookups and explicit, reversible file organisation.
use crate::companion::{self, Companion};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(12))
        .user_agent("claude-ojousama")
        .build()
        .map_err(|e| e.to_string())
}
pub fn weather(city: &str) -> Result<Value, String> {
    if city.trim().is_empty() {
        return Ok(Value::Null);
    }
    let mut url = reqwest::Url::parse("https://wttr.in/").map_err(|e| e.to_string())?;
    url.path_segments_mut()
        .map_err(|_| "天气地址无效")?
        .push(city.trim());
    url.query_pairs_mut().append_pair("format", "j1");
    let response = client()?
        .get(url)
        .send()
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let value: Value = response.json().map_err(|e| e.to_string())?;
    let current = &value["current_condition"][0];
    let code = current["weatherCode"]
        .as_str()
        .and_then(|n| n.parse::<u32>().ok())
        .ok_or("天气服务未返回有效数据")?;
    Ok(
        json!({"city":city,"code":code,"desc":current["weatherDesc"][0]["value"],"temp":current["temp_C"],"max":value["weather"][0]["maxtempC"],"min":value["weather"][0]["mintempC"],"at":companion::now()}),
    )
}
pub fn update() -> Result<Value, String> {
    let response = client()?
        .get("https://api.github.com/repos/Last-emo-boy/claude-ojousama/releases/latest")
        .header("Accept", "application/vnd.github+json")
        .send()
        .map_err(|e| e.to_string())?;
    if response.status() == 404 {
        return Ok(Value::Null);
    }
    let value: Value = response
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .map_err(|e| e.to_string())?;
    Ok(
        json!({"version":value["tag_name"],"url":value["html_url"],"notes":value["body"],"publishedAt":value["published_at"]}),
    )
}
pub(crate) fn category(name: &str) -> Option<&'static str> {
    let ext = Path::new(name).extension()?.to_str()?.to_lowercase();
    for (name,extensions) in [
        ("图片","jpg jpeg png gif webp bmp svg heic heif ico tif tiff avif psd"),("文档","pdf doc docx xls xlsx ppt pptx txt md csv rtf odt ods odp epub pages key numbers"),("压缩包","zip rar 7z tar gz bz2 xz tgz zst"),("安装包","exe msi msix msixbundle appx dmg pkg apk iso"),("视频","mp4 mkv mov avi wmv flv webm m4v"),("音乐","mp3 wav flac aac ogg m4a wma opus"),("代码","js ts jsx tsx py java c cpp h hpp cs go rs json yml yaml xml html css ipynb sql sh ps1 bat")]{
        if extensions.split(' ').any(|e|e==ext){return Some(name);}
    }
    None
}
pub fn tidy_plan(folder: &Path) -> Result<Value, String> {
    plan(folder, None)
}
pub fn tidy_selected(folder: &Path, files: &[Value]) -> Result<Value, String> {
    plan(folder, Some(files))
}
fn plan(folder: &Path, selected: Option<&[Value]>) -> Result<Value, String> {
    let folder = fs::canonicalize(folder).map_err(|e| e.to_string())?;
    let mut moves = Vec::new();
    let mut taken = HashSet::new();
    let files = if let Some(selected) = selected {
        selected
            .iter()
            .map(|v| {
                let file = PathBuf::from(v["full"].as_str().ok_or("新文件路径无效")?);
                if file.parent() != Some(folder.as_path())
                    || file.file_name().and_then(|s| s.to_str()) != v["name"].as_str()
                {
                    return Err("新文件路径已变化，请刷新列表".to_string());
                }
                Ok((file, Some(v)))
            })
            .collect::<Result<Vec<_>, String>>()?
    } else {
        fs::read_dir(&folder)
            .map_err(|e| e.to_string())?
            .take(2000)
            .map(|e| e.map(|e| (e.path(), None)).map_err(|e| e.to_string()))
            .collect::<Result<Vec<_>, _>>()?
    };
    for (file, record) in files {
        let meta = fs::symlink_metadata(&file).map_err(|e| e.to_string())?;
        let modified = meta
            .modified()
            .map_err(|e| e.to_string())?
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        if let Some(record) = record {
            if !meta.is_file() || record["size"] != meta.len() || record["modified"] != modified {
                return Err("新文件已变化，请等待列表刷新后再预览".into());
            }
        }
        if !meta.is_file()
            || meta
                .modified()
                .map_err(|e| e.to_string())?
                .elapsed()
                .unwrap_or_default()
                < Duration::from_secs(45)
        {
            continue;
        }
        let name = file
            .file_name()
            .ok_or("文件名无效")?
            .to_str()
            .ok_or("文件名不能表示为 Unicode")?
            .to_owned();
        if name.starts_with('.') || name.starts_with("~$") {
            continue;
        }
        let Some(cat) = category(&name) else {
            continue;
        };
        let dir = folder.join(cat);
        if dir.is_symlink() {
            return Err("分类目录不能是符号链接".into());
        }
        let stem = file.file_stem().unwrap().to_string_lossy();
        let extension = file.extension().unwrap().to_string_lossy();
        let mut target = None;
        for i in 0..1000 {
            let p = dir.join(if i == 0 {
                name.clone()
            } else {
                format!("{stem} ({i}).{extension}")
            });
            if !p.exists() && taken.insert(p.to_string_lossy().to_lowercase()) {
                target = Some(p);
                break;
            }
        }
        if let Some(to) = target {
            moves.push(json!({"from":file,"to":to,"cat":cat,"name":name,"size":meta.len(),"modified":meta.modified().map_err(|e|e.to_string())?.duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_millis() as u64}));
        }
    }
    Ok(json!({"folder":folder,"moves":moves,"at":companion::now()}))
}
// create_new prevents overwriting a file that appeared after preview. On any copy
// failure the original is untouched; an incomplete destination is removed.
fn rename_exclusive(from: &Path, to: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        let a = CString::new(from.as_os_str().as_bytes())?;
        let b = CString::new(to.as_os_str().as_bytes())?;
        #[cfg(target_os = "macos")]
        let result = unsafe { libc::renamex_np(a.as_ptr(), b.as_ptr(), libc::RENAME_EXCL) };
        #[cfg(target_os = "linux")]
        let result = unsafe {
            libc::renameat2(
                libc::AT_FDCWD,
                a.as_ptr(),
                libc::AT_FDCWD,
                b.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        if result == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        extern "system" {
            fn MoveFileExW(a: *const u16, b: *const u16, flags: u32) -> i32;
        }
        let a: Vec<_> = from.as_os_str().encode_wide().chain(Some(0)).collect();
        let b: Vec<_> = to.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe { MoveFileExW(a.as_ptr(), b.as_ptr(), 8) } != 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }
}
fn move_exclusive(from: &Path, to: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(from).map_err(|e| e.to_string())?;
    if !metadata.is_file() {
        return Err("只移动普通文件，不移动符号链接".into());
    }
    match rename_exclusive(from, to) {
        Ok(()) => return Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::CrossesDevices => {}
        Err(e) => return Err(e.to_string()),
    }
    let mut source = fs::File::open(from).map_err(|e| e.to_string())?;
    let mut dest = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(to)
        .map_err(|e| e.to_string())?;
    let result = (|| -> std::io::Result<()> {
        std::io::copy(&mut source, &mut dest)?;
        dest.set_permissions(metadata.permissions())?;
        dest.set_times(
            fs::FileTimes::new()
                .set_modified(metadata.modified()?)
                .set_accessed(metadata.accessed()?),
        )?;
        dest.sync_all()?;
        let after = source.metadata()?;
        if after.len() != metadata.len() || after.modified()? != metadata.modified()? {
            return Err(std::io::Error::other("复制期间源文件发生变化，保留原文件"));
        }
        Ok(())
    })();
    if let Err(e) = result {
        drop(dest);
        fs::remove_file(to)
            .map_err(|cleanup| format!("复制失败：{e}；请清理未完成目标：{cleanup}"))?;
        return Err(e.to_string());
    }
    if let Err(e) = fs::remove_file(from) {
        drop(dest);
        fs::remove_file(to)
            .map_err(|cleanup| format!("源文件未移动：{e}；请清理目标副本：{cleanup}"))?;
        return Err(e.to_string());
    }
    Ok(())
}

pub fn tidy_apply(data: &Companion) -> Result<Value, String> {
    let d = data.snapshot();
    let plan = d["tidyPreview"].clone();
    let result = tidy_apply_plan(data, &plan)?;
    data.change(|d| {
        if d["tidyPreview"] == plan {
            d["tidyPreview"] = Value::Null;
        }
        Ok(())
    })?;
    Ok(result)
}
pub fn tidy_apply_plan(data: &Companion, plan: &Value) -> Result<Value, String> {
    if companion::now().saturating_sub(plan["at"].as_u64().unwrap_or(0)) > 600_000 {
        return Err("整理预览已过期，请重新预览".into());
    }
    let folder = fs::canonicalize(plan["folder"].as_str().ok_or("请先预览整理结果")?)
        .map_err(|e| e.to_string())?;
    let mut completed = Vec::new();
    let mut dirs = Vec::new();
    for movement in plan["moves"].as_array().ok_or("请先预览整理结果")? {
        let from = PathBuf::from(movement["from"].as_str().ok_or("源路径无效")?);
        let to = PathBuf::from(movement["to"].as_str().ok_or("目标路径无效")?);
        if from.parent() != Some(folder.as_path())
            || to.parent().and_then(Path::parent) != Some(folder.as_path())
        {
            return Err("路径已变化，停止整理".into());
        }
        let meta = fs::symlink_metadata(&from).map_err(|e| e.to_string())?;
        let modified = meta
            .modified()
            .map_err(|e| e.to_string())?
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        if !meta.is_file()
            || meta.len() != movement["size"].as_u64().unwrap_or(u64::MAX)
            || modified != movement["modified"].as_u64().unwrap_or(u64::MAX)
        {
            return Err(format!("文件已变化，未移动：{}", from.display()));
        }
        let dir = to.parent().unwrap();
        if dir.is_symlink() {
            return Err("分类目录发生变化，停止整理".into());
        }
        if !dir.exists() {
            fs::create_dir(dir).map_err(|e| e.to_string())?;
            dirs.push(dir.to_path_buf());
        }
        let mut journal = completed.clone();
        journal.push(movement.clone());
        data.change(|d| {
            d["tidyLog"] = json!({"at":companion::now(),"moves":journal,"dirs":dirs});
            Ok(())
        })?;
        move_exclusive(&from, &to)?;
        completed.push(movement.clone());
        // Journal every move, including partial runs, so undo never loses a move.
        data.change(|d| {
            d["tidyLog"] = json!({"at":companion::now(),"moves":completed,"dirs":dirs});
            Ok(())
        })?;
    }
    Ok(json!(completed))
}
pub fn tidy_undo(data: &Companion) -> Result<Value, String> {
    let log = data.snapshot()["tidyLog"].clone();
    let moves = log["moves"].as_array().ok_or("没有可撤销的整理记录")?;
    let mut left = moves.clone();
    for movement in moves.iter().rev() {
        let from = Path::new(movement["to"].as_str().ok_or("撤销源路径无效")?);
        let to = Path::new(movement["from"].as_str().ok_or("撤销目标路径无效")?);
        if !from.exists() && to.is_file() {
            left.pop();
            data.change(|d| {
                d["tidyLog"]["moves"] = json!(left);
                crate::file_watch::restored(d, movement);
                Ok(())
            })?;
            continue;
        }
        move_exclusive(from, to)?;
        left.pop();
        data.change(|d| {
            d["tidyLog"]["moves"] = json!(left);
            crate::file_watch::restored(d, movement);
            Ok(())
        })?;
    }
    for dir in log["dirs"].as_array().unwrap_or(&Vec::new()).iter().rev() {
        if let Some(dir) = dir.as_str() {
            match fs::remove_dir(dir) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::DirectoryNotEmpty => {}
                Err(e) => return Err(e.to_string()),
            }
        }
    }
    Ok(Value::Null)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exclusive_moves_never_overwrite_and_undo_preserves_data() {
        let dir = std::env::temp_dir().join(format!("ojousama-tidy-{}", companion::now()));
        fs::create_dir_all(&dir).unwrap();
        let a = dir.join("a.txt");
        let b = dir.join("b.txt");
        fs::write(&a, b"a").unwrap();
        fs::write(&b, b"b").unwrap();
        assert!(move_exclusive(&a, &b).is_err());
        assert_eq!(fs::read(&a).unwrap(), b"a");
        assert_eq!(fs::read(&b).unwrap(), b"b");
        let c = dir.join("c.txt");
        move_exclusive(&a, &c).unwrap();
        assert!(!a.exists());
        move_exclusive(&c, &a).unwrap();
        assert_eq!(fs::read(&a).unwrap(), b"a");
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn incomplete_downloads_and_unknown_extensions_are_not_categories() {
        assert_eq!(category("a.part"), None);
        assert_eq!(category("a.txt"), Some("文档"));
        assert_eq!(category("photo.HEIC"), Some("图片"));
    }
}

fn read_git(
    dir: &Path,
    args: &[String],
    overrides: &[(String, String)],
) -> Result<(std::process::ExitStatus, Vec<u8>), String> {
    let mut command = std::process::Command::new("git");
    command
        .args([
            "--no-pager",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.untrackedCache=false",
        ])
        .args(args)
        .current_dir(dir)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env_remove("GIT_CONFIG_PARAMETERS")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    if !overrides.is_empty() {
        // Keep keys and values separate: valid filter-driver names can contain '='.
        let count = std::env::var("GIT_CONFIG_COUNT").unwrap_or_else(|_| "0".into());
        let base = if count.is_empty() {
            0
        } else {
            count.parse::<usize>().map_err(|_| "Git 临时配置格式错误")?
        };
        for (i, (key, value)) in overrides.iter().enumerate() {
            command
                .env(format!("GIT_CONFIG_KEY_{}", base + i), key)
                .env(format!("GIT_CONFIG_VALUE_{}", base + i), value);
        }
        command.env("GIT_CONFIG_COUNT", (base + overrides.len()).to_string());
    }
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().unwrap();
    let reader = std::thread::spawn(move || {
        use std::io::Read;
        let mut buffer = Vec::new();
        stdout.take(65_537).read_to_end(&mut buffer).map(|_| buffer)
    });
    let started = std::time::Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if started.elapsed() > Duration::from_secs(5) {
            if let Err(error) = child.kill() {
                if child.try_wait().map_err(|e| e.to_string())?.is_none() {
                    return Err(error.to_string());
                }
            }
            child.wait().map_err(|e| e.to_string())?;
            reader
                .join()
                .map_err(|_| "git 输出读取失败")?
                .map_err(|e| e.to_string())?;
            return Err("git 查询超过 5 秒，已停止本次巡检".into());
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    let bytes = reader
        .join()
        .map_err(|_| "git 输出读取失败")?
        .map_err(|e| e.to_string())?;
    if bytes.len() > 65_536 {
        return Err("git 输出超过巡检上限，已停止本次查询".into());
    }
    Ok((status, bytes))
}
pub fn workspace_pulse(cwd: &str) -> Result<String, String> {
    if cwd.is_empty() {
        return Err("请先设置工作目录".into());
    }
    let root = fs::canonicalize(cwd).map_err(|e| e.to_string())?;
    let mut directories = vec![root.clone()];
    for entry in fs::read_dir(&root).map_err(|e| e.to_string())?.take(40) {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().map_err(|e| e.to_string())?.is_dir()
            && !entry.file_name().to_string_lossy().starts_with('.')
        {
            directories.push(entry.path());
        }
    }
    let mut results = Vec::new();
    for dir in directories {
        if !dir.join(".git").exists() {
            continue;
        }
        let args = [
            "config",
            "--null",
            "--name-only",
            "--get-regexp",
            r"^filter\.",
        ]
        .map(String::from);
        let (status, keys) = read_git(&dir, &args, &[])?;
        if !status.success() && status.code() != Some(1) {
            return Err("无法读取 Git 配置，未查询工作区状态".into());
        }
        let keys = std::str::from_utf8(&keys).map_err(|_| "Git 配置名称不是有效 UTF-8")?;
        let drivers: HashSet<_> = keys
            .split('\0')
            .filter_map(|key| key.rsplit_once('.').map(|(driver, _)| driver))
            .collect();
        if !drivers.is_empty() {
            let args = ["--version".into()];
            let (_, version) = read_git(&dir, &args, &[])?;
            let text = String::from_utf8_lossy(&version);
            let mut parts = text
                .trim()
                .strip_prefix("git version ")
                .unwrap_or("")
                .split('.');
            let major = parts.next().and_then(|v| v.parse::<u32>().ok());
            let minor = parts.next().and_then(|v| v.parse::<u32>().ok());
            if !matches!((major,minor),(Some(a),Some(b)) if a>2 || (a==2&&b>=31)) {
                return Err("含过滤器的工作区巡检需要 Git 2.31 或更新版本".into());
            }
        }
        let mut overrides = Vec::new();
        for driver in &drivers {
            for key in ["clean", "smudge", "process"] {
                overrides.push((format!("{driver}.{key}"), String::new()));
            }
            overrides.push((format!("{driver}.required"), "false".into()));
        }
        let args = [
            "status",
            "--porcelain=v1",
            "--branch",
            "--ignore-submodules=all",
        ]
        .map(String::from);
        let (status, bytes) = read_git(&dir, &args, &overrides)?;
        if !status.success() {
            continue;
        }
        let note = if drivers.is_empty() {
            ""
        } else {
            "未运行仓库过滤器；需转换的文件状态可能与常规查询不同。\n"
        };
        results.push(format!(
            "{}\n{}{}",
            dir.strip_prefix(&root).unwrap_or(&dir).display(),
            note,
            String::from_utf8_lossy(&bytes)
        ));
        if results.len() >= 6 {
            break;
        }
    }
    Ok(results.join("\n\n"))
}
#[cfg(test)]
mod git_tests {
    use super::*;
    #[test]
    fn workspace_status_never_runs_clean_or_required_process_filters() {
        let root = std::env::temp_dir().join(format!(
            "ojousama-git-filter-{}-{}",
            std::process::id(),
            companion::now()
        ));
        fs::create_dir_all(&root).unwrap();
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(&root)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", root.join("empty-config"))
                .env_remove("GIT_TEMPLATE_DIR")
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            out.stdout
        };
        git(&["init", "-q"]);
        fs::write(root.join(".gitattributes"), "*.txt filter=fixture\n").unwrap();
        fs::write(
            root.join("filter.sh"),
            "#!/bin/sh\nprintf invoked > filter-marker\ncat\n",
        )
        .unwrap();
        git(&["config", "filter.fixture.clean", "sh filter.sh"]);
        fs::write(root.join("file.txt"), "before\n").unwrap();
        git(&["add", "file.txt", ".gitattributes"]);
        git(&[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-qm",
            "controlled baseline",
        ]);
        fs::remove_file(root.join("filter-marker")).unwrap();
        fs::write(root.join("file.txt"), "after!\n").unwrap();
        git(&["-c", "core.fsmonitor=false", "status", "--porcelain=v1"]);
        assert!(
            root.join("filter-marker").exists(),
            "positive control must demonstrate the filter ran"
        );
        fs::remove_file(root.join("filter-marker")).unwrap();
        let status = workspace_pulse(root.to_str().unwrap()).unwrap();
        assert!(status.contains("file.txt") && status.contains("未运行仓库过滤器"));
        assert!(!root.join("filter-marker").exists());
        git(&["config", "filter.fixture.process", "sh filter.sh"]);
        git(&["config", "filter.fixture.required", "true"]);
        assert!(workspace_pulse(root.to_str().unwrap())
            .unwrap()
            .contains("file.txt"));
        assert!(!root.join("filter-marker").exists());
        assert_eq!(
            String::from_utf8(git(&["config", "filter.fixture.required"]))
                .unwrap()
                .trim(),
            "true"
        );
        fs::write(root.join(".gitattributes"), "*.txt filter=fixture=odd\n").unwrap();
        git(&["config", "filter.fixture=odd.clean", "sh filter.sh"]);
        git(&["config", "filter.fixture=odd.process", "sh filter.sh"]);
        git(&["config", "filter.fixture=odd.required", "true"]);
        assert!(workspace_pulse(root.to_str().unwrap())
            .unwrap()
            .contains("file.txt"));
        assert!(!root.join("filter-marker").exists());
        fs::remove_dir_all(root).unwrap();
    }
}

pub fn open_target(target: &str) -> Result<(), String> {
    if let Ok(url) = reqwest::Url::parse(target) {
        if ["https", "http"].contains(&url.scheme()) {
            return open::that(url.as_str()).map_err(|e| e.to_string());
        }
    }
    let file = fs::canonicalize(target).map_err(|e| e.to_string())?;
    let ext = file
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    if file.is_file()
        && (ext.is_empty()
            || [
                "exe", "app", "bat", "cmd", "com", "ps1", "psm1", "vbs", "js", "jse", "msi", "lnk",
                "url", "scr", "reg", "hta", "cpl", "jar", "py", "sh", "desktop",
            ]
            .contains(&ext.as_str()))
    {
        return Err("不会通过链接提议运行程序或脚本".into());
    }
    open::that(file).map_err(|e| e.to_string())
}
pub fn move_user_file(data: &Companion, from: &str, to: &str) -> Result<(), String> {
    let from = fs::canonicalize(from).map_err(|e| e.to_string())?;
    let to = Path::new(to);
    let to = if to.is_dir() {
        fs::canonicalize(to)
            .map_err(|e| e.to_string())?
            .join(from.file_name().ok_or("源文件名无效")?)
    } else {
        fs::canonicalize(to.parent().ok_or("目标目录无效")?)
            .map_err(|e| e.to_string())?
            .join(to.file_name().ok_or("目标文件名无效")?)
    };
    data.change(|d| {
        d["fileMoveLog"] = json!({"from":from,"to":to,"status":"planned"});
        Ok(())
    })?;
    move_exclusive(&from, &to)?;
    data.change(|d| {
        d["fileMoveLog"]["status"] = json!("completed");
        companion::log(d, "file", "已完成确认过的文件移动");
        Ok(())
    })?;
    Ok(())
}

#[cfg(test)]
mod recovery_tests {
    use super::*;
    #[test]
    fn tidy_preview_apply_and_undo_work_as_one_reversible_operation() {
        let root =
            std::env::temp_dir().join(format!("ojousama-tidy-roundtrip-{}", companion::now()));
        fs::create_dir_all(&root).unwrap();
        let data_dir = root.join("data");
        fs::create_dir(&data_dir).unwrap();
        let data = Companion::open(data_dir.join("pet-data.json"), None).unwrap();
        let file = root.join("test.txt");
        fs::write(&file, b"content").unwrap();
        fs::File::options()
            .write(true)
            .open(&file)
            .unwrap()
            .set_times(
                fs::FileTimes::new().set_modified(SystemTime::now() - Duration::from_secs(60)),
            )
            .unwrap();
        let preview = tidy_plan(&root).unwrap();
        assert_eq!(preview["moves"].as_array().unwrap().len(), 1);
        data.change(|d| {
            d["tidyPreview"] = preview;
            Ok(())
        })
        .unwrap();
        tidy_apply(&data).unwrap();
        assert!(!file.exists());
        assert_eq!(fs::read(root.join("文档/test.txt")).unwrap(), b"content");
        tidy_undo(&data).unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"content");
        fs::remove_dir_all(root).unwrap();
    }
}
