// Draws the Windows app and tray icon as a multi-size .ico: a rising line chart with axes on a dark rounded
// square, matching the Mac icon. The chart is drawn here rather than taken from SF Symbols, whose licence
// only covers Apple platforms. Each size is drawn on its own so small sizes stay sharp.
// Usage: swift winapp/icon.swift out.ico
import AppKit

let sizes = [16, 20, 24, 32, 40, 48, 64, 256]

/// RGBA pixels (straight alpha, top row first) of the icon drawn at s×s.
func render(_ s: Int) -> [UInt8] {
    let S = CGFloat(s)
    let ctx = CGContext(data: nil, width: s, height: s, bitsPerComponent: 8, bytesPerRow: s * 4,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    // Tile: almost the full square (Windows icons use little margin).
    let inset = max(0, (S / 32).rounded(.down))
    let tile = CGRect(x: 0, y: 0, width: S, height: S).insetBy(dx: inset, dy: inset)
    let tilePath = CGPath(roundedRect: tile, cornerWidth: S * 0.2, cornerHeight: S * 0.2, transform: nil)
    ctx.addPath(tilePath)
    ctx.clip()
    let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
                              colors: [CGColor(gray: 0.24, alpha: 1), CGColor(gray: 0.11, alpha: 1)] as CFArray,
                              locations: [0, 1])!
    ctx.drawLinearGradient(gradient, start: CGPoint(x: 0, y: tile.maxY), end: CGPoint(x: 0, y: tile.minY), options: [])
    ctx.resetClip()

    // Chart in a unit box (y up): axes on the left and bottom, and a line rising to the top right with one dip.
    func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: tile.minX + x * tile.width, y: tile.minY + y * tile.height) }
    ctx.setStrokeColor(CGColor(gray: 0.93, alpha: 1))
    ctx.setLineCap(.round)
    ctx.setLineJoin(.round)
    let lw = max(1.25, S * 0.065)
    ctx.setLineWidth(lw)
    ctx.move(to: p(0.22, 0.76)); ctx.addLine(to: p(0.22, 0.24)); ctx.addLine(to: p(0.78, 0.24))
    ctx.strokePath()
    // Arrowhead at the end of the line, pointing along its last segment.
    let dip = p(0.51, 0.44), tip = p(0.79, 0.73)
    let len = hypot(tip.x - dip.x, tip.y - dip.y)
    let d = CGPoint(x: (tip.x - dip.x) / len, y: (tip.y - dip.y) / len)
    let headL = tile.width * 0.17, headW = tile.width * 0.10
    let base = CGPoint(x: tip.x - d.x * headL, y: tip.y - d.y * headL)
    ctx.move(to: p(0.22, 0.45)); ctx.addLine(to: p(0.36, 0.58)); ctx.addLine(to: dip); ctx.addLine(to: base)
    ctx.strokePath()
    ctx.setFillColor(CGColor(gray: 0.93, alpha: 1))
    ctx.move(to: tip)
    ctx.addLine(to: CGPoint(x: base.x - d.y * headW, y: base.y + d.x * headW))
    ctx.addLine(to: CGPoint(x: base.x + d.y * headW, y: base.y - d.x * headW))
    ctx.closePath()
    ctx.drawPath(using: .fillStroke)

    // CGContext rows start at the top in memory; un-premultiply for the .ico.
    let buf = ctx.data!.bindMemory(to: UInt8.self, capacity: s * s * 4)
    var out = [UInt8](repeating: 0, count: s * s * 4)
    for i in 0..<(s * s) {
        let a = buf[i * 4 + 3]
        for c in 0..<3 {
            out[i * 4 + c] = a == 0 ? 0 : UInt8(min(255, (Int(buf[i * 4 + c]) * 255 + Int(a) / 2) / Int(a)))
        }
        out[i * 4 + 3] = a
    }
    return out
}

func png(_ rgba: [UInt8], _ s: Int) -> Data {
    var pixels = rgba
    let rep = pixels.withUnsafeMutableBufferPointer { ptr -> NSBitmapImageRep in
        var planes: UnsafeMutablePointer<UInt8>? = ptr.baseAddress
        return NSBitmapImageRep(bitmapDataPlanes: &planes, pixelsWide: s, pixelsHigh: s, bitsPerSample: 8,
                                samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                bitmapFormat: .alphaNonpremultiplied, bytesPerRow: s * 4, bitsPerPixel: 32)!
    }
    return rep.representation(using: .png, properties: [:])!
}

/// 32-bit BMP entry: BITMAPINFOHEADER, bottom-up BGRA rows, then an all-zero AND mask.
func dib(_ rgba: [UInt8], _ s: Int) -> Data {
    var d = Data()
    func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
    func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
    u32(40); u32(UInt32(s)); u32(UInt32(s * 2)); u16(1); u16(32); u32(0)
    u32(UInt32(s * s * 4)); u32(0); u32(0); u32(0); u32(0)
    for row in (0..<s).reversed() {
        for x in 0..<s {
            let i = (row * s + x) * 4
            d.append(contentsOf: [rgba[i + 2], rgba[i + 1], rgba[i], rgba[i + 3]])
        }
    }
    let maskRow = ((s + 31) / 32) * 4
    d.append(Data(count: maskRow * s))
    return d
}

var images: [(Int, Data)] = []
for s in sizes {
    let px = render(s)
    images.append((s, s >= 256 ? png(px, s) : dib(px, s)))
}
var ico = Data()
func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { ico.append(contentsOf: $0) } }
func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { ico.append(contentsOf: $0) } }
u16(0); u16(1); u16(UInt16(images.count))
var offset = 6 + 16 * images.count
for (s, data) in images {
    ico.append(UInt8(s >= 256 ? 0 : s)); ico.append(UInt8(s >= 256 ? 0 : s)); ico.append(0); ico.append(0)
    u16(1); u16(32); u32(UInt32(data.count)); u32(UInt32(offset))
    offset += data.count
}
for (_, data) in images { ico.append(data) }
try! ico.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))

// Optional: also write a PNG at one size, to check the drawing (swift winapp/icon.swift out.ico preview.png 32).
if CommandLine.arguments.count > 3, let s = Int(CommandLine.arguments[3]) {
    try! png(render(s), s).write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
}
