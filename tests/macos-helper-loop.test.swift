import Foundation
import Dispatch

// No screen capture or application activation: partial stdin must not starve AppKit's run loop.
@main
@MainActor
struct HelperLoopTest {
    static func main() {
        let pipe = Pipe()
        var lines: [String] = []
        var timerFired = false
        var ended = false
        let input = LineInput(input: pipe.fileHandleForReading, onLine: { data in
            guard let text = String(data: data, encoding: .utf8) else { fatalError("Invalid UTF-8 line") }
            lines.append(text)
        }, onEnd: {
            ended = true
            CFRunLoopStop(CFRunLoopGetMain())
        })
        DispatchQueue.global().asyncAfter(deadline: .now() + 3) {
            FileHandle.standardError.write(Data("FAIL helper blocked the main run loop\n".utf8))
            exit(1)
        }
        let timer = Timer(timeInterval: 0.02, repeats: false) { _ in
            MainActor.assumeIsolated {
                timerFired = true
                pipe.fileHandleForWriting.write(Data("ta\nlast".utf8))
                do { try pipe.fileHandleForWriting.close() }
                catch { fatalError("Cannot close test input: \(error)") }
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        pipe.fileHandleForWriting.write(Data("alpha\nbe".utf8))
        input.run()
        precondition(timerFired && ended, "The main run loop must run while a line is incomplete")
        precondition(lines == ["alpha", "beta", "last"], "Fragmented JSONL/EOF ordering changed")
        print("PASS macOS helper idle run loop, fragmented input and EOF ordering")
    }
}
