import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

// 品牌位图的派生命令。品牌稿只有 PNG（没有可编辑矢量源），而构建链路需要的是
// 「1024 圆角应用图标」和「裁掉透明留白的横版 logo」，这两步都不是 sips 能做的，
// 所以单独放一个小工具，由 `scripts/generate-brand-assets.sh` 调用。
//
//   BrandAssetTool squircle <in.png> <out.png> [canvas]
//       把满幅方图裁成 Apple 的圆角方块：内容 824/1024、圆角 185.4/1024、四角透明。
//       macOS 不会替应用图标补圆角（不像 iOS），满幅直角会原样出现在 Dock 里。
//
//   BrandAssetTool trim <in.png> <out.png> [targetWidth]
//       按 alpha 包围盒裁掉透明留白，可选缩放到指定宽度（默认保持原尺寸）。

private func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
    exit(1)
}

private func loadImage(_ path: String) -> CGImage {
    let url = URL(fileURLWithPath: path)
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        fail("无法读取 PNG：\(path)")
    }
    return image
}

private func writePNG(_ image: CGImage, to path: String) {
    let url = URL(fileURLWithPath: path) as CFURL
    guard let destination = CGImageDestinationCreateWithURL(url, UTType.png.identifier as CFString, 1, nil) else {
        fail("无法写入 PNG：\(path)")
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else {
        fail("PNG 写入失败：\(path)")
    }
}

private func makeContext(width: Int, height: Int) -> CGContext {
    let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
    guard let context = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else {
        fail("无法创建 \(width)x\(height) 位图上下文")
    }
    context.interpolationQuality = .high
    return context
}

private func scaled(_ image: CGImage, toWidth width: Int, height: Int) -> CGImage {
    let context = makeContext(width: width, height: height)
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    guard let rendered = context.makeImage() else { fail("缩放渲染失败") }
    return rendered
}

private func alphaBoundingBox(_ image: CGImage) -> CGRect {
    let width = image.width
    let height = image.height
    let context = makeContext(width: width, height: height)
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    guard let data = context.data else { fail("无法读取像素数据") }
    let bytes = data.bindMemory(to: UInt8.self, capacity: width * height * 4)
    let bytesPerRow = context.bytesPerRow

    var minX = width
    var minY = height
    var maxX = -1
    var maxY = -1
    for y in 0..<height {
        // CGContext 的行序是自上而下，与 CGImage.cropping 的坐标一致。
        let row = y * bytesPerRow
        for x in 0..<width where bytes[row + x * 4 + 3] > 4 {
            if x < minX { minX = x }
            if x > maxX { maxX = x }
            if y < minY { minY = y }
            if y > maxY { maxY = y }
        }
    }
    if maxX < 0 { fail("图片没有任何不透明像素") }
    return CGRect(x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1)
}

let arguments = Array(CommandLine.arguments.dropFirst())
guard let command = arguments.first else {
    fail("用法：BrandAssetTool <squircle|trim> <in.png> <out.png> [数值]")
}

switch command {
case "squircle":
    guard arguments.count >= 3 else { fail("用法：BrandAssetTool squircle <in.png> <out.png> [canvas]") }
    let canvas = arguments.count > 3 ? (Int(arguments[3]) ?? 1024) : 1024
    guard canvas >= 16 else { fail("canvas 至少要 16") }
    let source = loadImage(arguments[1])
    // Apple 的 macOS 图标网格：1024 画布里 824×824 的圆角方块，圆角半径 185.4。
    let content = CGFloat(canvas) * 824.0 / 1024.0
    let radius = CGFloat(canvas) * 185.4 / 1024.0
    let inset = (CGFloat(canvas) - content) / 2
    let context = makeContext(width: canvas, height: canvas)
    let rect = CGRect(x: inset, y: inset, width: content, height: content)
    context.addPath(CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil))
    context.clip()
    context.draw(source, in: rect)
    guard let rendered = context.makeImage() else { fail("圆角裁切渲染失败") }
    writePNG(rendered, to: arguments[2])
    print("squircle \(canvas)x\(canvas) → \(arguments[2])")

case "trim":
    guard arguments.count >= 3 else { fail("用法：BrandAssetTool trim <in.png> <out.png> [targetWidth]") }
    let source = loadImage(arguments[1])
    let box = alphaBoundingBox(source)
    guard let cropped = source.cropping(to: box) else { fail("裁切失败") }
    print("trim bbox \(Int(box.width))x\(Int(box.height)) ← \(source.width)x\(source.height)")
    if arguments.count > 3, let targetWidth = Int(arguments[3]), targetWidth > 0 {
        let targetHeight = max(1, Int((CGFloat(targetWidth) * CGFloat(cropped.height) / CGFloat(cropped.width)).rounded()))
        writePNG(scaled(cropped, toWidth: targetWidth, height: targetHeight), to: arguments[2])
        print("trim \(targetWidth)x\(targetHeight) → \(arguments[2])")
    } else {
        writePNG(cropped, to: arguments[2])
        print("trim \(cropped.width)x\(cropped.height) → \(arguments[2])")
    }

default:
    fail("未知命令：\(command)")
}
