import Foundation

final class RotatingLogWriter {
    private let fileURL: URL
    private let archiveURL: URL
    private let maxBytes: UInt64
    private let queue = DispatchQueue(label: "com.moofleet.native-log-writer")
    private var fileHandle: FileHandle?
    private var currentSize: UInt64 = 0
    private var closed = false

    init(fileURL: URL, maxBytes: UInt64 = 5 * 1024 * 1024) throws {
        guard maxBytes > 0 else {
            throw NSError(
                domain: "MooFleetLog",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "日志分片上限必须大于 0"]
            )
        }
        self.fileURL = fileURL
        archiveURL = URL(fileURLWithPath: fileURL.path + ".1")
        self.maxBytes = maxBytes
        try queue.sync {
            try openForAppend()
        }
    }

    func write(_ data: Data) {
        guard !data.isEmpty else { return }
        queue.async { [weak self] in
            guard let self, !closed else { return }
            do {
                try writeSynchronously(data)
            } catch {
                NSLog("Moo Fleet native log write failed: %@", error.localizedDescription)
            }
        }
    }

    func write(_ message: String) {
        guard let data = message.data(using: .utf8) else { return }
        write(data)
    }

    func close() {
        queue.sync {
            guard !closed else { return }
            closed = true
            try? fileHandle?.synchronize()
            try? fileHandle?.close()
            fileHandle = nil
        }
    }

    private func openForAppend() throws {
        let manager = FileManager.default
        if manager.fileExists(atPath: fileURL.path) {
            let size = try fileSize(at: fileURL)
            if size >= maxBytes {
                try archiveExistingLog(size: size)
            }
        }
        try createSecureFileIfNeeded(at: fileURL)
        let handle = try FileHandle(forWritingTo: fileURL)
        currentSize = try handle.seekToEnd()
        fileHandle = handle
    }

    private func archiveExistingLog(size: UInt64) throws {
        let manager = FileManager.default
        try removeIfPresent(archiveURL)
        if size == maxBytes {
            try manager.moveItem(at: fileURL, to: archiveURL)
        } else {
            let source = try FileHandle(forReadingFrom: fileURL)
            defer { try? source.close() }
            try source.seek(toOffset: size - maxBytes)
            let tail = try source.readToEnd() ?? Data()
            try tail.write(to: archiveURL, options: .atomic)
            try manager.removeItem(at: fileURL)
        }
        try securePermissions(at: archiveURL)
    }

    private func writeSynchronously(_ data: Data) throws {
        var offset = 0
        while offset < data.count {
            if currentSize >= maxBytes {
                try rotateCurrentLog()
            }
            let available = Int(min(maxBytes - currentSize, UInt64(data.count - offset)))
            let nextOffset = offset + available
            try fileHandle?.write(contentsOf: data.subdata(in: offset..<nextOffset))
            currentSize += UInt64(available)
            offset = nextOffset
        }
    }

    private func rotateCurrentLog() throws {
        try fileHandle?.synchronize()
        try fileHandle?.close()
        fileHandle = nil

        let manager = FileManager.default
        try removeIfPresent(archiveURL)
        if manager.fileExists(atPath: fileURL.path) {
            try manager.moveItem(at: fileURL, to: archiveURL)
            try securePermissions(at: archiveURL)
        }
        try createSecureFileIfNeeded(at: fileURL)
        fileHandle = try FileHandle(forWritingTo: fileURL)
        currentSize = 0
    }

    private func createSecureFileIfNeeded(at url: URL) throws {
        let manager = FileManager.default
        if !manager.fileExists(atPath: url.path) {
            guard manager.createFile(atPath: url.path, contents: nil) else {
                throw NSError(
                    domain: "MooFleetLog",
                    code: 2,
                    userInfo: [NSLocalizedDescriptionKey: "无法创建日志文件：\(url.path)"]
                )
            }
        }
        try securePermissions(at: url)
    }

    private func securePermissions(at url: URL) throws {
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    private func removeIfPresent(_ url: URL) throws {
        let manager = FileManager.default
        if manager.fileExists(atPath: url.path) {
            try manager.removeItem(at: url)
        }
    }

    private func fileSize(at url: URL) throws -> UInt64 {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        return (attributes[.size] as? NSNumber)?.uint64Value ?? 0
    }
}
