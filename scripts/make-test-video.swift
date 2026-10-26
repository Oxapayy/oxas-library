import Foundation
import AVFoundation
import CoreVideo
import CoreGraphics

let output = URL(fileURLWithPath: "scripts/fixtures/test-video.mp4")
try? FileManager.default.removeItem(at: output)
let writer = try AVAssetWriter(outputURL: output, fileType: .mp4)
let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 320, AVVideoHeightKey: 180])
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB, kCVPixelBufferWidthKey as String: 320, kCVPixelBufferHeightKey as String: 180])
writer.add(input); writer.startWriting(); writer.startSession(atSourceTime: .zero)
for frame in 0..<360 {
    while !input.isReadyForMoreMediaData { Thread.sleep(forTimeInterval: 0.002) }
    var buffer: CVPixelBuffer?
    CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, adaptor.pixelBufferPool!, &buffer)
    let pixel = buffer!; CVPixelBufferLockBaseAddress(pixel, [])
    let ctx = CGContext(data: CVPixelBufferGetBaseAddress(pixel), width: 320, height: 180, bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(pixel), space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue)!
    ctx.setFillColor(CGColor(red: 0.08, green: 0.15, blue: 0.18, alpha: 1)); ctx.fill(CGRect(x: 0, y: 0, width: 320, height: 180))
    ctx.setFillColor(CGColor(red: 0.8, green: 0.9, blue: 0.95, alpha: 1)); ctx.fill(CGRect(x: frame % 300, y: 80, width: 20, height: 20))
    CVPixelBufferUnlockBaseAddress(pixel, [])
    adaptor.append(pixel, withPresentationTime: CMTime(value: Int64(frame), timescale: 15))
}
input.markAsFinished()
await writer.finishWriting()
if writer.status != .completed { throw writer.error ?? NSError(domain: "VideoFixture", code: 1) }
print("Created 24-second local test fixture")
