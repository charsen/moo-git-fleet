import AppKit
import Foundation

private func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
    exit(1)
}

private func alpha(atX x: Int, y: Int, in image: NSBitmapImageRep, path: String) -> CGFloat {
    guard let color = image.colorAt(x: x, y: y) else {
        fail("Unable to read icon pixel (\(x), \(y)): \(path)")
    }
    return color.alphaComponent
}

let paths = Array(CommandLine.arguments.dropFirst())
guard !paths.isEmpty else {
    fail("Usage: AppIconAlphaCheck <png> [png ...]")
}

for path in paths {
    let url = URL(fileURLWithPath: path)
    guard let data = try? Data(contentsOf: url),
          let image = NSBitmapImageRep(data: data),
          image.pixelsWide > 1,
          image.pixelsHigh > 1 else {
        fail("Unable to load icon PNG: \(path)")
    }

    let maxX = image.pixelsWide - 1
    let maxY = image.pixelsHigh - 1
    let corners = [
        alpha(atX: 0, y: 0, in: image, path: path),
        alpha(atX: maxX, y: 0, in: image, path: path),
        alpha(atX: 0, y: maxY, in: image, path: path),
        alpha(atX: maxX, y: maxY, in: image, path: path),
    ]
    if corners.contains(where: { $0 > 0.01 }) {
        fail("App icon corners must be transparent: \(path)")
    }

    let centerAlpha = alpha(
        atX: image.pixelsWide / 2,
        y: image.pixelsHigh / 2,
        in: image,
        path: path
    )
    if centerAlpha < 0.99 {
        fail("App icon center must remain opaque: \(path)")
    }

    print("App icon alpha valid: \(image.pixelsWide)x\(image.pixelsHigh) \(path)")
}
