import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import Vision

// JSON Lines bridge. Window Services uses the same top-left, logical-point space as Electron.
typealias JSON = [String: Any]

@MainActor
func windowInfo(_ window: JSON) -> JSON? {
    guard let id = window[kCGWindowNumber as String] as? NSNumber,
          let pid = window[kCGWindowOwnerPID as String] as? NSNumber,
          let raw = window[kCGWindowBounds as String] as? JSON,
          let x = raw["X"] as? NSNumber, let y = raw["Y"] as? NSNumber,
          let width = raw["Width"] as? NSNumber, let height = raw["Height"] as? NSNumber,
          width.doubleValue >= 40, height.doubleValue >= 40 else { return nil }
    let owner = NSRunningApplication(processIdentifier: pid.int32Value)
    let bounds = CGRect(x: x.doubleValue, y: y.doubleValue, width: width.doubleValue, height: height.doubleValue)
    let top = NSScreen.screens.first?.frame.maxY ?? 0
    let maximized = NSScreen.screens.contains { screen in
        let visible = screen.visibleFrame
        let rect = CGRect(x: visible.minX, y: top - visible.maxY, width: visible.width, height: visible.height)
        return abs(rect.minX - bounds.minX) < 3 && abs(rect.minY - bounds.minY) < 3 &&
               abs(rect.width - bounds.width) < 3 && abs(rect.height - bounds.height) < 3
    }
    return [
        "hwnd": id, "pid": pid,
        "title": window[kCGWindowName as String] as? String ?? "",
        "process": owner?.executableURL?.lastPathComponent ?? window[kCGWindowOwnerName as String] as? String ?? "",
        "cls": owner?.bundleIdentifier ?? "", "shell": owner?.bundleIdentifier == "com.apple.finder" && (window[kCGWindowLayer as String] as? NSNumber)?.intValue != 0,
        "x": x, "y": y, "w": width, "h": height, "coordinates": "dip",
        "minimized": !(window[kCGWindowIsOnscreen as String] as? Bool ?? false), "maximized": maximized,
    ]
}

@MainActor
func visibleWindows() -> [JSON] {
    guard let raw = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [JSON] else { return [] }
    return raw.filter { ($0[kCGWindowLayer as String] as? NSNumber)?.intValue == 0 }
        .compactMap(windowInfo).prefix(64).map { $0 }
}

@MainActor
func capabilities() -> JSON {
    let capture = CGPreflightScreenCaptureAccess()
    let session = !NSScreen.screens.isEmpty
    var value: JSON = [
        "ok": true, "platform": "darwin", "session": session ? "aqua" : "headless",
        "foreground": session && capture, "windows": session, "ocr": true,
        "manualCapture": session, "screenCapture": capture,
        "permissions": ["screenCapture": capture, "accessibility": AXIsProcessTrusted()],
    ]
    if !session { value["reason"] = "没有可用的 macOS 图形会话" }
    else if !capture { value["reason"] = "请在系统设置中允许桌宠录制屏幕；开发运行时需允许启动它的终端或 IDE" }
    return value
}

func recognizeText(path: String, language: String) throws -> String {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    let supported = try request.supportedRecognitionLanguages()
    let wanted = language.hasPrefix("zh") ? ["zh-Hans", "en-US"] : ["en-US"]
    request.recognitionLanguages = wanted.filter { supported.contains($0) }
    let handler = VNImageRequestHandler(url: URL(fileURLWithPath: path), options: [:])
    try handler.perform([request])
    return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
}

@MainActor
func respond(_ request: JSON) throws -> JSON {
    switch request["cmd"] as? String {
    case "ping": return ["ok": true]
    case "capabilities": return capabilities()
    case "fg":
        guard CGPreflightScreenCaptureAccess() else {
            return ["ok": false, "error": "macOS 屏幕录制权限尚未授予", "code": "permission-denied"]
        }
        guard let app = NSWorkspace.shared.frontmostApplication,
              let window = visibleWindows().first(where: { ($0["pid"] as? NSNumber)?.int32Value == app.processIdentifier }) else {
            return ["ok": true, "none": true]
        }
        return window.merging(["ok": true]) { old, _ in old }
    case "wins": return ["ok": true, "windows": visibleWindows()]
    case "rect":
        guard let rawID = request["hwnd"] as? NSNumber,
              let list = CGWindowListCopyWindowInfo(.optionIncludingWindow, CGWindowID(rawID.uint32Value)) as? [JSON],
              let first = list.first, let window = windowInfo(first) else { return ["ok": true, "gone": true] }
        return window.merging(["ok": true, "gone": false]) { old, _ in old }
    case "procs":
        let names = (request["names"] as? [String] ?? []).map { $0.lowercased() }
        let windows = visibleWindows().filter { names.contains(($0["process"] as? String ?? "").lowercased()) }
            .map { ["process": $0["process"] ?? "", "title": $0["title"] ?? ""] }
        return ["ok": true, "windows": windows]
    case "ocr":
        guard let path = request["path"] as? String else { return ["ok": false, "error": "OCR image path is required"] }
        return ["ok": true, "text": try recognizeText(path: path, language: request["lang"] as? String ?? "en-US")]
    default: return ["ok": false, "error": "Unknown screen helper command"]
    }
}

@main
@MainActor
struct ScreenHelper {
    static func main() {
        while let line = readLine() {
            autoreleasepool {
                var id: Any = NSNull()
                let response: JSON
                do {
                    guard let data = line.data(using: .utf8), let request = try JSONSerialization.jsonObject(with: data) as? JSON else {
                        throw NSError(domain: "ScreenHelper", code: 1, userInfo: [NSLocalizedDescriptionKey: "Expected a JSON object"])
                    }
                    id = request["id"] ?? NSNull()
                    response = try respond(request)
                } catch {
                    response = ["ok": false, "error": error.localizedDescription]
                }
                var result = response
                result["id"] = id
                do {
                    let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
                    FileHandle.standardOutput.write(data)
                    FileHandle.standardOutput.write(Data([10]))
                } catch {
                    FileHandle.standardError.write(Data("screen-helper: cannot encode response\n".utf8))
                }
            }
        }
    }
}
