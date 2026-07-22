import Foundation

private enum TestFailure: Error {
    case assertion(String)
}

private func require(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
    if try !condition() {
        throw TestFailure.assertion(message)
    }
}

private func contents(of url: URL) throws -> String {
    String(decoding: try Data(contentsOf: url), as: UTF8.self)
}

private func permissions(of url: URL) throws -> Int {
    let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
    return (attributes[.posixPermissions] as? NSNumber)?.intValue ?? 0
}

@main
struct RotatingLogWriterTest {
    static func main() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("moo-fleet-log-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let startupLog = root.appendingPathComponent("startup.log")
        try Data("0123456789ABC".utf8).write(to: startupLog)
        let startupWriter = try RotatingLogWriter(fileURL: startupLog, maxBytes: 10)
        startupWriter.close()
        try require(contents(of: startupLog) == "", "旧版超大日志轮转后当前文件应为空")
        try require(contents(of: URL(fileURLWithPath: startupLog.path + ".1")) == "3456789ABC", "应只保留旧日志末尾一个分片")

        let runtimeLog = root.appendingPathComponent("runtime.log")
        let firstWriter = try RotatingLogWriter(fileURL: runtimeLog, maxBytes: 10)
        firstWriter.write(Data("abcdefghijklmno".utf8))
        firstWriter.close()
        try require(contents(of: URL(fileURLWithPath: runtimeLog.path + ".1")) == "abcdefghij", "跨越上限时应归档完整分片")
        try require(contents(of: runtimeLog) == "klmno", "跨越上限后的剩余内容应进入当前文件")

        let secondWriter = try RotatingLogWriter(fileURL: runtimeLog, maxBytes: 10)
        secondWriter.write(Data("pqrstuv".utf8))
        secondWriter.close()
        let runtimeArchive = URL(fileURLWithPath: runtimeLog.path + ".1")
        try require(contents(of: runtimeArchive) == "klmnopqrst", "重复轮转应只保留最近一个完整分片")
        try require(contents(of: runtimeLog) == "uv", "重复轮转后的当前文件内容不正确")
        try require(permissions(of: runtimeLog) == 0o600, "当前日志权限必须为 0600")
        try require(permissions(of: runtimeArchive) == 0o600, "归档日志权限必须为 0600")

        print("RotatingLogWriter tests passed")
    }
}
